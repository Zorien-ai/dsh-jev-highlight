/**
 * Judge pipeline: frame capture, splitting, queue, verdicts and cancellation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { JudgePipeline, VerdictStore } from '../../lib/index.js'
import {
  SESSION,
  blockEndPayload,
  blockStartPayload,
  chunkPayload,
  endPayload,
  makeControlledJudgeClient,
  makeImmediateJudgeClient,
  makeSessionObject,
  startPayload,
  textDeltaPayload,
  waitFor,
} from './helpers.mjs'

const THRESHOLDS = { critical: 0.85, medium: 0.65, low: 0.45 }
const ALL_CORE = { is_core_answer: 1, is_actionable: 1, is_warning: 0, is_definition: 0 }

function makePipeline(overrides = {}) {
  const client = overrides.client ?? makeImmediateJudgeClient(ALL_CORE)
  const store = new VerdictStore(overrides.storeOptions)
  const pipeline = new JudgePipeline({
    client,
    store,
    model: 'jev-1.13.0',
    baseUrl: 'https://api.example.test',
    keySource: 'config',
    thresholds: THRESHOLDS,
    maxConcurrency: 8,
    requestTokenBudget: 24000,
    autoStart: true,
    ...overrides,
  })
  pipeline.start()
  return { pipeline, store, client }
}

function feed(pipeline, payloads) {
  for (const payload of payloads) pipeline.handleAssistantStream(payload)
}

test('a complete stream becomes a stored verdict with weighted priority and level', async () => {
  const { pipeline, store } = makePipeline()
  feed(pipeline, [
    startPayload(),
    blockStartPayload(),
    textDeltaPayload('Hello paragraph.\n\n'),
    blockEndPayload('Hello paragraph.\n\n'),
    endPayload(),
  ])
  await waitFor(() => store.size === 1, { label: 'verdict stored' })
  const verdict = store.query({}).units[0]
  assert.equal(verdict.unitId, 'session-1:attempt-1:0:0')
  assert.equal(verdict.sessionId, SESSION)
  assert.equal(verdict.type, 'paragraph')
  assert.equal(verdict.text, 'Hello paragraph.')
  assert.equal(verdict.priority, 0.8)
  assert.equal(verdict.level, 'medium')
  assert.equal(verdict.model, 'jev-1.13.0')
  assert.equal(verdict.cached, false)
  assert.equal(verdict.matchText, undefined)
  assert.ok(verdict.createdAt > 0)

  const diag = pipeline.snapshot()
  assert.equal(diag.active, true)
  assert.equal(diag.unitsSeen, 1)
  assert.equal(diag.unitsJudged, 1)
  assert.equal(diag.unitsQueued, 0)
  assert.equal(diag.keySource, 'config')
  assert.equal(diag.requestBudget, 24000)
  assert.equal(diag.concurrencyLimit, 8)
  assert.deepEqual(diag.thresholdOverrides, THRESHOLDS)
})

test('units are published while the block is still streaming', async () => {
  const client = makeImmediateJudgeClient(ALL_CORE)
  const { pipeline, store } = makePipeline({ client })
  feed(pipeline, [
    startPayload(),
    blockStartPayload(),
    textDeltaPayload('First paragraph.\n\nSecond paragraph still stream'),
  ])
  await waitFor(() => store.size === 1, { label: 'first unit judged before block end' })
  assert.equal(store.query({}).units[0].text, 'First paragraph.')
  feed(pipeline, [blockEndPayload('First paragraph.\n\nSecond paragraph still streaming.\n\n'), endPayload()])
  await waitFor(() => store.size === 2, { label: 'second unit judged at block end' })
  assert.equal(store.query({}).units[1].text, 'Second paragraph still streaming.')
})

test('table rows carry both the Jev text and the DOM matchText', async () => {
  const { pipeline, store } = makePipeline()
  feed(pipeline, [
    startPayload(),
    blockStartPayload(),
    textDeltaPayload('| name | value |\n| --- | --- |\n| alpha | 1 |\n'),
    blockEndPayload('| name | value |\n| --- | --- |\n| alpha | 1 |\n'),
    endPayload(),
  ])
  await waitFor(() => store.size === 2, { label: 'table verdicts' })
  const units = store.query({}).units
  assert.equal(units[0].type, 'table_row')
  assert.equal(units[0].text, 'name | value')
  assert.equal(units[0].matchText, 'name value')
  assert.equal(units[1].text, 'alpha | 1')
  assert.equal(units[1].matchText, 'alpha 1')
})

test('block-end authoritative text extends a truncated stream without duplicating units', async () => {
  const { pipeline, store } = makePipeline()
  feed(pipeline, [
    startPayload(),
    blockStartPayload(),
    textDeltaPayload('Hello'),
    blockEndPayload('Hello world\n\n'),
    endPayload(),
  ])
  await waitFor(() => store.size === 1)
  assert.equal(store.query({}).units[0].text, 'Hello world')
})

test('block-end authoritative text replaces a divergent stream', async () => {
  const { pipeline, store } = makePipeline()
  feed(pipeline, [
    startPayload(),
    blockStartPayload(),
    textDeltaPayload('garbled text'),
    blockEndPayload('Complete authoritative paragraph.\n\n'),
    endPayload(),
  ])
  await waitFor(() => store.size === 1)
  assert.equal(store.query({}).units[0].text, 'Complete authoritative paragraph.')
})

test('heading context survives across text blocks of the same session', async () => {
  const { pipeline, store } = makePipeline()
  feed(pipeline, [
    startPayload(),
    blockStartPayload({ index: 0 }),
    textDeltaPayload('# Title\n\n'),
    blockEndPayload('# Title\n\n', { index: 0 }),
    blockStartPayload({ index: 1 }),
    textDeltaPayload('Body paragraph.\n\n', { index: 1 }),
    blockEndPayload('Body paragraph.\n\n', { index: 1 }),
    endPayload(),
  ])
  await waitFor(() => store.size === 1)
  const verdict = store.query({}).units[0]
  assert.equal(verdict.text, 'Body paragraph.')
  assert.equal(verdict.context.heading, 'Title')
  assert.equal(verdict.unitId, 'session-1:attempt-1:1:0')
})

test('grounding context resets when a new turn starts', async () => {
  const { pipeline, store } = makePipeline()
  feed(pipeline, [
    startPayload({ turn: 1 }),
    blockStartPayload({ index: 0 }),
    textDeltaPayload('# Turn one heading\n\n', { index: 0 }),
    blockEndPayload('# Turn one heading\n\n', { index: 0 }),
    endPayload(),
    // A new user turn must not inherit the previous turn's heading.
    startPayload({ turn: 2 }),
    blockStartPayload({ index: 0 }),
    textDeltaPayload('Fresh turn paragraph.\n\n', { index: 0 }),
    blockEndPayload('Fresh turn paragraph.\n\n', { index: 0 }),
    endPayload(),
  ])
  await waitFor(() => store.size === 1)
  const verdict = store.query({}).units[0]
  assert.equal(verdict.text, 'Fresh turn paragraph.')
  assert.equal(verdict.context.heading, undefined)
  assert.equal(verdict.context.before, undefined)
})

test('non-text blocks are ignored', async () => {
  const { pipeline, store } = makePipeline()
  feed(pipeline, [
    startPayload(),
    blockStartPayload({ index: 0, blockType: 'reasoning' }),
    chunkPayload({
      type: 'chunk',
      attemptId: 'attempt-1',
      revision: 0,
      index: 0,
      time: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: 'thinking...' },
    }),
    blockEndPayload('', { index: 0, blockType: 'reasoning' }),
    blockStartPayload({ index: 1 }),
    textDeltaPayload('Visible answer.\n\n', { index: 1 }),
    blockEndPayload('Visible answer.\n\n', { index: 1 }),
    endPayload(),
  ])
  await waitFor(() => store.size === 1)
  assert.equal(store.query({}).units[0].text, 'Visible answer.')
  assert.equal(pipeline.snapshot().unitsSeen, 1)
})

test('abandoned stream end aborts in-flight requests and drops the unit', async () => {
  const client = makeControlledJudgeClient()
  const { pipeline } = makePipeline({ client })
  feed(pipeline, [startPayload(), blockStartPayload(), textDeltaPayload('Pending paragraph.\n\n')])
  await waitFor(() => client.calls.length === 1, { label: 'judge call started' })
  const call = client.calls[0]
  assert.equal(call.signal.aborted, false)
  pipeline.handleAssistantStream(endPayload({ committed: false }))
  await waitFor(() => call.signal.aborted, { label: 'attempt signal aborted' })
  await waitFor(() => pipeline.snapshot().droppedUnits >= 1, { label: 'unit dropped' })
  assert.equal(pipeline.snapshot().unitsJudged, 0)
})

test('session disposal aborts the session in-flight request', async () => {
  const client = makeControlledJudgeClient()
  const { pipeline } = makePipeline({ client })
  feed(pipeline, [startPayload(), blockStartPayload(), textDeltaPayload('Pending paragraph.\n\n')])
  await waitFor(() => client.calls.length === 1)
  pipeline.handleSessionDisposed(makeSessionObject(SESSION))
  await waitFor(() => client.calls[0].signal.aborted)
  await waitFor(() => pipeline.snapshot().droppedUnits >= 1)
})

test('agent disposal aborts the agent in-flight request', async () => {
  const client = makeControlledJudgeClient()
  const { pipeline } = makePipeline({ client })
  feed(pipeline, [startPayload(), blockStartPayload(), textDeltaPayload('Pending paragraph.\n\n')])
  await waitFor(() => client.calls.length === 1)
  pipeline.handleAgentDisposed({ agent: { id: SESSION } })
  await waitFor(() => client.calls[0].signal.aborted)
  await waitFor(() => pipeline.snapshot().droppedUnits >= 1)
})

test('agent/status idle is NOT a cancellation trigger', async () => {
  const client = makeControlledJudgeClient()
  const { pipeline } = makePipeline({ client })
  feed(pipeline, [startPayload(), blockStartPayload(), textDeltaPayload('Pending paragraph.\n\n')])
  await waitFor(() => client.calls.length === 1)
  pipeline.handleAgentStatus({ agent: { id: SESSION }, status: 'idle' })
  assert.equal(client.calls[0].signal.aborted, false)
  client.calls[0].resolve(ALL_CORE)
  await waitFor(() => pipeline.snapshot().unitsJudged === 1)
})

test('pipeline disposal aborts everything and reports inactive', async () => {
  const client = makeControlledJudgeClient()
  const { pipeline } = makePipeline({ client })
  feed(pipeline, [startPayload(), blockStartPayload(), textDeltaPayload('Pending paragraph.\n\n')])
  await waitFor(() => client.calls.length === 1)
  await pipeline.dispose()
  assert.equal(client.calls[0].signal.aborted, true)
  const diag = pipeline.snapshot()
  assert.equal(diag.active, false)
  assert.equal(pipeline.isActive, false)
  // A second dispose is a no-op.
  await pipeline.dispose()
})

test('toggle off drops new units; toggle on resumes judging', async () => {
  const client = makeImmediateJudgeClient(ALL_CORE)
  const { pipeline, store } = makePipeline({ client })
  pipeline.setEnabled(false)
  feed(pipeline, [startPayload(), blockStartPayload(), textDeltaPayload('Dropped paragraph.\n\n')])
  await waitFor(() => pipeline.snapshot().unitsSeen === 1)
  assert.equal(client.calls.length, 0)
  assert.equal(pipeline.snapshot().droppedUnits, 1)

  pipeline.setEnabled(true)
  feed(pipeline, [textDeltaPayload('Judged paragraph.\n\n'), blockEndPayload('Judged paragraph.\n\n'), endPayload()])
  await waitFor(() => store.size === 1)
  assert.equal(store.query({}).units[0].text, 'Judged paragraph.')
})

test('queue depth is reported while jobs wait for a worker', async () => {
  const client = makeControlledJudgeClient()
  const { pipeline } = makePipeline({ client, maxConcurrency: 1 })
  feed(pipeline, [startPayload(), blockStartPayload(), textDeltaPayload('a\n\nb\n\nc\n\n')])
  await waitFor(() => client.calls.length === 1)
  assert.equal(pipeline.snapshot().unitsQueued, 2)
  assert.equal(pipeline.snapshot().inFlight, 1)
  for (let index = 0; index < 3; index += 1) {
    await waitFor(() => client.calls.length === index + 1)
    client.calls[index].resolve(ALL_CORE)
  }
  await waitFor(() => pipeline.snapshot().unitsJudged === 3)
  assert.equal(pipeline.snapshot().unitsQueued, 0)
})

test('custom thresholds change the stored level', async () => {
  const { pipeline, store } = makePipeline({ thresholds: { critical: 0.95, medium: 0.9, low: 0.7 } })
  feed(pipeline, [startPayload(), blockStartPayload(), textDeltaPayload('Level me.\n\n'), blockEndPayload('Level me.\n\n'), endPayload()])
  await waitFor(() => store.size === 1)
  assert.equal(store.query({}).units[0].priority, 0.8)
  assert.equal(store.query({}).units[0].level, 'low')
})

test('judge failures are counted with lastError and do not kill the pipeline', async () => {
  const client = {
    async judgeUnit() {
      throw new Error('upstream exploded')
    },
    stats() {
      return {
        requests: 1,
        inFlight: 0,
        maxConcurrentObserved: 1,
        maxRequestTokensObserved: 100,
        abortedRequests: 0,
        failures: 1,
        cacheHits: 0,
        cacheMisses: 1,
        cacheSize: 0,
      }
    },
  }
  const { pipeline } = makePipeline({ client })
  feed(pipeline, [startPayload(), blockStartPayload(), textDeltaPayload('Boom.\n\n'), blockEndPayload('Boom.\n\n'), endPayload()])
  await waitFor(() => pipeline.snapshot().failures === 1)
  assert.match(pipeline.snapshot().lastError, /upstream exploded/u)
  assert.equal(pipeline.snapshot().unitsJudged, 0)
})
