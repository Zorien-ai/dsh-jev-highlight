/**
 * Shared fakes for the host test suite.
 *
 * The tests exercise the built bundle (lib/index.js) exactly the way the DSH
 * host would load it, with fake Cordis contexts, fake HTTP routes and fake
 * fetch implementations. Nothing here touches the network or real credentials.
 */
import { EventEmitter } from 'node:events'

/** Poll until `predicate()` is truthy (or reject after `timeoutMs`). */
export async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5, label = 'condition' } = {}) {
  const startedAt = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await delay(intervalMs)
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Fake Cordis host context: ctx.on / ctx.effect / ctx.get / logger. */
export function makeFakeCtx(overrides = {}) {
  const listeners = new Map()
  const effects = []
  const services = { webServer: overrides.webServer }
  const ctx = {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
    effect(callback) {
      const disposer = callback()
      effects.push(disposer)
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    get(name) {
      return services[name]
    },
    webServer: services.webServer,
    logger: { info() {}, warn() {}, error() {} },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0
    },
    get effects() {
      return effects
    },
    disposeEffects() {
      for (const dispose of effects) {
        if (typeof dispose === 'function') dispose()
      }
    },
    ...overrides,
  }
  return ctx
}

/** Fake webServer service that records routes and supports duplicate detection. */
export function makeFakeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

/**
 * Invoke one registered route with fake IncomingMessage / ServerResponse.
 * Returns {status, headers, body, json}.
 */
export async function callRoute(webServer, { method = 'GET', path, headers = {}, body, url } = {}) {
  const route = webServer.routes.get(path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  const req = new EventEmitter()
  req.method = method
  req.headers = headers
  req.url = url ?? path
  req.destroy = () => {}
  let status = 0
  let responseHeaders = {}
  let responseBody = ''
  const res = {
    writeHead(code, nextHeaders) {
      status = code
      responseHeaders = nextHeaders ?? {}
    },
    end(payload) {
      responseBody = typeof payload === 'string' ? payload : ''
    },
  }
  const handlerPromise = Promise.resolve(route.handler(req, res))
  if (body !== undefined) {
    req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    req.emit('end')
  }
  await handlerPromise
  let json
  if (responseBody !== '') {
    try {
      json = JSON.parse(responseBody)
    } catch {
      json = undefined
    }
  }
  return { status, headers: responseHeaders, body: responseBody, json }
}

/** Fake fetch response helpers. */
export function okResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
  }
}

export function statusResponse(status, { retryAfter, body = '{"error":"boom"}' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 429 ? 'Too Many Requests' : 'Error',
    headers: {
      get: (name) => (name.toLowerCase() === 'retry-after' && retryAfter !== undefined ? String(retryAfter) : null),
    },
    text: async () => body,
  }
}

/** Wrap a handler into a recording fetch implementation. */
export function makeFakeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const call = { url, init, startedAt: Date.now() }
    calls.push(call)
    return await handler(call, calls.length - 1)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

/** Build a documented-shape systemOne response (all four questions present). */
export function answerPayload(scores) {
  const answers = {}
  for (const id of ['is_core_answer', 'is_actionable', 'is_warning', 'is_definition']) {
    answers[id] = { type: 'noul', noul: Number.isFinite(scores?.[id]) ? scores[id] : 0 }
  }
  for (const [id, value] of Object.entries(scores ?? {})) {
    if (!(id in answers)) answers[id] = { type: 'noul', noul: value }
  }
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 42, output_tokens: 7 } }
}

/** Parse the JSON body of one recorded fetch call. */
export function requestBody(call) {
  return JSON.parse(call.init.body)
}

/** A judge client whose settlements the test controls. */
export function makeControlledJudgeClient() {
  const calls = []
  const client = {
    calls,
    judgeUnit(unit, { signal }) {
      return new Promise((resolve, reject) => {
        const call = {
          unit,
          signal,
          settled: false,
          resolve(scores) {
            if (call.settled) return
            call.settled = true
            resolve({ scores, cached: false })
          },
          reject(error) {
            if (call.settled) return
            call.settled = true
            reject(error)
          },
        }
        calls.push(call)
        if (signal !== undefined) {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted')
              error.name = 'JevAbortError'
              call.reject(error)
            },
            { once: true },
          )
        }
      })
    },
    stats() {
      const inFlight = calls.filter((call) => !call.settled).length
      return {
        requests: calls.length,
        inFlight,
        maxConcurrentObserved: inFlight,
        maxRequestTokensObserved: 0,
        abortedRequests: calls.filter((call) => call.signal?.aborted === true).length,
        failures: 0,
        cacheHits: 0,
        cacheMisses: calls.length,
        cacheSize: 0,
      }
    },
  }
  return client
}

/** A judge client that always resolves immediately with fixed scores. */
export function makeImmediateJudgeClient(scores = { is_core_answer: 0.9, is_actionable: 0.5, is_warning: 0.2, is_definition: 0.1 }) {
  const calls = []
  return {
    calls,
    async judgeUnit(unit, { signal }) {
      if (signal?.aborted) {
        const error = new Error('aborted')
        error.name = 'JevAbortError'
        throw error
      }
      calls.push(unit)
      return { scores: { ...scores }, cached: false }
    },
    stats() {
      return {
        requests: calls.length,
        inFlight: 0,
        maxConcurrentObserved: 0,
        maxRequestTokensObserved: 0,
        abortedRequests: 0,
        failures: 0,
        cacheHits: 0,
        cacheMisses: calls.length,
        cacheSize: 0,
      }
    },
  }
}

/** Assistant-stream frame builders (payload + frame, exactly as the event carries it). */
export const SESSION = 'session-1'

export function startPayload({ sessionId = SESSION, attemptId = 'attempt-1', revision = 0, turn = 1 } = {}) {
  return {
    agent: { id: sessionId },
    frame: { type: 'start', attemptId, revision, turn, step: 1 },
  }
}

export function chunkPayload(frame) {
  return { agent: { id: SESSION }, frame }
}

export function blockStartPayload({ index = 0, blockType = 'text', attemptId = 'attempt-1', revision = 0, sessionId = SESSION } = {}) {
  return { agent: { id: sessionId }, frame: { type: 'chunk', attemptId, revision, index, time: Date.now(), chunk: { type: 'block-start', index, blockType } } }
}

export function textDeltaPayload(text, { index = 0, attemptId = 'attempt-1', revision = 0, sessionId = SESSION } = {}) {
  return { agent: { id: sessionId }, frame: { type: 'chunk', attemptId, revision, index, time: Date.now(), chunk: { type: 'text-delta', index, text } } }
}

export function blockEndPayload(text, { index = 0, blockType = 'text', attemptId = 'attempt-1', revision = 0, sessionId = SESSION } = {}) {
  const block = blockType === 'text' ? { type: 'text', text } : { type: blockType }
  return { agent: { id: sessionId }, frame: { type: 'chunk', attemptId, revision, index, time: Date.now(), chunk: { type: 'block-end', index, block } } }
}

export function endPayload({ attemptId = 'attempt-1', revision = 0, committed = true, sessionId = SESSION } = {}) {
  return {
    agent: { id: sessionId },
    frame: {
      type: 'end',
      attemptId,
      revision,
      index: 0,
      outcome: committed ? { kind: 'committed', eventType: 'assistant/message', seq: 1 } : { kind: 'abandoned' },
    },
  }
}

/** Fake object exposing a Session-like `id`. */
export function makeSessionObject(sessionId = SESSION) {
  return { id: sessionId }
}
