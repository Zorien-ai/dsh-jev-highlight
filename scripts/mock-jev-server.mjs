#!/usr/bin/env node
/**
 * Zero-dependency mock of the TypeSafe Jev API used by the jev-highlight E2E suite.
 *
 *   POST /v1/systemone   { model, state, questions } -> { model, answers: { id: { type, noul } }, usage }
 *   GET  /__stats        request/concurrency evidence (never contains the API key)
 *   GET  /__reset        clear counters between scenarios
 *   GET  /health         liveness for the acceptance harness
 *
 * The four noul questions are scored from the *content* of `state`, so one test
 * prompt can deterministically produce all four highlight levels:
 *
 *   is_core_answer  high when the state reads like the answer / conclusion
 *   is_actionable   high when the state contains code, commands or numbered steps
 *   is_warning      high when the state warns about a risk / caveat / limit
 *   is_definition   high when the state defines or explains a term
 *
 * Every score gets a stable hash-derived jitter in [0, 0.08) so repeated states
 * are byte-identical (cache tests) while unrelated states differ.
 *
 * Usage:
 *   node scripts/mock-jev-server.mjs [--port 10399] [--delay-ms 0]
 *        [--fail-rate 0] [--fail-status 429|500] [--field noul|probability|p_yes]
 *        [--log docs/e2e-runs/mock.log.json] [--seed 0] [--quiet]
 *
 * `--delay-ms` delays each request before the response body is written *and*
 * spreads the write over several chunks, so a plugin abort mid-response can be
 * observed (mock `inFlight` returns to zero, `aborted` grows).
 */

import { createServer } from 'node:http'
import { renameSync, writeFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { port: 10399, delayMs: 0, failRate: 0, failStatus: 0, field: 'noul', log: '', seed: 0, quiet: false, captureBodies: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      return argv[index]
    }
    switch (arg) {
      case '--port':
        args.port = Number.parseInt(next() ?? '', 10)
        break
      case '--delay-ms':
        args.delayMs = Math.max(0, Number.parseInt(next() ?? '0', 10) || 0)
        break
      case '--fail-rate':
        args.failRate = Math.min(1, Math.max(0, Number.parseFloat(next() ?? '0') || 0))
        break
      case '--fail-status':
        args.failStatus = Number.parseInt(next() ?? '0', 10) || 0
        break
      case '--field':
        args.field = String(next() ?? 'noul')
        break
      case '--log':
        args.log = String(next() ?? '')
        break
      case '--seed':
        args.seed = Number.parseInt(next() ?? '0', 10) || 0
        break
      case '--quiet':
        args.quiet = true
        break
      case '--capture-bodies':
        args.captureBodies = true
        break
      case '--help':
      case '-h':
        console.log('mock-jev-server: see file header for options')
        process.exit(0)
        break
      default:
        console.error(`mock-jev-server: unknown argument ${arg}`)
        process.exit(2)
    }
  }
  if (!['noul', 'probability', 'p_yes'].includes(args.field)) {
    console.error(`mock-jev-server: --field must be noul|probability|p_yes, got ${args.field}`)
    process.exit(2)
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    console.error('mock-jev-server: --port must be a valid TCP port')
    process.exit(2)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

// ---------------------------------------------------------------------------
// Scoring rules
// ---------------------------------------------------------------------------

/** Stable 32-bit FNV-1a hash so the same text always yields the same jitter. */
function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function jitter(text) {
  return (fnv1a(`${args.seed}:${text}`) % 800) / 10000
}

const clamp01 = (value) => Math.min(1, Math.max(0, value))

const CODE_FENCE = /```|`[^`\n]+`/u
const COMMAND = /(^|\n)\s*(?:[$>]\s+)?(?:npm|pnpm|node|npx|git|curl|powershell|pwsh|dsh|cd|ls|dir|Get-|Set-|Remove-|New-)\b/u
const STEP = /(?:^|\n)\s*(?:\d{1,2}[.)、]|[-*+]\s|第[一二三四五六七八九十\d]+步|步骤)/u
const ACTION = /(?:运行|执行|输入|打开|点击|安装|配置|设置|修改|添加|删除|重启|检查|查看|确认|run\b|execute|install|configure|open|click|add|remove|restart|check)/iu
const WARNING = /(?:风险|注意|警告|小心|失败|错误|限制|坑|不要|禁止|避免|超限|warning|risk|caveat|caution|limit|failure|avoid|danger|do not|don't)/iu
const DEFINITION = /(?:是指|定义为|定义是|指的是|称为|叫做|意味着|即|也就是说|means|refers to|is defined as|definition|is called|stands for)/iu
const CORE = /(?:核心|结论|答案是|关键|答案就是|本质上|归根结底|总结来说|总之|因此|所以最终|core answer|in short|the answer is|key takeaway|to sum up|conclusion)/iu
/** Code-looking lines. The splitter strips fence markers, so detect the body instead. */
const CODE_HINT = /(?:^|\n)\s*(?:\/\/|\/\*|\*\/|#\s|const |let |var |function |import |export |class |return |if \(|for \(|while \(|=>|<\/?[a-z][a-z0-9]*[ >])/mu

/**
 * The host sends `[preceding line] <before>\n[passage]\n<unit text>`; only the
 * passage itself may decide the score, exactly like a human judge. Without this
 * the preceding-line context would leak its keywords into every later unit
 * (e.g. a code block inheriting "核心/注意" from the paragraph above).
 */
function unitPassage(state) {
  const marker = '[passage]'
  const at = state.lastIndexOf(marker)
  if (at === -1) return state
  return state.slice(at + marker.length).replace(/^[ \t]*\r?\n/u, '').trim()
}

/**
 * Priority targets. The plugin composes
 *   priority = 0.5*core + 0.3*actionable + 0.2*max(warning, definition)
 * so each content tier below maps to one deterministic highlight bucket:
 *
 *   critical  -> 0.956   medium-core -> 0.774   medium-code -> 0.740
 *   medium-definition -> 0.715   low-action -> 0.580   low-warning -> 0.630
 *   none      -> 0.200
 *
 * The E2E prompt is written so a compliant model emits one critical paragraph,
 * one medium code block, one medium definition paragraph, and low list items.
 */
const TIERS = {
  critical: { is_core_answer: 0.97, is_actionable: 0.95, is_warning: 0.93, is_definition: 0.2 },
  'medium-core': { is_core_answer: 0.92, is_actionable: 0.88, is_warning: 0.25, is_definition: 0.2 },
  'medium-code': { is_core_answer: 0.72, is_actionable: 0.9, is_warning: 0.55, is_definition: 0.2 },
  'medium-definition': { is_core_answer: 0.8, is_actionable: 0.45, is_warning: 0.3, is_definition: 0.9 },
  'low-action': { is_core_answer: 0.55, is_actionable: 0.85, is_warning: 0.25, is_definition: 0.2 },
  'low-warning': { is_core_answer: 0.62, is_actionable: 0.5, is_warning: 0.85, is_definition: 0.2 },
  none: { is_core_answer: 0.2, is_actionable: 0.2, is_warning: 0.2, is_definition: 0.2 },
}

function classifyTier(text) {
  const hasCode = CODE_FENCE.test(text) || CODE_HINT.test(text)
  const isAction = hasCode || ACTION.test(text) || STEP.test(text) || COMMAND.test(text)
  const isWarning = WARNING.test(text)
  const isDefinition = DEFINITION.test(text)
  const isCore = CORE.test(text)
  if (isCore && isWarning && isAction) return 'critical'
  if (isCore && isAction) return 'medium-core'
  if (hasCode && isWarning) return 'medium-code'
  if (isDefinition && !isCore) return 'medium-definition'
  if (isAction && !isCore && !isWarning) return 'low-action'
  if (isWarning && !isCore && !isAction) return 'low-warning'
  return 'none'
}

/**
 * Score one noul question for the mock's view of `state`.
 * @param {string} questionId
 * @param {string} questionText
 * @param {string} state
 */
function scoreQuestion(questionId, questionText, state) {
  const passage = unitPassage(state)
  const tier = classifyTier(passage)
  const table = TIERS[tier] ?? TIERS.none
  const base = table[questionId] ?? 0.25
  const value = base + (jitter(`${questionId}:${passage}`) / 2)
  return Math.round(clamp01(value) * 10000) / 10000
}

/** Rough token estimate for the `usage` block; same heuristic direction as the plugin. */
function estimateTokens(text) {
  let cjk = 0
  let other = 0
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xff00 && codePoint <= 0xffef)
    ) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return Math.ceil(cjk + other / 3.5)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const startedAt = new Date().toISOString()
const stats = {
  startedAt,
  field: args.field,
  delayMs: args.delayMs,
  failRate: args.failRate,
  requests: 0,
  completed: 0,
  failed: 0,
  aborted: 0,
  inFlight: 0,
  maxConcurrent: 0,
  maxStateChars: 0,
  /** @type {Array<object>} */
  recent: [],
}

function snapshotStats() {
  return {
    ...stats,
    recent: stats.recent.slice(-40),
    now: new Date().toISOString(),
  }
}

let persistSeq = 0
function persistLog() {
  if (args.log === '') return
  try {
    // Write-then-rename so a reader can never observe a half-written JSON log.
    const temporary = `${args.log}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(snapshotStats(), null, 2), 'utf8')
    renameSync(temporary, args.log)
    persistSeq += 1
  } catch (error) {
    if (!args.quiet) console.error(`mock-jev-server: could not write --log file: ${String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 8 * 1024 * 1024) {
        reject(new Error('request body exceeds 8 MiB'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** Delay that resolves early when the client disconnects (so aborts are swift). */
function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

function authSummary(request) {
  const authorization = request.headers.authorization
  const xApiKey = request.headers['x-api-key']
  if (typeof authorization === 'string' && authorization !== '') return 'authorization-header'
  if (typeof xApiKey === 'string' && xApiKey !== '') return 'x-api-key-header'
  return 'none'
}

/** Structural tolerance: questions may be an object (real API) or an array (defensive). */
function normaliseQuestions(raw) {
  if (raw === null || typeof raw !== 'object') return []
  if (Array.isArray(raw)) {
    return raw
      .map((entry, index) => {
        if (entry === null || typeof entry !== 'object') return undefined
        const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : `q${index}`
        return { id, type: String(entry.type ?? 'noul'), instructions: String(entry.instructions ?? '') }
      })
      .filter((entry) => entry !== undefined)
  }
  return Object.entries(raw).map(([id, entry]) => ({
    id,
    type: String(entry?.type ?? 'noul'),
    instructions: String(entry?.instructions ?? ''),
  }))
}

async function handleSystemOne(request, response) {
  stats.requests += 1
  stats.inFlight += 1
  if (stats.inFlight > stats.maxConcurrent) stats.maxConcurrent = stats.inFlight
  persistLog()
  let finished = false
  const finish = () => {
    if (finished) return false
    finished = true
    stats.inFlight = Math.max(0, stats.inFlight - 1)
    return true
  }

  const abortController = new AbortController()
  const onClose = () => {
    if (!response.writableEnded) abortController.abort()
  }
  response.on('close', onClose)

  const started = Date.now()
  const summary = { seq: stats.requests, ts: new Date().toISOString(), status: 'pending', stateChars: 0, questionIds: [], field: args.field, auth: authSummary(request) }
  try {
    const text = await readBody(request)
    let body
    try {
      body = JSON.parse(text)
    } catch {
      summary.status = 400
      finish()
      sendJson(response, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } })
      return
    }
    const state = typeof body?.state === 'string' ? body.state : JSON.stringify(body?.state ?? '')
    const questions = normaliseQuestions(body?.questions)
    summary.model = typeof body?.model === 'string' ? body.model : undefined
    summary.stateChars = [...state].length
    if (summary.stateChars > stats.maxStateChars) stats.maxStateChars = summary.stateChars
    summary.questionIds = questions.map((question) => question.id)
    summary.tier = classifyTier(unitPassage(state))
    summary.statePreview = state.slice(0, 160)
    if (args.captureBodies) {
      summary.state = state.slice(0, 20000)
      summary.questions = questions.map((question) => ({ id: question.id, type: question.type, instructions: question.instructions.slice(0, 300) }))
    }
    if (questions.length === 0) {
      summary.status = 400
      finish()
      sendJson(response, 400, { error: { message: 'missing questions', type: 'invalid_request_error' } })
      return
    }
    if (state === '') {
      summary.status = 400
      finish()
      sendJson(response, 400, { error: { message: 'missing state', type: 'invalid_request_error' } })
      return
    }

    if (args.delayMs > 0) await sleep(args.delayMs, abortController.signal)
    if (abortController.signal.aborted) {
      summary.status = 'aborted'
      summary.durationMs = Date.now() - started
      stats.aborted += 1
      finish()
      stats.recent.push(summary)
      persistLog()
      return
    }

    if (args.failRate > 0 && Math.random() < args.failRate) {
      const status = args.failStatus === 429 || args.failStatus === 500 ? args.failStatus : Math.random() < 0.5 ? 429 : 500
      summary.status = status
      summary.durationMs = Date.now() - started
      stats.failed += 1
      finish()
      stats.recent.push(summary)
      persistLog()
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '1' })
      response.end(
        JSON.stringify({
          error:
            status === 429
              ? { message: 'mock rate limit exceeded', type: 'rate_limit_error' }
              : { message: 'mock internal server error', type: 'api_error' },
        }),
      )
      return
    }

    const answers = {}
    const scores = {}
    for (const question of questions) {
      const value = scoreQuestion(question.id, question.instructions, state)
      scores[question.id] = value
      answers[question.id] = { type: question.type, [args.field]: value }
    }
    const payload = {
      model: typeof body?.model === 'string' && body.model !== '' ? body.model : 'jev-1.13.0-mock',
      answers,
      usage: { input_tokens: estimateTokens(state), output_tokens: questions.length },
      mock: { field: args.field, scores, delayMs: args.delayMs },
    }
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8')

    if (args.delayMs === 0) {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(encoded.length),
        'cache-control': 'no-store',
      })
      response.end(encoded)
    } else {
      // Gzip is not used; split the body across several timed writes so an abort
      // can land mid-body. Content-Length is still exact.
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(encoded.length),
        'cache-control': 'no-store',
      })
      const parts = 4
      const chunkSize = Math.max(1, Math.ceil(encoded.length / parts))
      for (let offset = 0; offset < encoded.length; offset += chunkSize) {
        if (abortController.signal.aborted || response.writableEnded) break
        try {
          response.write(encoded.subarray(offset, Math.min(encoded.length, offset + chunkSize)))
        } catch {
          abortController.abort()
          break
        }
        if (offset + chunkSize < encoded.length) await sleep(Math.max(50, Math.floor(args.delayMs / parts)), abortController.signal)
      }
      if (!abortController.signal.aborted && !response.writableEnded) response.end()
    }

    summary.status = abortController.signal.aborted ? 'aborted' : 200
    summary.durationMs = Date.now() - started
    summary.scores = scores
    if (abortController.signal.aborted) stats.aborted += 1
    else stats.completed += 1
    if (finish()) {
      stats.recent.push(summary)
      persistLog()
    }
  } catch (error) {
    summary.status = 'error'
    summary.error = String(error?.message ?? error).slice(0, 200)
    summary.durationMs = Date.now() - started
    stats.failed += 1
    if (finish()) {
      stats.recent.push(summary)
      persistLog()
    }
    if (!response.writableEnded) sendJson(response, 500, { error: { message: 'mock failure', type: 'api_error' } })
  } finally {
    response.removeListener('close', onClose)
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/__health')) {
    sendJson(response, 200, { ok: true, inFlight: stats.inFlight, requests: stats.requests })
    return
  }
  if (request.method === 'GET' && url.pathname === '/__stats') {
    sendJson(response, 200, snapshotStats())
    return
  }
  if (request.method === 'POST' && url.pathname === '/__reset') {
    stats.requests = 0
    stats.completed = 0
    stats.failed = 0
    stats.aborted = 0
    stats.maxConcurrent = 0
    stats.recent = []
    persistLog()
    sendJson(response, 200, { ok: true })
    return
  }
  if (request.method === 'POST' && url.pathname === '/v1/systemone') {
    void handleSystemOne(request, response)
    return
  }
  sendJson(response, 404, { error: { message: `no route ${request.method} ${url.pathname}`, type: 'not_found' } })
})

server.listen(args.port, '127.0.0.1', () => {
  if (!args.quiet) {
    console.log(
      `mock-jev-server listening on http://127.0.0.1:${args.port} ` +
        `(field=${args.field} delayMs=${args.delayMs} failRate=${args.failRate} seed=${args.seed})`,
    )
  }
  persistLog()
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    persistLog()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500).unref()
  })
}
