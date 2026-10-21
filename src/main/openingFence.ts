import { join, resolve, sep } from 'path'
import { HIVE_DIR } from '../shared/defaults'

/**
 * The fence at the databases' open (#1379): once a window starts closing a workspace, its databases (hive.db, the
 * Assistant's journal, usage.db) aren't opened again until a window opens the workspace again. Work still going on for
 * it (a read that resumes after the close, a job queued before it) used to open them again as the window switched away,
 * holding the folder until Hive quit, so it couldn't be moved or deleted. Keyed on the workspace, not on who asks: work
 * of no window's request (a timer, a session's end) is fenced as well. Openers that close again what they open (a store's
 * last save as its workspace closes) aren't fenced.
 */
const closed = new Map<string, Error>()

const keyOf = (path: string): string => resolve(path).toLowerCase()

/** A window starts closing the workspace: from now on its databases aren't opened, `reason` saying why. */
export function markClosed(path: string, reason: Error): void {
  closed.set(keyOf(path), reason)
}

/** A window opens the workspace (again): its databases open as they're used. */
export function markOpen(path: string): void {
  closed.delete(keyOf(path))
}

/** Why `file`, in the `.hive` of a workspace closed and not opened again since, isn't opened; null when it may be. */
export function fencedOut(file: string): Error | null {
  if (!closed.size) return null
  const f = resolve(file).toLowerCase()
  for (const [path, reason] of closed) {
    const d = join(path, HIVE_DIR)
    if (f === d || f.startsWith(d + sep)) return reason
  }
  return null
}

/** Throws why `file` isn't opened (fencedOut). */
export function assertNotFencedOut(file: string): void {
  const reason = fencedOut(file)
  if (reason) throw reason
}
