/**
 * Persisted highlight-threshold overrides written by the Settings tab.
 *
 * Resolution order at activation:
 *   1. `$DSH_HOME/jev-highlight-thresholds.json` (Settings override);
 *   2. `config.highlightThresholds` (Jev) / `config.startluxThresholds`
 *      (StartLux, calibrated sensitive preset `.52/.37/.24`).
 *
 * The Settings tab can change these at runtime; the pipeline re-levels stored
 * verdicts and the client refreshes its highlights. "恢复默认" clears the file.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HighlightThresholds } from '../contract.js'
import { resolveDshHome } from './credentials.js'

export interface ThresholdsFileOptions {
  env?: Readonly<Record<string, string | undefined>>
  dshHome?: string
  /** Explicit file override; empty resolves to the default under $DSH_HOME. */
  file?: string
}

export function thresholdsFilePath(options: ThresholdsFileOptions = {}): string {
  const override = typeof options.file === 'string' ? options.file.trim() : ''
  if (override !== '') return override
  const home =
    typeof options.dshHome === 'string' && options.dshHome.trim() !== ''
      ? options.dshHome.trim()
      : resolveDshHome(options.env)
  return join(home, 'jev-highlight-thresholds.json')
}

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export function isValidThresholds(value: unknown): value is HighlightThresholds {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return validNumber(record.critical) && validNumber(record.medium) && validNumber(record.low)
}

/**
 * Validate user input and keep the buckets ordered. Equal boundaries are
 * allowed (an empty band); inverted boundaries are rejected instead of silently
 * reordered so the Settings tab can explain the problem.
 */
export function normaliseThresholds(
  value: unknown,
): { ok: true; thresholds: HighlightThresholds } | { ok: false; error: string } {
  if (!isValidThresholds(value)) {
    return { ok: false, error: 'thresholds must be three numbers between 0 and 1' }
  }
  const thresholds = {
    critical: round4(value.critical),
    medium: round4(value.medium),
    low: round4(value.low),
  }
  if (thresholds.medium > thresholds.critical) {
    return { ok: false, error: 'critical must be greater than or equal to medium' }
  }
  if (thresholds.low > thresholds.medium) {
    return { ok: false, error: 'medium must be greater than or equal to low' }
  }
  return { ok: true, thresholds }
}

/** Read the Settings override; returns null when absent, invalid or unordered. */
export function readThresholdsFile(file: string): HighlightThresholds | null {
  try {
    if (!existsSync(file)) return null
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const result = normaliseThresholds(parsed)
    return result.ok ? result.thresholds : null
  } catch {
    return null
  }
}

export function saveThresholdsFile(
  thresholds: HighlightThresholds,
  file: string,
): { ok: true } | { ok: false; error: string } {
  const result = normaliseThresholds(thresholds)
  if (!result.ok) return result
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(result.thresholds, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function clearThresholdsFile(file: string): { ok: true } | { ok: false; error: string } {
  try {
    if (existsSync(file)) unlinkSync(file)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}
