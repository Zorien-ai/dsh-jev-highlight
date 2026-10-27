#!/usr/bin/env node
/**
 * StartLux threshold calibration experiment.
 *
 * Feeds a labelled corpus through the *real* StartLux decision API using the
 * same state template and four noul questions the plugin uses, then evaluates
 * the current priority thresholds (.85/.65/.45) and a grid of alternatives.
 *
 * The API key is read from the plugin's Settings file (or env) and never
 * printed. Results go to a run directory under docs/eval-runs/.
 *
 *   node scripts/startlux-calibrate.mjs
 *   node scripts/startlux-calibrate.mjs --corpus scripts/startlux-calibration-corpus.json
 *   node scripts/startlux-calibrate.mjs --think-mode auto --auto-subset 8
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_THRESHOLDS,
  NOUL_QUESTIONS,
  buildJevQuestions,
  buildStateText,
  combinePriority,
  levelFor,
  parseSystemOneScoresDetailed,
} from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const map = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      map.set(key, next)
      index += 1
    } else {
      map.set(key, 'true')
    }
  }
  return map
}

const ARGS = parseArgs(process.argv.slice(2))
const MODE = ARGS.get('think-mode') ?? 'never'
if (MODE !== 'never' && MODE !== 'auto' && MODE !== 'always') throw new Error(`invalid --think-mode ${MODE}`)
const MODEL = ARGS.get('model') ?? 'startlux-decision-27b-autothink'
const BASE_URL = (ARGS.get('base-url') ?? 'https://api.bamboonode.dev/v1').replace(/\/+$/u, '')
const ENDPOINT = ARGS.get('endpoint') ?? '/decisions'
const CONCURRENCY = Math.max(1, Math.min(12, Number(ARGS.get('concurrency') ?? 8)))
const AUTO_SUBSET = Math.max(0, Math.min(24, Number(ARGS.get('auto-subset') ?? 8)))
const CORPUS_PATH = resolve(ROOT, ARGS.get('corpus') ?? 'scripts/startlux-calibration-corpus.json')
const KEY_FILE = ARGS.get('key-file') ?? join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'jev-highlight-startlux.key')
const RUN_ID = new Date().toISOString().replace(/[:.]/gu, '-')
const OUT_DIR = resolve(ROOT, ARGS.get('out') ?? join('docs', 'eval-runs', `run-${RUN_ID}-startlux-calibration`))

// Prompt variants for the calibration experiment. `current` is what the
// plugin ships (QUESTION_SET_VERSION v2); the others test whether sharper
// yes/no anchors make StartLux scores better calibrated.
const VARIANT = ARGS.get('variant') ?? 'current'
const strictInstructions = {
  is_core_answer: "Does this passage directly resolve the user's question in [question]? Answer yes only if the answer is present in the passage itself.",
  is_actionable: 'Does this passage give a concrete action, command, or step the reader can execute? Answer yes only for explicit instructions.',
  is_warning: 'Does this passage warn about a concrete risk, caveat, failure mode, or limitation? Answer yes only for an actual risk or constraint.',
  is_definition: 'Does this passage define or explain a term, concept, or field? Answer yes only for an actual definition or explanation.',
}
const criteriaAnchors = {
  is_core_answer: {
    true: "The passage directly answers the user's question in [question]; a reader could resolve the question from it.",
    false: 'The passage is background, a transition, tool output, or only loosely related to the question.',
  },
  is_actionable: {
    true: 'The passage contains an explicit command, step, or configuration the reader can execute.',
    false: 'The passage is descriptive, explanatory, or vague, with no executable instruction.',
  },
  is_warning: {
    true: 'The passage states a concrete risk, caveat, failure mode, or limitation.',
    false: 'The passage is neutral, positive, or purely informational.',
  },
  is_definition: {
    true: 'The passage defines or explains a term, concept, or field.',
    false: 'The passage uses terms but does not define or explain them.',
  },
}

function buildVariantQuestions(variant) {
  const current = buildJevQuestions()
  if (variant === 'current') return current
  const source = variant === 'strict' || variant === 'both' ? strictInstructions : null
  const payload = {}
  for (const question of NOUL_QUESTIONS) {
    const instructions = source === null ? question.instructions : (source[question.id] ?? question.instructions)
    payload[question.id] = {
      type: 'noul',
      instructions,
      ...(variant === 'criteria' || variant === 'both' ? { criteria: criteriaAnchors[question.id] } : {}),
    }
  }
  return payload
}

if (!['current', 'criteria', 'strict', 'both'].includes(VARIANT)) throw new Error(`invalid --variant ${VARIANT}`)
const QUESTIONS = buildVariantQuestions(VARIANT)

// ---------------------------------------------------------------------------
// Key / HTTP
// ---------------------------------------------------------------------------

function loadKey() {
  const envKey = process.env.STARTLUX_API_KEY?.trim() || process.env.BAMBOO_API_KEY?.trim() || ''
  if (envKey !== '') return { key: envKey, source: 'env' }
  const fromFile = readFileSync(KEY_FILE, 'utf8').split(/\r?\n/u)[0]?.trim() ?? ''
  if (fromFile === '') throw new Error(`no API key in ${KEY_FILE}`)
  return { key: fromFile, source: 'settings:key-file' }
}

const CREDENTIAL = loadKey()
const URL = `${BASE_URL}${ENDPOINT}`

async function postDecision(payload, timeoutMs = 90000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${CREDENTIAL.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text.slice(0, 500) }
    }
    return { ok: response.ok, status: response.status, body }
  } finally {
    clearTimeout(timer)
  }
}

async function judge(item, mode = MODE) {
  const started = Date.now()
  const state = buildStateText({ text: item.text, context: { question: item.questionText } })
  const payload = { model: MODEL, state, questions: QUESTIONS, think_mode: mode }
  if (mode === 'auto' || mode === 'always') payload.return_details = true
  let lastError = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await postDecision(payload)
      if (response.ok) {
        const parsed = parseSystemOneScoresDetailed(response.body)
        const scores = parsed.scores
        const priority = combinePriority(scores)
        return {
          ok: true,
          latencyMs: Date.now() - started,
          scores,
          priority,
          missing: parsed.missing,
          usage: response.body?.usage ?? null,
          details: response.body?.answers?.is_core_answer?.details ?? null,
          state,
        }
      }
      lastError = `HTTP ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`
      if (response.status !== 429 && response.status < 500) break
      await sleep(500 * (attempt + 1))
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await sleep(500 * (attempt + 1))
    }
  }
  return { ok: false, latencyMs: Date.now() - started, error: lastError }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function mapLimited(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const ORDER = ['none', 'low', 'medium', 'critical']
const rank = (level) => ORDER.indexOf(level)

function classify(priority, thresholds) {
  return levelFor(priority, thresholds)
}

function evaluate(items, thresholds) {
  const confusion = Object.fromEntries(ORDER.map((expected) => [expected, Object.fromEntries(ORDER.map((predicted) => [predicted, 0]))]))
  const perClass = Object.fromEntries(ORDER.map((label) => [label, { total: 0, predicted: 0, correct: 0 }]))
  let correct = 0
  let absoluteError = 0
  let withinOne = 0
  for (const item of items) {
    const expected = item.label
    const predicted = classify(item.priority, thresholds)
    confusion[expected][predicted] += 1
    perClass[expected].total += 1
    perClass[predicted].predicted += 1
    if (expected === predicted) {
      correct += 1
      perClass[expected].correct += 1
    }
    const distance = Math.abs(rank(expected) - rank(predicted))
    absoluteError += distance
    if (distance <= 1) withinOne += 1
  }
  const recalls = {}
  const precisions = {}
  const f1s = {}
  for (const label of ORDER) {
    const stats = perClass[label]
    const recall = stats.total === 0 ? 0 : stats.correct / stats.total
    const precision = stats.predicted === 0 ? 0 : stats.correct / stats.predicted
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
    recalls[label] = recall
    precisions[label] = precision
    f1s[label] = f1
  }
  const counts = Object.fromEntries(ORDER.map((level) => [level, items.filter((item) => classify(item.priority, thresholds) === level).length]))
  const balancedAccuracy = ORDER.reduce((sum, label) => sum + recalls[label], 0) / ORDER.length
  const macroF1 = ORDER.reduce((sum, label) => sum + f1s[label], 0) / ORDER.length
  return {
    thresholds: { ...thresholds },
    n: items.length,
    accuracy: correct / items.length,
    ordinalMAE: absoluteError / items.length,
    withinOne: withinOne / items.length,
    balancedAccuracy,
    macroF1,
    criticalPrecision: precisions.critical,
    criticalRecall: recalls.critical,
    confusion,
    perClass: Object.fromEntries(ORDER.map((label) => [label, { ...perClass[label], recall: recalls[label], precision: precisions[label], f1: f1s[label] }])),
    counts,
  }
}

function auc(positives) {
  const pairs = positives.slice().sort((a, b) => a.score - b.score)
  const totalPositive = pairs.filter((pair) => pair.positive).length
  const totalNegative = pairs.length - totalPositive
  if (totalPositive === 0 || totalNegative === 0) return null
  let rankSum = 0
  let index = 0
  while (index < pairs.length) {
    let end = index
    while (end + 1 < pairs.length && pairs[end + 1].score === pairs[index].score) end += 1
    const averageRank = (index + end) / 2 + 1
    for (let cursor = index; cursor <= end; cursor += 1) {
      if (pairs[cursor].positive) rankSum += averageRank
    }
    index = end + 1
  }
  return (rankSum - (totalPositive * (totalPositive + 1)) / 2) / (totalPositive * totalNegative)
}

function distribution(values) {
  const sorted = values.slice().sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))]
  return {
    n: sorted.length,
    min: sorted[0],
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  }
}

function gridSearch(items) {
  const candidates = []
  for (let critical = 0.5; critical <= 0.951; critical += 0.01) {
    for (let medium = 0.4; medium <= critical - 0.01 + 1e-9; medium += 0.01) {
      for (let low = 0.25; low <= medium - 0.01 + 1e-9; low += 0.01) {
        const thresholds = { critical: round2(critical), medium: round2(medium), low: round2(low) }
        const metrics = evaluate(items, thresholds)
        // Product wants meaningful critical + medium bands and ordinal separation.
        const sane = metrics.counts.critical >= 1 && metrics.counts.medium >= 1
        const score = metrics.balancedAccuracy * 1000 - metrics.ordinalMAE * 10 + (sane ? 5 : 0)
        candidates.push({ score, sane, metrics })
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates.slice(0, 12).map((candidate) => candidate.metrics)
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

function round2(value) {
  return Math.round(value * 100) / 100
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'))
const items = corpus.items.map((item) => ({ ...item, questionText: corpus.questions[item.question] }))
if (items.length === 0) throw new Error('empty corpus')

mkdirSync(OUT_DIR, { recursive: true })
const startedAt = new Date().toISOString()
console.log(`[calibrate] corpus=${items.length} variant=${VARIANT} url=${URL} model=${MODEL} think_mode=${MODE} concurrency=${CONCURRENCY}`)
console.log(`[calibrate] keySource=${CREDENTIAL.source} out=${OUT_DIR}`)

const responses = await mapLimited(items, CONCURRENCY, async (item) => ({ item, result: await judge(item) }))
const failed = responses.filter((entry) => !entry.result.ok)
if (failed.length > 0) {
  writeFileSync(join(OUT_DIR, 'responses.json'), JSON.stringify(responses, null, 2))
  throw new Error(`${failed.length} decision requests failed; first error: ${failed[0].result.error}`)
}

const scored = responses.map(({ item, result }) => ({ ...item, ...result }))
const current = evaluate(scored, DEFAULT_THRESHOLDS)
const grid = gridSearch(scored)
const recommended = grid[0]

// Per-question score means and per-boundary AUC.
const questionStats = {}
for (const key of Object.keys(corpus.questions)) {
  const subset = scored.filter((item) => item.question === key)
  questionStats[key] = {
    n: subset.length,
    meanScores: ['is_core_answer', 'is_actionable', 'is_warning', 'is_definition'].reduce((accumulator, questionId) => {
      accumulator[questionId] = subset.reduce((sum, item) => sum + item.scores[questionId], 0) / subset.length
      return accumulator
    }, {}),
    meanPriority: subset.reduce((sum, item) => sum + item.priority, 0) / subset.length,
  }
}

const boundaries = {
  'critical vs rest': auc(scored.map((item) => ({ score: item.priority, positive: item.label === 'critical' }))),
  'medium+critical vs low+none': auc(scored.map((item) => ({ score: item.priority, positive: rank(item.label) >= 2 }))),
  'low+ vs none': auc(scored.map((item) => ({ score: item.priority, positive: rank(item.label) >= 1 }))),
}

const distributions = Object.fromEntries(ORDER.map((label) => [label, distribution(scored.filter((item) => item.label === label).map((item) => item.priority))]))
const scoreDistributions = Object.fromEntries(ORDER.map((label) => {
  const subset = scored.filter((item) => item.label === label)
  return [label, Object.fromEntries(['is_core_answer', 'is_actionable', 'is_warning', 'is_definition'].map((questionId) => [
    questionId,
    distribution(subset.map((item) => item.scores[questionId])),
  ]))]
}))

// Optional stability check: re-run a small class-balanced subset with auto.
let autoSubset = null
if (AUTO_SUBSET > 0) {
  const picks = []
  for (const label of ORDER) {
    picks.push(...scored.filter((item) => item.label === label).slice(0, Math.ceil(AUTO_SUBSET / ORDER.length)))
  }
  const subset = picks.slice(0, AUTO_SUBSET)
  console.log(`[calibrate] auto subset=${subset.length} (for think-mode stability)`)
  const autoResponses = await mapLimited(subset, Math.min(4, CONCURRENCY), async (item) => ({ item, result: await judge(item, 'auto') }))
  autoSubset = autoResponses
    .filter((entry) => entry.result.ok)
    .map(({ item, result }) => ({
      id: item.id,
      label: item.label,
      priorityNever: item.priority,
      priorityAuto: result.priority,
      delta: round4(result.priority - item.priority),
      thought: result.details?.thought ?? null,
      outputTokens: result.usage?.output_tokens ?? null,
    }))
}

const calibration = {
  runId: RUN_ID,
  startedAt,
  finishedAt: new Date().toISOString(),
  endpoint: URL,
  model: MODEL,
  thinkMode: MODE,
  variant: VARIANT,
  questions: QUESTIONS,
  keySource: CREDENTIAL.source,
  labelDefinition: corpus.labels,
  corpus: { path: CORPUS_PATH, questions: corpus.questions, n: items.length },
  currentThresholds: { ...DEFAULT_THRESHOLDS },
  current,
  recommended,
  gridTop: grid,
  distributions,
  questionStats,
  scoreDistributions,
  boundaries,
  autoSubset,
  items: scored.map((item) => ({
    id: item.id,
    label: item.label,
    question: item.question,
    text: item.text,
    scores: item.scores,
    priority: round4(item.priority),
    latencyMs: item.latencyMs,
    currentLevel: classify(item.priority, DEFAULT_THRESHOLDS),
    currentThresholdLevel: classify(item.priority, DEFAULT_THRESHOLDS),
    recommendedLevel: classify(item.priority, recommended.thresholds),
  })),
}

writeFileSync(join(OUT_DIR, 'calibration.json'), `${JSON.stringify(calibration, null, 2)}\n`)
writeFileSync(join(OUT_DIR, 'corpus.json'), `${JSON.stringify(corpus, null, 2)}\n`)

// Human-readable console summary.
const pct = (value) => `${(value * 100).toFixed(1)}%`
const thresholdsText = (thresholds) => `${thresholds.critical.toFixed(2)}/${thresholds.medium.toFixed(2)}/${thresholds.low.toFixed(2)}`
console.log('')
console.log(`[current ${thresholdsText(DEFAULT_THRESHOLDS)}] acc=${pct(current.accuracy)} within1=${pct(current.withinOne)} ordinalMAE=${current.ordinalMAE.toFixed(3)} balancedAcc=${pct(current.balancedAccuracy)} macroF1=${pct(current.macroF1)} counts=${JSON.stringify(current.counts)}`)
console.log(`[recommended ${thresholdsText(recommended.thresholds)}] acc=${pct(recommended.accuracy)} within1=${pct(recommended.withinOne)} ordinalMAE=${recommended.ordinalMAE.toFixed(3)} balancedAcc=${pct(recommended.balancedAccuracy)} macroF1=${pct(recommended.macroF1)} counts=${JSON.stringify(recommended.counts)}`)
console.log(`[critical] current prec=${pct(current.criticalPrecision)} rec=${pct(current.criticalRecall)} | recommended prec=${pct(recommended.criticalPrecision)} rec=${pct(recommended.criticalRecall)}`)
console.log('[grid top 5]')
for (const candidate of grid.slice(0, 5)) {
  console.log(`  ${thresholdsText(candidate.thresholds)} acc=${pct(candidate.accuracy)} balAcc=${pct(candidate.balancedAccuracy)} macroF1=${pct(candidate.macroF1)} counts=${JSON.stringify(candidate.counts)}`)
}
console.log('[class priority distributions]')
for (const label of ORDER) {
  const dist = distributions[label]
  console.log(`  ${label.padEnd(8)} n=${dist.n} min=${dist.min.toFixed(3)} p25=${dist.p25.toFixed(3)} median=${dist.median.toFixed(3)} p75=${dist.p75.toFixed(3)} max=${dist.max.toFixed(3)}`)
}
console.log('[boundary AUC]', Object.fromEntries(Object.entries(boundaries).map(([key, value]) => [key, value === null ? null : round4(value)])))
if (autoSubset !== null) {
  console.log('[auto stability]', autoSubset.map((entry) => `${entry.id}: never=${entry.priorityNever.toFixed(3)} auto=${entry.priorityAuto.toFixed(3)} Δ=${entry.delta.toFixed(3)} thought=${entry.thought?.used ?? false}`).join(' | '))
}
console.log(`[calibrate] wrote ${join(OUT_DIR, 'calibration.json')}`)
