import { join, sep } from 'path'
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
const closed = new Map<string, Error>()

/**
 * How many closed workspaces are kept (#1381), the most recently closed: the map would otherwise grow with every workspace
 * closed and not opened again in a session. Dropping the oldest is safe: what the fence stops is work still under way for
 * a workspace as it closes (a request, a queued job, a timer, a session's end), which ends within seconds or minutes; by
 * the time this many other workspaces have closed after it, none of it is left to open the files again.
 */
export const MAX_CLOSED = 64

/** A window starts closing the workspace: from now on its databases aren't opened, `reason` saying why. */
export function markClosed(path: string, reason: Error): void {
  const key = placeKey(path)
  // The newest last: closed again, it moves to the end.
  closed.delete(key)
  closed.set(key, reason)
  while (closed.size > MAX_CLOSED) closed.delete(closed.keys().next().value!)
}

/** A window opens the workspace (again): its databases open as they're used. */
export function markOpen(path: string): void {
  closed.delete(placeKey(path))
}

/** Why `file`, in the `.hive` of a workspace closed and not opened again since, isn't opened; null when it may be. */
export function fencedOut(file: string): Error | null {
  if (!closed.size) return null
  // A file not made yet: by its nearest existing folder's real location (realPath).
  const f = placeKey(file)
  for (const [key, reason] of closed) {
    const d = join(key, HIVE_DIR.toLowerCase())
    if (f === d || f.startsWith(d + sep)) return reason
  }
  return null
}

/** Throws why `file` isn't opened (fencedOut). */
export function assertNotFencedOut(file: string): void {
  const reason = fencedOut(file)
  if (reason) throw reason
}
