import { realpathSync } from 'original-fs'
import { realpath } from 'original-fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'

// Telling places apart by their real locations (fsutil.ts re-exports them). A module of their own, with no logger and so
// no Electron in it: the usage worker's code uses them (Copilot's sessions, a transcript's paths), and a worker thread
// can't load Electron (HI-1880: tests/workerImports.test.ts).

/**
 * The real location of a path, following symlinks and junctions (for a path that doesn't exist yet, its
 * nearest existing folder's real location plus the rest).
 */
export function realPath(p: string): string {
  let head = resolve(p)
  const rest: string[] = []
  for (;;) {
    try {
      return rest.length ? join(realpathSync.native(head), ...rest.reverse()) : realpathSync.native(head)
    } catch {
      const up = dirname(head)
      if (up === head) return resolve(p)
      rest.push(head.slice(up.length).replace(/^[\\/]/, ''))
      head = up
    }
  }
}

/**
 * `realPath`, resolved off main's thread (HI-1909: the usage history resolves its file on every request, a few ms of
 * main's thread each under load): the same location, the same fallback for a path that doesn't exist yet.
 */
export async function realPathAsync(p: string): Promise<string> {
  let head = resolve(p)
  const rest: string[] = []
  for (;;) {
    try {
      const real = await realpath(head)
      return rest.length ? join(real, ...rest.reverse()) : real
    } catch {
      const up = dirname(head)
      if (up === head) return resolve(p)
      rest.push(head.slice(up.length).replace(/^[\\/]/, ''))
      head = up
    }
  }
}

/**
 * A path's key for telling whether two paths are the same place: its real location (`realPath`), lower-cased. Git lists
 * worktrees by their real, long names, so a path Hive was given or saved as an 8.3 short name (C:\Users\RUNNER~1\…),
 * through a junction or a symlink only matches git's by this (#389). One that can't be resolved keys as written.
 */
export const placeKey = (p: string): string => realPath(p).toLowerCase()

/**
 * Whether two paths are the same place (`placeKey`). Spelt the same, they are, with no look at the disk (HI-1783: a
 * check's resolve compared its folders this way, a realpath each on main's thread, a few ms apiece).
 */
export const samePlace = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase() || placeKey(a) === placeKey(b)

/**
 * A test for whether a path is the place `folder` is, for matching the cwd a CLI recorded with Hive's spelling of a
 * folder (#493): the same spelling, or else the same real location (`placeKey`), each other spelling resolved once.
 */
export function placeMatcher(folder: string): (p: string) => boolean {
  const spelt = resolve(folder).toLowerCase()
  let key: string | undefined
  const seen = new Map<string, boolean>()
  return (p) => {
    const s = resolve(p).toLowerCase()
    if (s === spelt) return true
    let same = seen.get(s)
    if (same === undefined) {
      same = placeKey(p) === (key ??= placeKey(folder))
      seen.set(s, same)
    }
    return same
  }
}

/** `to` relative to `from` when it is inside it (or is it: ''), by spelling or else by real locations (`placeRelative`); else null. */
export function relativeInside(from: string, to: string): string | null {
  const rel = relative(from, to)
  if (!leavesFolder(rel)) return rel
  const real = relative(realPath(from), realPath(to))
  return leavesFolder(real) ? null : real
}

const leavesFolder = (rel: string): boolean => rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
