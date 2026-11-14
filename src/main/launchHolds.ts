// A folder held against agent launches (HI-2887; design HI-2887/s17–s20, HR1's): while something that must have no agent
// in a folder runs (jj's control workspace's making, which snapshots the project folder's working copy), no session is
// admitted there. Admission is where a start's folder becomes known (sessions.ts' `start`, once its place is resolved,
// before anything is launched or prepared); its record lasts until the start ends, by which time a started session's live
// entry covers the folder. Each side is one synchronous step on main's thread: a hold checks the admitted and live
// sessions and registers in the same step, and an admission checks the holds and registers in the same step, so neither
// can land between the other's check and its record.

import { containsPlace } from './fsutil'

/** What a hold reads of the sessions running: each live session's folder (its live entry), from sessions.ts. */
let liveFolders: () => string[] = () => []

/** Set by sessions.ts as it loads (so this module imports nothing of it). */
export function setLiveFolders(fn: () => string[]): void {
  liveFolders = fn
}

const holds = new Map<number, { folder: string; released: Promise<void>; release: () => void }>()
const admitted = new Map<string, string>()
let next = 1

/** Whether a folder is at or under another. */
const within = (folder: string, place: string): boolean => containsPlace(place, folder)

/**
 * Holds `folder` against launches: synchronous. Refused (what is in it) when a session is admitted or live at or under it,
 * or another hold covers it; else held until `release()` (always call it, in a `finally`).
 */
export function holdLaunches(folder: string): { release: () => void } | { busy: string } {
  for (const [id, cwd] of admitted) if (within(cwd, folder)) return { busy: id }
  for (const cwd of liveFolders()) if (within(cwd, folder)) return { busy: cwd }
  for (const h of holds.values()) if (within(folder, h.folder) || within(h.folder, folder)) return { busy: h.folder }
  const id = next++
  let release = (): void => undefined
  const released = new Promise<void>((resolve) => (release = resolve))
  holds.set(id, { folder, released, release })
  return {
    release: () => {
      const h = holds.get(id)
      if (!h) return
      holds.delete(id)
      h.release()
    }
  }
}

/**
 * Admits a start (`id`, its live id) whose folder is now known: waits while a hold covers it (until released, or the
 * start's cancel), then checks again and records the admission in the same synchronous step. False: cancelled while
 * waiting (nothing recorded). The record is removed by `endAdmission` when the start ends, however it ends.
 */
export async function admitLaunch(id: string, cwd: string, cancelled: () => boolean): Promise<boolean> {
  for (;;) {
    if (cancelled()) return false
    const blocking = [...holds.values()].find((h) => within(cwd, h.folder))
    if (!blocking) {
      admitted.set(id, cwd)
      return true
    }
    await Promise.race([blocking.released, new Promise((r) => setTimeout(r, 250).unref?.())])
  }
}

/** A start's admission ended (it started, failed or was cancelled): its live entry, if any, covers its folder now. */
export function endAdmission(id: string): void {
  admitted.delete(id)
}

/** For tests: everything let go of. */
export function resetLaunchHolds(): void {
  for (const h of holds.values()) h.release()
  holds.clear()
  admitted.clear()
}
