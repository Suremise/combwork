import { resolve } from 'path'
import { placeKey } from './places'

// The writes under way to each workspace's databases (HI-1368's drain): counted from the moment a write is asked for,
// before it waits for the board's lock, until it has ended, however it ends. A workspace's close command runs only once
// none is left for it, so a store's last save as it closes lands first. Counted by the spelling the write was given
// (resolved, lower-cased: no look at the disk on each save); the drain matches spellings to the workspace's real place.

const counts = new Map<string, number>()
const waiters = new Set<() => void>()

const keyOf = (path: string): string => resolve(path).toLowerCase()

/** A write to the workspace's databases begins: the function returned ends it (once). */
export function beginWrite(workspacePath: string): () => void {
  const key = keyOf(workspacePath)
  counts.set(key, (counts.get(key) ?? 0) + 1)
  let ended = false
  return () => {
    if (ended) return
    ended = true
    const n = (counts.get(key) ?? 1) - 1
    if (n > 0) counts.set(key, n)
    else counts.delete(key)
    for (const w of [...waiters]) w()
  }
}

/** Runs `fn` as a counted write to the workspace's databases. */
export async function countedWrite<T>(workspacePath: string, fn: () => Promise<T>): Promise<T> {
  const end = beginWrite(workspacePath)
  try {
    return await fn()
  } finally {
    end()
  }
}

/**
 * The writes under way to a place (its `placeKey`), whatever spelling each was given: `spelt`, the workspace's path as
 * Combwork has it, matches without a look at the disk.
 */
export function writesAt(place: string, spelt?: string): number {
  const own = spelt ? keyOf(spelt) : null
  let n = 0
  for (const [key, c] of counts) if (key === own || key === place || placeKey(key) === place) n += c
  return n
}

/** Called whenever a write ends (a drain looks again then); the function returned stops it. */
export function onWriteEnded(fn: () => void): () => void {
  waiters.add(fn)
  return () => waiters.delete(fn)
}
