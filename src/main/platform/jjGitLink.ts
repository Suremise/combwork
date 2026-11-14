// A colocated jj slot's Git worktree link (HI-3046, design HI-3046/s7–s14).
//
// A colocated `jj workspace add` makes a Git worktree entry (`<store>/worktrees/<n>`) beside the jj workspace. jj 0.47.1
// unlinks it on `jj workspace forget` only while the workspace's folder is there; once the folder is deleted the entry
// outlives the forget, and the next `jj workspace add` at that path fails in Git ("a missing but already registered
// worktree"). R2.6 keeps every Git worktree command off jj slots, so the port clears such an entry itself, and only
// one it can prove is its own:
// - a receipt, written when the slot was made: the entry's path, its folder's file id and birth time (a replaced entry,
//   or a user's own worktree at the same path, has others), its `gitdir` and `commondir` bytes, the slot's workspace,
//   generation, folder and store;
// - cleared by moving it aside atomically (out of `worktrees`, so Git no longer sees it), then proved again on what was
//   moved (a rename keeps the file id), and only then removed; any mismatch or doubt leaves it, never deleted. An entry
//   with no receipt, or one that doesn't match it, is the user's to remove or keep.
// The predicates are synchronous, so the caller runs them with nothing awaited before the rename or the removal.

import { lstatSync, readFileSync, realpathSync } from 'original-fs'
import { lstat, readdir, readFile, realpath } from 'original-fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'

/** What the port recorded of a slot's Git worktree entry when it made the slot (board_meta, keyed by the slot's folder). */
export interface GitLinkReceipt {
  store: string
  folder: string
  workspace: string
  generation: string
  /** The entry's folder, `<store>/worktrees/<n>`. */
  entry: string
  /** The entry folder's file id and birth time. */
  entryId: string
  /** `<store>/worktrees`' own file id and birth time (a real folder, no link). */
  worktreesId: string
  /** The entry's `gitdir` and `commondir` files, byte for byte (as text). */
  gitdir: string
  commondir: string
  /** A clearing under way: the entry moved (or about to be moved) to `asideOf(store, clearing)`. */
  clearing?: string
  /** What a clearing left because it couldn't be proved, never removed by Combwork. */
  residues?: { path: string; why: string }[]
}

const same = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()
const realOr = async (p: string): Promise<string> => resolve(await realpath(p).catch(() => p))

export const worktreesOf = (store: string): string => join(store, 'worktrees')
/** Where a clearing moves an entry: in the store, outside `worktrees` (so no Git command sees it as a worktree). */
export const asideOf = (store: string, token: string): string => join(store, `.cw-gitlink-${token}`)

/** A `gitdir`/`commondir` file's path, resolved as Git does: absolute, or against the folder holding the file. */
const target = (from: string, text: string): string => {
  const t = text.trim()
  return isAbsolute(t) ? resolve(t) : resolve(from, t)
}

/** A receipt as the journal holds it, or null when it isn't one. */
export function asReceipt(v: unknown): GitLinkReceipt | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const strings = ['store', 'folder', 'workspace', 'generation', 'entry', 'entryId', 'worktreesId', 'gitdir', 'commondir'] as const
  if (!strings.every((k) => typeof r[k] === 'string' && r[k])) return null
  if (r.clearing !== undefined && typeof r.clearing !== 'string') return null
  if (r.residues !== undefined && !Array.isArray(r.residues)) return null
  return v as GitLinkReceipt
}

/** The residues a journal's record lists (a receipt's, or a record left with no receipt). */
export function residuesOf(v: unknown): { path: string; why: string }[] {
  const r = v && typeof v === 'object' ? (v as { residues?: unknown }).residues : null
  return Array.isArray(r) ? r.filter((x): x is { path: string; why: string } => !!x && typeof x.path === 'string' && typeof x.why === 'string') : []
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
 * The receipt for a slot just made: its folder's `.git` names exactly one entry, a real folder directly in the store's
 * `worktrees`, whose `gitdir` names the folder back and whose `commondir` is the store. Null when that isn't so.
 */
export async function receiptOf(o: { store: string; folder: string; workspace: string; generation: string }): Promise<GitLinkReceipt | null> {
  const dotGit = await readFile(join(o.folder, '.git'), 'utf8').catch(() => null)
  const m = dotGit ? /^gitdir:\s*(.+?)\s*$/m.exec(dotGit) : null
  if (!m) return null
  const entry = target(o.folder, m[1])
  if (!same(dirname(entry), worktreesOf(o.store))) return null
  const st = await lstat(entry).catch(() => null)
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return null
  // Physically where it says (HR1's round 1): no link or junction between the store and the entry, `worktrees` itself
  // a real folder whose identity the receipt keeps.
  if (!inStoreSync(o.store, entry)) return null
  const worktreesId = entryIdSync(worktreesOf(o.store))
  if (!worktreesId) return null
  const entryId = entryIdSync(entry)
  const gitdir = await readFile(join(entry, 'gitdir'), 'utf8').catch(() => null)
  const commondir = await readFile(join(entry, 'commondir'), 'utf8').catch(() => null)
  if (!entryId || gitdir === null || commondir === null) return null
  if (!same(await realOr(target(entry, gitdir)), await realOr(join(o.folder, '.git')))) return null
  if (!same(await realOr(target(entry, commondir)), await realOr(o.store))) return null
  const links = await linksTo(o.store, o.folder)
  if (!links || links.length !== 1 || !same(links[0], entry)) return null
  return { store: o.store, folder: o.folder, workspace: o.workspace, generation: o.generation, entry, entryId, worktreesId, gitdir, commondir }
}

/**
 * Whether a path under the store is physically there: its real path is the store's real path with the same path below
 * it, so no link or junction between the store and it (a `worktrees` junction, say); false when it can't be read.
 */
export function inStoreSync(store: string, p: string): boolean {
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
 * birth time, not `locked`, its `gitdir` and `commondir` the receipt's bytes, and the slot's folder still absent. Null
 * when proved; else why not (a protocol code, for the log and the residue).
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
