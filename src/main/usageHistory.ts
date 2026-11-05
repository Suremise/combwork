import { Worker } from 'worker_threads'
import { app } from 'electron'
import { existsSync } from 'original-fs'
import { stat } from 'original-fs/promises'
import { createHash } from 'crypto'
import { basename, join } from 'path'
import type { KeptUsage, ProviderId, SessionRecord, UsageHistoryProgress } from '../shared/types'
import { projectAgents } from '../shared/defaults'
import { cardHoldsKey, heldAt, holdIndex, sessionHolds, usageFromRows, type HoldIndex, type SessionHold, type SessionWho } from '../shared/usageLedger'
import type { UsageSummary } from '../shared/usageLedger'
import { advanced } from './advanced'
import { resolvedValues } from './advancedValues'
import { config } from './config'
import { emit, onHiveEvent } from './events'
import { createLogger, userText } from './logger'
import { recordProvider, sessions, type ListContext } from './sessions'
import { boardHolds, cardHolds, type CardHolds } from './tasks'
import { usageFile, type SessionId, type SessionMeta, type StoredSession } from './usageDb'
import type { IngestJob, IngestResult, KeptJob, ReadResult, ReadSeed, RollUpResult, WorkerReply, WorkerRequest } from './usageWorker'
import { openWorkspaces, workspaceFor, WorkspaceService } from './workspace'
import { isAdmitted, ownerOf, refusedOpen } from './openingFence'
import { realPathAsync } from './places'
import { bundledScriptExists, workerHere, workerStarted } from './workerThreads'

const log = createLogger('usage')

/** What the worker answers at once, not after its jobs (usageWorker.ts): one slow to answer is worth a log line. */
const QUERIES: ReadonlySet<Body['type']> = new Set(['sessions', 'cards', 'timelines', 'ids', 'meta', 'read'])

/**
 * The usage history's side in main (#1106): the usage worker (usageWorker.ts) and the work it is given. Main keeps the
 * queue, one job in the worker at a time, most urgent first: a session about to be deleted (its use recorded before its
 * transcript goes), then running sessions (a tick about every minute, and as each ends), then the one-time import of a
 * workspace's existing sessions (the backfill) and the sweeps that find what changed while Hive wasn't looking (every
 * ten minutes). A job is made when its turn comes, so it has the board and the records as they are then. Queries go to
 * the worker too (it alone opens usage.db); main prices what they return with its settings.
 */

/** How often running sessions are read. */
const TICK_MS = 60_000
/** Every this many ticks, each open workspace's sessions are checked for what changed. */
const SWEEP_TICKS = 10
/** A parser's state kept for a session not used for this long is let go (reading it again is from the start). */
const STATE_DAYS = 14
/** How often each open workspace's ended sessions' timelines are rolled up (HI-1648): at its opening, then about daily. */
const ROLL_UP_MS = 24 * 3_600_000
/** How long the board read for holds is used again. */
const CARDS_MS = 30_000

/** A project's holds for sharing its sessions' use out: see UsageHistory.projectHolds. */
interface ProjectHolds {
  index: HoldIndex
  named: (name: string) => string[]
  /** Each agent's holds key, by whoKey (null: it held none of them, once none starts later: holdsKeyOf). */
  keys: Map<string, string | null>
  /** When the latest hold starts (-Infinity: none has a start). */
  latestFrom: number
}

/** A workspace's cards' holds as read at `at`, and each project's worked out from them (UsageHistory.projectHolds). */
interface BoardCards {
  at: number
  cards: Promise<CardHolds[]>
  projects: Map<string, ProjectEntry>
  /** The read before this one's projects: a project whose holds are as they were keeps its agents' keys. */
  prior: Map<string, ProjectEntry> | null
}

/** A project's holds worked out once, their fingerprint, and its agents' keys while its agents are `agents`. */
interface ProjectEntry {
  index: HoldIndex | null
  fp: string
  latestFrom: number
  agents: string | null
  keys: Map<string, string | null>
}

/**
 * A project's holds as they are (each card's: whose, which role, from when to when): equal, its agents' keys are too.
 * From each card's key, kept with the card's object (cardHoldsKey): a board change reads again only the cards it
 * touched, so the rest cost nothing (HI-1887: worked out whole, after each of a dozen agents' comments).
 */
const holdsFingerprint = (cards: CardHolds[]): string => cards.map(cardHoldsKey).join('\n')

/** When the latest of an index's holds starts. */
const latestFromOf = (index: HoldIndex): number => {
  let latest = Number.NEGATIVE_INFINITY
  for (const c of index.cards) for (const h of c.holds) if (h.from > latest) latest = h.from
  return latest
}

const whoKey = (who: SessionWho): string => `${who.agentId ?? ''}\0${who.agentName ?? ''}`

type Priority = 0 | 1 | 2
type Body = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

interface Queued {
  key: string
  priority: Priority
  /** Makes its request (null: none) and sends it. */
  run: () => Promise<unknown>
  waiters: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[]
}

/** A host's usage as the Overview and its like read it: each session's, priced now, by id, with the file it was read from. */
export interface StoredUsage {
  meta: SessionMeta
  source: string
  read: { path: string | null; size: number; mtime: number }
  usage: ReturnType<typeof usageFromRows>
}

const wsKey = (p: string): string => p.toLowerCase()

/** The opening of a workspace that work in the background was begun for: its path, and that opening's lifetime. */
interface WorkspaceRun {
  path: string
  signal: AbortSignal
}
const runOf = (ws: WorkspaceService): WorkspaceRun | null => (ws.path ? { path: ws.path, signal: ws.lifetime } : null)

class UsageHistory {
  private worker: Worker | null = null
  private inProcess: ((m: WorkerRequest) => Promise<unknown>) | null = null
  /** In-process (unit tests): requests under way, and what closes the files once there are none. */
  private inFlight = 0
  private closeInProcess: (() => void) | null = null
  private calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  private next = 1
  private sentConfig = ''
  private queue: Queued[] = []
  /** The job in the worker now. */
  private current: Queued | null = null
  private pumping = false
  private timer: NodeJS.Timeout | null = null
  private ticks = 0
  private stopped = false
  private progress = new Map<string, UsageHistoryProgress>()
  private backfills = new Map<string, Promise<void>>()
  /** Each workspace's cards' holds, read again after a board change or half a minute, and each project's worked out from them once (holdIndex, HI-1748). */
  private cards = new Map<string, BoardCards>()

  /** Starts the tick (Hive is ready). */
  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
    const status = new Map<string, string>()
    onHiveEvent((e) => {
      // The board changed: its holds are read again, and running sessions' cards shared out again if they changed.
      if (e.type === 'tasks-changed') {
        const c = this.cards.get(wsKey(e.workspacePath))
        if (c) c.at = Number.NEGATIVE_INFINITY
        this.cardsChanged(e.workspacePath)
      }
      // A turn ended: what it used is recorded now, not at the next tick, so views that read the history have it.
      if (e.type === 'session-status') {
        const k = `${e.state.projectPath.toLowerCase()}#${e.state.agentId}`
        const was = status.get(k)
        status.set(k, e.state.status)
        if (e.state.status === 'stopped') status.delete(k)
        if (was === 'working' && e.state.status !== 'working' && e.state.sessionId && !e.state.settingUp) this.ingest(e.state.projectPath, e.state.sessionId, { priority: 1, keepState: 'running' }).catch((err) => log.warn('recording a turn that ended', err))
      }
    })
    WorkspaceService.closingListeners.add((path, place) => this.closeWorkspace(path, place))
  }

  /** Board changes in a workspace, a second apart at most: every recorded session's cards shared out again where their holds changed. */
  private cardsDue = new Map<string, NodeJS.Timeout>()
  private cardsChanged(workspacePath: string): void {
    const key = wsKey(workspacePath)
    if (this.cardsDue.has(key)) return
    const t = setTimeout(() => {
      this.cardsDue.delete(key)
      const ws = openWorkspaces().find((w) => w.path?.toLowerCase() === key)
      if (ws) void this.attribute(ws).catch((e) => log.warn('sharing usage out between cards again', e))
    }, 1000)
    t.unref?.()
    this.cardsDue.set(key, t)
  }

  /**
   * Every recorded session of a workspace (running, stopped or deleted) whose cards' holds changed since its rows were
   * shared out, shared out again from what is stored, no file read (#1106 round 3): a card moved after its session
   * stopped, a hold that ended within its last request's second. Holds are worked out once per agent; the worker
   * compares keys and re-shares only the sessions whose changed. Waits for it (cost per card asks first).
   */
  async attribute(ws: WorkspaceService, run = runOf(ws)): Promise<void> {
    if (!run || !this.live(ws, run)) return
    const file = usageFile(run.path)
    const waits: Promise<unknown>[] = []
    for (const host of await ws.listProjectPaths().then(async (a) => [...a, ...(await ws.listProjectPaths({ hidden: true }))])) {
      if (!this.live(ws, run)) return
      const { scope } = await ws.sessionScope(host)
      if (!this.live(ws, run)) return
      waits.push(
        this.enqueue(`attribute|${wsKey(run.path)}|${scope}`, 1, async () => {
          if (!this.live(ws, run)) return null
          const ids = await this.call<SessionId[]>({ type: 'ids', file, scope })
          if (!this.live(ws, run)) return null
          const p = await this.projectHolds(ws, run, host)
          if (!this.live(ws, run)) return null
          const now = Date.now()
          // Each agent's key (kept until the board changes); its holds worked out only for a session whose key changed.
          const byWho = new Map<string, { holds: SessionHold[] | null; holdsKey: string | null }>()
          const list: { session: string; holds: SessionHold[]; holdsKey: string | null }[] = []
          for (const id of ids) {
            if (id.source === 'external') continue
            const who = { ...(id.agentId ? { agentId: id.agentId } : {}), ...(id.agentName ? { agentName: id.agentName } : {}) }
            const k = whoKey(who)
            let h = byWho.get(k)
            if (!h) byWho.set(k, (h = { holds: null, holdsKey: p ? this.holdsKeyOf(p, who, now) : null }))
            if (h.holdsKey !== id.holdsKey) list.push({ session: id.session, holdsKey: h.holdsKey, holds: (h.holds ??= p ? sessionHolds(p.index, who, p.named, now) : []) })
          }
          return list.length ? { type: 'attribute', file, scope, sessions: list } : null
        })
      )
    }
    await Promise.all(waits.map((p) => p.catch(() => undefined)))
  }

  /** Hive quits: what is queued is dropped and the worker ends (each write is a transaction: nothing is left half done). */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const q of this.queue.splice(0)) for (const w of q.waiters) w.resolve(null)
    const w = this.worker
    this.worker = null
    if (w) await w.terminate().catch(() => undefined)
  }

  // -------------------------------------------------------------------------
  // The worker.
  // -------------------------------------------------------------------------

  private async transport(): Promise<(m: WorkerRequest) => void> {
    if (this.worker) return (m) => this.worker!.postMessage(m)
    if (this.inProcess) return (m) => this.runInProcess(m)
    const file = workerScript()
    if (!bundledScriptExists(file)) {
      // Unit tests (no build): the worker's code runs here.
      workerHere('usage history', "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
      const { handleRequest, logInProcess, closeAll } = await import('./usageWorker')
      logInProcess((m) => this.reply(m))
      this.closeInProcess = closeAll
      this.inProcess = handleRequest
      return (m) => this.runInProcess(m)
    }
    const w = new Worker(file)
    this.worker = w
    workerStarted('usage history', w) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
    w.on('message', (m: WorkerReply) => this.reply(m))
    const gone = (why: string): void => {
      if (this.worker !== w) return
      this.worker = null
      this.sentConfig = ''
      log.warn(`the usage worker ended (${why}); it starts again with the next job`)
      for (const c of this.calls.values()) c.reject(new Error(`The usage worker ended (${why})`)) // i18n-ignore: an internal error, for the log
      this.calls.clear()
    }
    w.on('error', (e: Error) => gone(e.message))
    w.on('exit', (code) => gone(`exit code ${code}`)) // i18n-ignore: for the log
    w.unref()
    return (m) => w.postMessage(m)
  }

  private runInProcess(m: WorkerRequest): void {
    this.inFlight++
    this.inProcess!(m)
      .then(
        (value) => this.reply({ id: m.id, ok: true, value }),
        (e) => this.reply({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
      )
      .finally(() => {
        // Nothing under way: its files closed, so a test can delete its folder (a worker thread keeps them open).
        if (--this.inFlight === 0) this.closeInProcess?.()
      })
  }

  private reply(m: WorkerReply): void {
    if ('log' in m) {
      const text = m.path ? `${m.text}: ${userText(m.path)}` : m.text
      if (m.log === 'warn') log.warn(text)
      else log.info(text)
      return
    }
    const c = this.calls.get(m.id)
    if (!c) return
    this.calls.delete(m.id)
    if (m.ok) c.resolve(m.value)
    else c.reject(new Error(m.error))
  }

  /** A request to the worker, the settings it reads sent first when they changed. */
  private async call<T>(body: Body): Promise<T> {
    // A workspace's usage.db is opened only while a window holds it (#1395: the worker keeps it open); a read goes on
    // without the session's saved state in one no window holds. Asked again once the worker is there, with nothing
    // awaited from then to the request: a close meanwhile refuses it.
    // The file it opens: its own, or the one a read takes a session's saved state from. Where it really is and its
    // workspace's place are resolved once, as the request enters (#1456): the worker is sent that file, never the
    // spelling (a junction pointed elsewhere while this waits for the worker would take it to another workspace's), and
    // the place admits it, records the file and closes it. A close is sent a file recorded so, resolved again never.
    // Resolved off main's thread (HI-1909: a few ms each, on every request under load); admitted only after it.
    const spelt = body.type === 'close' ? null : 'file' in body ? body.file : body.type === 'read' ? (body.seed?.file ?? null) : null
    const file = spelt ? await realPathAsync(spelt) : null
    const place = file ? ownerOf(file, true) : null
    if (file) body = body.type === 'read' && body.seed ? { ...body, seed: { ...body.seed, file } } : ({ ...body, file } as Body)
    const admitted = (b: Body): Body => {
      const ok = place !== null && isAdmitted(place)
      if (b.type !== 'close' && 'file' in b && !ok) throw refusedOpen()
      return b.type === 'read' && b.seed && !ok ? { ...b, seed: null } : b
    }
    body = admitted(body)
    const send = await this.transport()
    body = admitted(body)
    const cfg = JSON.stringify({ advanced: resolvedValues(advanced), providers: config.settings.providers, hiveVersion: appVersion(), cacheSize: usageCacheSize() })
    if (cfg !== this.sentConfig) {
      this.sentConfig = cfg
      this.post(send, { type: 'config', ...(JSON.parse(cfg) as Omit<Extract<Body, { type: 'config' }>, 'type'>) }).catch((e) => log.warn('sending the usage worker its settings', e))
    }
    const answer = this.post(send, body) as Promise<T>
    const opens = body.type === 'read' ? (body.seed?.file ?? null) : file
    if (opens && place !== null) {
      const known = this.sent.get(place) ?? new Map<string, string>()
      known.set(wsKey(opens), opens)
      this.sent.set(place, known)
      void answer.finally(() => this.closeIfUnused(opens, place)).catch(() => undefined)
    }
    return answer
  }

  /**
   * The usage.db files the worker was sent (where each really was as its request entered: the worker keeps a file open
   * by the name it is sent), by their workspace's place then (#1456): the workspace's close closes every one, so none
   * holds the folder until Hive quits. Only admitted workspaces' (a request for another is refused), forgotten as each
   * closes: bounded by the windows open.
   */
  private sent = new Map<string, Map<string, string>>()

  /** Closes the workspace at `place`'s usage.db as each file was sent (and `file`), after what was queued. */
  private closeAt(place: string, file?: string): void {
    const files = new Map(this.sent.get(place))
    this.sent.delete(place)
    if (file) files.set(wsKey(file), file)
    for (const [k, f] of files) void this.enqueue(`close|${k}`, 2, async () => ({ type: 'close', file: f })).catch(() => undefined)
  }

  /**
   * A file of a workspace no window has open, used by a request that came after its close (one under way as it closed):
   * closed again, every file of its place sent, so the worker doesn't hold the folder (#1379: the user can't move or delete it).
   * By the place it resolved to as it entered: a window closing the workspace has dismissed it already.
   */
  private closeIfUnused(file: string, place: string): void {
    if (this.stopped || isAdmitted(place)) return
    this.closeAt(place, file)
  }

  private post(send: (m: WorkerRequest) => void, body: Body): Promise<unknown> {
    const id = this.next++
    const sent = performance.now()
    const answer = new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject })
      send({ ...body, id } as WorkerRequest)
    })
    // A query the worker answers at once, not after its jobs, that took over a second says so (#1177).
    if (QUERIES.has(body.type))
      void answer.then(
        () => {
          const ms = performance.now() - sent
          if (ms > 1000) log.info(`the usage worker took ${(ms / 1000).toFixed(1)} s to answer a ${body.type} query`)
        },
        () => undefined
      )
    return answer
  }

  // -------------------------------------------------------------------------
  // The queue.
  // -------------------------------------------------------------------------

  /** Queues a job (one already queued under its key is shared, and takes the more urgent priority). */
  private enqueue<T>(key: string, priority: Priority, queued: () => Promise<Body | null>): Promise<T | null> {
    if (this.stopped) return Promise.resolve(null)
    const run = async (): Promise<unknown> => {
      const body = await queued()
      return body ? this.call(body) : null
    }
    return new Promise<T | null>((resolve, reject) => {
      const had = this.queue.find((q) => q.key === key)
      if (had) {
        had.priority = Math.min(had.priority, priority) as Priority
        had.waiters.push({ resolve: resolve as (v: unknown) => void, reject })
      } else this.queue.push({ key, priority, run, waiters: [{ resolve: resolve as (v: unknown) => void, reject }] })
      void this.pump()
    })
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length && !this.stopped) {
        // The most urgent, oldest first.
        let at = 0
        for (let i = 1; i < this.queue.length; i++) if (this.queue[i].priority < this.queue[at].priority) at = i
        const [q] = this.queue.splice(at, 1)
        this.current = q
        try {
          const value = await q.run()
          for (const w of q.waiters) w.resolve(value)
        } catch (e) {
          for (const w of q.waiters) w.reject(e)
        } finally {
          this.current = null
        }
      }
    } finally {
      this.pumping = false
    }
  }

  // -------------------------------------------------------------------------
  // Recording.
  // -------------------------------------------------------------------------

  /**
   * Records what a session of a host used (its record's: none, nothing), from its transcript or Hive's backup of it, as
   * far as it is written. `priority` 0 for one about to be deleted (it waits for nothing else), 1 for a running one;
   * `keepState` keeps the parser's state ('running': at most every few minutes). `path`: where it was read last, when
   * the caller has it (a sweep), else found as the session list finds it.
   */
  ingest(projectPath: string, sessionId: string, o: { priority: Priority; keepState: IngestJob['keepState']; path?: string; context?: () => Promise<ListContext> }): Promise<IngestResult | null> {
    return this.told(projectPath, sessionId, this.ingestJob(projectPath, sessionId, o))
  }

  /** A job's result, the window told when it recorded something (a list showing the session without it reads it again). */
  private told(projectPath: string, sessionId: string, job: Promise<IngestResult | null>): Promise<IngestResult | null> {
    return job.then((r) => {
      if (r?.status === 'written') emit({ type: 'usage-changed', projectPath, sessionId })
      return r
    })
  }

  private ingestJob(projectPath: string, sessionId: string, o: { priority: Priority; keepState: IngestJob['keepState']; path?: string; context?: () => Promise<ListContext> }): Promise<IngestResult | null> {
    return this.enqueue<IngestResult>(`ingest|${projectPath.toLowerCase()}|${sessionId}`, o.priority, async () => {
      const ws = workspaceFor(projectPath)
      const run = ws && runOf(ws)
      if (!ws || !run) return null
      const { workspace, scope } = await ws.sessionScope(projectPath)
      // The host's records its freshen shares between its jobs (HI-1790), or the job's own record by its key (HI-1887: a
      // turn's end read every record, and its transcript's look again).
      const ctx = o.context ? await o.context() : undefined
      const rec = ctx ? ctx.records.find((s) => s.id === sessionId) : await ws.sessionRecord(projectPath, sessionId)
      if (!rec) return null
      const path = o.path && existsSync(o.path) ? o.path : await sessions.anyTranscript(projectPath, sessionId, ctx).catch(() => null)
      const { holds, holdsKey } = await this.holdsFor(ws, run, projectPath, rec)
      const job: IngestJob = { ...metaOf(scope, rec), path, holds, holdsKey, keepState: o.keepState, ...(rec.serverRan ? { reportsIgnored: true } : {}), ...(rec.serverLocal ? { serverLocal: true } : {}), ...(rec.notLocal ? { notLocal: true } : {}) }
      return { type: 'ingest', file: usageFile(workspace), job }
    })
  }

  /**
   * Records a session started outside Hive (no record: the Sessions list shows it), so its usage is read from the history
   * next time rather than its transcript; it never counts in totals.
   */
  ingestExternal(projectPath: string, ext: { id: string; provider: ProviderId; transcriptPath: string }): Promise<IngestResult | null> {
    return this.told(projectPath, ext.id, this.enqueue<IngestResult>(`ingest|${projectPath.toLowerCase()}|${ext.id}`, 2, async () => {
      const ws = workspaceFor(projectPath)
      if (!ws?.path) return null
      const { workspace, scope } = await ws.sessionScope(projectPath)
      const job: IngestJob = { scope, session: ext.id, provider: ext.provider, path: ext.transcriptPath, holds: [], holdsKey: null, keepState: 'no', external: true }
      return { type: 'ingest', file: usageFile(workspace), job }
    }))
  }

  /**
   * Records a kept usage (a deleted session's, or a record's whose transcript went): for a session the history doesn't
   * have, or has with less counted (the worker keeps whichever counted more). `priority` 0 before a delete.
   */
  private importKept(projectPath: string, k: { id: string; provider: ProviderId; agentId?: string; agentName?: string; name?: string; cwd?: string; usage: KeptUsage['usage'] }, priority: Priority = 2): Promise<IngestResult | null> {
    return this.enqueue<IngestResult>(`kept|${projectPath.toLowerCase()}|${k.id}`, priority, async () => {
      const ws = workspaceFor(projectPath)
      const run = ws && runOf(ws)
      if (!ws || !run) return null
      const { workspace, scope } = await ws.sessionScope(projectPath)
      const { holds, holdsKey } = await this.holdsFor(ws, run, projectPath, { agentId: k.agentId, agentName: k.agentName })
      const job: KeptJob = { scope, session: k.id, provider: k.provider, ...(k.agentId ? { agentId: k.agentId } : {}), ...(k.agentName ? { agentName: k.agentName } : {}), ...(k.name ? { name: k.name } : {}), ...(k.cwd ? { cwd: k.cwd } : {}), usage: k.usage, holds, holdsKey }
      return { type: 'kept', file: usageFile(workspace), job }
    })
  }

  /**
   * The cards a session's agent held (none for the Assistant's), from the board as it is, archived cards too (read again
   * after a change, or half a minute); and their key, open holds as open, so the worker shares a session's cards out again
   * only when they changed. Of `run`'s workspace only: none once it closed (the service may have the next one by then).
   */
  private async holdsFor(ws: WorkspaceService, run: WorkspaceRun, projectPath: string, who: Pick<SessionRecord, 'agentId' | 'agentName'>): Promise<{ holds: SessionHold[]; holdsKey: string | null }> {
    const p = await this.projectHolds(ws, run, projectPath)
    if (!p) return { holds: [], holdsKey: null }
    const now = Date.now()
    const holds = sessionHolds(p.index, who, p.named, now)
    return { holds, holdsKey: holds.length ? this.holdsKeyOf(p, who, now) : null }
  }

  /**
   * A project's cards' holds as the board has them (read again after a change, or half a minute), worked out once
   * (holdIndex), how a hold with only a name finds its agent, and each agent's holds key, kept while the board and the
   * project's agents are as they were (HI-1748). Null: none (no cards; the Assistant's; `run`'s workspace closed).
   */
  private async projectHolds(ws: WorkspaceService, run: WorkspaceRun, projectPath: string): Promise<ProjectHolds | null> {
    if (!this.live(ws, run) || ws.isAssistantHome(projectPath)) return null
    const c = this.boardCards(ws, run)
    const project = basename(projectPath).toLowerCase()
    const all = await c.cards
    if (!this.live(ws, run)) return null
    let kept = c.projects.get(project)
    if (!kept) {
      const own = all.filter((card) => card.project.toLowerCase() === project)
      const fp = holdsFingerprint(own)
      const was = c.prior?.get(project)
      if (was && was.fp === fp) kept = was
      else {
        const index = own.length ? holdIndex(own) : null
        kept = { index, fp, latestFrom: index ? latestFromOf(index) : Number.NEGATIVE_INFINITY, agents: null, keys: new Map() }
      }
      c.projects.set(project, kept)
    }
    const index = kept.index
    if (!index) return null
    const cfg = await ws.projectConfig(projectPath).catch(() => null)
    if (!this.live(ws, run)) return null
    const agents = cfg ? projectAgents(cfg) : []
    // A hold with only a name is its agent's by the agents named so now: their keys are kept while those are the same.
    const names = agents.map((a) => `${a.id}\0${a.name}`).join('\n')
    if (kept.agents !== names) Object.assign(kept, { agents: names, keys: new Map() })
    // Each name looked up once: every hold with only a name asks, for each agent's key.
    const byName = new Map<string, string[]>()
    const named = (name: string): string[] => {
      const k = name.toLowerCase()
      let ids = byName.get(k)
      if (!ids) byName.set(k, (ids = agents.filter((a) => a.name.toLowerCase() === k).map((a) => a.id)))
      return ids
    }
    return { index, named, keys: kept.keys, latestFrom: kept.latestFrom }
  }

  /** The workspace's cards' holds kept (read again after a board change, which is told as it commits, or half a minute). */
  private boardCards(ws: WorkspaceService, run: WorkspaceRun): BoardCards {
    const key = wsKey(run.path)
    let c = this.cards.get(key)
    if (!c || Date.now() - c.at > CARDS_MS) {
      // Only the cards' holds (#1107: never their comments).
      // What the last read worked out, for the projects whose holds a change left as they were (most: a comment, a move of another project's card).
      const prior = c ? new Map([...(c.prior ?? []), ...c.projects]) : null
      c = { at: Date.now(), cards: boardHolds(ws).catch(() => []), projects: new Map(), prior }
      this.cards.set(key, c)
    }
    return c
  }

  /**
   * Every card's holds, archived cards too, as sharing sessions' use out reads them: cost per card and per lane take
   * these rather than reading every card's holds again (HI-1748). Kept until the board changes.
   */
  boardHolds(ws: WorkspaceService): Promise<CardHolds[]> {
    const run = runOf(ws)
    return run && this.live(ws, run) ? this.boardCards(ws, run).cards : cardHolds(ws)
  }

  /**
   * An agent's holds key: its holds with open ones ending "never", so one going on doesn't change it and one ending
   * does; null while it holds no card. The worker shares a session's cards out again only when its key changed. Null is
   * kept too once every hold has started (HI-1887: each of the history's agents asks after every board change): a hold
   * only ever starts holding later, so one that held none of them by then never will.
   */
  private holdsKeyOf(p: ProjectHolds, who: SessionWho, now: number): string | null {
    const k = whoKey(who)
    const had = p.keys.get(k)
    if (had !== undefined) return had
    if (!heldAt(p.index, who, p.named, now)) {
      if (now > p.latestFrom) p.keys.set(k, null)
      return null
    }
    const key = createHash('sha1').update(JSON.stringify(sessionHolds(p.index, who, p.named, Number.MAX_SAFE_INTEGER))).digest('hex')
    p.keys.set(k, key)
    return key
  }

  /**
   * Running sessions, read about every minute; every ten minutes, each open workspace's sessions checked for changes,
   * and an import that couldn't finish tried again.
   */
  private tick(): void {
    for (const st of sessions.liveStates()) {
      if (st.sessionId && !st.settingUp) this.ingest(st.projectPath, st.sessionId, { priority: 1, keepState: 'running' }).catch((e) => log.warn('recording a running session', e))
    }
    if (++this.ticks % SWEEP_TICKS !== 0) return
    for (const ws of openWorkspaces()) {
      const run = runOf(ws)
      if (!run) continue
      if (!this.backfilled(run.path)) void this.opened(ws)
      else
        void this.sweep(ws, run)
          .then(() => this.housekeep(ws, run))
          .catch((e) => log.warn('checking the usage history', e))
    }
  }

  /** A session's launch ended: what it used is recorded now, with its parser's state. */
  sessionEnded(projectPath: string, sessionId: string): void {
    this.ingest(projectPath, sessionId, { priority: 1, keepState: 'now' }).catch((e) => log.warn('recording a session that ended', e))
  }

  /**
   * Brings a workspace's running sessions' history up to date, and waits for what is queued for sessions that just ended:
   * for what reads a session's latest use at once (cost per card and per lane; the views that refresh on a tick may lag).
   */
  async freshen(ws: WorkspaceService): Promise<void> {
    const waits: Promise<unknown>[] = [this.attribute(ws)]
    // Each host's records and settings read once for its running sessions' jobs (HI-1790: a dozen agents' jobs each read
    // every record twice, for a card's cost line), by the first of them to run: as current as its own read would be.
    const contexts = new Map<string, () => Promise<ListContext>>()
    const contextOf = (host: string): (() => Promise<ListContext>) => {
      const key = host.toLowerCase()
      let c = contexts.get(key)
      if (!c) {
        let read: Promise<ListContext> | undefined
        c = () => (read ??= Promise.all([ws.sessionsFile(host, runOf(ws)?.signal), ws.projectConfig(host)]).then(([f, cfg]) => ({ records: f.sessions, cfg })))
        contexts.set(key, c)
      }
      return c
    }
    for (const st of sessions.liveStates()) {
      if (st.sessionId && !st.settingUp && workspaceFor(st.projectPath) === ws) waits.push(this.ingest(st.projectPath, st.sessionId, { priority: 1, keepState: 'running', context: contextOf(st.projectPath) }))
    }
    for (const q of [...this.queue, ...(this.current ? [this.current] : [])]) {
      if (q.priority <= 1) waits.push(new Promise((resolve) => q.waiters.push({ resolve, reject: resolve })))
    }
    await Promise.all(waits.map((p) => p.catch(() => undefined)))
  }

  /**
   * Records what a session used before Hive lets its copies or record go (Delete, Clean Up), waiting for nothing else
   * queued: its file, and its kept usage from before the history when it has one (whichever counted more is kept).
   * Resolves whether that's done: true also for a session with nothing to keep (no file, no kept usage); false when its
   * use couldn't be recorded (the delete then keeps it).
   */
  async recordNow(projectPath: string, sessionId: string): Promise<boolean> {
    const ws = workspaceFor(projectPath)
    const rec = (await ws?.sessionsFile(projectPath, ws.lifetime).catch(() => null))?.sessions.find((s) => s.id === sessionId)
    const r = await this.ingest(projectPath, sessionId, { priority: 0, keepState: 'no' })
    if (!r || r.status === 'busy' || r.status === 'failed') return false
    if (rec?.keptUsage) {
      const k = await this.importKept(projectPath, { ...rec, provider: recordProvider(rec), usage: rec.keptUsage }, 0)
      if (!k || k.status === 'busy' || k.status === 'failed') return false
    }
    return true
  }

  /**
   * Records a deleted session's kept usage (deletedUsage) now, before Purge… removes it (#1138): whether it's done (the
   * history then counts it, as much as or more than the kept usage did).
   */
  async recordKept(projectPath: string, k: KeptUsage): Promise<boolean> {
    const r = await this.importKept(projectPath, k, 0)
    return !!r && r.status !== 'busy' && r.status !== 'failed'
  }

  /** The hosts of a workspace whose history counts: its projects, hidden ones too, and the Assistant. */
  private async hosts(ws: WorkspaceService, run: WorkspaceRun): Promise<string[]> {
    const out = [...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))]
    if (!this.live(ws, run)) return []
    if (existsSync(ws.assistantHome)) out.push(ws.assistantHome)
    return out
  }

  /**
   * Whether work begun for a workspace may go on: it is still the one open, in the same opening. `ws.lifetime` read later
   * is the next opening's (close starts a new one), so the run's own is checked (#1379: a backfill that went on after a
   * switch read the closed workspace's sessions and opened its combwork.db again, holding its folder).
   */
  private live(ws: WorkspaceService, run: WorkspaceRun): boolean {
    return !run.signal.aborted && ws.path === run.path && !this.stopped
  }

  /**
   * What changed while Hive wasn't reading it: each record the history doesn't have yet (a session adopted, started
   * before this tick), and each whose file grew (a session continued outside Hive); parser states of sessions unused for
   * two weeks let go.
   */
  private async sweep(ws: WorkspaceService, run = runOf(ws)): Promise<void> {
    if (!run || !this.live(ws, run) || !this.backfilled(run.path)) return
    const file = usageFile(run.path)
    for (const host of await this.hosts(ws, run)) {
      if (!this.live(ws, run)) return
      const { scope } = await ws.sessionScope(host)
      if (!this.live(ws, run)) return
      const known = new Map((await this.call<SessionId[]>({ type: 'ids', file, scope })).map((s) => [s.session, s]))
      if (!this.live(ws, run)) return
      for (const rec of (await ws.sessionsFile(host, run.signal)).sessions) {
        const k = known.get(rec.id)
        if (k?.path) {
          const st = await stat(k.path).catch(() => null)
          if (!st || (st.size === k.size && st.mtimeMs === k.mtime)) continue
        } else if (k) continue
        if (sessions.liveStates().some((s) => s.sessionId === rec.id)) continue
        void this.ingest(host, rec.id, { priority: 2, keepState: 'no', ...(k?.path ? { path: k.path } : {}) }).catch(() => undefined)
      }
    }
    if (!this.live(ws, run)) return
    await this.call({ type: 'forgetStates', file, before: new Date(Date.now() - STATE_DAYS * 86_400_000).toISOString() }).catch(() => undefined)
  }

  /**
   * The backups' housekeeping (#1110), once the history has every session (so totals survive what goes): backups of
   * sessions that ended before compression was done compressed, and old ones let go as Settings → Sessions → Keep
   * transcript backups says. One host at a time, in the background.
   */
  private async housekeep(ws: WorkspaceService, run = runOf(ws)): Promise<void> {
    if (!run || !this.live(ws, run) || !this.backfilled(run.path) || this.housekeeping.has(wsKey(run.path))) return
    const key = wsKey(run.path)
    this.housekeeping.add(key)
    try {
      await this.rollUp(ws, run).catch((e) => log.warn('rolling up the usage history', e))
      for (const host of await this.hosts(ws, run)) {
        if (!this.live(ws, run)) return
        await sessions.compressIdleBackups(host, run.signal).catch((e) => log.warn('compressing backups', e))
        if (!this.live(ws, run)) return
        await sessions.applyRetention(host, run.signal).catch((e) => log.warn('backup retention', e))
      }
    } finally {
      this.housekeeping.delete(key)
    }
  }
  private housekeeping = new Set<string>()

  /** When each open workspace's timelines were last rolled up (rollUp), by its key: let go as it closes. */
  private rolledUp = new Map<string, number>()

  /**
   * Ended sessions' timelines merged into 1-hour steps once Settings → Advanced's days of full detail are past (HI-1648,
   * Darren 27 Oct), in the worker, a batch at a time behind what is queued (each batch a job of its own, so a turn's
   * record never waits for them all), then the space they freed given back (on a file from before, its one whole
   * vacuum first). At a workspace's opening, then about daily. Logged when it merged any.
   */
  private async rollUp(ws: WorkspaceService, run: WorkspaceRun): Promise<void> {
    const key = wsKey(run.path)
    const last = this.rolledUp.get(key)
    if (last !== undefined && Date.now() - last < ROLL_UP_MS) return
    this.rolledUp.set(key, Date.now())
    const file = usageFile(run.path)
    const t0 = Date.now()
    const total = { sessions: 0, rows: 0, merged: 0 }
    for (;;) {
      // The running sessions as the batch goes to the worker, not as it was queued (review round 1: one resumed while it
      // waited behind other jobs, still last active long ago, was merged as it ran).
      const r = await this.enqueue<RollUpResult>(`rollUp|${key}`, 2, async () => (this.live(ws, run) ? { type: 'rollUp', file, live: sessions.liveStates().flatMap((s) => (s.sessionId ? [s.sessionId] : [])) } : null))
      if (!r || !this.live(ws, run)) return
      total.sessions += r.sessions
      total.rows += r.rows
      total.merged += r.merged
      // A batch that tried none has nothing left it may merge (the rest are running).
      if (!r.more || !r.tried) break
    }
    if (total.sessions) log.info(`usage history of ${userText(run.path)}: ${total.sessions} ended session(s) rolled up into 1-hour steps, ${total.rows} timeline rows → ${total.merged}, in ${Date.now() - t0} ms`)
    await this.enqueue(`spaceBack|${key}`, 2, async () => (this.live(ws, run) ? { type: 'spaceBack', file } : null))
  }

  // -------------------------------------------------------------------------
  // The backfill.
  // -------------------------------------------------------------------------

  /** Whether a workspace's existing sessions are all in its history (its backfill is done). */
  backfilled(workspacePath: string): boolean {
    return this.progress.get(wsKey(workspacePath))?.importing === false
  }

  /** A workspace's backfill as it stands (importing: under way, with how many sessions are done of how many). */
  progressOf(workspacePath: string): UsageHistoryProgress {
    return this.progress.get(wsKey(workspacePath)) ?? { importing: true, done: 0, total: 0 }
  }

  private setProgress(workspacePath: string, p: UsageHistoryProgress): void {
    this.progress.set(wsKey(workspacePath), p)
    emit({ type: 'usage-history', workspacePath, progress: p })
  }

  /**
   * A workspace opened: its backfill runs if it hasn't been done (once; a later open, or the ten-minute tick after one
   * that couldn't finish, carries on with what is left).
   */
  opened(ws: WorkspaceService): Promise<void> {
    const opening = runOf(ws)
    if (!opening) return Promise.resolve()
    const { path } = opening
    const key = wsKey(path)
    let run = this.backfills.get(key)
    if (!run) {
      run = this.backfill(ws, opening)
        // Then what changed since it was last open (a session continued outside Hive, one that ended as Hive quit; a card
        // moved meanwhile, by another Hive or a script). Only while this opening lasts: not the next workspace's.
        .then(() => this.sweep(ws, opening))
        .then(() => this.attribute(ws, opening))
        .then(() => this.housekeep(ws, opening))
        .catch((e) => log.warn(`importing the usage history of ${userText(path)}`, e))
        .finally(() => this.backfills.delete(key))
      this.backfills.set(key, run)
    }
    return run
  }

  /**
   * The one-time import of a workspace's sessions (Darren's decision 3): each record's transcript (or Hive's backup of
   * it) read in the worker, newest first, so recent periods fill first; a record's kept usage (a backup can lag what was
   * kept: whichever counted more stays); each deleted session's kept usage. Nothing already counted is lost: what
   * keptUsage and deletedUsage held is imported, and stays where it was. Only when every session was imported is it
   * recorded as done (usage_meta) and usage-cache.json retired (decision 6): one that failed (the worker ended, a file
   * that can't be read, a write another Hive held) leaves it not done, and it runs again (what was imported is skipped)
   * at the next open or ten-minute tick, the Overview saying meanwhile that its figures are partial; so does an
   * interruption (Hive quit, the workspace closed).
   */
  private async backfill(ws: WorkspaceService, opening: WorkspaceRun): Promise<void> {
    const { path } = opening
    const file = usageFile(path)
    const done = await this.call<string | null>({ type: 'meta', file, scope: '', key: 'backfill' })
    if (!this.live(ws, opening)) return
    if (done) {
      this.setProgress(path, { importing: false, done: 0, total: 0 })
      return
    }
    /** Whether a job did what it was for (null: the workspace closed meanwhile). */
    const ok = (r: IngestResult | null): boolean => !!r && r.status !== 'busy' && r.status !== 'failed'
    type Item = { at: string; run: () => Promise<boolean> }
    const items: Item[] = []
    for (const host of await this.hosts(ws, opening)) {
      if (!this.live(ws, opening)) return
      const f = await ws.sessionsFile(host, opening.signal)
      for (const rec of f.sessions) {
        items.push({
          at: rec.lastActiveAt ?? rec.createdAt ?? '',
          run: async () => {
            if (!ok(await this.ingest(host, rec.id, { priority: 2, keepState: 'no' }))) return false
            return !rec.keptUsage || ok(await this.importKept(host, { ...rec, provider: recordProvider(rec), usage: rec.keptUsage }))
          }
        })
      }
      for (const k of f.deletedUsage ?? []) items.push({ at: k.usage.lastActivity ?? '', run: async () => ok(await this.importKept(host, k)) })
    }
    items.sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0))
    const total = items.length
    log.info(`importing the usage history of ${userText(path)}: ${total} session(s)`)
    const t0 = Date.now()
    let n = 0
    let failed = 0
    let told = 0
    this.setProgress(path, { importing: true, done: 0, total })
    for (const it of items) {
      if (!this.live(ws, opening)) return
      const good = await it.run().catch((e) => {
        log.warn('importing a session into the usage history', e)
        return false
      })
      if (!good) failed++
      n++
      // Told at most every half second, and at the end.
      if (Date.now() - told > 500) {
        told = Date.now()
        this.setProgress(path, { importing: true, done: n, total })
      }
    }
    if (failed || !this.live(ws, opening)) {
      log.warn(`the usage history of ${userText(path)}: ${failed} of ${total} session(s) not imported; tried again at the next open or in ten minutes`)
      this.setProgress(path, { importing: true, done: n - failed, total })
      return
    }
    await this.call({ type: 'meta', file, scope: '', key: 'backfill', value: JSON.stringify({ at: new Date().toISOString(), sessions: total, hiveVersion: appVersion() }) })
    log.info(`imported the usage history of ${userText(path)}: ${total} session(s) in ${Date.now() - t0} ms`)
    this.setProgress(path, { importing: false, done: total, total })
    await sessions.retireUsageCacheFile().catch((e) => log.warn('removing usage-cache.json', e))
  }

  /**
   * A workspace closed: its file closed after what was queued for it, as each was sent, by the place its window
   * recorded (#1456: never what a spelling resolves to now, so the window's own spelling, a junction pointed at another
   * workspace since, closes nothing of that one's).
   */
  private closeWorkspace(path: string, place: string): void {
    this.cards.delete(wsKey(path))
    this.rolledUp.delete(wsKey(path))
    this.progress.delete(wsKey(path))
    this.closeAt(place)
  }

  // -------------------------------------------------------------------------
  // Reading.
  // -------------------------------------------------------------------------

  /**
   * What a transcript used so far, read in the worker (#1147), never in main: a running session's (its footer and context
   * gauge, its cost, the Agent API's), or one the history doesn't have yet. Not queued: the worker reads it at once, from
   * where its last read of the file stopped, or from the session's saved state when it hasn't read it in this run (a
   * resume after a restart reads only what was added since). `projectPath`: the session's host, whose history has that
   * state. Null when it can't be read, or once Hive is quitting.
   */
  async read(projectPath: string, path: string, sessionId: string, provider: ProviderId, o: { noWait?: boolean; reportsIgnored?: boolean } = {}): Promise<ReadResult | null> {
    if (this.stopped) return null
    let seed: ReadSeed | null = null
    const ws = workspaceFor(projectPath)
    if (ws?.path) {
      const scope = await ws.sessionScope(projectPath).catch(() => null)
      if (scope) seed = { file: usageFile(scope.workspace), scope: scope.scope }
    }
    return this.call<ReadResult | null>({ type: 'read', path, session: sessionId, provider, seed, ...(o.noWait ? { noWait: true } : {}), ...(o.reportsIgnored ? { reportsIgnored: true } : {}) })
  }

  /** Forgets what the worker read in this run (Settings → Sessions → Clear): each transcript is read again when asked for. */
  async forgetReads(): Promise<void> {
    if (!this.stopped) await this.call({ type: 'forgetReads' })
  }

  /** The history's sessions of some hosts of a workspace (by scope), with their rows. */
  async storedSessions(workspacePath: string, scopes: string[] | null): Promise<StoredSession[]> {
    return this.call<StoredSession[]>({ type: 'sessions', file: usageFile(workspacePath), scopes })
  }

  /** A host's sessions in the history, each priced now, by id. */
  async storedUsage(projectPath: string): Promise<Map<string, StoredUsage>> {
    const ws = workspaceFor(projectPath)
    if (!ws?.path) return new Map()
    const { workspace, scope } = await ws.sessionScope(projectPath)
    const settings = config.settings
    return new Map((await this.storedSessions(workspace, [scope])).map((s) => [s.session, { meta: s, source: s.source, read: { path: s.path, size: s.size, mtime: s.mtime }, usage: usageFromRows(s.summary, s.rows, settings) }]))
  }

  /** The rows on some cards, with whose session each is. */
  cardRows(workspacePath: string, cards: number[]): Promise<(SessionMeta & { row: StoredSession['rows'][number] })[]> {
    return this.call({ type: 'cards', file: usageFile(workspacePath), cards })
  }

  /** Whose a host's sessions in the history are, without their usage (cost per card: whether a hold's agent has any, HI-1748). */
  async sessionsWho(projectPath: string): Promise<SessionWho[]> {
    const ws = workspaceFor(projectPath)
    if (!ws?.path) return []
    const { workspace, scope } = await ws.sessionScope(projectPath)
    return (await this.call<SessionId[]>({ type: 'ids', file: usageFile(workspace), scope })).map((s) => ({ ...(s.agentId ? { agentId: s.agentId } : {}), ...(s.agentName ? { agentName: s.agentName } : {}) }))
  }

  /**
   * A host's sessions with their timelines (a lane's cost); only `only`'s when given (HI-1906: a card's, from its ledger
   * rows), each by its scope and session, so a session of another host with the same id is never taken.
   */
  async timelines(projectPath: string, only?: { scope: string; session: string }[]): Promise<(SessionMeta & { summary: UsageSummary; timeline: import('../shared/usageTimeline').UsageTimeline | null; firstActivity: string | null; lastActivity: string | null })[]> {
    const ws = workspaceFor(projectPath)
    if (!ws?.path) return []
    const { workspace, scope } = await ws.sessionScope(projectPath)
    const ids = only ? [...new Set(only.filter((s) => s.scope === scope).map((s) => s.session))] : undefined
    return this.call({ type: 'timelines', file: usageFile(workspace), scope, ...(ids ? { sessions: ids } : {}) })
  }
}

/** Who a session was, from its record. */
const metaOf = (scope: string, rec: SessionRecord): SessionMeta => ({
  scope,
  session: rec.id,
  provider: recordProvider(rec),
  ...(rec.agentId ? { agentId: rec.agentId } : {}),
  ...(rec.agentName ? { agentName: rec.agentName } : {}),
  ...(rec.name ? { name: rec.name } : {}),
  ...(rec.cwd ? { cwd: rec.cwd } : {})
})

/** Transcripts whose results the worker keeps (Settings → Sessions → Usage cache size). */
const usageCacheSize = (): number => Math.min(50000, Math.max(100, Number(config.settings.sessions.usageCacheSize) || 5000))

const appVersion = (): string => {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

/** The worker's script, beside main's (inside the asar: a worker thread loads it, and its packages, from there). */
const workerScript = (): string => join(__dirname, 'usage-worker.js')

export const usageHistory = new UsageHistory()
