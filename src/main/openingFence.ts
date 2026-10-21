import { AsyncLocalStorage } from 'async_hooks'
import { join, resolve, sep } from 'path'
import { HIVE_DIR } from '../shared/defaults'

/**
 * One opening of a workspace that work began for (#1379): its folder, and that opening's lifetime (the workspace's
 * `lifetime` as the work began: closing aborts it, and the next opening has a new one).
 */
export interface Opening {
  path: string
  signal: AbortSignal
}

/**
 * The fence at the databases' open (#1379): work begun for one opening of a workspace never opens that workspace's
 * databases (hive.db, the Assistant's journal, usage.db) again once the opening closed, unless a window has the workspace
 * open again. A late read used to open them as the window switched away and hold the folder until Hive quit, so it
 * couldn't be moved or deleted. Openers that close again what they open (a store's save, Restore's copies) aren't fenced.
 */
const current = new AsyncLocalStorage<Opening | null>()
let openNow: (path: string) => boolean = () => false

/** Runs `fn` as work of `opening` (null: of none), whatever the work around it began for. */
export function inOpening<T>(opening: Opening | null, fn: () => T): T {
  return current.run(opening, fn)
}

/** The opening the current work began for, if any. */
export const currentOpening = (): Opening | null => current.getStore() ?? null

/** How the fence asks whether a window has a workspace open now (workspace.ts sets it). */
export function setOpenCheck(fn: (path: string) => boolean): void {
  openNow = fn
}

const inside = (file: string, dir: string): boolean => {
  const f = resolve(file).toLowerCase()
  const d = resolve(dir).toLowerCase()
  return f === d || f.startsWith(d + sep)
}

/** Whether the current work's opening has closed and `file` is in that workspace's `.hive`, not open again since. */
export function fencedOut(file: string): boolean {
  const o = current.getStore()
  return !!o?.signal.aborted && inside(file, join(o.path, HIVE_DIR)) && !openNow(o.path)
}

/** Throws the close's reason when `file` is fenced out (fencedOut). */
export function assertNotFencedOut(file: string): void {
  if (fencedOut(file)) current.getStore()!.signal.throwIfAborted()
}
