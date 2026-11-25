// HI-3374: retrying what Windows or another git refuses for a moment (a file held open by a virus scanner or the search
// indexer, another git's index.lock), under a time bound rather than a count of tries, with waits that grow to a cap.
// No imports: the separately bundled workers (OpenCode's history) use it as main does.

/** How a retry is bounded: the whole of it (`boundMs`, from the first try), its first wait, and the longest wait. */
export interface RetryBound {
  boundMs: number
  firstMs: number
  capMs: number
  /** Each wait this much longer than the last; without it, each wait twice the last. */
  stepMs?: number
}

/**
 * The file renames that finish a save or move a folder aside (renameRetrying, rows 1, 2, 10, 11): up to 15 s, waits
 * from 15 ms, growing by 10 ms a try, capped at 250 ms.
 */
export const RENAME_RETRY: RetryBound = { boundMs: 15_000, firstMs: 15, capMs: 250, stepMs: 10 }

/**
 * "The index is busy" (another git holds index.lock or is rewriting the index), by what waits on it: taking a finished
 * commit's entries into the real index (`take`, row 8); publishing a moved line's index (`publish`, row 9); a read
 * (`read`, rows 12 and 13: waits of 50, 100, 200, 400, 800, 1600 ms, 3150 ms in all, under a 3200 ms bound).
 */
export const INDEX_BUSY = {
  take: { boundMs: 30_000, firstMs: 50, capMs: 1600 },
  publish: { boundMs: 10_000, firstMs: 50, capMs: 1600 },
  read: { boundMs: 3200, firstMs: 50, capMs: 1600 }
} satisfies Record<string, RetryBound>

/** The wait after try `n` (0 first): growing by `stepMs` a try, or doubling, never past `capMs`. */
export function retryWait(bound: RetryBound, n: number): number {
  const grown = bound.stepMs !== undefined ? bound.firstMs + n * bound.stepMs : bound.firstMs * 2 ** n
  return Math.min(bound.capMs, grown)
}

/**
 * Runs `attempt` until it returns, an error it throws isn't `transient` (thrown at once), or the bound is spent (the
 * last transient error thrown, `onGaveUp` told first). `guard`, when given, runs before every attempt and before every
 * wait, and stops it by throwing (the work's owner gone, a shutdown, a cancellation): no attempt runs once it refuses.
 * Each wait is cut to the time left, and no attempt starts once the bound has passed.
 */
export async function untilBound<T>(
  attempt: () => T | Promise<T>,
  o: { bound: RetryBound; transient: (e: unknown) => boolean; guard?: () => void | Promise<void>; onGaveUp?: (e: unknown, tries: number, ms: number) => void; now?: () => number; sleep?: (ms: number) => Promise<void> }
): Promise<T> {
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const started = now()
  const left = (): number => o.bound.boundMs - (now() - started)
  let last: unknown = undefined
  const giveUp = (tries: number): never => {
    o.onGaveUp?.(last, tries, now() - started)
    throw last
  }
  for (let n = 0; ; n++) {
    await o.guard?.()
    // HI-3374 (HR3's round 1): the time left read again after each awaited guard, right before the attempt: none, no attempt.
    if (n > 0 && left() <= 0) giveUp(n)
    try {
      return await attempt()
    } catch (e) {
      if (!o.transient(e)) throw e
      last = e
      if (left() <= 0) giveUp(n + 1)
      await o.guard?.()
      // Read again after the guard: its wait is cut to what is left then.
      const wait = Math.min(retryWait(o.bound, n), left())
      if (wait <= 0) giveUp(n + 1)
      await sleep(wait)
    }
  }
}

/**
 * Runs `attempt` again while its result says to (`again`), for the bound: the result of the last attempt made, once
 * `again` says no or the bound is spent. Waits and guard as untilBound's; an attempt throwing ends it (thrown).
 */
export async function retryWhile<T>(attempt: () => T | Promise<T>, again: (r: T) => boolean, o: { bound: RetryBound; guard?: () => void | Promise<void>; now?: () => number; sleep?: (ms: number) => Promise<void> }): Promise<T> {
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const started = now()
  const left = (): number => o.bound.boundMs - (now() - started)
  await o.guard?.()
  let r = await attempt()
  for (let n = 0; again(r); n++) {
    if (left() <= 0) return r
    await o.guard?.()
    // Read again after the guard (HR3's round 1).
    const wait = Math.min(retryWait(o.bound, n), left())
    if (wait <= 0) return r
    await sleep(wait)
    await o.guard?.()
    if (left() <= 0) return r
    r = await attempt()
  }
  return r
}

/** How many tries a bound allows when each try takes no time (its waits, from the first, until they pass the bound): for tests. */
export function triesWithin(bound: RetryBound): number {
  let tries = 1
  for (let n = 0, spent = retryWait(bound, 0); spent < bound.boundMs; n++, spent += retryWait(bound, n)) tries++
  return tries
}

/** A file held open for a moment (Windows refuses the rename or delete then). */
export const heldError = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}
