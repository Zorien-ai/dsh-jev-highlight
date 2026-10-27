/**
 * Client-facing HTTP routes.
 *
 * The host half owns the API key, so the browser talks to these same-origin
 * JSON routes instead of calling Jev directly. Plugin routes bypass DSH
 * connection auth, therefore every route enforces the same guard the reference
 * deepsearch plugin uses:
 *
 *   - expected HTTP method;
 *   - a browser `Origin` header must be same-origin with `Host`;
 *   - `Sec-Fetch-Site: cross-site` is rejected;
 *   - POST bodies must be `application/json`;
 *   - request bodies are bounded.
 *
 * This blocks CSRF; it is not authentication. The web server must keep
 * listening on 127.0.0.1 only.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DiagSnapshot, HighlightThresholds, JudgeProvider, StartLuxThinkMode, UnitVerdict } from '../contract.js'

export const ROUTE_STATE = '/jev-highlight/state'
export const ROUTE_UNITS = '/jev-highlight/units'
export const ROUTE_DIAG = '/jev-highlight/diag'
export const ROUTE_TOGGLE = '/jev-highlight/toggle'
export const ROUTE_PROMPTS = '/jev-highlight/prompts'
export const ROUTE_PROVIDER = '/jev-highlight/provider'
export const ROUTE_KEY = '/jev-highlight/key'
export const ROUTE_CHECK = '/jev-highlight/check'
export const ROUTE_THINK = '/jev-highlight/think'
export const ROUTE_THRESHOLDS = '/jev-highlight/thresholds'
export const JEV_ROUTE_PATHS: readonly string[] = [
  ROUTE_STATE,
  ROUTE_UNITS,
  ROUTE_DIAG,
  ROUTE_TOGGLE,
  ROUTE_PROMPTS,
  ROUTE_PROVIDER,
  ROUTE_KEY,
  ROUTE_CHECK,
  ROUTE_THINK,
  ROUTE_THRESHOLDS,
]

export interface RouteState {
  enabled: boolean
  /** Active judge backend and the model it calls. */
  provider: JudgeProvider
  /** False when activation continued without a resolvable API key. */
  keyConfigured: boolean
  /** Actionable credential/configuration notice, shown in the chip tooltip. */
  notice: string | null
  counts: { critical: number; medium: number; low: number }
  capabilities: { highlightApi: boolean }
  model: string
  baseUrl: string
  thresholds: HighlightThresholds
}

export interface UnitsQuery {
  since: number
  sessionId?: string
  limit: number
}

export interface UnitsResult {
  units: UnitVerdict[]
  seq: number
}

/** Read-only description of the judge prompt design (GET /jev-highlight/prompts). */
export interface PromptsPayload {
  questionSetVersion: string
  provider: JudgeProvider
  model: string
  /** State template; `{...}` slots mark optional grounding lines. */
  stateTemplate: string
  /** Wire payload of each noul question, exactly as sent to the judge. */
  questions: Record<string, { type: 'noul'; instructions: string }>
  weights: { coreAnswer: number; actionable: number; warningOrDefinition: number }
  thresholds: HighlightThresholds
  /** Max characters of the user request injected into `[question]`. */
  maxQuestionChars: number
}

/** Provider/key status for the Settings tab (never contains the key). */
export interface ProviderStatus {
  provider: JudgeProvider
  model: string
  baseUrl: string
  endpointPath: string
  thinkMode: StartLuxThinkMode | 'n/a'
  keyConfigured: boolean
  keySource: string | null
  /** Where a key typed into Settings is stored. */
  keyFile: string
  keyRequired: boolean
  /** Effective highlight cutoffs (Settings override or provider default). */
  thresholds: HighlightThresholds
  thresholdsSource: 'settings' | 'config'
}

export interface ThresholdsResult {
  ok: boolean
  thresholds: HighlightThresholds
  source: 'settings' | 'config'
  provider: ProviderStatus
  error?: string
}

export interface ThinkModeResult {
  ok: boolean
  mode: StartLuxThinkMode
  provider: ProviderStatus
  error?: string
}

export interface KeyActionResult {
  ok: boolean
  action: 'save' | 'clear'
  provider: ProviderStatus
  error?: string
}

export interface ProviderCheckResult {
  ok: boolean
  provider: JudgeProvider
  model: string
  latencyMs?: number
  modelReturned?: string
  answer?: number
  error?: string
}

export interface RouteDeps {
  getState(): RouteState
  getUnits(query: UnitsQuery): UnitsResult
  getDiag(): DiagSnapshot
  getPrompts(): PromptsPayload
  getProvider(): ProviderStatus
  saveKey(key: string): KeyActionResult
  clearKey(): KeyActionResult
  setThinkMode(mode: StartLuxThinkMode | 'default'): ThinkModeResult
  setThresholds(input: { critical?: unknown; medium?: unknown; low?: unknown }): ThresholdsResult
  resetThresholds(): ThresholdsResult
  check(): Promise<ProviderCheckResult>
  toggle(enabled: boolean): RouteState
}

export interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface WebServerLike {
  register(route: WebRouteLike): () => void
}

const MAX_BODY_BYTES = 65536

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 400 ? `${message.slice(0, 400)}…` : message
}

/** Read and JSON-parse a request body, rejecting bodies above `limit` bytes. */
export function readJsonBody(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise<unknown>((resolveBody, rejectBody) => {
    const parts: Buffer[] = []
    let size = 0
    req.on('data', (chunk: unknown) => {
      const buffer: Buffer = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk)
          : Buffer.from(chunk as ArrayBuffer)
      size += buffer.length
      if (size > limit) {
        rejectBody(new Error('request body is too large'))
        req.destroy()
        return
      }
      parts.push(buffer)
    })
    req.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8').trim()
      if (text === '') {
        resolveBody({})
        return
      }
      try {
        resolveBody(JSON.parse(text))
      } catch (error) {
        rejectBody(new Error(`request body is not JSON: ${describeError(error)}`))
      }
    })
    req.on('error', (error: unknown) => rejectBody(error))
  })
}

/** Write one JSON response; never throws, never echoes secrets. */
export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  let body: string
  try {
    body = JSON.stringify(value)
  } catch {
    body = JSON.stringify({ ok: false, error: 'state is not serializable' })
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Validate method, browser same-origin and POST content-type. Writes the error
 * response itself and returns false when the request must not proceed.
 */
export function guardRouteRequest(req: IncomingMessage, res: ServerResponse, expectedMethod: string): boolean {
  const method = String(req.method ?? '').toUpperCase()
  if (method !== expectedMethod) {
    sendJson(res, 405, { ok: false, error: `only ${expectedMethod} is allowed` })
    return false
  }

  const headers = req.headers ?? {}
  const origin = typeof headers.origin === 'string' ? headers.origin.trim() : ''
  if (origin !== '') {
    let parsed: URL | undefined
    try {
      parsed = new URL(origin)
    } catch {
      parsed = undefined
    }
    const host = typeof headers.host === 'string' ? headers.host : ''
    if (parsed === undefined || host === '' || parsed.host !== host) {
      sendJson(res, 403, { ok: false, error: 'only same-origin page requests are allowed' })
      return false
    }
  }
  if (headers['sec-fetch-site'] === 'cross-site') {
    sendJson(res, 403, { ok: false, error: 'only same-origin page requests are allowed' })
    return false
  }

  if (expectedMethod === 'POST') {
    const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'].toLowerCase() : ''
    if (!contentType.startsWith('application/json')) {
      sendJson(res, 415, { ok: false, error: 'POST requests must use application/json' })
      return false
    }
  }
  return true
}

function parseNonNegativeInt(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}

function clampLimit(raw: string | null): number {
  const parsed = parseNonNegativeInt(raw, 200)
  if (parsed < 1) return 200
  return Math.min(1000, parsed)
}

/** Parse the query string of a request URL without trusting it. */
export function parseQuery(url: string | undefined): URLSearchParams {
  const raw = typeof url === 'string' ? url : ''
  const index = raw.indexOf('?')
  if (index === -1) return new URLSearchParams()
  try {
    return new URLSearchParams(raw.slice(index + 1))
  } catch {
    return new URLSearchParams()
  }
}

/** Register the five client routes; returns one combined disposer. */
export function registerJevRoutes(webServer: WebServerLike, deps: RouteDeps): () => void {
  if (typeof webServer?.register !== 'function') {
    throw new Error('the web server service is unavailable; cannot register jev-highlight routes')
  }

  const disposeState = webServer.register({
    kind: 'exact',
    path: ROUTE_STATE,
    handler: (req, res) => {
      if (!guardRouteRequest(req, res, 'GET')) return
      try {
        sendJson(res, 200, { ok: true, ...deps.getState() })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError(error) })
      }
    },
  })

  const disposeUnits = webServer.register({
    kind: 'exact',
    path: ROUTE_UNITS,
    handler: (req, res) => {
      if (!guardRouteRequest(req, res, 'GET')) return
      try {
        const query = parseQuery(req.url)
        const sessionId = query.get('sessionId') ?? undefined
        const result = deps.getUnits({
          since: parseNonNegativeInt(query.get('since'), 0),
          sessionId: sessionId === undefined || sessionId.trim() === '' ? undefined : sessionId.trim(),
          limit: clampLimit(query.get('limit')),
        })
        sendJson(res, 200, { ok: true, units: result.units, seq: result.seq })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError(error) })
      }
    },
  })

  const disposeDiag = webServer.register({
    kind: 'exact',
    path: ROUTE_DIAG,
    handler: (req, res) => {
      if (!guardRouteRequest(req, res, 'GET')) return
      try {
        sendJson(res, 200, { ok: true, ...deps.getDiag() })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError(error) })
      }
    },
  })

  const disposeToggle = webServer.register({
    kind: 'exact',
    path: ROUTE_TOGGLE,
    handler: async (req, res) => {
      if (!guardRouteRequest(req, res, 'POST')) return
      try {
        const body = (await readJsonBody(req)) as { enabled?: unknown }
        if (typeof body?.enabled !== 'boolean') {
          sendJson(res, 200, { ok: false, error: 'body.enabled must be a boolean' })
          return
        }
        sendJson(res, 200, { ok: true, state: deps.toggle(body.enabled) })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError(error) })
      }
    },
  })

  const disposePrompts = webServer.register({
    kind: 'exact',
    path: ROUTE_PROMPTS,
    handler: (req, res) => {
      if (!guardRouteRequest(req, res, 'GET')) return
      try {
        sendJson(res, 200, { ok: true, ...deps.getPrompts() })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError(error) })
      }
    },
  })

  const disposeProvider = webServer.register({
    kind: 'exact',
    path: ROUTE_PROVIDER,
    handler: (req, res) => {
      if (!guardRouteRequest(req, res, 'GET')) return
      try {
        sendJson(res, 200, { ok: true, provider: deps.getProvider() })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError(error) })
      }
    },
  })

  const disposeKey = webServer.register({
    kind: 'exact',
    path: ROUTE_KEY,
    handler: async (req, res) => {
      if (!guardRouteRequest(req, res, 'POST')) return
      try {
        const body = (await readJsonBody(req)) as { action?: unknown; key?: unknown }
        const action = typeof body?.action === 'string' ? body.action.trim() : 'save'
        if (action === 'save') {
          if (typeof body.key !== 'string' || body.key.trim() === '') {
            sendJson(res, 200, { ok: false, action, error: 'body.key must be a non-empty string' })
            return
          }
          const result = deps.saveKey(body.key)
          // Never echo the key value: only provider status metadata comes back.
          sendJson(res, 200, { ok: result.ok, action, provider: result.provider, ...(result.error !== undefined ? { error: result.error } : {}) })
          return
        }
        if (action === 'clear') {
          const result = deps.clearKey()
          sendJson(res, 200, { ok: result.ok, action, provider: result.provider, ...(result.error !== undefined ? { error: result.error } : {}) })
          return
        }
        sendJson(res, 200, { ok: false, action, error: 'action must be "save" or "clear"' })
      } catch (error) {
        sendJson(res, 200, { ok: false, action: 'save', error: describeError(error) })
      }
    },
  })

  const disposeCheck = webServer.register({
    kind: 'exact',
    path: ROUTE_CHECK,
    handler: async (req, res) => {
      if (!guardRouteRequest(req, res, 'POST')) return
      try {
        const result = await deps.check()
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 200, { ok: false, provider: 'jev', model: '', error: describeError(error) })
      }
    },
  })

  const disposeThink = webServer.register({
    kind: 'exact',
    path: ROUTE_THINK,
    handler: async (req, res) => {
      if (!guardRouteRequest(req, res, 'POST')) return
      try {
        const body = (await readJsonBody(req)) as { mode?: unknown }
        const raw = typeof body?.mode === 'string' ? body.mode.trim() : ''
        if (raw !== 'never' && raw !== 'auto' && raw !== 'always' && raw !== 'default') {
          sendJson(res, 200, { ok: false, error: "mode must be 'never', 'auto', 'always' or 'default'" })
          return
        }
        const result = deps.setThinkMode(raw)
        sendJson(res, 200, { ok: result.ok, mode: result.mode, provider: result.provider, ...(result.error !== undefined ? { error: result.error } : {}) })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError(error) })
      }
    },
  })

  const disposeThresholds = webServer.register({
    kind: 'exact',
    path: ROUTE_THRESHOLDS,
    handler: async (req, res) => {
      if (!guardRouteRequest(req, res, 'POST')) return
      try {
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const action = typeof body?.action === 'string' ? body.action.trim() : 'save'
        if (action === 'reset') {
          const result = deps.resetThresholds()
          sendJson(res, 200, {
            ok: result.ok,
            thresholds: result.thresholds,
            source: result.source,
            provider: result.provider,
            ...(result.error !== undefined ? { error: result.error } : {}),
          })
          return
        }
        if (action !== 'save') {
          sendJson(res, 200, { ok: false, error: "action must be 'save' or 'reset'" })
          return
        }
        const result = deps.setThresholds({ critical: body.critical, medium: body.medium, low: body.low })
        sendJson(res, 200, {
          ok: result.ok,
          thresholds: result.thresholds,
          source: result.source,
          provider: result.provider,
          ...(result.error !== undefined ? { error: result.error } : {}),
        })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: describeError(error) })
      }
    },
  })

  return () => {
    for (const dispose of [
      disposeState,
      disposeUnits,
      disposeDiag,
      disposeToggle,
      disposePrompts,
      disposeProvider,
      disposeKey,
      disposeCheck,
      disposeThink,
      disposeThresholds,
    ]) {
      try {
        dispose()
      } catch {
        // Ignore disposal races; the route may already be gone.
      }
    }
  }
}
