/**
 * Token estimator + request budget invariants.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  JevBudgetError,
  FIXED_REQUEST_OVERHEAD_TOKENS,
  HARD_STATE_QUESTION_LIMIT,
  HARD_TOTAL_LIMIT,
  assertRequestBudget,
  checkRequestBudget,
  estimateJsonTokens,
  estimateRequestTokens,
  estimateTokens,
  splitTextToTokenBudget,
} from '../../lib/index.js'

test('estimateTokens: conservative calibrated CJK and ASCII rules', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('你好世界'), 5) // ceil(4 * 1.2075)
  assert.equal(estimateTokens('日本語'), 4)
  assert.equal(estimateTokens('abcdefg'), 3) // ceil(7 * 0.4025)
  assert.equal(estimateTokens('a'.repeat(70)), 29)
  assert.equal(estimateTokens('你好 abcdefg'), 6) // ceil(2*1.2075 + 8*0.4025)
  // Full-width punctuation counts as CJK.
  assert.equal(estimateTokens('，。！'), 4)
  // Emoji are not CJK; they are conservatively counted as ordinary chars.
  assert.ok(estimateTokens('🙂🙂🙂') >= 1)
  // The estimate is never below the task's plain rule of thumb (CJK 1/char, ASCII 1/3.5).
  assert.ok(estimateTokens('汉'.repeat(100)) >= 100)
  assert.ok(estimateTokens('a'.repeat(100)) >= Math.ceil(100 / 3.5))
})

test('estimateJsonTokens estimates the actual serialized length', () => {
  const value = { model: 'jev-1.13.0', questions: { q: { type: 'noul', instructions: 'Is it?' } } }
  assert.equal(estimateJsonTokens(value), estimateTokens(JSON.stringify(value)))
  assert.ok(estimateJsonTokens(value) > estimateTokens('jev-1.13.0'))
})

test('estimateRequestTokens = state + longest question + fixed overhead', () => {
  const state = 'abcd'
  const questions = ['abcd', 'abcdefgh']
  const stateTokens = estimateTokens(state)
  const longest = estimateTokens('abcdefgh')
  assert.equal(estimateRequestTokens(state, questions), stateTokens + longest + FIXED_REQUEST_OVERHEAD_TOKENS)
  assert.equal(estimateRequestTokens(state, questions, 0), stateTokens + longest)
})

test('checkRequestBudget reports each invariant', () => {
  const ok = checkRequestBudget('hello', ['Is this the answer?'], 24000)
  assert.equal(ok.withinRequestBudget, true)
  assert.equal(ok.withinHardStateQuestionLimit, true)
  assert.equal(ok.withinHardTotalLimit, true)
  assert.equal(ok.estimatedTokens, ok.stateTokens + ok.longestQuestionTokens + FIXED_REQUEST_OVERHEAD_TOKENS)

  const tight = checkRequestBudget('hello', ['Is this the answer?'], 10)
  assert.equal(tight.withinRequestBudget, false)

  const hugeState = '汉'.repeat(HARD_STATE_QUESTION_LIMIT + 100)
  const huge = checkRequestBudget(hugeState, ['q'], 60000)
  assert.equal(huge.withinHardStateQuestionLimit, false)
  assert.equal(huge.withinHardTotalLimit, true) // 32293 < 64000; only the state cap is hit

  const hugeTotal = checkRequestBudget('汉'.repeat(HARD_TOTAL_LIMIT + 100), ['q'], 60000)
  assert.equal(hugeTotal.withinHardTotalLimit, false)
})

test('assertRequestBudget throws JevBudgetError for each violation', () => {
  assert.throws(() => assertRequestBudget('hello', ['question'], 10), JevBudgetError)
  assert.throws(() => assertRequestBudget('汉'.repeat(HARD_STATE_QUESTION_LIMIT + 10), ['question'], 60000), JevBudgetError)
  assert.throws(() => assertRequestBudget('汉'.repeat(HARD_TOTAL_LIMIT + 10), ['question'], 60000), JevBudgetError)
  assert.equal(assertRequestBudget('hello', ['question'], 24000), estimateRequestTokens('hello', ['question']))
})

test('splitTextToTokenBudget keeps every chunk inside the budget and the content ordered', () => {
  const lines = []
  for (let index = 0; index < 40; index += 1) lines.push(`line ${index} content`)
  const text = lines.join('\n')
  const chunks = splitTextToTokenBudget(text, 40)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(estimateTokens(chunk) <= 40, `chunk over budget: ${estimateTokens(chunk)}`)
    assert.ok(chunk.trim() !== '')
  }
  const rejoined = chunks.join('\n')
  for (const line of lines) assert.ok(rejoined.includes(line), `missing ${line}`)
})

test('splitTextToTokenBudget cuts a single oversized line on sentence boundaries', () => {
  const sentence = '这是一个很长的中文句子，用来测试切分。'
  const text = sentence.repeat(20)
  const chunks = splitTextToTokenBudget(text, 30)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(estimateTokens(chunk) <= 30, `chunk over budget: ${estimateTokens(chunk)}`)
  }
  assert.equal(chunks.join('').replace(/\s+/gu, ''), text.replace(/\s+/gu, ''))
})

test('splitTextToTokenBudget hard-cuts a single huge unbroken line', () => {
  const text = 'x'.repeat(1000)
  const chunks = splitTextToTokenBudget(text, 50)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(estimateTokens(chunk) <= 50)
  assert.equal(chunks.join(''), text)
})

test('splitTextToTokenBudget tolerates empty input', () => {
  assert.deepEqual(splitTextToTokenBudget('', 100), [])
  assert.deepEqual(splitTextToTokenBudget('\n\n\n', 100), [])
})
