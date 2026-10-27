#!/usr/bin/env node
/**
 * jev-probe.mjs — real TypeSafe Jev contract probe + input-token calibration.
 *
 * Zero dependencies. Node >= 20 (global fetch + AbortSignal.timeout).
 *
 * Why this exists
 * ---------------
 * The host half of the Jev highlight plugin calls
 * `POST {jevBaseUrl}/v1/systemone` with `{ state, model, questions }` and needs
 * the exact shape of a noul answer (`answers.<id>.<field>`), the served model
 * name, the usage counters, and the error/retry contract. This script proves
 * all of that against the real API and writes a sanitized evidence artifact.
 *
 * Modes
 * -----
 *   --mode models     GET  /v1/models (free)  — names/aliases this account can use.
 *   --mode main       POST /v1/systemone      — the 4 plugin noul questions over a
 *                                               mixed CJK/English agent-style state.
 *   --mode alias      POST /v1/systemone      — tiny call with model=jev-latest,
 *                                               records what `response.model` says.
 *   --mode calibrate  POST /v1/systemone x3   — short CJK / long mixed / code block,
 *                                               compares usage.input_tokens against a
 *                                               character heuristic and least-squares fit.
 *   --mode errors     free negative probes    — 401 (missing/invalid key), 422
 *                                               validation, unknown model: real error
 *                                               body shapes for host-core.
 *   --mode all        models + main + alias + calibrate + errors (5 billable calls).
 *
 * Security invariant
 * ------------------
 * The key is read from `JEV_API_KEY` only. It is never printed, never written to
 * the artifact, and never appears in a command line: run this script from a
 * PowerShell wrapper that parses the .env in-process and only sets the env var.
 * Every console line and every artifact byte passes through `scrub()`.
 *
 * Artifact: docs/jev-probe-result.json (sanitized, no key/header).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOCS_DIR = join(HERE, '..', 'docs')
const RESULT_PATH = join(DOCS_DIR, 'jev-probe-result.json')
const TOKEN_CALIB_PATH = join(DOCS_DIR, 'jev-token-calibration.json')

const BASE_URL = (process.env.JEV_BASE_URL || 'https://api.typesafe.ai').replace(/\/+$/u, '')
const REQUESTED_MODEL = process.env.JEV_MODEL || 'jev-1.13.0'
const API_KEY = process.env.JEV_API_KEY || ''

const MODES = new Set(['models', 'main', 'alias', 'calibrate', 'errors', 'tokencalib', 'all'])

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { mode: process.env.JEV_PROBE_MODE || 'main', pretty: true, raw: '', preds: '', limit: 0 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--mode' || arg === '-m') {
      out.mode = argv[i + 1]
      i += 1
    } else if (arg.startsWith('--mode=')) {
      out.mode = arg.slice('--mode='.length)
    } else if (arg === '--raw') {
      out.raw = argv[i + 1]
      i += 1
    } else if (arg === '--preds') {
      out.preds = argv[i + 1]
      i += 1
    } else if (arg === '--limit') {
      out.limit = Number.parseInt(argv[i + 1], 10) || 0
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      out.help = true
    } else if (arg === '--compact') {
      out.pretty = false
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('usage: node scripts/jev-probe.mjs --mode models|main|alias|calibrate|errors|tokencalib|all [--compact]')
  console.log('  live modes need env JEV_API_KEY (never on the command line): JEV_BASE_URL, JEV_MODEL optional')
  console.log('  tokencalib is offline: needs --raw <jev_raw_zh.jsonl> --preds <preds_test_jev_zh.csv>')
  process.exit(0)
}
if (!MODES.has(args.mode)) {
  console.error(`unknown mode "${args.mode}"; expected one of ${[...MODES].join(', ')}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

const SECRET = API_KEY

/** Remove the API key (if any) from a string so it can never reach stdout or disk. */
function scrub(value) {
  if (typeof value !== 'string') return value
  let text = value
  if (SECRET.length >= 8) text = text.split(SECRET).join('[REDACTED]')
  return text
}

/** Scrub every string leaf of a JSON-ish value, then return it. */
function scrubDeep(value) {
  if (typeof value === 'string') return scrub(value)
  if (Array.isArray(value)) return value.map(scrubDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[scrub(k)] = scrubDeep(v)
    return out
  }
  return value
}

function log(...parts) {
  console.log(...parts.map((p) => scrub(typeof p === 'string' ? p : JSON.stringify(p))))
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const HEADER_ALLOWLIST = /^(content-type|date|request-id|x-request-id|retry-after|x-ratelimit-|ratelimit-|x-envoy-|server-timing|cf-ray)$/iu

/** Keep only non-sensitive response headers; never include authorization/set-cookie. */
function sanitizeHeaders(headers) {
  const out = {}
  for (const [name, value] of headers.entries()) {
    if (HEADER_ALLOWLIST.test(name)) out[name.toLowerCase()] = scrub(value)
  }
  return out
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryDelayMs(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const seconds = Number.parseFloat(retryAfterHeader)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000)
  }
  return Math.min(500 * 2 ** attempt + Math.random() * 250, 8_000)
}

/**
 * One authenticated HTTP call with 429/529/5xx exponential backoff.
 * Returns a sanitized result object: status, ok, json/text, headers, latencyMs,
 * attempts, retries (timestamps/reasons), error.
 */
async function httpCall(path, { method = 'POST', body, auth = true, retries = 2, timeoutMs = 30_000 } = {}) {
  const url = `${BASE_URL}${path}`
  const startedAt = performance.now()
  const attempts = []
  let last = null

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const headers = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (auth) headers.authorization = `Bearer ${API_KEY}`

    const attemptStarted = performance.now()
    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      attempts.push({
        attempt,
        status: null,
        latencyMs: Math.round(performance.now() - attemptStarted),
        error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
      })
      last = {
        ok: false,
        status: null,
        latencyMs: Math.round(performance.now() - startedAt),
        attempts,
        error: attempts.at(-1).error,
      }
      // Network errors: retry on the same schedule.
      if (attempt < retries) {
        await sleep(retryDelayMs(attempt))
        continue
      }
      return last
    }

    const text = await response.text()
    let json = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    const latencyMs = Math.round(performance.now() - attemptStarted)
    const headersOut = sanitizeHeaders(response.headers)
    attempts.push({ attempt, status: response.status, latencyMs, error: null })

    const retryable = response.status === 429 || response.status === 529 || response.status >= 500
    last = {
      ok: response.ok,
      status: response.status,
      latencyMs: Math.round(performance.now() - startedAt),
      json,
      text: json === null ? scrub(text.slice(0, 2_000)) : undefined,
      headers: headersOut,
      attempts,
      error: response.ok ? null : errorSummary(json, text),
    }

    if (!retryable || attempt >= retries) return last
    const waited = retryDelayMs(attempt, response.headers.get('retry-after'))
    log(`  retry ${attempt + 1}/${retries} after HTTP ${response.status} in ${Math.round(waited)}ms`)
    await sleep(waited)
  }

  return last
}

function errorSummary(json, text) {
  if (json && typeof json === 'object') {
    if ('detail' in json) {
      const detail = json.detail
      if (typeof detail === 'string') return detail.slice(0, 500)
      if (Array.isArray(detail)) {
        return detail
          .slice(0, 3)
          .map((item) => `${Array.isArray(item?.loc) ? item.loc.join('.') : '?'}: ${item?.msg ?? ''} (${item?.type ?? '?'})`)
          .join('; ')
      }
    }
    return JSON.stringify(json).slice(0, 500)
  }
  return scrub(String(text ?? '').slice(0, 500))
}

// ---------------------------------------------------------------------------
// Question set (matches the plugin's contract.ts ids)
// ---------------------------------------------------------------------------

const MAIN_QUESTIONS = {
  is_core_answer: {
    type: 'noul',
    instructions:
      'Is this passage the core answer about how to read the noul probability field from a TypeSafe Jev response?',
  },
  is_actionable: {
    type: 'noul',
    instructions: 'Does this passage contain a concrete action, command, or code step the reader can execute?',
  },
  is_warning: {
    type: 'noul',
    instructions: 'Does this passage warn about a risk, caveat, failure mode, or limitation?',
    // Optional criteria: proves the optional field is accepted and does not change the answer shape.
    criteria: {
      true: 'Explicitly warns about a risk, caveat, failure mode, or limitation',
      false: 'Reports facts or steps without any caution',
    },
  },
  is_definition: {
    type: 'noul',
    instructions: 'Does this passage define or explain the meaning of a term or field?',
  },
}

/** Mixed CJK/English agent-style state: paragraph + bullets + code + risk warning. */
const MAIN_STATE = [
  '我已经把 Jev 的契约核对完了，结论如下。首先，POST /v1/systemone 的 body 是 {model, state, questions}，四个 noul 问题会返回同一个 answers 对象，每个答案的字段名就是 noul，取值范围 0 到 1，不是 probability 也不是 p_yes。',
  '',
  '读取方式如下：',
  '',
  '```js',
  'const p = body.answers.is_core_answer.noul;',
  '```',
  '',
  '- 端点：/v1/systemone',
  '- 计费：只算 input token，output token 免费',
  '- 限制：64k 总上下文，state 加最长问题最多 32k',
  '',
  '风险提示：Jev 1.13 对 CJK 文本的准确率低于英文，超限会返回 400 max_tokens_exceeded；遇到 429 或 529 应指数退避重试，不要把四个判断塞进同一个 noul 问题。',
].join('\n')

const CALIBRATION_SAMPLES = [
  {
    id: 'short-cjk',
    label: '短中文段',
    state:
      '这段回答说明了核心结论：Jev 的 noul 答案字段名是 noul，它同时表示“是”的概率与确定性，不需要另外读取 confidence 字段。读取后按阈值判断是否高亮即可。',
  },
  {
    id: 'long-mixed',
    label: '长中英混合段',
    state: [
      'The host half evaluates each streamed unit independently, then composes the four noul probabilities in code. 具体做法是把四个问题放进同一个请求，让 model 一次性返回 answers。',
      'Question ids are chosen by the client and echoed back by the API, so the host can map results without relying on ordering. 问题 id 不会发送给模型，只是响应中的键名。',
      'A typical flow: split the stream into units, estimate tokens, batch units into one state, call /v1/systemone, then cache verdicts by content hash. 缓存可以显著减少重复请求。',
      '需要注意：Jev 1.13 会字面理解问题，含糊的指令会降低准确率；对中文内容建议用英文提问，并避免把多个判断合并在一个 noul 里。',
    ].join('\n\n'),
  },
  {
    id: 'code-block',
    label: '代码块',
    state: [
      '```ts',
      'interface NoulAnswer { type: "noul"; noul: number }',
      'interface SystemOneResponse {',
      '  model: string',
      '  answers: Record<string, NoulAnswer>',
      '  usage: { input_tokens: number; output_tokens: number }',
      '}',
      '',
      'export function priority(scores: Record<string, number>): number {',
      '  const core = scores.is_core_answer ?? 0',
      '  const action = scores.is_actionable ?? 0',
      '  const warning = Math.max(scores.is_warning ?? 0, scores.is_definition ?? 0)',
      '  return Math.min(1, 0.5 * core + 0.3 * action + 0.2 * warning)',
      '}',
      '```',
      '',
      'The snippet above is type-safe at the boundary but does not validate that each value is finite and clamped to [0, 1] before composition.',
    ].join('\n'),
  },
]

// ---------------------------------------------------------------------------
// Offline calibration from the user's historical REAL calls (2026-09-21)
// ---------------------------------------------------------------------------
//
// The live endpoint is region-blocked (HTTP 451) from this network, so the three
// fresh calibration calls above cannot run. Instead `--mode tokencalib` reads
// the frozen 2026-09-21 experiment artifacts and reconstructs the exact request
// bodies that produced 1,980 real `usage.input_tokens` values:
//
//   F:\workspace\最新模型jev和bert和deepseek-V4.1Flash模型对比和混合架构的探索\
//     duibi\jev\out\jev_raw_zh.jsonl          (row_id + real usage.input_tokens)
//     duibi\jev\out\preds_test_jev_zh.csv     (row_id + review text)
//
// The reconstruction mirrors duibi/human_eval ... duibi/jev/jev_classify.py
// build_payload(..., prompt_lang="zh") exactly. This is real measured token
// data, not an estimate: it just comes from a `choice` question set, so the
// fitted coefficients are re-validated against TypeSafe's documented `noul`
// response examples below.

const HISTORICAL_MODEL = 'jev-1.13.0'
const HISTORICAL_QUESTION = {
  type: 'choice',
  instructions: '这条外卖评论的整体情感极性是正面还是负面？',
  criteria: {
    positive: '顾客对本次订单整体满意，表达认可、推荐或好评',
    negative: '顾客对本次订单不满，表达抱怨、失望或差评',
  },
}

/** Rebuild the exact body jev_classify.py sent for one review text. */
function historicalBody(text) {
  return {
    state: { review: text },
    model: HISTORICAL_MODEL,
    questions: { sentiment: HISTORICAL_QUESTION },
  }
}

/** Recorded TypeSafe documentation responses, used to validate transfer to noul. */
const DOCUMENTED_NOUL_EXAMPLES = [
  {
    id: 'docs-noul-two-questions',
    source: 'https://docs.typesafe.ai/primitives/noul',
    documentedInputTokens: 360,
    documentedOutputTokens: 39,
    body: {
      model: 'jev-1.13.0',
      state: 'I have asked three times now. Can I please just talk to a real person?',
      questions: {
        is_human_escalation: {
          type: 'noul',
          instructions: 'Is the customer asking for a human agent?',
        },
        is_repeat_contact: {
          type: 'noul',
          instructions: 'Has the customer contacted support about this before?',
          criteria: {
            true: 'Mentions a prior attempt, ticket, or that they have asked before',
            false: 'No sign of any previous contact',
          },
        },
      },
    },
  },
  {
    id: 'docs-noul-structured-three-questions',
    source: 'https://docs.typesafe.ai/primitives/noul#structured-instructions',
    documentedInputTokens: 535,
    documentedOutputTokens: 58,
    body: {
      model: 'jev-1.13.0',
      state: {
        resume: {
          name: 'John Smith',
          location: 'Oakland, CA',
          summary: 'Backend engineer with eight years of Python and Go experience.',
          experience: [
            { employer: 'Google', title: 'Senior Backend Engineer', years: '2021-2025' },
            { employer: 'Microsoft', title: 'Software Engineer', years: '2017-2021' },
          ],
        },
      },
      questions: {
        same_as_record_18: {
          type: 'noul',
          instructions: {
            potential_duplicate: { name: 'Jon Smith', location: 'Oakland, CA', last_employer: 'Google' },
            question: 'Is the resume for the same person as `potential_duplicate`?',
          },
        },
        same_as_record_42: {
          type: 'noul',
          instructions: {
            potential_duplicate: { name: 'John Smith', location: 'Austin, TX', last_employer: 'Lone Star Freight' },
            question: 'Is the resume for the same person as `potential_duplicate`?',
          },
        },
        same_as_record_77: {
          type: 'noul',
          instructions: {
            potential_duplicate: { name: 'John Smithers', location: 'Oakland, CA', last_employer: 'Bay Health Clinic' },
            question: 'Is the resume for the same person as `potential_duplicate`?',
          },
        },
      },
    },
  },
  {
    id: 'docs-quickstart-three-mixed',
    source: 'https://docs.typesafe.ai/introduction/quickstart#call-it-the-api',
    documentedInputTokens: 428,
    documentedOutputTokens: 73,
    body: {
      model: 'jev-1.13.0',
      state:
        "Our API integration started returning 500 errors on every request about 20 minutes ago, and we can't process any customer orders until this is fixed.",
      questions: {
        department: {
          type: 'choice',
          instructions: 'Which team should handle this',
          criteria: {
            billing: 'Payment or subscription issues',
            technical: 'Bugs or integration problems',
            sales: 'Pricing or account questions',
          },
        },
        frustration: {
          type: 'score',
          instructions: 'How frustrated the customer appears',
          criteria: ['Calm, just stating facts', 'Frustrated but civil', 'Very angry, strong language'],
        },
        is_urgent: {
          type: 'noul',
          instructions: 'The message conveys urgency or time-sensitivity',
        },
      },
    },
  },
]

/** Collect only the string leaf values of a JSON-ish value (structural keys excluded). */
function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out)
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectStrings(child, out)
  }
  return out
}

/** Token estimate for plain prompt text: per-char rates for CJK vs ASCII. */
function estimateTextTokens(strings, cjkPerChar, asciiPerChar) {
  let tokens = 0
  for (const text of strings) {
    const cjk = (text.match(CJK_CHAR_RE) || []).length
    const ascii = (text.match(ASCII_CHAR_RE) || []).length
    const other = [...text].length - cjk - ascii
    tokens += cjk * cjkPerChar + ascii * asciiPerChar + other * cjkPerChar
  }
  return tokens
}

/** Minimal RFC 4180 CSV parser (quoted fields may contain commas, quotes, newlines). */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return round2(sorted[index])
}

/** Fit against the reconstructed 2026-09-21 bodies and validate transfer to documented noul examples. */
async function modeTokenCalib() {
  log('\n== token calibration from 1,980 historical REAL calls (offline) ==')
  if (!args.raw || !args.preds) {
    throw new Error('--mode tokencalib needs --raw <jev_raw_zh.jsonl> and --preds <preds_test_jev_zh.csv>')
  }
  log(`  raw:   ${args.raw}`)
  log(`  preds: ${args.preds}`)

  const rawText = await readFile(args.raw, 'utf8')
  const csvText = await readFile(args.preds, 'utf8')

  const textByRow = new Map()
  const csvRows = parseCsv(csvText)
  const header = csvRows.shift() ?? []
  const idIndex = header.indexOf('row_id')
  const textIndex = header.indexOf('text')
  if (idIndex < 0 || textIndex < 0) throw new Error(`unexpected preds CSV header: ${header.join(',')}`)
  for (const row of csvRows) {
    const rowId = Number(row[idIndex])
    if (Number.isFinite(rowId)) textByRow.set(rowId, row[textIndex] ?? '')
  }

  const samples = []
  let skippedNoUsage = 0
  let skippedNoText = 0
  let totalActual = 0
  for (const line of rawText.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!record || record.ok !== true) {
      skippedNoUsage += 1
      continue
    }
    const inputTokens = record?.data?.usage?.input_tokens
    if (!Number.isFinite(inputTokens)) {
      skippedNoUsage += 1
      continue
    }
    const text = textByRow.get(record.row_id)
    if (typeof text !== 'string') {
      skippedNoText += 1
      continue
    }
    if (args.limit > 0 && samples.length >= args.limit) break
    const body = historicalBody(text)
    samples.push({
      rowId: record.row_id,
      textChars: [...text].length,
      metrics: bodyMetrics(body),
      stateMetrics: textMetrics(text),
      stateText: text,
      actualInputTokens: inputTokens,
    })
    totalActual += inputTokens
  }

  if (samples.length < 3) throw new Error(`only ${samples.length} joined samples; need >= 3`)

  const fit = fitCoefficients(samples)
  if (!fit) throw new Error('least-squares fit is rank-deficient; need samples with varied CJK/ASCII mix')

  const residuals = samples.map((sample) => {
    const predicted =
      sample.metrics.cjkChars * fit.cjkPerChar + sample.metrics.asciiChars * fit.asciiPerChar + fit.jsonOverhead
    return {
      sample,
      predicted,
      absolutePct: Math.abs(((predicted - sample.actualInputTokens) / sample.actualInputTokens) * 100),
    }
  })
  const meanActual = totalActual / samples.length
  let ssRes = 0
  let ssTot = 0
  for (const residual of residuals) {
    ssRes += (residual.predicted - residual.sample.actualInputTokens) ** 2
    ssTot += (residual.sample.actualInputTokens - meanActual) ** 2
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null

  const baselineNaive = samples.map((sample) => {
    const predicted = sample.metrics.naiveTokens
    return { actual: sample.actualInputTokens, predicted, absolutePct: Math.abs(((predicted - sample.actualInputTokens) / sample.actualInputTokens) * 100) }
  })
  const baselineCharsDiv4 = samples.map((sample) => {
    const predicted = sample.metrics.charsDiv4Tokens
    return { actual: sample.actualInputTokens, predicted, absolutePct: Math.abs(((predicted - sample.actualInputTokens) / sample.actualInputTokens) * 100) }
  })
  const meanPct = (rows) => round2(rows.reduce((sum, row) => sum + row.absolutePct, 0) / rows.length)

  const documentedExamples = DOCUMENTED_NOUL_EXAMPLES.map((example) => {
    const metrics = bodyMetrics(example.body)
    const predicted = metrics.cjkChars * fit.cjkPerChar + metrics.asciiChars * fit.asciiPerChar + fit.jsonOverhead
    return {
      id: example.id,
      source: example.source,
      documentedInputTokens: example.documentedInputTokens,
      documentedOutputTokens: example.documentedOutputTokens,
      predictedInputTokens: round2(predicted),
      errorPct: round2(((predicted - example.documentedInputTokens) / example.documentedInputTokens) * 100),
      metrics,
      bodyCharCount: metrics.bodyChars,
    }
  })

  // ---- Fit B: state text only; the fixed term is the whole question-set overhead. ----
  const stateFit = fitCoefficients(
    samples.map((sample) => ({ metrics: sample.stateMetrics, actualInputTokens: sample.actualInputTokens })),
  )
  const meanState = samples.reduce(
    (acc, sample) => ({
      cjkChars: acc.cjkChars + sample.stateMetrics.cjkChars,
      asciiChars: acc.asciiChars + sample.stateMetrics.asciiChars,
      chars: acc.chars + [...sample.stateText].length,
    }),
    { cjkChars: 0, asciiChars: 0, chars: 0 },
  )
  const meanStateChars = {
    chars: round2(meanState.chars / samples.length),
    cjkChars: round2(meanState.cjkChars / samples.length),
    asciiChars: round2(meanState.asciiChars / samples.length),
  }

  // ---- Recorded docs responses: derive the fixed overhead of a small multi-question request. ----
  const documentedBodies = new Map(DOCUMENTED_NOUL_EXAMPLES.map((example) => [example.id, example.body]))
  const overheadAssumptions = [0.3, 0.4].map((asciiPerChar) => {
    const rows = documentedExamples.map((example) => {
      const body = documentedBodies.get(example.id)
      const estState = estimateTextTokens(collectStrings(body.state), fit.cjkPerChar, asciiPerChar)
      const estQuestions = estimateTextTokens(collectStrings(body.questions), fit.cjkPerChar, asciiPerChar)
      return {
        id: example.id,
        documentedInputTokens: example.documentedInputTokens,
        questionCount: Object.keys(body.questions).length,
        estimatedStateTokens: round2(estState),
        estimatedQuestionTokens: round2(estQuestions),
        impliedFixedOverhead: round2(example.documentedInputTokens - estState - estQuestions),
      }
    })
    const line = fitLine(
      rows.map((row) => [1, row.questionCount]),
      rows.map((row) => row.impliedFixedOverhead),
    )
    return {
      asciiPerCharAssumption: asciiPerChar,
      rows,
      linearFit: line ? { fixedOverhead: round2(line[0]), perQuestionOverhead: round2(line[1]) } : null,
    }
  })

  // ---- Recommended conservative estimator for host-core (estimated, not yet measured live). ----
  const recommendedEstimator = {
    form:
      'input_tokens_est = ceil(cjkPerChar*CJK_chars + asciiPerChar*ASCII_chars + requestOverhead), ' +
      'chars counted over state text plus the 4 noul question instructions (and optional criteria)',
    cjkPerChar: 1.05,
    asciiPerChar: 0.35,
    requestOverhead: 320,
    safetyFactor: 1.15,
    rationale:
      'CJK rate comes from 1,980 real input_tokens; the fixed request overhead is triangulated from three recorded TypeSafe responses ' +
      '(360 / 428 / 535 input tokens); ASCII 0.35 is deliberately above plain-English BPE (~0.25) to cover JSON/code punctuation.',
    caution:
      'ESTIMATED, not freshly measured: the live 4-sample calibrate mode is blocked by HTTP 451 (region block). ' +
      'Re-run --mode calibrate and replace these constants when the API is reachable.',
  }
  const recommendedChecks = documentedExamples.map((example) => {
    const body = documentedBodies.get(example.id)
    const strings = [...collectStrings(body.state), ...collectStrings(body.questions)]
    const predicted =
      estimateTextTokens(strings, recommendedEstimator.cjkPerChar, recommendedEstimator.asciiPerChar) +
      recommendedEstimator.requestOverhead
    return {
      id: example.id,
      documentedInputTokens: example.documentedInputTokens,
      predictedInputTokens: round2(predicted),
      errorPct: round2(((predicted - example.documentedInputTokens) / example.documentedInputTokens) * 100),
    }
  })
  const historicalRecommendedErrors = samples.map((sample) => {
    const strings = [sample.stateText, ...collectStrings(HISTORICAL_QUESTION)]
    const predicted =
      estimateTextTokens(strings, recommendedEstimator.cjkPerChar, recommendedEstimator.asciiPerChar) +
      recommendedEstimator.requestOverhead
    return ((predicted - sample.actualInputTokens) / sample.actualInputTokens) * 100
  })
  const historicalRecommendedCheck = {
    note: 'historical set has ONE choice question, so the 4-noul overhead constant overestimates it by design',
    meanPredictedErrorPct: round2(
      historicalRecommendedErrors.reduce((sum, value) => sum + value, 0) / historicalRecommendedErrors.length,
    ),
    mapePct: round2(
      historicalRecommendedErrors.reduce((sum, value) => sum + Math.abs(value), 0) / historicalRecommendedErrors.length,
    ),
  }

  const sampleRows = residuals.slice(0, 15).map((residual) => ({
    rowId: residual.sample.rowId,
    textChars: residual.sample.textChars,
    bodyChars: residual.sample.metrics.bodyChars,
    cjkChars: residual.sample.metrics.cjkChars,
    asciiChars: residual.sample.metrics.asciiChars,
    actualInputTokens: residual.sample.actualInputTokens,
    predictedTokens: round2(residual.predicted),
    errorPct: round2(((residual.predicted - residual.sample.actualInputTokens) / residual.sample.actualInputTokens) * 100),
  }))

  const artifact = scrubDeep({
    generatedAt: new Date().toISOString(),
    method: 'offline least-squares fit over reconstructed 2026-09-21 request bodies',
    note:
      'The live endpoint returned HTTP 451 (region block) on 2026-10-20, so fresh calibration calls could not run. ' +
      'These 1,980 (request body -> usage.input_tokens) pairs are REAL measured values from the user-owned ' +
      '2026-09-21 experiment. Bodies were reconstructed from the frozen payload builder in duibi/jev/jev_classify.py ' +
      '(prompt_lang=zh, model=jev-1.13.0, one choice question). No API key is involved or recorded.',
    source: {
      rawJsonl: args.raw,
      predsCsv: args.preds,
      model: HISTORICAL_MODEL,
      questionSet: HISTORICAL_QUESTION,
    },
    sampleCount: samples.length,
    skippedNoUsage,
    skippedNoText,
    totalActualInputTokens: totalActual,
    meanActualInputTokens: round2(meanActual),
    fit: {
      form: 'input_tokens ~= cjkChars(bodyJson) * cjkPerChar + asciiChars(bodyJson) * asciiPerChar + jsonOverhead',
      cjkPerChar: fit.cjkPerChar,
      asciiPerChar: fit.asciiPerChar,
      jsonOverhead: fit.jsonOverhead,
      r2: r2 === null ? null : round4(r2),
      mapePct: fit.mapePct,
    },
    errorStats: {
      mapePct: fit.mapePct,
      p50AbsPct: percentile(residuals.map((r) => r.absolutePct), 50),
      p90AbsPct: percentile(residuals.map((r) => r.absolutePct), 90),
      maxAbsPct: round2(Math.max(...residuals.map((r) => r.absolutePct))),
    },
    baselines: {
      naiveCjk1AsciiQuarter: { mapePct: meanPct(baselineNaive) },
      jsonCharsDiv4: { mapePct: meanPct(baselineCharsDiv4) },
    },
    stateTextFit: stateFit
      ? {
          form: 'input_tokens ~= cjkChars(stateText)*cjkPerChar + asciiChars(stateText)*asciiPerChar + fixedOverhead',
          cjkPerChar: stateFit.cjkPerChar,
          asciiPerChar: stateFit.asciiPerChar,
          fixedOverhead: stateFit.jsonOverhead,
          mapePct: stateFit.mapePct,
          note: 'fixedOverhead is specific to this one-choice-question set; do not reuse it across question sets',
        }
      : null,
    meanStateChars,
    overheadTriangulation: overheadAssumptions,
    recommendedEstimator,
    recommendedChecks,
    historicalRecommendedCheck,
    documentedExamples,
    sampleRows,
  })

  await mkdir(DOCS_DIR, { recursive: true })
  await writeFile(TOKEN_CALIB_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')

  log(`  samples joined: ${samples.length} (real usage.input_tokens), mean=${round2(meanActual)} tokens`)
  log(`  fit: cjkPerChar=${fit.cjkPerChar} asciiPerChar=${fit.asciiPerChar} jsonOverhead=${fit.jsonOverhead} R2=${round4(r2 ?? 0)} MAPE=${fit.mapePct}%`)
  log(`  error stats: p50=${artifact.errorStats.p50AbsPct}% p90=${artifact.errorStats.p90AbsPct}%`)
  log(`  baseline naive(cjk1/ascii0.25) MAPE=${artifact.baselines.naiveCjk1AsciiQuarter.mapePct}%`)
  log(`  baseline jsonChars/4 MAPE=${artifact.baselines.jsonCharsDiv4.mapePct}%`)
  if (stateFit) {
    log(
      `  state-text fit: cjkPerChar=${stateFit.cjkPerChar} asciiPerChar=${stateFit.asciiPerChar} ` +
        `fixedOverhead=${stateFit.jsonOverhead} MAPE=${stateFit.mapePct}%`,
    )
  }
  for (const assumption of overheadAssumptions) {
    log(
      `  overhead triangulation (ASCII=${assumption.asciiPerCharAssumption}/char): ` +
        assumption.rows.map((row) => `${row.questionCount}q implied=${row.impliedFixedOverhead}`).join(', '),
    )
    if (assumption.linearFit) {
      log(
        `    linear fit: fixedOverhead=${assumption.linearFit.fixedOverhead} ` +
          `perQuestionOverhead=${assumption.linearFit.perQuestionOverhead}`,
      )
    }
  }
  for (const check of recommendedChecks) {
    log(
      `  recommended check ${check.id}: predicted=${check.predictedInputTokens} documented=${check.documentedInputTokens} ` +
        `error=${check.errorPct}%`,
    )
  }
  log(
    `  recommended estimator: CJK ${recommendedEstimator.cjkPerChar}, ASCII ${recommendedEstimator.asciiPerChar}, ` +
      `overhead ${recommendedEstimator.requestOverhead} (historical 1q check MAPE=${historicalRecommendedCheck.mapePct}%, expected overestimate)`,
  )
  for (const example of documentedExamples) {
    log(
      `  doc check ${example.id}: documented=${example.documentedInputTokens} predicted=${example.predictedInputTokens} ` +
        `error=${example.errorPct}%`,
    )
  }
  log(`\nartifacts written: ${TOKEN_CALIB_PATH}`)
  return fit
}

// ---------------------------------------------------------------------------
// Token heuristics / calibration math
// ---------------------------------------------------------------------------

const CJK_CHAR_RE =
  /[\u1100-\u11ff\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u31c0-\u31ef\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/gu
const ASCII_CHAR_RE = /[\x00-\x7f]/gu

/** Character-composition metrics for a request body (the unit a host-side estimator sees). */
function bodyMetrics(body) {
  const text = JSON.stringify(body)
  const cjk = (text.match(CJK_CHAR_RE) || []).length
  const ascii = (text.match(ASCII_CHAR_RE) || []).length
  const other = [...text].length - cjk - ascii
  return {
    bodyChars: text.length,
    cjkChars: cjk,
    asciiChars: ascii,
    otherChars: other,
    // Heuristic A (the naive one the plugin spec assumed): CJK 1 token/char, ASCII 1/4 char.
    naiveTokens: Math.ceil(cjk * 1 + ascii * 0.25),
    // Heuristic B (simplest): JSON chars / 4.
    charsDiv4Tokens: Math.ceil(text.length / 4),
  }
}

/** Character-composition metrics for one plain text string (e.g. the state text alone). */
function textMetrics(text) {
  const cjk = (text.match(CJK_CHAR_RE) || []).length
  const ascii = (text.match(ASCII_CHAR_RE) || []).length
  const chars = [...text].length
  return {
    bodyChars: text.length,
    cjkChars: cjk,
    asciiChars: ascii,
    otherChars: chars - cjk - ascii,
    naiveTokens: Math.ceil(cjk * 1 + ascii * 0.25),
    charsDiv4Tokens: Math.ceil(text.length / 4),
  }
}

/**
 * Least-squares fit of actual input tokens against
 *   predicted = cjkChars * cjkPerChar + asciiChars * asciiPerChar + jsonOverhead
 * (3 unknowns, n >= 3 samples). Tiny ridge keeps the system solvable.
 */
function fitCoefficients(samples) {
  const rows = samples.map((s) => [s.metrics.cjkChars, s.metrics.asciiChars, 1])
  const y = samples.map((s) => s.actualInputTokens)
  const normal = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  const rhs = [0, 0, 0]
  for (let r = 0; r < rows.length; r += 1) {
    for (let i = 0; i < 3; i += 1) {
      rhs[i] += rows[r][i] * y[r]
      for (let j = 0; j < 3; j += 1) normal[i][j] += rows[r][i] * rows[r][j]
    }
  }
  const ridge = 1e-6
  for (let i = 0; i < 3; i += 1) normal[i][i] += ridge
  const solution = solve3(normal, rhs)
  if (!solution) return null
  const [cjkPerChar, asciiPerChar, jsonOverhead] = solution
  let sumAbsPct = 0
  const predictions = samples.map((s) => {
    const predicted = s.metrics.cjkChars * cjkPerChar + s.metrics.asciiChars * asciiPerChar + jsonOverhead
    const errorPct = s.actualInputTokens > 0 ? ((predicted - s.actualInputTokens) / s.actualInputTokens) * 100 : 0
    sumAbsPct += Math.abs(errorPct)
    return { sample: s.id, actualInputTokens: s.actualInputTokens, predictedTokens: round2(predicted), errorPct: round2(errorPct) }
  })
  return {
    cjkPerChar: round4(cjkPerChar),
    asciiPerChar: round4(asciiPerChar),
    jsonOverhead: round2(jsonOverhead),
    mapePct: round2(sumAbsPct / Math.max(1, samples.length)),
    predictions,
  }
}

/** Gaussian elimination with partial pivoting for a 3x3 system. */
function solve3(matrix, rhs) {
  const a = matrix.map((row, i) => [...row, rhs[i]])
  for (let col = 0; col < 3; col += 1) {
    let pivot = col
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null
    ;[a[col], a[pivot]] = [a[pivot], a[col]]
    const div = a[col][col]
    for (let j = col; j < 4; j += 1) a[col][j] /= div
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue
      const factor = a[row][col]
      if (factor === 0) continue
      for (let j = col; j < 4; j += 1) a[row][j] -= factor * a[col][j]
    }
  }
  return [a[0][3], a[1][3], a[2][3]]
}

/** Least-squares line y = m0 + m1*x with design rows [1, x]. */
function fitLine(rows, y) {
  let s00 = 0
  let s01 = 0
  let s11 = 0
  let t0 = 0
  let t1 = 0
  for (let i = 0; i < rows.length; i += 1) {
    const [a, b] = rows[i]
    s00 += a * a
    s01 += a * b
    s11 += b * b
    t0 += a * y[i]
    t1 += b * y[i]
  }
  const det = s00 * s11 - s01 * s01
  if (Math.abs(det) < 1e-9) return null
  const m0 = (t0 * s11 - t1 * s01) / det
  const m1 = (s00 * t1 - s01 * t0) / det
  return [m0, m1]
}

const round2 = (n) => Math.round(n * 100) / 100
const round4 = (n) => Math.round(n * 10000) / 10000

/** Explain a real main/calibration result in one flat object (what host-core needs). */
function summarizeSystemOneResult(result) {
  const json = result.json
  const answers = json?.answers && typeof json.answers === 'object' ? json.answers : {}
  const flat = {}
  for (const [id, answer] of Object.entries(answers)) {
    const keys = answer && typeof answer === 'object' ? Object.keys(answer) : []
    flat[id] = {
      type: answer?.type ?? null,
      noul: typeof answer?.noul === 'number' ? answer.noul : null,
      keys,
    }
  }
  return {
    status: result.status,
    ok: result.ok,
    model: json?.model ?? null,
    answerIds: Object.keys(answers),
    answers: flat,
    usage: json?.usage ?? null,
    latencyMs: result.latencyMs,
    attempts: result.attempts,
    headers: result.headers,
    error: result.error ?? null,
  }
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

const state = {
  generatedAt: new Date().toISOString(),
  probe: 'scripts/jev-probe.mjs',
  baseUrl: BASE_URL,
  requestedModel: REQUESTED_MODEL,
  keyPresent: API_KEY.length > 0,
  keyLength: API_KEY.length,
  requestedHeaders: ['content-type', 'authorization (never recorded)', 'accept'],
  modes: {},
  billableRequests: 0,
  note: 'All artifacts are sanitized: no Authorization header and no API key are recorded.',
}

async function modeModels() {
  log('\n== GET /v1/models (free) ==')
  const result = await httpCall('/v1/models', { method: 'GET', auth: true, retries: 2 })
  const record = {
    status: result.status,
    ok: result.ok,
    latencyMs: result.latencyMs,
    headers: result.headers,
    models: result.ok && Array.isArray(result.json?.models) ? result.json.models : null,
    error: result.error ?? null,
  }
  log(`HTTP ${result.status} in ${result.latencyMs}ms`)
  if (record.models) {
    for (const model of record.models) log(`  ${model.name}  release=${model.release_date}  ${model.description ?? ''}`)
  } else if (!result.ok) {
    log(`  error: ${result.error}`)
  }
  state.modes.models = record
  return result.ok
}

async function modeMain() {
  log('\n== POST /v1/systemone — 4 noul questions over mixed CJK/English state ==')
  const body = { model: REQUESTED_MODEL, state: MAIN_STATE, questions: MAIN_QUESTIONS }
  const metrics = bodyMetrics(body)
  const result = await httpCall('/v1/systemone', { body, retries: 2 })
  state.billableRequests += result.ok ? 1 : 0
  const summary = summarizeSystemOneResult(result)

  log(`HTTP ${summary.status} in ${summary.latencyMs}ms, response model: ${summary.model}`)
  if (summary.ok) {
    log('answers (full JSON — the key evidence):')
    log(JSON.stringify(summary.answers, null, 2))
    log(`usage: ${JSON.stringify(summary.usage)}`)
  } else {
    log(`ERROR: ${summary.error}`)
  }

  state.modes.main = {
    request: {
      model: REQUESTED_MODEL,
      state: MAIN_STATE,
      questions: MAIN_QUESTIONS,
      stateChars: [...MAIN_STATE].length,
    },
    response: summary,
    metrics,
  }
  return { ok: summary.ok, summary, metrics }
}

async function modeAlias() {
  log('\n== POST /v1/systemone — model alias resolution (model=jev-latest) ==')
  const aliasBody = {
    model: 'jev-latest',
    state: 'I was charged twice for my subscription this month. Please refund the extra charge.',
    questions: { billing: { type: 'noul', instructions: 'Is this message about billing?' } },
  }
  const result = await httpCall('/v1/systemone', { body: aliasBody, retries: 2 })
  state.billableRequests += result.ok ? 1 : 0
  const summary = summarizeSystemOneResult(result)
  log(`HTTP ${summary.status} in ${summary.latencyMs}ms, requested model: jev-latest, response model: ${summary.model}`)
  log(`answers: ${JSON.stringify(summary.answers)}`)
  state.modes.alias = {
    requestedModel: 'jev-latest',
    request: aliasBody,
    response: summary,
  }
  return summary.ok
}

async function modeCalibrate(mainMetrics, mainUsage) {
  log('\n== token calibration — 3 real calls (short CJK / long mixed / code) ==')
  const samples = []

  // Fold the main probe call in as a 4th calibration point when available.
  if (mainMetrics && mainUsage && Number.isFinite(mainUsage.input_tokens)) {
    samples.push({
      id: 'agent-mixed-main',
      label: '主探针混合段（复用 main 调用）',
      actualInputTokens: mainUsage.input_tokens,
      metrics: mainMetrics,
      outputTokens: mainUsage.output_tokens,
    })
    log(`  [reused] agent-mixed-main: input_tokens=${mainUsage.input_tokens}`)
  }

  let index = 0
  for (const sample of CALIBRATION_SAMPLES) {
    const body = { model: REQUESTED_MODEL, state: sample.state, questions: MAIN_QUESTIONS }
    const metrics = bodyMetrics(body)
    if (index > 0) await sleep(350) // be polite to the rate limiter
    const result = await httpCall('/v1/systemone', { body, retries: 2 })
    index += 1
    const summary = summarizeSystemOneResult(result)
    const actual = typeof summary.usage?.input_tokens === 'number' ? summary.usage.input_tokens : null
    if (result.ok) state.billableRequests += 1
    samples.push({
      id: sample.id,
      label: sample.label,
      status: summary.status,
      ok: summary.ok,
      model: summary.model,
      stateChars: [...sample.state].length,
      actualInputTokens: actual,
      outputTokens: summary.usage?.output_tokens ?? null,
      metrics,
      error: summary.error,
    })
    log(
      `  ${sample.id}: HTTP ${summary.status} input_tokens=${actual} output_tokens=${summary.usage?.output_tokens ?? '?'} ` +
        `cjk=${metrics.cjkChars} ascii=${metrics.asciiChars} bodyChars=${metrics.bodyChars} ` +
        `naive=${metrics.naiveTokens} charsDiv4=${metrics.charsDiv4Tokens}`,
    )
  }

  const fitInput = samples.filter((s) => s.ok && typeof s.actualInputTokens === 'number' && s.actualInputTokens > 0)
  const fit = fitInput.length >= 3 ? fitCoefficients(fitInput) : null
  if (fit) {
    log(
      `  least-squares fit: cjkPerChar=${fit.cjkPerChar} asciiPerChar=${fit.asciiPerChar} ` +
        `jsonOverhead=${fit.jsonOverhead} MAPE=${fit.mapePct}%`,
    )
  } else {
    log('  not enough successful samples to fit coefficients')
  }

  state.modes.calibration = {
    model: REQUESTED_MODEL,
    questions: MAIN_QUESTIONS,
    samples,
    fit,
  }
  return fit
}

async function modeErrors() {
  log('\n== negative probes (no inference billed) — real error body shapes ==')
  const cases = [
    {
      id: 'missing-auth',
      label: 'missing Authorization header',
      path: '/v1/systemone',
      auth: false,
      body: { model: REQUESTED_MODEL, state: 'hello', questions: { q: { type: 'noul', instructions: 'Is this a test?' } } },
      expect: 401,
    },
    {
      id: 'invalid-key',
      label: 'invalid bearer token',
      path: '/v1/systemone',
      auth: false,
      headers: { authorization: 'Bearer probe_invalid_key_not_real' },
      body: { model: REQUESTED_MODEL, state: 'hello', questions: { q: { type: 'noul', instructions: 'Is this a test?' } } },
      expect: 401,
    },
    {
      id: 'missing-questions',
      label: 'valid key, body missing questions',
      path: '/v1/systemone',
      auth: true,
      body: { model: REQUESTED_MODEL, state: 'hello' },
      expect: 422,
    },
    {
      id: 'empty-questions',
      label: 'valid key, empty questions object',
      path: '/v1/systemone',
      auth: true,
      body: { model: REQUESTED_MODEL, state: 'hello', questions: {} },
      expect: 422,
    },
    {
      id: 'bad-question-type',
      label: 'valid key, unknown question type',
      path: '/v1/systemone',
      auth: true,
      body: { model: REQUESTED_MODEL, state: 'hello', questions: { q: { type: 'nope', instructions: 'x' } } },
      expect: 422,
    },
    {
      id: 'unknown-model',
      label: 'valid key, unknown model name',
      path: '/v1/systemone',
      auth: true,
      body: { model: 'jev-does-not-exist-0.0.1', state: 'hello', questions: { q: { type: 'noul', instructions: 'Is this a test?' } } },
      expect: null,
    },
    {
      id: 'unknown-path',
      label: 'valid key, unknown path',
      path: '/v1/does-not-exist',
      auth: true,
      body: { hello: 'world' },
      expect: 404,
    },
  ]

  const results = []
  for (const testCase of cases) {
    const startedAt = performance.now()
    const headers = { accept: 'application/json', 'content-type': 'application/json' }
    if (testCase.auth) headers.authorization = `Bearer ${API_KEY}`
    if (testCase.headers) Object.assign(headers, testCase.headers)
    let status = null
    let json = null
    let rawText = ''
    let networkError = null
    try {
      const response = await fetch(`${BASE_URL}${testCase.path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(testCase.body),
        signal: AbortSignal.timeout(20_000),
      })
      status = response.status
      rawText = await response.text()
      try {
        json = rawText ? JSON.parse(rawText) : null
      } catch {
        json = null
      }
    } catch (error) {
      networkError = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
    }
    const record = {
      id: testCase.id,
      label: testCase.label,
      expected: testCase.expect,
      status,
      latencyMs: Math.round(performance.now() - startedAt),
      contentType: null,
      body: json,
      rawText: json === null ? scrub(rawText.slice(0, 2_000)) : undefined,
      networkError,
    }
    log(`  ${testCase.id}: HTTP ${status} ${record.latencyMs}ms -> ${json ? JSON.stringify(json).slice(0, 300) : scrub(rawText.slice(0, 300))}`)
    results.push(record)
    await sleep(150)
  }
  state.modes.errors = results
  return results
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('TypeSafe Jev probe')
  log(`  baseUrl: ${BASE_URL}`)
  log(`  requested model: ${REQUESTED_MODEL}`)
  log(`  JEV_API_KEY present: ${API_KEY.length > 0} (length=${API_KEY.length}, stored only in memory)`)

  // Offline mode: no API key and no network call by design.
  if (args.mode === 'tokencalib') {
    await modeTokenCalib()
    return
  }

  if (!API_KEY) {
    console.error('FATAL: JEV_API_KEY is empty. Refusing to run: results would be fabricated.')
    console.error('Set it in-process from the .env file, then start node — never on the command line.')
    process.exit(2)
  }

  let mainOk = null
  let mainMetrics = null
  let mainUsage = null
  let failure = null

  if (args.mode === 'models' || args.mode === 'all') {
    const ok = await modeModels()
    if (!ok) failure = `GET /v1/models failed with HTTP ${state.modes.models?.status ?? 'network error'}`
  }

  if (args.mode === 'main' || args.mode === 'all') {
    const { ok, summary, metrics } = await modeMain()
    mainOk = ok
    mainMetrics = metrics
    mainUsage = summary.usage
    if (!ok) failure = failure || `POST /v1/systemone failed with HTTP ${summary.status ?? 'network error'}`
  }

  if (args.mode === 'alias' || args.mode === 'all') {
    const ok = await modeAlias()
    if (!ok && !failure) failure = 'alias call failed'
  }

  if (args.mode === 'calibrate' || args.mode === 'all') {
    await modeCalibrate(mainMetrics, mainUsage)
  }

  if (args.mode === 'errors' || args.mode === 'all') {
    await modeErrors()
  }

  state.finishedAt = new Date().toISOString()
  state.ok = args.mode === 'errors' ? true : mainOk !== false && !failure
  if (failure) state.failure = failure

  await mkdir(DOCS_DIR, { recursive: true })
  const artifact = scrubDeep(state)
  await writeFile(RESULT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  log(`\nartifacts written: ${RESULT_PATH}`)
  log(`  billable POST /v1/systemone calls: ${state.billableRequests}`)
  if (failure) {
    log(`  FAILURE: ${failure} (artifact records the real status; nothing fabricated)`)
    // Set exitCode instead of process.exit: process.exit() while undici keep-alive
    // sockets are open trips a libuv assertion on Windows (exit code 0xC0000409).
    process.exitCode = 3
    return
  }
  log('done.')
}

await main()
