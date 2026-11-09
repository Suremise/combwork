import { spawn as spawnChild, type ChildProcess } from 'child_process'
import { endTree } from '../../progressReporters/wrapper'
import { request as httpRequest } from 'http'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'original-fs'
import { join } from 'path'
import { buildMirror, mirrorState, newestMessage, parseExport, withStatus, type MirrorHeader, type MirrorProblem, type LimitsReading, opencodePlanUsage } from './mirror'

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
}

export const DEFAULT_BOUNDS: Bounds = { maxPending: 64, refreshes: 2, pageSize: 200, maxPages: 100, maxBytes: 8 * 1024 * 1024, requestMs: 10_000, refreshMs: 60_000, settleTries: 3, exportMs: 60_000, maxExportBytes: 64 * 1024 * 1024, repairBatch: 8, repairHours: 24 }

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
  | { type: 'refresh'; runId: string; force?: boolean }
  | { type: 'export'; home: string; sessionId: string; command: CommandSpec; reason: 'runEnd' | 'repair' }
  | { type: 'limits'; runId: string }
  | { type: 'repairScan'; homes: string[] }
  | { type: 'bounds'; bounds: Partial<Bounds> }
  | { type: 'idle' }
  | { type: 'shutdown' }
)

/** What the core tells main without being asked: a mirror published, a limits reading, a line for the log. */
export type CoreEvent =
  | { event: 'published'; home: string; sessionId: string; source: 'api' | 'export'; updated: number; cost: number | null }
  | { event: 'limits'; runId: string; epoch: number; reading: LimitsReading }
  | { event: 'log'; level: 'info' | 'warn'; text: string }

export type CoreReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string } | CoreEvent

export const mirrorDir = (home: string): string => join(home, 'combwork-sessions')
export const mirrorPath = (home: string, sessionId: string): string => join(mirrorDir(home), `${sessionId}.jsonl`)
export const statePath = (home: string, sessionId: string): string => join(mirrorDir(home), `${sessionId}.state.json`)
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
}

interface Run {
  runId: string
  key: string
  epoch: number
  url: string | null
  password: string | null
  abort: AbortController
}

type JobKind = 'refresh' | 'export' | 'limits'
interface Job {
  kind: JobKind
  key: string
  epoch: number
  runId?: string
  force?: boolean
  command?: CommandSpec
  reason?: 'runEnd' | 'repair'
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
  private runs = new Map<string, Run>()
  private removed = new Set<string>()
  /** Queued jobs, oldest first: at most one per session and kind. */
  private queue: Job[] = []
  private running = { refresh: 0, export: 0, limits: 0 }
  private children = new Set<ChildProcess>()
  private inflight = new Set<Promise<unknown>>()
  private closed = false
  bounds: Bounds = { ...DEFAULT_BOUNDS }

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
        return s?.epoch ?? null
      }
      case 'removeRoot': {
        const h = r.home.toLowerCase()
        this.removed.add(h)
        for (const [k, s] of this.sessions) {
          if (s.home.toLowerCase() !== h) continue
          s.epoch++
          this.cancelQueued(k)
        }
        for (const run of [...this.runs.values()]) if (run.key.startsWith(`${h}|`)) this.dropRun(run)
        return true
      }
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
    if (!s) this.sessions.set(k, (s = { home, sessionId, epoch: 0, runId: null, updated: 0 }))
    return s
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
    return this.exportJob(j)
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
        // A poll: nothing more is read while the session's time.updated is the one published.
        const info = ((await this.get(run, `/api/session/${encodeURIComponent(s.sessionId)}`, deadline)) as { data?: Record<string, any> })?.data
        const updated = typeof info?.time?.updated === 'number' ? info.time.updated : 0
        if (updated && updated === s.updated && this.complete(s)) return
      }
      const read = await this.settledRead(run, s, deadline)
      // Unsettled every try (a turn under way): the next poll or nudge reads again; nothing is published, no notice.
      if (!read) return
      const updated = typeof read.info.time?.updated === 'number' ? read.info.time.updated : 0
      this.publish(s, j.epoch, 'api', read.w, updated, read.info, read.messages)
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
      const code = await this.runExport(j.command, tmp, s, j.epoch)
      if (s.epoch !== j.epoch) return
      if (code !== 0) throw new Failed('exit', `opencode exited with code ${code}`, this.tail(tmp)) // i18n-ignore: a log line; the CLI's own output is what the history shows
      const parsed = parseExport(readFileSync(tmp, 'utf8'))
      if (!parsed || parsed.info.id !== s.sessionId) throw new Failed('parse', "the export wasn't a session's") // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
      const updated = typeof parsed.info.time?.updated === 'number' ? parsed.info.time.updated : newestMessage(parsed.messages)
      this.publish(s, j.epoch, 'export', -1, updated, parsed.info, parsed.messages)
      this.clearState(s)
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
  private runExport(cmd: CommandSpec, tmp: string, s: Session, epoch: number): Promise<number> {
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
        if (s.epoch !== epoch || this.closed) kill(new Failed('exit', 'stopped: the session moved on')) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
      }, 200)
      child.stdout?.on('data', (b: Buffer) => {
        bytes += b.length
        if (bytes > this.bounds.maxExportBytes) return kill(new Failed('size', `the export was over ${this.bounds.maxExportBytes} bytes`)) // i18n-ignore: a log line or an internal detail (the history shows only the CLI's own words)
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
  private header(s: Session): MirrorHeader | null {
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
    const h = this.header(s)
    if (h?.state === 'complete') {
      if (source === 'api' && h.source === 'api' && h.epoch === epoch && typeof h.w === 'number' && h.w > w) return false
      if (typeof h.updated === 'number' && h.updated > updated) return false
    }
    const text = buildMirror({ w, epoch, source, at: new Date(this.deps.now()).toISOString(), updated }, info, messages)
    this.write(s, text)
    s.updated = updated
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
   * line, or one a run-end export was kept for; not one with a live run (its poll reads it); and only once the account's
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
