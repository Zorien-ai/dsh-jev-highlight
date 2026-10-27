/**
 * Shared structural types for the browser half.
 *
 * The client bundle only gets `react` from the Harness module table; every host
 * service is consumed through the guarded structural interfaces below so a
 * missing/renamed service can never crash the page.
 */

/** Verdict shape the host route serves (`UnitVerdict` from ../contract.ts plus optional fields). */
export interface VerdictLike {
  seq: number
  unitId: string
  sessionId: string
  type: string
  text: string
  /** DOM-searchable variant: table rows join cells with a space (see host splitter). */
  matchText?: string
  priority: number
  level: string
  createdAt?: number
}

/** Highlight buckets, mirrored from ../contract.ts so the browser bundle stays self-contained. */
export type Level = 'critical' | 'medium' | 'low'

export const LEVELS: readonly Level[] = ['critical', 'medium', 'low']

/** Highlight names registered in `CSS.highlights`. */
export const HIGHLIGHT_NAMES: Record<Level, string> = {
  critical: 'jev-critical',
  medium: 'jev-medium',
  low: 'jev-low',
}

/** Locale namespace used for the chip dictionaries. */
export const NS = 'jev-highlight'

/** Counts reported by the host state route. */
export interface Counts {
  critical: number
  medium: number
  low: number
}

/** Immutable snapshot the chip renders. */
export interface ViewState {
  /** False until the first successful `/state` response. */
  ready: boolean
  /** True when CSS Custom Highlight API is usable in this browser. */
  supported: boolean
  /** False when the host activated in degraded mode without a Jev API key. */
  keyConfigured: boolean
  enabled: boolean
  counts: Counts
  model: string
  /** True while a toggle request is in flight. */
  busy: boolean
  /** Last transport failure message, for the chip tooltip only. */
  error: string | null
}

/** Locale service shape (ctx.locale). */
export interface LocaleService {
  register(namespace: string, language: string, dictionary: Record<string, string>): unknown
  bind(namespace: string): (key: string, params?: Record<string, string | number>) => string
}

/** Minimal React surface used by the chip. */
export interface ReactLike {
  createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown
  useState: <T>(initial: T | (() => T)) => [T, (next: T | ((previous: T) => T)) => void]
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void
}

/** Registration options accepted by ctx.slots.register. */
export interface SlotRegistration {
  name: string
  id: string
  order: number
  /** Localized tab/nav text; the settings slot reads this thunk. */
  label?: string | (() => string)
  locale?: string
  inject?: () => Record<string, unknown>
}

/** Slots service shape (ctx.slots). */
export interface SlotsService {
  inject(name: string, callback: () => unknown): (() => void) | void
  register(options: SlotRegistration, component: unknown): (() => void) | void
}

/** Guarded client plugin context. */
export interface ClientContextLike {
  effect(callback: () => (() => void) | void): () => void
  on?(name: string, listener: (...args: never[]) => void): () => void
  get?(name: string): unknown
  inject?(services: string[], callback: (scope: ClientContextLike) => void): (() => void) | void
  slots?: SlotsService
  locale?: LocaleService
  [key: string]: unknown
}

/** Component props the chip receives through the slot `inject` hook. */
export interface ChipProps {
  t: (key: string, params?: Record<string, string | number>) => string
  controller: ChipController
}

/** What the chip needs from the controller. */
export interface ChipController {
  getState(): ViewState
  subscribe(listener: () => void): () => void
  toggle(): void
}
