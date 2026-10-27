/**
 * Shared contract helpers: weighting, thresholds, version.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_THRESHOLDS,
  PRIORITY_WEIGHTS,
  QUESTION_SET_VERSION,
  combinePriority,
  levelFor,
} from '../../lib/index.js'

const zero = { is_core_answer: 0, is_actionable: 0, is_warning: 0, is_definition: 0 }
const one = { is_core_answer: 1, is_actionable: 1, is_warning: 1, is_definition: 1 }

test('combinePriority uses the documented weights', () => {
  assert.equal(combinePriority(zero), 0)
  assert.equal(combinePriority(one), 1)
  assert.equal(combinePriority({ ...zero, is_core_answer: 1 }), PRIORITY_WEIGHTS.coreAnswer)
  assert.equal(combinePriority({ ...zero, is_actionable: 1 }), PRIORITY_WEIGHTS.actionable)
  assert.equal(combinePriority({ ...zero, is_warning: 1 }), PRIORITY_WEIGHTS.warningOrDefinition)
  // warning and definition share one slot: the max, not the sum.
  assert.equal(combinePriority({ ...zero, is_warning: 1, is_definition: 1 }), PRIORITY_WEIGHTS.warningOrDefinition)
  assert.equal(combinePriority({ is_core_answer: 0.5, is_actionable: 0.5, is_warning: 0.5, is_definition: 0 }), 0.25 + 0.15 + 0.1)
})

test('combinePriority clamps out-of-range input', () => {
  assert.equal(combinePriority({ is_core_answer: 2, is_actionable: -1, is_warning: 5, is_definition: -5 }), 0.5 + 0.2)
  assert.equal(combinePriority({ is_core_answer: Number.NaN, is_actionable: 0, is_warning: 0, is_definition: 0 }), 0)
})

test('levelFor maps priority to intensity buckets', () => {
  assert.equal(levelFor(1), 'critical')
  assert.equal(levelFor(0.85), 'critical')
  assert.equal(levelFor(0.8499), 'medium')
  assert.equal(levelFor(0.65), 'medium')
  assert.equal(levelFor(0.6499), 'low')
  assert.equal(levelFor(0.45), 'low')
  assert.equal(levelFor(0.4499), 'none')
  assert.equal(levelFor(0), 'none')
})

test('levelFor accepts custom thresholds', () => {
  const thresholds = { critical: 0.9, medium: 0.5, low: 0.2 }
  assert.equal(levelFor(0.85, thresholds), 'medium')
  assert.equal(levelFor(0.4, thresholds), 'low')
  assert.equal(levelFor(0.1, thresholds), 'none')
})

test('contract constants remain stable', () => {
  assert.deepEqual(DEFAULT_THRESHOLDS, { critical: 0.85, medium: 0.65, low: 0.45 })
  assert.equal(QUESTION_SET_VERSION, 'jev-highlight/questions/v2')
})
