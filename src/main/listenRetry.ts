import type { Server } from 'net'

/** How often the Agent API's listen is tried again while its port is in use after an unexpected close (HI-2196). */
export const LISTEN_RETRY_MS = 250
/** How long, from the first try, it is tried again before giving up as a single try does. */
export const LISTEN_RETRY_BOUND_MS = 5000

export interface ListenRetryOptions {
  /** Whether a port in use (EADDRINUSE) is tried again; without, the first try's error is the answer. */
  retry: boolean
  retryMs?: number
  /** From the first try, on a monotonic clock: tries stop once the next would start after it. */
  boundMs?: number
  /** Aborted: the try under way is closed, no other is made, and it rejects with an AbortError. */
  signal?: AbortSignal
  /** Once, when the first try finds the port in use and it starts trying again. */
  onWait?: () => void
  /** A monotonic clock in ms (tests). */
  now?: () => number
}

export interface Listening<S extends Server> {
  server: S
  tries: number
  /** From the first try to the one that listened. */
  waitedMs: number
}

const aborted = (): Error => Object.assign(new Error('The listen was stopped'), { name: 'AbortError' }) // i18n-ignore: an internal AbortError, never shown

/** One listen of a new server: resolves once it listens, rejects with its error (the server closed) or on abort. */
function listenOnce(server: Server, port: number, host: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      server.off('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const onError = (e: Error): void => {
      done()
      server.close(() => undefined)
      reject(e)
    }
    const onAbort = (): void => {
      done()
      server.close(() => undefined)
      reject(aborted())
    }
    if (signal?.aborted) return reject(aborted())
    server.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    server.listen(port, host, () => {
      done()
      resolve()
    })
  })
}

/** Waits ms, or rejects with an AbortError once signal is aborted. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted())
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(aborted())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Listens on port with a server from make(), trying again with a new one while the port is in use, when `retry` says so,
 * until boundMs from the first try (HI-2196: after an unexpected close the copy just ended may still hold its port). Only
 * EADDRINUSE is tried again; another error, the bound passed or an abort rejects with that error, each server that failed
 * closed. The server that listens is the caller's.
 */
export async function listenWithRetry<S extends Server>(make: () => S, port: number, host: string, opts: ListenRetryOptions): Promise<Listening<S>> {
  const { retry, retryMs = LISTEN_RETRY_MS, boundMs = LISTEN_RETRY_BOUND_MS, signal, onWait, now = () => performance.now() } = opts
  const start = now()
  const deadline = start + boundMs
  for (let tries = 1; ; tries++) {
    const server = make()
    try {
      await listenOnce(server, port, host, signal)
      return { server, tries, waitedMs: Math.round(now() - start) }
    } catch (e) {
      if (!retry || (e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || now() + retryMs > deadline) throw Object.assign(e as Error, { tries })
      if (tries === 1) onWait?.()
      await pause(retryMs, signal)
      // A pause that ended late (a busy event loop) makes no try past the bound: that try's error is the answer.
      if (now() > deadline) throw Object.assign(e as Error, { tries })
    }
  }
}
