/**
 * Conservative token estimation.
 *
 * The estimator deliberately over-counts instead of under-counting: a request
 * that is wrongly judged "too small" can exceed the provider's context window
 * and fail, while an over-estimate only splits one extra time.
 *
 * Base rates come from `docs/jev-token-calibration.json`, produced by the
 * jev-api workstream from 1,980 real `usage.input_tokens` pairs plus
 * triangulation over three documented TypeSafe responses:
 *
 *   1.05 token / CJK char, 0.35 token / other char, 320 tokens fixed overhead
 *   for a four-noul question set.
 *
 * The live calibration endpoint was region-blocked (HTTP 451) when measured,
 * so a safety factor of 1.15 is applied on top of the calibrated numbers. The
 * result is >= the "CJK 1 token/char, ASCII 1/3.5 chars" rule of thumb from
 * the task, i.e. strictly conservative.
 */
import { JevBudgetError } from './errors.js'

/** CJK, Hangul, kana and full-width forms: 1 token per code point. */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2e80, 0x2eff], // CJK radicals supplement
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3040, 0x30ff], // hiragana + katakana
  [0x3130, 0x318f], // hangul compatibility jamo
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa960, 0xa97f], // hangul jamo extended-A
  [0xac00, 0xd7af], // hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff00, 0xffef], // half-width / full-width forms
  [0x1f200, 0x1f2ff], // enclosed ideographic supplement
  [0x20000, 0x2fa1f], // CJK extensions B..F
]

/** Multiplier applied on top of the calibrated rates (see file header). */
export const ESTIMATE_SAFETY_FACTOR = 1.15
/** Measured token rate for CJK / Hangul / kana / full-width characters. */
export const CALIBRATED_CJK_TOKENS_PER_CHAR = 1.05
/** Measured token rate for everything else (English prose, JSON, code). */
export const CALIBRATED_ASCII_TOKENS_PER_CHAR = 0.35
/** Measured fixed overhead of a four-noul request (envelope + formatting). */
export const CALIBRATED_REQUEST_OVERHEAD = 320
/** Effective CJK weight after the safety factor. */
export const CJK_TOKENS_PER_CHAR = CALIBRATED_CJK_TOKENS_PER_CHAR * ESTIMATE_SAFETY_FACTOR
/** Effective non-CJK weight after the safety factor. */
export const ASCII_TOKENS_PER_CHAR = CALIBRATED_ASCII_TOKENS_PER_CHAR * ESTIMATE_SAFETY_FACTOR
/** Effective fixed protocol overhead per request. */
export const FIXED_REQUEST_OVERHEAD_TOKENS = Math.ceil(CALIBRATED_REQUEST_OVERHEAD * ESTIMATE_SAFETY_FACTOR)
/** Hard provider-side ceiling for state + longest question. */
export const HARD_STATE_QUESTION_LIMIT = 32000
/** Hard provider-side ceiling for the whole request estimate. */
export const HARD_TOTAL_LIMIT = 64000

function isCjk(codePoint: number): boolean {
  for (const [start, end] of CJK_RANGES) {
    if (codePoint >= start && codePoint <= end) return true
  }
  return false
}

/**
 * Estimate the token count of arbitrary text, conservatively.
 *
 * An empty or non-string input estimates to 0; callers that need a floor add
 * it themselves.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  let other = 0
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    if (isCjk(codePoint)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + other * ASCII_TOKENS_PER_CHAR)
}

/** Estimate the token cost of a JSON value from its actual serialized length. */
export function estimateJsonTokens(value: unknown): number {
  let text: string
  try {
    text = JSON.stringify(value) ?? ''
  } catch {
    text = String(value)
  }
  return estimateTokens(text)
}

/**
 * Estimate one Jev request:
 *   estimate(state) + estimate(longest question) + fixed protocol overhead.
 */
export function estimateRequestTokens(
  state: string,
  questionTexts: readonly string[],
  fixedOverheadTokens: number = FIXED_REQUEST_OVERHEAD_TOKENS,
): number {
  const stateTokens = estimateTokens(state)
  let longestQuestionTokens = 0
  for (const question of questionTexts) {
    const tokens = estimateTokens(question)
    if (tokens > longestQuestionTokens) longestQuestionTokens = tokens
  }
  return stateTokens + longestQuestionTokens + fixedOverheadTokens
}

/** Breakdown of one budget check, also useful in diagnostics and tests. */
export interface RequestBudgetCheck {
  estimatedTokens: number
  stateTokens: number
  longestQuestionTokens: number
  requestTokenBudget: number
  withinRequestBudget: boolean
  withinHardStateQuestionLimit: boolean
  withinHardTotalLimit: boolean
}

/** Evaluate every budget invariant for one planned request. */
export function checkRequestBudget(
  state: string,
  questionTexts: readonly string[],
  requestTokenBudget: number,
  fixedOverheadTokens: number = FIXED_REQUEST_OVERHEAD_TOKENS,
): RequestBudgetCheck {
  const stateTokens = estimateTokens(state)
  let longestQuestionTokens = 0
  for (const question of questionTexts) {
    const tokens = estimateTokens(question)
    if (tokens > longestQuestionTokens) longestQuestionTokens = tokens
  }
  const estimatedTokens = stateTokens + longestQuestionTokens + fixedOverheadTokens
  return {
    estimatedTokens,
    stateTokens,
    longestQuestionTokens,
    requestTokenBudget,
    withinRequestBudget: estimatedTokens <= requestTokenBudget,
    withinHardStateQuestionLimit: stateTokens + longestQuestionTokens <= HARD_STATE_QUESTION_LIMIT,
    withinHardTotalLimit: estimatedTokens <= HARD_TOTAL_LIMIT,
  }
}

/**
 * Throw when one planned request violates any budget invariant.
 *
 * `requestTokenBudget` is the config-level target; the two hard limits mirror
 * the provider's absolute caps and must never be crossed even with a raised
 * config value.
 */
export function assertRequestBudget(
  state: string,
  questionTexts: readonly string[],
  requestTokenBudget: number,
  fixedOverheadTokens: number = FIXED_REQUEST_OVERHEAD_TOKENS,
): number {
  const check = checkRequestBudget(state, questionTexts, requestTokenBudget, fixedOverheadTokens)
  if (!check.withinHardTotalLimit) {
    throw new JevBudgetError(
      `Jev request estimate ${check.estimatedTokens} exceeds the hard total limit ${HARD_TOTAL_LIMIT} tokens`,
    )
  }
  if (!check.withinHardStateQuestionLimit) {
    throw new JevBudgetError(
      `Jev request state ${check.stateTokens} + longest question ${check.longestQuestionTokens} tokens exceeds the hard limit ${HARD_STATE_QUESTION_LIMIT} tokens`,
    )
  }
  if (!check.withinRequestBudget) {
    throw new JevBudgetError(
      `Jev request estimate ${check.estimatedTokens} exceeds requestTokenBudget ${requestTokenBudget} tokens`,
    )
  }
  return check.estimatedTokens
}

/** Split a single long line into pieces whose estimate stays inside the budget. */
function hardSplitByTokenBudget(line: string, tokenBudget: number): string[] {
  const budget = Math.max(1, tokenBudget)
  const pieces: string[] = []
  let start = 0
  let cost = 0
  let index = 0
  for (const character of line) {
    const codePoint = character.codePointAt(0) ?? 0
    const weight = isCjk(codePoint) ? CJK_TOKENS_PER_CHAR : ASCII_TOKENS_PER_CHAR
    if (cost + weight > budget && index > start) {
      pieces.push(line.slice(start, index))
      start = index
      cost = 0
    }
    cost += weight
    index += character.length
  }
  if (index > start) pieces.push(line.slice(start, index))
  return pieces.filter((piece) => piece.length > 0)
}

/** Sentence-ish boundaries that keep sub-chunks single-factor for Jev. */
const SENTENCE_BOUNDARY = /(?<=[。！？；.!?;])/u

function splitLineIntoSentences(line: string): string[] {
  return line
    .split(SENTENCE_BOUNDARY)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

/**
 * Split text into ordered chunks whose estimated token count is at most
 * `tokenBudget`, preferring line boundaries, then sentence boundaries, then a
 * hard character cut. Chunk text is trimmed but the original order and the
 * bulk of the content are preserved.
 */
export function splitTextToTokenBudget(text: string, tokenBudget: number): string[] {
  const budget = Math.max(1, Math.floor(tokenBudget))
  const chunks: string[] = []

  const pushChunk = (lines: string[]): void => {
    const chunk = lines.join('\n').trim()
    if (chunk !== '') chunks.push(chunk)
  }

  for (const line of text.split('\n')) {
    const lineTokens = estimateTokens(line)
    if (lineTokens <= budget) {
      // A line fits: append to the trailing chunk when the joined estimate fits.
      const tail = chunks.length > 0 ? chunks[chunks.length - 1] ?? '' : ''
      if (tail !== '' && estimateTokens(`${tail}\n${line}`) <= budget) {
        chunks[chunks.length - 1] = `${tail}\n${line}`.trim()
      } else if (line.trim() !== '') {
        chunks.push(line.trim())
      }
      continue
    }
    // A single line is too large: cut it on sentence boundaries, then hard-cut.
    const sentences = splitLineIntoSentences(line)
    if (sentences.length <= 1) {
      chunks.push(...hardSplitByTokenBudget(line, budget))
      continue
    }
    let current: string[] = []
    for (const sentence of sentences) {
      const candidate = current.length === 0 ? sentence : `${current.join(' ')} ${sentence}`
      if (estimateTokens(candidate) <= budget) {
        current.push(sentence)
        continue
      }
      if (current.length > 0) {
        pushChunk(current)
        current = []
      }
      if (estimateTokens(sentence) <= budget) current.push(sentence)
      else chunks.push(...hardSplitByTokenBudget(sentence, budget))
    }
    if (current.length > 0) pushChunk(current)
  }

  return chunks
}
