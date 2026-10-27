/**
 * Minimal fair semaphore with abort support.
 *
 * The Jev client caps concurrent HTTP requests with it; the pipeline caps
 * concurrent unit jobs with the same limit. `maxObserved` is exported through
 * diagnostics so an E2E run can assert the configured concurrency was never
 * exceeded.
 */
import { JevAbortError } from './errors.js'

interface Waiter {
  resolve: (release: () => void) => void
  reject: (error: unknown) => void
  signal: AbortSignal | undefined
  detach: (() => void) | undefined
}

export class Semaphore {
  readonly limit: number
  private activeCount = 0
  private maxActiveObserved = 0
  private readonly waiters: Waiter[] = []

  constructor(limit: number) {
    const normalised = Math.floor(limit)
    if (!Number.isFinite(normalised) || normalised < 1) {
      throw new RangeError(`Semaphore limit must be a positive integer, got ${String(limit)}`)
    }
    this.limit = normalised
  }

  /** Slots currently held. */
  get active(): number {
    return this.activeCount
  }

  /** Requests waiting for a slot. */
  get waiting(): number {
    return this.waiters.length
  }

  /** Highest `active` value ever observed. */
  get maxObserved(): number {
    return this.maxActiveObserved
  }

  /**
   * Acquire one slot, resolving with an idempotent release function.
   * Rejects with {@link JevAbortError} when `signal` aborts before the slot is
   * granted.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new JevAbortError('aborted before acquiring a concurrency slot'))
    }
    if (this.activeCount < this.limit) {
      this.activeCount += 1
      this.observe()
      return Promise.resolve(this.makeRelease())
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, detach: undefined }
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          waiter.detach = undefined
          reject(new JevAbortError('aborted while waiting for a concurrency slot'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        waiter.detach = () => signal.removeEventListener('abort', onAbort)
      }
      this.waiters.push(waiter)
    })
  }

  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.release()
    }
  }

  private release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1)
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift() as Waiter
      if (waiter.detach !== undefined) waiter.detach()
      if (waiter.signal?.aborted) {
        waiter.reject(new JevAbortError('aborted while waiting for a concurrency slot'))
        continue
      }
      this.activeCount += 1
      this.observe()
      waiter.resolve(this.makeRelease())
      return
    }
  }

  private observe(): void {
    if (this.activeCount > this.maxActiveObserved) this.maxActiveObserved = this.activeCount
  }
}
