/**
 * LRU verdict cache and cache keys.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LruVerdictCache,
  cacheKeyFor,
  cacheKeyForUnit,
  normaliseCacheText,
} from '../../lib/index.js'

const scores = { is_core_answer: 0.9, is_actionable: 0.4, is_warning: 0, is_definition: 0.1 }

test('get/set tracks hits, misses and size', () => {
  const cache = new LruVerdictCache({ capacity: 3 })
  assert.equal(cache.get('missing'), undefined)
  cache.set('a', scores)
  assert.deepEqual(cache.get('a'), scores)
  const stats = cache.stats()
  assert.equal(stats.hits, 1)
  assert.equal(stats.misses, 1)
  assert.equal(stats.size, 1)
})

test('capacity evicts the least recently used entry', () => {
  const cache = new LruVerdictCache({ capacity: 2 })
  cache.set('a', { ...scores, is_core_answer: 1 })
  cache.set('b', { ...scores, is_core_answer: 2 })
  // Touch a so b becomes the least recently used.
  assert.equal(cache.get('a').is_core_answer, 1)
  cache.set('c', { ...scores, is_core_answer: 3 })
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a').is_core_answer, 1)
  assert.equal(cache.get('c').is_core_answer, 3)
  assert.equal(cache.size, 2)
})

test('normaliseCacheText collapses whitespace', () => {
  assert.equal(normaliseCacheText('  a\n\t b  '), 'a b')
})

test('cacheKeyFor is stable across whitespace and sensitive to context/model', () => {
  const base = cacheKeyFor({ text: 'Hello   world', type: 'paragraph', context: { heading: 'H', before: 'B' } }, 'jev-1.13.0')
  const same = cacheKeyFor({ text: 'Hello world', type: 'paragraph', context: { heading: 'H', before: 'B' } }, 'jev-1.13.0')
  const otherModel = cacheKeyFor({ text: 'Hello world', type: 'paragraph', context: { heading: 'H', before: 'B' } }, 'jev-1.14.0')
  const otherHeading = cacheKeyFor({ text: 'Hello world', type: 'paragraph', context: { heading: 'H2', before: 'B' } }, 'jev-1.13.0')
  const otherBefore = cacheKeyFor({ text: 'Hello world', type: 'paragraph', context: { heading: 'H', before: 'B2' } }, 'jev-1.13.0')
  const otherText = cacheKeyFor({ text: 'Hello world!', type: 'paragraph', context: { heading: 'H', before: 'B' } }, 'jev-1.13.0')
  const otherQuestion = cacheKeyFor(
    { text: 'Hello world', type: 'paragraph', context: { heading: 'H', before: 'B', question: 'Q?' } },
    'jev-1.13.0',
  )
  assert.equal(base, same)
  assert.notEqual(base, otherModel)
  assert.notEqual(base, otherHeading)
  assert.notEqual(base, otherBefore)
  assert.notEqual(base, otherText)
  assert.notEqual(base, otherQuestion)
  assert.match(base, /^[0-9a-f]{64}$/u)
})

test('cacheKeyForUnit matches cacheKeyFor for the same unit', () => {
  const unit = { id: 'u', sessionId: 's', attemptId: 'a', blockIndex: 0, type: 'paragraph', text: 'Body', context: { heading: 'H' } }
  assert.equal(cacheKeyForUnit(unit, 'jev-1.13.0'), cacheKeyFor(unit, 'jev-1.13.0'))
})
