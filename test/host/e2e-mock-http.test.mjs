/**
 * Host E2E over a real HTTP mock of the TypeSafe Jev endpoint.
 *
 * Unlike the fake-fetch tests this exercises the whole network stack: the real
 * `fetch`, the request envelope, real timeouts/AbortSignals, the concurrency
 * semaphore and the same-origin JSON routes the browser will poll. The live
 * TypeSafe endpoint is region-blocked (HTTP 451) from this machine, so this
 * mock is the only way to prove the host pipeline end to end.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  ROUTE_DIAG,
  ROUTE_STATE,
  ROUTE_UNITS,
  createHostRuntime,
} from '../../lib/index.js'
import {
  SESSION,
  blockEndPayload,
  blockStartPayload,
  callRoute,
  endPayload,
  makeFakeCtx,
  makeFakeWebServer,
  startPayload,
  textDeltaPayload,
  waitFor,
} from './helpers.mjs'

const THRESHOLDS = { critical: 0.85, medium: 0.65, low: 0.45 }
const CREDENTIAL = { key: 'test-key', source: 'config' }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function scoresForState(text) {
  return {
    is_core_answer: /answer|答案|42/u.test(text) ? 0.95 : 0.2,
    is_actionable: /run|step|步骤|执行|delete/iu.test(text) ? 0.8 : 0.1,
    is_warning: /risk|warning|不要|风险|注意/u.test(text) ? 0.92 : 0.05,
    is_definition: /define|means|是指|定义为/u.test(text) ? 0.85 : 0.05,
  }
}

function toAnswers(scores) {
  const answers = {}
  for (const [id, value] of Object.entries(scores)) answers[id] = { type: 'noul', noul: value }
  return answers
}

/**
 * Zero-dependency mock of POST /v1/systemone.
 * Options: delayMs, statusSequence (by request index), holdUntilAbort, scoreField.
 */
async function startMockJev(options = {}) {
  const stats = { requests: 0, concurrent: 0, maxConcurrent: 0, bodies: [], aborted: 0 }
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/systemone') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not found"}')
      return
    }
    stats.requests += 1
    stats.concurrent += 1
    stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent)
    let responded = false
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      stats.concurrent -= 1
    }
    // A response closing before it was written means the client aborted.
    res.on('close', () => {
      if (!responded && !finished) {
        stats.aborted += 1
        finish()
      }
    })
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', async () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = {}
      }
      stats.bodies.push(body)
      if (options.holdUntilAbort === true) {
        // Keep the connection open; the client aborts and the socket closes.
        return
      }
      const status = options.statusSequence?.[stats.requests - 1] ?? 200
      if (status !== 200) {
        responded = true
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ title: 'mock throttled', status }))
        finish()
        return
      }
      if (options.delayMs !== undefined) await delay(options.delayMs)
      responded = true
      const baseScores = {
        is_core_answer: 0,
        is_actionable: 0,
        is_warning: 0,
        is_definition: 0,
        ...(options.scores ?? scoresForState(String(body.state ?? ''))),
      }
      const field = options.scoreField ?? 'noul'
      const answers = {}
      for (const [id, value] of Object.entries(baseScores)) answers[id] = { type: 'noul', [field]: value }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 123 } }))
      finish()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`
  return {
    url,
    stats,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function makeConfig(jevBaseUrl, overrides = {}) {
  return {
    jevApiKey: '',
    jevBaseUrl,
    model: 'jev-1.13.0',
    maxConcurrency: 8,
    requestTokenBudget: 24000,
    unitTokenBudget: 20000,
    cacheCapacity: 500,
    requestTimeoutMs: 5000,
    highlightThresholds: THRESHOLDS,
    autoStart: true,
    debug: false,
    ...overrides,
  }
}

function makeRuntime(mock, overrides = {}) {
  const webServer = makeFakeWebServer()
  const ctx = makeFakeCtx({ webServer })
  const runtime = createHostRuntime({
    ctx,
    config: makeConfig(mock.url, overrides.config),
    credential: CREDENTIAL,
  })
  return { ctx, runtime, webServer }
}

/** Emit one complete text block through the real event listeners. */
function emitBlock(ctx, text, { sessionId = SESSION, attemptId = 'attempt-1', blockIndex = 0 } = {}) {
  ctx.emit('agent/assistant-stream', startPayload({ sessionId, attemptId }))
  ctx.emit('agent/assistant-stream', blockStartPayload({ sessionId, attemptId, index: blockIndex }))
  ctx.emit('agent/assistant-stream', textDeltaPayload(text, { sessionId, attemptId, index: blockIndex }))
  ctx.emit('agent/assistant-stream', blockEndPayload(text, { sessionId, attemptId, index: blockIndex }))
  ctx.emit('agent/assistant-stream', endPayload({ sessionId, attemptId, committed: true }))
}

test('E2E over real HTTP: request envelope, verdict, state/units/diag', async () => {
  const mock = await startMockJev()
  const { ctx, runtime, webServer } = makeRuntime(mock)
  try {
    runtime.start()
    emitBlock(ctx, '风险提示：不要在生产环境执行 delete 操作。\n\n')
    await waitFor(() => runtime.store.size === 1, { label: 'verdict stored' })

    // The mock saw exactly one documented-shape request.
    assert.equal(mock.stats.requests, 1)
    const body = mock.stats.bodies[0]
    assert.equal(body.model, 'jev-1.13.0')
    assert.ok(body.state.includes('风险提示：不要在生产环境执行 delete 操作。'))
    assert.deepEqual(Object.keys(body.questions).sort(), ['is_actionable', 'is_core_answer', 'is_definition', 'is_warning'])
    for (const question of Object.values(body.questions)) {
      assert.equal(question.type, 'noul')
      assert.equal(typeof question.instructions, 'string')
    }

    const verdict = runtime.store.query({}).units[0]
    // mock: warning 0.92 + actionable 0.8 + core 0.2 => 0.1 + 0.24 + 0.184 = 0.524
    assert.equal(verdict.level, 'low')
    assert.ok(verdict.scores.is_warning > 0.9)

    const state = await callRoute(webServer, { path: ROUTE_STATE })
    assert.deepEqual(state.json.counts, { critical: 0, medium: 0, low: 1 })

    const units = await callRoute(webServer, { path: ROUTE_UNITS, url: `${ROUTE_UNITS}?since=0` })
    assert.equal(units.json.units.length, 1)
    assert.equal(units.json.seq, 1)

    const diag = await callRoute(webServer, { path: ROUTE_DIAG })
    assert.equal(diag.json.requests, 1)
    assert.equal(diag.json.inFlight, 0)
    assert.equal(diag.json.unitsJudged, 1)
    assert.equal(diag.json.maxConcurrentObserved, 1)
    assert.ok(diag.json.maxRequestTokensObserved <= diag.json.requestBudget)
    assert.equal(mock.stats.maxConcurrent, 1)
  } finally {
    await runtime.stop()
    await mock.close()
  }
})

test('real HTTP concurrency stays within maxConcurrency', async () => {
  const mock = await startMockJev({ delayMs: 30 })
  const { ctx, runtime } = makeRuntime(mock, { config: { maxConcurrency: 3 } })
  try {
    runtime.start()
    const paragraphs = Array.from({ length: 6 }, (_, index) => `Paragraph ${index} with answer 42.\n\n`).join('')
    emitBlock(ctx, paragraphs)
    await waitFor(() => runtime.store.size === 6, { label: 'six verdicts', timeoutMs: 5000 })
    const diag = runtime.diag()
    assert.equal(diag.requests, 6)
    assert.equal(diag.unitsJudged, 6)
    assert.ok(diag.maxConcurrentObserved <= 3, `maxConcurrentObserved ${diag.maxConcurrentObserved} > 3`)
    assert.ok(mock.stats.maxConcurrent <= 3, `mock saw ${mock.stats.maxConcurrent} concurrent requests`)
    assert.equal(mock.stats.maxConcurrent, 3) // the limit is actually reached
  } finally {
    await runtime.stop()
    await mock.close()
  }
})

test('plugin unload aborts an in-flight real HTTP request', async () => {
  const mock = await startMockJev({ holdUntilAbort: true })
  const { ctx, runtime } = makeRuntime(mock)
  try {
    runtime.start()
    emitBlock(ctx, 'This request will hang.\n\n')
    await waitFor(() => mock.stats.requests === 1, { label: 'mock request received' })
    assert.equal(mock.stats.aborted, 0)
    await runtime.stop()
    await waitFor(() => mock.stats.aborted === 1, { label: 'server saw the abort' })
    const diag = runtime.diag()
    assert.ok(diag.abortedRequests >= 1)
    assert.equal(diag.inFlight, 0)
  } finally {
    await runtime.stop()
    await mock.close()
  }
})

test('429 over real HTTP is retried and then succeeds', async () => {
  const mock = await startMockJev({ statusSequence: [429, 200] })
  const { ctx, runtime } = makeRuntime(mock)
  try {
    runtime.start()
    emitBlock(ctx, 'Rate limited answer 42.\n\n')
    await waitFor(() => runtime.store.size === 1, { label: 'verdict after retry', timeoutMs: 5000 })
    assert.equal(mock.stats.requests, 2)
    assert.equal(runtime.diag().failures, 0)
  } finally {
    await runtime.stop()
    await mock.close()
  }
})

test('replayed content hits the cache and skips the network', async () => {
  const mock = await startMockJev()
  const { ctx, runtime } = makeRuntime(mock)
  try {
    runtime.start()
    const text = 'Replayable answer 42.\n\n'
    // Same content in the same block position of two sessions: the cache key
    // includes the grounding context, which is identical (first unit, no
    // heading, no preceding line), so the second session is served locally.
    emitBlock(ctx, text, { sessionId: 'session-a', attemptId: 'attempt-a' })
    await waitFor(() => runtime.store.size === 1)
    emitBlock(ctx, text, { sessionId: 'session-b', attemptId: 'attempt-b' })
    await waitFor(() => runtime.store.size === 2)
    assert.equal(mock.stats.requests, 1)
    const verdicts = runtime.store.query({}).units
    assert.equal(verdicts[1].cached, true)
    assert.ok(runtime.diag().cacheHits >= 1)
  } finally {
    await runtime.stop()
    await mock.close()
  }
})

test('mock response with probability field is parsed tolerantly', async () => {
  const mock = await startMockJev({ scoreField: 'probability', scores: { is_core_answer: 0.97 } })
  const { ctx, runtime } = makeRuntime(mock)
  try {
    runtime.start()
    emitBlock(ctx, 'The answer is 42.\n\n')
    await waitFor(() => runtime.store.size === 1)
    const verdict = runtime.store.query({}).units[0]
    assert.equal(verdict.scores.is_core_answer, 0.97)
    assert.equal(verdict.level, 'low') // 0.5 * 0.97 = 0.485 => low bucket
  } finally {
    await runtime.stop()
    await mock.close()
  }
})
