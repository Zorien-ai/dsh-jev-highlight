/**
 * Config schema declared with Schemastery, so the Loader validates the row's
 * `config` before activation and Config inspection can project a JSON Schema.
 *
 * Credentials: `jevApiKey` is an *optional override* only. The documented
 * injection paths are the `jevApiKey` field of `$DSH_HOME/.credentials.yaml`
 * and the `JEV_API_KEY` environment variable; neither is ever hardcoded.
 */
import Schema from '@deepseek-ai/schemastery'
import type { HighlightThresholds, ResolvedConfig, StartLuxThinkMode } from '../contract.js'
import { DEFAULT_THRESHOLDS, STARTLUX_THRESHOLDS } from '../contract.js'

function threshold(label: string, value: number) {
  return Schema.number()
    .min(0)
    .max(1)
    .default(value)
    .description(`Priority cutoff for the ${label} highlight bucket (0..1).`)
}

export const Config = Schema.object({
  provider: Schema.string()
    .default('startlux')
    .description("Judge backend: 'startlux' (domestic default, OpenAI-compatible decision API) or 'jev' (TypeSafe)."),
  jevApiKey: Schema.string()
    .default('')
    .description('Jev only — optional literal override. Prefer $DSH_HOME/.credentials.yaml jevApiKey or JEV_API_KEY.'),
  jevBaseUrl: Schema.string()
    .default('https://api.typesafe.ai')
    .description('Jev only — API origin; the client appends /v1/systemone.'),
  model: Schema.string()
    .default('jev-1.13.0')
    .description('Jev model version (used when provider = jev).'),
  startluxBaseUrl: Schema.string()
    .default('https://api.bamboonode.dev/v1')
    .description('StartLux OpenAI-compatible decision API base (Bamboo Relay default).'),
  startluxModel: Schema.string()
    .default('startlux-decision-27b-autothink')
    .description('StartLux / Bamboo model id sent in the request body.'),
  startluxEndpointPath: Schema.string()
    .default('/decisions')
    .description('Path appended to startluxBaseUrl (Bamboo: /decisions; self-hosted TypeSafe-compatible: /systemone).'),
  startluxThinkMode: Schema.string()
    .default('never')
    .description("StartLux think_mode: 'never' (fastest), 'auto', or 'always'. Ignored by Instant models."),
  startluxKeyFile: Schema.string()
    .default('')
    .description('Optional key-file path; empty resolves to $DSH_HOME/jev-highlight-startlux.key (written by the Settings tab).'),
  maxConcurrency: Schema.natural()
    .min(1)
    .max(12)
    .default(8)
    .description('Maximum in-flight Jev requests; the spec asks for 8–12.'),
  requestTokenBudget: Schema.natural()
    .min(1000)
    .max(60000)
    .default(24000)
    .description('Estimated input-token cap per Jev request (spec: 20k–24k, hard API cap 64k).'),
  unitTokenBudget: Schema.natural()
    .min(500)
    .max(24000)
    .default(20000)
    .description('Oversized units are split into sub-chunks no larger than this.'),
  cacheCapacity: Schema.natural()
    .min(1)
    .max(100000)
    .default(500)
    .description('LRU verdict cache entries keyed by content hash.'),
  requestTimeoutMs: Schema.natural()
    .min(1000)
    .max(120000)
    .default(30000)
    .description('Per-request timeout; the AbortSignal also cancels on turn/plugin teardown.'),
  startluxThresholds: Schema.object({
    critical: threshold('critical', STARTLUX_THRESHOLDS.critical),
    medium: threshold('medium', STARTLUX_THRESHOLDS.medium),
    low: threshold('low', STARTLUX_THRESHOLDS.low),
  })
    .default({ ...STARTLUX_THRESHOLDS })
    .description(
      'StartLux-only priority cutoffs (calibrated: .52/.37/.24). highlightThresholds is used for provider=jev.',
    ),
  highlightThresholds: Schema.object({
    critical: threshold('critical', DEFAULT_THRESHOLDS.critical),
    medium: threshold('medium', DEFAULT_THRESHOLDS.medium),
    low: threshold('low', DEFAULT_THRESHOLDS.low),
  })
    .default({ ...DEFAULT_THRESHOLDS })
    .description('Jev-only priority cutoffs: critical >= .85, medium >= .65, low >= .45, below = none.'),
  autoStart: Schema.boolean()
    .default(true)
    .description('Judge streamed units automatically; false keeps the pipeline idle until toggled.'),
  requireApiKey: Schema.boolean()
    .default(false)
    .description(
      'true = fail activation with MissingJevApiKeyError when no key resolves (strict); ' +
        'false (default) = load in degraded mode, keep routes/chip, disable judging, and report the error.',
    ),
  debug: Schema.boolean()
    .default(false)
    .description('Verbose host logging.'),
})

/** Normalise the Loader-validated config into the runtime shape. */
export function normaliseConfig(raw: Partial<ResolvedConfig> | undefined): ResolvedConfig {
  const provider = raw?.provider === 'jev' ? 'jev' : 'startlux'
  const rawThresholds =
    provider === 'startlux'
      ? (raw as { startluxThresholds?: Partial<HighlightThresholds> } | undefined)?.startluxThresholds
      : raw?.highlightThresholds
  const fallback = provider === 'startlux' ? STARTLUX_THRESHOLDS : DEFAULT_THRESHOLDS
  const thresholds: HighlightThresholds = {
    critical: clamp01(rawThresholds?.critical, fallback.critical),
    medium: clamp01(rawThresholds?.medium, fallback.medium),
    low: clamp01(rawThresholds?.low, fallback.low),
  }
  // Keep the buckets ordered no matter what the user config says.
  if (thresholds.medium > thresholds.critical) thresholds.medium = thresholds.critical
  if (thresholds.low > thresholds.medium) thresholds.low = thresholds.medium

  return {
    provider,
    jevApiKey: str(raw?.jevApiKey),
    jevBaseUrl: stripTrailingSlash(str(raw?.jevBaseUrl) || 'https://api.typesafe.ai'),
    model: str(raw?.model) || 'jev-1.13.0',
    startluxBaseUrl: stripTrailingSlash(str(raw?.startluxBaseUrl) || 'https://api.bamboonode.dev/v1'),
    startluxModel: str(raw?.startluxModel) || 'startlux-decision-27b-autothink',
    startluxEndpointPath: normalisePath(str(raw?.startluxEndpointPath), '/decisions'),
    startluxThinkMode: normaliseThinkMode(raw?.startluxThinkMode),
    startluxKeyFile: str(raw?.startluxKeyFile),
    maxConcurrency: clampInt(raw?.maxConcurrency, 8, 1, 12),
    requestTokenBudget: clampInt(raw?.requestTokenBudget, 24000, 1000, 60000),
    unitTokenBudget: clampInt(raw?.unitTokenBudget, 20000, 500, 24000),
    cacheCapacity: clampInt(raw?.cacheCapacity, 500, 1, 100000),
    requestTimeoutMs: clampInt(raw?.requestTimeoutMs, 30000, 1000, 120000),
    highlightThresholds: thresholds,
    autoStart: raw?.autoStart !== false,
    requireApiKey: raw?.requireApiKey === true,
    debug: raw?.debug === true,
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? Math.round(value) : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '')
}

function normalisePath(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return fallback
  return raw.startsWith('/') ? raw : `/${raw}`
}

function normaliseThinkMode(value: unknown): StartLuxThinkMode {
  return value === 'auto' || value === 'always' ? value : 'never'
}
