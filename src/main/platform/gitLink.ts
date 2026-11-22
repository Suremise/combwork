// A Git worktree registration's proof (HI-3046, HI-3069): what dropRegistration (gitWorkspacePort.ts) checks before it
// removes the one registration (`<store>/worktrees/<n>`) that names a missing folder.
//
// Only an entry it can prove is the one it read is cleared:
// - a receipt, taken just before: the entry's path, its folder's file id and birth time (a replaced entry, or a user's
//   own worktree at the same path, has others), `worktrees`' own, its `gitdir` and `commondir` bytes, the folder and
//   the store;
// - cleared by moving it aside atomically (out of `worktrees`, so Git no longer sees it), then proved again on what was
//   moved (a rename keeps the file id), and only then removed; any mismatch or doubt leaves it, never deleted.
// The predicates are synchronous, so the caller runs them with nothing awaited before the rename or the removal.

import { lstatSync, readFileSync, realpathSync } from 'original-fs'
import { readdir, readFile } from 'original-fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'

/** What dropRegistration read of a registration just before it moves it aside. */
export interface GitLinkReceipt {
  store: string
  folder: string
  /** The entry's folder, `<store>/worktrees/<n>`. */
  entry: string
  /** The entry folder's file id and birth time. */
  entryId: string
  /** `<store>/worktrees`' own file id and birth time (a real folder, no link). */
  worktreesId: string
  /** The entry's `gitdir` and `commondir` files, byte for byte (as text). */
  gitdir: string
  commondir: string
}

const same = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

export const worktreesOf = (store: string): string => join(store, 'worktrees')
/** Where a clearing moves an entry: in the store, outside `worktrees` (so no Git command sees it as a worktree). */
export const asideOf = (store: string, token: string): string => join(store, `.cw-gitlink-${token}`)

/** A `gitdir`/`commondir` file's path, resolved as Git does: absolute, or against the folder holding the file. */
const target = (from: string, text: string): string => {
  const t = text.trim()
  return isAbsolute(t) ? resolve(t) : resolve(from, t)
}

/** A folder's file id and birth time, not following a link; null when it isn't a real folder or can't be read. */
export function entryIdSync(p: string): string | null {
  try {
    const s = lstatSync(p, { bigint: true })
    return s.isDirectory() && !s.isSymbolicLink() && s.ino !== 0n ? `${s.ino}:${s.birthtimeNs}` : null
  } catch {
    return null
  }
}

/**
 * The Git worktree entries of a store whose `gitdir` names `<folder>/.git` (those a `git worktree add` there collides
 * with), whoever made them; null when the store's `worktrees` can't be read. An entry whose `gitdir` can't be read
 * names no folder (Git matches none to it either).
 */
export async function linksTo(store: string, folder: string): Promise<string[] | null> {
  const dir = worktreesOf(store)
  const names = await readdir(dir).catch((e: { code?: string }) => (e?.code === 'ENOENT' ? [] : null))
  if (!names) return null
  const want = join(folder, '.git')
  const out: string[] = []
  for (const n of names) {
    const e = join(dir, n)
    const t = await readFile(join(e, 'gitdir'), 'utf8').catch(() => null)
    if (t !== null && same(target(e, t), want)) out.push(e)
  }
  return out
}

/**
 * Whether a path under the store is physically there: its real path is the store's real path with the same path below
 * it, so no link or junction between the store and it (a `worktrees` junction, say); false when it can't be read.
 */
function inStoreSync(store: string, p: string): boolean {
  try {
    return same(realpathSync.native(p), join(realpathSync.native(store), relative(store, p)))
  } catch {
    return false
  }
}

/** Whether something is at a path: false only for ENOENT or ENOTDIR, null when it can't be told. */
function presentSync(p: string): boolean | null {
  try {
    lstatSync(p)
    return true
  } catch (e) {
    const code = (e as { code?: string }).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? false : null
  }
}

/** Why a path isn't there (ENOENT or ENOTDIR): true; there, or unreadable: false. */
function absentSync(p: string): boolean {
  try {
    lstatSync(p)
    return false
  } catch (e) {
    const code = (e as { code?: string }).code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }
}

/**
 * Whether `at` is still the receipt's entry, synchronously (the caller's last step before a rename or a removal): where
 * it should be (`entry`: in `worktrees`; `aside`: moved aside in the store), a real folder with the receipt's file id and
 * birth time, not `locked`, its `gitdir` and `commondir` the receipt's bytes, and the folder still absent. Null when
 * proved; else why not (a protocol code, for the log).
 */
export function provedSync(r: GitLinkReceipt, at: string, where: 'entry' | 'aside'): string | null {
  if (!same(dirname(at), where === 'entry' ? worktreesOf(r.store) : r.store)) return 'elsewhere' // i18n-ignore: a protocol code
  if (where === 'entry' && !same(at, r.entry)) return 'elsewhere' // i18n-ignore: a protocol code
  const id = entryIdSync(at)
  if (!id) return 'gone' // i18n-ignore: a protocol code
  if (id !== r.entryId) return 'replaced' // i18n-ignore: a protocol code
  // Physically in the store (HR1's round 1): no link or junction between the store and it (a `worktrees` redirected
  // since keeps the entry's own ids), and `worktrees` still the folder the receipt saw.
  if (!inStoreSync(r.store, at)) return 'indirect' // i18n-ignore: a protocol code
  if (where === 'entry' && entryIdSync(worktreesOf(r.store)) !== r.worktreesId) return 'worktrees' // i18n-ignore: a protocol code
  try {
    const locked = presentSync(join(at, 'locked'))
    if (locked !== false) return locked ? 'locked' : 'unreadable' // i18n-ignore: a protocol code
    if (readFileSync(join(at, 'gitdir'), 'utf8') !== r.gitdir) return 'gitdir' // i18n-ignore: a protocol code
    if (readFileSync(join(at, 'commondir'), 'utf8') !== r.commondir) return 'commondir' // i18n-ignore: a protocol code
  } catch {
    return 'unreadable' // i18n-ignore: a protocol code
  }
  if (!absentSync(r.folder)) return 'folder' // i18n-ignore: a protocol code
  return null
}
