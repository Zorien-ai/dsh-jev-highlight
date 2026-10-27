/**
 * dsh Jev highlight — client half (browser).
 *
 * This file is bundled into a single classic script that registers a lazy
 * factory with the Harness module loader. Everything runs inside the factory:
 * module-body side effects are deliberately avoided.
 *
 * The client half talks to its host half through the same-origin JSON routes
 * registered by the host (GET /jev-highlight/state, GET /jev-highlight/units,
 * POST /jev-highlight/toggle). It never calls Jev itself: the API key never
 * reaches the browser, and api.typesafe.ai is not CORS enabled.
 *
 * Rendering is read-only DOM mapping + the CSS Custom Highlight API; the agent
 * output DOM is never inserted into, wrapped or moved. The only UI the plugin
 * owns is the chip it registers in `conversation.composer.dock`.
 */

import type { ClientContextLike, ReactLike } from './client/types.js'
import { applyClientHalf } from './client/controller.js'

/** Minimal structural types for the guarded client context. */
interface ClientPlugin {
  inject?: string[]
  apply(ctx: ClientContextLike): void
}

interface ModuleLoader {
  load(definition: { id: string; factory: (require: (id: string) => unknown) => ClientPlugin }): void
}

declare const window: Window & { __ModuleLoader__: ModuleLoader }
declare function require(id: string): unknown

window.__ModuleLoader__.load({
  id: '@local/dsh-jev-highlight',
  factory(req) {
    const React = req('react') as unknown as ReactLike

    // Keep the factory side-effect free: resources are allocated in apply() and
    // handed to ctx.effect for disposal.
    const plugin: ClientPlugin = {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          applyClientHalf(ctx, React)
        } catch (error) {
          // A client half must never break the host page.
          console.error('[jev-highlight] failed to apply the client half', error)
        }
      },
    }
    return plugin
  },
})
