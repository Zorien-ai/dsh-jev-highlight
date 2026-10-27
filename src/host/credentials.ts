/**
 * Credential resolution for the TypeSafe Jev API.
 *
 * Resolution order (first non-empty wins):
 *   1. the plugin config field `jevApiKey` (explicit override / debug patch);
 *   2. environment variable `JEV_API_KEY`;
 *   3. environment variable `TYPESAFE_API_KEY`;
 *   4. a top-level `jevApiKey` scalar in `$DSH_HOME/.credentials.yaml`.
 *
 * The missing-key error names the documentation paths explicitly so a
 * misconfigured deployment gets actionable instructions instead of silently
 * judging nothing. `requireApiKey: true` turns that error into activation
 * failure; the default (`false`) keeps the message but loads the plugin in
 * degraded mode (routes/chip alive, judging disabled), so a key can be added
 * later without restarting the whole Harness profile.
 * The key value itself is never logged, persisted or returned over HTTP.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type CredentialSource =
  | 'config'
  | 'env:JEV_API_KEY'
  | 'env:TYPESAFE_API_KEY'
  | 'env:STARTLUX_API_KEY'
  | 'env:BAMBOO_API_KEY'
  | 'file:$DSH_HOME/.credentials.yaml'
  | 'settings:key-file'
  | 'missing'

export interface JevCredential {
  key: string
  source: CredentialSource
}

export interface ResolveJevApiKeyOptions {
  /** Explicit config override; empty string means "not provided". */
  configKey?: string
  /** Environment map; defaults to `process.env`. Tests inject a fake map. */
  env?: Readonly<Record<string, string | undefined>>
  /** DSH home override; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Full credentials path override; defaults to `<dshHome>/.credentials.yaml`. */
  credentialsPath?: string
}

/** Raised when no Jev API key can be resolved; safe to show to the user. */
export class MissingJevApiKeyError extends Error {
  readonly code = 'JEV_API_KEY_MISSING'
  readonly credentialsPath: string

  constructor(credentialsPath: string, detail?: string) {
    super(missingKeyMessage(credentialsPath, detail))
    this.name = 'MissingJevApiKeyError'
    this.credentialsPath = credentialsPath
  }
}

function missingKeyMessage(credentialsPath: string, detail?: string): string {
  const lines = [
    'No Jev API key is configured: the jev-highlight plugin cannot judge content without it.',
    '',
    'Provide the key in one of these places, then retry by restarting the DSH web profile (or toggling the plugin off and on):',
    `  1. $DSH_HOME/.credentials.yaml — add a top-level scalar line: jevApiKey: "<your key>" (resolved path: ${credentialsPath})`,
    '  2. environment variable JEV_API_KEY (or TYPESAFE_API_KEY) in the environment that starts dsh',
    '  3. the plugin config field `jevApiKey` (debug patches only; prefer the options above)',
    '',
    'The key is never logged, never returned over HTTP and never sent to the browser.',
  ]
  if (typeof detail === 'string' && detail !== '') lines.push('', `Hint: ${detail}`)
  return lines.join('\n')
}

/** `$DSH_HOME`, else `~/.dsh` — the same convention the rest of DSH uses. */
export function resolveDshHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** Path of the credentials document: `$DSH_HOME/.credentials.yaml`. */
export function credentialsFilePath(dshHome?: string): string {
  return join(dshHome !== undefined && dshHome !== '' ? dshHome : resolveDshHome(), '.credentials.yaml')
}

function unquoteScalar(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'string') return parsed
    } catch {
      // Fall through to a plain slice; a malformed escape is not worth failing on.
    }
    return raw.slice(1, -1)
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/gu, "'")
  }
  return raw
}

/**
 * Minimal YAML top-level scalar parser.
 *
 * Only the shape `key: value` at indentation level zero is understood — that
 * is exactly what `.credentials.yaml` uses for `jevApiKey`. Nested mappings,
 * lists, anchors and multi-line scalars are ignored rather than guessed at.
 */
export function parseCredentialsYaml(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/\r$/u, '')
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    // Only top-level keys: any leading indentation belongs to a nested value.
    if (/^[ \t]/u.test(line)) continue
    const match = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/u.exec(line)
    if (match === null) continue
    const key = match[1]
    const rest = match[2]
    if (key === undefined || rest === undefined) continue
    let value = rest.trim()
    if (value === '' || value.startsWith('#')) continue
    if (!value.startsWith('"') && !value.startsWith("'")) {
      // Strip a trailing YAML comment from an unquoted scalar.
      value = value.replace(/[ \t]+#.*$/u, '').trim()
    }
    value = unquoteScalar(value)
    if (value === '') continue
    result[key] = value
  }
  return result
}

function readCredentialsKey(credentialsPath: string): { key?: string; error?: string } {
  let text: string
  try {
    text = readFileSync(credentialsPath, 'utf8')
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    if (code === 'ENOENT') return {}
    return { error: `could not read ${credentialsPath}` }
  }
  const parsed = parseCredentialsYaml(text)
  const key = parsed.jevApiKey
  return typeof key === 'string' && key !== '' ? { key } : {}
}

/**
 * Resolve the Jev API key or throw {@link MissingJevApiKeyError}.
 *
 * The error message contains the resolved credentials path and both documented
 * environment variables, never the key.
 */
export function resolveJevApiKey(options: ResolveJevApiKeyOptions = {}): JevCredential {
  const env = options.env ?? process.env
  const credentialsPath = options.credentialsPath ?? credentialsFilePath(options.dshHome)

  const configKey = typeof options.configKey === 'string' ? options.configKey.trim() : ''
  if (configKey !== '') return { key: configKey, source: 'config' }

  const jevEnv = typeof env.JEV_API_KEY === 'string' ? env.JEV_API_KEY.trim() : ''
  if (jevEnv !== '') return { key: jevEnv, source: 'env:JEV_API_KEY' }

  const typesafeEnv = typeof env.TYPESAFE_API_KEY === 'string' ? env.TYPESAFE_API_KEY.trim() : ''
  if (typesafeEnv !== '') return { key: typesafeEnv, source: 'env:TYPESAFE_API_KEY' }

  const fromFile = readCredentialsKey(credentialsPath)
  if (fromFile.key !== undefined) return { key: fromFile.key, source: 'file:$DSH_HOME/.credentials.yaml' }

  throw new MissingJevApiKeyError(credentialsPath, fromFile.error)
}

// ---------------------------------------------------------------------------
// StartLux / Bamboo Relay credentials
// ---------------------------------------------------------------------------

/** Raised when no StartLux key can be resolved; safe to show to the user. */
export class MissingStartLuxApiKeyError extends Error {
  readonly code = 'STARTLUX_API_KEY_MISSING'
  readonly keyFile: string

  constructor(keyFile: string, detail?: string) {
    super(startluxMissingMessage(keyFile, detail))
    this.name = 'MissingStartLuxApiKeyError'
    this.keyFile = keyFile
  }
}

function startluxMissingMessage(keyFile: string, detail?: string): string {
  const lines = [
    'No StartLux API key is configured: the jev-highlight plugin cannot judge content without it.',
    '',
    'Provide the key in one of these places (the Settings tab is preferred):',
    '  1. DSH Settings → 插件 → Jev 高亮 → API Key → 保存（write-only，落到下面的 key 文件）',
    `  2. key file: ${keyFile}`,
    '  3. environment variables STARTLUX_API_KEY or BAMBOO_API_KEY in the environment that starts dsh',
    '  4. $DSH_HOME/.credentials.yaml — top-level scalar line: startluxApiKey: "<your key>"',
    '',
    'The key is never logged, never returned over HTTP and never sent to the browser.',
  ]
  if (typeof detail === 'string' && detail !== '') lines.push('', `Hint: ${detail}`)
  return lines.join('\n')
}

export interface StartLuxKeyOptions {
  env?: Readonly<Record<string, string | undefined>>
  dshHome?: string
  /** Explicit key-file override; empty resolves to the default under $DSH_HOME. */
  keyFile?: string
  /** Credentials path override; defaults to `<dshHome>/.credentials.yaml`. */
  credentialsPath?: string
}

/** Default key file written by the plugin Settings tab. */
export function startluxKeyFilePath(options: StartLuxKeyOptions = {}): string {
  const override = typeof options.keyFile === 'string' ? options.keyFile.trim() : ''
  if (override !== '') return override
  const home =
    typeof options.dshHome === 'string' && options.dshHome.trim() !== ''
      ? options.dshHome.trim()
      : resolveDshHome(options.env)
  return join(home, 'jev-highlight-startlux.key')
}

function unquoteStartLuxValue(raw: string): string {
  return unquoteScalar(raw)
}

function readStartLuxCredentialsYaml(credentialsPath: string): { key?: string; error?: string } {
  let text: string
  try {
    text = readFileSync(credentialsPath, 'utf8')
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    if (code === 'ENOENT') return {}
    return { error: `could not read ${credentialsPath}` }
  }
  const parsed = parseCredentialsYaml(text)
  const key = parsed.startluxApiKey
  return typeof key === 'string' && key !== '' ? { key } : {}
}

/** Read the Settings-written key file; returns '' when absent/unreadable. */
export function readStartLuxKeyFile(keyFile: string): string {
  try {
    if (!existsSync(keyFile)) return ''
    const text = readFileSync(keyFile, 'utf8')
    const firstLine = text.split(/\r?\n/u)[0] ?? ''
    return unquoteStartLuxValue(firstLine.trim())
  } catch {
    return ''
  }
}

const API_KEY_TOKEN = /^\S{8,512}$/u

/** Validate and persist a key typed into the Settings tab (mode 0600 best effort). */
export function saveStartLuxKey(key: string, keyFile: string): { ok: true } | { ok: false; error: string } {
  const candidate = typeof key === 'string' ? key.trim() : ''
  if (!API_KEY_TOKEN.test(candidate)) {
    return { ok: false, error: 'API key must be 8–512 printable non-whitespace characters' }
  }
  try {
    mkdirSync(dirname(keyFile), { recursive: true })
    writeFileSync(keyFile, `${candidate}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(keyFile, 0o600)
    } catch {
      // Windows has no POSIX mode bits; best effort only.
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Delete the Settings-written key file. */
export function clearStartLuxKey(keyFile: string): { ok: true } | { ok: false; error: string } {
  try {
    if (existsSync(keyFile)) unlinkSync(keyFile)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Resolve the StartLux key. Order: Settings key file → STARTLUX_API_KEY →
 * BAMBOO_API_KEY → `.credentials.yaml` `startluxApiKey`.
 */
export function resolveStartLuxApiKey(options: StartLuxKeyOptions = {}): JevCredential {
  const env = options.env ?? process.env
  const keyFile = startluxKeyFilePath(options)

  const fromFile = readStartLuxKeyFile(keyFile)
  if (fromFile !== '') return { key: fromFile, source: 'settings:key-file' }

  const startluxEnv = typeof env.STARTLUX_API_KEY === 'string' ? env.STARTLUX_API_KEY.trim() : ''
  if (startluxEnv !== '') return { key: startluxEnv, source: 'env:STARTLUX_API_KEY' }

  const bambooEnv = typeof env.BAMBOO_API_KEY === 'string' ? env.BAMBOO_API_KEY.trim() : ''
  if (bambooEnv !== '') return { key: bambooEnv, source: 'env:BAMBOO_API_KEY' }

  const credentialsPath = options.credentialsPath ?? credentialsFilePath(options.dshHome)
  const fromCredentials = readStartLuxCredentialsYaml(credentialsPath)
  if (fromCredentials.key !== undefined) return { key: fromCredentials.key, source: 'file:$DSH_HOME/.credentials.yaml' }

  throw new MissingStartLuxApiKeyError(keyFile, fromCredentials.error)
}
