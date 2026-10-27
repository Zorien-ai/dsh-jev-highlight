/**
 * Provider-specific threshold defaults: StartLux uses the calibrated sensitive
 * preset (.52/.37/.24), Jev keeps the original .85/.65/.45. Settings overrides
 * are persisted separately and take precedence at runtime.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_THRESHOLDS, STARTLUX_THRESHOLDS, normaliseConfig } from '../../lib/index.js'

test('StartLux defaults to the calibrated sensitive thresholds', () => {
  assert.deepEqual(normaliseConfig({ provider: 'startlux' }).highlightThresholds, STARTLUX_THRESHOLDS)
  assert.deepEqual(normaliseConfig(undefined).highlightThresholds, STARTLUX_THRESHOLDS)
  assert.deepEqual(STARTLUX_THRESHOLDS, { critical: 0.52, medium: 0.37, low: 0.24 })
})

test('Jev keeps the original default thresholds', () => {
  assert.deepEqual(normaliseConfig({ provider: 'jev' }).highlightThresholds, DEFAULT_THRESHOLDS)
  assert.deepEqual(DEFAULT_THRESHOLDS, { critical: 0.85, medium: 0.65, low: 0.45 })
})

test('per-provider threshold config is honoured and kept ordered', () => {
  assert.deepEqual(
    normaliseConfig({ provider: 'startlux', startluxThresholds: { critical: 0.6, medium: 0.45, low: 0.3 } }).highlightThresholds,
    { critical: 0.6, medium: 0.45, low: 0.3 },
  )
  assert.deepEqual(
    normaliseConfig({ provider: 'jev', highlightThresholds: { critical: 0.9, medium: 0.7, low: 0.5 } }).highlightThresholds,
    { critical: 0.9, medium: 0.7, low: 0.5 },
  )
  // Medium above critical is clamped down to keep the buckets ordered.
  assert.deepEqual(
    normaliseConfig({ provider: 'startlux', startluxThresholds: { critical: 0.5, medium: 0.7, low: 0.2 } }).highlightThresholds,
    { critical: 0.5, medium: 0.5, low: 0.2 },
  )
})
