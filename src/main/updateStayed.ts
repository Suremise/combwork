/**
 * A CLI that stays on its version after an update (HI-2777). An organisation's remote settings can pin Claude Code's
 * channel or version: `claude update` then says it is up to date, or a session's updater puts the version back, and
 * Provider Setup would offer the same update again. Seen (an update Combwork ran ended well and the version didn't move
 * towards the one offered, or a later check found an older version than the last), Provider Setup says that a policy may
 * decide it, tentatively: the update stays available, and the note goes once the CLI or its version changes, or after a
 * day. An unchanged CLI can have other causes, so nothing is claimed.
 */

/** How long a note lasts without the version changing. */
export const STAYED_MS = 24 * 60 * 60 * 1000

export interface StayedRecord {
  path: string
  /** The version it stayed on. */
  version: string
  /** The version that was offered. */
  offered: string
  at: number
}

/** An update Combwork started: the CLI, its version then and the one offered. */
export interface UpdateExpectation {
  path: string
  from: string | null
  offered: string | null
}

/** The note after a check: the one kept (still the same CLI and version, within a day), a new one, or none. */
export function judgeStayed(i: { expect: UpdateExpectation | null; prev: { path: string | null; version: string | null }; next: { path: string | null; version: string | null; latest: string | null }; held: StayedRecord | null; now: number; isNewer: (a: string, b: string) => boolean }): StayedRecord | null {
  const { next } = i
  if (!next.path || !next.version) return null
  const held = i.held && i.held.path === next.path && i.held.version === next.version && i.now - i.held.at <= STAYED_MS ? i.held : null
  const e = i.expect
  // The update ended well, and the version didn't move towards the one offered.
  if (e && e.path === next.path && e.offered && i.isNewer(e.offered, next.version) && (!e.from || !i.isNewer(next.version, e.from))) return { path: next.path, version: next.version, offered: e.offered, at: i.now }
  // The same CLI found older than the last check found it: something put it back.
  if (i.prev.path === next.path && i.prev.version && i.isNewer(i.prev.version, next.version)) return { path: next.path, version: next.version, offered: next.latest && i.isNewer(next.latest, next.version) ? next.latest : i.prev.version, at: i.now }
  return held
}
