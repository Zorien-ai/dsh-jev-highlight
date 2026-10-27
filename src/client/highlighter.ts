/**
 * CSS Custom Highlight controller.
 *
 * Owns the three `CSS.highlights` entries, the injected stylesheet, the
 * `MutationObserver` + `requestAnimationFrame` remap loop, and the read-only
 * Range bookkeeping. It never mutates the agent output DOM: ranges are painted
 * by the browser's highlight overlay.
 *
 * Results arrive progressively, so a unit is registered the first time its text
 * is visible in the DOM and re-mapped only when its nodes disappear.
 */

import type { Level, VerdictLike } from './types.js'
import { HIGHLIGHT_NAMES, LEVELS } from './types.js'
import { collectRegionRoots } from './regions.js'
import { findNormalizedSpan, flattenRegion, isRangeAlive, normalizeNeedle } from './textmap.js'
import { HIGHLIGHT_CSS, STYLE_ATTRIBUTE } from './styles.js'

/** Minimal shape of the Custom Highlight registry (avoids relying on lib.dom versions). */
interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void
  delete(name: string): boolean
  get(name: string): unknown
  has?(name: string): boolean
}

interface HighlightConstructorLike {
  new (...ranges: Range[]): unknown
}

/** Structural window slice used by the highlighter (injectable in fixtures). */
export interface HighlightWindowLike {
  document: Document
  CSS?: { highlights?: HighlightRegistryLike }
  Highlight?: HighlightConstructorLike
  requestAnimationFrame?: (callback: FrameRequestCallback) => number
  cancelAnimationFrame?: (handle: number) => void
  setTimeout?: (callback: () => void, delay?: number) => number
  clearTimeout?: (handle: number) => void
  MutationObserver?: typeof MutationObserver
}

interface UnitRecord {
  seq: number
  unitId: string
  level: Level
  loose: boolean
  normalized: string
  range: Range | null
  /** Number of remaps that failed to locate the text; bounded to avoid endless scans. */
  attempts: number
}

/** How long a unit whose text is absent keeps being retried on each remap. */
const MAX_ATTEMPTS = 400

/** Upper bound on remembered judged units, to keep a long-lived page bounded. */
const MAX_REMEMBERED_UNITS = 2000

interface FlattenCache {
  loose: Map<Element, ReturnType<typeof flattenRegion>>
  verbatim: Map<Element, ReturnType<typeof flattenRegion>>
}

export interface HighlightStats {
  supported: boolean
  enabled: boolean
  /** Registered highlight names with their current range count. */
  names: Record<string, number>
  /** Units accepted from the host (level != none). */
  units: number
  /** Units currently painted. */
  mapped: number
  /** Units whose text has not been located yet (or any more). */
  pending: number
}

export interface HighlightController {
  /** Feed newly polled verdicts; existing units with a changed level are updated. */
  ingest(verdicts: readonly VerdictLike[]): void
  /** Drop every unit (session switch). */
  reset(): void
  /** Enable/disable painting; units are kept so re-enabling is instant. */
  setEnabled(enabled: boolean): void
  /** Force a synchronous remap (tests / re-enable). */
  remap(): void
  stats(): HighlightStats
  dispose(): void
}

interface HighlightOptions {
  window: HighlightWindowLike
  /** True to skip painting (no CSS Custom Highlight API). */
  unsupported: boolean
}

function isLevel(value: string): value is Level {
  return value === 'critical' || value === 'medium' || value === 'low'
}

function makeUnitRecord(verdict: VerdictLike, level: Level): UnitRecord | null {
  const loose = verdict.type !== 'code_block'
  const source = typeof verdict.matchText === 'string' && verdict.matchText !== '' ? verdict.matchText : verdict.text
  const normalized = normalizeNeedle(source, loose)
  if (normalized.trim() === '') return null
  return { seq: verdict.seq, unitId: verdict.unitId, level, loose, normalized, range: null, attempts: 0 }
}

/** Create the highlight controller. Call `dispose()` to restore the page. */
export function createHighlighter(options: HighlightOptions): HighlightController {
  const { window: win } = options
  const doc = win.document
  const unsupported = options.unsupported
  const registry = win.CSS?.highlights
  const highlightCtor = win.Highlight

  const units = new Map<string, UnitRecord>()
  let enabled = true
  let disposed = false
  let style: HTMLStyleElement | null = null
  let observer: MutationObserver | null = null
  let frameRequested = false
  let frameHandle: number | null = null
  let timeoutHandle: number | null = null

  if (!unsupported) {
    style = doc.createElement('style')
    style.setAttribute(STYLE_ATTRIBUTE, 'styles')
    style.textContent = HIGHLIGHT_CSS
    if (doc.head !== null) doc.head.appendChild(style)
    const MutationObserverCtor = win.MutationObserver
    if (MutationObserverCtor !== undefined) {
      observer = new MutationObserverCtor(() => scheduleRemap())
      const target: Element | null = doc.body ?? doc.documentElement
      if (target !== null) {
        try {
          observer.observe(target, { subtree: true, childList: true, characterData: true })
        } catch {
          observer = null
        }
      } else {
        observer = null
      }
    }
  }

  function scheduleRemap(): void {
    if (disposed || unsupported || frameRequested) return
    frameRequested = true
    const run = (): void => {
      frameRequested = false
      frameHandle = null
      timeoutHandle = null
      if (disposed) return
      try {
        remapInternal()
      } catch (error) {
        console.error('[jev-highlight] DOM remap failed', error)
      }
    }
    if (typeof win.requestAnimationFrame === 'function') {
      frameHandle = win.requestAnimationFrame(run)
    } else if (typeof win.setTimeout === 'function') {
      timeoutHandle = win.setTimeout(run, 16)
    } else {
      run()
    }
  }

  function rebuildHighlights(): void {
    if (unsupported || registry === undefined || highlightCtor === undefined) return
    for (const level of LEVELS) {
      const name = HIGHLIGHT_NAMES[level]
      if (!enabled) {
        registry.delete(name)
        continue
      }
      const ranges: Range[] = []
      for (const record of units.values()) {
        if (record.level === level && record.range !== null && isRangeAlive(record.range)) ranges.push(record.range)
      }
      if (ranges.length === 0) {
        registry.delete(name)
        continue
      }
      try {
        registry.set(name, new highlightCtor(...ranges))
      } catch (error) {
        console.error('[jev-highlight] failed to register highlight', name, error)
      }
    }
  }

  function remapInternal(): void {
    if (unsupported) return
    if (!enabled) {
      rebuildHighlights()
      return
    }
    const roots = collectRegionRoots(doc)
    const cache: FlattenCache = { loose: new Map(), verbatim: new Map() }
    const flattened = (root: Element, loose: boolean): ReturnType<typeof flattenRegion> => {
      const bucket = loose ? cache.loose : cache.verbatim
      const existing = bucket.get(root)
      if (existing !== undefined) return existing
      const created = flattenRegion(root, loose)
      bucket.set(root, created)
      return created
    }

    const claimed = new Set<string>()
    const ordered = [...units.values()].sort((left, right) => left.seq - right.seq)
    for (const record of ordered) {
      if (record.range !== null && isRangeAlive(record.range)) {
        claimed.add(`${record.level}:alive`)
        continue
      }
      record.range = null
      if (record.attempts > MAX_ATTEMPTS) continue
      let located = false
      for (let index = 0; index < roots.length; index += 1) {
        const root = roots[index]
        if (root === undefined) continue
        const region = flattened(root, record.loose)
        const span = findNormalizedSpan(region, record.normalized)
        if (span === null) continue
        const key = `${record.loose ? 'L' : 'V'}:${index}:${span.variant}:${span.start}:${span.end}`
        if (claimed.has(key)) {
          located = true
          break
        }
        claimed.add(key)
        record.range = span.range
        record.attempts = 0
        located = true
        break
      }
      if (!located) record.attempts += 1
    }
    rebuildHighlights()
  }

  return {
    ingest(verdicts) {
      if (disposed || unsupported) return
      let touched = false
      for (const verdict of verdicts) {
        if (typeof verdict.unitId !== 'string' || verdict.unitId === '') continue
        if (!isLevel(verdict.level)) continue
        const existing = units.get(verdict.unitId)
        if (existing !== undefined) {
          if (existing.level !== verdict.level) {
            existing.level = verdict.level
            touched = true
          }
          continue
        }
        const record = makeUnitRecord(verdict, verdict.level)
        if (record === null) continue
        units.set(record.unitId, record)
        touched = true
      }
      // Bound memory across a long-lived page: drop the oldest judged units.
      if (units.size > MAX_REMEMBERED_UNITS) {
        const ordered = [...units.values()].sort((left, right) => left.seq - right.seq)
        const overflow = units.size - MAX_REMEMBERED_UNITS
        for (let index = 0; index < overflow; index += 1) {
          const oldest = ordered[index]
          if (oldest === undefined) break
          units.delete(oldest.unitId)
        }
      }
      if (touched) scheduleRemap()
    },
    reset() {
      units.clear()
      rebuildHighlights()
    },
    setEnabled(next) {
      if (disposed) return
      enabled = next
      if (enabled) scheduleRemap()
      else rebuildHighlights()
    },
    remap() {
      if (disposed) return
      remapInternal()
    },
    stats() {
      let mapped = 0
      let pending = 0
      for (const record of units.values()) {
        if (record.range !== null && isRangeAlive(record.range)) mapped += 1
        else pending += 1
      }
      const names: Record<string, number> = {}
      if (registry !== undefined) {
        for (const level of LEVELS) {
          const name = HIGHLIGHT_NAMES[level]
          const entry = registry.get(name)
          names[name] = entry !== undefined && entry !== null && typeof entry === 'object' && Symbol.iterator in entry ? [...(entry as Iterable<Range>)].length : 0
        }
      }
      return { supported: !unsupported, enabled, names, units: units.size, mapped, pending }
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (observer !== null) {
        try {
          observer.disconnect()
        } catch {
          /* ignore */
        }
        observer = null
      }
      if (frameHandle !== null && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(frameHandle)
      if (timeoutHandle !== null && typeof win.clearTimeout === 'function') win.clearTimeout(timeoutHandle)
      frameHandle = null
      timeoutHandle = null
      if (registry !== undefined) {
        for (const level of LEVELS) {
          const name = HIGHLIGHT_NAMES[level]
          try {
            registry.delete(name)
          } catch {
            /* ignore */
          }
        }
      }
      if (style !== null) {
        style.remove()
        style = null
      }
      units.clear()
    },
  }
}

/** Feature detection used by the plugin entry. */
export function supportsHighlights(win: HighlightWindowLike): boolean {
  return win.CSS?.highlights !== undefined && typeof win.Highlight === 'function'
}
