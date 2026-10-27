/**
 * Runtime wiring: listeners/routes registration, E2E through the HTTP layer,
 * unload cancellation, and the fail-loud missing-key activation path.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MissingJevApiKeyError,
  MissingStartLuxApiKeyError,
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
  apply,
  createHostRuntime,
} from '../../lib/index.js'
import {
  SESSION,
  answerPayload,
  blockEndPayload,
  blockStartPayload,
  callRoute,
  endPayload,
  makeFakeCtx,
  makeFakeFetch,
  makeFakeWebServer,
  okResponse,
  requestBody,
  startPayload,
  textDeltaPayload,
  waitFor,
} from './helpers.mjs'

const THRESHOLDS = { critical: 0.85, medium: 0.65, low: 0.45 }
const ALL_MEDIUM = { is_core_answer: 1, is_actionable: 1, is_warning: 0, is_definition: 0 }
const CREDENTIAL = { key: 'test-key', source: 'config' }

// Isolate every runtime test from the developer's real Settings files (the
// StartLux key / think-mode overrides live under $DSH_HOME). Tests that need a
// specific home still override and restore it locally.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'jev-runtime-home-'))

function makeConfig(overrides = {}) {
  return {
    provider: 'jev',
    startluxBaseUrl: 'https://api.bamboonode.dev/v1',
    startluxModel: 'startlux-decision-27b-autothink',
    startluxEndpointPath: '/decisions',
    startluxThinkMode: 'never',
    startluxKeyFile: '',
    jevApiKey: '',
    jevBaseUrl: 'https://api.example.test',
    model: 'jev-1.13.0',
    maxConcurrency: 8,
    requestTokenBudget: 24000,
    unitTokenBudget: 20000,
    cacheCapacity: 500,
    requestTimeoutMs: 30000,
    highlightThresholds: THRESHOLDS,
    autoStart: true,
    requireApiKey: false,
    debug: false,
    ...overrides,
  }
}

function makeRuntime(overrides = {}) {
  const ctx = makeFakeCtx({ webServer: overrides.webServer ?? makeFakeWebServer() })
  const pipelineOptions = overrides.pipelineOptions ?? {}
  const runtime = createHostRuntime({
    ctx,
    config: makeConfig(pipelineOptions),
    credential: CREDENTIAL,
    fetchImpl: overrides.fetchImpl,
  })
  return { ctx, runtime, webServer: ctx.webServer }
}

/** Run one complete text block through the assistant-stream listeners. */
function emitParagraph(ctx, text, { sessionId = SESSION } = {}) {
  ctx.emit('agent/assistant-stream', startPayload({ sessionId }))
  ctx.emit('agent/assistant-stream', blockStartPayload({ sessionId }))
  ctx.emit('agent/assistant-stream', textDeltaPayload(text, { sessionId }))
  ctx.emit('agent/assistant-stream', blockEndPayload(text, { sessionId }))
  ctx.emit('agent/assistant-stream', endPayload({ committed: true, sessionId }))
}

test('start registers every listener and route, stop removes them', async () => {
  const { ctx, runtime, webServer } = makeRuntime()
  runtime.start()
  assert.equal(ctx.listenerCount('agent/assistant-stream'), 1)
  assert.equal(ctx.listenerCount('agent/inbox/claimed'), 1)
  assert.equal(ctx.listenerCount('agent/status'), 1)
  assert.equal(ctx.listenerCount('agent/disposed'), 1)
  assert.equal(ctx.listenerCount('session/disposed'), 1)
  assert.deepEqual(
    [...webServer.routes.keys()].sort(),
    [ROUTE_STATE, ROUTE_UNITS, ROUTE_DIAG, ROUTE_TOGGLE, ROUTE_PROMPTS, ROUTE_PROVIDER, ROUTE_KEY, ROUTE_CHECK, ROUTE_THINK, ROUTE_THRESHOLDS].sort(),
  )
  await runtime.stop()
  assert.equal(ctx.listenerCount('agent/assistant-stream'), 0)
  assert.equal(webServer.routes.size, 0)
  runtime.stop() // idempotent
})

test('E2E: stream 閳?verdict 閳?state/units/diag routes', async () => {
  const fetchImpl = makeFakeFetch(async () => okResponse(answerPayload(ALL_MEDIUM)))
  const { ctx, runtime, webServer } = makeRuntime({ fetchImpl })
  runtime.start()
  emitParagraph(ctx, 'The answer is 42.\n\n')
  await waitFor(() => runtime.store.size === 1, { label: 'verdict stored' })

  const state = await callRoute(webServer, { path: ROUTE_STATE })
  assert.equal(state.json.ok, true)
  assert.equal(state.json.enabled, true)
  assert.deepEqual(state.json.counts, { critical: 0, medium: 1, low: 0 })
  assert.equal(state.json.model, 'jev-1.13.0')
  assert.equal(state.json.provider, 'jev')
  assert.deepEqual(state.json.thresholds, THRESHOLDS)
  assert.deepEqual(state.json.capabilities, { highlightApi: true })

  const units = await callRoute(webServer, { path: ROUTE_UNITS, url: `${ROUTE_UNITS}?since=0` })
  assert.equal(units.json.ok, true)
  assert.equal(units.json.units.length, 1)
  assert.equal(units.json.units[0].text, 'The answer is 42.')
  assert.equal(units.json.units[0].level, 'medium')
  assert.equal(units.json.seq, 1)

  const diag = await callRoute(webServer, { path: ROUTE_DIAG })
  assert.equal(diag.json.ok, true)
  assert.equal(diag.json.active, true)
  assert.equal(diag.json.requests, 1)
  assert.equal(diag.json.unitsJudged, 1)
  assert.equal(diag.json.maxConcurrentObserved, 1)
  assert.ok(diag.json.maxRequestTokensObserved > 0)
  assert.ok(diag.json.maxRequestTokensObserved <= diag.json.requestBudget)
  assert.equal(diag.json.keySource, 'config')
  assert.equal(diag.json.provider, 'jev')
  assert.equal(diag.json.keyConfigured, true)
  assert.equal(diag.json.baseUrl, 'https://api.example.test/v1/systemone')
  assert.equal(diag.json.questionSetVersion, 'jev-highlight/questions/v2')
  await runtime.stop()
})

test('claimed user message is injected as [question] into the Jev state', async () => {
  const fetchImpl = makeFakeFetch(async () => okResponse(answerPayload(ALL_MEDIUM)))
  const { ctx, runtime } = makeRuntime({ fetchImpl })
  runtime.start()
  ctx.emit('agent/inbox/claimed', {
    agent: { id: SESSION },
    message: { role: 'user', content: [{ type: 'text', text: 'What is the answer?' }] },
    turn: 1,
  })
  emitParagraph(ctx, 'The answer is 42.\n\n')
  await waitFor(() => runtime.store.size === 1, { label: 'verdict stored' })
  const verdict = runtime.store.query({ since: 0, limit: 10 }).units[0]
  assert.equal(verdict.context.question, 'What is the answer?')
  const body = requestBody(fetchImpl.calls[0])
  assert.ok(body.state.includes('[question] What is the answer?'), body.state)
  await runtime.stop()
})

test('GET /prompts returns the live prompt design', async () => {
  const { runtime, webServer } = makeRuntime()
  runtime.start()
  const response = await callRoute(webServer, { path: ROUTE_PROMPTS })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.questionSetVersion, 'jev-highlight/questions/v2')
  assert.equal(response.json.questions.is_core_answer.type, 'noul')
  assert.ok(response.json.stateTemplate.includes('[passage]'))
  assert.ok(response.json.stateTemplate.includes('[question]'))
  assert.deepEqual(response.json.weights, { coreAnswer: 0.5, actionable: 0.3, warningOrDefinition: 0.2 })
  assert.equal(response.body.includes('test-key'), false)
  await runtime.stop()
})

test('POST /toggle disables judging immediately', async () => {
  const fetchImpl = makeFakeFetch(async () => okResponse(answerPayload(ALL_MEDIUM)))
  const { ctx, runtime, webServer } = makeRuntime({ fetchImpl })
  runtime.start()
  const toggled = await callRoute(webServer, {
    method: 'POST',
    path: ROUTE_TOGGLE,
    headers: { 'content-type': 'application/json' },
    body: { enabled: false },
  })
  assert.equal(toggled.json.ok, true)
  assert.equal(toggled.json.state.enabled, false)
  assert.equal(runtime.pipeline.isEnabled, false)

  emitParagraph(ctx, 'Should be dropped.\n\n')
  await waitFor(() => runtime.diag().unitsSeen === 1)
  assert.equal(runtime.diag().unitsJudged, 0)
  assert.equal(runtime.diag().droppedUnits, 1)
  assert.equal(fetchImpl.calls.length, 0)
  await runtime.stop()
})

test('unload aborts in-flight Jev requests and removes listeners/routes', async () => {
  const fetchImpl = makeFakeFetch(
    (call) =>
      new Promise((_resolve, reject) => {
        call.init.signal.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          },
          { once: true },
        )
      }),
  )
  const { ctx, runtime, webServer } = makeRuntime({ fetchImpl })
  runtime.start()
  emitParagraph(ctx, 'Pending paragraph.\n\n')
  await waitFor(() => fetchImpl.calls.length === 1, { label: 'request started' })
  assert.equal(fetchImpl.calls[0].init.signal.aborted, false)
  await runtime.stop()
  assert.equal(fetchImpl.calls[0].init.signal.aborted, true)
  assert.equal(runtime.pipeline.isActive, false)
  assert.ok(runtime.diag().abortedRequests >= 1)
  assert.equal(ctx.listenerCount('agent/assistant-stream'), 0)
  assert.equal(webServer.routes.size, 0)
})

test('session/disposed aborts that session in-flight request', async () => {
  const fetchImpl = makeFakeFetch(
    (call) =>
      new Promise((_resolve, reject) => {
        call.init.signal.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          },
          { once: true },
        )
      }),
  )
  const { ctx, runtime } = makeRuntime({ fetchImpl })
  runtime.start()
  emitParagraph(ctx, 'Pending paragraph.\n\n')
  await waitFor(() => fetchImpl.calls.length === 1)
  ctx.emit('session/disposed', { id: SESSION })
  await waitFor(() => fetchImpl.calls[0].init.signal.aborted)
  await waitFor(() => runtime.diag().droppedUnits >= 1)
  await runtime.stop()
})

test('StartLux provider: request envelope targets Bamboo /v1/decisions', async () => {
  const fetchImpl = makeFakeFetch(async () => okResponse(answerPayload(ALL_MEDIUM)))
  const { ctx, runtime } = makeRuntime({ fetchImpl, pipelineOptions: { provider: 'startlux' } })
  runtime.start()
  emitParagraph(ctx, 'The answer is 42.\n\n')
  await waitFor(() => runtime.store.size === 1, { label: 'verdict stored' })
  assert.equal(runtime.client.endpoint, 'https://api.bamboonode.dev/v1/decisions')
  assert.equal(fetchImpl.calls[0].url, 'https://api.bamboonode.dev/v1/decisions')
  const body = requestBody(fetchImpl.calls[0])
  assert.equal(body.model, 'startlux-decision-27b-autothink')
  assert.equal(body.think_mode, 'never')
  assert.equal(body.questions.is_core_answer.type, 'noul')
  await runtime.stop()
})

test('StartLux settings: provider status, save/clear key, check endpoint', async () => {
  const savedEnv = { STARTLUX_API_KEY: process.env.STARTLUX_API_KEY, BAMBOO_API_KEY: process.env.BAMBOO_API_KEY, DSH_HOME: process.env.DSH_HOME }
  const emptyHome = mkdtempSync(join(tmpdir(), 'jev-startlux-'))
  delete process.env.STARTLUX_API_KEY
  delete process.env.BAMBOO_API_KEY
  process.env.DSH_HOME = emptyHome
  const fetchImpl = makeFakeFetch(async () => okResponse(answerPayload(ALL_MEDIUM)))
  try {
    const webServer = makeFakeWebServer()
    const ctx = makeFakeCtx({ webServer })
    const keyFile = join(emptyHome, 'startlux.key')
    const runtime = createHostRuntime({
      ctx,
      config: makeConfig({ provider: 'startlux', startluxKeyFile: keyFile }),
      credential: { key: '', source: 'missing' },
      credentialMissing: true,
      credentialNotice: 'missing startlux key',
      fetchImpl,
    })
    runtime.start()
    const initial = await callRoute(webServer, { path: ROUTE_PROVIDER })
    assert.equal(initial.json.ok, true)
    assert.equal(initial.json.provider.provider, 'startlux')
    assert.equal(initial.json.provider.keyConfigured, false)
    assert.equal(initial.json.provider.keyFile, keyFile)

    const saved = await callRoute(webServer, {
      method: 'POST',
      path: ROUTE_KEY,
      headers: { 'content-type': 'application/json' },
      body: { action: 'save', key: 'bk-12345678' },
    })
    assert.equal(saved.json.ok, true)
    assert.equal(saved.json.provider.keyConfigured, true)
    assert.equal(existsSync(keyFile), true)
    assert.equal(JSON.stringify(saved.json).includes('bk-12345678'), false)
    assert.equal(runtime.state().enabled, true)
    assert.equal(runtime.state().keyConfigured, true)

    const checked = await callRoute(webServer, {
      method: 'POST',
      path: ROUTE_CHECK,
      headers: { 'content-type': 'application/json' },
      body: {},
    })
    assert.equal(checked.json.ok, true)
    assert.equal(checked.json.provider, 'startlux')
    assert.equal(typeof checked.json.latencyMs, 'number')

    const cleared = await callRoute(webServer, {
      method: 'POST',
      path: ROUTE_KEY,
      headers: { 'content-type': 'application/json' },
      body: { action: 'clear' },
    })
    assert.equal(cleared.json.ok, true)
    assert.equal(cleared.json.provider.keyConfigured, false)
    assert.equal(existsSync(keyFile), false)
    assert.equal(runtime.state().keyConfigured, false)
    await runtime.stop()
  } finally {
    if (savedEnv.STARTLUX_API_KEY === undefined) delete process.env.STARTLUX_API_KEY
    else process.env.STARTLUX_API_KEY = savedEnv.STARTLUX_API_KEY
    if (savedEnv.BAMBOO_API_KEY === undefined) delete process.env.BAMBOO_API_KEY
    else process.env.BAMBOO_API_KEY = savedEnv.BAMBOO_API_KEY
    if (savedEnv.DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedEnv.DSH_HOME
  }
})

test('POST /think persists the StartLux think mode and applies it to requests', async () => {
  const savedEnv = { STARTLUX_API_KEY: process.env.STARTLUX_API_KEY, BAMBOO_API_KEY: process.env.BAMBOO_API_KEY, DSH_HOME: process.env.DSH_HOME }
  const emptyHome = mkdtempSync(join(tmpdir(), 'jev-think-'))
  delete process.env.STARTLUX_API_KEY
  delete process.env.BAMBOO_API_KEY
  process.env.DSH_HOME = emptyHome
  const fetchImpl = makeFakeFetch(async () => okResponse(answerPayload(ALL_MEDIUM)))
  try {
    const webServer = makeFakeWebServer()
    const ctx = makeFakeCtx({ webServer })
    const runtime = createHostRuntime({
      ctx,
      config: makeConfig({ provider: 'startlux', startluxKeyFile: join(emptyHome, 'key') }),
      credential: { key: 'bk-test-key', source: 'config' },
      fetchImpl,
    })
    runtime.start()
    assert.equal(runtime.providerStatus().thinkMode, 'never')

    const switched = await callRoute(webServer, {
      method: 'POST',
      path: ROUTE_THINK,
      headers: { 'content-type': 'application/json' },
      body: { mode: 'auto' },
    })
    assert.equal(switched.json.ok, true)
    assert.equal(switched.json.mode, 'auto')
    assert.equal(runtime.providerStatus().thinkMode, 'auto')
    const thinkFile = join(emptyHome, 'jev-highlight-think-mode')
    assert.equal(existsSync(thinkFile), true)
    assert.equal(readFileSync(thinkFile, 'utf8').trim(), 'auto')

    emitParagraph(ctx, 'Auto mode paragraph.\n\n')
    await waitFor(() => fetchImpl.calls.length >= 1, { label: 'auto-mode request' })
    assert.equal(requestBody(fetchImpl.calls[0]).think_mode, 'auto')

    const fallback = await callRoute(webServer, {
      method: 'POST',
      path: ROUTE_THINK,
      headers: { 'content-type': 'application/json' },
      body: { mode: 'default' },
    })
    assert.equal(fallback.json.ok, true)
    assert.equal(fallback.json.mode, 'never')
    assert.equal(existsSync(thinkFile), false)

    emitParagraph(ctx, 'Default mode paragraph.\n\n')
    await waitFor(() => fetchImpl.calls.length >= 2, { label: 'default-mode request' })
    assert.equal(requestBody(fetchImpl.calls[1]).think_mode, 'never')
    await runtime.stop()
  } finally {
    if (savedEnv.STARTLUX_API_KEY === undefined) delete process.env.STARTLUX_API_KEY
    else process.env.STARTLUX_API_KEY = savedEnv.STARTLUX_API_KEY
    if (savedEnv.BAMBOO_API_KEY === undefined) delete process.env.BAMBOO_API_KEY
    else process.env.BAMBOO_API_KEY = savedEnv.BAMBOO_API_KEY
    if (savedEnv.DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedEnv.DSH_HOME
  }
})

test('POST /thresholds persists and re-levels existing verdicts', async () => {
  const savedHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'jev-thresholds-'))
  process.env.DSH_HOME = home
  const fetchImpl = makeFakeFetch(async () => okResponse(answerPayload(ALL_MEDIUM)))
  try {
    const webServer = makeFakeWebServer()
    const ctx = makeFakeCtx({ webServer })
    const runtime = createHostRuntime({
      ctx,
      config: makeConfig({ provider: 'startlux', startluxKeyFile: join(home, 'key') }),
      credential: CREDENTIAL,
      fetchImpl,
    })
    runtime.start()
    emitParagraph(ctx, 'The answer is 42.\n\n')
    await waitFor(() => runtime.store.size === 1, { label: 'verdict stored' })
    // ALL_MEDIUM priority = .8 -> medium under the legacy .85/.65/.45 defaults.
    assert.equal(runtime.store.query({ since: 0, limit: 10 }).units[0].level, 'medium')

    const saved = await callRoute(webServer, {
      method: 'POST',
      path: ROUTE_THRESHOLDS,
      headers: { 'content-type': 'application/json' },
      body: { critical: 0.52, medium: 0.37, low: 0.24 },
    })
    assert.equal(saved.json.ok, true)
    assert.deepEqual(saved.json.thresholds, { critical: 0.52, medium: 0.37, low: 0.24 })
    assert.equal(saved.json.source, 'settings')
    assert.equal(existsSync(join(home, 'jev-highlight-thresholds.json')), true)
    assert.equal(runtime.store.query({ since: 0, limit: 10 }).units[0].level, 'critical')
    assert.deepEqual(runtime.state().thresholds, { critical: 0.52, medium: 0.37, low: 0.24 })
    assert.deepEqual(runtime.state().counts, { critical: 1, medium: 0, low: 0 })

    const invalid = await callRoute(webServer, {
      method: 'POST',
      path: ROUTE_THRESHOLDS,
      headers: { 'content-type': 'application/json' },
      body: { critical: 0.3, medium: 0.5, low: 0.2 },
    })
    assert.equal(invalid.json.ok, false)
    assert.match(String(invalid.json.error), /greater than or equal/u)

    const reset = await callRoute(webServer, {
      method: 'POST',
      path: ROUTE_THRESHOLDS,
      headers: { 'content-type': 'application/json' },
      body: { action: 'reset' },
    })
    assert.equal(reset.json.ok, true)
    assert.equal(reset.json.source, 'config')
    assert.equal(existsSync(join(home, 'jev-highlight-thresholds.json')), false)
    assert.equal(runtime.store.query({ since: 0, limit: 10 }).units[0].level, 'medium')
    await runtime.stop()
  } finally {
    process.env.DSH_HOME = savedHome
  }
})

test('startup honors a persisted Settings think mode over config', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jev-think-startup-'))
  writeFileSync(join(home, 'jev-highlight-think-mode'), 'auto\n', 'utf8')
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = makeFakeCtx({ webServer: makeFakeWebServer() })
    const runtime = createHostRuntime({
      ctx,
      config: makeConfig({ provider: 'startlux', startluxThinkMode: 'never' }),
      credential: CREDENTIAL,
    })
    // The Settings override wins over the config default (and survives the
    // test suite's own DSH_HOME isolation because this test overrides it).
    assert.equal(runtime.providerStatus().thinkMode, 'auto')
    await runtime.stop()
  } finally {
    process.env.DSH_HOME = savedHome
  }
})

test('missing StartLux key (default provider) loads degraded with Settings guidance', async () => {
  const savedEnv = { STARTLUX_API_KEY: process.env.STARTLUX_API_KEY, BAMBOO_API_KEY: process.env.BAMBOO_API_KEY, DSH_HOME: process.env.DSH_HOME }
  const emptyHome = mkdtempSync(join(tmpdir(), 'jev-startlux-missing-'))
  delete process.env.STARTLUX_API_KEY
  delete process.env.BAMBOO_API_KEY
  process.env.DSH_HOME = emptyHome
  try {
    const webServer = makeFakeWebServer()
    const ctx = makeFakeCtx({ webServer })
    let error
    try {
      apply(ctx, {})
    } catch (caught) {
      error = caught
    }
    assert.equal(error, undefined)
    assert.equal(webServer.routes.size, 10)
    const state = await callRoute(webServer, { path: ROUTE_STATE })
    assert.equal(state.json.provider, 'startlux')
    assert.equal(state.json.keyConfigured, false)
    assert.match(state.json.notice, /StartLux API key/u)
    assert.match(state.json.notice, /jev-highlight-startlux\.key/u)

    const strictCtx = makeFakeCtx({ webServer: makeFakeWebServer() })
    let strictError
    try {
      apply(strictCtx, { requireApiKey: true })
    } catch (caught) {
      strictError = caught
    }
    assert.ok(strictError instanceof MissingStartLuxApiKeyError)
    ctx.disposeEffects()
  } finally {
    if (savedEnv.STARTLUX_API_KEY === undefined) delete process.env.STARTLUX_API_KEY
    else process.env.STARTLUX_API_KEY = savedEnv.STARTLUX_API_KEY
    if (savedEnv.BAMBOO_API_KEY === undefined) delete process.env.BAMBOO_API_KEY
    else process.env.BAMBOO_API_KEY = savedEnv.BAMBOO_API_KEY
    if (savedEnv.DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedEnv.DSH_HOME
  }
})

test('missing key (default): loads in degraded mode and reports the actionable error', async () => {
  const savedEnv = {
    JEV_API_KEY: process.env.JEV_API_KEY,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    DSH_HOME: process.env.DSH_HOME,
  }
  const emptyHome = mkdtempSync(join(tmpdir(), 'jev-apply-'))
  delete process.env.JEV_API_KEY
  delete process.env.TYPESAFE_API_KEY
  process.env.DSH_HOME = emptyHome
  try {
    const webServer = makeFakeWebServer()
    const ctx = makeFakeCtx({ webServer })
    let error
    try {
      apply(ctx, { provider: 'jev' })
    } catch (caught) {
      error = caught
    }
    // Degraded mode: no throw, listeners and routes stay registered.
    assert.equal(error, undefined)
    assert.equal(ctx.listenerCount('agent/assistant-stream'), 1)
    assert.equal(webServer.routes.size, 10)
    const response = await callRoute(webServer, { path: ROUTE_STATE })
    assert.equal(response.status, 200)
    assert.equal(response.json.keyConfigured, false)
    assert.equal(response.json.enabled, false)
    assert.match(response.json.notice, /\.credentials\.yaml/u)
    assert.ok(response.json.notice.includes(join(emptyHome, '.credentials.yaml')))
    assert.match(response.json.notice, /JEV_API_KEY/u)
    ctx.disposeEffects()
  } finally {
    if (savedEnv.JEV_API_KEY === undefined) delete process.env.JEV_API_KEY
    else process.env.JEV_API_KEY = savedEnv.JEV_API_KEY
    if (savedEnv.TYPESAFE_API_KEY === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = savedEnv.TYPESAFE_API_KEY
    if (savedEnv.DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedEnv.DSH_HOME
  }
})

test('requireApiKey: true keeps the strict fail-loud activation path', () => {
  const savedEnv = {
    JEV_API_KEY: process.env.JEV_API_KEY,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    DSH_HOME: process.env.DSH_HOME,
  }
  const emptyHome = mkdtempSync(join(tmpdir(), 'jev-apply-strict-'))
  delete process.env.JEV_API_KEY
  delete process.env.TYPESAFE_API_KEY
  process.env.DSH_HOME = emptyHome
  try {
    const ctx = makeFakeCtx({ webServer: makeFakeWebServer() })
    let error
    try {
      apply(ctx, { provider: 'jev', requireApiKey: true })
    } catch (caught) {
      error = caught
    }
    assert.ok(error instanceof MissingJevApiKeyError)
    assert.match(error.message, /\.credentials\.yaml/u)
    assert.ok(error.message.includes(join(emptyHome, '.credentials.yaml')))
    assert.match(error.message, /JEV_API_KEY/u)
    assert.equal(ctx.listenerCount('agent/assistant-stream'), 0)
  } finally {
    if (savedEnv.JEV_API_KEY === undefined) delete process.env.JEV_API_KEY
    else process.env.JEV_API_KEY = savedEnv.JEV_API_KEY
    if (savedEnv.TYPESAFE_API_KEY === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = savedEnv.TYPESAFE_API_KEY
    if (savedEnv.DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedEnv.DSH_HOME
  }
})

test('apply with a configured key activates and cleans up with the context effect', async () => {
  const webServer = makeFakeWebServer()
  const ctx = makeFakeCtx({ webServer })
  apply(ctx, { provider: 'jev', jevApiKey: 'test-key', jevBaseUrl: 'https://api.example.test' })
  assert.equal(ctx.listenerCount('agent/assistant-stream'), 1)
  assert.equal(webServer.routes.size, 10)
  ctx.disposeEffects()
  await waitFor(() => webServer.routes.size === 0 && ctx.listenerCount('agent/assistant-stream') === 0)
})
