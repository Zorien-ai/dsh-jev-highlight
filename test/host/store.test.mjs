/**
 * Bounded verdict store: monotonic seq, cursor queries, capacity bounds.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { VerdictStore } from '../../lib/index.js'

const scores = { is_core_answer: 0, is_actionable: 0, is_warning: 0, is_definition: 0 }

function verdict(index, { sessionId = 's1', level = 'low', matchText } = {}) {
  const value = {
    unitId: `u${index}`,
    sessionId,
    type: 'paragraph',
    text: `text ${index}`,
    context: {},
    priority: 0.5,
    level,
    scores,
    model: 'jev-1.13.0',
    cached: false,
    createdAt: index,
  }
  if (matchText !== undefined) value.matchText = matchText
  return value
}

test('append assigns a globally monotonic seq and preserves fields', () => {
  const store = new VerdictStore()
  const first = store.append(verdict(1, { matchText: 'a b' }))
  const second = store.append(verdict(2, { sessionId: 's2' }))
  assert.equal(first.seq, 1)
  assert.equal(second.seq, 2)
  assert.equal(store.lastSeq, 2)
  assert.equal(first.matchText, 'a b')
  assert.equal(store.size, 2)
})

test('counts follow level buckets and ignore none', () => {
  const store = new VerdictStore()
  store.append(verdict(1, { level: 'critical' }))
  store.append(verdict(2, { level: 'medium' }))
  store.append(verdict(3, { level: 'low' }))
  store.append(verdict(4, { level: 'none' }))
  assert.deepEqual(store.countsSnapshot(), { critical: 1, medium: 1, low: 1 })
})

test('query respects since, sessionId and limit; cursor advances', () => {
  const store = new VerdictStore()
  for (let index = 0; index < 5; index += 1) store.append(verdict(index))
  store.append(verdict(5, { sessionId: 'other' }))

  const page1 = store.query({ since: 0, limit: 2 })
  assert.deepEqual(page1.units.map((unit) => unit.seq), [1, 2])
  assert.equal(page1.seq, 2)

  const page2 = store.query({ since: page1.seq, limit: 2 })
  assert.deepEqual(page2.units.map((unit) => unit.seq), [3, 4])
  assert.equal(page2.seq, 4)

  const page3 = store.query({ since: page2.seq, limit: 2 })
  assert.deepEqual(page3.units.map((unit) => unit.seq), [5, 6])
  assert.equal(page3.seq, 6)

  const empty = store.query({ since: 6 })
  assert.deepEqual(empty.units, [])
  assert.equal(empty.seq, 6)

  const filtered = store.query({ since: 0, sessionId: 'other' })
  assert.deepEqual(filtered.units.map((unit) => unit.unitId), ['u5'])
})

test('query without limit defaults to 200 and clamps large limits', () => {
  const store = new VerdictStore({ globalLimit: 2000 })
  for (let index = 0; index < 300; index += 1) store.append(verdict(index))
  assert.equal(store.query({ since: 0 }).units.length, 200)
  assert.equal(store.query({ since: 0, limit: 100000 }).units.length, 300)
})

test('per-session bound evicts oldest of that session only', () => {
  const store = new VerdictStore({ perSessionLimit: 2, globalLimit: 100 })
  store.append(verdict(1, { sessionId: 'a', level: 'critical' }))
  store.append(verdict(2, { sessionId: 'a', level: 'low' }))
  store.append(verdict(3, { sessionId: 'b', level: 'medium' }))
  store.append(verdict(4, { sessionId: 'a', level: 'low' }))
  assert.equal(store.size, 3)
  assert.deepEqual(store.sessionUnits('a').map((unit) => unit.unitId), ['u2', 'u4'])
  assert.deepEqual(store.sessionUnits('b').map((unit) => unit.unitId), ['u3'])
  // Counts must reflect retained verdicts only: critical evicted, b medium kept.
  assert.deepEqual(store.countsSnapshot(), { critical: 0, medium: 1, low: 2 })
})

test('global bound evicts oldest verdicts across sessions', () => {
  const store = new VerdictStore({ perSessionLimit: 100, globalLimit: 3 })
  for (let index = 1; index <= 5; index += 1) store.append(verdict(index, { sessionId: index <= 3 ? 'a' : 'b' }))
  assert.equal(store.size, 3)
  assert.deepEqual(store.query({ since: 0 }).units.map((unit) => unit.unitId), ['u3', 'u4', 'u5'])
})

test('clear resets both entries and the sequence cursor', () => {
  const store = new VerdictStore()
  store.append(verdict(1))
  store.clear()
  assert.equal(store.size, 0)
  assert.equal(store.lastSeq, 0)
  assert.deepEqual(store.countsSnapshot(), { critical: 0, medium: 0, low: 0 })
  assert.equal(store.append(verdict(2)).seq, 1)
})
