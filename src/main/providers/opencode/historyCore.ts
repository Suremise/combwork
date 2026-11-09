import { spawn as spawnChild, type ChildProcess } from 'child_process'
import { endTree } from '../../progressReporters/wrapper'
import { request as httpRequest } from 'http'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'original-fs'
import { join } from 'path'
import { buildMirror, mirrorState, newestMessage, ownMessages, parseExport, placeholderMirror, sessionSettled, subagentSessions, withStatus, type MirrorHeader, type MirrorProblem, type LimitsReading, opencodePlanUsage } from './mirror'

// The OpenCode history's worker core (HI-2762, design s7/s10/s13): every read of a session from its agent's private server,
// every `opencode session export`, and every write of a session's mirror (mirror.ts) happens here, in a thread of its own
// (opencodeHistoryWorker.ts; in unit tests, in-process). Main sends requests and gets small answers.
//
// Ownership and publication are one serialized step per session: the core owns each session's epoch, bumped by `begin`
// (a run starts on it), `end` (that run ended) and `removeRoot` (its account goes), applied in the order they come; a
// result is published only if its epoch is still the session's and it isn't older than what is published (its settled
// watermark for a read, its session's `time.updated` for an export), checked and written (a temp file renamed over the
// mirror) synchronously, so nothing can come between the check and the rename. A request is answered once applied, so
// `begin` answered means no older work can publish after it.
//
// Bounded: at most `maxPending` queued jobs (per session one, the newest replacing an older one of its kind), refreshes 2
// at a time, exports 1, limits 1; pages of 200 (2.2.6's maximum), at most `maxPages`; each response at most `maxBytes`,
// counted as it is read; each request `requestMs`; an export `exportMs` and `maxExportBytes`, its process tree killed on a
// timeout or cancel. Full with no repair to drop: a live refresh is left to its run's next poll, a run-end export is kept
// for the repair pass (its state file says so): neither is lost, neither grows the queue.
//
// Subagents (HI-2773): OpenCode runs each in a session of its own, its `parentID` the session that started it, named in the
// starting tool part's metadata. A published session's parts name its children; each is a session here too, mirrored
// beside its parent and owned with it: a run's start and end move its descendants' epochs with its own, so while the run
// lives they are read from its server (a poll's check of `time.updated` first, as for the parent; one still running is
// checked at each of the parent's polls), and after it each is exported once, when its mirror is older than its newest
// start (main is told which: `children`, as it builds the commands). A child's read publishes only when its info names
// that parent. Each session's tokens are its own (2.2.6: a parent's info doesn't count its subagents'), so nothing is
// counted twice.

export interface Bounds {
  maxPending: number
  refreshes: number
  pageSize: number
  maxPages: number
  maxBytes: number
  requestMs: number
  refreshMs: number
  settleTries: number
  exportMs: number
  maxExportBytes: number
  repairBatch: number
  repairHours: number
  /** `opencode session list`'s output, at most (discovery, HI-2774). */
  maxListBytes: number
}

export const DEFAULT_BOUNDS: Bounds = { maxPending: 64, refreshes: 2, pageSize: 200, maxPages: 100, maxBytes: 8 * 1024 * 1024, requestMs: 10_000, refreshMs: 60_000, settleTries: 3, exportMs: 60_000, maxExportBytes: 64 * 1024 * 1024, repairBatch: 8, repairHours: 24, maxListBytes: 1024 * 1024 }

/** A command main built (its protected environment: install.ts opencodeCommand). */
export interface CommandSpec {
  file: string
  args: string[]
  /** The command line to start it with instead of `args`, as it is (a .cmd through cmd.exe: common.ts toSpawnable). */
  line?: string
  env: Record<string, string>
  cwd?: string
}

export type CoreRequest = { id: number } & (
  | { type: 'begin'; home: string; sessionId: string; runId: string }
  | { type: 'server'; runId: string; url: string; password: string }
  | { type: 'end'; runId: string }
  | { type: 'removeRoot'; home: string }
  | { type: 'restoreRoot'; home: string }
  | { type: 'refresh'; runId: string; force?: boolean }
  | { type: 'export'; home: string; sessionId: string; command: CommandSpec; reason: 'runEnd' | 'repair' }
  | { type: 'limits'; runId: string }
  | { type: 'repairScan'; homes: string[] }
  | { type: 'bounds'; bounds: Partial<Bounds> }
  | { type: 'discover'; home: string; folder: string; command: CommandSpec; reason: 'runEnd' | 'repair' }
  | { type: 'discoveryFolders'; homes: string[] }
  | { type: 'adoptMark'; home: string; sessionId: string; directory: string }
  | { type: 'adoptCommit'; home: string; sessionId: string; lease: string }
  | { type: 'adoptDone'; home: string; sessionId: string; lease: string; ok: boolean; created: boolean }
  | { type: 'idle' }
  | { type: 'shutdown' }
)

/** What the core tells main without being asked: a mirror published, a limits reading, a line for the log. */
export type CoreEvent =
  | { event: 'published'; home: string; sessionId: string; source: 'api' | 'export'; updated: number; cost: number | null }
  | { event: 'limits'; runId: string; epoch: number; reading: LimitsReading }
  /** An exported session's subagents whose mirrors need an export of their own (HI-2773): main queues them. */
  | { event: 'children'; home: string; sessionId: string; children: string[]; reason: 'runEnd' | 'repair' }
  /** Sessions Combwork didn't make, found in an account's data (HI-2774): main queues their exports. */
  | { event: 'discovered'; home: string; sessions: string[] }
  | { event: 'log'; level: 'info' | 'warn'; text: string }

export type CoreReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string } | CoreEvent

export const mirrorDir = (home: string): string => join(home, 'combwork-sessions')
export const mirrorPath = (home: string, sessionId: string): string => join(mirrorDir(home), `${sessionId}.jsonl`)
export const statePath = (home: string, sessionId: string): string => join(mirrorDir(home), `${sessionId}.state.json`)
/** Combwork's mark that it made (or took over) a session in this account (the launcher's sessionMark: the same folder). */
export const markPath = (home: string, sessionId: string): string => join(mirrorDir(home), `${sessionId}.json`)
/** An account's discovery record (HI-2774): per folder scanned, the database's time at its last scan and whether that scan handed out everything. */
export const discoveryPath = (home: string): string => join(mirrorDir(home), 'combwork-discovery.json')
const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/
/** The account's database (OpenCode's default under its data root), and its WAL: a change to either is a change. */
export const dbFiles = (home: string): string[] => [join(home, 'opencode', 'opencode.db'), join(home, 'opencode', 'opencode.db-wal')]

/** A session's retry record (no reader reads it): when its last export failed, the database's time then, a run-end kept for repair. */
interface RepairState {
  failedAt?: number
  dbMtime?: number
  attempts?: number
  pending?: true
}

interface Session {
  home: string
  sessionId: string
  epoch: number
  runId: string | null
  /** The session's `time.updated` the last published read had (a poll that sees it unchanged reads nothing more). */
  updated: number
  /** A subagent's session: the session that started it, once a published read of that one named it. */
  parent: string | null
  /** Whether its last published info said nothing runs in it (a child still running is checked at each parent poll). */
  settled: boolean
  /** The message its last published info's staged revert starts at (HI-2774): a stage or unstage is a change too. */
  revert: string | null
}

/** A folder's entry in an account's discovery record (discoveryPath). */
interface Discovery {
  folder: string
  dbMtime?: number
  complete?: boolean
  /** When it was last scanned (ms): the oldest folder goes past MAX_FOLDERS. */
  at?: number
}

/** At most this many folders are kept per account for discovery's later passes. */
const MAX_FOLDERS = 50

/** At most this many subagents are followed per session (its newest starts first). */
const MAX_CHILDREN = 200

interface Run {
  runId: string
  key: string
  epoch: number
  url: string | null
  password: string | null
  abort: AbortController
}

type JobKind = 'refresh' | 'export' | 'limits' | 'discover'
interface Job {
  kind: JobKind
  key: string
  epoch: number
  runId?: string
  force?: boolean
  command?: CommandSpec
  reason?: 'runEnd' | 'repair'
  /** A discovery's account and folder. */
  home?: string
  folder?: string
}

/**
 * A read that failed: its kind (what the history's notice says, translated), what the log says (English), and the CLI's or
 * OpenCode's own words where they gave some (`said`: shown after the notice as they are; never Combwork's own words).
 */
export class Failed extends Error {
  constructor(
    readonly problem: MirrorProblem,
    detail: string,
    readonly said = ''
  ) {
    super(detail)
  }
}

/**
 * A GET to an agent's own OpenCode server on this PC (http on a loopback address only), never through fetch: fetch hands
 * a `Content-Encoding: br` reply to Node's Brotli decoder (#1582). It asks for no encoding and refuses an encoded reply;
 * the answer is at most `maxBytes`, counted as it comes; `signal` ends it. Failures are Failed, with what went wrong.
 */
export function plainLocalGet(url: string, headers: Record<string, string>, signal: AbortSignal, maxBytes: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return reject(new Failed('timeout', 'not a URL')) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
    }
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return reject(new Failed('timeout', 'not a server on this PC')) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
    const req = httpRequest(u, { method: 'GET', headers: { ...headers, 'accept-encoding': 'identity' }, signal }, (res) => {
      const encoding = String(res.headers['content-encoding'] ?? 'identity').toLowerCase()
      if (encoding !== 'identity') {
        res.destroy()
        return reject(new Failed('parse', `an encoded answer (${encoding})`)) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
      }
      const chunks: Buffer[] = []
      let n = 0
      res.on('data', (b: Buffer) => {
        n += b.length
        if (n > maxBytes) {
          res.destroy()
          reject(new Failed('size', `an answer was over ${maxBytes} bytes`)) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
        } else chunks.push(b)
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', (e) => reject(new Failed('timeout', e.message)))
    })
    req.on('error', (e) => reject(new Failed('timeout', e.message)))
    req.end()
  })
}

const key = (home: string, sessionId: string): string => `${home.toLowerCase()}|${sessionId}`

export interface CoreDeps {
  /** A GET to the run's own server: plainLocalGet's answer (tests: a fake server). */
  get: (url: string, headers: Record<string, string>, signal: AbortSignal, maxBytes: number) => Promise<{ status: number; body: string }>
  spawn: (file: string, args: string[], opts: { env: Record<string, string>; cwd?: string; verbatim?: boolean }) => ChildProcess
  /** Ends a process and what it started, by identity (cw-progress's endTree, #603/#655). */
  endTree: (child: ChildProcess) => void
  now: () => number
}

const defaultDeps: CoreDeps = {
  get: (url, headers, signal, maxBytes) => plainLocalGet(url, headers, signal, maxBytes),
  spawn: (file, args, o) => spawnChild(file, args, { env: o.env, cwd: o.cwd, windowsHide: true, windowsVerbatimArguments: !!o.verbatim, stdio: ['ignore', 'pipe', 'pipe'] }),
  endTree: (child) => endTree(child),
  now: () => Date.now()
}

export class HistoryCore {
  private sessions = new Map<string, Session>()
  /**
   * Adoptions under way, by session key (HI-2774, HR2 on round 1): each adoption's lease, pending (its mark checked or
   * made) or committing (its record being written); whether one of them made the mark, and whether one committed. The
   * mark is taken back only once none is left and none committed, and only if one of them made it.
   */
  private adoptions = new Map<string, { created: boolean; committed: boolean; leases: Map<string, 'pending' | 'committing'> }>()
  private leaseCount = 0
  /** Each session's subagents' sessions (by its key: their ids), from its last published read. */
  private kids = new Map<string, Set<string>>()
  private runs = new Map<string, Run>()
  private removed = new Set<string>()
  /** Queued jobs, oldest first: at most one per session and kind. */
  private queue: Job[] = []
  private running = { refresh: 0, export: 0, limits: 0, discover: 0 }
  private children = new Set<ChildProcess>()
  /** Each session's export under way, by session key: removeRoot waits for its root's. */
  private exporting = new Map<string, Promise<void>>()
  private inflight = new Set<Promise<unknown>>()
  private closed = false
  bounds: Bounds = { ...DEFAULT_BOUNDS }
  /**
   * Where this core's epochs start (its start time, in thousandths): a worker started after another ended never gives an
   * epoch the old one gave, so nothing of the old one's can pass for the new one's.
   */
  private readonly epochBase = Date.now() * 1000

  constructor(
    private readonly emit: (e: CoreEvent) => void,
    private readonly deps: CoreDeps = defaultDeps
  ) {}

  /** One request, applied in order: its answer once applied (a job queued is answered when queued, not when done). */
  async handle(r: CoreRequest): Promise<unknown> {
    switch (r.type) {
      case 'begin': {
        const s = this.session(r.home, r.sessionId)
        s.epoch++
        s.runId = r.runId
        // An older run of the session (a restart before its end came) stops: its work can't publish now anyway.
        for (const run of this.runs.values()) if (run.key === key(r.home, r.sessionId) && run.runId !== r.runId) this.dropRun(run)
        this.runs.set(r.runId, { runId: r.runId, key: key(r.home, r.sessionId), epoch: s.epoch, url: null, password: null, abort: new AbortController() })
        this.cancelQueued(key(r.home, r.sessionId))
        // Its subagents' sessions are the run's too.
        for (const c of this.descendants(s)) {
          c.epoch++
          c.runId = r.runId
          this.cancelQueued(key(c.home, c.sessionId))
        }
        return s.epoch
      }
      case 'server': {
        const run = this.runs.get(r.runId)
        if (run) Object.assign(run, { url: r.url.replace(/\/+$/, ''), password: r.password })
        return !!run
      }
      case 'end': {
        const run = this.runs.get(r.runId)
        if (!run) return null
        this.dropRun(run)
        const s = this.sessions.get(run.key)
        if (s && s.runId === r.runId) {
          s.epoch++
          s.runId = null
        }
        for (const c of s ? this.descendants(s) : [])
          if (c.runId === r.runId) {
            c.epoch++
            c.runId = null
          }
        return s?.epoch ?? null
      }
      case 'removeRoot': {
        // Nothing publishes into the root from now (publish and fail check `removed` in the same step as the rename);
        // answered once its exports have ended, their temp files gone, so nothing of the worker's is in the folder.
        const h = r.home.toLowerCase()
        this.removed.add(h)
        for (const [k, s] of this.sessions) {
          if (s.home.toLowerCase() !== h) continue
          s.epoch++
          this.cancelQueued(k)
        }
        for (const run of [...this.runs.values()]) if (run.key.startsWith(`${h}|`)) this.dropRun(run)
        // Its discovery too (HI-2774): a queued one goes, a running one is waited for below.
        this.queue = this.queue.filter((j) => !j.key.startsWith(`${h}|`))
        await Promise.all([...this.exporting].filter(([k]) => k.startsWith(`${h}|`)).map(([, p]) => p))
        // An adoption writing its record in the root is waited for (its rollback, if any, done too); one not committing yet
        // is refused at its commit, the root being removed now (HR2 on HI-2774, round 1).
        while ([...this.adoptions].some(([k, a]) => k.startsWith(`${h}|`) && [...a.leases.values()].includes('committing'))) await new Promise((res) => setTimeout(res, 5))
        return true
      }
      case 'restoreRoot':
        // The removal was taken back (accounts.ts letGo): the root's sessions may be read again.
        this.removed.delete(r.home.toLowerCase())
        return true
      case 'refresh': {
        const run = this.runs.get(r.runId)
        if (!run) return false
        return this.enqueue({ kind: 'refresh', key: run.key, epoch: run.epoch, runId: r.runId, force: r.force })
      }
      case 'limits': {
        const run = this.runs.get(r.runId)
        if (!run) return false
        return this.enqueue({ kind: 'limits', key: run.key, epoch: run.epoch, runId: r.runId })
      }
      case 'export': {
        if (this.removed.has(r.home.toLowerCase())) return false
        const s = this.session(r.home, r.sessionId)
        // A live run's session is its run's to read.
        if (s.runId) return false
        return this.enqueue({ kind: 'export', key: key(r.home, r.sessionId), epoch: s.epoch, command: r.command, reason: r.reason })
      }
      case 'repairScan':
        return this.repairCandidates(r.homes)
      case 'discover': {
        // One per account and folder at a time, and only when due: its database changed since that folder's last scan, or
        // that scan left some.
        if (this.removed.has(r.home.toLowerCase()) || !this.discoveryDue(r.home, r.folder)) return false
        return this.enqueue({ kind: 'discover', key: key(r.home, `#discover|${r.folder.toLowerCase()}`), epoch: 0, command: r.command, reason: r.reason, home: r.home, folder: r.folder })
      }
      case 'discoveryFolders':
        // The repair pass: each account's folders scanned before whose scan is due again.
        return r.homes.filter((h) => !this.removed.has(h.toLowerCase())).flatMap((home) => Object.values(this.readDiscovery(home)).filter((d) => this.discoveryDue(home, d.folder)).map((d) => ({ home, folder: d.folder })))
      case 'adoptMark': {
        const m = this.adoptMark(r.home, r.sessionId, r.directory)
        if (!m.ok) return m
        const k = key(r.home, r.sessionId)
        const a = this.adoptions.get(k) ?? { created: false, committed: false, leases: new Map() }
        const lease = `${this.epochBase}-${++this.leaseCount}`
        a.created ||= m.created
        a.leases.set(lease, 'pending')
        this.adoptions.set(k, a)
        return { ...m, lease }
      }
      case 'adoptCommit': {
        // The adoption's record is about to be written: refused when its root is going (or went) away meanwhile, or its
        // lease isn't known (a worker since restarted); else the root's removal waits for it to be done.
        const a = this.adoptions.get(key(r.home, r.sessionId))
        if (this.removed.has(r.home.toLowerCase()) || this.closed || !a?.leases.has(r.lease) || !existsSync(markPath(r.home, r.sessionId))) return false
        a.leases.set(r.lease, 'committing')
        return true
      }
      case 'adoptDone': {
        const k = key(r.home, r.sessionId)
        const a = this.adoptions.get(k)
        if (!a) {
          // A lease a restarted worker never knew: its own mark taken back if its record wasn't written.
          if (!r.ok && r.created) rmSync(markPath(r.home, r.sessionId), { force: true })
          return true
        }
        a.leases.delete(r.lease)
        if (r.ok) a.committed = true
        if (a.leases.size) return true
        this.adoptions.delete(k)
        if (!a.committed && a.created) rmSync(markPath(r.home, r.sessionId), { force: true })
        return true
      }
      case 'bounds':
        this.bounds = { ...this.bounds, ...r.bounds }
        return this.bounds
      case 'idle':
        // Tests: everything queued and running has ended.
        while (this.queue.length || this.inflight.size) await Promise.race([...this.inflight, new Promise((res) => setTimeout(res, 5))])
        return true
      case 'shutdown':
        this.closed = true
        this.queue = []
        for (const run of [...this.runs.values()]) this.dropRun(run)
        for (const c of this.children) this.deps.endTree(c)
        this.children.clear()
        return true
    }
  }

  /** The session's epoch now (tests). */
  epochOf(home: string, sessionId: string): number | null {
    return this.sessions.get(key(home, sessionId))?.epoch ?? null
  }

  /** How many jobs wait (tests: the bound). */
  get pending(): number {
    return this.queue.length
  }

  private session(home: string, sessionId: string): Session {
    const k = key(home, sessionId)
    let s = this.sessions.get(k)
    if (!s) this.sessions.set(k, (s = { home, sessionId, epoch: this.epochBase, runId: null, updated: 0, parent: null, settled: false, revert: null }))
    return s
  }

  /** A session's subagents' sessions, theirs, and so on, each once. */
  private descendants(s: Session): Session[] {
    const out: Session[] = []
    const seen = new Set([key(s.home, s.sessionId)])
    const todo = [s]
    while (todo.length) {
      const p = todo.pop()!
      for (const id of this.kids.get(key(p.home, p.sessionId)) ?? []) {
        const k = key(p.home, id)
        const c = this.sessions.get(k)
        if (!c || seen.has(k)) continue
        seen.add(k)
        out.push(c)
        todo.push(c)
      }
    }
    return out
  }

  /**
   * After a session's read published: the subagents its parts name. While its run lives, each is the run's and is read
   * from its server (a poll: nothing more when unchanged); after it, those whose mirror is older than their newest start
   * are given to main to export (`reason`: the parent's).
   */
  private followChildren(s: Session, source: 'api' | 'export', info: Record<string, any>, messages: Record<string, any>[], reason: 'runEnd' | 'repair' = 'repair'): void {
    // A fork's copied messages name its source's subagents (HI-2774): only what it ran itself is its own to follow.
    const found = [...subagentSessions(s.sessionId, ownMessages(info, messages))].sort((a, b) => b[1] - a[1]).slice(0, MAX_CHILDREN)
    const pk = key(s.home, s.sessionId)
    if (!found.length) return void this.kids.delete(pk)
    this.kids.set(pk, new Set(found.map(([id]) => id)))
    const run = source === 'api' && s.runId ? this.runs.get(s.runId) : undefined
    const exports: string[] = []
    for (const [id, ran] of found) {
      const c = this.session(s.home, id)
      // The session that started it, once known, stays its parent.
      if (c.parent && c.parent !== s.sessionId) continue
      c.parent = s.sessionId
      if (run) {
        if (c.runId !== run.runId) {
          c.epoch++
          c.runId = run.runId
        }
        this.enqueue({ kind: 'refresh', key: key(s.home, id), epoch: c.epoch, runId: run.runId })
      } else if (source === 'export' && !c.runId && this.needsExport(c, ran)) exports.push(id)
    }
    if (exports.length) this.emit({ event: 'children', home: s.home, sessionId: s.sessionId, children: exports, reason })
  }

  /**
   * A child's mirror needs an export: none complete, one ending in a notice, one read while the child still ran (its first
   * line says so: needsRepair), or one older than its newest start.
   */
  private needsExport(c: Session, ran: number): boolean {
    const h = this.header(c)
    if (!h || h.state !== 'complete' || this.needsRepair(c.home, c.sessionId)) return true
    return !(typeof h.updated === 'number' && h.updated >= ran)
  }

  /** At a run's poll: its session's subagents still running are checked too (a poll each: nothing more when unchanged). */
  private pollChildren(s: Session, run: Run): void {
    for (const c of this.descendants(s)) if (c.runId === run.runId && !c.settled) this.enqueue({ kind: 'refresh', key: key(c.home, c.sessionId), epoch: c.epoch, runId: run.runId })
  }

  private dropRun(run: Run): void {
    run.abort.abort()
    this.runs.delete(run.runId)
    this.queue = this.queue.filter((j) => j.runId !== run.runId)
  }

  private cancelQueued(k: string): void {
    this.queue = this.queue.filter((j) => j.key !== k)
  }

  /**
   * Queues a job: replacing the session's queued one of its kind (a run-end export is never replaced by a repair); when
   * full, a repair export makes room, else a refresh is left to its next poll and a run-end export to the repair pass.
   */
  private enqueue(job: Job): boolean {
    if (this.closed) return false
    const same = this.queue.findIndex((j) => j.key === job.key && j.kind === job.kind)
    if (same >= 0) {
      const old = this.queue[same]
      if (!(old.reason === 'runEnd' && job.reason === 'repair')) this.queue[same] = { ...job, force: job.force || old.force }
      this.pump()
      return true
    }
    if (this.queue.length >= this.bounds.maxPending) {
      const repair = this.queue.findIndex((j) => j.reason === 'repair')
      if (repair >= 0) this.queue.splice(repair, 1)
      else {
        if (job.kind === 'export' && job.reason === 'runEnd') this.keepForRepair(job.key)
        this.emit({ event: 'log', level: 'info', text: `the OpenCode history's queue is full (${this.queue.length}): a ${job.kind} waits for its next turn` }) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
        return false
      }
    }
    this.queue.push(job)
    this.pump()
    return true
  }

  private keepForRepair(k: string): void {
    const s = this.sessions.get(k)
    if (!s) return
    this.writeState(s, { ...this.readState(s), pending: true })
  }

  private pump(): void {
    if (this.closed) return
    for (let i = 0; i < this.queue.length; ) {
      const j = this.queue[i]
      const cap = j.kind === 'refresh' ? this.bounds.refreshes : 1
      // One job of a session at a time.
      const busy = this.busy.has(j.key)
      if (this.running[j.kind] >= cap || busy) {
        i++
        continue
      }
      this.queue.splice(i, 1)
      this.running[j.kind]++
      this.busy.add(j.key)
      const p = this.run(j)
        .catch((e) => this.emit({ event: 'log', level: 'warn', text: `an OpenCode history ${j.kind} failed: ${e instanceof Error ? e.message : String(e)}` })) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
        .finally(() => {
          this.running[j.kind]--
          this.busy.delete(j.key)
          this.inflight.delete(p)
          this.pump()
        })
      this.inflight.add(p)
    }
  }
  private busy = new Set<string>()

  private async run(j: Job): Promise<void> {
    if (j.kind === 'refresh') return this.refresh(j)
    if (j.kind === 'limits') return this.limits(j)
    // An export or a discovery runs a command in the account's folder: removeRoot waits for it (exporting, by its key).
    const p = j.kind === 'discover' ? this.discoverJob(j) : this.exportJob(j)
    this.exporting.set(j.key, p.catch(() => undefined))
    try {
      await p
    } finally {
      this.exporting.delete(j.key)
    }
  }

  // ---- Reading from a run's server

  private async get(run: Run, path: string, deadline: number): Promise<unknown> {
    if (!run.url || !run.password) throw new Failed('timeout', 'the server is not known yet') // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
    const ms = Math.min(this.bounds.requestMs, deadline - this.deps.now())
    if (ms <= 0) throw new Failed('timeout', 'the read took too long') // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
    const signal = AbortSignal.any([AbortSignal.timeout(ms), run.abort.signal])
    const res = await this.deps.get(run.url + path, { authorization: 'Basic ' + Buffer.from(`opencode:${run.password}`).toString('base64') }, signal, this.bounds.maxBytes) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
    if (res.status !== 200) throw new Failed('timeout', `${path.split('?')[0]} answered ${res.status}`) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
    try {
      return JSON.parse(res.body)
    } catch {
      // The log's watermark is an SSE frame (`data: {…}`).
      const m = /^data:\s*(\{.*\})\s*$/m.exec(res.body)
      if (m) return JSON.parse(m[1])
      throw new Failed('parse', `${path.split('?')[0]} wasn't JSON`) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
    }
  }

  /** The session's durable watermark (`log?after=0`'s log.synced seq), as HI-2760's launcher reads it. */
  private async watermark(run: Run, sid: string, deadline: number): Promise<number> {
    const o = (await this.get(run, `/api/experimental/session/${encodeURIComponent(sid)}/log?after=0`, deadline)) as Record<string, unknown>
    if (o && o.type === 'log.synced' && typeof o.seq === 'number') return o.seq
    throw new Failed('parse', "the log's watermark wasn't readable") // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
  }

  /** A settled read: the watermark, the session, every page of messages (newest first by its cursor), the watermark again. */
  private async settledRead(run: Run, s: Session, deadline: number): Promise<{ w: number; info: Record<string, any>; messages: Record<string, any>[] } | null> {
    const sid = encodeURIComponent(s.sessionId)
    for (let i = 0; i < this.bounds.settleTries; i++) {
      const w1 = await this.watermark(run, s.sessionId, deadline)
      const info = ((await this.get(run, `/api/session/${sid}`, deadline)) as { data?: Record<string, any> })?.data
      if (!info || info.id !== s.sessionId) throw new Failed('parse', "the session's info wasn't readable") // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
      const newestFirst: Record<string, any>[] = []
      let cursor: string | null = null
      for (let page = 0; ; page++) {
        if (page >= this.bounds.maxPages) throw new Failed('size', `the session has more than ${this.bounds.maxPages} pages of messages`) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
        const q: string = `limit=${this.bounds.pageSize}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
        const body = (await this.get(run, `/api/session/${sid}/message?${q}`, deadline)) as { data?: unknown; cursor?: { next?: unknown } }
        if (!body || !Array.isArray(body.data)) throw new Failed('parse', "the session's messages weren't readable") // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
        newestFirst.push(...(body.data as Record<string, any>[]))
        const next = typeof body.cursor?.next === 'string' ? body.cursor.next : null
        if (!next || body.data.length < this.bounds.pageSize) break
        cursor = next
      }
      const w2 = await this.watermark(run, s.sessionId, deadline)
      if (w1 === w2) return { w: w1, info, messages: newestFirst.reverse() }
    }
    return null
  }

  private async refresh(j: Job): Promise<void> {
    const run = j.runId ? this.runs.get(j.runId) : undefined
    const s = this.sessions.get(j.key)
    if (!run || !s || s.epoch !== j.epoch || !run.url) return
    const deadline = this.deps.now() + this.bounds.refreshMs
    try {
      if (!j.force) {
        if (run.key === j.key) this.pollChildren(s, run)
        // A poll: nothing more is read while the session's time.updated is the one published.
        const info = ((await this.get(run, `/api/session/${encodeURIComponent(s.sessionId)}`, deadline)) as { data?: Record<string, any> })?.data
        const updated = typeof info?.time?.updated === 'number' ? info.time.updated : 0
        // 2.2.6 sets a session's `time.idle` at its end without moving `time.updated` (HI-2773's R0): that is a change too.
        // A staged revert or its undoing changes the info too (HI-2774): compared as well, whatever time.updated says.
        const revert = typeof info?.revert?.messageID === 'string' ? info.revert.messageID : null
        if (updated && updated === s.updated && sessionSettled(info ?? {}) === s.settled && revert === s.revert && this.complete(s)) return
      }
      const read = await this.settledRead(run, s, deadline)
      // Unsettled every try (a turn under way): the next poll or nudge reads again; nothing is published, no notice.
      if (!read) return
      const updated = typeof read.info.time?.updated === 'number' ? read.info.time.updated : 0
      if (this.publish(s, j.epoch, 'api', read.w, updated, read.info, read.messages)) this.followChildren(s, 'api', read.info, read.messages)
    } catch (e) {
      // A run's server going away (it ends with its run) or slow is no notice: its run-end export reads it again. What a
      // retry can't change (too large, unreadable) is one.
      if (e instanceof Failed && (e.problem === 'size' || e.problem === 'parse')) this.fail(s, j.epoch, e.problem, e.said)
      else this.emit({ event: 'log', level: 'info', text: `an OpenCode session couldn't be read from its server (${e instanceof Error ? e.message : String(e)}); its next poll tries again` }) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
    }
  }

  private async limits(j: Job): Promise<void> {
    const run = j.runId ? this.runs.get(j.runId) : undefined
    if (!run || run.epoch !== j.epoch || !run.url) return
    try {
      const body = await this.get(run, '/api/experimental/usage/limits', this.deps.now() + this.bounds.requestMs)
      if (!this.runs.has(run.runId)) return
      this.emit({ event: 'limits', runId: run.runId, epoch: j.epoch, reading: opencodePlanUsage(body, new Date(this.deps.now()).toISOString()) })
    } catch (e) {
      // An error changes nothing: kept limits expire by their own reset.
      this.emit({ event: 'log', level: 'info', text: `OpenCode's usage limits couldn't be read (${e instanceof Error ? e.message : String(e)})` }) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
    }
  }

  // ---- Export (a session with no live run: after its run, or repaired)

  private async exportJob(j: Job): Promise<void> {
    const s = this.sessions.get(j.key)
    if (!s || s.epoch !== j.epoch || !j.command || s.runId) return
    const dir = mirrorDir(s.home)
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.${s.sessionId}.export-${process.pid}-${this.deps.now()}.json`)
    try {
      const code = await this.runExport(j.command, tmp, () => s.epoch === j.epoch, this.bounds.maxExportBytes)
      if (s.epoch !== j.epoch) return
      if (code !== 0) throw new Failed('exit', `opencode exited with code ${code}`, this.tail(tmp)) // i18n-ignore: a log line; the CLI's own output is what the history shows
      const parsed = parseExport(readFileSync(tmp, 'utf8'))
      if (!parsed || parsed.info.id !== s.sessionId) throw new Failed('parse', "the export wasn't a session's") // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
      const updated = typeof parsed.info.time?.updated === 'number' ? parsed.info.time.updated : newestMessage(parsed.messages)
      const published = this.publish(s, j.epoch, 'export', -1, updated, parsed.info, parsed.messages)
      // A subagent's export that still says it runs (its parent's run ended under it) is read again by the repair pass, as
      // a failure is: once the account's database changed, or after the retry time, never in a loop.
      if (published && typeof parsed.info.parentID === 'string' && !sessionSettled(parsed.info)) this.writeState(s, { failedAt: this.deps.now(), dbMtime: this.dbMtime(s.home), attempts: (this.readState(s).attempts ?? 0) + 1 })
      else this.clearState(s)
      if (published) this.followChildren(s, 'export', parsed.info, parsed.messages, j.reason)
    } catch (e) {
      const f = e instanceof Failed ? e : new Failed('exit', e instanceof Error ? e.message : String(e)) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
      if (s.epoch !== j.epoch) return
      this.fail(s, j.epoch, f.problem, f.said)
      this.emit({ event: 'log', level: 'warn', text: `an OpenCode session's export failed: ${f.message}` }) // i18n-ignore: a log line
      const st = this.readState(s)
      this.writeState(s, { failedAt: this.deps.now(), dbMtime: this.dbMtime(s.home), attempts: (st.attempts ?? 0) + 1 })
    } finally {
      rmSync(tmp, { force: true })
    }
  }

  /** Runs an export, its stdout to `tmp` up to the bound; the exit code, or a Failed. Killed when the session's epoch moves on. */
  private runExport(cmd: CommandSpec, tmp: string, wanted: () => boolean, maxBytes: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const out = createWriteStream(tmp)
      let child: ChildProcess
      try {
        child = this.deps.spawn(cmd.file, cmd.line !== undefined ? [cmd.line] : cmd.args, { env: cmd.env, cwd: cmd.cwd, verbatim: cmd.line !== undefined })
      } catch (e) {
        out.close()
        return reject(new Failed('exit', e instanceof Error ? e.message : String(e))) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
      }
      this.children.add(child)
      let bytes = 0
      let stderr = ''
      let why: Failed | null = null
      const kill = (f: Failed): void => {
        if (why) return
        why = f
        this.deps.endTree(child)
      }
      const timer = setTimeout(() => kill(new Failed('timeout', `the export took over ${Math.round(this.bounds.exportMs / 1000)} s`)), this.bounds.exportMs) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
      const watch = setInterval(() => {
        if (!wanted() || this.closed) kill(new Failed('exit', 'stopped: the session moved on')) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
      }, 200)
      child.stdout?.on('data', (b: Buffer) => {
        bytes += b.length
        if (bytes > maxBytes) return kill(new Failed('size', `the output was over ${maxBytes} bytes`)) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
        out.write(b)
      })
      child.stderr?.on('data', (b: Buffer) => {
        if (stderr.length < 4000) stderr += b.toString('utf8')
      })
      const done = (code: number | null, err?: Error): void => {
        clearTimeout(timer)
        clearInterval(watch)
        this.children.delete(child)
        out.end(() => {
          if (why) return reject(why)
          if (err) return reject(new Failed('exit', err.message)) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
          if (code !== 0 && stderr.trim()) return reject(new Failed('exit', `opencode exited with code ${code}`, stderr.trim().split('\n').slice(-3).join(' '))) // i18n-ignore: a log line; the CLI's stderr is what the history shows
          resolve(code ?? -1)
        })
      }
      child.on('error', (e) => done(null, e))
      child.on('close', (code) => done(code))
    })
  }

  // ---- Discovery (HI-2774): sessions in an account's data that Combwork didn't make (its TUI's `/new` or `/fork`)

  /** An account's discovery record: its folders' entries, by folder in lower case. */
  private readDiscovery(home: string): Record<string, Discovery> {
    try {
      const o = JSON.parse(readFileSync(discoveryPath(home), 'utf8'))
      if (!o || typeof o !== 'object' || !o.folders || typeof o.folders !== 'object') return {}
      return Object.fromEntries(Object.entries(o.folders as Record<string, Discovery>).filter(([, d]) => d && typeof d.folder === 'string'))
    } catch {
      return {}
    }
  }

  private writeDiscovery(home: string, d: Discovery): void {
    const all = this.readDiscovery(home)
    all[d.folder.toLowerCase()] = d
    const kept = Object.entries(all).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, MAX_FOLDERS)
    mkdirSync(mirrorDir(home), { recursive: true })
    writeFileSync(discoveryPath(home), JSON.stringify({ folders: Object.fromEntries(kept) }))
  }

  /** Due: that folder never scanned, its last scan left candidates it didn't hand out, or the database changed since. */
  private discoveryDue(home: string, folder: string): boolean {
    const d = this.readDiscovery(home)[folder.toLowerCase()]
    return !d || !d.complete || (d.dbMtime ?? 0) < this.dbMtime(home)
  }

  /**
   * One scan of an account (`opencode session list --format json`, standalone: main's protected command, an export's
   * bounds, its output at most `maxListBytes`): the sessions with no mark, no live run and no parent whose mirror is
   * missing, a placeholder, ends in a notice or is older than listed, and whose retry record lets them be tried now; at
   * most `repairBatch` of them, the least recently tried first, go to main to export. The scan is complete only when it
   * handed out every one, so a backlog is scanned for again at the next pass though the database didn't change.
   */
  private async discoverJob(j: Job): Promise<void> {
    const home = j.home
    const folder = j.folder
    if (!home || !folder || !j.command || this.removed.has(home.toLowerCase()) || this.closed) return
    const db = this.dbMtime(home)
    const dir = mirrorDir(home)
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.discover-${process.pid}-${this.deps.now()}.json`)
    let listed: unknown
    try {
      const code = await this.runExport(j.command, tmp, () => !this.removed.has(home.toLowerCase()), this.bounds.maxListBytes)
      if (code !== 0) throw new Failed('exit', `opencode exited with code ${code}`) // i18n-ignore: a log line
      listed = JSON.parse(readFileSync(tmp, 'utf8'))
    } catch (e) {
      this.emit({ event: 'log', level: 'info', text: `an OpenCode account's sessions couldn't be listed (${e instanceof Error ? e.message : String(e)}); the next pass tries again` }) // i18n-ignore: a log line
      return
    } finally {
      rmSync(tmp, { force: true })
    }
    if (this.removed.has(home.toLowerCase()) || this.closed || !Array.isArray(listed)) return
    const now = this.deps.now()
    const found: { id: string; tried: number }[] = []
    for (const row of listed) {
      const id = row && typeof row === 'object' ? (row as Record<string, unknown>).id : null
      const updated = row && typeof row === 'object' ? (row as Record<string, unknown>).updated : null
      if (typeof id !== 'string' || !SESSION_ID.test(id) || existsSync(markPath(home, id))) continue
      if (this.sessions.get(key(home, id))?.runId) continue
      const h = this.header({ home, sessionId: id })
      // A subagent's is its parent's to follow (followChildren).
      if (h?.parent) continue
      if (h?.state === 'complete' && !this.needsRepair(home, id) && typeof h.updated === 'number' && typeof updated === 'number' && h.updated >= updated) continue
      const st = this.readState({ home, sessionId: id })
      if (st.failedAt && (st.dbMtime ?? 0) >= db && now - st.failedAt < this.bounds.repairHours * 3600_000) continue
      found.push({ id, tried: st.failedAt ?? 0 })
    }
    found.sort((a, b) => a.tried - b.tried)
    const batch = found.slice(0, this.bounds.repairBatch).map((f) => f.id)
    // Each handed out is kept for the repair pass before the scan counts as done (HR2 on HI-2774, round 1): a placeholder
    // mirror and a pending retry record, so an export main never queued (a restart, a full queue, no command) is still
    // made by the repair pass, which reads the mirror folder.
    for (const id of batch) {
      if (!existsSync(mirrorPath(home, id))) writeFileSync(mirrorPath(home, id), placeholderMirror(), { flag: 'wx' })
      this.writeState({ home, sessionId: id }, { ...this.readState({ home, sessionId: id }), pending: true })
    }
    this.writeDiscovery(home, { folder, dbMtime: db, complete: found.length <= batch.length, at: now })
    if (batch.length) this.emit({ event: 'discovered', home, sessions: batch })
  }

  /**
   * An adoption's mark (HI-2774): Combwork takes over a session it didn't make, in the account whose data holds it, as the
   * launcher's own mark says it made one (`{id, directory}`). In order with removals: none in a root being removed. Only
   * for a complete mirror of that session, one Combwork didn't make, in that folder; never over another mark (one already
   * there for the same session and folder is taken as it is: `created: false`, so a rollback leaves it).
   */
  private adoptMark(home: string, sessionId: string, directory: string): { ok: true; created: boolean } | { ok: false; why: 'notRead' | 'otherFolder' | 'otherMark' | 'other' } {
    if (this.removed.has(home.toLowerCase()) || this.closed || !SESSION_ID.test(sessionId)) return { ok: false, why: 'other' } // i18n-ignore: an ICU select key (providers.opencode.adoptRefused), not text
    const same = (a: unknown): boolean => typeof a === 'string' && a.replace(/[\\/]+$/, '').toLowerCase() === directory.replace(/[\\/]+$/, '').toLowerCase()
    const mark = markPath(home, sessionId)
    if (existsSync(mark)) {
      try {
        const o = JSON.parse(readFileSync(mark, 'utf8'))
        return o && o.id === sessionId && same(o.directory) ? { ok: true, created: false } : { ok: false, why: 'otherMark' } // i18n-ignore: an ICU select key (providers.opencode.adoptRefused), not text
      } catch {
        return { ok: false, why: 'otherMark' } // i18n-ignore: an ICU select key (providers.opencode.adoptRefused), not text
      }
    }
    let lines: string[]
    try {
      lines = readFileSync(mirrorPath(home, sessionId), 'utf8').split('\n', 2)
    } catch {
      return { ok: false, why: 'notRead' } // i18n-ignore: an ICU select key (providers.opencode.adoptRefused), not text
    }
    const h = mirrorState(lines[0] ?? '').header
    if (!h || h.state !== 'complete' || !h.external) return { ok: false, why: h?.parent || h?.fork ? 'other' : 'notRead' } // i18n-ignore: ICU select keys (providers.opencode.adoptRefused), not text
    let info: Record<string, any> | null = null
    try {
      const o = JSON.parse(lines[1] ?? '')
      info = o && o.type === 'combwork.session' ? o.info : null
    } catch {
      info = null
    }
    if (!info || info.id !== sessionId) return { ok: false, why: 'notRead' } // i18n-ignore: an ICU select key (providers.opencode.adoptRefused), not text
    if (!same(h.directory) || !same(info.location?.directory)) return { ok: false, why: 'otherFolder' } // i18n-ignore: an ICU select key (providers.opencode.adoptRefused), not text
    try {
      writeFileSync(mark, JSON.stringify({ id: sessionId, directory: info.location.directory }), { flag: 'wx' })
    } catch {
      return { ok: false, why: 'otherMark' } // i18n-ignore: an ICU select key (providers.opencode.adoptRefused), not text
    }
    return { ok: true, created: true }
  }

  private tail(file: string): string {
    try {
      return readFileSync(file, 'utf8').trim().slice(-300)
    } catch {
      return ''
    }
  }

  // ---- Publication: checked and written in one synchronous step

  private complete(s: Session): boolean {
    return this.header(s)?.state === 'complete'
  }

  /** The published mirror's header (its first line, read alone), or null. */
  private header(s: Pick<Session, 'home' | 'sessionId'>): MirrorHeader | null {
    const p = mirrorPath(s.home, s.sessionId)
    let fd: number | null = null
    try {
      fd = openSync(p, 'r')
      const buf = Buffer.alloc(4096)
      const n = readSync(fd, buf, 0, buf.length, 0)
      const first = buf.toString('utf8', 0, n).split('\n')[0]
      return mirrorState(first).header
    } catch {
      return null
    } finally {
      if (fd !== null) closeSync(fd)
    }
  }

  /**
   * Publishes a read if its epoch is still the session's, its root wasn't removed, and it isn't older than what is
   * published: synchronous from the check to the rename, so no other request is applied in between.
   */
  publish(s: Session, epoch: number, source: 'api' | 'export', w: number, updated: number, info: Record<string, any>, messages: Record<string, any>[]): boolean {
    if (s.epoch !== epoch || this.removed.has(s.home.toLowerCase()) || this.closed) return false
    // A subagent's session is published only as the one its parent named (its info says that parent).
    if (s.parent && info.parentID !== s.parent) {
      this.emit({ event: 'log', level: 'warn', text: "an OpenCode subagent's session didn't name the session that started it: not published" }) // i18n-ignore: a log line
      return false
    }
    const h = this.header(s)
    if (h?.state === 'complete') {
      if (source === 'api' && h.source === 'api' && h.epoch === epoch && typeof h.w === 'number' && h.w > w) return false
      if (typeof h.updated === 'number' && h.updated > updated) return false
    }
    // A session with no mark of Combwork's and no parent is one Combwork didn't make (HI-2774): its header says so.
    const external = typeof info.parentID !== 'string' && !existsSync(markPath(s.home, s.sessionId))
    const text = buildMirror({ w, epoch, source, at: new Date(this.deps.now()).toISOString(), updated, external }, info, messages)
    this.write(s, text)
    s.updated = updated
    s.settled = sessionSettled(info)
    s.revert = typeof info.revert?.messageID === 'string' ? info.revert.messageID : null
    this.emit({ event: 'published', home: s.home, sessionId: s.sessionId, source, updated, cost: typeof info.cost === 'number' && Number.isFinite(info.cost) ? info.cost : null })
    return true
  }

  /** The last good content again with a status line: the history says the newest read failed. Same checks as publish. */
  private fail(s: Session, epoch: number, problem: MirrorProblem, detail: string): void {
    if (s.epoch !== epoch || this.removed.has(s.home.toLowerCase()) || this.closed) return
    let current = ''
    try {
      current = readFileSync(mirrorPath(s.home, s.sessionId), 'utf8')
    } catch {
      current = ''
    }
    this.write(s, withStatus(current, problem, detail, new Date(this.deps.now()).toISOString()))
    this.emit({ event: 'log', level: 'warn', text: `an OpenCode session's history couldn't be read (${problem})` }) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
  }

  private write(s: Session, text: string): void {
    const dir = mirrorDir(s.home)
    mkdirSync(dir, { recursive: true })
    const p = mirrorPath(s.home, s.sessionId)
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, p)
  }

  // ---- Repair

  private readState(s: Pick<Session, 'home' | 'sessionId'>): RepairState {
    try {
      const o = JSON.parse(readFileSync(statePath(s.home, s.sessionId), 'utf8'))
      return o && typeof o === 'object' ? (o as RepairState) : {}
    } catch {
      return {}
    }
  }

  private writeState(s: Pick<Session, 'home' | 'sessionId'>, st: RepairState): void {
    if (this.removed.has(s.home.toLowerCase())) return
    mkdirSync(mirrorDir(s.home), { recursive: true })
    writeFileSync(statePath(s.home, s.sessionId), JSON.stringify(st))
  }

  private clearState(s: Pick<Session, 'home' | 'sessionId'>): void {
    rmSync(statePath(s.home, s.sessionId), { force: true })
  }

  private dbMtime(home: string): number {
    let t = 0
    for (const f of dbFiles(home))
      try {
        t = Math.max(t, statSync(f).mtimeMs)
      } catch {
        /* none */
      }
    return t
  }

  /**
   * Sessions whose mirror needs an export, at most `repairBatch` (design s13 §1): a placeholder, one ending in a status
   * line, a subagent's read while it still ran (HI-2773), or one a run-end export was kept for; not one with a live run
   * (its poll reads it); and only once the account's
   * database changed since the last failure, or `repairHours` passed.
   */
  repairCandidates(homes: string[]): { home: string; sessionId: string }[] {
    const out: { home: string; sessionId: string }[] = []
    for (const home of homes) {
      if (this.removed.has(home.toLowerCase())) continue
      const dir = mirrorDir(home)
      if (!existsSync(dir)) continue
      let names: string[]
      try {
        names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
      } catch {
        continue
      }
      const db = this.dbMtime(home)
      for (const n of names) {
        if (out.length >= this.bounds.repairBatch) return out
        const sessionId = n.slice(0, -'.jsonl'.length)
        if (this.sessions.get(key(home, sessionId))?.runId) continue
        const st = this.readState({ home, sessionId })
        const ms = st.pending ? null : this.needsRepair(home, sessionId)
        if (!st.pending && !ms) continue
        const eligible = st.pending || !st.failedAt || (st.dbMtime ?? 0) < db || this.deps.now() - st.failedAt >= this.bounds.repairHours * 3600_000
        if (eligible) out.push({ home, sessionId })
      }
    }
    return out
  }

  /** Whether a mirror is a placeholder or ends in a status line (its head and tail read alone). */
  private needsRepair(home: string, sessionId: string): boolean {
    const p = mirrorPath(home, sessionId)
    let fd: number | null = null
    try {
      fd = openSync(p, 'r')
      const size = statSync(p).size
      const head = Buffer.alloc(Math.min(4096, size))
      readSync(fd, head, 0, head.length, 0)
      const first = mirrorState(head.toString('utf8').split('\n')[0]).header
      if (!first || first.state === 'placeholder') return true
      // A subagent's read while it still ran (HR1 on HI-2773): its end is still to be read.
      if (first.parent && first.settled !== true) return true
      const tailLen = Math.min(4096, size)
      const tail = Buffer.alloc(tailLen)
      readSync(fd, tail, 0, tailLen, size - tailLen)
      const lines = tail.toString('utf8').split('\n').filter((l) => l.trim())
      return !!mirrorState(`${head.toString('utf8').split('\n')[0]}\n${lines[lines.length - 1] ?? ''}`).status
    } catch {
      return false
    } finally {
      if (fd !== null) closeSync(fd)
    }
  }
}
