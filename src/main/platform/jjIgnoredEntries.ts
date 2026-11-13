// HI-3158: a jj check's stat snapshot (jjChecks.ts' jjStats) holds the folders of the revision's files, the workspace's
// root included, so a file made beside them shows. A folder's line also changes when an entry jj ignores comes or goes (a
// build's `out/`, a `__pycache__/`), and a build that deletes its output folder and makes it again was never credited.
// So the start keeps each such folder's entries (name and file id), and where only folder lines changed, the end asks
// which entries came, went or were made again (a new id under the same name), and whether jj ignores each: by the rules
// jj reads (the tracked `.gitignore` files, its Git store's `info/exclude`, Git's global excludes), asked of Git with the
// store as its folder (`check-ignore --no-index`), colocated or not. Every one ignored (or jj's and Git's own folders):
// the folder's line doesn't count. Anything else (an entry not ignored, an unreadable entry or listing, Git failing, or a
// folder whose time moved with no entry to explain it: something came and went) still counts.

import { lstat, readdir } from 'original-fs/promises'
import { join } from 'path'
import { git } from '../git'
import { isAbsent } from './jjView'
import { jjGitStoreOf } from './jjKeepOut'

/** Entries stat'ed at once (jjStats' bound). */
const AT_ONCE = 8

/** jj's and Git's own folders: never counted (jjChecks.ts' `internal`). */
const INTERNAL = new Set(['.jj', '.git'])

/** One folder's entries: name → its identity (`d:` or `f:` and the file id), `?` where it couldn't be stat'ed. */
export type FolderEntries = Map<string, string>

/** Each folder's entries (workspace-relative, `.` the root); a folder that couldn't be listed is null. */
export type EntriesOf = Map<string, FolderEntries | null>

/** The folders of a revision's files, `.` (the root) included: the folder lines of jjStats' snapshot, sorted. */
export function foldersOf(files: string[]): string[] {
  const dirs = new Set<string>(['.'])
  for (const f of files) {
    const i = f.lastIndexOf('/')
    if (i > 0) for (let d = f.slice(0, i); d; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') dirs.add(d)
  }
  return [...dirs].sort()
}

/** One folder's entries, off main's thread's blocking calls; null when it can't be listed. */
async function entriesOf(root: string, folder: string): Promise<FolderEntries | null> {
  const at = join(root, folder)
  const names = await readdir(at).catch(() => null)
  if (!names) return null
  const out: FolderEntries = new Map()
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < names.length) {
      const name = names[next++]
      // bigint: Windows' 64-bit file ids don't fit a double.
      const id = await lstat(join(at, name), { bigint: true }).then(
        (s) => `${s.isDirectory() ? 'd' : 'f'}:${s.ino}`,
        (e: unknown) => (isAbsent(e) ? null : '?')
      )
      // Gone between the listing and the stat: not there.
      if (id !== null) out.set(name, id)
    }
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, names.length) }, worker))
  return out
}

/** The entries of these folders (folderOf's), one folder at a time. */
export async function jjEntries(root: string, folders: string[]): Promise<EntriesOf> {
  const out: EntriesOf = new Map()
  for (const f of folders) out.set(f, await entriesOf(root, f))
  return out
}

/**
 * The entries that came, went or were made again between two listings of a folder, workspace-relative (a folder with a
 * trailing `/`, as Git's rules for folders need), jj's and Git's own left out. Null where either side can't say (a
 * listing or an entry unreadable).
 */
export function entriesChanged(folder: string, before: FolderEntries | null, after: FolderEntries | null): string[] | null {
  if (!before || !after) return null
  const rel = (name: string, id: string): string => `${folder === '.' ? '' : `${folder}/`}${name}${id.startsWith('d:') ? '/' : ''}`
  const out = new Set<string>()
  for (const [name, id] of before) {
    if (INTERNAL.has(name) && folder === '.') continue
    const now = after.get(name)
    if (now === id && id !== '?') continue
    if (id === '?' || now === '?') return null
    out.add(rel(name, id))
    if (now !== undefined) out.add(rel(name, now))
  }
  for (const [name, id] of after) {
    if (before.has(name) || (INTERNAL.has(name) && folder === '.')) continue
    if (id === '?') return null
    out.add(rel(name, id))
  }
  return [...out]
}

/**
 * Of these workspace-relative paths, those jj ignores (its Git store's rules, `check-ignore --no-index`, so a tracked
 * path is asked by its rules too). Null when Git can't say (no Git store, Git failing): nothing is taken as ignored.
 */
export async function jjIgnored(root: string, rels: string[]): Promise<Set<string> | null> {
  if (!rels.length) return new Set()
  const gd = await jjGitStoreOf(root)
  if (!gd) return null
  const r = await git(root, [`--git-dir=${gd}`, `--work-tree=${root}`, 'check-ignore', '--no-index', '-z', '--stdin'], undefined, rels.join('\0'))
  // Exit 1: none ignored. Anything else is Git failing.
  if (!r.ok && r.code !== 1) return null
  return new Set(r.out.split('\0').filter(Boolean))
}

/**
 * The folders (of `changed`, folder lines whose stat line moved) whose change only entries jj ignores explain: each has
 * at least one entry that came, went or was made again, and every such entry is ignored. Null when any changed folder
 * isn't explained: the snapshot then counts as it did.
 */
export async function ignoredOnly(root: string, changed: string[], before: EntriesOf | null): Promise<string[] | null> {
  if (!changed.length || !before) return null
  const asked: string[] = []
  for (const f of changed) {
    const was = before.get(f)
    if (was === undefined) return null
    const diff = entriesChanged(f, was, await entriesOf(root, f))
    // Unreadable, or nothing to explain the move: something came and went.
    if (!diff || !diff.length) return null
    asked.push(...diff)
  }
  const ignored = await jjIgnored(root, asked)
  if (!ignored || !asked.every((p) => ignored.has(p))) return null
  return changed
}
