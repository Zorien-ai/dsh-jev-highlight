/**
 * AbortSignal helpers.
 *
 * Requests are cancelled by a combination of three sources: the per-session
 * controller (turn/session teardown), the per-attempt controller (an abandoned
 * model attempt) and the per-request timeout. `AbortSignal.any` combines them
 * on modern hosts; the manual fallback keeps the code runnable on older Node.
 */

export type AbortSignalList = ReadonlyArray<AbortSignal | undefined>

/** Combine several optional signals into one; never returns undefined. */
export function combineSignals(signals: AbortSignalList): AbortSignal {
  const filtered: AbortSignal[] = []
  for (const signal of signals) {
    if (signal !== undefined) filtered.push(signal)
  }
  if (filtered.length === 0) return new AbortController().signal
  const first = filtered[0]
  if (filtered.length === 1 && first !== undefined) return first
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof any === 'function') return any.call(AbortSignal, filtered)

  const controller = new AbortController()
  const onAbort = (): void => {
    controller.abort()
  }
  for (const signal of filtered) {
    if (signal.aborted) {
      controller.abort()
      return controller.signal
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  return controller.signal
}

export interface TimeoutSignal {
  readonly signal: AbortSignal
  clear(): void
}

/**
 * A clearable timeout signal.
 *
 * `AbortSignal.timeout` cannot be disarmed, which leaves dangling timers in
 * tests and in fast responses; this keeps the timer under our control and
 * unrefs it so a pending timeout never keeps the process alive.
 */
export function createTimeoutSignal(timeoutMs: number): TimeoutSignal {
  const controller = new AbortController()
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
    return { signal: controller.signal, clear: () => {} }
  }
  const timer = setTimeout(() => {
    controller.abort(new Error(`timeout after ${timeoutMs}ms`))
  }, timeoutMs)
  const unref = (timer as unknown as { unref?: () => void }).unref
  if (typeof unref === 'function') unref.call(timer)
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer)
    },
  }
}

/** Wait for `ms`, rejecting as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    function cleanup(): void {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
    function onAbort(): void {
      cleanup()
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const unref = (timer as unknown as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(timer)
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
  })
}
