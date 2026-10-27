/**
 * Contract shared by the host half and the client half.
 *
 * Keep this file free of Node and DOM APIs: it is bundled into both halves.
 */

/** Semantic unit kinds the splitter recognises. */
export type UnitType = 'paragraph' | 'list_item' | 'code_block' | 'table_row'

/** Highlight intensity buckets; `none` means "judged, but not important enough". */
export type HighlightLevel = 'critical' | 'medium' | 'low'

/** Neighbouring context attached to a unit, used only to ground the Jev question. */
export interface UnitContext {
  /** The nearest preceding heading (markdown heading text, without #). */
  heading?: string
  /** Last line of the previous unit (bounded). */
  before?: string
  /**
   * The user request that the current turn is answering (bounded). Injected
   * into the Jev state as `[question]` so `is_core_answer` is judged against
   * the actual request instead of only the passage's wording.
   */
  question?: string
}

/** One semantic content unit produced by the streaming splitter. */
export interface ContentUnit {
  /** Stable id: sessionId:attemptId:blockIndex:ordinal. */
  id: string
  sessionId: string
  attemptId: string
  blockIndex: number
  type: UnitType
  /** Verbatim unit text, trimmed, without fence markers. */
  text: string
  context: UnitContext
}

/** The four noul questions, each answered with P(yes) in [0, 1]. */
export interface NoulScores {
  is_core_answer: number
  is_actionable: number
  is_warning: number
  is_definition: number
}

/** One judged unit, ready for the client half. */
export interface UnitVerdict {
  /** Monotonic sequence per host process; the client polls with `since`. */
  seq: number
  unitId: string
  sessionId: string
  type: UnitType
  text: string
  /**
   * Optional DOM-searchable variant. Table rows keep markdown pipes in `text`
   * (for Jev), but rendered table cells contain no `|`, so the host supplies
   * the cell-joined plain text here. Clients fall back to `text`.
   */
  matchText?: string
  context: UnitContext
  /** Weighted priority in [0, 1]. */
  priority: number
  level: HighlightLevel | 'none'
  scores: NoulScores
  model: string
  /** True when the verdict came from the local cache. */
  cached: boolean
  createdAt: number
}

/** Highlight cutoffs. */
export interface HighlightThresholds {
  critical: number
  medium: number
  low: number
}

export const DEFAULT_THRESHOLDS: HighlightThresholds = {
  critical: 0.85,
  medium: 0.65,
  low: 0.45,
}

/**
 * Calibrated cutoffs for StartLux-Decision (Bamboo Relay), which compresses
 * priorities relative to Jev/mock. Chosen from the calibration + A/B experiment:
 * synthetic accuracy 68.8%, real blind-judge accuracy 27.3% (vs 21.8% for the
 * conservative preset), with an accepted precision trade-off. Jev keeps
 * {@link DEFAULT_THRESHOLDS}.
 */
export const STARTLUX_THRESHOLDS: HighlightThresholds = {
  critical: 0.52,
  medium: 0.37,
  low: 0.24,
}

/**
 * Question template version: bump to invalidate every cached verdict.
 *
 * v2 adds the `[question]` grounding line to the state and rewords
 * `is_core_answer`, so v1 cache entries must not be reused.
 */
export const QUESTION_SET_VERSION = 'jev-highlight/questions/v2'

/** Upper bound for the user-request text injected into the Jev state. */
export const MAX_QUESTION_CHARS = 600

/** Weights from the product spec; the client only consumes `priority`. */
export const PRIORITY_WEIGHTS = {
  coreAnswer: 0.5,
  actionable: 0.3,
  warningOrDefinition: 0.2,
} as const

function unitInterval(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * Code-side weighted composition:
 *   priority = 0.5*is_core_answer + 0.3*is_actionable + 0.2*max(is_warning, is_definition)
 *
 * Jev's noul answer is P(yes); it has no independent confidence field, so the
 * code owns the aggregation and the thresholds.
 */
export function combinePriority(scores: NoulScores): number {
  const value =
    PRIORITY_WEIGHTS.coreAnswer * unitInterval(scores.is_core_answer) +
    PRIORITY_WEIGHTS.actionable * unitInterval(scores.is_actionable) +
    PRIORITY_WEIGHTS.warningOrDefinition * Math.max(unitInterval(scores.is_warning), unitInterval(scores.is_definition))
  return Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000
}

/**
 * Map a priority to an intensity bucket.
 *
 * 0.45–0.65 is deliberately `low`: that band is where a single noul judgment
 * is least separable from noise, so it renders as a weak signal, never medium.
 */
export function levelFor(priority: number, thresholds: HighlightThresholds = DEFAULT_THRESHOLDS): HighlightLevel | 'none' {
  const p = unitInterval(priority)
  if (p >= thresholds.critical) return 'critical'
  if (p >= thresholds.medium) return 'medium'
  if (p >= thresholds.low) return 'low'
  return 'none'
}

/** Judge backend. StartLux is the domestic default; Jev stays selectable. */
export type JudgeProvider = 'jev' | 'startlux'

/** StartLux AutoThink control forwarded as `think_mode`. */
export type StartLuxThinkMode = 'never' | 'auto' | 'always'

/** Runtime configuration after schema validation and normalisation. */
export interface ResolvedConfig {
  /** Which decision backend judges content units. */
  provider: JudgeProvider
  /** Literal key override; empty means "resolve from credentials/env". */
  jevApiKey: string
  jevBaseUrl: string
  model: string
  /** StartLux / Bamboo Relay settings (used when provider === 'startlux'). */
  startluxBaseUrl: string
  startluxModel: string
  startluxEndpointPath: string
  startluxThinkMode: StartLuxThinkMode
  /** Optional key-file override; empty resolves to $DSH_HOME/jev-highlight-startlux.key. */
  startluxKeyFile: string
  maxConcurrency: number
  requestTokenBudget: number
  unitTokenBudget: number
  cacheCapacity: number
  requestTimeoutMs: number
  highlightThresholds: HighlightThresholds
  autoStart: boolean
  /**
   * When true, activation fails with `MissingJevApiKeyError` if no key
   * resolves (strict mode). When false (default), the plugin still loads in
   * degraded mode: routes and the chip stay available, judging is disabled,
   * and the actionable error is exposed through /state and /diag.
   */
  requireApiKey: boolean
  debug: boolean
}

/** Answer payload shape of one Jev systemOne call (only the parts we use). */
export interface JevSystemOneResponse {
  model?: string
  answers?: Record<string, { type?: string; noul?: number; probability?: number; p_yes?: number; confidence?: number }>
  usage?: { input_tokens?: number; output_tokens?: number }
  [key: string]: unknown
}

/** Counters exposed on GET /jev-highlight/diag for acceptance checks. */
export interface DiagSnapshot {
  active: boolean
  unitsSeen: number
  unitsQueued: number
  unitsJudged: number
  requests: number
  inFlight: number
  maxConcurrentObserved: number
  maxRequestTokensObserved: number
  requestBudget: number
  concurrencyLimit: number
  cacheHits: number
  cacheMisses: number
  cacheSize: number
  abortedRequests: number
  failures: number
  droppedUnits: number
  lastError: string | null
  keySource: string | null
  /** Active judge backend and the StartLux/Jev model it calls. */
  provider: JudgeProvider
  /** False when activation continued without a resolvable provider key. */
  keyConfigured: boolean
  /** Prompt/cache schema version, useful when debugging stale verdicts. */
  questionSetVersion: string
  model: string
  baseUrl: string
  thresholdOverrides: HighlightThresholds
}
