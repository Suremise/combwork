// HI-3158: a jj check's stat snapshot (jjChecks.ts' jjStats) holds the folders of the revision's files, the workspace's
// root included, so a file made beside them shows. A folder's line also changes when an entry jj ignores comes or goes (a
// build's `out/`, a `__pycache__/`), and a build that deletes its output folder and makes it again was never credited.
//
// So the run watches each such folder (not its subfolders) from before t0 until after t1 (RunWatch), and the start keeps
// each one's entries (name and file id). Where only folders' lines moved, each moved folder is explained when:
//  - its watch was there throughout, never lost events, and settled at the end;
//  - every entry that came, went or was made again between the two listings (a new id under the same name) is among the
//    names the watch saw (else it missed something);
//  - and every name the watch saw is one jj ignores, by the rules jj reads (the tracked `.gitignore` files, its Git
//    store's `info/exclude`, Git's global excludes), asked of Git with the store as its folder (`check-ignore
//    --no-index`), colocated or not. jj's and Git's own folders, the revision's files and the snapshot's folders (their
//    own lines decide) aren't asked.
// The watch is what sees a file not ignored made and deleted during the run (HR1's round 1): the listings at the ends
// can't. Anything else (a folder the watch didn't cover, a name not ignored, an unreadable entry or listing, Git failing,
// a folder whose time moved with no name to explain it) still counts.

import { watch, type FSWatcher } from 'original-fs'
import { lstat, readdir } from 'original-fs/promises'
import { join } from 'path'
import { git } from '../git'
import { isAbsent } from './jjView'
import { jjGitStoreOf } from './jjKeepOut'

/** Entries stat'ed at once (jjStats' bound). */
const AT_ONCE = 8

/** jj's and Git's own folders: never counted (jjChecks.ts' `internal`). */
const INTERNAL = new Set(['.jj', '.git'])

/** At most this many folders are watched for a run; beyond, none is (their lines count as before HI-3158). */
export const RUN_WATCH_MAX = 64
/** A watch just started may miss the first moment's events (observe.ts' ARM_MS): t0 comes this long after it starts. */
const ARM_MS = 250
/** At the end, events are let in until the watches are quiet this long (observe.ts' settle), at most SETTLE_MAX_MS. */
const QUIET_MS = 150
const SETTLE_MAX_MS = 2000
/** A watch left open (a bracket whose end never came) closes itself after this long, incomplete. */
const LIFETIME_MS = 12 * 60 * 60 * 1000

/** One folder's entries: name → its identity (`d:` or `f:` and the file id), `?` where it couldn't be stat'ed. */
export type FolderEntries = Map<string, string>

/** Each folder's entries (workspace-relative, `.` the root); a folder that couldn't be listed is null. */
export type EntriesOf = Map<string, FolderEntries | null>

/** What a run's watches saw, by folder: the names, or null where the watch wasn't there throughout. */
export type WatchedNames = Map<string, Set<string> | null>

/** The folders of a revision's files, `.` (the root) included: the folder lines of jjStats' snapshot, sorted. */
export function foldersOf(files: string[]): string[] {
  const dirs = new Set<string>(['.'])
  for (const f of files) {
    const i = f.lastIndexOf('/')
    if (i > 0) for (let d = f.slice(0, i); d; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') dirs.add(d)
  }
  return [...dirs].sort()
}

/**
 * A run's watches on the snapshot's folders, each non-recursive. `settle` waits for them to be quiet and closes them;
 * `close` alone closes them (an end that didn't need them). A watch that failed to start, errored or lost events (a null
 * name) is null in what it saw.
 */
export class RunWatch {
  private readonly names = new Map<string, Set<string> | null>()
  private readonly watches: FSWatcher[] = []
  private readonly started = Date.now()
  private last = Date.now()
  private closed = false
  private readonly life: NodeJS.Timeout

  private constructor(root: string, folders: string[]) {
    for (const f of folders) {
      const seen = new Set<string>()
      this.names.set(f, seen)
      try {
        const w = watch(join(root, f), { persistent: false }, (_evt, name) => {
          this.last = Date.now()
          if (name === null || name === undefined || /[\\/]/.test(String(name))) this.names.set(f, null)
          else this.names.get(f)?.add(String(name))
        })
        w.on('error', () => this.names.set(f, null))
        this.watches.push(w)
      } catch {
        this.names.set(f, null)
      }
    }
    this.life = setTimeout(() => this.lost(), LIFETIME_MS)
    this.life.unref?.()
  }

  /** Watches these folders under root; null when there are more than RUN_WATCH_MAX. */
  static start(root: string, folders: string[]): RunWatch | null {
    return folders.length > RUN_WATCH_MAX ? null : new RunWatch(root, folders)
  }

  /** Resolves once the watches are armed (ARM_MS after they started). */
  async armed(): Promise<void> {
    const wait = ARM_MS - (Date.now() - this.started)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }

  /** Waits until quiet, closes, and says what each folder's watch saw; still busy at SETTLE_MAX_MS: every folder null. */
  async settle(): Promise<WatchedNames> {
    if (this.closed) return this.seen()
    const start = Date.now()
    for (;;) {
      const quiet = Date.now() - Math.max(this.last, start)
      if (quiet >= QUIET_MS) break
      if (Date.now() - start >= SETTLE_MAX_MS) {
        this.lost()
        break
      }
      await new Promise((r) => setTimeout(r, QUIET_MS - quiet + 5))
    }
    this.close()
    return this.seen()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.life)
    for (const w of this.watches) w.close()
  }

  private lost(): void {
    for (const f of this.names.keys()) this.names.set(f, null)
    this.close()
  }

  private seen(): WatchedNames {
    return new Map(this.names)
  }
}

/** One folder's entries; null when it can't be listed. */
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

/** The entries of these folders (foldersOf's), one folder at a time. */
export async function jjEntries(root: string, folders: string[]): Promise<EntriesOf> {
  const out: EntriesOf = new Map()
  for (const f of folders) out.set(f, await entriesOf(root, f))
  return out
}

/**
 * The names of the entries that came, went or were made again between two listings of a folder, jj's and Git's own left
 * out of the root. Null where either side can't say (a listing or an entry unreadable).
 */
export function entriesChanged(folder: string, before: FolderEntries | null, after: FolderEntries | null): string[] | null {
  if (!before || !after) return null
  const out = new Set<string>()
  const skip = (name: string): boolean => folder === '.' && INTERNAL.has(name)
  for (const [name, id] of before) {
    if (skip(name)) continue
    const now = after.get(name)
    if (now === id && id !== '?') continue
    if (id === '?' || now === '?') return null
    out.add(name)
  }
  for (const [name, id] of after) {
    if (before.has(name) || skip(name)) continue
    if (id === '?') return null
    out.add(name)
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

/** What ignoredOnly needs: the revision's files, the start's listings and what the run's watches saw. */
export interface IgnoredEvidence {
  files: string[]
  before: EntriesOf | null
  watched: WatchedNames | null
}

/**
 * The folders (of `changed`, folder lines whose stat line moved) whose change only entries jj ignores explain (the
 * module's comment). Null when any changed folder isn't explained: the snapshot then counts as it did.
 */
export async function ignoredOnly(root: string, changed: string[], ev: IgnoredEvidence): Promise<string[] | null> {
  if (!changed.length || !ev.before || !ev.watched) return null
  // Names with their own lines in a folder: the revision's files and the snapshot's folders directly in it.
  const own = new Set([...ev.files, ...foldersOf(ev.files)])
  const asked: string[] = []
  for (const f of changed) {
    const was = ev.before.get(f)
    const saw = ev.watched.get(f)
    if (was === undefined || !saw) return null
    const now = await entriesOf(root, f)
    const diff = entriesChanged(f, was, now)
    if (!diff || !now || !diff.every((n) => saw.has(n))) return null
    const rel = (name: string): string => (f === '.' ? name : `${f}/${name}`)
    const names = [...saw].filter((n) => !(f === '.' && INTERNAL.has(n)) && !own.has(rel(n)))
    // Its time moved, and nothing to say why: something came and went that no event named.
    if (!names.length) return null
    for (const n of names) {
      // A folder is asked with its slash (Git's rules for folders need it), as it is now or was at the start; one that
      // came and went unseen by either listing is asked as a file (a folder rule then doesn't match: it counts).
      const id = now.get(n) ?? was?.get(n)
      asked.push(`${rel(n)}${id?.startsWith('d:') ? '/' : ''}`)
    }
  }
  const ignored = await jjIgnored(root, asked)
  if (!ignored || !asked.every((p) => ignored.has(p))) return null
  return changed
}
