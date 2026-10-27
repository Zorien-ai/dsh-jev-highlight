/**
 * HTTP routes: same-origin guards, response contracts, toggle behaviour.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  JEV_ROUTE_PATHS,
  ROUTE_CHECK,
  ROUTE_DIAG,
  ROUTE_KEY,
  ROUTE_PROMPTS,
  ROUTE_PROVIDER,
  ROUTE_STATE,
  ROUTE_THINK,
  ROUTE_THRESHOLDS,
  ROUTE_TOGGLE,
  ROUTE_UNITS,
  guardRouteRequest,
  parseQuery,
  readJsonBody,
  registerJevRoutes,
} from '../../lib/index.js'
import { callRoute, makeFakeWebServer } from './helpers.mjs'

const THRESHOLDS = { critical: 0.85, medium: 0.65, low: 0.45 }

function makeDiag(overrides = {}) {
  return {
    active: true,
    unitsSeen: 3,
    unitsQueued: 0,
    unitsJudged: 2,
    requests: 2,
    inFlight: 0,
    maxConcurrentObserved: 2,
    maxRequestTokensObserved: 900,
    requestBudget: 24000,
    concurrencyLimit: 8,
    cacheHits: 1,
    cacheMisses: 1,
    cacheSize: 1,
    abortedRequests: 0,
    failures: 0,
    droppedUnits: 0,
    lastError: null,
    keySource: 'config',
    provider: 'jev',
    keyConfigured: true,
    questionSetVersion: 'jev-highlight/questions/v2',
    model: 'jev-1.13.0',
    baseUrl: 'https://api.example.test',
    thresholdOverrides: THRESHOLDS,
    ...overrides,
  }
}

function makeDeps(overrides = {}) {
  const seenQueries = []
  let enabled = true
  const deps = {
    seenQueries,
    getProvider() {
      return {
        provider: 'startlux',
        model: 'startlux-decision-27b-autothink',
        baseUrl: 'https://api.bamboonode.dev/v1',
        endpointPath: '/decisions',
        thinkMode: 'never',
        keyConfigured: false,
        keySource: null,
        keyFile: 'C:/tmp/startlux.key',
        keyRequired: false,
        thresholds: THRESHOLDS,
        thresholdsSource: 'config',
      }
    },
    saveKey(key) {
      return { ok: true, action: 'save', provider: this.getProvider() }
    },
    clearKey() {
      return { ok: true, action: 'clear', provider: this.getProvider() }
    },
    setThinkMode(mode) {
      const resolved = mode === 'default' ? 'never' : mode
      return { ok: true, mode: resolved, provider: { ...this.getProvider(), thinkMode: resolved } }
    },
    setThresholds(input) {
      const thresholds = { critical: Number(input.critical), medium: Number(input.medium), low: Number(input.low) }
      return {
        ok: true,
        thresholds,
        source: 'settings',
        provider: { ...this.getProvider(), thresholds, thresholdsSource: 'settings' },
      }
    },
    resetThresholds() {
      return {
        ok: true,
        thresholds: THRESHOLDS,
        source: 'config',
        provider: { ...this.getProvider(), thresholds: THRESHOLDS, thresholdsSource: 'config' },
      }
    },
    async check() {
      return { ok: true, provider: 'startlux', model: 'startlux-decision-27b-autothink', latencyMs: 12, answer: 0.9 }
    },
    getState() {
      return {
        enabled,
        counts: { critical: 1, medium: 2, low: 0 },
        capabilities: { highlightApi: true },
        model: 'jev-1.13.0',
        thresholds: THRESHOLDS,
      }
    },
    getUnits(query) {
      seenQueries.push(query)
      return {
        units: [
          {
            seq: 7,
            unitId: 'u7',
            sessionId: 's1',
            type: 'table_row',
            text: 'a | b',
            matchText: 'a b',
            context: {},
            priority: 0.9,
            level: 'critical',
            scores: { is_core_answer: 1, is_actionable: 1, is_warning: 0, is_definition: 0 },
            model: 'jev-1.13.0',
            cached: false,
            createdAt: 1,
          },
        ],
        seq: 7,
      }
    },
    getDiag() {
      return makeDiag()
    },
    getPrompts() {
      return {
        questionSetVersion: 'jev-highlight/questions/v2',
        provider: 'jev',
        model: 'jev-1.13.0',
        stateTemplate: '[section] {heading}\n[preceding line] {before}\n[question] {request}\n[passage]\n{unit}',
        questions: {
          is_core_answer: { type: 'noul', instructions: 'core?' },
          is_actionable: { type: 'noul', instructions: 'action?' },
          is_warning: { type: 'noul', instructions: 'warning?' },
          is_definition: { type: 'noul', instructions: 'definition?' },
        },
        weights: { coreAnswer: 0.5, actionable: 0.3, warningOrDefinition: 0.2 },
        thresholds: THRESHOLDS,
        maxQuestionChars: 600,
      }
    },
    toggle(value) {
      enabled = value
      return deps.getState()
    },
  }
  return Object.assign(deps, overrides)
}

function makeReq({ method = 'GET', headers = {}, url = '/', body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = headers
  req.url = url
  req.destroy = () => {}
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      req.emit('end')
    })
  }
  return req
}

function makeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    end(payload) {
      res.body = payload ?? ''
    },
  }
  return res
}

test('registers exactly the ten client routes', () => {
  const webServer = makeFakeWebServer()
  const dispose = registerJevRoutes(webServer, makeDeps())
  assert.deepEqual([...webServer.routes.keys()].sort(), [...JEV_ROUTE_PATHS].sort())
  dispose()
  assert.equal(webServer.routes.size, 0)
})

test('GET /provider and POST /check expose status without the key', async () => {
  const webServer = makeFakeWebServer()
  registerJevRoutes(webServer, makeDeps())
  const provider = await callRoute(webServer, { path: ROUTE_PROVIDER })
  assert.equal(provider.status, 200)
  assert.equal(provider.json.provider.provider, 'startlux')
  assert.equal(provider.json.provider.keyConfigured, false)

  const checked = await callRoute(webServer, {
    method: 'POST',
    path: ROUTE_CHECK,
    headers: { 'content-type': 'application/json' },
    body: {},
  })
  assert.equal(checked.json.ok, true)
  assert.equal(checked.json.latencyMs, 12)
  assert.equal(checked.json.answer, 0.9)
})

test('POST /key saves and clears without echoing the key', async () => {
  const webServer = makeFakeWebServer()
  registerJevRoutes(webServer, makeDeps())
  const saved = await callRoute(webServer, {
    method: 'POST',
    path: ROUTE_KEY,
    headers: { 'content-type': 'application/json' },
    body: { action: 'save', key: 'bk-secret-key-value' },
  })
  assert.equal(saved.json.ok, true)
  assert.equal(saved.json.action, 'save')
  assert.equal(saved.body.includes('bk-secret-key-value'), false)
  const cleared = await callRoute(webServer, {
    method: 'POST',
    path: ROUTE_KEY,
    headers: { 'content-type': 'application/json' },
    body: { action: 'clear' },
  })
  assert.equal(cleared.json.ok, true)
  assert.equal(cleared.json.action, 'clear')
})

test('POST /think switches think mode and rejects unknown values', async () => {
  const webServer = makeFakeWebServer()
  registerJevRoutes(webServer, makeDeps())
  const auto = await callRoute(webServer, {
    method: 'POST',
    path: ROUTE_THINK,
    headers: { 'content-type': 'application/json' },
    body: { mode: 'auto' },
  })
  assert.equal(auto.json.ok, true)
  assert.equal(auto.json.mode, 'auto')
  assert.equal(auto.json.provider.thinkMode, 'auto')

  const fallback = await callRoute(webServer, {
    method: 'POST',
    path: ROUTE_THINK,
    headers: { 'content-type': 'application/json' },
    body: { mode: 'default' },
  })
  assert.equal(fallback.json.ok, true)
  assert.equal(fallback.json.mode, 'never')

  const invalid = await callRoute(webServer, {
    method: 'POST',
    path: ROUTE_THINK,
    headers: { 'content-type': 'application/json' },
    body: { mode: 'bogus' },
  })
  assert.equal(invalid.json.ok, false)
})

test('POST /thresholds saves, resets and validates ordering', async () => {
  const webServer = makeFakeWebServer()
  registerJevRoutes(webServer, makeDeps())
  const saved = await callRoute(webServer, {
    method: 'POST',
    path: ROUTE_THRESHOLDS,
    headers: { 'content-type': 'application/json' },
    body: { critical: 0.52, medium: 0.37, low: 0.24 },
  })
  assert.equal(saved.json.ok, true)
  assert.deepEqual(saved.json.thresholds, { critical: 0.52, medium: 0.37, low: 0.24 })
  assert.equal(saved.json.source, 'settings')

  const reset = await callRoute(webServer, {
    method: 'POST',
    path: ROUTE_THRESHOLDS,
    headers: { 'content-type': 'application/json' },
    body: { action: 'reset' },
  })
  assert.equal(reset.json.ok, true)
  assert.deepEqual(reset.json.thresholds, THRESHOLDS)
  assert.equal(reset.json.source, 'config')
})

test('GET /state returns the documented state shape', async () => {
  const webServer = makeFakeWebServer()
  registerJevRoutes(webServer, makeDeps())
  const response = await callRoute(webServer, { path: ROUTE_STATE })
  assert.equal(response.status, 200)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(response.json.ok, true)
  assert.equal(response.json.enabled, true)
  assert.deepEqual(response.json.counts, { critical: 1, medium: 2, low: 0 })
  assert.deepEqual(response.json.capabilities, { highlightApi: true })
  assert.equal(response.json.model, 'jev-1.13.0')
  assert.deepEqual(response.json.thresholds, THRESHOLDS)
})

test('GET /units parses since, limit and sessionId', async () => {
  const deps = makeDeps()
  const webServer = makeFakeWebServer()
  registerJevRoutes(webServer, deps)
  const response = await callRoute(webServer, {
    path: ROUTE_UNITS,
    url: `${ROUTE_UNITS}?since=5&limit=10&sessionId=s1`,
  })
  assert.equal(response.json.ok, true)
  assert.equal(response.json.seq, 7)
  assert.equal(response.json.units[0].matchText, 'a b')
  assert.deepEqual(deps.seenQueries[0], { since: 5, limit: 10, sessionId: 's1' })
})

test('GET /units applies safe defaults for bad query values', async () => {
  const deps = makeDeps()
  const webServer = makeFakeWebServer()
  registerJevRoutes(webServer, deps)
  await callRoute(webServer, { path: ROUTE_UNITS, url: `${ROUTE_UNITS}?since=-4&limit=0&sessionId=` })
  assert.deepEqual(deps.seenQueries[0], { since: 0, limit: 200, sessionId: undefined })
  await callRoute(webServer, { path: ROUTE_UNITS, url: `${ROUTE_UNITS}?limit=99999` })
  assert.equal(deps.seenQueries[1].limit, 1000)
})

test('GET /prompts exposes the prompt design without secrets', async () => {
  const webServer = makeFakeWebServer()
  registerJevRoutes(webServer, makeDeps())
  const response = await callRoute(webServer, { path: ROUTE_PROMPTS })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.questionSetVersion, 'jev-highlight/questions/v2')
  assert.equal(response.json.questions.is_core_answer.type, 'noul')
  assert.ok(response.json.stateTemplate.includes('[question]'))
  assert.deepEqual(response.json.weights, { coreAnswer: 0.5, actionable: 0.3, warningOrDefinition: 0.2 })
  assert.equal(response.json.maxQuestionChars, 600)
  assert.equal(response.body.includes('key'), false)
})

test('GET /diag returns the DiagSnapshot fields at the top level', async () => {
  const webServer = makeFakeWebServer()
  registerJevRoutes(webServer, makeDeps({ getDiag: () => makeDiag({ lastError: 'boom' }) }))
  const response = await callRoute(webServer, { path: ROUTE_DIAG })
  assert.equal(response.json.ok, true)
  assert.equal(response.json.active, true)
  assert.equal(response.json.maxConcurrentObserved, 2)
  assert.equal(response.json.keySource, 'config')
  assert.equal(response.json.lastError, 'boom')
  assert.deepEqual(response.json.thresholdOverrides, THRESHOLDS)
  assert.equal(response.body.includes('test-key'), false)
})

test('POST /toggle flips the state and returns it', async () => {
  const deps = makeDeps()
  const webServer = makeFakeWebServer()
  registerJevRoutes(webServer, deps)
  const response = await callRoute(webServer, {
    method: 'POST',
    path: ROUTE_TOGGLE,
    headers: { 'content-type': 'application/json' },
    body: { enabled: false },
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.state.enabled, false)

  const state = await callRoute(webServer, { path: ROUTE_STATE })
  assert.equal(state.json.enabled, false)
})

test('POST /toggle rejects a non-boolean body and bad JSON', async () => {
  const webServer = makeFakeWebServer()
  registerJevRoutes(webServer, makeDeps())
  const wrongType = await callRoute(webServer, {
    method: 'POST',
    path: ROUTE_TOGGLE,
    headers: { 'content-type': 'application/json' },
    body: { enabled: 'yes' },
  })
  assert.equal(wrongType.json.ok, false)
  assert.match(wrongType.json.error, /boolean/u)

  const badJson = await callRoute(webServer, {
    method: 'POST',
    path: ROUTE_TOGGLE,
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  assert.equal(badJson.json.ok, false)
  assert.match(badJson.json.error, /not JSON/u)
})

test('route guards reject wrong method, cross-site and non-JSON POST bodies', async () => {
  const webServer = makeFakeWebServer()
  registerJevRoutes(webServer, makeDeps())

  const wrongMethod = await callRoute(webServer, { method: 'POST', path: ROUTE_STATE, headers: { 'content-type': 'application/json' } })
  assert.equal(wrongMethod.status, 405)

  const crossSite = await callRoute(webServer, { path: ROUTE_STATE, headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)

  const badOrigin = await callRoute(webServer, {
    path: ROUTE_STATE,
    headers: { origin: 'https://evil.example', host: '127.0.0.1:10222' },
  })
  assert.equal(badOrigin.status, 403)

  const sameOrigin = await callRoute(webServer, {
    path: ROUTE_STATE,
    headers: { origin: 'http://127.0.0.1:10222', host: '127.0.0.1:10222' },
  })
  assert.equal(sameOrigin.status, 200)

  const noContentType = await callRoute(webServer, { method: 'POST', path: ROUTE_TOGGLE, body: { enabled: false } })
  assert.equal(noContentType.status, 415)
})

test('guardRouteRequest writes its own error response', () => {
  const res = makeRes()
  const allowed = guardRouteRequest(makeReq({ method: 'DELETE' }), res, 'GET')
  assert.equal(allowed, false)
  assert.equal(res.status, 405)
  assert.match(res.body, /only GET/u)
})

test('route handlers never throw: dependency errors become {ok:false}', async () => {
  const webServer = makeFakeWebServer()
  registerJevRoutes(
    webServer,
    makeDeps({
      getState() {
        throw new Error('state exploded')
      },
    }),
  )
  const response = await callRoute(webServer, { path: ROUTE_STATE })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, false)
  assert.match(response.json.error, /state exploded/u)
})

test('readJsonBody enforces the size limit', async () => {
  const req = makeReq({ method: 'POST' })
  const promise = readJsonBody(req, 8)
  setImmediate(() => req.emit('data', Buffer.alloc(32)))
  await assert.rejects(promise, /too large/u)
})

test('readJsonBody parses valid JSON', async () => {
  const req = makeReq({ method: 'POST' })
  const promise = readJsonBody(req)
  setImmediate(() => {
    req.emit('data', Buffer.from('{"enabled":true}'))
    req.emit('end')
  })
  assert.deepEqual(await promise, { enabled: true })
})

test('parseQuery handles missing and malformed query strings', () => {
  assert.equal(parseQuery(undefined).get('a'), null)
  assert.equal(parseQuery('/x').get('a'), null)
  assert.equal(parseQuery('/x?a=1').get('a'), '1')
  assert.doesNotThrow(() => parseQuery('/x?%zz'))
})
