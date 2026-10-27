/**
 * LRU cache for Jev noul scores.
 *
 * One judgement of one semantic unit costs a network round trip; DSH replays
 * the same content often (regenerate, fork, re-render), so the cache is keyed
 * by a hash of the normalised unit text plus its grounding context, the
 * question-set version and the model. A question change or a model bump
 * therefore invalidates every entry automatically.
 */
import { createHash } from 'node:crypto'
import { QUESTION_SET_VERSION, type ContentUnit, type NoulScores, type UnitContext } from '../contract.js'

export interface VerdictCacheOptions {
  capacity?: number
}

export interface CacheStats {
  hits: number
  misses: number
  size: number
}

/** Whitespace-insensitive normalisation used only for the cache key. */
export function normaliseCacheText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

export interface CacheKeyInput {
  text: string
  type?: string
  context?: UnitContext
}

/** Stable sha256 key: normalised text + context fields + question version + model. */
export function cacheKeyFor(input: CacheKeyInput, model: string): string {
  const payload = JSON.stringify({
    v: QUESTION_SET_VERSION,
    model,
    type: input.type ?? '',
    text: normaliseCacheText(input.text),
    heading: normaliseCacheText(input.context?.heading ?? ''),
    before: normaliseCacheText(input.context?.before ?? ''),
    question: normaliseCacheText(input.context?.question ?? ''),
  })
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/** Convenience wrapper for a splitter-produced content unit. */
export function cacheKeyForUnit(unit: ContentUnit, model: string): string {
  return cacheKeyFor(unit, model)
}

export class LruVerdictCache {
  private readonly capacity: number
  private readonly entries = new Map<string, NoulScores>()
  private hits = 0
  private misses = 0

  constructor(options: VerdictCacheOptions = {}) {
    const capacity = Math.floor(options.capacity ?? 500)
    this.capacity = Number.isFinite(capacity) && capacity > 0 ? capacity : 500
  }

  /** Look up a verdict; a miss is recorded whenever the key is absent. */
  get(key: string): NoulScores | undefined {
    const value = this.entries.get(key)
    if (value === undefined) {
      this.misses += 1
      return undefined
    }
    this.hits += 1
    // Refresh recency.
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: string, value: NoulScores): void {
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  get size(): number {
    return this.entries.size
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, size: this.entries.size }
  }

  clear(): void {
    this.entries.clear()
    this.hits = 0
    this.misses = 0
  }
}
