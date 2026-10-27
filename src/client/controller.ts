/**
 * Client-half application glue.
 *
 * Wires four pieces and hands every allocation to `ctx.effect` so unloading the
 * plugin removes the stylesheet, the highlight names, the timers/observer and
 * the chip registration:
 *
 *   http transport  ->  poller  ->  highlighter (CSS.highlights)
 *                          \----->  chip (conversation.composer.dock)
 */

import type { ClientContextLike, ReactLike } from './types.js'
import { NS } from './types.js'
import { createHostApi } from './http.js'
import { createHighlighter, supportsHighlights } from './highlighter.js'
import type { HighlightWindowLike } from './highlighter.js'
import { createPoller } from './polling.js'
import { createChipComponent, createTranslator, DICTS } from './chip.js'
import { createSettingsComponent } from './settings.js'

/** Slot that seats the chip; declared by the conversation UI plugin. */
export const CHIP_SLOT = 'conversation.composer.dock'

/** Registration id inside the dock slot. */
export const CHIP_ID = 'jev-highlight-chip'

/** Safe `window` slice; document/window must exist (browser half only). */
function highlightWindow(win: Window & typeof globalThis): HighlightWindowLike {
  return {
    document: win.document,
    CSS: win.CSS as HighlightWindowLike['CSS'],
    Highlight: (win as unknown as { Highlight?: HighlightWindowLike['Highlight'] }).Highlight,
    requestAnimationFrame: (callback) => win.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => win.cancelAnimationFrame(handle),
    setTimeout: (callback, delay) => win.setTimeout(callback, delay),
    clearTimeout: (handle) => win.clearTimeout(handle),
    MutationObserver: win.MutationObserver,
  }
}

/**
 * Apply the browser half.
 *
 * @param ctx - guarded Harness client plugin context.
 * @param React - the shared React module obtained from the loader.
 * @param win - page window (injectable for fixtures/tests).
 */
export function applyClientHalf(ctx: ClientContextLike, React: ReactLike, win: Window & typeof globalThis = window): void {
  if (typeof win.document === 'undefined') return

  const locale = ctx.locale
  // Dictionaries first: the chip may render before the first poll returns.
  if (locale !== undefined && typeof locale.register === 'function') {
    for (const [language, dictionary] of Object.entries(DICTS)) {
      try {
        const disposer = locale.register(NS, language, dictionary)
        if (typeof disposer === 'function' && typeof ctx.effect === 'function') {
          const cleanup = disposer as () => void
          ctx.effect(() => cleanup)
        }
      } catch (error) {
        console.error('[jev-highlight] failed to register locale dictionary', language, error)
      }
    }
  }

  const translate = createTranslator(locale)
  const supported = supportsHighlights(highlightWindow(win))
  const highlighter = createHighlighter({ window: highlightWindow(win), unsupported: !supported })
  const api = createHostApi()
  const poller = createPoller({
    window: {
      document: win.document,
      setTimeout: (callback, delay) => win.setTimeout(callback, delay),
      clearTimeout: (handle) => win.clearTimeout(handle),
    },
    api,
    highlighter,
    supported,
  })

  // One disposer for everything owned by this application.
  try {
    ctx.effect(() => () => {
      try {
        poller.dispose()
      } finally {
        highlighter.dispose()
      }
    })
  } catch (error) {
    console.error('[jev-highlight] failed to register disposer', error)
  }

  poller.start()

  const Chip = createChipComponent(React, translate, poller)
  const Settings = createSettingsComponent(React, api, translate)
  const slots = ctx.slots
  if (slots !== undefined && typeof slots.inject === 'function' && typeof slots.register === 'function') {
    try {
      const disposer = slots.inject('settings.plugins.tab', () =>
        slots.register(
          {
            name: 'settings.plugins.tab',
            id: 'jev-highlight',
            order: 60,
            label: () => translate('settings.tab'),
          },
          Settings,
        ),
      )
      if (typeof disposer === 'function' && typeof ctx.effect === 'function') ctx.effect(() => disposer)
    } catch (error) {
      console.error('[jev-highlight] failed to register the settings tab', error)
    }
    try {
      // The real slot registration schema only accepts name/id/order/label:
      // there is no `inject` prop channel on conversation.composer.dock, so the
      // controller and translator travel through the component closure instead.
      const disposer = slots.inject(CHIP_SLOT, () =>
        slots.register(
          {
            name: CHIP_SLOT,
            id: CHIP_ID,
            order: 40,
          },
          Chip,
        ),
      )
      if (typeof disposer === 'function' && typeof ctx.effect === 'function') ctx.effect(() => disposer)
    } catch (error) {
      console.error('[jev-highlight] failed to register the status chip', error)
    }
  }
}
