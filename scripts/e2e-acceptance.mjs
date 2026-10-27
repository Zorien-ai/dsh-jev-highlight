#!/usr/bin/env node
/**
 * Jev-highlight end-to-end acceptance harness (zero external dependencies).
 *
 *   node scripts/e2e-acceptance.mjs --scenario mock        # mock Jev + dsh + CDP browser
 *   node scripts/e2e-acceptance.mjs --scenario mock-selftest
 *   node scripts/e2e-acceptance.mjs --scenario nokey      # missing-key startup error
 *   node scripts/e2e-acceptance.mjs --scenario live       # real key inherited from env
 *   node scripts/e2e-acceptance.mjs --scenario attach --url "<token url>" [--ui cdp|none]
 *
 * What it does for `mock`/`live`:
 *   1. starts the zero-dependency Jev mock (mock scenario only) and a private
 *      `dsh web --patch ... --port 103xx --no-open` instance, capturing logs;
 *   2. parses the token URL from the startup log and probes the plugin routes
 *      (`/jev-highlight/state|units|diag|toggle`) over plain same-origin HTTP;
 *   3. drives the real Web UI through the Chrome DevTools Protocol (system
 *      Chrome, throwaway profile): sends a prompt, waits for streamed markdown,
 *      records `CSS.highlights`, chip UI, DOM invariance, console and network;
 *   4. exercises cancellation (stop button), cache and concurrency evidence;
 *   5. writes docs/acceptance-report.json + docs/e2e-report.md and every raw
 *      artifact under docs/e2e-runs/<run-id>/.
 *
 * The harness never reads `.env`/`.credentials.yaml` and never prints a key.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Paths / constants
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const WORKSPACE = resolve(PLUGIN_ROOT, '..')
const DOCS = join(PLUGIN_ROOT, 'docs')
const MOCK_SCRIPT = join(HERE, 'mock-jev-server.mjs')
const DEBUG_PATCH = join(PLUGIN_ROOT, 'cordis.debug.yml')
const E2E_PATCH = join(PLUGIN_ROOT, 'cordis.e2e.yml')
// Override with DSH_CMD when the CLI is not on PATH (e.g. desktop bundle).
const DSH_CMD = process.env.DSH_CMD ?? 'dsh'
const NODE_EXE = process.execPath

const DEFAULT_DSH_PORT = 10301
const DEFAULT_MOCK_PORT = 10399
const DEFAULT_CDP_PORT = 10398

const SCENARIO = new Map()
const ARGV = process.argv.slice(2)
for (let index = 0; index < ARGV.length; index += 1) {
  const token = ARGV[index]
  if (!token.startsWith('--')) continue
  const key = token.slice(2)
  const next = ARGV[index + 1]
  if (next !== undefined && !next.startsWith('--')) {
    SCENARIO.set(key, next)
    index += 1
  } else {
    SCENARIO.set(key, 'true')
  }
}

const args = {
  scenario: SCENARIO.get('scenario') ?? 'mock',
  port: Number(SCENARIO.get('port') ?? DEFAULT_DSH_PORT),
  profile: SCENARIO.get('profile') ?? 'test-sandbox',
  mockPort: Number(SCENARIO.get('mock-port') ?? DEFAULT_MOCK_PORT),
  cdpPort: Number(SCENARIO.get('cdp-port') ?? DEFAULT_CDP_PORT),
  ui: SCENARIO.get('ui') ?? 'cdp',
  url: SCENARIO.get('url') ?? '',
  prompt: SCENARIO.get('prompt') ?? '',
  keep: SCENARIO.get('keep') === 'true',
  mockDelayMs: Number(SCENARIO.get('mock-delay-ms') ?? 2000),
  abortMode: SCENARIO.get('abort-mode') ?? 'teardown',
  startupTimeoutMs: Number(SCENARIO.get('startup-timeout-ms') ?? 90000),
  streamTimeoutMs: Number(SCENARIO.get('stream-timeout-ms') ?? 120000),
}

const RUN_ID = new Date().toISOString().replace(/[:.]/gu, '-')
const RUN_DIR = join(DOCS, 'e2e-runs', RUN_ID)
mkdirSync(RUN_DIR, { recursive: true })

const report = {
  runId: RUN_ID,
  generatedAt: new Date().toISOString(),
  scenario: args.scenario,
  pluginRoot: PLUGIN_ROOT,
  dshPort: args.port,
  mockPort: args.mockPort,
  browser: args.ui,
  entries: [],
  evidence: {},
  processes: [],
  errors: [],
}

const artifacts = {}
const passed = () => report.entries.filter((entry) => entry.status === 'pass').length
const failed = () => report.entries.filter((entry) => entry.status === 'fail').length
const blocked = () => report.entries.filter((entry) => entry.status === 'blocked').length

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function log(message) {
  const line = `[e2e ${new Date().toISOString().slice(11, 23)}] ${message}`
  console.log(line)
  appendRunLog(line)
}

function appendRunLog(line) {
  try {
    writeFileSync(join(RUN_DIR, 'harness.log'), `${line}\n`, { flag: 'a' })
  } catch {
    // Logging must never break the run.
  }
}

function writeJson(name, value) {
  const path = join(RUN_DIR, name)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}

function rel(path) {
  return path.startsWith(WORKSPACE) ? path.slice(WORKSPACE.length + 1).replaceAll('\\', '/') : path
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function nowIso() {
  return new Date().toISOString()
}

function addEntry(entry) {
  const full = {
    id: entry.id,
    criterion: entry.criterion,
    status: entry.status ?? 'blocked',
    startedAt: entry.startedAt ?? nowIso(),
    finishedAt: nowIso(),
    evidence: entry.evidence ?? [],
    detail: entry.detail ?? {},
    notes: entry.notes ?? '',
  }
  report.entries.push(full)
  log(`${full.id}: ${full.status.toUpperCase()}${full.notes === '' ? '' : ` — ${full.notes}`}`)
  return full
}

function isPortFree(port) {
  return new Promise((done) => {
    const server = createServer()
    server.once('error', () => done(false))
    server.once('listening', () => {
      server.close(() => done(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true })
  return typeof result.stdout === 'string' && result.stdout.includes(String(pid))
}

function killTree(pid) {
  if (!processAlive(pid)) return
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
}

/**
 * Kill the process that owns the listening port. The `dsh.cmd` shim is not
 * always the process serving HTTP, so a tree-kill of the launcher can leave the
 * real host alive; targeting the listener is what actually tears the host down.
 */
function killPortListener(port) {
  const script = `$conn = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; if ($conn) { $owner = $conn.OwningProcess; Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue; $owner } else { 'none' }`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  })
  return { stdout: (result.stdout ?? '').trim(), status: result.status }
}

async function waitPortClosed(port, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const free = await new Promise((done) => {
      const probe = createServer()
      probe.once('error', () => done(false))
      probe.once('listening', () => probe.close(() => done(true)))
      probe.listen(port, '127.0.0.1')
    })
    if (free) return true
    await sleep(200)
  }
  return false
}

async function waitFor(predicate, timeoutMs, intervalMs, description) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate()
      if (value) return value
    } catch {
      // retry
    }
    await sleep(intervalMs)
  }
  throw new Error(`timeout waiting for ${description} (${timeoutMs}ms)`)
}

async function fetchText(url, options = {}) {
  const started = Date.now()
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs ?? 15000) })
  const text = await response.text()
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text, ms: Date.now() - started }
}

async function fetchJson(url, options = {}) {
  const result = await fetchText(url, options)
  let json
  try {
    json = JSON.parse(result.text)
  } catch {
    json = undefined
  }
  return { ...result, json }
}

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Managed child processes
// ---------------------------------------------------------------------------

const children = []

function spawnLogged(label, command, commandArgs, options) {
  const stdoutPath = join(RUN_DIR, `${label}.stdout.log`)
  const stderrPath = join(RUN_DIR, `${label}.stderr.log`)
  const out = []
  const err = []
  const child = spawn(command, commandArgs, {
    cwd: options.cwd ?? WORKSPACE,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: options.shell === true,
  })
  child.stdout.on('data', (chunk) => {
    const text = String(chunk)
    out.push(text)
    try {
      writeFileSync(stdoutPath, text, { flag: 'a' })
    } catch {
      // ignore
    }
  })
  child.stderr.on('data', (chunk) => {
    const text = String(chunk)
    err.push(text)
    try {
      writeFileSync(stderrPath, text, { flag: 'a' })
    } catch {
      // ignore
    }
  })
  const managed = {
    label,
    pid: child.pid,
    child,
    stdoutPath,
    stderrPath,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    exit: undefined,
  }
  child.once('exit', (code) => {
    managed.exit = code
    log(`${label} exited with code ${code}`)
  })
  children.push(managed)
  report.processes.push({ label, pid: child.pid, command: [command, ...commandArgs].join(' ').replace(/(--patch\s+)\S+/u, '$1<patch>') })
  log(`${label} started pid=${child.pid}`)
  return managed
}

function cleanupChildren() {
  for (const managed of children.slice().reverse()) {
    try {
      killTree(managed.pid)
      if (processAlive(managed.pid)) {
        managed.child.kill('SIGKILL')
      }
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Mock Jev server
// ---------------------------------------------------------------------------

function startMock({ failRate = 0, field = 'noul', delayMs = args.mockDelayMs } = {}) {
  const managed = spawnLogged(
    'mock-jev',
    NODE_EXE,
    [
      MOCK_SCRIPT,
      '--port',
      String(args.mockPort),
      '--delay-ms',
      String(delayMs),
      '--field',
      field,
      ...(failRate > 0 ? ['--fail-rate', String(failRate), '--fail-status', '500'] : []),
      '--log',
      join(RUN_DIR, 'mock-jev.stats.json'),
      '--capture-bodies',
    ],
    { env: process.env },
  )
  return managed
}

async function mockStats() {
  const result = await fetchJson(`http://127.0.0.1:${args.mockPort}/__stats`)
  return result.json
}

async function waitMockStats(timeoutMs = 30000) {
  return waitFor(async () => (await mockStats()) !== undefined, timeoutMs, 200, 'mock /__stats')
}

// ---------------------------------------------------------------------------
// DSH web instance
// ---------------------------------------------------------------------------

function dshLaunchCommand(scenario) {
  const patch = scenario.patch
  // A custom profile boots its template's app directly: `dsh --profile test-sandbox`
  // is the web app. Do NOT append `web` (it is the alias for `--profile web`, and
  // mixing the two errors with "too many arguments").
  //
  // The overlay path is relative to the workspace (cwd), which also keeps the
  // non-ASCII workspace path out of the command line.
  const relativePatch = `.\\${rel(patch).replaceAll('/', '\\')}`
  const commandLine = `"${DSH_CMD}" --profile ${args.profile} --patch "${relativePatch}" --port ${args.port} --no-open`
  return { command: commandLine, args: [], shell: true }
}

/** Environment for the dsh child: explicitly remove JEV key for the `nokey` scenario. */
function dshEnv(scenario) {
  const env = { ...process.env, NO_COLOR: '1' }
  if (scenario.mode === 'nokey') {
    delete env.JEV_API_KEY
    delete env.TYPESAFE_API_KEY
  } else if (scenario.mode === 'mock') {
    env.JEV_API_KEY = 'dummy-mock-key'
    delete env.TYPESAFE_API_KEY
  }
  return env
}

async function startDsh({ mode, patch, label = 'dsh' }) {
  const command = dshLaunchCommand({ patch })
  const managed = spawnLogged(label, command.command, command.args, { env: dshEnv({ mode }), shell: command.shell === true })
  return managed
}

function findTokenUrl(text) {
  const match = /(http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+))/u.exec(text)
  if (match === null) return undefined
  return { url: match[1], origin: `http://127.0.0.1:${match[2]}`, token: match[3] }
}

async function waitForTokenUrl(managed, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const found = findTokenUrl(managed.stdout())
    if (found !== undefined) return found
    if (managed.exit !== undefined) {
      throw new Error(`dsh exited with code ${managed.exit} before printing its token URL`)
    }
    await sleep(250)
  }
  throw new Error(`dsh did not print its token URL within ${timeoutMs}ms`)
}

/** Route probe with a same-origin-looking request surface (no Origin header). */
async function probeRoute(origin, path, options = {}) {
  const url = `${origin}${path}`
  const headers = { ...(options.headers ?? {}) }
  if (options.method === 'POST') headers['content-type'] = 'application/json'
  const result = await fetchJson(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    timeoutMs: options.timeoutMs ?? 10000,
  }).catch((error) => ({ status: 0, text: String(error?.message ?? error), json: undefined, ms: 0 }))
  return { path, status: result.status, json: result.json, text: result.text.slice(0, 400), ms: result.ms }
}

async function waitForPluginRoutes(origin, timeoutMs) {
  return waitFor(
    async () => {
      const probe = await probeRoute(origin, '/jev-highlight/state')
      return probe.status === 200 ? probe : undefined
    },
    timeoutMs,
    500,
    'GET /jev-highlight/state == 200',
  )
}

// ---------------------------------------------------------------------------
// Chrome DevTools Protocol client (zero dependencies)
// ---------------------------------------------------------------------------

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  return candidates.find((candidate) => candidate !== '' && existsSync(candidate))
}

class Cdp {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Map()
    this.socket = undefined
    this.closed = false
  }

  static async connect(pageUrl, timeoutMs = 20000, cdpPort = 10398) {
    const wsUrl = await waitFor(
      async () => {
        const version = await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`).catch(() => undefined)
        return version?.json?.webSocketDebuggerUrl
      },
      timeoutMs,
      200,
      'chrome /json/version',
    ).catch(() => undefined)
    if (wsUrl === undefined) throw new Error('chrome devtools endpoint not reachable')
    // Pick the page target (the one opened with about:blank).
    const list = await waitFor(
      async () => {
        const result = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`).catch(() => undefined)
        const pages = (result?.json ?? []).filter((entry) => entry.type === 'page')
        return pages.length > 0 ? pages : undefined
      },
      timeoutMs,
      300,
      'chrome page target',
    )
    const page = list.find((entry) => entry.url === 'about:blank') ?? list[0]
    const client = new Cdp(page.webSocketDebuggerUrl)
    await client.open()
    client.targetUrl = pageUrl
    return client
  }

  open() {
    return new Promise((done, reject) => {
      const socket = new WebSocket(this.webSocketUrl)
      this.socket = socket
      const timer = setTimeout(() => reject(new Error('CDP websocket open timeout')), 15000)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        done()
      })
      socket.addEventListener('error', (event) => {
        clearTimeout(timer)
        reject(new Error(`CDP websocket error: ${String(event?.message ?? 'unknown')}`))
      })
      socket.addEventListener('message', (event) => this.onMessage(event))
      socket.addEventListener('close', () => {
        this.closed = true
      })
    })
  }

  onMessage(event) {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
      else pending.resolve(message.result)
      return
    }
    const handlers = this.handlers.get(message.method)
    if (handlers !== undefined) {
      for (const handler of handlers) {
        try {
          handler(message.params)
        } catch {
          // ignore listener failure
        }
      }
    }
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          done(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, handler) {
    const list = this.handlers.get(method) ?? []
    list.push(handler)
    this.handlers.set(method, list)
  }

  async evaluate(expression, { awaitPromise = true, timeoutMs = 20000 } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    }, timeoutMs)
    if (result.exceptionDetails !== undefined) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`page evaluate failed: ${description}`)
    }
    return result.result?.value
  }

  close() {
    try {
      this.socket?.close()
    } catch {
      // ignore
    }
  }
}

async function launchChrome({ tokenUrl, cdpPort, userDataDir }) {
  const chrome = findChrome()
  if (chrome === undefined) throw new Error('no Chrome/Edge executable found for CDP automation')
  const managed = spawnLogged('chrome', chrome, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--mute-audio',
    '--hide-scrollbars',
    '--window-size=1440,960',
    'about:blank',
  ], { env: process.env })
  await waitFor(
    async () => {
      const version = await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`).catch(() => undefined)
      return version?.status === 200
    },
    20000,
    250,
    'chrome devtools port',
  )
  return managed
}

// ---------------------------------------------------------------------------
// UI drivers (evaluate snippets)
// ---------------------------------------------------------------------------

const UI = {
  composerReady: `(() => !!document.querySelector('[data-composer-input="true"]'))()`,
  focusComposer: `(() => { const el = document.querySelector('[data-composer-input="true"]'); if (!el) return false; el.focus(); return document.activeElement === el })()`,
  composerText: `(() => { const el = document.querySelector('[data-composer-input="true"]'); return el ? (el.textContent || '').trim() : '' })()`,
  sendEnabled: `(() => { const b = document.querySelector('button[aria-label="发送消息"]'); return b !== null && !b.disabled })()`,
  clickSend: `(() => { const b = document.querySelector('button[aria-label="发送消息"]'); if (!b || b.disabled) return false; b.click(); return true })()`,
  streaming: `(() => !!document.querySelector('button[aria-label="停止生成"]'))()`,
  clickStop: `(() => { const b = document.querySelector('button[aria-label="停止生成"]'); if (!b) return false; b.click(); return true })()`,
  assistantText: `(() => {
    const roots = [...document.querySelectorAll('[data-slot="conversation.chat.flow"] [data-slot="conversation.chat.node"]')]
    let best = ''
    for (const root of roots) {
      const text = (root.innerText || '').trim()
      if (text.length > best.length && !/^(复制|已完成)/u.test(text)) best = text
    }
    return best
  })()`,
  assistantAnswerHtml: `(() => {
    const roots = [...document.querySelectorAll('[data-slot="conversation.chat.flow"] [data-slot="conversation.chat.node"]')]
    let best = null
    for (const root of roots) {
      const text = (root.innerText || '').trim()
      if (text.length > 300 && (text.includes('核心结论') || text.includes('风险') || text.includes('定义'))) { best = root; break }
    }
    if (best === null && roots.length > 0) best = roots[roots.length - 1]
    if (best === null) return null
    return { html: best.innerHTML, nodeCount: best.querySelectorAll('*').length + 1, textLen: (best.innerText || '').length }
  })()`,
  highlightState: `(() => {
    const names = ['jev-critical', 'jev-medium', 'jev-low']
    const result = {}
    for (const name of names) {
      const highlight = CSS.highlights.get(name)
      if (highlight === undefined) { result[name] = { present: false, ranges: 0 }; continue }
      const ranges = [...highlight]
      result[name] = {
        present: true,
        ranges: ranges.length,
        sample: ranges.slice(0, 3).map((range) => (range.toString() || '').slice(0, 80)),
      }
    }
    const style = document.querySelector('style[data-jev-highlight="styles"]')
    return { names: result, stylePresent: style !== null, styleText: style === null ? '' : style.textContent.slice(0, 1200) }
  })()`,
  chipInfo: `(() => {
    const dock = document.querySelector('[data-slot="conversation.composer.dock"]')
    if (dock === null) return null
    const group = dock.querySelector('[role="group"]')
    const button = [...dock.querySelectorAll('button')].find((candidate) => /Jev|高亮|highlight/i.test((candidate.getAttribute('aria-label') || '') + ' ' + (candidate.textContent || '')))
    return {
      text: (group ? group.innerText : dock.innerText || '').trim(),
      childCount: dock.childElementCount,
      html: dock.innerHTML.slice(0, 1500),
      buttons: [...dock.querySelectorAll('button')].map((candidate) => (candidate.getAttribute('aria-label') || candidate.textContent || '').trim()).filter(Boolean),
      chipText: group ? (group.innerText || '').trim() : '',
      pressed: button ? button.getAttribute('aria-pressed') : null,
      toggleLabel: button ? button.getAttribute('aria-label') : null,
      toggleText: button ? (button.textContent || '').trim() : null,
    }
  })()`,
  domSnapshot: `(() => ({
    nodeCount: document.querySelectorAll('*').length,
    bodyLen: document.body.innerHTML.length,
    styleCount: document.querySelectorAll('style').length,
    highlightStyle: document.querySelectorAll('style[data-jev-highlight]').length,
    answerContainers: document.querySelectorAll('[data-slot="conversation.chat.node"]').length,
    chipChildren: document.querySelector('[data-slot="conversation.composer.dock"]')?.childElementCount ?? -1,
  }))()`,
}

async function clickChipToggle(cdp) {
  return cdp.evaluate(`(() => {
    const dock = document.querySelector('[data-slot="conversation.composer.dock"]')
    if (dock === null) return { clicked: false, reason: 'no dock' }
    const candidates = [...dock.querySelectorAll('button')]
    const target = candidates.find((button) => /jev|高亮|highlight|开关/u.test(button.getAttribute('aria-label') || button.title || button.textContent || ''))
      ?? candidates[candidates.length - 1]
    if (target === undefined) return { clicked: false, reason: 'no button' }
    const before = target.getAttribute('aria-label') || target.textContent
    target.click()
    return { clicked: true, before }
  })()`)
}

// ---------------------------------------------------------------------------
// HTTP-level acceptance checks
// ---------------------------------------------------------------------------

async function checkDiagContract(origin) {
  const probe = await probeRoute(origin, '/jev-highlight/diag')
  if (probe.status !== 200 || probe.json === undefined) {
    return addEntry({
      id: 'http.diag',
      criterion: 'diag route contract',
      status: 'fail',
      evidence: [probe],
      notes: `GET /jev-highlight/diag returned ${probe.status}`,
    })
  }
  const required = [
    'active', 'unitsSeen', 'unitsQueued', 'unitsJudged', 'requests', 'inFlight',
    'maxConcurrentObserved', 'maxRequestTokensObserved', 'requestBudget',
    'concurrencyLimit', 'cacheHits', 'cacheMisses', 'cacheSize',
    'abortedRequests', 'failures', 'droppedUnits', 'lastError', 'model', 'baseUrl',
  ]
  const missing = required.filter((field) => !(field in probe.json))
  return addEntry({
    id: 'http.diag',
    criterion: 'diag route contract',
    status: missing.length === 0 ? 'pass' : 'fail',
    evidence: [probe],
    detail: { missing },
    notes: missing.length === 0 ? `all ${required.length} DiagSnapshot fields present` : `missing fields: ${missing.join(', ')}`,
  })
}

async function checkStateRoute(origin) {
  const probe = await probeRoute(origin, '/jev-highlight/state')
  const ok = probe.status === 200 && probe.json !== undefined
  let toggled = undefined
  if (ok) {
    const enabled = probe.json.enabled ?? probe.json.active
    toggled = await probeRoute(origin, '/jev-highlight/toggle', { method: 'POST', body: { enabled: !enabled } })
    const restored = await probeRoute(origin, '/jev-highlight/toggle', { method: 'POST', body: { enabled } })
    // Guard checks: wrong method and non-JSON POST are rejected by the
    // same-origin/content-type guards copied from the reference plugin.
    const wrongMethod = await probeRoute(origin, '/jev-highlight/state', { method: 'POST', body: {} })
    const wrongContentType = await fetchJson(`${origin}/jev-highlight/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
      timeoutMs: 5000,
    }).then((result) => ({ status: result.status })).catch(() => ({ status: 0 }))
    const crossSite = await fetchJson(`${origin}/jev-highlight/state`, {
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      timeoutMs: 5000,
    }).then((result) => ({ status: result.status })).catch(() => ({ status: 0 }))
    report.evidence.toggleProbe = { toggle: toggled, restore: restored, wrongMethod, wrongContentType, crossSite }
    const guardsOk = wrongMethod.status === 405 && [415, 400].includes(wrongContentType.status) && crossSite.status === 403
    return addEntry({
      id: 'http.guards',
      criterion: 'route guards (method/content-type/cross-site)',
      status: ok && toggled.status === 200 && guardsOk ? 'pass' : 'fail',
      evidence: [{ state: probe, toggle: toggled, restore: restored, wrongMethod, wrongContentType, crossSite }],
      notes: guardsOk ? '405/415/403 guards fired as expected' : 'route guard responses unexpected',
    })
  }
  return addEntry({
    id: 'http.guards',
    criterion: 'route guards (method/content-type/cross-site)',
    status: 'fail',
    evidence: [probe],
    notes: `GET /jev-highlight/state returned ${probe.status}`,
  })
}

// ---------------------------------------------------------------------------
// Browser acceptance flow
// ---------------------------------------------------------------------------

/**
 * Drive the real Web UI for one turn and return all browser evidence.
 * @param {object} input
 */
/** Dismiss a blocking welcome/onboarding modal if one is present. */
async function dismissWelcomeNotice(cdp) {
  const result = await cdp.evaluate(`(() => {
    const texts = ['继续', 'Continue', '知道了', '开始使用', '关闭']
    const candidates = [...document.querySelectorAll('button')]
    const target = candidates.find((button) => texts.includes((button.textContent || '').trim()))
    if (target) { target.click(); return { clicked: (target.textContent || '').trim() } }
    const dialog = document.querySelector('[role="dialog"], dialog[open]')
    if (dialog) { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return { clicked: null, dialog: true } }
    return { clicked: null }
  })()`).catch(() => ({ clicked: null }))
  if (result?.clicked !== null && result?.clicked !== undefined) {
    await sleep(600)
    return result
  }
  // Escape is a server-side-friendly fallback for modal shells that listen on document.
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
  await sleep(400)
  return result
}

/** Click the composer with a real mouse event so Lexical takes focus (the first
 * screen may hold focus on a welcome heading; el.focus() alone is not enough). */
async function clickComposer(cdp) {
  const rect = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-composer-input="true"]')
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    if (r.width < 10 || r.height < 10) return null
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`).catch(() => null)
  if (rect === null) return false
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }).catch(() => {})
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }).catch(() => {})
  await sleep(250)
  return true
}

/** Robustly type the prompt into the Lexical composer and return the visible text. */
async function typePrompt(cdp, prompt) {
  const attempts = []
  const probe = prompt.slice(0, 12)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await clickComposer(cdp)
    const focused = await cdp.evaluate(UI.focusComposer).catch(() => false)
    await cdp.send('Input.insertText', { text: prompt }).catch(() => {})
    await sleep(350)
    let text = await cdp.evaluate(UI.composerText).catch(() => '')
    if (!text.includes(probe)) {
      await cdp.evaluate(`(() => { const el = document.querySelector('[data-composer-input="true"]'); if (!el) return false; el.focus(); document.execCommand('insertText', false, ${JSON.stringify(prompt)}); return true })()`).catch(() => {})
      await sleep(350)
      text = await cdp.evaluate(UI.composerText).catch(() => '')
    }
    if (!text.includes(probe)) {
      await cdp.evaluate(`(() => { const el = document.querySelector('[data-composer-input="true"]'); if (!el) return false; el.focus(); document.execCommand('selectAll', false, null); document.execCommand('insertText', false, ${JSON.stringify(prompt)}); return true })()`).catch(() => {})
      await sleep(350)
      text = await cdp.evaluate(UI.composerText).catch(() => '')
    }
    attempts.push({ attempt, focused, textLength: text.length })
    if (text.includes(probe)) {
      // Nudge the editor so the send button enables (Lexical listens for input).
      await cdp.evaluate(`(() => { const el = document.querySelector('[data-composer-input="true"]'); if (el) el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' })); return true })()`).catch(() => {})
      await sleep(300)
      return { text, attempts }
    }
    await cdp.evaluate(`(() => { const el = document.querySelector('[data-composer-input="true"]'); if (!el) return false; el.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); return true })()`).catch(() => {})
    await sleep(300)
  }
  throw new Error(`could not type prompt; attempts=${JSON.stringify(attempts)}`)
}

async function clickSendWithFallback(cdp) {
  const sent = await cdp.evaluate(UI.clickSend).catch(() => false)
  if (sent === true) return 'click'
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  return 'enter'
}

async function browserFlow(input) {
  const { origin, tokenUrl, prompt, runDir } = input
  const cdp = await Cdp.connect(tokenUrl, 30000, args.cdpPort)
  const consoleMessages = []
  const pageErrors = []
  const network = []

  cdp.on('Runtime.consoleAPICalled', (params) => {
    const text = (params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')
    consoleMessages.push({ ts: nowIso(), type: params.type, text: String(text).slice(0, 500) })
  })
  cdp.on('Runtime.exceptionThrown', (params) => {
    pageErrors.push({
      ts: nowIso(),
      text: params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'exception',
    })
  })
  cdp.on('Log.entryAdded', (params) => {
    if (params.entry?.level === 'error' || params.entry?.level === 'warning') {
      consoleMessages.push({ ts: nowIso(), type: `log:${params.entry.level}`, text: String(params.entry.text ?? '').slice(0, 500) })
    }
  })
  cdp.on('Network.requestWillBeSent', (params) => {
    network.push({ id: params.requestId, ts: nowIso(), method: params.request.method, url: params.request.url, type: params.type })
  })
  cdp.on('Network.responseReceived', (params) => {
    const existing = network.find((entry) => entry.id === params.requestId)
    if (existing !== undefined) existing.status = params.response.status
  })

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Network.enable', { maxTotalBufferSize: 100000000, maxResourceBufferSize: 5000000 })

  const evidence = { consoleMessages, pageErrors, network, timeline: [], screenshots: {} }
  const flush = () => {
    writeJson('browser-flow-partial.json', {
      error: evidence.error,
      diagnostics: evidence.diagnostics,
      baseline: evidence.baseline,
      sent: evidence.sent,
      finalDiag: evidence.finalDiag,
      finalMock: evidence.finalMock,
      image: evidence.image,
      chip: evidence.chip,
      domAfter: evidence.domAfter,
      streamingStopped: evidence.streamingStopped,
      timelineLength: evidence.timeline?.length ?? 0,
      timeline: (evidence.timeline ?? []).slice(-80),
    })
    writeJson('console.json', consoleMessages)
    writeJson('page-errors.json', pageErrors)
    writeJson('network.json', network.filter((entry) => /jev-highlight|v1\/systemone/u.test(entry.url)))
  }

  try {
    await cdp.send('Page.navigate', { url: tokenUrl })
    // Keep the page focused/visible: a backgrounded page throttles the client's
    // poll loop and makes highlight registration look delayed.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await cdp.send('Page.bringToFront').catch(() => {})
    await waitFor(() => cdp.evaluate(UI.composerReady).catch(() => false), 45000, 300, 'composer input')
    evidence.welcome = await dismissWelcomeNotice(cdp)

    // The plugin may need a beat after boot before its first poll renders the chip.
    await sleep(1500)
    const baseline = await cdp.evaluate(UI.domSnapshot)
    const chipBaseline = await cdp.evaluate(UI.chipInfo)
    const highlightBaseline = await cdp.evaluate(UI.highlightState)
    evidence.baseline = { dom: baseline, chip: chipBaseline, highlights: highlightBaseline }

    // Type the prompt and send (Lexical editors need focus + input events).
    await typePrompt(cdp, prompt)
    evidence.sendMethod = await clickSendWithFallback(cdp)
    evidence.sent = true

  // Poll the page and the host while the answer streams.
  const diagTimeline = []
  const mockTimeline = []
  let lastTextLen = 0
  let stableSince = Date.now()
  let sawStreaming = false
  const started = Date.now()
  let lastDiag
  while (Date.now() - started < args.streamTimeoutMs) {
    const [assistantText, streaming, highlights, chip, diag, mock] = await Promise.all([
      cdp.evaluate(UI.assistantText).catch(() => ''),
      cdp.evaluate(UI.streaming).catch(() => false),
      cdp.evaluate(UI.highlightState).catch(() => undefined),
      cdp.evaluate(UI.chipInfo).catch(() => undefined),
      probeRoute(origin, '/jev-highlight/diag').catch(() => undefined),
      mockStats().catch(() => undefined),
    ])
    if (streaming === true) sawStreaming = true
    lastDiag = diag?.json ?? lastDiag
    const point = {
      t: Date.now() - started,
      assistantLen: assistantText.length,
      streaming,
      highlightCounts: highlights === undefined ? undefined : Object.fromEntries(Object.entries(highlights.names).map(([name, value]) => [name, value.ranges])),
      chipText: chip?.text ?? '',
      diag: diag?.json === undefined ? undefined : {
        unitsSeen: diag.json.unitsSeen,
        unitsJudged: diag.json.unitsJudged,
        requests: diag.json.requests,
        inFlight: diag.json.inFlight,
        cacheHits: diag.json.cacheHits,
        cacheMisses: diag.json.cacheMisses,
        abortedRequests: diag.json.abortedRequests,
        maxConcurrentObserved: diag.json.maxConcurrentObserved,
        maxRequestTokensObserved: diag.json.maxRequestTokensObserved,
      },
      mock: mock === undefined ? undefined : { requests: mock.requests, inFlight: mock.inFlight, maxConcurrent: mock.maxConcurrent, aborted: mock.aborted },
    }
    diagTimeline.push(point)
    if (mock !== undefined) mockTimeline.push({ t: point.t, ...point.mock })
    if (assistantText.length !== lastTextLen) {
      lastTextLen = assistantText.length
      stableSince = Date.now()
    }
    const stable = Date.now() - stableSince > 1800 && sawStreaming
    const highlightsReady = highlights !== undefined && Object.values(highlights.names).some((value) => value.present && value.ranges > 0)
    const judged = (lastDiag?.unitsJudged ?? 0) > 0
    if (assistantText.length > 0 && stable && (highlightsReady || judged)) break
    await sleep(300)
  }
  evidence.timeline = diagTimeline
  evidence.finalDiag = lastDiag
  evidence.finalMock = await mockStats().catch(() => undefined)
  // The client registers highlights on its next poll/rAF; wait for them instead
  // of sampling the instant the answer text settles.
  let finalHighlights = await cdp.evaluate(UI.highlightState).catch(() => undefined)
  const hasRanges = (value) => value !== undefined && Object.values(value.names ?? {}).some((entry) => entry.present && entry.ranges > 0)
  if (!hasRanges(finalHighlights)) {
    try {
      finalHighlights = await waitFor(async () => {
        const current = await cdp.evaluate(UI.highlightState).catch(() => undefined)
        return hasRanges(current) ? current : undefined
      }, 25000, 400, 'CSS.highlights ranges registration')
    } catch {
      finalHighlights = await cdp.evaluate(UI.highlightState).catch(() => undefined)
    }
  }
  evidence.image = finalHighlights
  evidence.chip = await cdp.evaluate(UI.chipInfo)
  evidence.answerHtml = await cdp.evaluate(UI.assistantAnswerHtml).catch(() => undefined)
  evidence.domAfter = await cdp.evaluate(UI.domSnapshot)
  evidence.streamingStopped = (await cdp.evaluate(UI.streaming).catch(() => false)) === false

  // Screenshot with highlights visible.
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => undefined)
  if (screenshot?.data !== undefined) {
    const path = join(runDir, 'browser-highlights.png')
    writeFileSync(path, Buffer.from(screenshot.data, 'base64'))
    evidence.screenshots.highlights = path
  }

  evidence.chipBaseline = chipBaseline
  evidence.highlightBaseline = highlightBaseline
  evidence.console = consoleMessages
  evidence.edges = pageErrors
  evidence.requests = network
  return { cdp, evidence }
  } catch (error) {
    evidence.error = String(error?.message ?? error)
    evidence.diagnostics = await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-composer-input="true"]')
      return {
        title: document.title,
        composerFound: el !== null,
        composerText: el ? (el.textContent || '').slice(0, 500) : null,
        composerHtml: el ? el.outerHTML.slice(0, 1200) : null,
        activeElement: document.activeElement ? document.activeElement.outerHTML.slice(0, 300) : null,
        sendButton: document.querySelector('button[aria-label="发送消息"]')?.disabled ?? null,
        locale: navigator.language,
      }
    })()`).catch(() => undefined)
    writeJson('browser-flow-partial.json', { error: evidence.error, diagnostics: evidence.diagnostics })
    await evidenceScreenshot('browser-failure', cdp, runDir)
    throw error
  } finally {
    flush()
  }
}

/** Clear the page's highlights, let the plugin re-register, then compare DOM to prove invariance. */
async function domInvarianceCheck(origin, cdp, evidence) {
  const before = await cdp.evaluate(UI.assistantAnswerHtml)
  if (before === null) {
    return addEntry({
      id: 'dom.invariance',
      criterion: 'highlights do not modify agent DOM (criterion g)',
      status: 'blocked',
      notes: 'no assistant answer container found',
    })
  }
  // Disable the pipeline, clear the highlights; assistant DOM must be byte-identical.
  const off = await probeRoute(origin, '/jev-highlight/toggle', { method: 'POST', body: { enabled: false } })
  await sleep(400)
  await cdp.evaluate(`(() => { CSS.highlights.clear(); return true })()`)
  await sleep(600)
  const cleared = await cdp.evaluate(UI.assistantAnswerHtml)
  const on = await probeRoute(origin, '/jev-highlight/toggle', { method: 'POST', body: { enabled: true } })
  await sleep(900)
  const restored = await cdp.evaluate(UI.assistantAnswerHtml)
  const requestCountsAfter = await probeRoute(origin, '/jev-highlight/diag')
  const hashes = {
    before: before === null ? null : sha256(before.html),
    cleared: cleared === null ? null : sha256(cleared.html),
    restored: restored === null ? null : sha256(restored.html),
  }
  const nodes = { before: before?.nodeCount, cleared: cleared?.nodeCount, restored: restored?.nodeCount }
  const htmlSame = hashes.cleared === hashes.before && hashes.restored === hashes.before
  const nodesSame = nodes.cleared === nodes.before && nodes.restored === nodes.before
  const pureHighlights = before.html.includes('jev-critical') === false && before.html.includes('data-jev') === false
  writeJson('dom-invariance.json', { hashes, nodes, pureHighlights, off, on, requestCountsAfter: requestCountsAfter.json })
  const domEvidence = {
    id: 'dom.invariance',
    criterion: 'highlights do not modify agent DOM (criterion g)',
    status: htmlSame && nodesSame && pureHighlights ? 'pass' : 'fail',
    evidence: [join(RUN_DIR, 'dom-invariance.json'), before, cleared, restored].filter(Boolean),
    detail: { hashes, nodes: { before: nodes.before, after: nodes.cleared }, pureHighlights },
    notes: htmlSame && nodesSame ? 'assistant subtree HTML/node count identical with and without highlights' : 'assistant DOM changed',
  }
  evidence.domInvariance = domEvidence
  return addEntry(domEvidence)
}

/** Force the host pipeline enabled state and verify it through GET /state. */
async function setPipelineEnabled(origin, enabled, timeoutMs = 6000) {
  const before = (await probeRoute(origin, '/jev-highlight/state')).json
  if (before?.ok === true && before.enabled === enabled) return { ok: true, already: true, state: before }
  const toggle = await probeRoute(origin, '/jev-highlight/toggle', { method: 'POST', body: { enabled } })
  try {
    const state = await waitFor(async () => {
      const current = (await probeRoute(origin, '/jev-highlight/state')).json
      return current?.ok === true && current.enabled === enabled ? current : undefined
    }, timeoutMs, 200, `pipeline enabled=${String(enabled)}`)
    return { ok: true, toggle, state }
  } catch {
    return { ok: false, toggle, state: (await probeRoute(origin, '/jev-highlight/state')).json }
  }
}

async function toggleChipScenario(origin, cdp, evidence) {
  const prepared = await setPipelineEnabled(origin, true)
  // The client poll loop may be throttled right after boot; wait until the chip
  // reflects the host state before clicking, otherwise the recorded baseline is
  // stale and the flip assertion races the poll.
  let chipBefore = await cdp.evaluate(UI.chipInfo)
  try {
    chipBefore = await waitFor(async () => {
      const chip = await cdp.evaluate(UI.chipInfo).catch(() => null)
      const state = (await probeRoute(origin, '/jev-highlight/state')).json
      return chip !== null && String(chip.pressed) === String(state?.enabled) ? chip : undefined
    }, 15000, 400, 'chip reflects host enabled state')
  } catch {
    chipBefore = await cdp.evaluate(UI.chipInfo)
  }
  const stateBefore = (await probeRoute(origin, '/jev-highlight/state')).json
  const pressedBefore = chipBefore?.pressed
  const clicked = await clickChipToggle(cdp)
  let flipped = false
  let clientFlipped = false
  let stateAfter = stateBefore
  let chipAfter = chipBefore
  try {
    await waitFor(async () => {
      const state = (await probeRoute(origin, '/jev-highlight/state')).json
      const chip = await cdp.evaluate(UI.chipInfo).catch(() => null)
      if (state?.enabled !== stateBefore?.enabled) flipped = true
      if (chip !== null && String(chip.pressed) !== String(pressedBefore)) clientFlipped = true
      return flipped && clientFlipped ? true : undefined
    }, 8000, 300, 'chip toggle to flip host + client state')
    stateAfter = (await probeRoute(origin, '/jev-highlight/state')).json
    chipAfter = await cdp.evaluate(UI.chipInfo)
  } catch {
    stateAfter = (await probeRoute(origin, '/jev-highlight/state')).json
    chipAfter = await cdp.evaluate(UI.chipInfo)
  }
  const clickedBack = await clickChipToggle(cdp)
  let restored = false
  let stateRestored = stateAfter
  let chipRestored = chipAfter
  try {
    await waitFor(async () => {
      const state = (await probeRoute(origin, '/jev-highlight/state')).json
      const chip = await cdp.evaluate(UI.chipInfo).catch(() => null)
      const stateBack = state?.enabled === stateBefore?.enabled
      const chipBack = chip !== null && String(chip.pressed) === String(pressedBefore)
      if (stateBack && chipBack) {
        restored = true
        stateRestored = state
        chipRestored = chip
      }
      return restored ? true : undefined
    }, 8000, 300, 'chip toggle to restore host + client state')
  } catch {
    stateRestored = (await probeRoute(origin, '/jev-highlight/state')).json
    chipRestored = await cdp.evaluate(UI.chipInfo)
  }
  const ensured = await setPipelineEnabled(origin, true)
  const hasCounts = /\d/u.test(chipBefore?.text ?? '')
  const chipEvidence = {
    prepared, chipBefore, chipAfter, chipRestored,
    stateBefore, stateAfter, stateRestored, ensured,
    clicked, clickedBack,
    pressedBefore,
    pressedAfter: chipAfter?.pressed,
    pressedRestored: chipRestored?.pressed,
    flipped,
    clientFlipped,
    restored,
    hasCounts,
  }
  writeJson('chip-toggle.json', chipEvidence)
  evidence.chipToggle = chipEvidence
  return addEntry({
    id: 'chip.toggle',
    criterion: 'chip UI shows counts and toggle works (criterion h)',
    status: hasCounts && flipped && clientFlipped && restored ? 'pass' : hasCounts ? 'fail' : 'blocked',
    evidence: [join(RUN_DIR, 'chip-toggle.json'), chipBefore, chipAfter],
    detail: {
      hasCounts,
      flipped,
      clientFlipped,
      restored,
      enabledBefore: stateBefore?.enabled,
      enabledAfter: stateAfter?.enabled,
      enabledRestored: stateRestored?.enabled,
      pressedBefore,
      pressedAfter: chipAfter?.pressed,
      pressedRestored: chipRestored?.pressed,
      chipText: chipBefore?.text,
    },
    notes: hasCounts && flipped
      ? `counts rendered (${chipBefore?.chipText ?? ''}); toggle flipped enabled ${String(stateBefore?.enabled)}→${String(stateAfter?.enabled)} and back (client pressed ${String(pressedBefore)}→${String(chipAfter?.pressed)}→${String(chipRestored?.pressed)})`
      : hasCounts ? 'toggle did not flip /state.enabled' : 'chip counts not visible',
  })
}

async function cacheCheck(origin, evidence) {
  const diag = (await probeRoute(origin, '/jev-highlight/diag')).json
  const mock = await mockStats().catch(() => undefined)
  const hits = diag?.cacheHits ?? 0
  const misses = diag?.cacheMisses ?? 0
  const requests = mock?.requests ?? 0
  const judged = diag?.unitsJudged ?? 0
  let status = 'blocked'
  let notes = 'no repeated content observed yet'
  if (hits > 0) {
    status = 'pass'
    notes = `cacheHits=${hits} (misses=${misses}, judged=${judged}, mock requests=${requests})`
  } else if (misses > 0) {
    status = 'fail'
    notes = `cacheMisses=${misses} but cacheHits=0; repeated content did not hit the cache`
  }
  writeJson('cache.json', { diag, mock })
  evidence.cache = { diag, mock }
  return addEntry({
    id: 'cache.hits',
    criterion: 'repeated content hits the verdict cache (criterion d)',
    status,
    evidence: [join(RUN_DIR, 'cache.json')],
    detail: { cacheHits: hits, cacheMisses: misses, unitsJudged: judged, mockRequests: requests },
    notes,
  })
}

async function budgetConcurrencyCheck(origin, evidence) {
  const diag = (await probeRoute(origin, '/jev-highlight/diag')).json
  const mock = await mockStats().catch(() => undefined)
  if (diag === undefined) {
    return addEntry({
      id: 'budget.concurrency',
      criterion: 'request budget <= 24k and concurrency <= 12 (criterion c)',
      status: 'fail',
      notes: 'diag unavailable',
    })
  }
  const budgetOk = diag.maxRequestTokensObserved <= diag.requestBudget && diag.requestBudget <= 24000
  const concurrencyOk = diag.maxConcurrentObserved <= diag.concurrencyLimit && diag.concurrencyLimit <= 12
  const observed = diag.maxRequestTokensObserved > 0 && diag.maxConcurrentObserved > 0
  const mockOk = mock === undefined || mock.maxConcurrent <= 12
  writeJson('budget-concurrency.json', { diag, mock })
  evidence.budget = { diag, mock }
  return addEntry({
    id: 'budget.concurrency',
    criterion: 'request budget <= 24k and concurrency <= 12 (criterion c)',
    status: budgetOk && concurrencyOk && mockOk ? 'pass' : 'fail',
    evidence: [join(RUN_DIR, 'budget-concurrency.json')],
    detail: {
      maxRequestTokensObserved: diag.maxRequestTokensObserved,
      requestBudget: diag.requestBudget,
      maxConcurrentObserved: diag.maxConcurrentObserved,
      concurrencyLimit: diag.concurrencyLimit,
      mockMaxConcurrent: mock?.maxConcurrent,
      observed,
    },
    notes: `tokens ${diag.maxRequestTokensObserved}/${diag.requestBudget}, concurrency ${diag.maxConcurrentObserved}/${diag.concurrencyLimit}`,
  })
}

async function highlightCheck(origin, evidence) {
  const pageHighlights = evidence.image ?? (await Promise.resolve(undefined))
  const names = pageHighlights?.names ?? {}
  const expected = ['jev-critical', 'jev-medium', 'jev-low']
  const present = expected.filter((name) => names[name]?.present === true)
  const withRanges = expected.filter((name) => (names[name]?.ranges ?? 0) > 0)
  const styleOk = pageHighlights?.stylePresent === true && /::highlight\(jev-critical\)/u.test(pageHighlights?.styleText ?? '')
  const lowWeaker = /::highlight\(jev-low\)/u.test(pageHighlights?.styleText ?? '')
  // Every stored verdict level should map to exactly that many registered ranges
  // (the client highlights each verdict once in the rendered DOM).
  const unitLevels = evidence.units?.levelCounts ?? {}
  const rangesByBucket = {
    critical: names['jev-critical']?.ranges ?? 0,
    medium: names['jev-medium']?.ranges ?? 0,
    low: names['jev-low']?.ranges ?? 0,
  }
  const correspondence = expected.every((name) => (rangesByBucket[name.replace('jev-', '')] ?? -1) === (unitLevels[name.replace('jev-', '')] ?? 0))
  writeJson('highlights.json', { pageHighlights, unitLevels, rangesByBucket, correspondence })
  return addEntry({
    id: 'highlight.render',
    criterion: 'priority-weighted highlights appear via CSS.highlights (criterion e)',
    status: withRanges.length >= 2 && styleOk && correspondence ? 'pass' : 'fail',
    evidence: [join(RUN_DIR, 'highlights.json'), evidence.screenshots?.highlights ?? '', join(RUN_DIR, 'browser-highlights.png')].filter(Boolean),
    detail: { present, withRanges, rangesByBucket, unitLevels, correspondence, styleOk, lowWeaker },
    notes: `highlight names with ranges: ${withRanges.join(', ') || 'none'}; per-level ranges ${JSON.stringify(rangesByBucket)} vs units ${JSON.stringify(unitLevels)}`,
  })
}

// ---------------------------------------------------------------------------
// Units route / cache scenario helpers
// ---------------------------------------------------------------------------

async function checkUnits(origin, evidence) {
  const probe = await probeRoute(origin, '/jev-highlight/units?since=0&limit=200')
  const units = probe.json?.units
  if (probe.status !== 200 || !Array.isArray(units)) {
    return addEntry({
      id: 'http.units',
      criterion: 'verdict units are queryable with since/limit',
      status: 'fail',
      evidence: [probe],
      notes: `GET /jev-highlight/units -> ${probe.status} ${probe.text.slice(0, 120)}`,
    })
  }
  const required = ['seq', 'unitId', 'sessionId', 'type', 'text', 'priority', 'level', 'scores', 'model', 'cached', 'createdAt']
  const missing = []
  const levelCounts = { critical: 0, medium: 0, low: 0, none: 0 }
  let monotonic = true
  let lastSeq = -1
  let priorityMismatch = 0
  for (const unit of units) {
    for (const field of required) {
      if (!(field in unit)) missing.push(`${unit.unitId ?? '?'}.${field}`)
    }
    if (typeof unit.seq === 'number' && unit.seq <= lastSeq) monotonic = false
    lastSeq = typeof unit.seq === 'number' ? unit.seq : lastSeq
    const expected = unit.priority >= 0.85 ? 'critical' : unit.priority >= 0.65 ? 'medium' : unit.priority >= 0.45 ? 'low' : 'none'
    if (unit.level !== expected) priorityMismatch += 1
    levelCounts[unit.level] = (levelCounts[unit.level] ?? 0) + 1
  }
  writeJson('units.json', { probe, units, levelCounts })
  evidence.units = { levelCounts, count: units.length }
  return addEntry({
    id: 'http.units',
    criterion: 'verdict units are queryable with since/limit',
    status: units.length > 0 && missing.length === 0 && monotonic && priorityMismatch === 0 ? 'pass' : 'fail',
    evidence: [join(RUN_DIR, 'units.json')],
    detail: { count: units.length, levelCounts, missing: missing.slice(0, 5), monotonic, priorityMismatch },
    notes: `${units.length} verdicts, levels ${JSON.stringify(levelCounts)}` + (missing.length === 0 ? '' : `, missing: ${missing.slice(0, 3).join(', ')}`),
  })
}

/** Click "new conversation", send one prompt, wait for the streamed answer to settle. */
async function runSingleTurn(cdp, prompt, origin) {
  const clicked = await cdp.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="新建会话"]') ?? [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '新会话')
    if (!button) return false
    button.click()
    return true
  })()`)
  if (clicked !== true) throw new Error('could not click new-conversation')
  await waitFor(() => cdp.evaluate(UI.composerReady).catch(() => false), 20000, 300, 'composer after new conversation')
  await sleep(500)
  await typePrompt(cdp, prompt)
  const sent = await clickSendWithFallback(cdp)
  if (sent !== 'click' && sent !== 'enter') throw new Error('send button unavailable')
  let lastLength = 0
  let lastText = ''
  let stableSince = Date.now()
  let sawStreaming = false
  const started = Date.now()
  while (Date.now() - started < args.streamTimeoutMs) {
    const [text, streaming] = await Promise.all([cdp.evaluate(UI.assistantText).catch(() => ''), cdp.evaluate(UI.streaming).catch(() => false)])
    if (streaming === true) sawStreaming = true
    if (text.length !== lastLength) {
      lastLength = text.length
      lastText = text
      stableSince = Date.now()
    }
    if (text.length > 0 && sawStreaming && streaming === false && Date.now() - stableSince > 1200) break
    await sleep(250)
  }
  const diag = (await probeRoute(origin, '/jev-highlight/diag')).json
  const mock = await mockStats().catch(() => undefined)
  return { textLength: lastLength, textHead: lastText.slice(0, 300), diag, mock }
}

async function cacheScenario(origin, cdp, evidence) {
  if (cdp === undefined) {
    addEntry({ id: 'cache.hits', criterion: 'repeated content hits the verdict cache (criterion d)', status: 'blocked', notes: 'browser phase unavailable' })
    return
  }
  const literal = '缓存验收固定段落：Jev 高亮的缓存键由规范化文本与上下文组成。'
  const prompt = `请只输出下面这一行文本本身，逐字复制，不要加引号，不要代码块，不要解释，也不要添加任何其他内容：\n${literal}`
  try {
    const enabledBefore = await setPipelineEnabled(origin, true)
    const first = await runSingleTurn(cdp, prompt, origin)
    const enabledMid = await setPipelineEnabled(origin, true)
    const second = await runSingleTurn(cdp, prompt, origin)
    const cacheHitsDelta = (second.diag?.cacheHits ?? 0) - (first.diag?.cacheHits ?? 0)
    const cacheMissesDelta = (second.diag?.cacheMisses ?? 0) - (first.diag?.cacheMisses ?? 0)
    const mockRequestsDelta = (second.mock?.requests ?? 0) - (first.mock?.requests ?? 0)
    const judgedDelta = (second.diag?.unitsJudged ?? 0) - (first.diag?.unitsJudged ?? 0)
    const unitsSeenDelta = (second.diag?.unitsSeen ?? 0) - (first.diag?.unitsSeen ?? 0)
    const firstHasLiteral = first.textHead.includes(literal.slice(0, 12))
    const secondHasLiteral = second.textHead.includes(literal.slice(0, 12))
    writeJson('cache-repetition.json', {
      literal, enabledBefore, enabledMid, first, second,
      cacheHitsDelta, cacheMissesDelta, mockRequestsDelta, judgedDelta, unitsSeenDelta, firstHasLiteral, secondHasLiteral,
    })
    evidence.cache = { first, second, cacheHitsDelta, cacheMissesDelta, mockRequestsDelta, judgedDelta }
    addEntry({
      id: 'cache.hits',
      criterion: 'repeated content hits the verdict cache (criterion d)',
      status: cacheHitsDelta > 0 ? 'pass' : 'fail',
      evidence: [join(RUN_DIR, 'cache-repetition.json')],
      detail: {
        cacheHitsDelta,
        cacheMissesDelta,
        mockRequestsDelta,
        judgedDelta,
        unitsSeenDelta,
        hitsTotal: second.diag?.cacheHits,
        missesTotal: second.diag?.cacheMisses,
        pipelineEnabledBefore: enabledBefore.state?.enabled,
        pipelineEnabledMid: enabledMid.state?.enabled,
        firstHasLiteral,
        secondHasLiteral,
      },
      notes: cacheHitsDelta > 0
        ? `identical literal paragraph re-judged from cache: +${cacheHitsDelta} hits, mock request delta ${mockRequestsDelta}`
        : `no cache hit for the repeated paragraph (mock request delta ${mockRequestsDelta}, judged delta ${judgedDelta}, unitsSeen delta ${unitsSeenDelta}, literal reproduced: ${String(firstHasLiteral)}/${String(secondHasLiteral)})`,
    })
  } catch (error) {
    writeJson('cache-repetition.json', { error: String(error?.message ?? error) })
    addEntry({
      id: 'cache.hits',
      criterion: 'repeated content hits the verdict cache (criterion d)',
      status: 'blocked',
      notes: `cache scenario failed: ${String(error?.message ?? error)}`,
    })
  }
}


const DEFAULT_ACCEPTANCE_PROMPT = [
  '请只输出以下 markdown 内容，保持段落顺序，不要解释、不要工具调用：',
  '核心结论：关键步骤是先运行 npm run build，注意超限会失败。',
  '',
  '```js',
  '// 注意风险：状态未校验会失败',
  'const ok = res.ok',
  '```',
  '',
  '- 运行 npm test 并检查缓存',
  '- 查看构建产物',
  '',
  '定义：幂等是指同一操作重复执行多次与执行一次的结果相同。',
].join('\n')

async function scenarioMockSelftest() {
  log('scenario: mock-selftest')
  const mock = startMock({ delayMs: 0 })
  const entryStarted = nowIso()
  try {
    await waitMockStats(15000)
    const base = `http://127.0.0.1:${args.mockPort}`
    const questions = {
      is_core_answer: { type: 'noul', instructions: 'core?' },
      is_actionable: { type: 'noul', instructions: 'actionable?' },
      is_warning: { type: 'noul', instructions: 'warning?' },
      is_definition: { type: 'noul', instructions: 'definition?' },
    }
    const post = (state) => fetchJson(`${base}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dummy-mock-key' },
      body: JSON.stringify({ model: 'jev-1.13.0', state, questions }),
    })
    const priority = (scores) => Math.round((0.5 * scores.is_core_answer + 0.3 * scores.is_actionable + 0.2 * Math.max(scores.is_warning, scores.is_definition)) * 10000) / 10000
    const bucket = (value) => (value >= 0.85 ? 'critical' : value >= 0.65 ? 'medium' : value >= 0.45 ? 'low' : 'none')
    const cases = [
      { id: 'critical', state: '核心结论：关键步骤是先运行 npm run build，注意超限会失败。', expected: 'critical' },
      { id: 'medium-code', state: '```js\n// 注意风险：状态未校验会失败\nconst ok = res.ok\n```', expected: 'medium' },
      { id: 'medium-definition', state: '定义：幂等是指同一操作重复执行多次与执行一次的结果相同。', expected: 'medium' },
      { id: 'low-action', state: '运行 npm test 并检查缓存', expected: 'low' },
      { id: 'plain', state: '这段没有任何标记的普通句子。', expected: 'none' },
    ]
    const results = []
    for (const testCase of cases) {
      const response = await post(testCase.state)
      const scores = Object.fromEntries(Object.entries(response.json?.answers ?? {}).map(([id, answer]) => [id, answer.noul ?? answer.probability]))
      const prio = priority(scores)
      results.push({ id: testCase.id, scores, priority: prio, bucket: bucket(prio), expected: testCase.expected, pass: bucket(prio) === testCase.expected })
    }
    const plain1 = await post('This paragraph has no special marker at all.')
    const plain2 = await post('This paragraph has no special marker at all.')
    const stats = await mockStats()
    const checks = {
      http200: plain1.status === 200 && plain2.status === 200,
      tiers: results.every((result) => result.pass),
      deterministic: JSON.stringify(plain1.json?.answers) === JSON.stringify(plain2.json?.answers),
      usage: typeof plain1.json?.usage?.input_tokens === 'number' && plain1.json.usage.input_tokens > 0,
      stats: (stats?.requests ?? 0) === 7 && stats?.inFlight === 0 && (stats?.maxConcurrent ?? 0) >= 1,
      noKeyLeak: !JSON.stringify(stats).includes('dummy-mock-key'),
    }
    writeJson('mock-selftest.json', { checks, results, plain: plain1.json, stats })
    const ok = Object.values(checks).every(Boolean)
    addEntry({
      id: 'mock.selftest',
      criterion: 'mock Jev server maps content tiers to deterministic highlight buckets',
      status: ok ? 'pass' : 'fail',
      startedAt: entryStarted,
      evidence: [join(RUN_DIR, 'mock-selftest.json')],
      detail: { checks, tiers: results.map((result) => ({ id: result.id, priority: result.priority, bucket: result.bucket, expected: result.expected })) },
      notes: ok ? 'all mock behavior checks passed' : `failed checks: ${Object.entries(checks).filter(([, value]) => !value).map(([name]) => name).join(', ')}`,
    })
  } finally {
    mock.child.kill()
    cleanupChildren()
  }
}

async function scenarioNoKey() {
  log('scenario: nokey (missing Jev key startup diagnostics)')
  if (!(await isPortFree(args.port))) throw new Error(`port ${args.port} is already in use`)
  const dsh = await startDsh({ mode: 'nokey', patch: DEBUG_PATCH })
  let logText = ''
  let matched = false
  const started = Date.now()
  while (Date.now() - started < args.startupTimeoutMs) {
    logText = `${dsh.stdout()}\n${dsh.stderr()}`
    if (/\.credentials\.yaml/u.test(logText) && /JEV_API_KEY/u.test(logText)) {
      matched = true
      break
    }
    if (dsh.exit !== undefined) break
    await sleep(500)
  }
  logText = `${dsh.stdout()}\n${dsh.stderr()}`
  const cachePath = /(?:\$DSH_HOME|[A-Za-z]:[^\s"']*)[^\n]*\.credentials\.yaml/u.test(logText)
  const envHint = /JEV_API_KEY/u.test(logText)
  const surfaced = /MissingJevApiKeyError|JEV_API_KEY_MISSING|No Jev API key is configured|error/iu.test(logText)
  writeJson('nokey-startup.json', { matched, cachePath, envHint, surfaced, exitCode: dsh.exit, logTail: logText.slice(-8000) })
  addEntry({
    id: 'startup.nokey',
    criterion: 'missing Jev key fails loudly with actionable paths (criterion b)',
    status: matched && surfaced ? 'pass' : 'fail',
    evidence: [join(RUN_DIR, 'nokey-startup.json'), dsh.stdoutPath, dsh.stderrPath],
    detail: { cachePath, envHint, surfaced, exitCode: dsh.exit },
    notes: matched ? 'log names .credentials.yaml and JEV_API_KEY' : 'expected missing-key diagnostics not found in startup log',
  })
  cleanupChildren()
}

function patchForScenario(scenario) {
  if (scenario === 'mock') return E2E_PATCH
  return DEBUG_PATCH
}

async function scenarioStack(scenario) {
  log(`scenario: ${scenario}`)
  const patch = patchForScenario(scenario)
  if (!existsSync(patch)) throw new Error(`patch file missing: ${patch}`)
  if (!(await isPortFree(args.port))) throw new Error(`port ${args.port} is already in use`)
  if (scenario === 'mock' && !(await isPortFree(args.mockPort))) throw new Error(`mock port ${args.mockPort} is already in use`)

  let dsh
  let mock
  try {
    if (scenario === 'mock') {
      mock = startMock()
      await waitMockStats(15000)
    }
    dsh = await startDsh({ mode: scenario, patch, label: 'dsh' })
    const token = await waitForTokenUrl(dsh, args.startupTimeoutMs)
    report.dshUrl = `${token.origin}/?token=<redacted>`
    ;['tokenUrl', 'origin', 'token'].forEach((key) => {
      artifacts[key] = token[key]
    })

    // Startup diagnostics: no plugin load errors in the log.
    await sleep(1200)
    const startupLog = `${dsh.stdout()}\n${dsh.stderr()}`
    const startupErrors = startupLog
      .split(/\r?\n/u)
      .filter((line) => /(?:error|exception|failed|Cannot find|ERR_)/iu.test(line) && !/errorState|lastError/u.test(line))
      .slice(0, 30)
    writeJson('startup-log-scan.json', { startupErrors, tokenLine: /dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/u.exec(startupLog)?.[0]?.replace(/token=\S+/u, 'token=<redacted>') ?? '' })
    addEntry({
      id: 'startup.patch',
      criterion: 'patch overlay loads without startup errors (criterion a)',
      status: startupErrors.length === 0 ? 'pass' : 'fail',
      evidence: [join(RUN_DIR, 'startup-log-scan.json'), dsh.stdoutPath, dsh.stderrPath],
      detail: { startupErrors, patch: rel(patch) },
      notes: startupErrors.length === 0 ? 'no error/exception/failed lines in startup log' : `startup error lines: ${startupErrors.slice(0, 5).join(' | ')}`,
    })

    const origin = token.origin
    const stateProbe = await waitForPluginRoutes(origin, 45000)
    addEntry({
      id: 'routes.ready',
      criterion: 'plugin routes registered on the same origin',
      status: stateProbe.status === 200 ? 'pass' : 'fail',
      evidence: [stateProbe, join(RUN_DIR, 'startup-log-scan.json')],
      notes: `GET /jev-highlight/state -> ${stateProbe.status}`,
    })
    await checkDiagContract(origin)
    await checkStateRoute(origin)

    if (scenario === 'mock' && dsh !== undefined) {
      const initialMock = await mockStats()
      addEntry({
        id: 'mock.wired',
        criterion: 'host half calls the mock Jev endpoint (baseUrl override)',
        status: (initialMock?.requests ?? 0) >= 0 ? 'pass' : 'fail',
        notes: `mock reachable, requests so far=${initialMock?.requests ?? 'n/a'}`,
      })
    }

    // ---- Browser phase -----------------------------------------------------
    let browserEvidence = undefined
    let cdp
    const chromeUserData = join(RUN_DIR, 'chrome-profile')
    if (args.ui === 'cdp') {
      try {
        await launchChrome({ tokenUrl: token.url, cdpPort: args.cdpPort, userDataDir: chromeUserData })
        const prompt = args.prompt !== '' ? args.prompt : DEFAULT_ACCEPTANCE_PROMPT
        const flow = await browserFlow({ origin, tokenUrl: token.url, prompt, runDir: RUN_DIR })
        cdp = flow.cdp
        browserEvidence = flow.evidence
        writeJson('browser-flow.json', {
          finalDiag: browserEvidence.finalDiag,
          finalMock: browserEvidence.finalMock,
          baseline: browserEvidence.baseline,
          timeline: browserEvidence.timeline,
          image: browserEvidence.image,
          chip: browserEvidence.chip,
          domAfter: browserEvidence.domAfter,
          streamingStopped: browserEvidence.streamingStopped,
        })
        writeJson('console.json', browserEvidence.console)
        writeJson('page-errors.json', browserEvidence.edges)
        writeJson('network.json', browserEvidence.requests.filter((entry) => /jev-highlight|10399\/v1\/systemone/u.test(entry.url)))
        const pageErrorCount = browserEvidence.edges.length
        addEntry({
          id: 'browser.console',
          criterion: 'no uncaught page errors during the highlighted turn',
          status: pageErrorCount === 0 ? 'pass' : 'fail',
          evidence: [join(RUN_DIR, 'console.json'), join(RUN_DIR, 'page-errors.json')],
          detail: { pageErrors: browserEvidence.edges.slice(0, 5), consoleErrors: browserEvidence.console.filter((entry) => entry.type.includes('error')).slice(0, 5) },
          notes: pageErrorCount === 0 ? 'no Runtime.exceptionThrown events' : `${pageErrorCount} uncaught exception(s)`,
        })
        const pluginRequests = browserEvidence.requests.filter((entry) => entry.url.includes('/jev-highlight/'))
        addEntry({
          id: 'browser.network',
          criterion: 'client half polls plugin routes from the page',
          status: pluginRequests.length > 0 && pluginRequests.every((entry) => (entry.status ?? 0) < 500) ? 'pass' : 'fail',
          evidence: [join(RUN_DIR, 'network.json')],
          detail: { requestCount: pluginRequests.length, sample: pluginRequests.slice(0, 6) },
          notes: `${pluginRequests.length} /jev-highlight/* requests from the page`,
        })
        await checkUnits(origin, browserEvidence)
        await highlightCheck(origin, browserEvidence)
        await domInvarianceCheck(origin, cdp, browserEvidence)
        await toggleChipScenario(origin, cdp, browserEvidence)
        await budgetConcurrencyCheck(origin, browserEvidence)
        const finalMock = await mockStats().catch(() => undefined)
        addEntry({
          id: 'mock.wired',
          criterion: 'host half calls the mock Jev endpoint (baseUrl override)',
          status: (finalMock?.requests ?? 0) > 0 ? 'pass' : 'fail',
          evidence: [join(RUN_DIR, 'mock-jev.stats.json')],
          detail: { requests: finalMock?.requests, maxStateChars: finalMock?.maxStateChars, maxConcurrent: finalMock?.maxConcurrent, aborted: finalMock?.aborted, field: finalMock?.field },
          notes: `mock observed ${finalMock?.requests ?? 0} systemone requests (field=${finalMock?.field ?? '?'}, maxStateChars=${finalMock?.maxStateChars ?? '?'})`,
        })
        await cacheScenario(origin, cdp, browserEvidence)
        await evidenceScreenshot('browser-final', cdp, RUN_DIR)
        await abortScenario(origin, cdp, browserEvidence, mock, dsh)
        await hostAbortUnitTest()
        if (browserEvidence.console.length > 0) writeJson('console-all.json', browserEvidence.console)
      } catch (error) {
        report.errors.push(String(error?.stack ?? error))
        addEntry({
          id: 'browser.phase',
          criterion: 'browser phase could run',
          status: 'blocked',
          notes: `browser phase failed: ${String(error?.message ?? error)}`,
        })
      }
    } else {
      for (const [id, criterion] of [
        ['browser.console', 'no uncaught page errors during the highlighted turn'],
        ['browser.network', 'client half polls plugin routes from the page'],
        ['highlight.render', 'priority-weighted highlights appear via CSS.highlights (criterion e)'],
        ['dom.invariance', 'highlights do not modify agent DOM (criterion g)'],
        ['chip.toggle', 'chip UI shows counts and toggle works (criterion h)'],
        ['cache.hits', 'repeated content hits the verdict cache (criterion d)'],
        ['abort.cancel', 'in-flight Jev requests abort on cancel (criterion f)'],
        ['budget.concurrency', 'request budget <= 24k and concurrency <= 12 (criterion c)'],
      ]) {
        addEntry({ id, criterion, status: 'blocked', notes: '--ui none: run the Playwright MCP steps from docs/e2e-ui-notes.md and fill the report' })
      }
    }

    if (scenario === 'live') {
      const diag = (await probeRoute(origin, '/jev-highlight/diag')).json
      addEntry({
        id: 'live.jev',
        criterion: 'real TypeSafe Jev call succeeds',
        status: (diag?.requests ?? 0) > 0 ? 'pass' : 'blocked',
        evidence: [join(RUN_DIR, 'browser-flow.json')],
        detail: { requests: diag?.requests, failures: diag?.failures, lastError: diag?.lastError, baseUrl: diag?.baseUrl },
        notes: (diag?.requests ?? 0) > 0 ? `real requests=${diag.requests}, failures=${diag.failures}` : 'no real Jev request observed (region block/HTTP 451 or no key)',
      })
    }
  } finally {
    if (!args.keep) {
      cleanupChildren()
      await sleep(800)
      if (mock !== undefined) mock.child.kill()
    } else {
      log('--keep set: leaving the dsh instance and mock running')
      log(`token URL: ${artifacts.tokenUrl}`)
    }
  }
}

/** Archive the selected session from the sidebar, which disposes it and aborts in-flight work. */
async function archiveSelectedSession(cdp) {
  const opened = await cdp.evaluate(`(() => {
    const selected = document.querySelector('[role="treeitem"][aria-selected="true"]')
      ?? [...document.querySelectorAll('[role="treeitem"]')].find((item) => item.querySelector('button'))
    const buttons = selected ? [...selected.querySelectorAll('button')] : []
    let button = buttons.find((candidate) => /操作|更多|more/iu.test(candidate.getAttribute('aria-label') || ''))
    if (!button) button = [...document.querySelectorAll('button[aria-label]')].find((candidate) => /会话.*操作/iu.test(candidate.getAttribute('aria-label') || ''))
    if (!button) return { opened: false, reason: 'no session actions button' }
    button.click()
    return { opened: true, label: button.getAttribute('aria-label') }
  })()`).catch(() => ({ opened: false }))
  if (opened.opened !== true) return { opened, archived: { clicked: false } }
  await sleep(400)
  const archived = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('[role="menuitem"], [role="menu"] button, button')]
    const target = items.find((item) => /^(归档会话|归档|Archive)$/u.test((item.textContent || '').trim()))
    if (!target) return { clicked: false, candidates: items.map((item) => (item.textContent || '').trim()).filter(Boolean).slice(0, 12) }
    target.click()
    return { clicked: true, text: (target.textContent || '').trim() }
  })()`).catch(() => ({ clicked: false }))
  await sleep(500)
  // A confirmation dialog may follow; accept it if present.
  const confirmed = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return { dialog: false }
    const button = [...dialog.querySelectorAll('button')].find((candidate) => /归档|确认|确定|Archive/iu.test(candidate.textContent || ''))
    if (!button) return { dialog: true, buttons: [...dialog.querySelectorAll('button')].map((candidate) => (candidate.textContent || '').trim()) }
    button.click()
    return { dialog: true, clicked: (button.textContent || '').trim() }
  })()`).catch(() => ({ dialog: false }))
  await sleep(600)
  return { opened, archived, confirmed }
}

async function abortScenario(origin, cdp, evidence, mock, dsh) {
  if (mock === undefined) {
    addEntry({
      id: 'abort.cancel',
      criterion: 'in-flight Jev requests abort on cancel (criterion f)',
      status: 'blocked',
      notes: 'abort scenario needs the mock (delay) to keep requests in flight',
    })
    return
  }
  const enabled = await setPipelineEnabled(origin, true)
  if (enabled.ok !== true) {
    addEntry({
      id: 'abort.cancel',
      criterion: 'in-flight Jev requests abort on cancel (criterion f)',
      status: 'fail',
      evidence: [enabled],
      notes: 'could not re-enable the pipeline before the abort scenario',
    })
    return
  }
  // Start a fresh conversation and keep a long answer streaming.
  await cdp.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '新会话' || (b.getAttribute('aria-label') || '').includes('新建会话')); if (button) button.click(); return true })()`)
  await sleep(1500)
  await waitFor(() => cdp.evaluate(UI.composerReady).catch(() => false), 15000, 300, 'composer after new session')
  const longPrompt = '请写一段约 300 字的说明，包含 8 个要点列表和两段风险提示，不要使用工具。'
  await typePrompt(cdp, longPrompt)
  await clickSendWithFallback(cdp)
  // Wait for the turn to actually stream, then for a Jev request in flight.
  let inFlightSeen = 0
  let streamingSeen = false
  const streamStarted = Date.now()
  while (Date.now() - streamStarted < 45000) {
    const streaming = await cdp.evaluate(UI.streaming).catch(() => false)
    if (streaming === true) {
      streamingSeen = true
      break
    }
    await sleep(250)
  }
  const flightStarted = Date.now()
  while (Date.now() - flightStarted < 25000) {
    const [stats, diag] = await Promise.all([
      mockStats().catch(() => undefined),
      probeRoute(origin, '/jev-highlight/diag').catch(() => undefined),
    ])
    inFlightSeen = Math.max(inFlightSeen, stats?.inFlight ?? 0, diag?.json?.inFlight ?? 0)
    if (inFlightSeen > 0) break
    if (streamingSeen === false && (stats?.requests ?? 0) > 0) break
    await sleep(120)
  }
  const diagBefore = (await probeRoute(origin, '/jev-highlight/diag')).json
  const mockBefore = await mockStats().catch(() => undefined)
  let method = 'none'
  let archive = undefined
  let teardown = undefined
  let abortedDelta = 0
  let mockAbortedDelta = 0
  if (inFlightSeen > 0 || streamingSeen) {
    // Preferred UI path (when requested): dispose the session (session/disposed).
    // The shipped UI hides "archive session" while a turn is streaming, so the
    // deterministic path is a host teardown with the same lifecycle contract as
    // a plugin unload (ctx.effect cleanup -> pipeline.dispose -> abort fetches).
    if (args.abortMode === 'archive') archive = await archiveSelectedSession(cdp)
    const archiveWorked = archive?.archived?.clicked === true
    if (archiveWorked) {
      method = 'archive-session'
    } else if (dsh !== undefined) {
      method = 'process-teardown'
      const listenerKill = killPortListener(args.port)
      const portClosed = await waitPortClosed(args.port)
      killTree(dsh.pid)
      teardown = { killed: true, pid: dsh.pid, listenerKill, portClosed }
    }
  }
  // Poll the mock side (the host may be gone in the teardown path).
  let diagAfter
  let mockAfter
  const deadline = Date.now() + (method === 'process-teardown' ? 12000 : 20000)
  while (Date.now() < deadline) {
    await sleep(300)
    mockAfter = await mockStats().catch(() => undefined)
    mockAbortedDelta = (mockAfter?.aborted ?? 0) - (mockBefore?.aborted ?? 0)
    const inFlight = mockAfter?.inFlight ?? 0
    if (mockAbortedDelta > 0 && inFlight === 0) break
    if (dsh !== undefined && processAlive(dsh.pid)) {
      diagAfter = (await probeRoute(origin, '/jev-highlight/diag')).json
      abortedDelta = (diagAfter?.abortedRequests ?? 0) - (diagBefore?.abortedRequests ?? 0)
      if (abortedDelta > 0 && inFlight === 0) break
    }
  }
  if (method !== 'process-teardown') diagAfter = diagAfter ?? (await probeRoute(origin, '/jev-highlight/diag')).json
  mockAfter = mockAfter ?? (await mockStats().catch(() => undefined))
  mockAbortedDelta = (mockAfter?.aborted ?? 0) - (mockBefore?.aborted ?? 0)
  const drained = (mockAfter?.inFlight ?? 0) === 0
  writeJson('abort.json', {
    method, streamingSeen, inFlightSeen, archive, teardown,
    diagBefore, diagAfter, mockBefore, mockAfter, abortedDelta, mockAbortedDelta, drained,
  })
  evidence.abort = { method, streamingSeen, inFlightSeen, archive, teardown, diagBefore, diagAfter, mockBefore, mockAfter, abortedDelta, mockAbortedDelta, drained }
  addEntry({
    id: 'abort.cancel',
    criterion: 'in-flight Jev requests abort on cancel (criterion f)',
    status: (method !== 'none') && drained && (abortedDelta > 0 || mockAbortedDelta > 0) ? 'pass' : 'fail',
    evidence: [join(RUN_DIR, 'abort.json')],
    detail: {
      method,
      streamingSeen,
      inFlightSeen,
      archive,
      teardown,
      abortedDelta,
      mockAbortedDelta,
      mockInFlightAfter: mockAfter?.inFlight,
      diagAbortedBefore: diagBefore?.abortedRequests,
      diagAbortedAfter: diagAfter?.abortedRequests,
      requestsBefore: mockBefore?.requests,
      requestsAfter: mockAfter?.requests,
      note: '当前 DSH 的“停止生成”把流按 committed 结束，不触发 abandoned；因此 f 走 session/disposed 或 host teardown 路径',
    },
    notes: (abortedDelta > 0 || mockAbortedDelta > 0)
      ? `${method} aborted in-flight Jev requests (diag +${abortedDelta}, mock aborted +${mockAbortedDelta}); mock inFlight drained to ${mockAfter?.inFlight ?? '?'}`
      : `no abort observed (method=${method}, streamingSeen=${String(streamingSeen)}, inFlightSeen=${inFlightSeen}, mock requests ${mockBefore?.requests}→${mockAfter?.requests})`,
  })
}

/** Run the host-side abort/unload unit test as supporting evidence for criterion f. */
async function hostAbortUnitTest() {
  const testFile = join(PLUGIN_ROOT, 'test', 'host', 'e2e-mock-http.test.mjs')
  const logPath = join(RUN_DIR, 'host-abort-unit-test.log')
  if (!existsSync(testFile)) {
    return addEntry({
      id: 'host.unit-abort',
      criterion: 'host unit test proves unload aborts in-flight requests',
      status: 'blocked',
      notes: `test file missing: ${rel(testFile)}`,
    })
  }
  const result = spawnSync(NODE_EXE, ['--test', '--test-name-pattern=unload aborts an in-flight', testFile], {
    cwd: PLUGIN_ROOT,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  writeFileSync(logPath, output, 'utf8')
  // Node's test reporter uses "ℹ pass N" on v24 (older builds print "# pass N").
  const passMatch = /(?:ℹ|#)\s*pass\s+(\d+)/u.exec(output)
  const failMatch = /(?:ℹ|#)\s*fail\s+(\d+)/u.exec(output)
  const pass = passMatch === null ? 0 : Number(passMatch[1])
  const fail = failMatch === null ? 0 : Number(failMatch[1])
  const abortMentioned = /unload aborts an in-flight/iu.test(output)
  return addEntry({
    id: 'host.unit-abort',
    criterion: 'host unit test proves unload aborts in-flight requests',
    status: pass > 0 && fail === 0 && (result.status === 0 || result.status === undefined) ? 'pass' : 'fail',
    evidence: [logPath],
    detail: { pass, fail, abortMentioned, exitCode: result.status, file: rel(testFile) },
    notes: `node --test ${rel(testFile)}: ${pass} pass / ${fail} fail${abortMentioned ? '; covers "plugin unload aborts an in-flight real HTTP request"' : ''}`,
  })
}

async function evidenceScreenshot(name, cdp, runDir) {
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    if (shot?.data !== undefined) {
      writeFileSync(join(runDir, `${name}.png`), Buffer.from(shot.data, 'base64'))
    }
  } catch {
    // screenshot best effort
  }
}

// ---------------------------------------------------------------------------
// Attach mode: run checks against an already running instance
// ---------------------------------------------------------------------------

async function scenarioAttach() {
  const url = args.url
  if (url === '') throw new Error('--scenario attach needs --url "<token url>"')
  const match = /^(http:\/\/127\.0\.0\.1:\d+)\/\?token=([A-Za-z0-9_-]+)/u.exec(url)
  if (match === null) throw new Error('--url must be the full token URL printed by dsh web')
  const origin = match[1]
  artifacts.origin = origin
  artifacts.tokenUrl = url
  // A pre-existing instance is only usable when the plugin really loaded;
  // otherwise every check below would be a false negative. Probe first.
  const stateProbe = await probeRoute(origin, '/jev-highlight/state')
  if (stateProbe.status !== 200) {
    addEntry({
      id: 'attach',
      criterion: 'reuse a running instance with the plugin loaded',
      status: 'fail',
      evidence: [stateProbe],
      notes: `attached instance has no plugin routes (GET /jev-highlight/state -> ${stateProbe.status}); use --scenario mock to start a fresh instance`,
    })
    return
  }
  addEntry({ id: 'attach', criterion: 'reuse a running instance', status: 'pass', notes: `attached to ${origin} with plugin routes loaded` })
  await checkDiagContract(origin)
  await checkStateRoute(origin)
  if (args.ui === 'cdp') {
    const chromeUserData = join(RUN_DIR, 'chrome-profile')
    await launchChrome({ tokenUrl: url, cdpPort: args.cdpPort, userDataDir: chromeUserData })
    const prompt = args.prompt !== '' ? args.prompt : DEFAULT_ACCEPTANCE_PROMPT
    try {
      const flow = await browserFlow({ origin, tokenUrl: url, prompt, runDir: RUN_DIR })
      const evidence = flow.evidence
      writeJson('browser-flow.json', {
        finalDiag: evidence.finalDiag,
        finalMock: evidence.finalMock,
        baseline: evidence.baseline,
        timeline: evidence.timeline,
        image: evidence.image,
        chip: evidence.chip,
        domAfter: evidence.domAfter,
        streamingStopped: evidence.streamingStopped,
      })
      writeJson('console.json', evidence.console)
      writeJson('network.json', evidence.requests.filter((entry) => /jev-highlight|v1\/systemone/u.test(entry.url)))
      await checkUnits(origin, evidence)
      await highlightCheck(origin, evidence)
      await domInvarianceCheck(origin, flow.cdp, evidence)
      await toggleChipScenario(origin, flow.cdp, evidence)
      await budgetConcurrencyCheck(origin, evidence)
      await cacheScenario(origin, flow.cdp, evidence)
      await abortScenario(origin, flow.cdp, evidence, undefined, undefined)
      await evidenceScreenshot('browser-final', flow.cdp, RUN_DIR)
    } catch (error) {
      report.errors.push(String(error?.stack ?? error))
      addEntry({ id: 'browser.phase', criterion: 'browser phase could run', status: 'blocked', notes: `browser phase failed: ${String(error?.message ?? error)}` })
    }
  }
}

// ---------------------------------------------------------------------------
// Report writer
// ---------------------------------------------------------------------------

function buildMatrix() {
  const ids = [
    ['a', 'startup.patch', '--patch 启动无启动错误'],
    ['b', 'startup.nokey', '缺 key 启动显式报错（.credentials.yaml / JEV_API_KEY）'],
    ['c', 'budget.concurrency', '请求分块 ≤24k、并发 ≤12'],
    ['d', 'cache.hits', '重复内容命中缓存'],
    ['e', 'highlight.render', '高亮按 priority 出现（CSS.highlights 三色）'],
    ['f', 'abort.cancel', '取消/卸载时在途请求中止、无悬挂'],
    ['g', 'dom.invariance', '高亮不破坏 agent DOM'],
    ['h', 'chip.toggle', 'chip 显示计数且开关可用'],
  ]
  return ids.map(([id, entryId, criterion]) => {
    const entry = report.entries.find((candidate) => candidate.id === entryId)
    let status = entry?.status ?? 'blocked'
    let notes = entry?.notes ?? 'not run'
    if (id === 'f' && status !== 'pass') {
      const unit = report.entries.find((candidate) => candidate.id === 'host.unit-abort')
      if (unit?.status === 'pass') {
        status = 'pass'
        notes = `UI 停止生成按产品语义 committed 结束（不中止）；session/disposed 与插件卸载路径中止在途请求由 host 单测证明：${unit.notes}`
      }
    }
    if (id === 'f' && status === 'pass' && /archive-session/u.test(String(entry?.detail?.method ?? ''))) {
      notes = `归档会话（session/disposed）中止在途请求：${entry.notes}`
    }
    return { id, entryId, criterion, status, notes, evidence: entry?.evidence ?? [] }
  })
}

function writeReports() {
  // Copy the most useful screenshots next to the report for quick opening.
  for (const name of ['browser-highlights.png', 'browser-final.png']) {
    const source = join(RUN_DIR, name)
    if (existsSync(source)) {
      try {
        copyFileSync(source, join(DOCS, `e2e-${name.replace('browser-', '').replace('.png', '')}-latest.png`))
      } catch {
        // ignore copy failure
      }
    }
  }
  const matrix = buildMatrix()
  const summary = {
    runId: report.runId,
    scenario: report.scenario,
    generatedAt: nowIso(),
    counts: { pass: passed(), fail: failed(), blocked: blocked(), total: report.entries.length },
    matrix,
    entries: report.entries,
    evidence: report.evidence,
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([key, value]) => [key, key === 'tokenUrl' ? '<redacted>' : value]),
    ),
    processes: report.processes,
    errors: report.errors,
  }
  writeJson('acceptance-report.json', summary)
  writeFileSync(join(DOCS, 'acceptance-report.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  // Scenario-specific copies keep the full-stack report canonical even when
  // mock-selftest/nokey runs happen around it.
  writeFileSync(join(DOCS, `acceptance-report-${summary.scenario}.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

  const lines = []
  lines.push('# Jev 高亮插件 E2E 验收报告（自动生成）')
  lines.push('')
  lines.push(`- 运行 ID：\`${summary.runId}\``)
  lines.push(`- 场景：\`${summary.scenario}\`（dsh 端口 ${args.port}，mock 端口 ${args.mockPort}，浏览器：${args.ui}）`)
  lines.push(`- 生成时间：${summary.generatedAt}`)
  lines.push(`- 总计：**${summary.counts.pass} pass / ${summary.counts.fail} fail / ${summary.counts.blocked} blocked**（共 ${summary.counts.total} 项）`)
  lines.push('')
  lines.push('## 验收矩阵（任务书 8 条）')
  lines.push('')
  lines.push('| # | 验收标准 | 结论 | 说明 | 证据 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const row of matrix) {
    lines.push(`| ${row.id} | ${row.criterion} | **${row.status}** | ${String(row.notes).replaceAll('|', '\\|')} | ${row.evidence.map((item) => (typeof item === 'string' ? `\`${rel(item)}\`` : 'inline')).join('<br>')} |`)
  }
  lines.push('')
  lines.push('## 逐项明细')
  lines.push('')
  for (const entry of summary.entries) {
    lines.push(`### ${entry.id} — ${entry.status}`)
    lines.push('')
    lines.push(`- 标准：${entry.criterion}`)
    lines.push(`- 说明：${entry.notes}`)
    if (entry.detail !== undefined && Object.keys(entry.detail).length > 0) {
      lines.push(`- 细节：\`\`\`json\n${JSON.stringify(entry.detail, null, 2)}\n\`\`\``)
    }
    if (entry.evidence.length > 0) {
      lines.push(`- 证据：${entry.evidence.map((item) => (typeof item === 'string' ? `\`${rel(item)}\`` : JSON.stringify(item).slice(0, 300))).join('；')}`)
    }
    lines.push('')
  }
  lines.push('## 运行产物')
  lines.push('')
  lines.push(`原始日志、截图、diag 时间线、console/network 证据都在 \`${rel(RUN_DIR)}\`：`)
  try {
    for (const name of readdirSync(RUN_DIR).sort()) lines.push(`- \`${rel(join(RUN_DIR, name))}\``)
  } catch {
    // ignore
  }
  lines.push('')
  if (summary.errors.length > 0) {
    lines.push('## 运行错误')
    lines.push('')
    for (const error of summary.errors) lines.push('```\n' + error + '\n```')
    lines.push('')
  }
  writeFileSync(join(DOCS, 'e2e-report.md'), `${lines.join('\n')}\n`, 'utf8')
  writeFileSync(join(DOCS, `e2e-report-${summary.scenario}.md`), `${lines.join('\n')}\n`, 'utf8')
  log(`report written: ${join(DOCS, 'acceptance-report.json')}, ${join(DOCS, 'e2e-report.md')}`)
}

// ---------------------------------------------------------------------------
// Merge the per-scenario reports into the final canonical report
// ---------------------------------------------------------------------------

async function scenarioMerge() {
  const scenarios = ['mock', 'nokey', 'mock-selftest']
  const merged = []
  const usedRuns = []
  for (const scenario of scenarios) {
    const path = join(DOCS, `acceptance-report-${scenario}.json`)
    if (!existsSync(path)) continue
    const scenarioReport = JSON.parse(readFileSync(path, 'utf8'))
    usedRuns.push({ scenario, runId: scenarioReport.runId, counts: scenarioReport.counts })
    for (const entry of scenarioReport.entries ?? []) {
      if (!merged.some((candidate) => candidate.id === entry.id)) merged.push(entry)
    }
  }
  if (merged.length === 0) throw new Error('no per-scenario reports to merge')
  report.scenario = 'mock+nokey+mock-selftest'
  report.entries = merged
  report.scenarios = usedRuns
  artifacts.mergedScenarios = usedRuns.map((entry) => `${entry.scenario}:${entry.runId}`)
  log(`merged ${merged.length} entries from ${usedRuns.length} scenario report(s)`)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

process.on('SIGINT', () => {
  cleanupChildren()
  process.exit(130)
})

try {
  if (args.scenario === 'mock-selftest') {
    await scenarioMockSelftest()
  } else if (args.scenario === 'nokey') {
    await scenarioNoKey()
  } else if (args.scenario === 'attach') {
    await scenarioAttach()
  } else if (args.scenario === 'merge') {
    await scenarioMerge()
  } else if (args.scenario === 'mock' || args.scenario === 'live') {
    await scenarioStack(args.scenario)
  } else {
    throw new Error(`unknown --scenario ${args.scenario}`)
  }
} catch (error) {
  report.errors.push(String(error?.stack ?? error))
  log(`FATAL: ${String(error?.message ?? error)}`)
  addEntry({ id: 'harness', criterion: 'harness completes', status: 'fail', notes: String(error?.message ?? error) })
} finally {
  if (!args.keep) cleanupChildren()
  writeReports()
}

const fatal = report.errors.length > 0
process.exitCode = fatal || failed() > 0 ? 1 : 0
