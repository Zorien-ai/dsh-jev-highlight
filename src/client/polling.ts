/**
 * Host route polling.
 *
 * - `/state` carries the master switch and the per-level counts;
 * - `/units?since=` is the monotonic verdict cursor;
 * - `/toggle` flips the switch.
 *
 * Cadence: 600 ms while the page is visible, 2500 ms while hidden, with
 * exponential backoff on transport errors. A missing host half (404) is an
 * expected "not mounted yet" state and is retried silently.
 */

import type { HostApi } from './http.js'
import type { HighlightController } from './highlighter.js'
import type { Counts, VerdictLike, ViewState } from './types.js'
import { NS } from './types.js'

interface PollerWindowLike {
  document: Document
  setTimeout: (callback: () => void, delay?: number) => number
  clearTimeout: (handle: number) => void
}

export interface PollerOptions {
  window: PollerWindowLike
  api: HostApi
  highlighter: HighlightController
  supported: boolean
  onUpdate?: () => void
}

export interface Poller {
  start(): void
  /** Force a `/state` refresh (tests / after a toggle). */
  refreshState(): void
  toggle(): void
  getState(): ViewState
  subscribe(listener: () => void): () => void
  dispose(): void
}

const UNITS_VISIBLE_MS = 600
const UNITS_HIDDEN_MS = 2500
const STATE_VISIBLE_MS = 2500
const STATE_HIDDEN_MS = 8000
const UNITS_FAILURE_MS = [800, 1500, 3000, 4000] as const
const STATE_FAILURE_MS = [1500, 3000, 6000, 10000] as const
const UNITS_LIMIT = 100
const STATE_AFTER_UNITS_MS = 300
const MAX_DELAY_MS = 60_000

function toCounts(value: unknown): Counts {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const read = (key: string): number => {
    const candidate = record[key]
    const parsed = typeof candidate === 'number' ? candidate : Number(candidate)
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
  }
  return { critical: read('critical'), medium: read('medium'), low: read('low') }
}

function isVerdict(value: unknown): value is VerdictLike {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.unitId === 'string' && record.unitId !== '' && typeof record.text === 'string' && typeof record.level === 'string'
}

/**
 * The units route accepts an optional `sessionId` filter, but the Host's
 * session identity (`agent.id`) is not guaranteed to equal the id the DOM
 * carries (`[data-conversation-session]`). Sending a mismatched filter would
 * silently return zero units forever, so the client polls the global cursor and
 * lets text mapping decide what belongs to the visible transcript.
 */

/** Create the poller; call `start()` after wiring listeners. */
export function createPoller(options: PollerOptions): Poller {
  const { window: win, api, highlighter, supported } = options
  const doc = win.document
  const listeners = new Set<() => void>()

  let state: ViewState = {
    ready: false,
    supported,
    keyConfigured: true,
    enabled: true,
    counts: { critical: 0, medium: 0, low: 0 },
    model: '',
    busy: false,
    error: null,
  }
  let disposed = false
  let since = 0
  let thresholdsSignature: string | null = null
  let unitsFailures = 0
  let stateFailures = 0
  let unitsTimer: number | null = null
  let stateTimer: number | null = null
  let started = false
  let dueStateRefresh = false

  const notify = (): void => {
    if (disposed) return
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[jev-highlight] chip listener failed', error)
      }
    }
    options.onUpdate?.()
  }

  const hidden = (): boolean => doc.visibilityState === 'hidden'

  function thresholdSignature(body: Record<string, unknown>): string | null {
    const raw = body.thresholds
    if (typeof raw !== 'object' || raw === null) return null
    const record = raw as Record<string, unknown>
    const read = (key: string): number | null => {
      const value = record[key]
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }
    const critical = read('critical')
    const medium = read('medium')
    const low = read('low')
    if (critical === null || medium === null || low === null) return null
    return `${critical}/${medium}/${low}`
  }

  function applyStateBody(body: Record<string, unknown>): void {
    const countsSource = body.counts ?? body.state
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined
    const model = typeof body.model === 'string' ? body.model : state.model
    const keyConfigured = typeof body.keyConfigured === 'boolean' ? body.keyConfigured : state.keyConfigured
    const notice =
      typeof body.notice === 'string' && body.notice !== ''
        ? body.notice
        : typeof body.error === 'string' && body.error !== ''
          ? body.error
          : null
    const ok = body.ok !== false
    if (!ok) return
    const signature = thresholdSignature(body)
    if (signature !== null) {
      const changed = thresholdsSignature !== null && signature !== thresholdsSignature
      thresholdsSignature = signature
      if (changed) {
        // The Settings tab changed the cutoffs: the Host re-levelled retained
        // verdicts, so restart the cursor and rebuild every highlight.
        since = 0
        highlighter.reset()
        scheduleUnits(0)
      }
    }
    state = {
      ...state,
      ready: true,
      keyConfigured,
      enabled: keyConfigured && (enabled ?? state.enabled),
      counts: countsSource === undefined ? state.counts : toCounts(countsSource),
      model,
      error: notice,
    }
    notify()
  }

  function scheduleUnits(delay: number): void {
    if (disposed) return
    if (unitsTimer !== null) win.clearTimeout(unitsTimer)
    unitsTimer = win.setTimeout(pullUnits, Math.min(MAX_DELAY_MS, Math.max(0, delay)))
  }

  function scheduleState(delay: number): void {
    if (disposed) return
    if (stateTimer !== null) win.clearTimeout(stateTimer)
    stateTimer = win.setTimeout(pullState, Math.min(MAX_DELAY_MS, Math.max(0, delay)))
  }

  async function pullUnits(): Promise<void> {
    if (disposed) return
    unitsTimer = null
    let delay = hidden() ? UNITS_HIDDEN_MS : UNITS_VISIBLE_MS
    try {
      const query = `units?since=${String(since)}&limit=${String(UNITS_LIMIT)}`
      const body = await api.get(query)
      unitsFailures = 0
      const rawUnits = body.units
      const units: VerdictLike[] = Array.isArray(rawUnits) ? rawUnits.filter(isVerdict) : []
      const seq = typeof body.seq === 'number' && Number.isFinite(body.seq) ? body.seq : null
      if (seq !== null && seq > since) since = seq
      if (units.length < UNITS_LIMIT && seq !== null && seq === since) {
        // Normal steady state; keep the cursor.
      }
      if (units.length > 0) {
        highlighter.ingest(units)
        scheduleState(STATE_AFTER_UNITS_MS)
      }
      if (!state.ready) {
        // The host answered; a state response may merely be slower.
        delay = hidden() ? UNITS_HIDDEN_MS : UNITS_VISIBLE_MS
      }
    } catch (error) {
      unitsFailures += 1
      const backoff = UNITS_FAILURE_MS[Math.min(unitsFailures - 1, UNITS_FAILURE_MS.length - 1)] ?? UNITS_FAILURE_MS[0]
      delay = hidden() ? backoff * 3 : backoff
      if (state.ready) {
        state = { ...state, error: error instanceof Error ? error.message : String(error) }
        notify()
      }
    }
    scheduleUnits(delay)
  }

  async function pullState(): Promise<void> {
    if (disposed) return
    stateTimer = null
    dueStateRefresh = false
    let delay = hidden() ? STATE_HIDDEN_MS : STATE_VISIBLE_MS
    try {
      const body = await api.get('state')
      stateFailures = 0
      applyStateBody(body)
    } catch (error) {
      stateFailures += 1
      const backoff = STATE_FAILURE_MS[Math.min(stateFailures - 1, STATE_FAILURE_MS.length - 1)] ?? STATE_FAILURE_MS[0]
      delay = hidden() ? backoff * 2 : backoff
      if (state.ready) {
        state = { ...state, error: error instanceof Error ? error.message : String(error) }
        notify()
      }
    }
    scheduleState(delay)
  }

  function refreshSoon(): void {
    if (dueStateRefresh) return
    dueStateRefresh = true
    scheduleState(STATE_AFTER_UNITS_MS)
  }

  function onVisibilityChange(): void {
    if (disposed) return
    if (hidden()) {
      scheduleUnits(UNITS_HIDDEN_MS)
      scheduleState(STATE_HIDDEN_MS)
      return
    }
    scheduleUnits(0)
    scheduleState(0)
  }

  return {
    start() {
      if (disposed || started) return
      started = true
      if (typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibilityChange)
      scheduleUnits(0)
      scheduleState(0)
    },
    refreshState() {
      refreshSoon()
    },
    toggle() {
      if (disposed || state.busy) return
      state = { ...state, busy: true }
      notify()
      void (async () => {
        try {
          const body = await api.post('toggle', { enabled: !state.enabled })
          const rawState = typeof body.state === 'object' && body.state !== null ? (body.state as Record<string, unknown>) : null
          const nextEnabled = typeof body.enabled === 'boolean' ? body.enabled : rawState !== null && typeof rawState.enabled === 'boolean' ? rawState.enabled : !state.enabled
          state = {
            ...state,
            enabled: nextEnabled,
            counts: rawState !== null && rawState.counts !== undefined ? toCounts(rawState.counts) : state.counts,
            model: rawState !== null && typeof rawState.model === 'string' ? rawState.model : state.model,
            error: null,
          }
          highlighter.setEnabled(nextEnabled)
        } catch (error) {
          state = { ...state, error: error instanceof Error ? error.message : String(error) }
        } finally {
          state = { ...state, busy: false }
          notify()
          refreshSoon()
        }
      })()
    },
    getState() {
      return { ...state, counts: { ...state.counts } }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibilityChange)
      if (unitsTimer !== null) win.clearTimeout(unitsTimer)
      if (stateTimer !== null) win.clearTimeout(stateTimer)
      unitsTimer = null
      stateTimer = null
      listeners.clear()
    },
  }
}

/** Locale namespace re-exported so the chip and poller agree on the dictionary key. */
export { NS }
