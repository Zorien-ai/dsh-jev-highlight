/**
 * Same-origin JSON transport for the four host routes.
 *
 * The Harness web frontend may be mounted under a path and may keep a
 * `<base href="./">` in the document; the DeepSeek plugin reference therefore
 * tries the document-relative route first and the root-absolute one second.
 * A 404 before the host half mounted is expected and stays silent.
 */

/** Route prefixes, document-relative first. */
const PREFIXES = ['jev-highlight/', '/jev-highlight/'] as const

/** Marker so callers can distinguish "route not mounted yet" from real errors. */
export class HostUnavailableError extends Error {
  readonly status: number | undefined

  constructor(status?: number) {
    super(status === undefined ? 'jev-highlight host route unreachable' : `jev-highlight host route returned HTTP ${String(status)}`)
    this.name = 'HostUnavailableError'
    this.status = status
  }
}

export interface HostApi {
  /** GET one route; throws HostUnavailableError when every candidate prefix fails. */
  get(path: string): Promise<Record<string, unknown>>
  /** POST a JSON body; throws HostUnavailableError when every candidate prefix fails. */
  post(path: string, body: unknown): Promise<Record<string, unknown>>
  /** True once a request succeeded, i.e. the host half is mounted. */
  mounted(): boolean
}

interface HostApiOptions {
  /** Injectable for tests; defaults to the page's own fetch (same-origin cookies apply). */
  fetchImpl?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Create the host transport. One instance per plugin application.
 */
export function createHostApi(options: HostApiOptions = {}): HostApi {
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  let resolvedPrefix: string | null = null
  let mounted = false

  async function request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const prefixes = resolvedPrefix === null ? PREFIXES : [resolvedPrefix]
    let lastStatus: number | undefined
    let lastError: unknown
    for (const prefix of prefixes) {
      try {
        const response = await fetchImpl(`${prefix}${path}`, { cache: 'no-store', ...init })
        if (!response.ok) {
          lastStatus = response.status
          continue
        }
        const body: unknown = await response.json()
        if (!isRecord(body)) {
          lastError = new Error('jev-highlight host route returned a non-object JSON body')
          continue
        }
        resolvedPrefix = prefix
        mounted = true
        return body
      } catch (cause) {
        lastError = cause
      }
    }
    if (lastError instanceof Error && lastStatus === undefined) {
      // Network-level failure (server not listening yet): same silent retry path.
      throw new HostUnavailableError()
    }
    throw new HostUnavailableError(lastStatus)
  }

  return {
    get(path) {
      return request(path, { method: 'GET', headers: { accept: 'application/json' } })
    },
    post(path, body) {
      return request(path, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    },
    mounted() {
      return mounted
    },
  }
}
