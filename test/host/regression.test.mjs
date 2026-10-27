/**
 * Regression tests for defects found during the integrated E2E run.
 *
 * 1. `finishCapture` used to lose the last paragraph when `block-end` carried
 *    an authoritative text that merely *extended* the streamed text: the
 *    `startsWith` branch published the suffix but never flushed the splitter
 *    buffer. The final unit of a message was silently unjudged.
 * 2. Streaming block boundaries can produce punctuation-only fragments (a lone
 *    "。"). They must not become content units or Jev requests.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { __internals } from '../../lib/index.js'

const {
  JudgePipeline,
  VerdictStore,
  StreamingSplitter,
  DEFAULT_THRESHOLDS,
  combinePriority,
} = __internals

function makeFakeClient() {
  const calls = []
  return {
    calls,
    async judgeUnit(unit) {
      calls.push(unit)
      return {
        scores: { is_core_answer: 0.9, is_actionable: 0.9, is_warning: 0.2, is_definition: 0.2 },
        cached: false,
      }
    },
    stats() {
      return {
        requests: calls.length,
        inFlight: 0,
        maxConcurrentObserved: 0,
        maxRequestTokensObserved: 0,
        cacheHits: 0,
        cacheMisses: calls.length,
        cacheSize: 0,
        abortedRequests: 0,
        failures: 0,
      }
    },
  }
}

function makePipeline(client) {
  const pipeline = new JudgePipeline({
    client,
    store: new VerdictStore(),
    model: 'jev-1.13.0',
    baseUrl: 'http://127.0.0.1:0',
    keySource: 'test',
    thresholds: DEFAULT_THRESHOLDS,
    maxConcurrency: 4,
    requestTokenBudget: 24000,
    autoStart: true,
  })
  pipeline.start()
  return pipeline
}

function frame(extra) {
  return { agent: { id: 'session-regression' }, frame: { attemptId: 'attempt-1', revision: 0, turn: 1, step: 1, ...extra } }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25))

test('block-end that extends streamed text still judges the trailing paragraph', async () => {
  const client = makeFakeClient()
  const pipeline = makePipeline(client)

  pipeline.handleAssistantStream(frame({ type: 'start' }))
  pipeline.handleAssistantStream(
    frame({ type: 'chunk', index: 0, time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } }),
  )
  pipeline.handleAssistantStream(
    frame({ type: 'chunk', index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '最后一句还没' } }),
  )
  // The authoritative block text extends the streamed prefix: the old code
  // published only the suffix and never flushed, losing the whole paragraph.
  pipeline.handleAssistantStream(
    frame({
      type: 'chunk',
      index: 0,
      time: 2,
      chunk: { type: 'block-end', index: 0, block: { type: 'text', text: '最后一句还没结束。\n' } },
    }),
  )
  await tick()

  const texts = client.calls.map((unit) => unit.text)
  assert.ok(
    texts.some((text) => text.includes('最后一句还没结束。')),
    `expected the trailing paragraph to be judged, got ${JSON.stringify(texts)}`,
  )
  await pipeline.dispose()
})

test('punctuation-only streaming fragments never become units', () => {
  const splitter = new StreamingSplitter({ sessionId: 's', attemptId: 'a', blockIndex: 0 })
  const units = []
  // Simulate a block boundary where the closing punctuation arrives isolated.
  units.push(...splitter.push('。\n\n'))
  units.push(...splitter.push('正文内容完整的一句话。\n\n'))
  units.push(...splitter.flush())
  const texts = units.map((unit) => unit.text)
  assert.ok(!texts.includes('。'), `punctuation-only unit leaked: ${JSON.stringify(texts)}`)
  assert.ok(texts.some((text) => text.includes('正文内容完整的一句话。')))
})

test('priority mapping uses the documented weights and cutoffs', () => {
  const scores = { is_core_answer: 1, is_actionable: 1, is_warning: 1, is_definition: 1 }
  assert.equal(combinePriority(scores), 1)
  assert.equal(combinePriority({ is_core_answer: 1, is_actionable: 0, is_warning: 0, is_definition: 0 }), 0.5)
  assert.equal(combinePriority({ is_core_answer: 0, is_actionable: 1, is_warning: 0, is_definition: 0 }), 0.3)
  assert.equal(combinePriority({ is_core_answer: 0, is_actionable: 0, is_warning: 1, is_definition: 0 }), 0.2)
  assert.equal(combinePriority({ is_core_answer: 0, is_actionable: 0, is_warning: 0, is_definition: 1 }), 0.2)
})
