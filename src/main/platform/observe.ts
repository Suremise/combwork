// The platform watcher (SPEC §16.3.2 Observe, §16.3.3, §16.13): tells Hive when a project's content changes outside an
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

import { watch, readdirSync, readFileSync, existsSync, statSync, type FSWatcher } from 'original-fs'
import { dirname, isAbsolute, join, resolve, sep } from 'path'
import { git } from '../git'
import { createLogger, userText } from '../logger'
import type { PlatformId } from '../../shared/platform/descriptors'
import { refSync } from './git'
import { unknown, type Maybe } from './types'

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
 * A watch just started may miss the first moment's events (Windows arms it asynchronously): its record counts as
 * complete only from this long after it starts.
 */
const ARM_MS = 250
/** At most this many working folders per repository are watched (its worktrees): beyond, the rest are unknown. */
const MAX_FOLDERS = 64

/** What the watcher tells its subscribers (platform-neutral: a line is a Git branch). */
export type ObserveEvent =
  | { kind: 'lineMoved'; project: string; line: string; from: string | null; to: string | null }
  | { kind: 'folderMoved'; project: string; folder: string; from: string | null; to: string | null }
  | { kind: 'written'; project: string; folder: string; paths: string[] }

export interface Disposable {
  dispose(): void
}

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
        if (n && isAbsolute(n)) return this.end('its folder is gone')
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
    this.end('its folder was moved or replaced')
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

/** Top-level folders never watched: git's own (a commit anywhere writes its objects there), and installs' output. */
const UNWATCHED = new Set(['.git', 'node_modules'])
/** At most this many top-level folders of a working folder are watched: beyond, its record is never complete. */
const MAX_TOP_FOLDERS = 256

/**
 * A working folder's writes, as its watches saw them. Not one recursive watch: Windows hands a watch its changes in a
 * small buffer, and one that also saw `.git` (every commit, in any worktree of the repository, writes objects there)
 * overflowed on a commit, losing the folder's own writes with git's. So the folder's top level has a watch of its own,
 * and each top-level folder but `.git` and `node_modules` a recursive one, added and dropped as folders come and go.
 */
class FolderLog {
  /** Writes are complete from this time on (the watch's start, a restart, the last dropped entry). */
  since: number
  /** When the last event came in, for `settle`. */
  lastEvent = 0
  private entries: WriteEntry[] = []
  private root: DirWatch
  /** Top-level folder (lower-cased) → its recursive watch. */
  private subs = new Map<string, DirWatch>()
  /** More top-level folders than MAX_TOP_FOLDERS: some aren't watched, so nothing is known complete. */
  private partial = false

  constructor(
    readonly folder: string,
    private written: (paths: string[]) => void
  ) {
    this.since = Date.now() + ARM_MS
    this.root = new DirWatch(folder, false, (name) => this.rootEvent(name))
    this.scan()
  }

  /** Watches each top-level folder not watched yet. */
  private scan(): void {
    let list
    try {
      list = readdirSync(this.folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of list) if (e.isDirectory()) this.addSub(e.name)
  }

  private addSub(name: string): boolean {
    const k = name.toLowerCase()
    if (UNWATCHED.has(k) || this.subs.has(k)) return false
    if (this.subs.size >= MAX_TOP_FOLDERS) {
      if (!this.partial) log.warn(`${userText(this.folder)} has over ${MAX_TOP_FOLDERS} top-level folders: its writes aren't all watched`)
      this.partial = true
      return false
    }
    this.subs.set(k, new DirWatch(join(this.folder, name), true, (m) => this.subEvent(name, m)))
    return true
  }

  private unnamed(now: number): void {
    // Unnamed (a watch started again, or Windows lost events): nothing before now is known complete.
    this.since = now + ARM_MS
  }

  private rootEvent(name: string | null): void {
    const now = Date.now()
    this.lastEvent = now
    if (name === null) {
      this.unnamed(now)
      return this.scan()
    }
    const k = name.toLowerCase()
    if (UNWATCHED.has(k)) return
    let dir = false
    try {
      dir = statSync(join(this.folder, name)).isDirectory()
    } catch {
      // Gone: a folder's watch goes with it.
      const sub = this.subs.get(k)
      sub?.close()
      this.subs.delete(k)
    }
    // A folder made: what is written in it before its watch is armed isn't seen, so the folder itself counts as written.
    if (dir) this.addSub(name)
    this.record(now, name.split(sep).join('/'))
  }

  private subEvent(top: string, name: string | null): void {
    const now = Date.now()
    this.lastEvent = now
    if (name === null) return this.unnamed(now)
    const rel = `${top}/${name.split(sep).join('/')}`
    // An install writes thousands of files there, always ignored: not worth a record each.
    if (rel.includes('/node_modules/') || rel.endsWith('/node_modules')) return
    this.record(now, rel)
  }

  private record(at: number, rel: string): void {
    this.push({ at, path: rel })
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
    if (!this.root.verify() || this.partial || t0 < this.since) return null
    for (const s of this.subs.values()) if (!s.live) return null
    return this.entries.filter((e) => e.at >= t0 && e.at <= t1)
  }

  /** Checks its watches still watch their folders (the minute's rescan). */
  verify(): void {
    this.root.verify()
    for (const s of this.subs.values()) s.verify()
  }

  close(): void {
    this.root.close()
    for (const s of this.subs.values()) s.close()
    this.subs.clear()
  }
}

/** A line or folder name → the commit it is at, read from the ref files. */
type Heads = Map<string, string | null>

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

/** Every branch with its commit: loose refs under refs/heads, over packed-refs. */
function linesOf(common: string): Heads {
  const out: Heads = new Map()
  try {
    for (const l of readFileSync(join(common, 'packed-refs'), 'utf8').split(/\r?\n/)) {
      const [sha, name] = l.split(' ')
      if (name?.startsWith('refs/heads/') && /^[0-9a-f]{40,64}$/.test(sha)) out.set(name.slice('refs/heads/'.length), sha)
    }
  } catch {
    // No packed refs.
  }
  const walk = (dir: string, prefix: string): void => {
    let list
    try {
      list = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of list) {
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`)
      else if (e.isFile() && !e.name.endsWith('.lock')) {
        try {
          const v = readFileSync(join(dir, e.name), 'utf8').trim()
          if (/^[0-9a-f]{40,64}$/.test(v)) out.set(`${prefix}${e.name}`, v)
        } catch {
          // Being rewritten: the next read has it.
        }
      }
    }
  }
  walk(join(common, 'refs', 'heads'), '')
  return out
}

/** The working folders of a repository (its main folder, then each worktree), each with its git dir. */
function foldersOf(common: string): { folder: string; gitDir: string }[] {
  const out: { folder: string; gitDir: string }[] = []
  // A repository's main folder holds its common dir as `.git`; a bare one has none.
  if (common.toLowerCase().endsWith(`${sep}.git`) || common.toLowerCase().endsWith('/.git')) out.push({ folder: dirname(common), gitDir: common })
  let names: string[] = []
  try {
    names = readdirSync(join(common, 'worktrees'))
  } catch {
    // No worktrees.
  }
  for (const n of names) {
    const gitDir = join(common, 'worktrees', n)
    try {
      const target = readFileSync(join(gitDir, 'gitdir'), 'utf8').trim()
      out.push({ folder: dirname(resolve(target)), gitDir })
    } catch {
      // Being made or removed.
    }
  }
  return out
}

/** A repository's ref watch, its working folders' write logs, and what it last read. */
class RepoWatch {
  private watches: DirWatch[] = []
  /** The watches of `refs`, `logs` and `worktrees`, which a fresh repository makes later. */
  private subs = new Map<string, DirWatch>()
  private timer: NodeJS.Timeout | null = null
  private first = 0
  private lines: Heads = new Map()
  private heads: Heads = new Map()
  /** Working folder (lower-cased) → its write log. */
  readonly logs = new Map<string, FolderLog>()
  /** git dir (lower-cased) → its working folder, for a reflog entry. */
  private reflogFolder = new Map<string, string>()

  constructor(
    readonly common: string,
    private tell: (e: { kind: 'lineMoved'; line: string; from: string | null; to: string | null } | { kind: 'folderMoved'; folder: string; from: string | null; to: string | null } | { kind: 'written'; folder: string; paths: string[] }) => void
  ) {
    this.watches.push(new DirWatch(common, false, (n) => this.event(n, '')))
    for (const sub of ['refs', 'logs', 'worktrees']) {
      const w = new DirWatch(join(common, sub), true, (n) => this.event(n, sub))
      this.subs.set(sub, w)
      this.watches.push(w)
    }
    this.read(false)
  }

  private event(name: string | null, under: string): void {
    const rel = name === null ? null : (under ? `${under}/${name}` : name).split(sep).join('/')
    if (rel !== null && !under) this.subs.get(rel)?.poke()
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
      this.read(true)
    }, wait)
    this.timer.unref?.()
  }

  /** Reads the lines and folders' HEADs; says what moved (`say`), and keeps the folders' write logs in step. */
  read(say: boolean): void {
    const lines = linesOf(this.common)
    const folders = foldersOf(this.common).slice(0, MAX_FOLDERS)
    const heads: Heads = new Map()
    this.reflogFolder.clear()
    for (const f of folders) {
      heads.set(f.folder, refSync(f.gitDir, 'HEAD') ?? refSync(this.common, readHeadRef(f.gitDir) ?? 'HEAD'))
      this.reflogFolder.set(f.gitDir.toLowerCase(), f.folder)
    }
    if (say) {
      for (const [line, to] of lines) if (this.lines.get(line) !== to) this.tell({ kind: 'lineMoved', line, from: this.lines.get(line) ?? null, to })
      for (const [line, from] of this.lines) if (!lines.has(line)) this.tell({ kind: 'lineMoved', line, from, to: null })
      for (const [folder, to] of heads) if (this.heads.has(folder) && this.heads.get(folder) !== to) this.tell({ kind: 'folderMoved', folder, from: this.heads.get(folder) ?? null, to })
    }
    this.lines = lines
    this.heads = heads
    // Worktrees added get a write log; those removed lose theirs.
    const live = new Set(folders.map((f) => f.folder.toLowerCase()))
    for (const [k, l] of this.logs) {
      if (live.has(k)) continue
      l.close()
      this.logs.delete(k)
    }
    for (const f of folders) {
      const k = f.folder.toLowerCase()
      if (!this.logs.has(k)) this.logs.set(k, new FolderLog(f.folder, (paths) => this.tell({ kind: 'written', folder: f.folder, paths })))
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const w of this.watches) w.close()
    for (const l of this.logs.values()) l.close()
    this.logs.clear()
  }
}

/** What a git dir's HEAD names (`refs/heads/x`), when it is a symbolic ref. */
function readHeadRef(gitDir: string): string | null {
  try {
    const v = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    return v.startsWith('ref: ') ? v.slice(5) : null
  } catch {
    return null
  }
}

/** A project as the watcher follows it: Git (its repository) or None (its folder). */
export interface ObservedProject {
  path: string
  platform: PlatformId
}

/** The question checks ask of the write log, answered: the folder's writes that count, or unknown. */
export interface FolderChanges {
  changed: boolean
  /** What counted: folder-relative paths, ':reflog', ':edit'. */
  paths: string[]
}

/**
 * The watcher for a set of projects: `follow` says which (the workspaces' projects); each repository and folder is
 * watched once, however many projects share it, and closed when none needs it.
 */
export class Observer {
  /** Common git dir (lower-cased) → its watch. */
  private repos = new Map<string, RepoWatch>()
  /** None project folders (lower-cased) → their write logs. */
  private folders = new Map<string, FolderLog>()
  /** Project path (lower-cased) → how it is followed. */
  private projects = new Map<string, { path: string; platform: PlatformId; repo: string | null }>()
  private subscribers = new Map<string, Set<(e: ObserveEvent) => void>>()

  /** Follows exactly these projects: new ones are watched, those gone stop being. */
  follow(list: readonly ObservedProject[]): void {
    const want = new Map<string, { path: string; platform: PlatformId; repo: string | null }>()
    for (const p of list) {
      const path = resolve(p.path)
      const repo = p.platform === 'git' ? commonDirOf(gitRoot(path) ?? path) : null
      want.set(path.toLowerCase(), { path, platform: p.platform, repo: repo && resolve(repo) })
    }
    this.projects = want
    const repos = new Set([...want.values()].flatMap((p) => (p.repo ? [p.repo.toLowerCase()] : [])))
    const folders = new Set([...want.values()].flatMap((p) => (p.platform === 'none' ? [p.path.toLowerCase()] : [])))
    for (const [k, r] of this.repos) {
      if (repos.has(k)) continue
      r.close()
      this.repos.delete(k)
    }
    for (const [k, f] of this.folders) {
      if (folders.has(k)) continue
      f.close()
      this.folders.delete(k)
    }
    for (const p of want.values()) {
      if (p.repo && !this.repos.has(p.repo.toLowerCase())) {
        const repo = p.repo
        this.repos.set(repo.toLowerCase(), new RepoWatch(repo, (e) => this.fan(repo, e)))
      }
      if (p.platform === 'none' && !this.folders.has(p.path.toLowerCase())) {
        const path = p.path
        this.folders.set(path.toLowerCase(), new FolderLog(path, (paths) => this.fanProject(path, { kind: 'written', project: path, folder: path, paths })))
      }
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
    for (const r of this.repos.values()) r.read(true)
    for (const l of [...this.folders.values(), ...[...this.repos.values()].flatMap((r) => [...r.logs.values()])]) l.verify()
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
   * agent's edit hook. Ignored outputs (`out/`, `node_modules`) don't count. `counts` narrows the paths for a None
   * folder (its deliverables). Unknown when the folder isn't watched or its record isn't complete for the whole time:
   * the caller then falls back to its stat snapshot.
   */
  async changedBetween(folder: string, t0: number, t1: number, counts?: (paths: string[]) => string[]): Promise<Maybe<FolderChanges>> {
    const l = this.logOf(folder)
    if (!l) return unknown(`the writes in ${folder}`)
    // An event is timed when it arrives, after its write: those arriving until the folder settles count too (a write by
    // someone else just after t1 then counts as a change: the safe side).
    const settled = await settle(l)
    const seen = l.between(t0, Math.max(t1, settled))
    if (!seen) return unknown(`the writes in ${folder}`)
    const marks = [...new Set(seen.filter((e) => e.path.startsWith(':')).map((e) => e.path))]
    let files = [...new Set(seen.filter((e) => !e.path.startsWith(':')).map((e) => e.path))]
    if (counts) files = counts(files)
    else if (files.length && this.isGitFolder(l.folder)) {
      const r = await git(l.folder, ['check-ignore', '-z', '--stdin'], undefined, files.join('\0'))
      // Exit 1: none of them is ignored. Anything else is git failing: unknown, never "nothing changed".
      if (!r.ok && r.code !== 1) return unknown(`what git ignores in ${folder}`)
      const ignored = new Set(r.out.split('\0').filter(Boolean))
      files = files.filter((f) => !ignored.has(f))
    }
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
  }
}

/** A folder's identity (its file id), or null when it isn't there. */
function identity(path: string): bigint | null {
  try {
    return statSync(path, { bigint: true }).ino
  } catch {
    return null
  }
}

/** The root of the Git repository holding a folder (where `.git` is), or null. */
function gitRoot(folder: string): string | null {
  let dir = resolve(folder)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
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
