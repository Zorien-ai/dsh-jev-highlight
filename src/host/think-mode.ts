/**
 * Persisted StartLux `think_mode` choice written by the Settings tab.
 *
 * Resolution order at activation:
 *   1. `$DSH_HOME/jev-highlight-think-mode` (Settings choice, if valid);
 *   2. `config.startluxThinkMode` (default `never`).
 *
 * The Settings tab can switch the mode at runtime through
 * `POST /jev-highlight/think`; "默认" clears the override and falls back to the
 * config value. Only StartLux understands think_mode, so the Jev provider
 * ignores this file.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { StartLuxThinkMode } from '../contract.js'
import { resolveDshHome } from './credentials.js'

export interface ThinkModeFileOptions {
  env?: Readonly<Record<string, string | undefined>>
  dshHome?: string
  /** Explicit file override; empty resolves to the default under $DSH_HOME. */
  file?: string
}

/** Default file written by the Settings tab. */
export function thinkModeFilePath(options: ThinkModeFileOptions = {}): string {
  const override = typeof options.file === 'string' ? options.file.trim() : ''
  if (override !== '') return override
  const home =
    typeof options.dshHome === 'string' && options.dshHome.trim() !== ''
      ? options.dshHome.trim()
      : resolveDshHome(options.env)
  return join(home, 'jev-highlight-think-mode')
}

export function isStartLuxThinkMode(value: unknown): value is StartLuxThinkMode {
  return value === 'never' || value === 'auto' || value === 'always'
}

/** Read the persisted mode; returns null when absent or invalid. */
export function readThinkModeFile(file: string): StartLuxThinkMode | null {
  try {
    if (!existsSync(file)) return null
    const value = readFileSync(file, 'utf8').split(/\r?\n/u)[0]?.trim() ?? ''
    return isStartLuxThinkMode(value) ? value : null
  } catch {
    return null
  }
}

/** Persist a mode; validates the enum before writing. */
export function saveThinkModeFile(mode: unknown, file: string): { ok: true } | { ok: false; error: string } {
  if (!isStartLuxThinkMode(mode)) {
    return { ok: false, error: "think mode must be 'never', 'auto' or 'always'" }
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${mode}\n`, { encoding: 'utf8', mode: 0o600 })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Remove the override so the config value applies again. */
export function clearThinkModeFile(file: string): { ok: true } | { ok: false; error: string } {
  try {
    if (existsSync(file)) unlinkSync(file)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
