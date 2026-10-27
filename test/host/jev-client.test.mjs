/**
 * Jev client: parsing tolerance, budget planning, cache, concurrency, retries,
 * timeout and abort behaviour — all against an injected fake fetch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  JevAbortError,
  JevBudgetError,
  JevClient,
  JevHttpError,
  JevTimeoutError,
  LruVerdictCache,
  NOUL_QUESTIONS,
  buildStateText,
  checkRequestBudget,
  combineScoresMax,
  estimateRequestTokens,
  estimateTokens,
  parseSystemOneScores,
  parseSystemOneScoresDetailed,
  planUnitRequests,
} from '../../lib/index.js'
import { answerPayload, makeFakeFetch, okResponse, requestBody, statusResponse, waitFor } from './helpers.mjs'

const zeroScores = { is_core_answer: 0, is_actionable: 0, is_warning: 0, is_definition: 0 }

function makeUnit(text, overrides = {}) {
  return {
    id: `u-${Math.random().toString(36).slice(2)}`,
    sessionId: 's1',
    attemptId: 'a1',
    blockIndex: 0,
    type: 'paragraph',
    text,
    context: {},
    ...overrides,
  }
}

function makeClient(overrides = {}) {
  return new JevClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.example.test',
    fetchImpl: makeFakeFetch(async () => okResponse(answerPayload(zeroScores))),
    timeoutMs: 5000,
    retryBaseMs: 1,
    ...overrides,
  })
}

test('the question set is the four noul questions with single-factor wording', () => {
  assert.deepEqual(
    NOUL_QUESTIONS.map((question) => question.id),
    ['is_core_answer', 'is_actionable', 'is_warning', 'is_definition'],
  )
  for (const question of NOUL_QUESTIONS) {
    assert.ok(question.instructions.length > 10)
    assert.ok(!question.instructions.includes(' and '), 'questions must stay single-factor')
  }
})

test('buildStateText keeps the verbatim unit text with grounding context', () => {
  const unit = { text: 'The answer is 42.', context: { heading: 'Answer', before: 'Question?' } }
  const state = buildStateText(unit)
  assert.ok(state.includes('[section] Answer'))
  assert.ok(state.includes('[preceding line] Question?'))
  assert.ok(state.includes('[passage]'))
  assert.ok(state.includes('The answer is 42.'))
  assert.equal(buildStateText({ text: 'x', context: {} }), '[passage]\nx')
})

test('buildStateText injects the current user request as [question]', () => {
  assert.equal(
    buildStateText({ text: 'x', context: { question: 'What is X?' } }),
    '[question] What is X?\n[passage]\nx',
  )
  const full = buildStateText({
    text: 'The answer is 42.',
    context: { heading: 'Answer', before: 'Question?', question: 'What is the answer?' },
  })
  assert.equal(
    full,
    '[section] Answer\n[preceding line] Question?\n[question] What is the answer?\n[passage]\nThe answer is 42.',
  )
})

test('parseSystemOneScores reads the documented noul answer shape', () => {
  const response = { answers: { is_core_answer: { type: 'noul', noul: 0.91 }, is_actionable: { type: 'noul', noul: 0.4 } } }
  const scores = parseSystemOneScores(response)
  assert.equal(scores.is_core_answer, 0.91)
  assert.equal(scores.is_actionable, 0.4)
  assert.equal(scores.is_warning, 0)
  assert.equal(scores.is_definition, 0)
})

test('parseSystemOneScores tolerates probability/p_yes/nested/array variants', () => {
  assert.equal(parseSystemOneScores({ answers: { is_core_answer: { probability: 0.7 } } }).is_core_answer, 0.7)
  assert.equal(parseSystemOneScores({ answers: { is_core_answer: { p_yes: 0.6 } } }).is_core_answer, 0.6)
  assert.equal(parseSystemOneScores({ answers: { is_core_answer: { answer: { noul: 0.55 } } } }).is_core_answer, 0.55)
  assert.equal(parseSystemOneScores({ answers: [{ id: 'is_core_answer', noul: 0.33 }] }).is_core_answer, 0.33)
  assert.equal(parseSystemOneScores({ is_core_answer: 0.44 }).is_core_answer, 0.44)
  assert.equal(parseSystemOneScores({ answers: { is_core_answer: { noul: 2 } } }).is_core_answer, 1)
  assert.equal(parseSystemOneScores({ answers: { is_core_answer: { noul: -1 } } }).is_core_answer, 0)
  assert.deepEqual(parseSystemOneScores({}), zeroScores)
  assert.deepEqual(parseSystemOneScores(null), zeroScores)
})

test('combineScoresMax takes per-question maxima', () => {
  const combined = combineScoresMax([
    { is_core_answer: 0.1, is_actionable: 0.9, is_warning: 0, is_definition: 0.2 },
    { is_core_answer: 0.8, is_actionable: 0.2, is_warning: 0.6, is_definition: 0 },
  ])
  assert.deepEqual(combined, { is_core_answer: 0.8, is_actionable: 0.9, is_warning: 0.6, is_definition: 0.2 })
  assert.deepEqual(combineScoresMax([]), zeroScores)
})

test('planUnitRequests keeps a small unit as one request with context', () => {
  const unit = makeUnit('Short body.', { context: { heading: 'H', before: 'B' } })
  const plans = planUnitRequests(unit, { requestTokenBudget: 24000, unitTokenBudget: 20000 })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].text, 'Short body.')
  assert.ok(plans[0].state.includes('Short body.'))
  assert.ok(plans[0].state.includes('[section] H'))
  assert.equal(plans[0].estimatedTokens, estimateRequestTokens(plans[0].state, NOUL_QUESTIONS.map((question) => question.instructions)))
})

test('planUnitRequests splits an oversized unit so every request fits the budget', () => {
  const unit = makeUnit('汉'.repeat(2000))
  const requestTokenBudget = 800
  const plans = planUnitRequests(unit, { requestTokenBudget, unitTokenBudget: 300 })
  assert.ok(plans.length > 1)
  for (const plan of plans) {
    const check = checkRequestBudget(plan.state, NOUL_QUESTIONS.map((question) => question.instructions), requestTokenBudget)
    assert.equal(check.withinRequestBudget, true, `estimate ${check.estimatedTokens} over budget`)
    assert.equal(check.withinHardStateQuestionLimit, true)
    assert.equal(check.withinHardTotalLimit, true)
    assert.ok(plan.estimatedTokens <= requestTokenBudget)
  }
  const joined = plans.map((plan) => plan.text).join('')
  assert.equal(joined.length, 2000)
})

test('planUnitRequests respects the provider hard caps even with a large config budget', () => {
  const unit = makeUnit('汉'.repeat(33000))
  const plans = planUnitRequests(unit, { requestTokenBudget: 60000, unitTokenBudget: 20000 })
  assert.ok(plans.length >= 2)
  for (const plan of plans) {
    const check = checkRequestBudget(plan.state, NOUL_QUESTIONS.map((question) => question.instructions), 60000)
    assert.equal(check.withinHardStateQuestionLimit, true)
    assert.equal(check.withinHardTotalLimit, true)
  }
})

test('planUnitRequests refuses to plan a request that cannot fit', () => {
  const impossibleQuestion = [{ id: 'is_core_answer', instructions: '汉'.repeat(20000) }]
  const unit = makeUnit('body')
  assert.throws(
    () => planUnitRequests(unit, { requestTokenBudget: 1000, unitTokenBudget: 500, questions: impossibleQuestion }),
    JevBudgetError,
  )
})

test('planUnitRequests guards against runaway sub-chunk counts', () => {
  const unit = makeUnit('汉'.repeat(100000))
  assert.throws(
    () => planUnitRequests(unit, { requestTokenBudget: 60000, unitTokenBudget: 24 }),
    JevBudgetError,
  )
})

test('systemOne posts the documented request shape and parses the JSON body', async () => {
  const fetchImpl = makeFakeFetch(async () => okResponse(answerPayload({ is_core_answer: 0.77 })))
  const client = makeClient({ fetchImpl })
  const response = await client.systemOne({ state: 'The unit.' })
  assert.equal(fetchImpl.calls.length, 1)
  const call = fetchImpl.calls[0]
  assert.equal(call.url, 'https://api.example.test/v1/systemone')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.authorization, 'Bearer test-key')
  assert.equal(call.init.headers['content-type'], 'application/json')
  const body = requestBody(call)
  assert.equal(body.model, 'jev-1.13.0')
  assert.equal(body.state, 'The unit.')
  assert.deepEqual(Object.keys(body.questions).sort(), ['is_actionable', 'is_core_answer', 'is_definition', 'is_warning'])
  for (const question of Object.values(body.questions)) {
    assert.equal(question.type, 'noul')
    assert.equal(typeof question.instructions, 'string')
  }
  assert.equal(parseSystemOneScores(response).is_core_answer, 0.77)
})

test('systemOne refuses to send a request over the budget', async () => {
  const fetchImpl = makeFakeFetch(async () => okResponse(answerPayload(zeroScores)))
  const client = makeClient({ fetchImpl, requestTokenBudget: 1000 })
  await assert.rejects(client.systemOne({ state: '汉'.repeat(5000) }), JevBudgetError)
  assert.equal(fetchImpl.calls.length, 0)
})

test('judgeUnit caches identical content and avoids a second request', async () => {
  const fetchImpl = makeFakeFetch(async () => okResponse(answerPayload({ is_core_answer: 0.8 })))
  const client = makeClient({ fetchImpl })
  const unit = makeUnit('Cached body.')
  const first = await client.judgeUnit(unit)
  const second = await client.judgeUnit({ ...unit })
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(client.stats().cacheHits, 1)
  assert.equal(second.scores.is_core_answer, 0.8)
  assert.equal(second.priority, 0.4)
})

test('judgeUnit sub-chunks take the per-question max', async () => {
  const unit = makeUnit('汉'.repeat(1200))
  let callIndex = 0
  const fetchImpl = makeFakeFetch(async () => {
    callIndex += 1
    return okResponse(answerPayload(callIndex === 1 ? { is_warning: 0.15 } : { is_warning: 0.9 }))
  })
  const client = makeClient({ fetchImpl, requestTokenBudget: 800, unitTokenBudget: 300 })
  const result = await client.judgeUnit(unit)
  assert.ok(result.requestCount > 1)
  assert.equal(result.scores.is_warning, 0.9)
})

test('every request in an oversized judgement stays within the budget', async () => {
  const requestTokenBudget = 900
  const fetchImpl = makeFakeFetch(async () => okResponse(answerPayload(zeroScores)))
  const client = makeClient({ fetchImpl, requestTokenBudget, unitTokenBudget: 400 })
  await client.judgeUnit(makeUnit('汉'.repeat(3000)))
  assert.ok(fetchImpl.calls.length > 1)
  const questionTexts = NOUL_QUESTIONS.map((question) => question.instructions)
  for (const call of fetchImpl.calls) {
    const body = requestBody(call)
    const check = checkRequestBudget(body.state, questionTexts, requestTokenBudget)
    assert.equal(check.withinRequestBudget, true)
    assert.ok(check.estimatedTokens <= requestTokenBudget)
  }
  assert.ok(client.stats().maxRequestTokensObserved <= requestTokenBudget)
})

test('concurrency never exceeds maxConcurrency and maxConcurrentObserved reports it', async () => {
  let active = 0
  let maxActive = 0
  let releaseGate
  const gate = new Promise((resolve) => {
    releaseGate = resolve
  })
  const fetchImpl = makeFakeFetch(async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    try {
      await gate
    } finally {
      active -= 1
    }
    return okResponse(answerPayload(zeroScores))
  })
  const client = makeClient({ fetchImpl, maxConcurrency: 3 })
  const units = Array.from({ length: 8 }, (_, index) => makeUnit(`distinct unit ${index}`))
  const results = Promise.all(units.map((unit) => client.judgeUnit(unit)))
  await waitFor(() => fetchImpl.calls.length >= 3, { label: 'three in-flight requests' })
  assert.equal(fetchImpl.calls.length, 3)
  assert.equal(client.stats().inFlight, 3)
  releaseGate()
  await results
  assert.equal(maxActive, 3)
  assert.equal(client.stats().maxConcurrentObserved, 3)
  assert.equal(client.stats().inFlight, 0)
})

test('aborting an in-flight judgement rejects, empties inFlight and counts the abort', async () => {
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
  const client = makeClient({ fetchImpl, timeoutMs: 60000 })
  const controller = new AbortController()
  const judging = client.judgeUnit(makeUnit('abort me'), { signal: controller.signal })
  await waitFor(() => fetchImpl.calls.length === 1, { label: 'request started' })
  controller.abort()
  await assert.rejects(judging, JevAbortError)
  assert.equal(client.stats().inFlight, 0)
  assert.equal(client.stats().abortedRequests, 1)
})

test('aborting while waiting for a concurrency slot rejects without leaking a slot', async () => {
  let releaseFirst
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const fetchImpl = makeFakeFetch(async (call) => {
    if (call.init.body.includes('first unit')) await firstGate
    return okResponse(answerPayload(zeroScores))
  })
  const client = makeClient({ fetchImpl, maxConcurrency: 1 })
  const first = client.judgeUnit(makeUnit('first unit'))
  await waitFor(() => fetchImpl.calls.length === 1, { label: 'first request started' })
  const controller = new AbortController()
  const second = client.judgeUnit(makeUnit('second unit'), { signal: controller.signal })
  await waitFor(() => client.stats().requests === 1, { label: 'second waits for the slot' })
  controller.abort()
  await assert.rejects(second, JevAbortError)
  assert.equal(client.stats().abortedRequests, 1)
  releaseFirst()
  await first
  assert.equal(client.stats().inFlight, 0)
  const third = await client.judgeUnit(makeUnit('third unit'))
  assert.equal(third.cached, false)
})

test('429 is retried with backoff and then succeeds', async () => {
  let calls = 0
  const fetchImpl = makeFakeFetch(async () => {
    calls += 1
    if (calls === 1) return statusResponse(429, { retryAfter: 0.001 })
    return okResponse(answerPayload({ is_core_answer: 0.5 }))
  })
  const client = makeClient({ fetchImpl })
  const result = await client.judgeUnit(makeUnit('rate limited'))
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(result.scores.is_core_answer, 0.5)
  assert.equal(client.stats().failures, 0)
})

test('5xx retries maxRetries times, then throws JevHttpError', async () => {
  const fetchImpl = makeFakeFetch(async () => statusResponse(503))
  const client = makeClient({ fetchImpl, maxRetries: 2 })
  await assert.rejects(client.judgeUnit(makeUnit('server error')), (error) => error instanceof JevHttpError && error.status === 503)
  assert.equal(fetchImpl.calls.length, 3)
  assert.equal(client.stats().failures, 1)
})

test('4xx is not retried', async () => {
  const fetchImpl = makeFakeFetch(async () => statusResponse(400))
  const client = makeClient({ fetchImpl })
  await assert.rejects(client.judgeUnit(makeUnit('bad request')), (error) => error instanceof JevHttpError && error.status === 400)
  assert.equal(fetchImpl.calls.length, 1)
})

test('a region-blocked 451 surfaces the provider reason for diagnostics', async () => {
  const body = '{"title":"Typesafe is not available in your region.","status":451}'
  const fetchImpl = makeFakeFetch(async () => statusResponse(451, { body }))
  const client = makeClient({ fetchImpl })
  await assert.rejects(
    client.judgeUnit(makeUnit('region blocked')),
    (error) =>
      error instanceof JevHttpError &&
      error.status === 451 &&
      /not available in your region/u.test(error.message),
  )
  assert.equal(fetchImpl.calls.length, 1) // 4xx never retried
  assert.equal(client.stats().failures, 1)
})

test('a request timeout rejects JevTimeoutError and empties inFlight', async () => {
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
  const client = makeClient({ fetchImpl, timeoutMs: 25 })
  await assert.rejects(client.judgeUnit(makeUnit('too slow')), JevTimeoutError)
  assert.equal(client.stats().inFlight, 0)
  assert.equal(client.stats().failures, 1)
})

test('non-JSON responses are retried once, then raise JevParseError', async () => {
  const fetchImpl = makeFakeFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => '<html>not json</html>',
  }))
  const client = makeClient({ fetchImpl })
  await assert.rejects(client.judgeUnit(makeUnit('bad body')), (error) => error.code === 'JEV_PARSE')
  // Contract violation per docs/jev-api.md §10.1: one retry, then skip the unit.
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(client.stats().failures, 1)
  assert.equal(client.stats().requests, 2)
})

test('an empty 200 body is a contract violation, not a silent zero score', async () => {
  const fetchImpl = makeFakeFetch(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '' }))
  const client = makeClient({ fetchImpl })
  await assert.rejects(client.judgeUnit(makeUnit('empty body')), (error) => error.code === 'JEV_PARSE')
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(client.stats().failures, 1)
  assert.equal(client.stats().cacheSize, 0) // nothing cached for a broken judgement
})

test('a response missing any noul answer fails the unit instead of scoring 0', async () => {
  const partial = { model: 'jev-1.13.0', answers: { is_core_answer: { type: 'noul', noul: 0.9 } } }
  const fetchImpl = makeFakeFetch(async () => okResponse(partial))
  const client = makeClient({ fetchImpl })
  await assert.rejects(client.judgeUnit(makeUnit('partial answers')), (error) => error.code === 'JEV_PARSE' && /is_actionable/u.test(error.message))
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(client.stats().failures, 1)
})

test('parseSystemOneScoresDetailed reports missing and non-noul answers', () => {
  const detailed = parseSystemOneScoresDetailed({
    answers: {
      is_core_answer: { type: 'noul', noul: 0.8 },
      is_actionable: { type: 'choice', choice: 'yes' },
    },
  })
  assert.equal(detailed.complete, false)
  assert.deepEqual(detailed.missing.sort(), ['is_actionable', 'is_definition', 'is_warning'])
  assert.equal(detailed.scores.is_core_answer, 0.8)
  assert.equal(parseSystemOneScoresDetailed(answerPayload(zeroScores)).complete, true)
})

test('cache capacity is bounded', async () => {
  const fetchImpl = makeFakeFetch(async () => okResponse(answerPayload(zeroScores)))
  const client = makeClient({ fetchImpl, cache: new LruVerdictCache({ capacity: 2 }) })
  await client.judgeUnit(makeUnit('one'))
  await client.judgeUnit(makeUnit('two'))
  await client.judgeUnit(makeUnit('three'))
  assert.equal(client.stats().cacheSize, 2)
})

test('stats report requests and maxRequestTokensObserved', async () => {
  const fetchImpl = makeFakeFetch(async () => okResponse(answerPayload(zeroScores)))
  const client = makeClient({ fetchImpl })
  await client.judgeUnit(makeUnit('stat body'))
  const stats = client.stats()
  assert.equal(stats.requests, 1)
  assert.ok(stats.maxRequestTokensObserved > 0)
  assert.ok(stats.maxRequestTokensObserved <= 24000)
  assert.ok(estimateTokens('stat body') <= stats.maxRequestTokensObserved)
})
