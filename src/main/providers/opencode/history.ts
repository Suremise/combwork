import { Worker } from 'worker_threads'
import { join } from 'path'
import { existsSync } from 'original-fs'
import { mkdir, readFile, writeFile } from 'original-fs/promises'
import type { PlanUsage } from '../../../shared/types'
import { advanced } from '../../advanced'
import { createLogger, userText } from '../../logger'
import { bundledScriptExists, workerHere, workerStarted } from '../../workerThreads'
import type { CoreEvent, CoreReply, CoreRequest, CommandSpec } from './historyCore'
import { mirrorDir, mirrorPath } from './historyCore'
import { placeholderMirror } from './mirror'
import { serverInfoPath } from './launcher'

const log = createLogger('opencodeHistory')

// The OpenCode history's main side (HI-2762, design s7/s10/s13). Main never reads a session itself: it tells the worker
// (historyCore, in opencodeHistoryWorker.ts) what runs, which server each has, when to read, and when a run ended, and
// passes on what the worker says (a published mirror, a limits reading). Per run: the server's password (kept from the
// launch's preparation, never written) and address (the launcher's opencode-server.json, written once its server is
// ready); a poll every opencode.history.pollSeconds while it runs; at its end, an export of its session. Across runs: a
// repair pass a minute after start, every opencode.history.repairMinutes and after each run's end.

type Body = CoreRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

/** Where Combwork's other parts take what the history finds for a run (set at startup: opencodeHistoryHost). */
export interface HistorySink {
  /** A run's plan limits as its server reported them (null: its account has none: clear its connection's). */
  limits(runId: string, usage: PlanUsage | null): void
  /** A run's session cost now, live (`at`: when it was so, ms): shown until a newer reading. */
  cost(runId: string, costUsd: number): void
  /** The OpenCode executable to export with, or null when none is found. */
  executable(): string | null
  /** The roots repair looks at: each OpenCode account's, Combwork's own. */
  homes(): string[]
  /** The protected command for `opencode <args>` on a root (install.ts opencodeCommand). */
  command(executable: string, args: string[], home: string): Promise<CommandSpec>
}

interface Tracked {
  runId: string
  home: string
  sessionId: string
  privateDir: string
  password: string
  server: boolean
  /** The server's address, once known (given again to a restarted worker). */
  url: string | null
  poll: ReturnType<typeof setInterval> | null
  /** When its limits were last read (ms): at most once a minute. */
  limitsAt: number
  /** The newest live cost's time (ms): an older reading never replaces it. */
  costAt: number
  epoch: number
}

class HistoryThread {
  private worker: Worker | null = null
  private inProcess: ((m: CoreRequest) => Promise<unknown>) | null = null
  private calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private next = 0
  onEvent: (e: CoreEvent) => void = () => undefined
  /** Told when a worker ended: its next requests go to a new one, which knows nothing of the old one's runs. */
  onGone: () => void = () => undefined

  async ask(body: Body, timeoutMs = 0): Promise<unknown> {
    const send = await this.transport()
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => (this.calls.delete(id), reject(new Error(`the OpenCode history's worker didn't answer ${body.type} in ${timeoutMs} ms`))), timeoutMs) : null // i18n-ignore: an internal error, for the log
      this.calls.set(id, {
        resolve: (v) => (timer && clearTimeout(timer), resolve(v)),
        reject: (e) => (timer && clearTimeout(timer), reject(e))
      })
      send({ ...body, id } as CoreRequest)
    })
  }

  private async transport(): Promise<(m: CoreRequest) => void> {
    if (this.worker) return (m) => this.worker!.postMessage(m)
    if (!this.inProcess && (scriptForTests === 'in-process' || !bundledScriptExists(workerScript()))) {
      if (scriptForTests !== 'in-process') workerHere('OpenCode history', "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
      const { HistoryCore } = await import('./historyCore')
      const core = new HistoryCore((e) => this.reply(e))
      this.inProcess = (m) => core.handle(m)
    }
    if (this.inProcess) {
      const run = this.inProcess
      return (m) =>
        void run(m).then(
          (value) => this.reply({ id: m.id, ok: true, value: value ?? null }),
          (e: unknown) => this.reply({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
        )
    }
    const w = new Worker(workerScript())
    this.worker = w
    workerStarted('OpenCode history', w) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
    w.on('message', (r: CoreReply) => this.reply(r))
    const gone = (why: string): void => {
      if (this.worker !== w) return
      this.worker = null
      log.warn(`the OpenCode history's worker ended (${why}); it starts again with the next request`)
      for (const c of this.calls.values()) c.reject(new Error(`The OpenCode history's worker ended (${why})`)) // i18n-ignore: an internal error, for the log
      this.calls.clear()
      this.onGone()
    }
    w.on('error', (e: Error) => gone(e.message))
    w.on('exit', (code) => gone(`exit code ${code}`)) // i18n-ignore: for the log
    w.unref()
    return (m) => w.postMessage(m)
  }

  private reply(r: CoreReply): void {
    if ('event' in r) return this.onEvent(r)
    const c = this.calls.get(r.id)
    if (!c) return
    this.calls.delete(r.id)
    if (r.ok) c.resolve(r.value)
    else c.reject(new Error(r.error))
  }

  async stop(): Promise<void> {
    const w = this.worker
    if (w) {
      await this.ask({ type: 'shutdown' }, 2000).catch(() => undefined)
      this.worker = null
      await w.terminate().catch(() => undefined)
    } else if (this.inProcess) await this.ask({ type: 'shutdown' }).catch(() => undefined)
    this.inProcess = null
  }
}

let scriptForTests: string | null = null
const workerScript = (): string => (scriptForTests && scriptForTests !== 'in-process' ? scriptForTests : join(__dirname, 'opencode-history-worker.js'))

export class OpencodeHistory {
  private thread = new HistoryThread()
  private runs = new Map<string, Tracked>()
  private sink: HistorySink | null = null
  private repairTimer: ReturnType<typeof setInterval> | null = null
  private firstRepair: ReturnType<typeof setTimeout> | null = null
  /** Sessions a first-read export was queued for, this process: once each until its state changes. */
  private asked = new Set<string>()

  /** Roots whose removal the worker acknowledged (and not taken back): a restarted worker is told again first. */
  private removedHomes = new Set<string>()

  constructor() {
    this.thread.onEvent = (e) => this.onEvent(e)
    this.thread.onGone = () => void this.restore()
  }

  /**
   * A new worker after the last one ended (HR1 on HI-2762): told the removed roots first, then each live run again (a new
   * epoch, so nothing of the old one counts) and its server, before any poll's request; its limits read again. A run it
   * can't take is left to its own end (its polls then do nothing), and said in the log.
   */
  private async restore(): Promise<void> {
    for (const h of this.removedHomes) await this.thread.ask({ type: 'removeRoot', home: h }, 5000).catch(() => undefined)
    for (const t of [...this.runs.values()]) {
      try {
        t.epoch = (await this.thread.ask({ type: 'begin', home: t.home, sessionId: t.sessionId, runId: t.runId }, 5000)) as number
        if (t.server && t.url) await this.thread.ask({ type: 'server', runId: t.runId, url: t.url, password: t.password }, 5000)
        if (t.server) {
          void this.thread.ask({ type: 'refresh', runId: t.runId, force: true }).catch(() => undefined)
          this.readLimits(t, true)
        }
      } catch (e) {
        log.warn(`an OpenCode session's history couldn't be taken up again by a new worker: ${userText(String(e))}`)
      }
    }
  }

  /** Connects the sink and starts the repair pass (once, at startup). */
  start(sink: HistorySink): void {
    this.sink = sink
    if (this.firstRepair || this.repairTimer) return
    this.firstRepair = setTimeout(() => void this.repair(), 60_000)
    this.firstRepair.unref?.()
    const every = Math.max(1, advanced.number('opencode.history.repairMinutes')) * 60_000
    this.repairTimer = setInterval(() => void this.repair(), every)
    this.repairTimer.unref?.()
    void this.thread.ask({ type: 'bounds', bounds: { repairHours: advanced.number('opencode.history.retryMinutes') / 60 } }).catch(() => undefined)
  }

  /**
   * A run starts on a session (prepareLaunch): its ownership taken in the worker, answered before the launch goes on,
   * so no older work on the session publishes after it (design s13 §2). Throws when the worker doesn't answer in time.
   */
  async begin(home: string, sessionId: string, runId: string): Promise<void> {
    const epoch = (await this.thread.ask({ type: 'begin', home, sessionId, runId }, 5000)) as number
    this.runs.set(runId, { runId, home, sessionId, privateDir: '', password: '', server: false, url: null, poll: null, limitsAt: 0, costAt: 0, epoch })
  }

  /** The run's server password and private folder (buildCommand): its poll starts, reading the server once it is up. */
  track(runId: string, privateDir: string, password: string): void {
    const t = this.runs.get(runId)
    if (!t) return
    t.privateDir = privateDir
    t.password = password
    const every = Math.max(1, advanced.number('opencode.history.pollSeconds')) * 1000
    t.poll = setInterval(() => void this.poll(t), every)
    t.poll.unref?.()
  }

  private async poll(t: Tracked): Promise<void> {
    if (this.runs.get(t.runId) !== t) return
    if (!t.server) {
      const info = await readFile(serverInfoPath(t.privateDir), 'utf8').then((s) => JSON.parse(s) as { url?: unknown; sessionId?: unknown }, () => null)
      if (!info || typeof info.url !== 'string' || this.runs.get(t.runId) !== t) return
      if (typeof info.sessionId === 'string' && info.sessionId !== t.sessionId) return
      await this.thread.ask({ type: 'server', runId: t.runId, url: info.url, password: t.password }).catch(() => undefined)
      t.server = true
      t.url = info.url
      void this.thread.ask({ type: 'refresh', runId: t.runId, force: true }).catch(() => undefined)
      this.readLimits(t, true)
      return
    }
    void this.thread.ask({ type: 'refresh', runId: t.runId }).catch(() => undefined)
  }

  /**
   * Something happened in a run's session (HI-2760's forwarded events, through prepareHook): a turn's end, a resync,
   * or OpenCode's running usage (`cost`, `at`: when, ms). A turn's end or a resync reads the session now.
   */
  nudge(sessionId: string, what: { kind: 'turnEnd' | 'resync' } | { kind: 'usage'; cost: number; at: number }): void {
    const t = [...this.runs.values()].find((r) => r.sessionId === sessionId && r.server)
    if (!t) return
    if (what.kind === 'usage') return this.liveCost(t, what.cost, what.at)
    void this.thread.ask({ type: 'refresh', runId: t.runId, force: true }).catch(() => undefined)
    if (what.kind === 'turnEnd') this.readLimits(t, false)
  }

  private liveCost(t: Tracked, cost: number, at: number): void {
    if (!Number.isFinite(cost) || cost < 0 || at <= t.costAt) return
    t.costAt = at
    this.sink?.cost(t.runId, cost)
  }

  private readLimits(t: Tracked, now: boolean): void {
    if (!now && Date.now() - t.limitsAt < 60_000) return
    t.limitsAt = Date.now()
    void this.thread.ask({ type: 'limits', runId: t.runId }).catch(() => undefined)
  }

  /** A run ended (sessions.onLaunchEnded): its poll stops, its ownership ends, its session is exported once. */
  async ended(runId: string): Promise<void> {
    const t = this.runs.get(runId)
    if (!t) return
    this.runs.delete(runId)
    if (t.poll) clearInterval(t.poll)
    await this.thread.ask({ type: 'end', runId }).catch(() => undefined)
    await this.exportSession(t.home, t.sessionId, 'runEnd')
    void this.repair([t.home])
  }

  private async exportSession(home: string, sessionId: string, reason: 'runEnd' | 'repair'): Promise<void> {
    const exe = this.sink?.executable()
    if (!exe || !this.sink) return
    const command = await this.sink.command(exe, ['session', 'export', sessionId], home).catch(() => null)
    if (!command) return
    await this.thread.ask({ type: 'export', home, sessionId, command, reason }).catch((e) => log.warn(`an OpenCode session's export couldn't be queued: ${userText(String(e))}`))
  }

  /**
   * The mirror's path for a session Combwork made (its mark exists): stable from the first answer (design s13 §1), so a
   * placeholder is made when there is none, and, with no live run, a first-read export is queued (once a process).
   */
  async mirrorFor(home: string, sessionId: string): Promise<string> {
    const p = mirrorPath(home, sessionId)
    if (!existsSync(p)) {
      await mkdir(mirrorDir(home), { recursive: true })
      await writeFile(p, placeholderMirror(), { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e
      })
      const k = `${home.toLowerCase()}|${sessionId}`
      const live = [...this.runs.values()].some((r) => r.sessionId === sessionId && r.home.toLowerCase() === home.toLowerCase())
      if (!live && !this.asked.has(k)) {
        this.asked.add(k)
        if (this.asked.size > 1000) this.asked.clear()
        void this.exportSession(home, sessionId, 'repair')
      }
    }
    return p
  }

  /** The repair pass: the worker lists the mirrors that need an export, eligible now; each is queued (design s13 §1). */
  async repair(homes?: string[]): Promise<void> {
    const sink = this.sink
    if (!sink) return
    const roots = (homes ?? sink.homes()).filter((h) => existsSync(mirrorDir(h)))
    if (!roots.length) return
    const found = (await this.thread.ask({ type: 'repairScan', homes: roots }).catch(() => [])) as { home: string; sessionId: string }[]
    for (const c of found) await this.exportSession(c.home, c.sessionId, 'repair')
  }

  /**
   * An account's folder is going (accounts.onAccountRemoving): the worker answers once nothing of its own writes into the
   * folder (its exports there ended), within 5 s, else this throws and the removal is refused. Resolves with how to take
   * it back (a removal refused later).
   */
  async removeRoot(home: string): Promise<() => void> {
    await this.thread.ask({ type: 'removeRoot', home }, 5000)
    const h = home.toLowerCase()
    this.removedHomes.add(h)
    for (const t of [...this.runs.values()])
      if (t.home.toLowerCase() === h) {
        if (t.poll) clearInterval(t.poll)
        this.runs.delete(t.runId)
      }
    return () => {
      this.removedHomes.delete(h)
      void this.thread.ask({ type: 'restoreRoot', home }).catch(() => undefined)
    }
  }

  private onEvent(e: CoreEvent): void {
    if (e.event === 'log') return void (e.level === 'warn' ? log.warn(e.text) : log.info(e.text))
    if (e.event === 'published') {
      // A newer reading of the session's cost than any live one shown takes over.
      const t = [...this.runs.values()].find((r) => r.sessionId === e.sessionId && r.home.toLowerCase() === e.home.toLowerCase())
      if (t && typeof e.cost === 'number') this.liveCost(t, e.cost, e.updated)
      return
    }
    // A limits reading: only its run's, while that run is the session's current one (a late answer is dropped, never a clear).
    const t = this.runs.get(e.runId)
    if (!t || t.epoch !== e.epoch) return
    if (e.reading.kind === 'report') this.sink?.limits(e.runId, e.reading.usage)
    else if (e.reading.kind === 'none') this.sink?.limits(e.runId, null)
  }

  /** Quitting: polls stop, the worker drops its queue, ends its exports and ends. */
  async stop(): Promise<void> {
    for (const t of this.runs.values()) if (t.poll) clearInterval(t.poll)
    this.runs.clear()
    if (this.repairTimer) clearInterval(this.repairTimer)
    if (this.firstRepair) clearTimeout(this.firstRepair)
    this.repairTimer = null
    this.firstRepair = null
    await this.thread.stop()
  }

  /** Tests: waits until the worker has nothing queued or running. */
  async idle(): Promise<void> {
    await this.thread.ask({ type: 'idle' })
  }

  /** Tests: a request straight to the worker. */
  ask(body: Body): Promise<unknown> {
    return this.thread.ask(body)
  }
}

export let opencodeHistory = new OpencodeHistory()

/** Tests: the worker from this script (a build of opencodeHistoryWorker.ts), 'in-process', or null for the default; a new history. */
export async function historyWorkerForTests(script: string | null): Promise<OpencodeHistory> {
  await opencodeHistory.stop()
  scriptForTests = script
  opencodeHistory = new OpencodeHistory()
  return opencodeHistory
}
