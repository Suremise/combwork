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
// can't. Each name is asked about as every kind its entry had: a folder with its slash, a file without. A watch gives
// names only (a creation and a deletion alike), so each event's entry is stat'ed as it arrives (HR2's round 2: a file made
// where an ignored `out/` was). The residual, Darren's decision (13 Nov, r36): a file named as an ignored folder, made and
// deleted while that folder is remade, gone before its event is read (milliseconds), passes as the folder; reading kinds
// for certain needs the change journal, which needs admin rights. Anything else (a folder the watch didn't cover, a name not ignored, an unreadable entry or listing, Git failing,
// a folder whose time moved with no name to explain it) still counts.

import { watch, type FSWatcher } from 'original-fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'original-fs/promises'
import { tmpdir } from 'os'
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
/**
 * HR2's round 3, the service-changes resource rule: a run's kind reads are a few at a time (jjStats' bound), at most this
 * many names wait to be read, and a folder keeps at most this many names. Past either, that folder's watch is
 * incomplete (its line counts) and nothing more of it is read.
 */
export const RUN_READS_AT_ONCE = 8
export const RUN_READS_QUEUED = 256
export const RUN_NAMES_MAX = 4096

/** The tests' seams: the watch (a name per event, null for lost events) and the stat. */
export interface RunWatchSeams {
  watch?: (path: string, onEvent: (name: string | null) => void) => Pick<FSWatcher, 'on' | 'close'>
  lstat?: (path: string) => Promise<{ isDirectory(): boolean }>
}

/** One folder's entries: name → its identity (`d:` or `f:` and the file id), `?` where it couldn't be stat'ed. */
export type FolderEntries = Map<string, string>

/** Each folder's entries (workspace-relative, `.` the root); a folder that couldn't be listed is null. */
export type EntriesOf = Map<string, FolderEntries | null>

/** An entry's kind as read: a folder, a file (anything else), or unreadable. */
export type Kind = 'd' | 'f' | '?'

/**
 * What a run's watches saw, by folder: each name with the kinds its entry had when its events were read (none: gone each
 * time), or null where the watch wasn't there throughout.
 */
export type WatchedNames = Map<string, Map<string, Set<Kind>> | null>

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
  private readonly names = new Map<string, Map<string, Set<Kind>> | null>()
  private readonly watches: Pick<FSWatcher, 'on' | 'close'>[] = []
  /**
   * The kinds still to read (HR2's round 3: bounded): each folder and name once (`folder\0name`), at most
   * RUN_READS_QUEUED waiting and RUN_READS_AT_ONCE read at once. An event for a name being read reads it once more after.
   */
  private readonly queued = new Set<string>()
  private readonly inFlight = new Set<string>()
  private readonly again = new Set<string>()
  private idleWaiters: (() => void)[] = []
  private readonly started = Date.now()
  private last = Date.now()
  private closed = false
  private readonly life: NodeJS.Timeout

  private constructor(
    private readonly root: string,
    folders: string[],
    private readonly seams: RunWatchSeams
  ) {
    const watchOf = seams.watch ?? ((path, onEvent) => watch(path, { persistent: false }, (_evt, name) => onEvent(name === null || name === undefined ? null : String(name))))
    for (const f of folders) {
      this.names.set(f, new Map())
      try {
        const w = watchOf(join(root, f), (name) => this.event(f, name))
        w.on('error', () => this.incomplete(f))
        this.watches.push(w)
      } catch {
        this.names.set(f, null)
      }
    }
    this.life = setTimeout(() => this.lost(), LIFETIME_MS)
    this.life.unref?.()
  }

  /** Watches these folders under root; null when there are more than RUN_WATCH_MAX. Seams: the tests'. */
  static start(root: string, folders: string[], seams: RunWatchSeams = {}): RunWatch | null {
    return folders.length > RUN_WATCH_MAX ? null : new RunWatch(root, folders, seams)
  }

  /** Reads going on now (the tests'). */
  get reads(): number {
    return this.inFlight.size
  }

  private event(f: string, name: string | null): void {
    this.last = Date.now()
    const seen = this.names.get(f)
    // Already incomplete: nothing more is read for it.
    if (!seen) return
    if (name === null || /[\\/]/.test(name)) return this.incomplete(f)
    if (!seen.has(name)) {
      if (seen.size >= RUN_NAMES_MAX) return this.incomplete(f)
      seen.set(name, new Set())
    }
    // Darren's decision on HI-3158 (13 Nov, r36, option 2): its kind as soon as it can be read, so a file made where an
    // ignored folder was is seen as one unless it's gone within moments (the residual SPEC names).
    const key = `${f}\0${name}`
    if (this.queued.has(key)) return
    if (this.inFlight.has(key)) return void this.again.add(key)
    if (this.queued.size >= RUN_READS_QUEUED) return this.incomplete(f)
    this.queued.add(key)
    this.pump()
  }

  private pump(): void {
    for (const key of this.queued) {
      if (this.inFlight.size >= RUN_READS_AT_ONCE) return
      this.queued.delete(key)
      this.inFlight.add(key)
      void this.read(key)
    }
    if (!this.inFlight.size) for (const w of this.idleWaiters.splice(0)) w()
  }

  private async read(key: string): Promise<void> {
    const [f, n] = key.split('\0')
    const lstatOf = this.seams.lstat ?? ((p: string) => lstat(p))
    // Gone: a deletion, or an entry gone before it could be read; nothing to add.
    const kind = await lstatOf(join(this.root, f, n)).then(
      (s): Kind | null => (s.isDirectory() ? 'd' : 'f'),
      (e: unknown): Kind | null => (isAbsent(e) ? null : '?')
    )
    if (kind) this.names.get(f)?.get(n)?.add(kind)
    this.inFlight.delete(key)
    if (this.again.delete(key) && this.names.get(f)) this.queued.add(key)
    this.pump()
  }

  /** A folder whose watch can't be complete: null, and its reads dropped. */
  private incomplete(f: string): void {
    this.names.set(f, null)
    for (const key of this.queued) if (key.startsWith(`${f}\0`)) this.queued.delete(key)
    this.pump()
  }

  /** Resolves once no read is waiting or going on. */
  private idle(): Promise<void> {
    if (!this.inFlight.size && !this.queued.size) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
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
    await this.idle()
    return this.seen()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.life)
    for (const w of this.watches) w.close()
  }

  private lost(): void {
    this.close()
    for (const f of this.names.keys()) this.incomplete(f)
  }

  /** What the watches have seen so far (their kinds may still be being read). */
  seen(): WatchedNames {
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
    const names = [...saw.keys()].filter((n) => !(f === '.' && INTERNAL.has(n)) && !own.has(rel(n)))
    // Its time moved, and nothing to say why: something came and went that no event named.
    if (!names.length) return null
    for (const n of names) {
      // Every kind its entry had, as its events were read and in the two listings. Unreadable: it counts. A folder is
      // asked with its slash (Git's rules for folders need it), a file without, both where it was each; never seen as
      // either (came and went between reads), it is asked as a file, so a folder-only rule doesn't match: it counts.
      const kinds = new Set(saw.get(n))
      for (const id of [now.get(n), was?.get(n)]) if (id) kinds.add(id === '?' ? '?' : id.startsWith('d:') ? 'd' : 'f')
      if (kinds.has('?')) return null
      if (kinds.has('d')) asked.push(`${rel(n)}/`)
      if (kinds.has('f') || !kinds.size) asked.push(rel(n))
    }
  }
  const ignored = await ignoredByKind(root, asked)
  if (!ignored || !asked.every((p) => ignored.has(p))) return null
  return changed
}

/**
 * jjIgnored by the kind each path is asked as, never by what is on disk now: Git takes a path without a slash that is a
 * folder on disk as that folder (HR2's `out` file where `out/` is now), so it's asked in a work tree of its own holding
 * only the `.gitignore` files on the paths' way (the root's and each folder's down to theirs), where nothing else is: a
 * path with a slash is a folder, one without a file. Null where it can't say (one of those unreadable, Git failing).
 */
export async function ignoredByKind(root: string, rels: string[]): Promise<Set<string> | null> {
  if (!rels.length) return new Set()
  const gd = await jjGitStoreOf(root)
  if (!gd) return null
  const shadow = await mkdtemp(join(tmpdir(), 'combwork-ignore-'))
  try {
    const folders = new Set<string>(['.'])
    for (const p of rels) {
      const parts = p.replace(/\/$/, '').split('/').slice(0, -1)
      for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'))
    }
    for (const f of folders) {
      const text = await readFile(join(root, f, '.gitignore')).catch((e: unknown) => (isAbsent(e) ? null : undefined))
      if (text === undefined) return null
      if (text === null) continue
      await mkdir(join(shadow, f), { recursive: true })
      await writeFile(join(shadow, f, '.gitignore'), text)
    }
    const r = await git(shadow, [`--git-dir=${gd}`, `--work-tree=${shadow}`, 'check-ignore', '--no-index', '-z', '--stdin'], undefined, rels.join('\0'))
    if (!r.ok && r.code !== 1) return null
    return new Set(r.out.split('\0').filter(Boolean))
  } finally {
    await rm(shadow, { recursive: true, force: true }).catch(() => undefined)
  }
}
