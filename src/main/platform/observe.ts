// The platform watcher (SPEC §16.3.2 Observe, §16.3.3, §16.13): tells Combwork when a project's content changes outside an
// intent, and keeps the per-folder write log checks read to prove nothing changed while they ran.
//
// - Git: per repository (its common git dir), a watch on `HEAD`, `packed-refs`, `refs/heads`, `logs` and each
//   worktree's git dir (`worktrees/<name>/HEAD`, `logs/HEAD`). A burst of events is read once (debounced), from the ref
//   files with no git process, and said as platform-neutral events: a line (branch) moved, a folder's HEAD moved. A
//   target is a line: whose target it is, the subscriber's options say.
// - Every working folder (a Git repository's worktrees, a None project's folder): a recursive watch whose writes go
//   into the folder's write log, with each HEAD reflog entry and each agent's edit hook (`markEdits`). Writes are kept
//   for WRITE_LOG_MS and at most WRITE_LOG_MAX per folder: a question about a time it has no complete record of (before
//   the watch started, dropped, or while it was down) is unknown, and the caller falls back to its stat snapshot.
// - The minute and window focus read the refs again, for what a watch missed.
//
// Windows' fs.watch quirks (#964): a watched folder deleted makes Windows send its full path in an endless stream of
// events and no error; such a watch ends at once, and is tried again every few seconds until the folder is back (its
// record starting again then). A watch's error does the same.

import { watch, readFileSync, existsSync, statSync, type FSWatcher } from 'original-fs'
import { lstat, stat } from 'original-fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'path'
import { git, readRefsOffMain } from '../git'
import { createLogger, userText } from '../logger'
import type { PlatformId } from '../../shared/platform/descriptors'
import { isMainGitDir, plainRepo, readRepoRefs, type Heads, type RepoRefs } from './repoRefs'
import { UNREADABLE } from '../../shared/workflow/texts'
import { unknown, type Maybe } from './types'
import type { Disposable, FolderChanges, ObserveEvent, ObservePort } from './history'

const log = createLogger('observe')

/** A burst of ref events is read once it is quiet this long, or at least this often while it goes on. */
export const DEBOUNCE_MS = 150
const DEBOUNCE_MAX_MS = 1000
/** How long a folder's writes are kept, and at most how many: beyond either, older questions are unknown. */
export const WRITE_LOG_MS = 6 * 60 * 60 * 1000
export const WRITE_LOG_MAX = 20_000
/** A watch that ended (its folder gone, an error) is tried again this often. */
const RETRY_MS = 3000
/** Before answering, a folder's events are let in until it is quiet this long, at most WRITES_SETTLE_MAX_MS. */
const WRITES_QUIET_MS = 150
const WRITES_SETTLE_MAX_MS = 2000
/**
 * How far before a stretch's start a write's own time may be and still count in it (HI-1767): Windows stamps a file's
 * times from a clock that ticks about every 15.6 ms, so a write just after t0 can carry a time a tick before it.
 */
export const FILE_TIME_SLACK_MS = 100
/**
 * A watch just started may miss the first moment's events (Windows arms it asynchronously): its record counts as
 * complete only from this long after it starts.
 */
const ARM_MS = 250
/** At most this many working folders per repository are watched (its worktrees): beyond, the rest are unknown. */
const MAX_FOLDERS = 64

// What the watcher tells its subscribers, and how a subscription ends: port 3's types (history.ts, HI-2787).
export type { Disposable, FolderChanges, ObserveEvent } from './history'

/** A watch that survives its folder going and coming back (#964), and an error: it ends, and is tried again. */
class DirWatch {
  private w: FSWatcher | null = null
  private retry: NodeJS.Timeout | null = null
  private closed = false
  /** The folder's identity when watched: a watch follows its folder renamed away, silently, on Windows. */
  private ino: bigint | null = null

  constructor(
    readonly path: string,
    private recursive: boolean,
    /** A relative name, or null: something changed that the watch can't name (it started again, events were lost). */
    private onEvent: (name: string | null) => void
  ) {
    this.start(false)
  }

  get live(): boolean {
    return !!this.w
  }

  private start(again: boolean): void {
    if (this.closed) return
    if (!existsSync(this.path)) return this.later()
    try {
      const w = watch(this.path, { recursive: this.recursive }, (_evt, name) => {
        if (this.w !== w) return
        const n = name === null || name === undefined ? null : String(name)
        // #964: the folder gone, Windows names it by its full path in a stream that doesn't stop.
        if (n && isAbsolute(n)) return this.end('its folder is gone') // i18n-ignore: a log line's reason
        this.onEvent(n)
      })
      w.on('error', (e) => this.end(e instanceof Error ? e.message : String(e)))
      this.w = w
      this.ino = identity(this.path)
      if (again) this.onEvent(null)
    } catch {
      this.later()
    }
  }

  /**
   * Whether it still watches its folder: live, and the folder at its path is the one it started on. A folder renamed
   * away (another made in its place, or none) ends the watch, which starts again on what is there now.
   */
  verify(): boolean {
    if (!this.w) return false
    if (identity(this.path) === this.ino) return true
    this.end('its folder was moved or replaced') // i18n-ignore: a log line's reason
    this.poke()
    return false
  }

  /** Its folder may be there now (its parent saw it made): tried at once rather than at the next retry. */
  poke(): void {
    if (this.closed || this.w) return
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.start(true)
  }

  private end(why: string): void {
    if (!this.w) return
    log.info(`The watch on ${userText(this.path)} ended (${userText(why)}); tried again until it is back`)
    this.w.close()
    this.w = null
    this.onEvent(null)
    this.later()
  }

  private later(): void {
    if (this.closed || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      this.start(true)
    }, RETRY_MS)
    this.retry.unref?.()
  }

  close(): void {
    this.closed = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.w?.close()
    this.w = null
  }
}

interface WriteEntry {
  at: number
  /** The folder-relative path written (with `/`), or ':reflog' for a HEAD reflog entry, ':edit' for an agent's edit hook. */
  path: string
}

/**
 * A working folder's writes, as its watch saw them: one recursive watch, which holds only the folder itself (Windows
 * can't rename a folder while a handle is open on anything inside it, so no watch is ever put inside a project folder).
 * The repository's own events come through it too: a main folder holds its `.git`, whose changes go to `git` (its
 * RepoWatch), not into the log. Windows hands a watch its changes in a small buffer: a burst (a commit writing objects
 * into `.git`) can overflow it, and Node then names no file. Nothing before then is known complete (`since`): a check
 * over that moment is unknown, and falls back to its snapshot.
 */
class FolderLog {
  /** Writes are complete from this time on (the watch's start, a restart, lost events, the last dropped entry). */
  since: number
  /** When the last event came in, for `settle`. */
  lastEvent = 0
  private entries: WriteEntry[] = []
  private watch: DirWatch

  constructor(
    readonly folder: string,
    private written: (paths: string[]) => void,
    /** The main folder's `.git` events (relative to `.git`), or null when events were lost; else they're dropped. */
    private gitEvent: ((rel: string | null) => void) | null = null
  ) {
    this.since = Date.now() + ARM_MS
    this.watch = new DirWatch(folder, true, (name) => this.event(name))
  }

  private event(name: string | null): void {
    const now = Date.now()
    this.lastEvent = now
    if (name === null) {
      // Unnamed (the watch started again, or Windows lost events): nothing before now is known complete.
      this.since = now + ARM_MS
      this.gitEvent?.(null)
      return
    }
    const rel = name.split(sep).join('/')
    if (rel === '.git' || rel.startsWith('.git/')) {
      this.gitEvent?.(rel.slice(5))
      return
    }
    // Every path is kept, `node_modules` too (a project can track vendored files there): what git ignores is dropped
    // when a check asks. An install's thousands of writes are bounded by WRITE_LOG_MAX: past it, the oldest go and a
    // question about their time is unknown.
    this.push({ at: now, path: rel })
    this.written([rel])
  }

  push(e: WriteEntry): void {
    const cutoff = e.at - WRITE_LOG_MS
    let drop = 0
    while (drop < this.entries.length && this.entries[drop].at < cutoff) drop++
    if (this.entries.length - drop >= WRITE_LOG_MAX) drop = Math.max(drop, this.entries.length - Math.floor(WRITE_LOG_MAX / 2))
    if (drop) {
      this.since = Math.max(this.since, this.entries[drop - 1].at + 1)
      this.entries.splice(0, drop)
    }
    this.since = Math.max(this.since, cutoff)
    this.entries.push(e)
  }

  /** The entries between t0 and t1 (inclusive), or null when the record isn't complete for all of it. */
  between(t0: number, t1: number): WriteEntry[] | null {
    if (!this.watch.verify() || t0 < this.since) return null
    return this.entries.filter((e) => e.at >= t0 && e.at <= t1)
  }

  /** Checks its watch still watches its folder (the minute's rescan). */
  verify(): void {
    this.watch.verify()
  }

  close(): void {
    this.watch.close()
  }
}

/** The common git dir of the repository holding a folder, read from the files (no git process), or null. */
export function commonDirOf(root: string): string | null {
  const dotGit = join(root, '.git')
  try {
    const st = statSync(dotGit)
    let gitDir = dotGit
    if (st.isFile()) {
      const m = readFileSync(dotGit, 'utf8').match(/gitdir:\s*(.+)/)
      if (!m) return null
      gitDir = resolve(root, m[1].trim())
    }
    const common = join(gitDir, 'commondir')
    return existsSync(common) ? resolve(gitDir, readFileSync(common, 'utf8').trim()) : gitDir
  } catch {
    return null
  }
}

/**
 * A repository's ref events, its working folders' write logs, and what it last read. Its events come from its main
 * folder's watch (which holds its `.git`), never from watches inside `.git` (they'd stop the project folder being
 * renamed); a bare repository, with no main folder, has a watch of its own on its git dir.
 */
class RepoWatch {
  /** A bare repository's own watch. */
  private bare: DirWatch | null = null
  private timer: NodeJS.Timeout | null = null
  private first = 0
  private lines: Heads = new Map()
  private heads: Heads = new Map()
  /** Read once: from now on, every move is said. */
  private primed = false
  /** Working folder (lower-cased) → its write log. */
  readonly logs = new Map<string, FolderLog>()
  /** git dir (lower-cased) → its working folder, for a reflog entry. */
  private reflogFolder = new Map<string, string>()
  /** git dir (lower-cased) → its HEAD reflog's size at the last read: an entry whose event was lost still counts. */
  private reflogSize = new Map<string, number>()
  /** The reads under way in git's worker (HI-1814), one after another while more are asked for. */
  private reading: Promise<void> | null = null
  /** Reads asked for (each `read()`), and how many of them the reads in so far have covered. */
  private asked = 0
  private covered = 0
  /** Callers of `current()`, each until the reads owed when it asked are in. */
  private owed: { want: number; done: () => void }[] = []
  private closed = false
  /**
   * HI-2115: how many reads found something moved (a line, a folder's HEAD, a HEAD reflog entry: a switch to the same
   * commit too, a worktree added or removed). The same number: nothing of these moved in between.
   */
  changes = 0

  constructor(
    readonly common: string,
    private tell: (e: { kind: 'lineMoved'; line: string; from: string | null; to: string | null } | { kind: 'folderMoved'; folder: string; from: string | null; to: string | null } | { kind: 'written'; folder: string; paths: string[] }) => void,
    /** A folder being deleted or removed (`Observer.suspend`): not watched meanwhile. */
    private held: (folder: string) => boolean = () => false
  ) {
    if (!isMainGitDir(common)) this.bare = new DirWatch(common, true, (n) => this.event(n === null ? null : n.split(sep).join('/')))
    // The first read here and now: the repository's folders have their write logs as soon as it is followed.
    this.apply(readRepoRefs(common, MAX_FOLDERS))
  }

  /** An event in the git dir (its path relative to it, with `/`), or null: events were lost, so the refs are read. */
  private event(rel: string | null): void {
    if (rel !== null) {
      // The index, objects, a worktree's index: nothing the refs or HEADs say.
      if (!/^(HEAD|packed-refs|refs(\/heads(\/.*)?)?|logs(\/HEAD)?|worktrees(\/[^/]+(\/(HEAD|gitdir|logs(\/HEAD)?))?)?)$/.test(rel)) return
      const m = rel.match(/^(?:worktrees\/([^/]+)\/)?logs\/HEAD$/)
      if (m) this.reflog(m[1] ? join(this.common, 'worktrees', m[1]) : this.common)
    }
    this.soon()
  }

  /** A HEAD reflog entry in a folder: always a change while a check runs (a checkout and back, a reset to the same commit). */
  private reflog(gitDir: string): void {
    const folder = this.reflogFolder.get(gitDir.toLowerCase())
    if (folder) this.logs.get(folder.toLowerCase())?.push({ at: Date.now(), path: ':reflog' })
  }

  private soon(): void {
    const now = Date.now()
    this.first ||= now
    if (this.timer) clearTimeout(this.timer)
    const wait = now - this.first >= DEBOUNCE_MAX_MS ? 0 : DEBOUNCE_MS
    this.timer = setTimeout(() => {
      this.timer = null
      this.first = 0
      this.read()
    }, wait)
    this.timer.unref?.()
  }

  /**
   * Reads the lines and folders' HEADs, says what moved since the last read, and keeps the folders' write logs in step.
   * Only the first read (the repository just attached) takes what it finds without saying it: every later one, whoever
   * asks (its own events, a rescan, a refresh's `follow`), says every move, so none is taken in silently. Those later
   * reads walk the ref files in git's worker (HI-1814: a check copy's reset read them on main), one at a time, a read
   * asked for meanwhile running once that one is in; folders being deleted or removed let go of their logs at once.
   */
  read(): void {
    this.release()
    this.asked++
    if (this.reading) return
    this.reading = (async () => {
      try {
        while (this.covered < this.asked && !this.closed) {
          // What a read finds covers every read asked for before it began.
          const covers = this.asked
          try {
            const refs = await readRefsOffMain(this.common, MAX_FOLDERS)
            if (this.closed) break
            this.apply(refs)
          } catch (e) {
            log.warn(`reading ${userText(this.common)}'s refs failed`, e)
          }
          this.settle(covers)
        }
      } finally {
        // Here, with nothing awaited since the loop's last check: a read asked for from now on starts a new one.
        this.reading = null
        if (this.closed) this.settle(Infinity)
      }
    })()
  }

  /**
   * Once the reads asked for so far are in: never waiting for those asked for after it (HR1's round 1: a busy
   * repository's refreshes kept every check waiting), nor for any once the watch has closed.
   */
  /** Whether a working folder's HEAD is among those read (at most MAX_FOLDERS of them). */
  watches(folder: string): boolean {
    const k = resolve(folder).toLowerCase()
    for (const f of this.heads.keys()) if (resolve(f).toLowerCase() === k) return true
    return false
  }

  /** A working folder's own git dir, as the last read found it; null when it isn't one of the folders read. */
  gitDirOf(folder: string): string | null {
    const k = resolve(folder).toLowerCase()
    for (const [g, f] of this.reflogFolder) if (resolve(f).toLowerCase() === k) return g
    return null
  }

  current(): Promise<void> {
    if (this.closed || this.covered >= this.asked) return Promise.resolve()
    const want = this.asked
    return new Promise((done) => this.owed.push({ want, done }))
  }

  /** The reads asked for up to `n` are in: those waiting for no more go on. */
  private settle(n: number): void {
    this.covered = Math.max(this.covered, n)
    const left: typeof this.owed = []
    for (const w of this.owed) {
      if (w.want <= this.covered) w.done()
      else left.push(w)
    }
    this.owed = left
  }

  /** Lets go of the write logs of folders being deleted or removed (Windows can't delete a folder a watch holds). */
  private release(): void {
    for (const [k, l] of this.logs) {
      if (!this.held(l.folder)) continue
      l.close()
      this.logs.delete(k)
    }
  }

  /** Takes in what a read found: the moves since the last are said (but for the first), the write logs kept in step. */
  private apply({ lines, folders, heads, sizes }: RepoRefs): void {
    if (!sameMap(this.lines, lines) || !sameMap(this.heads, heads) || !sameMap(this.reflogSize, sizes)) this.changes++
    this.reflogFolder.clear()
    for (const f of folders) {
      const g = f.gitDir.toLowerCase()
      this.reflogFolder.set(g, f.folder)
      const was = this.reflogSize.get(g)
      if (was !== undefined && was !== sizes.get(g)) this.reflog(f.gitDir)
    }
    this.reflogSize = sizes
    if (this.primed) {
      for (const [line, to] of lines) if (this.lines.get(line) !== to) this.tell({ kind: 'lineMoved', line, from: this.lines.get(line) ?? null, to })
      for (const [line, from] of this.lines) if (!lines.has(line)) this.tell({ kind: 'lineMoved', line, from, to: null })
      for (const [folder, to] of heads) if (this.heads.has(folder) && this.heads.get(folder) !== to) this.tell({ kind: 'folderMoved', folder, from: this.heads.get(folder) ?? null, to })
    }
    this.primed = true
    this.lines = lines
    this.heads = heads
    // Worktrees added get a write log; those removed lose theirs.
    const live = new Set(folders.map((f) => f.folder.toLowerCase()))
    for (const [k, l] of this.logs) {
      if (live.has(k)) continue
      l.close()
      this.logs.delete(k)
    }
    this.release()
    for (const f of folders) {
      const k = f.folder.toLowerCase()
      if (this.logs.has(k) || this.held(f.folder)) continue
      const main = f.gitDir.toLowerCase() === this.common.toLowerCase()
      this.logs.set(k, new FolderLog(f.folder, (paths) => this.tell({ kind: 'written', folder: f.folder, paths }), main ? (rel) => this.event(rel) : null))
    }
  }

  close(): void {
    this.closed = true
    this.settle(Infinity)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.bare?.close()
    for (const l of this.logs.values()) l.close()
    this.logs.clear()
  }
}

export interface ObservedProject {
  path: string
  platform: PlatformId
  /** Git: the repository's root, as detected (§16.3.5); absent, its repository is gone, and nothing is watched for it. */
  root?: string
}

/**
 * The watcher for a set of projects: `follow` says which (the workspaces' projects); each repository and folder is
 * watched once, however many projects share it, and closed when none needs it.
 */
export class Observer implements ObservePort {
  /** Common git dir (lower-cased) → its watch. */
  private repos = new Map<string, RepoWatch>()
  /** None project folders (lower-cased) → their write logs. */
  private folders = new Map<string, FolderLog>()
  /** Project path (lower-cased) → how it is followed. */
  private projects = new Map<string, { path: string; platform: PlatformId; repo: string | null }>()
  private subscribers = new Map<string, Set<(e: ObserveEvent) => void>>()

  /** Follows exactly these projects: new ones are watched, those gone stop being. */
  follow(list: readonly ObservedProject[]): void {
    this.list = list
    const want = new Map<string, { path: string; platform: PlatformId; repo: string | null }>()
    for (const p of list) {
      const path = resolve(p.path)
      // Never a repository found above a Git project whose own is gone: only the one detection named.
      const repo = p.platform === 'git' && p.root ? commonDirOf(p.root) : null
      want.set(path.toLowerCase(), { path, platform: p.platform, repo: repo && resolve(repo) })
    }
    this.projects = want
    const repos = new Set([...want.values()].flatMap((p) => (p.repo ? [p.repo.toLowerCase()] : [])))
    const folders = new Set([...want.values()].flatMap((p) => (p.platform === 'none' ? [p.path.toLowerCase()] : [])))
    for (const [k, r] of this.repos) {
      if (repos.has(k) && !this.held(r.common)) continue
      r.close()
      this.repos.delete(k)
    }
    for (const [k, f] of this.folders) {
      if (folders.has(k) && !this.held(f.folder)) continue
      f.close()
      this.folders.delete(k)
    }
    // Worktrees being removed lose their write logs.
    for (const r of this.repos.values()) r.read()
    for (const p of want.values()) {
      if (p.repo && !this.repos.has(p.repo.toLowerCase()) && !this.held(p.repo)) {
        const repo = p.repo
        this.repos.set(repo.toLowerCase(), new RepoWatch(repo, (e) => this.fan(repo, e), (f) => this.held(f)))
      }
      if (p.platform === 'none' && !this.folders.has(p.path.toLowerCase()) && !this.held(p.path)) {
        const path = p.path
        this.folders.set(path.toLowerCase(), new FolderLog(path, (paths) => this.fanProject(path, { kind: 'written', project: path, folder: path, paths })))
      }
    }
  }

  /** What `follow` was last given, to follow again once a suspension ends. */
  private list: readonly ObservedProject[] = []
  /** Folders being deleted or removed (lower-cased) → how many suspensions hold them. */
  private suspended = new Map<string, number>()

  /** Whether a folder is, or is inside, one being deleted or removed. */
  private held(folder: string): boolean {
    if (!this.suspended.size) return false
    const f = resolve(folder).toLowerCase()
    for (const s of this.suspended.keys()) if (f === s || f.startsWith(s.endsWith(sep) ? s : s + sep)) return true
    return false
  }

  /**
   * Closes every watch on or inside these folders, which Windows can't delete or move while a watch holds them (a
   * project deleted, a worktree removed), and watches nothing there until the function returned is called: then they
   * are followed again as before (whatever is still there). Its record restarts, so the time between is unknown.
   */
  suspend(paths: readonly string[]): () => void {
    const keys = paths.map((p) => resolve(p).toLowerCase())
    for (const k of keys) this.suspended.set(k, (this.suspended.get(k) ?? 0) + 1)
    this.follow(this.list)
    let done = false
    return () => {
      if (done) return
      done = true
      for (const k of keys) {
        const n = (this.suspended.get(k) ?? 1) - 1
        if (n > 0) this.suspended.set(k, n)
        else this.suspended.delete(k)
      }
      this.follow(this.list)
    }
  }

  /** How many watches are open: repositories, and working folders (theirs and None projects'). */
  get size(): { repos: number; folders: number } {
    let folders = this.folders.size
    for (const r of this.repos.values()) folders += r.logs.size
    return { repos: this.repos.size, folders }
  }

  /** A repository's event, to the projects it holds. */
  private fan(repo: string, e: { kind: 'lineMoved'; line: string; from: string | null; to: string | null } | { kind: 'folderMoved'; folder: string; from: string | null; to: string | null } | { kind: 'written'; folder: string; paths: string[] }): void {
    for (const p of this.projects.values()) if (p.repo?.toLowerCase() === repo.toLowerCase()) this.fanProject(p.path, { ...e, project: p.path } as ObserveEvent)
  }

  private fanProject(project: string, e: ObserveEvent): void {
    for (const fn of this.subscribers.get(project.toLowerCase()) ?? []) {
      try {
        fn(e)
      } catch (err) {
        log.warn('an observe subscriber failed', err)
      }
    }
  }

  /** The adapter's `observe` (§16.3.1): a project's events until disposed. */
  subscribe(project: string, fn: (e: ObserveEvent) => void): Disposable {
    const k = resolve(project).toLowerCase()
    let set = this.subscribers.get(k)
    if (!set) this.subscribers.set(k, (set = new Set()))
    set.add(fn)
    return {
      dispose: () => {
        set.delete(fn)
        if (!set.size && this.subscribers.get(k) === set) this.subscribers.delete(k)
      }
    }
  }

  /** Reads every repository's refs again (the minute, window focus): what a watch missed is said now. */
  rescan(): void {
    for (const r of this.repos.values()) r.read()
    for (const l of [...this.folders.values(), ...[...this.repos.values()].flatMap((r) => [...r.logs.values()])]) l.verify()
  }

  /**
   * Once every repository's reads asked for so far are in (a worktree a refresh just followed then has its write log):
   * only those, never reads asked for meanwhile.
   */
  private async current(): Promise<void> {
    await Promise.all([...this.repos.values()].map((r) => r.current()))
  }

  private logOf(folder: string): FolderLog | null {
    const k = resolve(folder).toLowerCase()
    const own = this.folders.get(k)
    if (own) return own
    for (const r of this.repos.values()) {
      const l = r.logs.get(k)
      if (l) return l
    }
    return null
  }

  /**
   * HI-2115: where a project's refs stand now, as a token: the same token, and no line, folder HEAD or HEAD reflog of
   * its repository moved in between, so what git said about a folder's checkout then holds. The refs are read again
   * first (in git's worker, no git process), so a move just made counts though its event hasn't come yet. Null when
   * that can't be told: the project's repository isn't watched (not followed, or held), or `folder` isn't among the
   * folders it reads.
   */
  async refsNow(project: string, folder: string): Promise<string | null> {
    const p = this.projects.get(resolve(project).toLowerCase())
    const r = p?.repo ? this.repos.get(p.repo.toLowerCase()) : undefined
    if (!r) return null
    // The folder's own HEAD as it is written (the branch it names, or its commit): a switch between two branches at the
    // same commit with no reflog moves nothing the reads compare (HR3's round 1, finding 1).
    const gitDir = r.gitDirOf(folder)
    let head: string
    try {
      head = gitDir ? readFileSync(join(gitDir, 'HEAD'), 'utf8').trim() : ''
    } catch {
      return null
    }
    // Only a plain repository (plainRepo, the one rule of Combwork's git caches): a reftable's refs, say, aren't in the files
    // these reads walk, so nothing of them can be seen to move (HR3's HI-2115 rounds 1 and 2).
    if (!head || !plainRepo(r.common, gitDir!)) return null
    r.read()
    await r.current()
    if (this.repos.get(p!.repo!.toLowerCase()) !== r || !r.watches(folder) || r.gitDirOf(folder) !== gitDir) return null
    return `${this.serial(r)}:${r.changes}:${head}`
  }

  /** Each repository watch's own number: a watch started again (after a hold) is another, whose moves start afresh. */
  private serials = new WeakMap<RepoWatch, number>()
  private serialNext = 0
  private serial(r: RepoWatch): number {
    let n = this.serials.get(r)
    if (n === undefined) this.serials.set(r, (n = ++this.serialNext))
    return n
  }

  /**
   * Once the events of what was written in a folder so far have come in (it is quiet a moment; at most
   * WRITES_SETTLE_MAX_MS): an event is timed when it arrives, so a check's start waits for this, or a commit just before
   * it would count as a change during it (#1222).
   */
  async settled(folder: string): Promise<void> {
    await this.current()
    const l = this.logOf(folder)
    if (l) await settle(l)
  }

  /** Agents' edit hooks (sessions.ts preToolUse): each file's folder, if watched, records an edit now. */
  markEdits(files: readonly string[]): void {
    const now = Date.now()
    const logs = [...this.folders.values(), ...[...this.repos.values()].flatMap((r) => [...r.logs.values()])]
    for (const f of files) {
      const abs = resolve(f).toLowerCase()
      for (const l of logs) {
        const root = l.folder.toLowerCase()
        if (abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep)) l.push({ at: now, path: ':edit' })
      }
    }
  }

  /**
   * Did anything that counts change in a working folder between t0 and t1 (§16.13)? A write to a file git doesn't
   * ignore (tracked, or new and not ignored: anywhere in the tree, not only a card's files), a HEAD reflog entry, an
   * agent's edit hook. Ignored outputs (`out/`, an ignored `node_modules`) don't count; a tracked file anywhere does,
   * `node_modules` included. `counts` narrows the paths for a None
   * folder (its deliverables). Unknown when the folder isn't watched or its record isn't complete for the whole time:
   * the caller then falls back to its stat snapshot.
   */
  async changedBetween(folder: string, t0: number, t1: number, counts?: (paths: string[]) => string[]): Promise<Maybe<FolderChanges>> {
    await this.current()
    const l = this.logOf(folder)
    if (!l) return unknown(UNREADABLE.writes, { folder })
    // An event is timed when it arrives, after its write: those arriving until the folder settles count too (a write by
    // someone else just after t1 then counts as a change: the safe side).
    const settled = await settle(l)
    const seen = l.between(t0, Math.max(t1, settled))
    if (!seen) return unknown(UNREADABLE.writes, { folder })
    const marks = [...new Set(seen.filter((e) => e.path.startsWith(':')).map((e) => e.path))]
    let files = [...new Set(seen.filter((e) => !e.path.startsWith(':')).map((e) => e.path))]
    if (counts) files = counts(files)
    else if (files.length && this.isGitFolder(l.folder)) {
      const r = await git(l.folder, ['check-ignore', '-z', '--stdin'], undefined, files.join('\0'))
      // Exit 1: none of them is ignored. Anything else is git failing: unknown, never "nothing changed".
      if (!r.ok && r.code !== 1) return unknown(UNREADABLE.ignored, { folder })
      const ignored = new Set(r.out.split('\0').filter(Boolean))
      files = files.filter((f) => !ignored.has(f))
    }
    // An event is timed when it arrives, so one for a write just before t0 can come after it (HI-1767: a check copy's
    // reset, or the target merged in, then a check at once: their events still coming past the settle's quiet or its
    // cap, under load). A file last written before t0 wasn't written meanwhile, however late its event; one written
    // meanwhile, and put back, was. One at a time: a long list is a reset's, not a run's.
    const during: string[] = []
    for (const f of files) if (await writtenSince(l.folder, f, t0)) during.push(f)
    files = during
    const paths = [...marks, ...files]
    return { changed: paths.length > 0, paths }
  }

  private isGitFolder(folder: string): boolean {
    for (const r of this.repos.values()) if (r.logs.has(folder.toLowerCase())) return true
    return false
  }

  dispose(): void {
    for (const r of this.repos.values()) r.close()
    for (const f of this.folders.values()) f.close()
    this.repos.clear()
    this.folders.clear()
    this.projects.clear()
    this.subscribers.clear()
    this.list = []
  }
}

/**
 * Whether a folder-relative path was written at or after t0, by its own times (modified or changed, whichever is
 * later, FILE_TIME_SLACK_MS before t0 counting too: the safe side). A link's times are its own and its target's,
 * whichever is later (a link replaced, or its target written through it). Only a path shown gone (ENOENT, ENOTDIR)
 * was deleted: when, its nearest folder that is says (a deletion changes the folder holding it), up to the folder
 * itself. Anything else unreadable (EACCES, EPERM, an I/O error: HR2's round 1) counts: a file there that can't be
 * read is never judged by its folder's age.
 */
async function writtenSince(folder: string, rel: string, t0: number): Promise<boolean> {
  const root = resolve(folder)
  for (let p = resolve(root, rel); p.length >= root.length; p = dirname(p)) {
    const at = await writtenAt(p)
    if (at === 'unreadable') return true
    if (at !== 'gone') return at >= t0 - FILE_TIME_SLACK_MS
    if (p.length === root.length) break
  }
  return true
}

/** A path's last write (the later of its modified and changed times, a link's and its target's), gone, or unreadable. */
async function writtenAt(p: string): Promise<number | 'gone' | 'unreadable'> {
  const gone = (e: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')
  try {
    const own = await lstat(p)
    const times = [own.mtimeMs, own.ctimeMs]
    if (own.isSymbolicLink()) {
      // Its target: gone (a dangling link) adds nothing; unreadable counts.
      const target = await stat(p).catch((e: unknown) => (gone(e) ? null : 'unreadable' as const))
      if (target === 'unreadable') return target
      if (target) times.push(target.mtimeMs, target.ctimeMs)
    }
    return Math.max(...times)
  } catch (e) {
    return gone(e) ? 'gone' : 'unreadable'
  }
}

/** A folder's identity (its file id), or null when it isn't there. */
/** Whether two maps hold the same keys with the same values. */
function sameMap<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (!b.has(k) || b.get(k) !== v) return false
  return true
}

function identity(path: string): bigint | null {
  try {
    return statSync(path, { bigint: true }).ino
  } catch {
    return null
  }
}

/**
 * Lets a folder's events come in before it is asked: writes just made are on their way, so it waits until no event has
 * come for WRITES_QUIET_MS since the question (at least that long), and at most WRITES_SETTLE_MAX_MS.
 */
async function settle(l: FolderLog): Promise<number> {
  const start = Date.now()
  for (;;) {
    const quiet = Date.now() - Math.max(l.lastEvent, start)
    if (quiet >= WRITES_QUIET_MS || Date.now() - start >= WRITES_SETTLE_MAX_MS) return Date.now()
    await new Promise((r) => setTimeout(r, WRITES_QUIET_MS - quiet + 5))
  }
}

/** The app's watcher: the open workspaces' projects follow it (watching.ts); adapters subscribe and ask it. */
export const observer = new Observer()

/** Runs fn with no watch on or inside these folders (a worktree being removed: Windows can't while one holds it). */
export async function unwatchedWhile<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> {
  const resume = observer.suspend(paths)
  try {
    return await fn()
  } finally {
    resume()
  }
}
