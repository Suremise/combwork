// A start whose single-instance lock is refused (HI-3454). Electron's requestSingleInstanceLock() says false both when it
// told a running copy of Combwork about this start and when no copy answered because the profile's lock is held by one
// still ending: a copy that crashed or was ended from outside holds Chromium's `lockfile` until Windows has closed its
// handles, which takes a moment after its window has gone (about half a second under load, measured in HI-3454's runs).
// A reopen in that moment left as "already running", with nothing brought forward and nothing opened. Only the copy
// holding the lock has that file open (for writing, shared for reading only, deleted on close), so this start waits,
// within a bound, for the file to be free, and then asks for the lock once more. A copy that is running holds it
// throughout: the wait runs out and the start leaves as before, having told that copy.

import { closeSync, openSync } from 'original-fs'
import { join } from 'path'

/**
 * How long a refused start waits for the profile's lock to be released: a bound for a copy that is still ending, a few
 * times the longest seen. A copy that is running holds the lock throughout, so a start that told it waits this long
 * before leaving (with no window: the running copy has already been brought forward).
 */
export const LOCK_RELEASE_WAIT_MS = 5_000
/** How often the wait looks at the lock. */
export const LOCK_POLL_MS = 50
/** Chromium's single-instance lock file in the profile folder (process_singleton_win.cc's kLockfile). */
export const LOCK_FILE = 'lockfile'

/**
 * Whether another process holds the profile's lock: its file there and not openable for writing (the holder shares it
 * for reading only). Gone, or openable, it is free. Any other failure (access denied while it's being deleted, say)
 * counts as held: the wait looks again.
 */
export function profileLockHeld(profile: string): boolean {
  try {
    closeSync(openSync(join(profile, LOCK_FILE), 'r+'))
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException | null)?.code !== 'ENOENT'
  }
}

export interface LockWait {
  /** Whether this start has the lock now. */
  taken: boolean
  /** Whether the lock was seen free (taken, or another start's by the time this one asked). */
  released: boolean
  waitedMs: number
}

/** Holds this thread for `ms`: the wait runs before the app is ready, with no window or event to serve. */
const pauseThread = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Waits until `held()` says the lock is free, within `waitMs`, then calls `take()` once (requestSingleInstanceLock):
 * asked only once the lock is free, so a running copy is never told about this start twice.
 */
export function lockOnceReleased(take: () => boolean, held: () => boolean, opts: { waitMs?: number; pollMs?: number; now?: () => number; pause?: (ms: number) => void } = {}): LockWait {
  const waitMs = opts.waitMs ?? LOCK_RELEASE_WAIT_MS
  const pollMs = opts.pollMs ?? LOCK_POLL_MS
  const now = opts.now ?? Date.now
  const pause = opts.pause ?? pauseThread
  const start = now()
  for (;;) {
    if (!held()) return { taken: take(), released: true, waitedMs: now() - start }
    if (now() - start >= waitMs) return { taken: false, released: false, waitedMs: now() - start }
    pause(pollMs)
  }
}
