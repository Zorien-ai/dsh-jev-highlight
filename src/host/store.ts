/**
 * Bounded in-process verdict store.
 *
 * The client polls `GET /jev-highlight/units?since=<seq>` with a monotonic
 * cursor, so sequences are global to the process and never reused. Memory is
 * bounded twice: per session (so one very long chat cannot crowd out other
 * sessions) and globally (so a long-running DSH process cannot grow without
 * limit).
 */
import type { HighlightLevel, HighlightThresholds, UnitVerdict } from '../contract.js'
import { levelFor } from '../contract.js'

export interface VerdictStoreOptions {
  /** Verdicts retained per session; oldest are dropped first. */
  perSessionLimit?: number
  /** Verdicts retained across all sessions; oldest are dropped first. */
  globalLimit?: number
}

export interface UnitQuery {
  /** Return units with `seq > since`; defaults to 0. */
  since?: number
  /** Optional session filter. */
  sessionId?: string
  /** Maximum returned units; defaults to 200. */
  limit?: number
}

export interface StoreCounts {
  critical: number
  medium: number
  low: number
}

export interface UnitQueryResult {
  units: UnitVerdict[]
  /** Cursor for the next poll. */
  seq: number
}

export const DEFAULT_QUERY_LIMIT = 200
export const MAX_QUERY_LIMIT = 1000

function clampLimit(limit: number | undefined): number {
  const value = Math.floor(limit ?? DEFAULT_QUERY_LIMIT)
  if (!Number.isFinite(value) || value < 1) return DEFAULT_QUERY_LIMIT
  return Math.min(MAX_QUERY_LIMIT, value)
}

export class VerdictStore {
  private readonly perSessionLimit: number
  private readonly globalLimit: number
  private readonly units: UnitVerdict[] = []
  private readonly bySession = new Map<string, UnitVerdict[]>()
  private readonly counts: StoreCounts = { critical: 0, medium: 0, low: 0 }
  private readonly evictedSeqs = new Set<number>()
  private seqCursor = 0

  constructor(options: VerdictStoreOptions = {}) {
    const perSession = Math.floor(options.perSessionLimit ?? 500)
    const global = Math.floor(options.globalLimit ?? 2000)
    this.perSessionLimit = Number.isFinite(perSession) && perSession > 0 ? perSession : 500
    this.globalLimit = Number.isFinite(global) && global > 0 ? global : 2000
  }

  /** Highest sequence assigned so far. */
  get lastSeq(): number {
    return this.seqCursor
  }

  get size(): number {
    return this.units.length
  }

  /** Store a judgement; assigns the next monotonic sequence. */
  append(verdict: Omit<UnitVerdict, 'seq'>): UnitVerdict {
    this.seqCursor += 1
    const stored: UnitVerdict = { ...verdict, seq: this.seqCursor }
    this.units.push(stored)
    const sessionUnits = this.bySession.get(stored.sessionId)
    if (sessionUnits === undefined) this.bySession.set(stored.sessionId, [stored])
    else sessionUnits.push(stored)
    this.incrementLevel(stored.level)

    const sessionList = this.bySession.get(stored.sessionId)
    if (sessionList !== undefined) {
      while (sessionList.length > this.perSessionLimit) {
        const oldest = sessionList[0]
        if (oldest === undefined) break
        this.evict(oldest)
      }
    }
    while (this.units.length > this.globalLimit) {
      const oldest = this.units[0]
      if (oldest === undefined) break
      this.evict(oldest)
    }
    return stored
  }

  /**
   * Query by cursor. `seq` is the next cursor: the last returned seq when the
   * result was truncated, otherwise the store's global last seq.
   */
  query(query: UnitQuery = {}): UnitQueryResult {
    const since = Number.isFinite(query.since ?? 0) ? Math.max(0, Math.floor(query.since ?? 0)) : 0
    const limit = clampLimit(query.limit)
    const sessionId = typeof query.sessionId === 'string' && query.sessionId !== '' ? query.sessionId : undefined
    const result: UnitVerdict[] = []
    for (const unit of this.units) {
      if (unit.seq <= since) continue
      if (sessionId !== undefined && unit.sessionId !== sessionId) continue
      if (result.length >= limit) {
        const last = result[result.length - 1]
        return { units: result, seq: last !== undefined ? last.seq : this.seqCursor }
      }
      result.push(unit)
    }
    return { units: result, seq: this.seqCursor }
  }

  /** Current highlight bucket counts across retained verdicts. */
  countsSnapshot(): StoreCounts {
    return { critical: this.counts.critical, medium: this.counts.medium, low: this.counts.low }
  }

  /**
   * Recompute every retained verdict's level under new thresholds.
   *
   * Used when the Settings tab changes the cutoffs: without this, already
   * judged units would keep their old bucket while new units use the new one.
   */
  relevel(thresholds: HighlightThresholds): void {
    this.counts.critical = 0
    this.counts.medium = 0
    this.counts.low = 0
    for (const unit of this.units) {
      const level = levelFor(unit.priority, thresholds)
      unit.level = level
      this.incrementLevel(level)
    }
  }

  /** All verdicts of one session, oldest first (diagnostics/tests only). */
  sessionUnits(sessionId: string): UnitVerdict[] {
    return [...(this.bySession.get(sessionId) ?? [])]
  }

  clear(): void {
    this.units.length = 0
    this.bySession.clear()
    this.evictedSeqs.clear()
    this.counts.critical = 0
    this.counts.medium = 0
    this.counts.low = 0
    this.seqCursor = 0
  }

  private evict(verdict: UnitVerdict): void {
    if (this.evictedSeqs.has(verdict.seq)) return
    this.evictedSeqs.add(verdict.seq)
    const globalIndex = this.units.indexOf(verdict)
    if (globalIndex >= 0) this.units.splice(globalIndex, 1)
    const sessionList = this.bySession.get(verdict.sessionId)
    if (sessionList !== undefined) {
      const index = sessionList.indexOf(verdict)
      if (index >= 0) sessionList.splice(index, 1)
      if (sessionList.length === 0) this.bySession.delete(verdict.sessionId)
    }
    this.decrementLevel(verdict.level)
  }

  private incrementLevel(level: HighlightLevel | 'none'): void {
    if (level === 'critical') this.counts.critical += 1
    else if (level === 'medium') this.counts.medium += 1
    else if (level === 'low') this.counts.low += 1
  }

  private decrementLevel(level: HighlightLevel | 'none'): void {
    if (level === 'critical') this.counts.critical = Math.max(0, this.counts.critical - 1)
    else if (level === 'medium') this.counts.medium = Math.max(0, this.counts.medium - 1)
    else if (level === 'low') this.counts.low = Math.max(0, this.counts.low - 1)
  }
}
