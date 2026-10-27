/**
 * The judging pipeline: stream frames → semantic units → Jev verdicts → store.
 *
 * Ownership:
 * - one `StreamingSplitter` per (session, attempt, revision, text block);
 * - one AbortController per session (teardown) and one per attempt revision
 *   (abandoned attempts), combined per request;
 * - a bounded job queue drained by at most `maxConcurrency` unit workers;
 * - every queued unit is dropped (and counted) when its session/attempt is
 *   cancelled or the plugin toggles off.
 *
 * Cancellation policy (see the task contract): `abandoned` stream ends,
 * `agent/disposed`, `session/disposed` and plugin unload abort in-flight Jev
 * requests. `agent/status idle` is deliberately NOT a cancellation trigger:
 * idle fires between tool-call steps and at the end of a turn, where the
 * already-streamed text still needs to be judged.
 */
import type { DiagSnapshot, HighlightThresholds, JudgeProvider, NoulScores, UnitVerdict } from '../contract.js'
import { MAX_QUESTION_CHARS, QUESTION_SET_VERSION, combinePriority, levelFor } from '../contract.js'
import { describeError, isAbortLike } from './errors.js'
import type { JevClientStats } from './jev-client.js'
import { combineSignals } from './signals.js'
import { StreamingSplitter, type SplitUnit } from './splitter.js'
import { VerdictStore } from './store.js'

/** What the pipeline needs from the Jev client (fakeable in tests). */
export interface JudgeClient {
  judgeUnit(unit: SplitUnit, options: { signal: AbortSignal }): Promise<{ scores: NoulScores; cached: boolean }>
  stats(): JevClientStats
}

export interface JudgePipelineOptions {
  client: JudgeClient
  store: VerdictStore
  model: string
  baseUrl: string
  keySource: string | null
  /** Judge backend label shown in diagnostics. */
  provider?: JudgeProvider
  /** False when the runtime activated without a credential (degraded mode). */
  keyConfigured?: boolean
  thresholds: HighlightThresholds
  maxConcurrency: number
  requestTokenBudget: number
  autoStart?: boolean
  log?: (message: string) => void
  now?: () => number
}

interface SessionState {
  readonly sessionId: string
  readonly controller: AbortController
  readonly scopes: Map<string, AbortController>
  readonly captures: Map<string, BlockCapture>
  heading: string | undefined
  before: string | undefined
  /** Latest claimed user request for the current turn (bounded). */
  question: string | undefined
  /** Turn the question above belongs to; guards against leaking stale turns. */
  questionTurn: number | undefined
  /** Last turn observed; heading/before are reset when a new turn starts. */
  turn: number | undefined
}

interface BlockCapture {
  readonly key: string
  readonly attemptId: string
  readonly revision: number
  readonly blockIndex: number
  splitter: StreamingSplitter
  streamedText: string
  readonly emittedTexts: Set<string>
}

interface Job {
  sessionId: string
  attemptId: string
  revision: number
  unit: SplitUnit
}

/** A single runaway session cannot grow the session map without bound. */
export const MAX_TRACKED_SESSIONS = 500
/** A stalled API must not grow the pending queue without bound. */
export const MAX_QUEUED_UNITS = 512

function scopeKey(attemptId: string, revision: number): string {
  return `${attemptId}#${revision}`
}

function captureKey(attemptId: string, revision: number, blockIndex: number): string {
  return `${attemptId}#${revision}#${blockIndex}`
}

function readSessionId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function readIndex(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  return 0
}

function readRevision(frame: Record<string, unknown>): number {
  const value = frame.revision
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0
}

function readTurn(frame: Record<string, unknown>): number | undefined {
  const value = frame.turn
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined
}

function readAttemptId(frame: Record<string, unknown>): string {
  const value = frame.attemptId
  return typeof value === 'string' ? value : ''
}

/**
 * Extract the text of a claimed user message. Defensive about shape: the
 * documented payload carries `message.content` content blocks, but tests and
 * future revisions may pass a string/plain text field.
 */
export function readUserMessageText(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const record = message as { content?: unknown; text?: unknown }
  const pieces: string[] = []
  if (typeof record.text === 'string') pieces.push(record.text)
  const content = record.content
  if (typeof content === 'string') {
    pieces.push(content)
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      const typed = block as { type?: unknown; text?: unknown }
      if (typed.type === 'text' && typeof typed.text === 'string') pieces.push(typed.text)
    }
  }
  const text = pieces.join('\n').replace(/\s+/gu, ' ').trim()
  return text.length > MAX_QUESTION_CHARS ? text.slice(0, MAX_QUESTION_CHARS) : text
}

export class JudgePipeline {
  private readonly client: JudgeClient
  private readonly store: VerdictStore
  private readonly model: string
  private readonly baseUrl: string
  private keySource: string | null
  private readonly provider: JudgeProvider
  private keyConfigured: boolean
  private thresholds: HighlightThresholds
  private readonly maxConcurrency: number
  private readonly requestTokenBudget: number
  private readonly autoStart: boolean
  private readonly log: (message: string) => void
  private readonly now: () => number

  private readonly sessions = new Map<string, SessionState>()
  private readonly queue: Job[] = []
  private readonly runningTasks = new Set<Promise<void>>()

  private active = false
  private disposed = false
  private enabled: boolean
  private running = 0

  private unitsSeen = 0
  private unitsJudged = 0
  private droppedUnits = 0
  private failures = 0
  private lastError: string | null = null

  constructor(options: JudgePipelineOptions) {
    this.client = options.client
    this.store = options.store
    this.model = options.model
    this.baseUrl = options.baseUrl
    this.keySource = options.keySource
    this.provider = options.provider === 'startlux' ? 'startlux' : 'jev'
    this.keyConfigured = options.keyConfigured !== false
    this.thresholds = { ...options.thresholds }
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency))
    this.requestTokenBudget = Math.max(1, Math.floor(options.requestTokenBudget))
    this.autoStart = options.autoStart !== false
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
    this.enabled = this.autoStart
  }

  /** Begin accepting stream frames. */
  start(): void {
    if (this.disposed) throw new Error('jev-highlight pipeline has been disposed')
    this.active = true
  }

  get isEnabled(): boolean {
    return this.enabled && !this.disposed
  }

  get isActive(): boolean {
    return this.active && !this.disposed
  }

  /** Record a non-request failure (route registration, unexpected wiring). */
  noteError(message: string): void {
    this.lastError = message.length > 400 ? `${message.slice(0, 400)}…` : message
  }

  /** Toggle judging; disabling also drops pending units and block buffers. */
  setEnabled(enabled: boolean): boolean {
    this.enabled = enabled === true && !this.disposed
    if (!this.enabled) {
      this.dropQueued(() => true)
      for (const session of this.sessions.values()) session.captures.clear()
    }
    return this.enabled
  }

  /**
   * Feed one `agent/assistant-stream` event payload ({agent, frame}).
   * Never throws: frame shapes are data from the model loop, not trusted input.
   */
  handleAssistantStream(payload: unknown): void {
    if (!this.active || this.disposed) return
    if (payload === null || typeof payload !== 'object') return
    const record = payload as { agent?: unknown; frame?: unknown }
    const sessionId = readSessionId(record.agent)
    const frameValue = record.frame
    if (sessionId === undefined || frameValue === null || typeof frameValue !== 'object') return
    const frame = frameValue as Record<string, unknown>
    const attemptId = readAttemptId(frame)
    if (attemptId === '') return
    const revision = readRevision(frame)

    try {
      if (frame.type === 'start') {
        this.handleStart(sessionId, attemptId, revision, readTurn(frame))
        return
      }
      if (frame.type === 'chunk') {
        this.handleChunk(sessionId, attemptId, revision, frame.chunk)
        return
      }
      if (frame.type === 'end') {
        this.handleEnd(sessionId, attemptId, revision, frame.outcome)
      }
    } catch (error) {
      this.failures += 1
      this.lastError = describeError(error)
      this.log(`[jev-highlight] failed to handle assistant stream frame: ${this.lastError}`)
    }
  }

  /**
   * `agent/inbox/claimed` listener: remember the user request for this turn so
   * the Jev state can carry it as `[question]` and `is_core_answer` judges the
   * passage against the actual request, not just its own wording.
   */
  handleInboxClaimed(payload: unknown): void {
    if (!this.active || this.disposed) return
    if (payload === null || typeof payload !== 'object') return
    const record = payload as { agent?: unknown; message?: unknown; turn?: unknown }
    const sessionId = readSessionId(record.agent)
    if (sessionId === undefined) return
    const text = readUserMessageText(record.message)
    if (text === '') return
    const session = this.ensureSession(sessionId)
    session.question = text
    session.questionTurn =
      typeof record.turn === 'number' && Number.isFinite(record.turn) ? Math.floor(record.turn) : session.turn
  }

  /** `agent/status` listener. Intentionally does not abort: see the file header. */
  handleAgentStatus(_payload: unknown): void {
    // No-op by design; cancellation is driven by abandoned ends and disposal.
  }

  /** `agent/disposed` listener: abort every in-flight request of the agent. */
  handleAgentDisposed(payload: unknown): void {
    if (payload === null || typeof payload !== 'object') return
    const sessionId = readSessionId((payload as { agent?: unknown }).agent)
    if (sessionId !== undefined) this.abortSession(sessionId, 'agent disposed')
  }

  /** `session/disposed` listener: abort every in-flight request of the session. */
  handleSessionDisposed(session: unknown): void {
    const sessionId = readSessionId(session)
    if (sessionId !== undefined) this.abortSession(sessionId, 'session disposed')
  }

  /** Abort one model attempt (all its in-flight requests and queued units). */
  abortAttempt(sessionId: string, attemptId: string, revision: number | undefined, reason = 'attempt aborted'): number {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return 0
    let aborted = 0
    for (const [key, controller] of session.scopes) {
      if (!key.startsWith(`${attemptId}#`)) continue
      if (revision !== undefined && key !== scopeKey(attemptId, revision)) continue
      if (!controller.signal.aborted) {
        controller.abort()
        aborted += 1
      }
      session.scopes.delete(key)
    }
    for (const [key, capture] of session.captures) {
      if (capture.attemptId !== attemptId) continue
      if (revision !== undefined && capture.revision !== revision) continue
      session.captures.delete(key)
    }
    this.dropQueued(
      (job) => job.sessionId === sessionId && job.attemptId === attemptId && (revision === undefined || job.revision === revision),
    )
    if (aborted > 0) this.log(`[jev-highlight] ${reason}: aborted ${aborted} attempt scope(s)`)
    return aborted
  }

  /** Abort the whole session: every in-flight request and queued unit. */
  abortSession(sessionId: string, reason = 'session aborted'): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    session.controller.abort()
    for (const controller of session.scopes.values()) {
      if (!controller.signal.aborted) controller.abort()
    }
    session.scopes.clear()
    session.captures.clear()
    this.sessions.delete(sessionId)
    this.dropQueued((job) => job.sessionId === sessionId)
    this.log(`[jev-highlight] ${reason}: session ${sessionId} torn down`)
  }

  /** Current verdict counts (for GET /state). */
  counts(): { critical: number; medium: number; low: number } {
    return this.store.countsSnapshot()
  }

  /** Update credential diagnostics when the Settings tab saves/clears a key. */
  setCredentialState(state: { keySource: string | null; keyConfigured: boolean }): void {
    this.keySource = state.keySource
    this.keyConfigured = state.keyConfigured
  }

  /**
   * Apply new highlight thresholds: future verdicts use them and retained
   * verdicts are re-levelled immediately so the UI is consistent.
   */
  setThresholds(thresholds: HighlightThresholds): void {
    this.thresholds = { ...thresholds }
    this.store.relevel(this.thresholds)
  }

  /** Clear a stale credential/route error once a key is saved successfully. */
  clearError(): void {
    this.lastError = null
  }

  /** Full diagnostics snapshot for GET /diag. */
  snapshot(): DiagSnapshot {
    const clientStats = this.client.stats()
    return {
      active: this.isActive && this.isEnabled,
      unitsSeen: this.unitsSeen,
      unitsQueued: this.queue.length,
      unitsJudged: this.unitsJudged,
      requests: clientStats.requests,
      inFlight: clientStats.inFlight,
      maxConcurrentObserved: clientStats.maxConcurrentObserved,
      maxRequestTokensObserved: clientStats.maxRequestTokensObserved,
      requestBudget: this.requestTokenBudget,
      concurrencyLimit: this.maxConcurrency,
      cacheHits: clientStats.cacheHits,
      cacheMisses: clientStats.cacheMisses,
      cacheSize: clientStats.cacheSize,
      abortedRequests: clientStats.abortedRequests,
      failures: this.failures,
      droppedUnits: this.droppedUnits,
      lastError: this.lastError,
      keySource: this.keySource,
      provider: this.provider,
      keyConfigured: this.keyConfigured,
      questionSetVersion: QUESTION_SET_VERSION,
      model: this.model,
      baseUrl: this.baseUrl,
      thresholdOverrides: { ...this.thresholds },
    }
  }

  /** Test seam: number of queued jobs (also exposed through diag). */
  get queued(): number {
    return this.queue.length
  }

  /** Stop accepting frames, abort everything in flight and wait for settle. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.active = false
    this.enabled = false
    for (const sessionId of [...this.sessions.keys()]) this.abortSession(sessionId, 'plugin unloaded')
    this.dropQueued(() => true)
    await Promise.allSettled([...this.runningTasks])
  }

  private handleStart(sessionId: string, attemptId: string, revision: number, turn: number | undefined): void {
    const session = this.ensureSession(sessionId)
    // Grounding context must not leak from one turn into the next: a new turn
    // starts with no heading/preceding line of its own.
    if (turn !== undefined && session.turn !== undefined && turn !== session.turn) {
      session.heading = undefined
      session.before = undefined
      // Keep the question only when it was explicitly claimed for this turn;
      // otherwise a previous turn's request would silently ground the new one.
      if (session.questionTurn !== turn) {
        session.question = undefined
        session.questionTurn = undefined
      }
    }
    if (turn !== undefined) session.turn = turn
    for (const [key, controller] of session.scopes) {
      if (!key.startsWith(`${attemptId}#`)) continue
      if (key === scopeKey(attemptId, revision)) continue
      if (!controller.signal.aborted) controller.abort()
      session.scopes.delete(key)
    }
    for (const [key, capture] of session.captures) {
      if (capture.attemptId === attemptId && capture.revision !== revision) session.captures.delete(key)
    }
    this.dropQueued((job) => job.sessionId === sessionId && job.attemptId === attemptId && job.revision !== revision)
  }

  private handleChunk(sessionId: string, attemptId: string, revision: number, chunkValue: unknown): void {
    if (chunkValue === null || typeof chunkValue !== 'object') return
    const chunk = chunkValue as Record<string, unknown>
    const session = this.ensureSession(sessionId)
    const blockIndex = readIndex(chunk.index)

    if (chunk.type === 'block-start') {
      if (chunk.blockType === 'text') this.ensureCapture(session, attemptId, revision, blockIndex)
      return
    }

    if (chunk.type === 'text-delta') {
      const text = chunk.text
      if (typeof text !== 'string' || text === '') return
      const capture = this.ensureCapture(session, attemptId, revision, blockIndex)
      capture.streamedText += text
      this.publishUnits(session, capture, capture.splitter.push(text))
      return
    }

    if (chunk.type === 'block-end') {
      const block = chunk.block
      if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const capture = this.ensureCapture(session, attemptId, revision, blockIndex)
        const finalText = (block as { text?: unknown }).text
        this.finishCapture(session, capture, typeof finalText === 'string' ? finalText : undefined)
        return
      }
      session.captures.delete(captureKey(attemptId, revision, blockIndex))
    }
  }

  private handleEnd(sessionId: string, attemptId: string, revision: number, outcomeValue: unknown): void {
    const session = this.ensureSession(sessionId)
    const committed =
      outcomeValue !== null && typeof outcomeValue === 'object' && (outcomeValue as { kind?: unknown }).kind === 'committed'

    for (const [key, capture] of session.captures) {
      if (capture.attemptId !== attemptId || capture.revision !== revision) continue
      if (committed) this.finishCapture(session, capture, undefined)
      else session.captures.delete(key)
    }

    if (committed) {
      // Keep judging the committed content; only forget the attempt scope.
      session.scopes.delete(scopeKey(attemptId, revision))
      return
    }
    this.abortAttempt(sessionId, attemptId, revision, 'assistant stream abandoned')
  }

  private ensureSession(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    while (this.sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) break
      this.abortSession(oldest.value, 'session table overflow')
    }
    const session: SessionState = {
      sessionId,
      controller: new AbortController(),
      scopes: new Map<string, AbortController>(),
      captures: new Map<string, BlockCapture>(),
      heading: undefined,
      before: undefined,
      question: undefined,
      questionTurn: undefined,
      turn: undefined,
    }
    this.sessions.set(sessionId, session)
    return session
  }

  private ensureScope(session: SessionState, attemptId: string, revision: number): AbortController {
    const key = scopeKey(attemptId, revision)
    const existing = session.scopes.get(key)
    if (existing !== undefined) return existing
    const controller = new AbortController()
    session.scopes.set(key, controller)
    return controller
  }

  private ensureCapture(session: SessionState, attemptId: string, revision: number, blockIndex: number): BlockCapture {
    const key = captureKey(attemptId, revision, blockIndex)
    const existing = session.captures.get(key)
    if (existing !== undefined) return existing
    const capture: BlockCapture = {
      key,
      attemptId,
      revision,
      blockIndex,
      splitter: new StreamingSplitter({
        sessionId: session.sessionId,
        attemptId,
        blockIndex,
        initialHeading: session.heading,
        initialBefore: session.before,
        initialQuestion: session.question,
      }),
      streamedText: '',
      emittedTexts: new Set<string>(),
    }
    session.captures.set(key, capture)
    return capture
  }

  private publishUnits(session: SessionState, capture: BlockCapture, units: readonly SplitUnit[]): void {
    for (const unit of units) {
      capture.emittedTexts.add(unit.text)
      this.enqueue(capture.attemptId, capture.revision, unit)
    }
    this.syncContext(session, capture)
  }

  private syncContext(session: SessionState, capture: BlockCapture): void {
    const heading = capture.splitter.heading
    if (heading !== undefined && heading !== '') session.heading = heading
    const before = capture.splitter.before
    if (before !== undefined && before !== '') session.before = before
  }

  /**
   * Close one text block. `block-end` carries the authoritative block text;
   * the streaming accumulation is normally identical, but a mismatch (retry
   * with a new revision, provider normalisation) must not silently lose or
   * duplicate content: the authoritative text wins, and units already emitted
   * are not emitted twice.
   */
  private finishCapture(session: SessionState, capture: BlockCapture, finalText: string | undefined): void {
    if (finalText !== undefined && finalText !== capture.streamedText) {
      if (finalText.startsWith(capture.streamedText)) {
        const suffix = finalText.slice(capture.streamedText.length)
        capture.streamedText = finalText
        this.publishUnits(session, capture, capture.splitter.push(suffix))
        // The streamed prefix may have left an unterminated trailing unit in
        // the splitter buffer. `block-end` is authoritative and final, so close
        // it now; otherwise the last paragraph of a message is silently lost.
        this.publishUnits(session, capture, capture.splitter.flush())
      } else {
        this.log(`[jev-highlight] block-end text mismatch for ${capture.key}; reprocessing the authoritative text`)
        const replacement = new StreamingSplitter({
          sessionId: session.sessionId,
          attemptId: capture.attemptId,
          blockIndex: capture.blockIndex,
          initialHeading: capture.splitter.seededHeading,
          initialBefore: capture.splitter.seededBefore,
          initialQuestion: capture.splitter.seededQuestion,
          startOrdinal: capture.splitter.nextOrdinal,
        })
        const units = [...replacement.push(finalText), ...replacement.flush()]
        const fresh = units.filter((unit) => !capture.emittedTexts.has(unit.text))
        capture.splitter = replacement
        capture.streamedText = finalText
        this.publishUnits(session, capture, fresh)
      }
    } else {
      this.publishUnits(session, capture, capture.splitter.flush())
    }
    session.captures.delete(capture.key)
    this.syncContext(session, capture)
  }

  private enqueue(attemptId: string, revision: number, unit: SplitUnit): void {
    this.unitsSeen += 1
    if (!this.active || this.disposed || !this.enabled) {
      this.droppedUnits += 1
      return
    }
    while (this.queue.length >= MAX_QUEUED_UNITS) {
      const dropped = this.queue.shift()
      if (dropped === undefined) break
      this.droppedUnits += 1
    }
    this.queue.push({ sessionId: unit.sessionId, attemptId, revision, unit })
    this.pump()
  }

  private dropQueued(predicate: (job: Job) => boolean): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const job = this.queue[index]
      if (job === undefined) continue
      if (!predicate(job)) continue
      this.queue.splice(index, 1)
      this.droppedUnits += 1
    }
  }

  private pump(): void {
    while (this.active && !this.disposed && this.running < this.maxConcurrency && this.queue.length > 0) {
      const job = this.queue.shift()
      if (job === undefined) return
      this.running += 1
      const task = this.execute(job).catch(() => {})
      this.runningTasks.add(task)
      void task.finally(() => {
        this.running = Math.max(0, this.running - 1)
        this.runningTasks.delete(task)
        this.pump()
      })
    }
  }

  private async execute(job: Job): Promise<void> {
    const session = this.sessions.get(job.sessionId)
    if (session === undefined || session.controller.signal.aborted) {
      this.droppedUnits += 1
      return
    }
    const scope = this.ensureScope(session, job.attemptId, job.revision)
    const signal = combineSignals([session.controller.signal, scope.signal])
    if (signal.aborted) {
      this.droppedUnits += 1
      return
    }
    try {
      const result = await this.client.judgeUnit(job.unit, { signal })
      if (!this.active || this.disposed || signal.aborted) {
        this.droppedUnits += 1
        return
      }
      const priority = combinePriority(result.scores)
      const level = levelFor(priority, this.thresholds)
      const verdict: Omit<UnitVerdict, 'seq'> = {
        unitId: job.unit.id,
        sessionId: job.unit.sessionId,
        type: job.unit.type,
        text: job.unit.text,
        context: job.unit.context,
        priority,
        level,
        scores: result.scores,
        model: this.model,
        cached: result.cached === true,
        createdAt: this.now(),
      }
      if (job.unit.matchText !== undefined) verdict.matchText = job.unit.matchText
      this.store.append(verdict)
      this.unitsJudged += 1
    } catch (error) {
      if (isAbortLike(error) || signal.aborted) {
        this.droppedUnits += 1
        return
      }
      this.failures += 1
      this.lastError = describeError(error)
      this.log(`[jev-highlight] unit ${job.unit.id} failed: ${this.lastError}`)
    }
  }
}
