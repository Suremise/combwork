import { basename, dirname } from 'path'
import { HIVE_DIR } from '../shared/defaults'
import { placeKey } from './fsutil'

/**
 * The fence at the databases' open (#1379): once a window starts closing a workspace, its databases (hive.db, the
 * Assistant's journal, usage.db) aren't opened again until a window opens the workspace again. Work still going on for
 * it (a read that resumes after the close, a job queued before it) used to open them again as the window switched away,
 * holding the folder until Hive quit, so it couldn't be moved or deleted. Keyed on the workspace, not on who asks: work
 * of no window's request (a timer, a session's end) is fenced as well. Openers that close again what they open (a store's
 * last save as its workspace closes) aren't fenced. By real paths (`placeKey`), as workspaces are told apart: a junction,
 * a symlink or an 8.3 short name is the same workspace and the same file, however the closing or the opening spells it.
 */
/**
 * The workspaces closed and not opened again, by real path (#1381: what it costs). An entry ends only as a window opens
 * the workspace again, never for room: nothing tells when the last of a workspace's late work has ended (a delivery
 * store's tick, a job queued behind others, a read awaiting a slow disk), so an entry dropped earlier would let that work
 * open its files again and hold the folder (#1379), or recreate a folder the user deleted (openDb makes its folder). So it
 * keeps one path per workspace a window has closed this run (closed again, the same one), nothing else: about a hundred
 * bytes each, and a lookup costs the file's depth, not the count. Bounding it by ownership instead (only a workspace a
 * window has open may be opened, everything else a lease or refused) is #1395.
 */
const closed = new Set<string>()

/** The error a fenced open throws: the workspace's own (`setFenceReason`), else a plain one. */
let reasonOf = (): Error => new Error('The workspace was closed') // i18n-ignore: replaced by the workspace's message at start (setFenceReason)

/** The error a fenced open throws, made when one is refused (the workspace's "The workspace was closed"). */
export function setFenceReason(make: () => Error): void {
  reasonOf = make
}

/** A window starts closing the workspace: from now on its databases aren't opened. */
export function markClosed(path: string): void {
  closed.add(placeKey(path))
}

/** How many workspaces are closed and not opened again (tests, diagnostics). */
export const closedCount = (): number => closed.size

/** A window opens the workspace (again): its databases open as they're used. */
export function markOpen(path: string): void {
  closed.delete(placeKey(path))
}

/** Why `file`, in the `.hive` of a workspace closed and not opened again since, isn't opened; null when it may be. */
export function fencedOut(file: string): Error | null {
  if (!closed.size) return null
  // A file not made yet: by its nearest existing folder's real location (realPath). Each `.hive` above it is a workspace's.
  const hive = HIVE_DIR.toLowerCase()
  for (let d = placeKey(file); ; ) {
    if (basename(d) === hive && closed.has(dirname(d))) return reasonOf()
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
}

/** Throws why `file` isn't opened (fencedOut). */
export function assertNotFencedOut(file: string): void {
  const reason = fencedOut(file)
  if (reason) throw reason
}
