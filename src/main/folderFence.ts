import { resolve, sep } from 'path'
import { createLogger, userText } from './logger'

/**
 * Folders being changed under the agents working in them (#646): a Git action that switches the project folder's branch
 * or pulls into it, and anything else that rewrites a folder's files at once (1.0's merges Combwork does itself). While one
 * runs, Combwork starts no turn there of its own: nothing is typed into an agent working in that folder (lineWriter, so every
 * delivery: messages, wakes, loop wakes, tasks) and no agent starts or resumes there (sessions' launch); both wait for it.
 * A fence lasts as long as what it guards (`changingFolder`), never longer. What the user types into a terminal can't be
 * held. In memory: an operation runs in one process.
 */

const log = createLogger('folders')

interface Fence {
  folder: string
  /** What changes it, for the log and for why a line waits ("a Git switch"). */
  what: string
  done: Promise<void>
}

const fences = new Set<Fence>()
const lifted: ((folder: string) => void)[] = []

const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()

/** Whether `path` is `folder` itself or inside it (a subfolder an agent works in changes with it). */
export const inFolder = (path: string, folder: string): boolean => {
  const p = norm(path)
  const f = norm(folder)
  return p === f || p.startsWith(f + sep) || p.startsWith(`${f}/`)
}

/**
 * Runs `fn` with `folder` fenced: no Hive-sent line is typed and no agent starts in it until `fn` settles. The fence is
 * up before `fn` starts, so a check `fn` makes first (an agent there busy?) can't be overtaken by a turn Combwork starts.
 */
export async function changingFolder<T>(folder: string, what: string, fn: () => Promise<T>): Promise<T> {
  let release!: () => void
  const fence: Fence = { folder, what, done: new Promise<void>((r) => (release = r)) }
  fences.add(fence)
  const t0 = Date.now()
  try {
    return await fn()
  } finally {
    fences.delete(fence)
    release()
    log.info(`${userText(folder)}: ${what} done, ${Date.now() - t0} ms; Combwork's lines and starts there go on`)
    for (const tell of lifted) {
      try {
        tell(folder)
      } catch (e) {
        log.warn('after a folder change', e)
      }
    }
  }
}

/** What is changing the folder `path` is in now (null: nothing): Combwork types nothing into an agent working there. */
export function folderChanging(path: string | null | undefined): string | null {
  if (!path) return null
  for (const f of fences) if (inFolder(path, f.folder)) return f.what
  return null
}

/** Resolves once nothing is changing the folder `path` is in (at once when nothing is). */
export async function folderSteady(path: string | null | undefined): Promise<void> {
  if (!path) return
  for (;;) {
    const f = [...fences].find((x) => inFolder(path, x.folder))
    if (!f) return
    await f.done
  }
}

/** Told each time a folder's fence comes down (the delivery service offers what waited for it). */
export function onFolderSteady(fn: (folder: string) => void): void {
  lifted.push(fn)
}
