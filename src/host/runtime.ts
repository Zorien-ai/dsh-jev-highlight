/**
 * Host runtime wiring.
 *
 * The plugin judges content units with one of two decision backends:
 * - `startlux` (default): domestic StartLux-Decision via the OpenAI-compatible
 *   Bamboo Relay (`POST {baseURL}/decisions`); the API key can be typed into
 *   Settings → 插件 → Jev 高亮 (key file, write-only) or supplied by env;
 * - `jev`: TypeSafe Jev (`POST {jevBaseUrl}/v1/systemone`).
 *
 * `apply()` resolves the credential for the selected backend. In strict mode
 * (`requireApiKey: true`) a missing key fails activation loudly; by default the
 * plugin loads in degraded mode (routes/chip alive, judging disabled) and the
 * actionable notice is exposed through /state and /diag. Saving a key in the
 * Settings tab re-enables judging immediately — no restart.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { DiagSnapshot, HighlightThresholds, JudgeProvider, ResolvedConfig, StartLuxThinkMode } from '../contract.js'
import { MAX_QUESTION_CHARS, PRIORITY_WEIGHTS, QUESTION_SET_VERSION } from '../contract.js'
import { LruVerdictCache } from './cache.js'
import { normaliseConfig } from './config.js'
import { describeError } from './errors.js'
import {
  MissingJevApiKeyError,
  MissingStartLuxApiKeyError,
  clearStartLuxKey,
  resolveJevApiKey,
  resolveStartLuxApiKey,
  saveStartLuxKey,
  startluxKeyFilePath,
  type JevCredential,
} from './credentials.js'
import { JevClient, buildJevQuestions, extractProbability, type JevFetchLike } from './jev-client.js'
import { JudgePipeline } from './pipeline.js'
import {
  clearThinkModeFile,
  readThinkModeFile,
  saveThinkModeFile,
  thinkModeFilePath,
} from './think-mode.js'
import {
  clearThresholdsFile,
  normaliseThresholds,
  readThresholdsFile,
  saveThresholdsFile,
  thresholdsFilePath,
} from './thresholds.js'
import {
  registerJevRoutes,
  type KeyActionResult,
  type PromptsPayload,
  type ProviderCheckResult,
  type ProviderStatus,
  type RouteState,
  type ThinkModeResult,
  type ThresholdsResult,
  type UnitsResult,
  type WebServerLike,
} from './routes.js'
import { VerdictStore } from './store.js'

export const pluginName = 'jev-highlight'

/** Verdicts kept per session; the global bound lives in the store defaults. */
const PER_SESSION_VERDICTS = 500

/** Documented state template exposed by GET /jev-highlight/prompts. */
const STATE_TEMPLATE = [
  '[section] {nearest markdown heading}',
  '[preceding line] {last line of the previous unit}',
  '[question] {current user request, bounded}',
  '[passage]',
  '{verbatim content unit text}',
].join('\n')

export interface HostLogger {
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

/** Structural facade over the Cordis context; keeps the plugin testable. */
export interface HostContextLike {
  on(event: string, listener: (...args: any[]) => void): () => unknown
  effect?(callback: () => (() => unknown) | void): () => unknown
  get?(service: string): unknown
  logger?: HostLogger
  webServer?: WebServerLike
  [key: string]: unknown
}

export interface HostRuntime {
  start(): void
  stop(): Promise<void>
}

export interface HostRuntimeOptions {
  ctx: HostContextLike
  config: ResolvedConfig
  credential: JevCredential
  /** True when activation continued without a resolvable key (degraded mode). */
  credentialMissing?: boolean
  /** Actionable missing-key message surfaced through /state and /diag. */
  credentialNotice?: string | null
  /** Test seam: inject a fake fetch. Defaults to the global fetch. */
  fetchImpl?: JevFetchLike
}

export interface HostRuntimeInstance extends HostRuntime {
  readonly pipeline: JudgePipeline
  readonly client: JevClient
  readonly store: VerdictStore
  readonly cache: LruVerdictCache
  readonly config: ResolvedConfig
  state(): RouteState
  diag(): DiagSnapshot
  providerStatus(): ProviderStatus
}

function isWebServerLike(value: unknown): value is WebServerLike {
  return value !== null && typeof value === 'object' && typeof (value as { register?: unknown }).register === 'function'
}

function makeLogger(ctx: HostContextLike, debug: boolean): (message: string) => void {
  return (message: string) => {
    if (!debug) return
    try {
      const logger = ctx.logger
      if (logger === undefined) return
      if (typeof logger.warn === 'function') logger.warn(message)
      else if (typeof logger.info === 'function') logger.info(message)
      else if (typeof logger.error === 'function') logger.error(message)
    } catch {
      // Logging must never take the pipeline down.
    }
  }
}

/** Resolve the provider-specific endpoint, model and credential sources. */
export function providerEndpoint(config: ResolvedConfig): { provider: JudgeProvider; baseUrl: string; endpointPath: string; url: string; model: string } {
  if (config.provider === 'startlux') {
    const baseUrl = config.startluxBaseUrl
    const endpointPath = config.startluxEndpointPath
    return {
      provider: 'startlux',
      baseUrl,
      endpointPath,
      url: `${baseUrl}${endpointPath}`,
      model: config.startluxModel,
    }
  }
  return {
    provider: 'jev',
    baseUrl: config.jevBaseUrl,
    endpointPath: '/v1/systemone',
    url: `${config.jevBaseUrl}/v1/systemone`,
    model: config.model,
  }
}

/** Resolve the selected provider's API key, or throw its actionable error. */
export function resolveProviderCredential(config: ResolvedConfig): JevCredential {
  if (config.provider === 'startlux') {
    return resolveStartLuxApiKey({ keyFile: config.startluxKeyFile })
  }
  return resolveJevApiKey({ configKey: config.jevApiKey })
}

/**
 * Build the runtime without touching the Cordis context yet. Split out so
 * node:test can drive the pipeline, routes and abort paths with fakes.
 */
export function createHostRuntime(options: HostRuntimeOptions): HostRuntimeInstance {
  const { ctx, config, credential } = options
  let credentialMissing = options.credentialMissing === true
  let credentialNotice = options.credentialNotice ?? null
  let keySource: string | null = credentialMissing ? null : credential.source
  const log = makeLogger(ctx, config.debug)
  const target = providerEndpoint(config)
  const keyFile = startluxKeyFilePath({ keyFile: config.startluxKeyFile })
  const thinkFile = thinkModeFilePath()
  let thinkMode: StartLuxThinkMode = readThinkModeFile(thinkFile) ?? config.startluxThinkMode
  const thresholdsFile = thresholdsFilePath()
  const persistedThresholds = readThresholdsFile(thresholdsFile)
  let currentThresholds: HighlightThresholds = persistedThresholds ?? { ...config.highlightThresholds }
  let thresholdsOverridden = persistedThresholds !== null

  const cache = new LruVerdictCache({ capacity: config.cacheCapacity })
  const client = new JevClient({
    // JevClient enforces a non-empty key. In degraded mode no request is ever
    // issued (the pipeline stays disabled); the placeholder only satisfies that
    // invariant so the rest of the plugin can load.
    apiKey: credential.key !== '' ? credential.key : 'unconfigured-degraded-mode',
    provider: target.provider,
    baseUrl: target.baseUrl,
    endpointPath: target.endpointPath,
    thinkMode,
    model: target.model,
    fetchImpl: options.fetchImpl,
    timeoutMs: config.requestTimeoutMs,
    maxConcurrency: config.maxConcurrency,
    requestTokenBudget: config.requestTokenBudget,
    unitTokenBudget: config.unitTokenBudget,
    cache,
    log,
  })
  const store = new VerdictStore({ perSessionLimit: PER_SESSION_VERDICTS })
  const pipeline = new JudgePipeline({
    client,
    store,
    model: target.model,
    baseUrl: target.url,
    keySource,
    provider: target.provider,
    keyConfigured: !credentialMissing,
    thresholds: currentThresholds,
    maxConcurrency: config.maxConcurrency,
    requestTokenBudget: config.requestTokenBudget,
    // Without a key there is nothing to judge with: keep the pipeline idle so
    // the UI can still load and show the actionable credential notice.
    autoStart: config.autoStart && !credentialMissing,
    log,
  })
  if (credentialMissing && credentialNotice !== null) pipeline.noteError(credentialNotice)

  const cleanups: Array<() => void> = []
  let started = false
  let stopped = false

  const registerCleanup = (cleanup: () => void): void => {
    let done = false
    const once = (): void => {
      if (done) return
      done = true
      try {
        cleanup()
      } catch {
        // Cleanup races are ignored.
      }
    }
    cleanups.push(once)
    const effect = ctx.effect
    if (typeof effect === 'function') {
      try {
        effect(() => once)
      } catch (error) {
        log(`[jev-highlight] ctx.effect failed: ${describeError(error)}`)
      }
    }
  }

  const resolveService = (name: string): unknown => {
    try {
      if (typeof ctx.get === 'function') {
        const service = ctx.get(name)
        if (service !== undefined && service !== null) return service
      }
    } catch (error) {
      log(`[jev-highlight] ctx.get(${name}) failed: ${describeError(error)}`)
    }
    return ctx[name]
  }

  const getWebServer = (): WebServerLike | undefined => {
    const service = resolveService('webServer')
    return isWebServerLike(service) ? service : undefined
  }

  const state = (): RouteState => ({
    enabled: pipeline.isEnabled && !credentialMissing,
    provider: target.provider,
    keyConfigured: !credentialMissing,
    notice: credentialNotice,
    counts: pipeline.counts(),
    capabilities: { highlightApi: true },
    model: target.model,
    baseUrl: target.url,
    thresholds: { ...currentThresholds } as HighlightThresholds,
  })

  const providerStatus = (): ProviderStatus => ({
    provider: target.provider,
    model: target.model,
    baseUrl: target.baseUrl,
    endpointPath: target.endpointPath,
    thinkMode: target.provider === 'startlux' ? thinkMode : 'n/a',
    keyConfigured: !credentialMissing,
    keySource,
    keyFile,
    keyRequired: config.requireApiKey,
    thresholds: { ...currentThresholds },
    thresholdsSource: thresholdsOverridden ? 'settings' : 'config',
  })

  const getUnits = (query: { since: number; sessionId?: string; limit: number }): UnitsResult => store.query(query)

  const diag = (): DiagSnapshot => pipeline.snapshot()

  const getPrompts = (): PromptsPayload => ({
    questionSetVersion: QUESTION_SET_VERSION,
    provider: target.provider,
    model: target.model,
    stateTemplate: STATE_TEMPLATE,
    questions: buildJevQuestions(),
    weights: { ...PRIORITY_WEIGHTS },
    thresholds: { ...currentThresholds },
    maxQuestionChars: MAX_QUESTION_CHARS,
  })

  const unavailableKeyResult = (action: 'save' | 'clear'): KeyActionResult => ({
    ok: false,
    action,
    provider: providerStatus(),
    error:
      target.provider === 'startlux'
        ? credentialNotice ?? 'StartLux key is not configured'
        : 'The Settings key store is for StartLux; configure the Jev key via JEV_API_KEY or $DSH_HOME/.credentials.yaml',
  })

  const saveKey = (rawKey: string): KeyActionResult => {
    if (target.provider !== 'startlux') return unavailableKeyResult('save')
    const saved = saveStartLuxKey(rawKey, keyFile)
    if (!saved.ok) return { ok: false, action: 'save', provider: providerStatus(), error: saved.error }
    client.setApiKey(rawKey.trim())
    credentialMissing = false
    credentialNotice = null
    keySource = 'settings:key-file'
    pipeline.setCredentialState({ keySource, keyConfigured: true })
    pipeline.clearError()
    pipeline.setEnabled(config.autoStart)
    return { ok: true, action: 'save', provider: providerStatus() }
  }

  const clearKey = (): KeyActionResult => {
    if (target.provider !== 'startlux') return unavailableKeyResult('clear')
    const cleared = clearStartLuxKey(keyFile)
    if (!cleared.ok) return { ok: false, action: 'clear', provider: providerStatus(), error: cleared.error }
    client.setApiKey('unconfigured-degraded-mode')
    credentialMissing = true
    credentialNotice = new MissingStartLuxApiKeyError(keyFile).message
    keySource = null
    pipeline.setCredentialState({ keySource: null, keyConfigured: false })
    pipeline.noteError(credentialNotice)
    pipeline.setEnabled(false)
    return { ok: true, action: 'clear', provider: providerStatus() }
  }

  const setThinkMode = (mode: StartLuxThinkMode | 'default'): ThinkModeResult => {
    if (target.provider !== 'startlux') {
      return {
        ok: false,
        mode: config.startluxThinkMode,
        provider: providerStatus(),
        error: 'think mode is only available for the StartLux provider',
      }
    }
    if (mode === 'default') {
      const cleared = clearThinkModeFile(thinkFile)
      if (!cleared.ok) return { ok: false, mode: thinkMode, provider: providerStatus(), error: cleared.error }
      thinkMode = config.startluxThinkMode
    } else {
      const saved = saveThinkModeFile(mode, thinkFile)
      if (!saved.ok) return { ok: false, mode: thinkMode, provider: providerStatus(), error: saved.error }
      thinkMode = mode
    }
    client.setThinkMode(thinkMode)
    return { ok: true, mode: thinkMode, provider: providerStatus() }
  }

  const setThresholds = (input: { critical?: unknown; medium?: unknown; low?: unknown }): ThresholdsResult => {
    const result = normaliseThresholds(input)
    if (!result.ok) {
      return {
        ok: false,
        thresholds: { ...currentThresholds },
        source: thresholdsOverridden ? 'settings' : 'config',
        provider: providerStatus(),
        error: result.error,
      }
    }
    const saved = saveThresholdsFile(result.thresholds, thresholdsFile)
    if (!saved.ok) {
      return {
        ok: false,
        thresholds: { ...currentThresholds },
        source: thresholdsOverridden ? 'settings' : 'config',
        provider: providerStatus(),
        error: saved.error,
      }
    }
    currentThresholds = result.thresholds
    thresholdsOverridden = true
    pipeline.setThresholds(currentThresholds)
    return { ok: true, thresholds: { ...currentThresholds }, source: 'settings', provider: providerStatus() }
  }

  const resetThresholds = (): ThresholdsResult => {
    const cleared = clearThresholdsFile(thresholdsFile)
    if (!cleared.ok) {
      return {
        ok: false,
        thresholds: { ...currentThresholds },
        source: thresholdsOverridden ? 'settings' : 'config',
        provider: providerStatus(),
        error: cleared.error,
      }
    }
    currentThresholds = { ...config.highlightThresholds }
    thresholdsOverridden = false
    pipeline.setThresholds(currentThresholds)
    return { ok: true, thresholds: { ...currentThresholds }, source: 'config', provider: providerStatus() }
  }

  const check = async (): Promise<ProviderCheckResult> => {
    if (credentialMissing) {
      return { ok: false, provider: target.provider, model: target.model, error: credentialNotice ?? 'API key is not configured' }
    }
    const startedAt = Date.now()
    try {
      const response = await client.systemOne({
        state: 'Health check: the jev-highlight plugin is verifying the configured decision endpoint.',
        questions: { health: { type: 'noul', instructions: 'Does this request reach the decision model successfully?' } },
      })
      const answers = response.answers
      const health = answers !== undefined && answers !== null ? answers.health : undefined
      const answer = extractProbability(health)
      return {
        ok: true,
        provider: target.provider,
        model: target.model,
        latencyMs: Date.now() - startedAt,
        modelReturned: typeof response.model === 'string' ? response.model : undefined,
        ...(answer !== undefined ? { answer } : {}),
      }
    } catch (error) {
      return { ok: false, provider: target.provider, model: target.model, latencyMs: Date.now() - startedAt, error: describeError(error) }
    }
  }

  const start = (): void => {
    if (started || stopped) return
    started = true
    pipeline.start()

    const on = ctx.on
    if (typeof on !== 'function') throw new Error('jev-highlight requires a Cordis context with ctx.on')
    const listen = (event: string, listener: (...args: any[]) => void): void => {
      const disposer = on.call(ctx, event, listener)
      if (typeof disposer === 'function') registerCleanup(() => disposer())
    }
    listen('agent/assistant-stream', (payload: unknown) => pipeline.handleAssistantStream(payload))
    listen('agent/inbox/claimed', (payload: unknown) => pipeline.handleInboxClaimed(payload))
    listen('agent/status', (payload: unknown) => pipeline.handleAgentStatus(payload))
    listen('agent/disposed', (payload: unknown) => pipeline.handleAgentDisposed(payload))
    listen('session/disposed', (session: unknown) => pipeline.handleSessionDisposed(session))

    const webServer = getWebServer()
    if (webServer === undefined) {
      const message = 'the webServer service is unavailable; jev-highlight client routes were not registered'
      pipeline.noteError(message)
      log(`[jev-highlight] ${message}`)
      return
    }
    try {
      const disposeRoutes = registerJevRoutes(webServer, {
        getState: state,
        getUnits,
        getDiag: diag,
        getPrompts,
        getProvider: providerStatus,
        saveKey,
        clearKey,
        setThinkMode,
        setThresholds,
        resetThresholds,
        check,
        toggle: (enabled: boolean) => {
          // Without a credential the toggle is a no-op that stays off; the
          // chip explains why through state.keyConfigured / state.notice.
          pipeline.setEnabled(credentialMissing ? false : enabled)
          return state()
        },
      })
      registerCleanup(disposeRoutes)
    } catch (error) {
      pipeline.noteError(describeError(error))
      log(`[jev-highlight] route registration failed: ${describeError(error)}`)
    }
  }

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await pipeline.dispose()
    for (let index = cleanups.length - 1; index >= 0; index -= 1) {
      const cleanup = cleanups[index]
      if (cleanup !== undefined) cleanup()
    }
    cleanups.length = 0
  }

  return { start, stop, pipeline, client, store, cache, config, state, diag, providerStatus }
}

/**
 * DSH plugin entry point.
 *
 * Credential policy (provider-specific message):
 * - `requireApiKey: true` throws the provider's missing-key error and the entry
 *   does not activate;
 * - default (`false`) loads degraded: listeners/routes/chip work, judging stays
 *   off, and the actionable message is exposed through `/jev-highlight/state`
 *   (`notice`) and `/jev-highlight/diag` (`lastError`). A StartLux key typed in
 *   Settings re-enables judging without a restart.
 */
export function apply(ctx: Context, rawConfig: unknown): void {
  const config = normaliseConfig(rawConfig as Partial<ResolvedConfig> | undefined)
  let credential: JevCredential
  let credentialMissing = false
  let credentialNotice: string | null = null
  try {
    credential = resolveProviderCredential(config)
  } catch (error) {
    const expected = error instanceof MissingJevApiKeyError || error instanceof MissingStartLuxApiKeyError
    if (config.requireApiKey || !expected) throw error
    credentialMissing = true
    credentialNotice = error.message
    credential = { key: '', source: 'missing' }
    try {
      const logger = (ctx as unknown as HostContextLike).logger
      const message = `[jev-highlight] ${error.message} — loaded in degraded mode: judging stays disabled until a key is provided`
      if (logger !== undefined && typeof logger.error === 'function') logger.error(message)
      else if (logger !== undefined && typeof logger.warn === 'function') logger.warn(message)
    } catch {
      // Logging must not prevent the plugin from loading.
    }
  }
  const host = ctx as unknown as HostContextLike
  const runtime = createHostRuntime({ ctx: host, config, credential, credentialMissing, credentialNotice })
  const effect = host.effect
  if (typeof effect === 'function') {
    // Returning the stop promise lets Cordis await quiescent unload: every
    // in-flight request is aborted and the pipeline drains before the plugin is
    // considered unloaded.
    effect(() => {
      runtime.start()
      return () => runtime.stop()
    })
    return
  }
  runtime.start()
}
