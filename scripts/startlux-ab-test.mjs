#!/usr/bin/env node
/**
 * StartLux preset A/B evaluation.
 *
 * Compares two candidate StartLux threshold presets (conservative vs sensitive)
 * against three labelled datasets:
 *   1. the 48-item synthetic product-intent corpus (known labels);
 *   2. 55 real live units with blind LLM judge labels (0..3 importance);
 *   3. 17 real P1-P7/P11 units with mock-expected levels (reference only).
 *
 * The judge labels were produced by an independent blind annotator that never
 * saw priorities; treat them as an experiment, not ground truth.
 *
 *   node scripts/startlux-ab-test.mjs
 *   node scripts/startlux-ab-test.mjs --run-dir docs/eval-runs/run-20261023-2040-startlux-ab
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { levelFor } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

function parseArgs(argv) {
  const map = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      map.set(token.slice(2), next)
      index += 1
    } else {
      map.set(token.slice(2), 'true')
    }
  }
  return map
}

const ARGS = parseArgs(process.argv.slice(2))
const RUN_DIR = resolve(ROOT, ARGS.get('run-dir') ?? 'docs/eval-runs/run-20261023-2040-startlux-ab')
const CALIBRATION_JSON = resolve(ROOT, 'docs/eval-runs/run-2026-10-23T12-24-28-825Z-startlux-calibration/calibration.json')
const CASES_JSON = resolve(ROOT, 'docs/eval-runs/run-20261023-2000-startlux/cases-startlux.json')

const cal = JSON.parse(readFileSync(CALIBRATION_JSON, 'utf8'))
const live = JSON.parse(readFileSync(join(RUN_DIR, 'live-units.json'), 'utf8'))
const cases = JSON.parse(readFileSync(CASES_JSON, 'utf8'))
const judge = JSON.parse(readFileSync(join(RUN_DIR, 'judge-labels.json'), 'utf8'))

const ORDER = ['none', 'low', 'medium', 'critical']
const rank = (level) => ORDER.indexOf(level)
const LABEL_BY_IMPORTANCE = { 0: 'none', 1: 'low', 2: 'medium', 3: 'critical' }
const judgeMap = new Map((judge.labels ?? judge).map((entry) => [entry.id, entry.importance]))

const presets = {
  current: { critical: 0.85, medium: 0.65, low: 0.45 },
  conservative: { critical: 0.63, medium: 0.4, low: 0.25 },
  sensitive: { critical: 0.52, medium: 0.37, low: 0.24 },
}

// A: synthetic product-intent corpus.
const datasetA = cal.items.map((item) => ({ id: item.id, priority: item.priority, label: item.label }))
// B: real live units with blind judge labels.
const datasetB = live
  .map((unit, index) => {
    const id = `U${String(index + 1).padStart(2, '0')}`
    return { id, priority: unit.priority, label: LABEL_BY_IMPORTANCE[judgeMap.get(id)], type: unit.type }
  })
  .filter((item) => item.label !== undefined)
// C: real P1..P7 + P11 units with mock-expected levels.
const caseLabels = { P1: 'critical', P2: 'medium', P3: 'medium', P4: 'medium', P5: 'low', P6: 'low', P7: 'none', P11: 'none' }
const datasetC = []
for (const [caseId, label] of Object.entries(caseLabels)) {
  for (const unit of cases[caseId]?.units ?? []) datasetC.push({ id: `${caseId}#${unit.seq}`, priority: unit.priority, label })
}

const COST = {
  none: { none: 0, low: 0.5, medium: 1, critical: 2 },
  low: { none: 0.5, low: 0, medium: 0.5, critical: 1 },
  medium: { none: 1, low: 0.5, medium: 0, critical: 1 },
  critical: { none: 3, low: 2, medium: 1, critical: 0 },
}

function evaluate(items, thresholds) {
  let correct = 0
  let mae = 0
  let within = 0
  let cost = 0
  let predCritical = 0
  let predCriticalHit = 0
  let actualCritical = 0
  let actualCriticalHit = 0
  let predHighlighted = 0
  let highlightedImportant = 0
  let actualImportant = 0
  let importantHighlighted = 0
  const confusion = {}
  const pairs = []
  for (const item of items) {
    const pred = levelFor(item.priority, thresholds)
    const distance = Math.abs(rank(item.label) - rank(pred))
    const hit = distance === 0
    correct += hit ? 1 : 0
    mae += distance
    within += distance <= 1 ? 1 : 0
    cost += COST[item.label][pred]
    if (pred === 'critical') {
      predCritical += 1
      if (item.label === 'critical') predCriticalHit += 1
    }
    if (item.label === 'critical') {
      actualCritical += 1
      if (pred === 'critical') actualCriticalHit += 1
    }
    if (rank(pred) >= 2) {
      predHighlighted += 1
      if (rank(item.label) >= 2) highlightedImportant += 1
    }
    if (rank(item.label) >= 2) {
      actualImportant += 1
      if (rank(pred) >= 2) importantHighlighted += 1
    }
    confusion[`${item.label}->${pred}`] = (confusion[`${item.label}->${pred}`] ?? 0) + 1
    pairs.push({ id: item.id, label: item.label, pred, priority: item.priority })
  }
  return {
    n: items.length,
    accuracy: correct / items.length,
    withinOne: within / items.length,
    mae: mae / items.length,
    cost: cost / items.length,
    criticalPrecision: predCritical === 0 ? 0 : predCriticalHit / predCritical,
    criticalRecall: actualCritical === 0 ? 0 : actualCriticalHit / actualCritical,
    highlightPrecision: predHighlighted === 0 ? 0 : highlightedImportant / predHighlighted,
    highlightRecall: actualImportant === 0 ? 0 : importantHighlighted / actualImportant,
    counts: Object.fromEntries(ORDER.map((level) => [level, pairs.filter((pair) => pair.pred === level).length])),
    confusion,
    pairs,
  }
}

function mcnemar(a, b) {
  let onlyA = 0
  let onlyB = 0
  for (let index = 0; index < a.length; index += 1) {
    const ca = a[index].pred === a[index].label
    const cb = b[index].pred === b[index].label
    if (ca && !cb) onlyA += 1
    if (!ca && cb) onlyB += 1
  }
  const n = onlyA + onlyB
  if (n === 0) return { onlyA, onlyB, p: 1 }
  let tail = 0
  for (let k = 0; k <= Math.min(onlyA, onlyB); k += 1) tail += choose(n, k) * 0.5 ** n
  return { onlyA, onlyB, p: Math.min(1, 2 * tail) }
}

function choose(n, k) {
  let result = 1
  for (let index = 1; index <= k; index += 1) result = (result * (n - k + index)) / index
  return result
}

function bootstrapDiff(a, b, samples = 10000) {
  const diffs = []
  for (let round = 0; round < samples; round += 1) {
    let da = 0
    let db = 0
    for (let index = 0; index < a.length; index += 1) {
      const pick = Math.floor(Math.random() * a.length)
      if (a[pick].pred === a[pick].label) da += 1
      if (b[pick].pred === b[pick].label) db += 1
    }
    diffs.push((da - db) / a.length)
  }
  diffs.sort((x, y) => x - y)
  const at = (q) => diffs[Math.min(diffs.length - 1, Math.max(0, Math.floor((diffs.length - 1) * q)))]
  return { mean: diffs.reduce((sum, value) => sum + value, 0) / diffs.length, ci95: [at(0.025), at(0.975)] }
}

const datasets = {
  synthetic: { items: datasetA, note: '48 条产品意图标注' },
  live: { items: datasetB, note: '55 条真实运行 unit，独立盲标' },
  acceptance: { items: datasetC, note: '17 条真实 P1-P7/P11，mock 预期档位（仅参考）' },
  combined: { items: [...datasetA, ...datasetB, ...datasetC], note: '全部' },
}

const report = {
  generatedAt: new Date().toISOString(),
  judge: { items: datasetB.length, counts: Object.fromEntries(ORDER.map((level) => [level, datasetB.filter((item) => item.label === level).length])) },
  datasets: {},
}
for (const [name, dataset] of Object.entries(datasets)) {
  const results = {}
  for (const [presetName, thresholds] of Object.entries(presets)) results[presetName] = evaluate(dataset.items, thresholds)
  report.datasets[name] = {
    note: dataset.note,
    n: dataset.items.length,
    results,
    sensitiveVsConservative: {
      mcnemar: mcnemar(results.sensitive.pairs, results.conservative.pairs),
      bootstrapAccuracyDiff: bootstrapDiff(results.sensitive.pairs, results.conservative.pairs),
    },
  }
}

mkdirSync(RUN_DIR, { recursive: true })
writeFileSync(join(RUN_DIR, 'ab-evaluation.json'), `${JSON.stringify(report, null, 2)}\n`)

for (const [name, data] of Object.entries(report.datasets)) {
  console.log(`\n=== ${name} (${data.n} items; ${data.note}) ===`)
  for (const presetName of ['current', 'conservative', 'sensitive']) {
    const r = data.results[presetName]
    console.log(
      `${presetName.padEnd(13)} acc=${(r.accuracy * 100).toFixed(1)}% within1=${(r.withinOne * 100).toFixed(1)}% mae=${r.mae.toFixed(3)} cost=${r.cost.toFixed(3)} ` +
        `critP=${(r.criticalPrecision * 100).toFixed(0)}% critR=${(r.criticalRecall * 100).toFixed(0)}% ` +
        `hiPrec=${(r.highlightPrecision * 100).toFixed(0)}% hiRec=${(r.highlightRecall * 100).toFixed(0)}% counts=${JSON.stringify(r.counts)}`,
    )
  }
  const compare = data.sensitiveVsConservative
  console.log(
    `sensitive vs conservative: McNemar p=${compare.mcnemar.p.toFixed(4)} (onlySensitive=${compare.mcnemar.onlyA}, onlyConservative=${compare.mcnemar.onlyB}), ` +
      `bootstrap acc diff=${(compare.bootstrapAccuracyDiff.mean * 100).toFixed(1)}pp CI95=[${(compare.bootstrapAccuracyDiff.ci95[0] * 100).toFixed(1)}, ${(compare.bootstrapAccuracyDiff.ci95[1] * 100).toFixed(1)}]pp`,
  )
}
console.log(`\njudge label counts=${JSON.stringify(report.judge.counts)}`)
console.log(`wrote ${join(RUN_DIR, 'ab-evaluation.json')}`)
