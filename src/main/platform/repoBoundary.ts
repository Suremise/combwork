// A folder's repository boundary (HI-2896, J9f; design HI-2896/s13 and s16, HR1's): the nearest version-control marker
// at or above it, read from files with no process, which decides the platform that answers for the folder. A nearer `.jj`
// hides every repository above it, readable or not: a non-colocated jj workspace inside a Git working tree is jj's, and
// an unreadable `.jj` is unknown, never permission to ask the Git repository above it. A `.jj` with a `.git` beside it
// naming the same store is a colocated pair (Git's context, as before); a valid one naming another store is unknown;
// a stray or damaged `.jj` beside a `.git` leaves Git's own repository there, as before.
//
// A leaf (HR1's s13 answer): it imports only the file system, `path` and nothing of Combwork's, so the repository lock
// (repoLock.ts), the context ports (repoPorts.ts) and J0's detection (jjDetect.ts) can all read it without a cycle. Every
// read is asynchronous (no walk on main's thread blocks it) and bounded (LEVELS_MAX levels, MARKER_MAX bytes a marker).
// Nothing is cached: a walk is a few `stat`s for a project at its repository's root, and a lock or a write never rests
// on an earlier walk (s13 §3 resolves again after taking the lock).

import { open, realpath, stat } from 'original-fs/promises'
import { dirname, join, resolve } from 'path'

/** The most a marker file is read (a pointer, a store's type or target is a line); more is malformed. */
export const MARKER_MAX = 4096
/** The most folders looked at on the way up for a marker (deeper than Windows' paths go). */
export const LEVELS_MAX = 256

/** A folder's real path, resolved (null when it can't be read). */
export const real = (p: string): Promise<string | null> => realpath(p).then((r) => resolve(r), () => null)
export const isDir = (p: string): Promise<boolean> => stat(p).then((s) => s.isDirectory(), () => false)
/** What a path is: a folder, a file, something else (`other`), or nothing (null). */
export const kindOf = (p: string): Promise<'dir' | 'file' | 'other' | null> =>
  stat(p).then(
    (s) => (s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other'),
    (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : 'other')
  )

/** Two folders compared as Windows compares them: case-insensitively, resolved. */
export const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

/**
 * A marker file's one line, trimmed: null when it is unreadable, empty, larger than MARKER_MAX, more than one line or
 * holds a NUL (malformed: never followed).
 */
export async function line(p: string): Promise<string | null> {
  const f = await open(p, 'r').catch(() => null)
  if (!f) return null
  try {
    const buf = Buffer.alloc(MARKER_MAX + 1)
    const { bytesRead } = await f.read(buf, 0, buf.length, 0)
    if (bytesRead > MARKER_MAX) return null
    const t = buf.subarray(0, bytesRead).toString('utf8').trim()
    return t && !/[\r\n\0]/.test(t) ? t : null
  } catch {
    return null
  } finally {
    await f.close().catch(() => undefined)
  }
}

/** Whether a folder is itself a Git dir (a bare store, a `.git` folder): a HEAD file and an objects folder. */
export async function isGitDir(folder: string): Promise<boolean> {
  return (await kindOf(join(folder, 'HEAD'))) === 'file' && (await isDir(join(folder, 'objects')))
}

/**
 * The common git dir of a git dir (`own`): a worktree's administrative folder names it in `commondir`, so it is never
 * taken for a store of its own (a second lock); else the folder itself. Real, and only a Git folder (it has a HEAD).
 */
export async function commonOf(own: string): Promise<string | null> {
  const pointer = await line(join(own, 'commondir'))
  const common = await real(pointer ? resolve(own, pointer) : own)
  return common && (await kindOf(join(common, 'HEAD'))) === 'file' ? common : null
}

/** The common git dir a root's `.git` names (a folder, or a worktree's `gitdir:` file), real; null for none or malformed. */
export async function gitCommonDir(root: string): Promise<string | null> {
  const dot = join(root, '.git')
  const k = await kindOf(dot)
  if (k === 'dir') return commonOf(dot)
  if (k !== 'file') return null
  const gitdir = /^gitdir: (.+)$/.exec((await line(dot)) ?? '')?.[1]?.trim()
  return gitdir ? commonOf(resolve(root, gitdir)) : null
}

/** Why a jj workspace's store couldn't be read (J0's codes, `jjNotDir` added). */
export type BoundaryUnknown = 'jjNotDir' | 'noRepo' | 'emptyPointer' | 'repoGone' | 'storeType' | 'backend' | 'gitStore' | 'colocatedDisagrees' | 'levels'

/**
 * A jj workspace root's shared repository and Git store, from its files as J0 reads them: `.jj/repo` (the folder, or a
 * file naming it), `store/type` `git`, `store/git_target` naming a Git dir (its common dir, real).
 */
export async function jjStoreOf(root: string): Promise<{ jjRepo: string; store: string; linked: boolean } | { unknown: BoundaryUnknown; detail: string }> {
  const dotJj = join(root, '.jj')
  const repoAt = join(dotJj, 'repo')
  const repoKind = await kindOf(repoAt)
  if (repoKind !== 'dir' && repoKind !== 'file') return { unknown: 'noRepo', detail: repoAt }
  const pointer = repoKind === 'file' ? await line(repoAt) : null
  if (repoKind === 'file' && !pointer) return { unknown: 'emptyPointer', detail: repoAt }
  const jjRepo = await real(pointer ? resolve(dotJj, pointer) : repoAt)
  if (!jjRepo || !(await isDir(jjRepo))) return { unknown: 'repoGone', detail: pointer ?? repoAt }
  const backend = await line(join(jjRepo, 'store', 'type'))
  if (backend === null) return { unknown: 'storeType', detail: join(jjRepo, 'store', 'type') }
  if (backend !== 'git') return { unknown: 'backend', detail: backend.slice(0, 40) }
  const target = await line(join(jjRepo, 'store', 'git_target'))
  const store = target ? await commonOf(resolve(jjRepo, 'store', target)) : null
  if (!store) return { unknown: 'gitStore', detail: target ?? join(jjRepo, 'store', 'git_target') }
  return { jjRepo, store, linked: repoKind === 'file' }
}

/**
 * A folder's repository boundary: Git's (`git`: the root whose `.git` is nearest; Git itself names its store), a
 * colocated pair (`colocated`: `.jj` and `.git` at one root naming one store), jj's alone (`jj`: no `.git` beside the
 * `.jj`), none (no marker up to the drive's root), or unknown (a nearer `.jj` that can't be read, or of the wrong type).
 */
export type Boundary =
  | { git: { root: string } }
  | { colocated: { root: string; store: string } }
  | { jj: { root: string; store: string; jjRepo: string; linked: boolean } }
  | { none: true }
  | { unknown: BoundaryUnknown; root: string; detail?: string }

/** The nearest marker at or above `folder`, and what it says (see Boundary). */
export async function boundaryOf(folder: string): Promise<Boundary> {
  let dir = resolve(folder)
  for (let level = 0; level < LEVELS_MAX; level++) {
    const jjKind = await kindOf(join(dir, '.jj'))
    const gitKind = await kindOf(join(dir, '.git'))
    if (jjKind !== null && gitKind !== null) {
      // A `.git` at the same level: a colocated pair when the `.jj` is a valid jj repository naming the same store; a
      // valid one naming another store (or a `.git` that names none) is unknown, never answered by Git (HR1's round 1:
      // two repositories claim the folder). A stray or damaged `.jj` beside it (not a readable jj repository) leaves
      // Git's own repository there, as before HI-2896.
      const s = jjKind === 'dir' ? await jjStoreOf(dir) : null
      if (!s || 'unknown' in s) return { git: { root: dir } }
      const common = await gitCommonDir(dir)
      return common && samePath(common, s.store) ? { colocated: { root: dir, store: s.store } } : { unknown: 'colocatedDisagrees', root: dir, detail: common ?? join(dir, '.git') }
    }
    if (jjKind !== null) {
      if (jjKind !== 'dir') return { unknown: 'jjNotDir', root: dir, detail: join(dir, '.jj') }
      const s = await jjStoreOf(dir)
      if ('unknown' in s) return { unknown: s.unknown, root: dir, detail: s.detail }
      return { jj: { root: dir, store: s.store, jjRepo: s.jjRepo, linked: s.linked } }
    }
    if (gitKind !== null) return { git: { root: dir } }
    const up = dirname(dir)
    if (up === dir) return { none: true }
    dir = up
  }
  return { unknown: 'levels', root: dir }
}

/**
 * Whether Git may answer for `folder` (the veto, s13 §1): null when it may (a Git or colocated boundary, none, or the
 * folder itself a Git dir: a bare store, as the store's own lock names it); else why not (a non-colocated jj workspace,
 * or a nearer `.jj` that can't be read), with the jj root.
 */
export async function gitVeto(folder: string): Promise<{ why: 'jj' | BoundaryUnknown; root: string } | null> {
  if (await isGitDir(folder)) return null
  const b = await boundaryOf(folder)
  if ('jj' in b) return { why: 'jj', root: b.jj.root } // i18n-ignore: a code, never shown as text
  if ('unknown' in b) return { why: b.unknown, root: b.root }
  return null
}

/** The canonical key of a store (a Git dir): its real path, lower-cased, as every lock and fence compares stores. */
export async function canonicalStore(store: string): Promise<string> {
  return ((await real(store)) ?? resolve(store)).toLowerCase()
}
