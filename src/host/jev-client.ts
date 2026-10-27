/**
 * TypeSafe Jev client: one POST /v1/systemone per planned request.
 *
 * Design points:
 * - The four product questions are `noul` questions: Jev answers each with
 *   P(yes) ∈ [0,1]. The code owns aggregation (`combinePriority`) so a model
 *   swap cannot silently change the ranking.
 * - Oversized units are cut on line/sentence boundaries into sub-chunks; each
 *   request is budget-checked (config budget + the provider hard caps) before
 *   it is sent.
 * - Sub-chunk answers combine per question with `max`, so a warning or answer
 *   buried in one part is never diluted by calmer neighbours.
 * - A verdict cache keyed by content hash avoids paying again for replayed
 *   content.
 * - A fair semaphore caps in-flight requests; abort signals cancel both queued
 *   and in-flight requests (turn abandonment, session dispose, plugin unload,
 *   timeout).
 */
import {
  combinePriority,
  type ContentUnit,
  type JevSystemOneResponse,
  type JudgeProvider,
  type NoulScores,
  type StartLuxThinkMode,
  type UnitContext,
} from '../contract.js'
import { LruVerdictCache, cacheKeyForUnit } from './cache.js'
import {
  JevAbortError,
  JevBudgetError,
  JevHttpError,
  JevParseError,
  JevTimeoutError,
  isAbortLike,
} from './errors.js'
import { Semaphore } from './semaphore.js'
import { combineSignals, createTimeoutSignal, sleep } from './signals.js'
import {
  FIXED_REQUEST_OVERHEAD_TOKENS,
  HARD_STATE_QUESTION_LIMIT,
  HARD_TOTAL_LIMIT,
  assertRequestBudget,
  checkRequestBudget,
  estimateRequestTokens,
  estimateTokens,
  splitTextToTokenBudget,
} from './token-estimator.js'

/** One noul question definition. */
export interface NoulQuestion {
  id: string
  /** Single-factor, literal instruction; Jev is trained mostly on English. */
  instructions: string
}

/** Wire shape of one question value. */
export interface NoulQuestionPayload {
  type: 'noul'
  instructions: string
}

/**
 * The four product questions, using the wording verified against the TypeSafe
 * docs (`docs/jev-api.md` §2.2): single-factor, literal, yes-positive English.
 * Jev answers with P(yes), so a compound question would blur the signal the
 * code weights.
 */
export const NOUL_QUESTIONS: readonly NoulQuestion[] = [
  {
    id: 'is_core_answer',
    // `[question]` is part of the state (the user request of this turn); the
    // instruction names it so Jev knows what "the user's question" refers to.
    instructions: "Is this passage the core answer that directly resolves the user's question given in [question]?",
  },
  {
    id: 'is_actionable',
    instructions: 'Does this passage contain a concrete action, command, or step the reader can execute?',
  },
  {
    id: 'is_warning',
    instructions: 'Does this passage warn about a risk, caveat, failure mode, or limitation?',
  },
  {
    id: 'is_definition',
    instructions: 'Does this passage define or explain the meaning of a term, concept, or field?',
  },
]

/** Build the `questions` object sent to Jev, keyed by question id. */
export function buildJevQuestions(questions: readonly NoulQuestion[] = NOUL_QUESTIONS): Record<string, NoulQuestionPayload> {
  const payload: Record<string, NoulQuestionPayload> = {}
  for (const question of questions) {
    payload[question.id] = { type: 'noul', instructions: question.instructions }
  }
  return payload
}

export interface StateSource {
  text: string
  context?: UnitContext
}

/**
 * Build the Jev `state`: grounding context lines followed by the verbatim
 * passage. The text is never paraphrased — the noul questions are about "this
 * passage", and changing the wording would change the answer.
 *
 * `[question]` carries the current turn's user request (bounded upstream) so
 * `is_core_answer` can be judged against it instead of guessing from the
 * passage's tone alone.
 */
export function buildStateText(source: StateSource, text: string = source.text): string {
  const parts: string[] = []
  const heading = source.context?.heading
  const before = source.context?.before
  const question = source.context?.question
  if (typeof heading === 'string' && heading !== '') parts.push(`[section] ${heading}`)
  if (typeof before === 'string' && before !== '') parts.push(`[preceding line] ${before}`)
  if (typeof question === 'string' && question !== '') parts.push(`[question] ${question}`)
  parts.push('[passage]')
  parts.push(text)
  return parts.join('\n')
}

const PROBABILITY_KEYS = [
  'noul',
  'probability',
  'p_yes',
  'pYes',
  'p(yes)',
  'pyes',
  'yes',
  'prob',
  'confidence',
  'score',
  'mean',
  'value',
] as const

const ENVELOPE_KEYS = ['answer', 'result', 'response'] as const

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Tolerantly read P(yes) from one answer value.
 *
 * The documented shape (`answers[id].noul`) is the fast path; the parser also
 * walks `probability` / `p_yes` / nested envelopes so a minor API revision
 * does not blank every highlight.
 */
export function extractProbability(value: unknown, depth = 0): number | undefined {
  if (typeof value === 'number') return clamp01(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return clamp01(parsed)
  }
  if (value === null || typeof value !== 'object' || depth > 3) return undefined
  const record = value as Record<string, unknown>
  for (const key of PROBABILITY_KEYS) {
    if (key in record) {
      const found = extractProbability(record[key], depth + 1)
      if (found !== undefined) return found
    }
  }
  for (const key of ENVELOPE_KEYS) {
    if (key in record) {
      const found = extractProbability(record[key], depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function collectAnswerEntries(container: unknown): Map<string, unknown> {
  const entries = new Map<string, unknown>()

  const visit = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== 'object' || depth > 2) return
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item === null || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        const id =
          typeof record.id === 'string'
            ? record.id
            : typeof record.key === 'string'
              ? record.key
              : typeof record.name === 'string'
                ? record.name
                : ''
        if (id !== '') entries.set(id, record)
        else visit(record, depth + 1)
      }
      return
    }
    const record = node as Record<string, unknown>
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'number') {
        entries.set(key, value)
        continue
      }
      if (value === null || typeof value !== 'object') continue
      // Any object value may be the answer for its key; extractProbability walks
      // nested envelopes (`{ answer: { noul } }`) itself. Nested containers are
      // visited too so `{ answers: { group: { q: {...} } } }` still resolves.
      if (!entries.has(key)) entries.set(key, value)
      visit(value, depth + 1)
    }
  }

  visit(container, 0)
  return entries
}

function findEntry(entries: Map<string, unknown>, id: string): unknown {
  if (entries.has(id)) return entries.get(id)
  const lower = id.toLowerCase()
  for (const [key, value] of entries) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}

/** Result of parsing one response: scores plus the ids that failed to resolve. */
export interface ParsedSystemOneScores {
  scores: NoulScores
  /** Question ids whose answers were missing, malformed or non-noul. */
  missing: string[]
  /** True when every requested question produced a valid noul probability. */
  complete: boolean
}

/**
 * Parse a systemOne response into the four scores.
 *
 * Canonical contract (`docs/jev-api.md` §3.2): `answers.<id>.{type:'noul',
 * noul:<0..1>}`. `probability` / `p_yes` / nested envelopes are tolerated for
 * older gateways; every other shape is reported as missing so the caller can
 * treat the response as a contract violation instead of inventing a score.
 */
export function parseSystemOneScoresDetailed(
  payload: unknown,
  questions: readonly NoulQuestion[] = NOUL_QUESTIONS,
): ParsedSystemOneScores {
  const response = (payload ?? {}) as Record<string, unknown>
  const candidates: unknown[] = [response.answers, response.results, response.scores, response.noul, response]
  let entries = new Map<string, unknown>()
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue
    const found = collectAnswerEntries(candidate)
    if (found.size > 0) {
      entries = found
      break
    }
  }
  const scores: Record<string, number> = {}
  const missing: string[] = []
  for (const question of questions) {
    const entry = findEntry(entries, question.id)
    if (entry === undefined) {
      scores[question.id] = 0
      missing.push(question.id)
      continue
    }
    if (entry !== null && typeof entry === 'object') {
      const type = (entry as Record<string, unknown>).type
      if (typeof type === 'string' && type !== 'noul') {
        scores[question.id] = 0
        missing.push(question.id)
        continue
      }
    }
    const probability = extractProbability(entry)
    if (probability === undefined) {
      scores[question.id] = 0
      missing.push(question.id)
      continue
    }
    scores[question.id] = probability
  }
  return { scores: scores as unknown as NoulScores, missing, complete: missing.length === 0 }
}

/** Lenient wrapper for callers/tests that only need the numbers. */
export function parseSystemOneScores(
  payload: unknown,
  questions: readonly NoulQuestion[] = NOUL_QUESTIONS,
): NoulScores {
  return parseSystemOneScoresDetailed(payload, questions).scores
}

/** Per-question max across sub-chunk answers: risk is not diluted. */
export function combineScoresMax(
  scoreList: readonly NoulScores[],
  questions: readonly NoulQuestion[] = NOUL_QUESTIONS,
): NoulScores {
  const combined: Record<string, number> = {}
  for (const question of questions) combined[question.id] = 0
  for (const scores of scoreList) {
    const record = scores as unknown as Record<string, number>
    for (const question of questions) {
      const value = typeof record[question.id] === 'number' ? (record[question.id] as number) : 0
      const previous = combined[question.id] ?? 0
      if (value > previous) combined[question.id] = value
    }
  }
  return combined as unknown as NoulScores
}

/** One planned HTTP request for one (possibly sub-chunked) unit. */
export interface UnitRequestPlan {
  text: string
  state: string
  estimatedTokens: number
}

export interface PlanUnitRequestsOptions {
  requestTokenBudget: number
  unitTokenBudget: number
  questions?: readonly NoulQuestion[]
  /** Guard against runaway splitting; defaults to {@link MAX_SUB_CHUNKS}. */
  maxSubChunks?: number
}

/** A unit is never split into more requests than this. */
export const MAX_SUB_CHUNKS = 64

const MIN_CONTENT_TOKENS = 24
const CONTEXT_SAFETY_TOKENS = 8

/**
 * Plan the request(s) for one unit.
 *
 * A unit that fits is one request. An oversized unit is cut on line, sentence
 * then character boundaries until every request satisfies the config budget
 * and the provider hard caps. Context is shortened before content when the
 * overhead alone would starve the content budget.
 */
export function planUnitRequests(unit: StateSource, options: PlanUnitRequestsOptions): UnitRequestPlan[] {
  const questions = options.questions ?? NOUL_QUESTIONS
  const questionTexts = questions.map((question) => question.instructions)
  const requestTokenBudget = Math.max(1, Math.floor(options.requestTokenBudget))
  const unitTokenBudget = Math.max(1, Math.floor(options.unitTokenBudget))
  const maxSubChunks = Math.max(1, Math.floor(options.maxSubChunks ?? MAX_SUB_CHUNKS))

  const fullState = buildStateText(unit)
  const fullCheck = checkRequestBudget(fullState, questionTexts, requestTokenBudget)
  const unitTokens = estimateTokens(unit.text)
  const fullFits =
    fullCheck.withinRequestBudget &&
    fullCheck.withinHardStateQuestionLimit &&
    fullCheck.withinHardTotalLimit &&
    unitTokens <= unitTokenBudget
  if (fullFits) {
    return [{ text: unit.text, state: fullState, estimatedTokens: fullCheck.estimatedTokens }]
  }

  const longestQuestionTokens = fullCheck.longestQuestionTokens
  const questionOverhead = longestQuestionTokens + FIXED_REQUEST_OVERHEAD_TOKENS

  let context: UnitContext = {}
  if (typeof unit.context?.heading === 'string' || typeof unit.context?.before === 'string') {
    context = { ...unit.context }
  }
  const contextTokensFor = (candidate: UnitContext): number => estimateTokens(buildStateText({ text: '', context: candidate }))
  const maxStateTokens = (): number =>
    Math.min(
      requestTokenBudget - questionOverhead,
      HARD_STATE_QUESTION_LIMIT - longestQuestionTokens,
      HARD_TOTAL_LIMIT - questionOverhead,
    )

  if (maxStateTokens() - contextTokensFor(context) - CONTEXT_SAFETY_TOKENS < MIN_CONTENT_TOKENS) {
    if (context.before !== undefined) {
      const { before: _droppedBefore, ...rest } = context
      context = rest
    }
    if (maxStateTokens() - contextTokensFor(context) - CONTEXT_SAFETY_TOKENS < MIN_CONTENT_TOKENS) {
      context = {}
    }
  }

  const contentBudget = Math.max(
    MIN_CONTENT_TOKENS,
    Math.floor(Math.min(unitTokenBudget, maxStateTokens() - contextTokensFor(context) - CONTEXT_SAFETY_TOKENS)),
  )

  const plans: UnitRequestPlan[] = []
  const source: StateSource = { text: unit.text, context }

  const addPlan = (chunkText: string, depth: number): void => {
    const state = buildStateText(source, chunkText)
    const check = checkRequestBudget(state, questionTexts, requestTokenBudget)
    if (check.withinRequestBudget && check.withinHardStateQuestionLimit && check.withinHardTotalLimit) {
      plans.push({ text: chunkText, state, estimatedTokens: check.estimatedTokens })
      return
    }
    if (depth >= 8 || chunkText.length <= 1) {
      throw new JevBudgetError(
        `cannot fit a Jev request: estimate ${check.estimatedTokens} tokens, budget ${requestTokenBudget} tokens`,
      )
    }
    const halfBudget = Math.max(1, Math.floor(estimateTokens(chunkText) / 2))
    const pieces = splitTextToTokenBudget(chunkText, halfBudget)
    if (pieces.length <= 1) {
      throw new JevBudgetError(
        `cannot split a Jev request below budget ${requestTokenBudget} tokens (estimate ${check.estimatedTokens})`,
      )
    }
    for (const piece of pieces) addPlan(piece, depth + 1)
  }

  const chunks = splitTextToTokenBudget(unit.text, contentBudget)
  const initialChunks = chunks.length > 0 ? chunks : [unit.text]
  if (initialChunks.length > maxSubChunks) {
    throw new JevBudgetError(
      `unit requires ${initialChunks.length} sub-chunks (limit ${maxSubChunks}); raise unitTokenBudget or split the message`,
    )
  }
  for (const chunk of initialChunks) addPlan(chunk, 0)
  return plans
}

/** Minimal fetch surface the client needs; injected in tests. */
export interface JevFetchResponse {
  ok: boolean
  status: number
  statusText?: string
  headers?: { get(name: string): string | null } | Readonly<Record<string, string | undefined>>
  text(): Promise<string>
}

export interface JevFetchInit {
  method: string
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}

export type JevFetchLike = (url: string, init: JevFetchInit) => Promise<JevFetchResponse>

export interface JevClientOptions {
  apiKey: string
  /** Judge backend; selects the wire shape/endpoint defaults. */
  provider?: JudgeProvider
  baseUrl?: string
  model?: string
  /** Path appended to baseUrl (defaults: /v1/systemone for jev, /decisions for startlux). */
  endpointPath?: string
  /** StartLux request control forwarded when provider === 'startlux'. */
  thinkMode?: StartLuxThinkMode
  fetchImpl?: JevFetchLike
  timeoutMs?: number
  maxConcurrency?: number
  requestTokenBudget?: number
  unitTokenBudget?: number
  cache?: LruVerdictCache
  retryBaseMs?: number
  maxRetries?: number
  log?: (message: string) => void
}

export interface JevClientStats {
  requests: number
  inFlight: number
  maxConcurrentObserved: number
  maxRequestTokensObserved: number
  abortedRequests: number
  failures: number
  cacheHits: number
  cacheMisses: number
  cacheSize: number
}

export interface JevJudgeResult {
  scores: NoulScores
  cached: boolean
  priority: number
  requestCount: number
}

export interface SystemOneInput {
  state: string
  questions?: Record<string, NoulQuestionPayload>
  signal?: AbortSignal
}

export interface JudgeUnitOptions {
  signal?: AbortSignal
}

const DEFAULT_MODEL = 'jev-1.13.0'
const DEFAULT_BASE_URL = 'https://api.typesafe.ai'

function normaliseBaseUrl(baseUrl: string | undefined): string {
  const value = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  const resolved = value === '' ? DEFAULT_BASE_URL : value
  return resolved.replace(/\/+$/u, '')
}

function normaliseEndpointPath(path: string | undefined, fallback: string): string {
  const value = typeof path === 'string' ? path.trim() : ''
  if (value === '') return fallback
  return value.startsWith('/') ? value : `/${value}`
}

function readRetryAfterMs(response: JevFetchResponse): number | undefined {
  const headers = response.headers
  if (headers === undefined) return undefined
  let raw: string | null | undefined
  const withGet = headers as { get?: unknown }
  if (typeof withGet.get === 'function') {
    raw = (withGet.get as (name: string) => string | null).call(headers, 'retry-after')
  } else {
    const record = headers as Readonly<Record<string, string | undefined>>
    raw = record['retry-after'] ?? record['Retry-After']
  }
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const seconds = Number(raw.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(raw)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

function defaultFetch(url: string, init: JevFetchInit): Promise<JevFetchResponse> {
  return fetch(url, init) as unknown as Promise<JevFetchResponse>
}

/**
 * Best-effort, bounded reason for a failed response.
 *
 * TypeSafe answers failures with a JSON body such as
 * `{"title":"Typesafe is not available in your region.","status":451}`; the
 * title makes `/diag` actionable (region block vs bad key vs rate limit).
 * Response bodies never contain our key, but the text is still bounded and
 * only used for diagnostics.
 */
async function readErrorDetail(response: JevFetchResponse): Promise<string> {
  try {
    const text = await response.text()
    if (typeof text !== 'string' || text.trim() === '') return ''
    let detail = text.trim()
    try {
      const parsed: unknown = JSON.parse(detail)
      if (parsed !== null && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>
        const candidate =
          typeof record.title === 'string'
            ? record.title
            : typeof record.error === 'string'
              ? record.error
              : typeof record.message === 'string'
                ? record.message
                : ''
        if (candidate !== '') detail = candidate
      }
    } catch {
      // Keep the raw body when it is not JSON.
    }
    return detail.length > 160 ? `${detail.slice(0, 160)}…` : detail
  } catch {
    return ''
  }
}

export class JevClient {
  readonly model: string
  readonly provider: JudgeProvider
  private apiKey: string
  private readonly baseUrl: string
  private readonly endpointPath: string
  private thinkMode: StartLuxThinkMode | undefined
  private readonly fetchImpl: JevFetchLike
  private readonly timeoutMs: number
  private readonly requestTokenBudget: number
  private readonly unitTokenBudget: number
  private readonly cache: LruVerdictCache
  private readonly semaphore: Semaphore
  private readonly retryBaseMs: number
  private readonly maxRetries: number
  private readonly log: (message: string) => void

  private requests = 0
  private inFlight = 0
  private maxConcurrentObserved = 0
  private maxRequestTokensObserved = 0
  private abortedRequests = 0
  private failures = 0

  constructor(options: JevClientOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new Error('JevClient requires a non-empty API key')
    }
    this.apiKey = options.apiKey
    this.provider = options.provider === 'startlux' ? 'startlux' : 'jev'
    this.baseUrl = normaliseBaseUrl(options.baseUrl)
    this.endpointPath = normaliseEndpointPath(options.endpointPath, this.provider === 'startlux' ? '/decisions' : '/v1/systemone')
    this.thinkMode = this.provider === 'startlux' ? options.thinkMode : undefined
    this.model = typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : DEFAULT_MODEL
    this.fetchImpl = options.fetchImpl ?? defaultFetch
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 30000))
    this.requestTokenBudget = Math.max(1, Math.floor(options.requestTokenBudget ?? 24000))
    this.unitTokenBudget = Math.max(1, Math.floor(options.unitTokenBudget ?? 20000))
    this.cache = options.cache ?? new LruVerdictCache({ capacity: 500 })
    this.semaphore = new Semaphore(Math.max(1, Math.floor(options.maxConcurrency ?? 8)))
    this.retryBaseMs = Math.max(0, Math.floor(options.retryBaseMs ?? 500))
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2))
    this.log = options.log ?? (() => {})
  }

  get endpoint(): string {
    return `${this.baseUrl}${this.endpointPath}`
  }

  /** Swap the key at runtime when the Settings tab saves/clears one. */
  setApiKey(apiKey: string): void {
    this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : ''
  }

  /** Switch StartLux think_mode at runtime (Settings tab). */
  setThinkMode(mode: StartLuxThinkMode): void {
    if (this.provider === 'startlux') this.thinkMode = mode
  }

  /** True when a key is currently configured on this client. */
  hasApiKey(): boolean {
    return this.apiKey !== ''
  }

  /** Live counters for diagnostics. */
  stats(): JevClientStats {
    const cacheStats = this.cache.stats()
    return {
      requests: this.requests,
      inFlight: this.inFlight,
      maxConcurrentObserved: this.maxConcurrentObserved,
      maxRequestTokensObserved: this.maxRequestTokensObserved,
      abortedRequests: this.abortedRequests,
      failures: this.failures,
      cacheHits: cacheStats.hits,
      cacheMisses: cacheStats.misses,
      cacheSize: cacheStats.size,
    }
  }

  /** One budget-checked systemOne call. */
  async systemOne(input: SystemOneInput): Promise<JevSystemOneResponse> {
    const questions = input.questions ?? buildJevQuestions()
    const questionTexts = Object.values(questions).map((question) => question.instructions)
    const estimatedTokens = estimateRequestTokens(input.state, questionTexts)
    this.observeRequestTokens(estimatedTokens)
    // Defence in depth: the planner already respected the budget, this assert
    // protects every other caller of systemOne.
    assertRequestBudget(input.state, questionTexts, this.requestTokenBudget)
    const body = JSON.stringify({
      model: this.model,
      state: input.state,
      questions,
      ...(this.provider === 'startlux' && this.thinkMode !== undefined ? { think_mode: this.thinkMode } : {}),
    })
    return await this.request(body, input.signal)
  }

  /**
   * Judge one content unit. Returns combined per-question scores; identical
   * content served from the LRU cache performs no network request.
   *
   * `stats().failures` counts failed *judgements* (after retries), not failed
   * HTTP attempts; aborted judgements are not failures.
   */
  async judgeUnit(unit: ContentUnit, options: JudgeUnitOptions = {}): Promise<JevJudgeResult> {
    try {
      return await this.judgeUnitInternal(unit, options)
    } catch (error) {
      if (!isAbortLike(error)) this.failures += 1
      throw error
    }
  }

  private async judgeUnitInternal(unit: ContentUnit, options: JudgeUnitOptions): Promise<JevJudgeResult> {
    const cacheKey = cacheKeyForUnit(unit, this.model)
    const cachedScores = this.cache.get(cacheKey)
    if (cachedScores !== undefined) {
      return { scores: cachedScores, cached: true, priority: combinePriority(cachedScores), requestCount: 0 }
    }

    const plans = planUnitRequests(unit, {
      requestTokenBudget: this.requestTokenBudget,
      unitTokenBudget: this.unitTokenBudget,
      questions: NOUL_QUESTIONS,
    })
    const ask = async (): Promise<NoulScores[]> =>
      Promise.all(
        plans.map(async (plan) => {
          const response = await this.systemOne({ state: plan.state, signal: options.signal })
          const parsed = parseSystemOneScoresDetailed(response)
          if (!parsed.complete) {
            throw new JevParseError(`Jev response is missing noul answers for: ${parsed.missing.join(', ')}`)
          }
          return parsed.scores
        }),
      )
    let responses: NoulScores[]
    try {
      responses = await ask()
    } catch (error) {
      // `docs/jev-api.md` §10.1: a 200 with a broken body is a contract
      // violation — retry once, then surface the failure so the unit is
      // skipped instead of being scored as if it were unimportant.
      if (!(error instanceof JevParseError) || options.signal?.aborted === true) throw error
      this.log('[jev-highlight] Jev response violated the noul contract; retrying once')
      responses = await ask()
    }
    const scores = combineScoresMax(responses)
    this.cache.set(cacheKey, scores)
    return { scores, cached: false, priority: combinePriority(scores), requestCount: plans.length }
  }

  private async request(body: string, signal?: AbortSignal): Promise<JevSystemOneResponse> {
    let attempt = 0
    for (;;) {
      this.throwIfAborted(signal)
      const release = await this.acquireSlot(signal)
      const timeout = createTimeoutSignal(this.timeoutMs)
      try {
        const requestSignal = combineSignals([signal, timeout.signal])
        this.requests += 1
        this.beginInFlight()
        let response: JevFetchResponse
        try {
          response = await this.fetchImpl(this.endpoint, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.apiKey}`,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body,
            signal: requestSignal,
          })
        } catch (error) {
          if (signal?.aborted) {
            this.abortedRequests += 1
            throw new JevAbortError('Jev request aborted')
          }
          if (timeout.signal.aborted) {
            throw new JevTimeoutError(`Jev request timed out after ${this.timeoutMs}ms`)
          }
          if (isAbortLike(error)) {
            this.abortedRequests += 1
            throw new JevAbortError('Jev request aborted')
          }
          if (attempt < this.maxRetries) {
            await this.backoff(attempt, undefined, signal)
            attempt += 1
            continue
          }
          throw error
        } finally {
          this.endInFlight()
          timeout.clear()
        }

        if (!response.ok) {
          const status = Math.floor(response.status)
          const retryable = status === 429 || status >= 500
          if (retryable && attempt < this.maxRetries) {
            await this.backoff(attempt, readRetryAfterMs(response), signal)
            attempt += 1
            continue
          }
          const detail = await readErrorDetail(response)
          const hint =
            status === 401
              ? ' — check the configured API key (Settings → 插件 → Jev 高亮 for StartLux, STARTLUX_API_KEY / BAMBOO_API_KEY, or JEV_API_KEY / TYPESAFE_API_KEY for Jev)'
              : status === 451
                ? ' — the upstream API is not available from this network region; use the StartLux provider or a supported region'
                : ''
          throw new JevHttpError(
            status,
            `Jev API responded with HTTP ${status}${
              typeof response.statusText === 'string' && response.statusText !== '' ? ` ${response.statusText}` : ''
            }${detail !== '' ? `: ${detail}` : ''}${retryable ? ' (retries exhausted)' : ''}${hint}`,
          )
        }

        return await this.readJson(response)
      } finally {
        release()
      }
    }
  }

  private async readJson(response: JevFetchResponse): Promise<JevSystemOneResponse> {
    const text = await response.text()
    if (typeof text !== 'string' || text.trim() === '') return {}
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object') return parsed as JevSystemOneResponse
      throw new JevParseError('Jev API returned a non-object JSON document')
    } catch (error) {
      if (error instanceof JevParseError) throw error
      throw new JevParseError(`Jev API returned a non-JSON body (${text.length} characters)`)
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      this.abortedRequests += 1
      throw new JevAbortError('Jev request aborted before it started')
    }
  }

  private async acquireSlot(signal?: AbortSignal): Promise<() => void> {
    try {
      return await this.semaphore.acquire(signal)
    } catch (error) {
      if (isAbortLike(error)) this.abortedRequests += 1
      throw error
    }
  }

  private async backoff(attempt: number, retryAfterMs: number | undefined, signal?: AbortSignal): Promise<void> {
    const exponential = this.retryBaseMs * 2 ** attempt
    const base = retryAfterMs ?? exponential
    const capped = Math.min(5000, Math.max(0, base))
    const jitter = capped > 0 ? Math.floor(Math.random() * Math.min(50, Math.floor(capped / 4) + 1)) : 0
    this.log(`[jev-highlight] retrying Jev request after ${capped + jitter}ms (attempt ${attempt + 1})`)
    await sleep(capped + jitter, signal)
  }

  private beginInFlight(): void {
    this.inFlight += 1
    if (this.inFlight > this.maxConcurrentObserved) this.maxConcurrentObserved = this.inFlight
  }

  private endInFlight(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
  }

  private observeRequestTokens(tokens: number): void {
    if (tokens > this.maxRequestTokensObserved) this.maxRequestTokensObserved = tokens
  }
}
