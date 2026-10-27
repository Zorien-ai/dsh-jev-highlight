/**
 * Error taxonomy for the host half.
 *
 * Every error carries a stable `code` so the pipeline can classify failures
 * (abort vs timeout vs HTTP vs budget) without string matching, and so tests
 * can assert on categories instead of messages.
 */

/** The caller aborted the request (turn cancelled, session disposed, plugin unloaded). */
export class JevAbortError extends Error {
  readonly code = 'JEV_ABORTED'

  constructor(message = 'Jev request was aborted') {
    super(message)
    this.name = 'JevAbortError'
  }
}

/** The per-request timeout fired before the response settled. */
export class JevTimeoutError extends Error {
  readonly code = 'JEV_TIMEOUT'

  constructor(message = 'Jev request timed out') {
    super(message)
    this.name = 'JevTimeoutError'
  }
}

/** The API answered with a non-retryable (or retry-exhausted) HTTP status. */
export class JevHttpError extends Error {
  readonly code = 'JEV_HTTP'
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'JevHttpError'
    this.status = status
  }
}

/** The planned request exceeds a token budget; the splitter must cut it first. */
export class JevBudgetError extends Error {
  readonly code = 'JEV_BUDGET'

  constructor(message: string) {
    super(message)
    this.name = 'JevBudgetError'
  }
}

/** The response body was not the JSON document we expect. */
export class JevParseError extends Error {
  readonly code = 'JEV_PARSE'

  constructor(message: string) {
    super(message)
    this.name = 'JevParseError'
  }
}

/** True for abort-shaped errors, whatever realm/class produced them. */
export function isAbortLike(error: unknown): boolean {
  if (error === null || error === undefined) return false
  if (typeof error === 'object') {
    const candidate = error as { name?: unknown; code?: unknown; message?: unknown }
    if (candidate.name === 'AbortError' || candidate.name === 'JevAbortError') return true
    if (candidate.code === 'JEV_ABORTED' || candidate.code === 'ABORT_ERR') return true
    if (typeof candidate.message === 'string' && /aborted|aborterror/iu.test(candidate.message) && /abort/iu.test(candidate.message)) {
      return true
    }
  }
  return false
}

/** Human-readable, bounded description of an unknown error. */
export function describeError(error: unknown, limit = 400): string {
  let message: string
  if (error instanceof Error) {
    message = error.message === '' ? error.name : `${error.name}: ${error.message}`
  } else {
    try {
      message = typeof error === 'string' ? error : JSON.stringify(error)
    } catch {
      message = String(error)
    }
  }
  return message.length > limit ? `${message.slice(0, limit)}…` : message
}
