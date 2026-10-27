/**
 * Host half entry. The implementation lives in ./host/*.
 *
 * Exported form (dsh function plugin): name / inject / Config / apply.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config } from './host/config.js'
import { apply as applyRuntime, pluginName } from './host/runtime.js'

export const name = pluginName

/** The client routes need the web server; without it the plugin stays inactive. */
export const inject = ['webServer']

export { Config }

export function apply(ctx: Context, config: unknown): void {
  applyRuntime(ctx, config as never)
}

/** Test-only seams; not part of the plugin contract. */
export * from './host/internal.js'
