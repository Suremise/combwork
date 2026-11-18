import { homedir } from 'os'
import { join } from 'path'
import { Worker } from 'worker_threads'
import type { RetryWait } from '../../../shared/types'
import type { LogAnswer, LogReply, LogRequest, LogRow, NoRow } from './threads/logWorker'
import { advanced } from '../../advanced'
import { createLogger, userText } from '../../logger'
import { bundledScriptExists, workerHere, workerStarted } from '../../workerThreads'

const log = createLogger('codexLog')

/**
 * Codex waiting to retry its model request (HI-1972). Codex 0.164.0 shows nothing of it (its screen says "Working", its
 * rollout and hooks are silent): its only record is a row in its log database, `logs_2.sqlite` in its CODEX_HOME,
 * `target` codex_core::responses_retry, `thread_id` the conversation, its message "stream disconnected - retrying
 * sampling request (1/5 in 399.9997619s)... last status: 429 Too Many Requests". Combwork reads the newest such row of a
 * session's turn there, read-only, in a worker of its own (threads/logWorker.ts: main's thread never waits on that file);
 * the row's target and the message's pattern are Settings → Advanced's (codex.retry.*), so a Codex that words it
 * otherwise can be followed without a release.
 */

/**
 * The reads' bounds (HI-3376), changeable by tests: a read unanswered after `deadlineMs` counts as none for its caller
 * (a disk read can take seconds on a slow disk; the worker isn't faulted for it); the worker is started again only
 * when it has answered nothing for `unresponsiveMs` since its oldest read still unanswered (a reply, late or not,
 * shows it is working).
 */
export const logLimits = { deadlineMs: 15_000, unresponsiveMs: 60_000 }
/** The callers' deadline, as it is by default. */
export const DEADLINE_MS = logLimits.deadlineMs
/** Reads under way at most, across sessions: past it a session's look is skipped this time. */
export const MAX_PENDING = 8
/** Reads sent to a worker and not yet answered by it at most (callers that gave up included): past it, none are sent. */
export const MAX_OUTSTANDING = 64
/** A reason a home has no answer is logged at most this often. */
const NOTE_EVERY_MS = 60 * 60_000

/** Why a read had no row: the worker's reasons, or main's (past the deadline, too many under way, the worker ended). */
export type NoAnswer = NoRow | 'deadline' | 'full' | 'ended'
export type Lookup = { row: LogRow | null; why?: NoAnswer; detail?: string }

type Transport = (m: LogRequest) => Promise<LogAnswer>

/** The worker's script, beside main's (as the other workers'). */
let scriptForTests: string | null = null
const workerScript = (): string => scriptForTests ?? join(__dirname, 'codex-log-worker.js')

/** The log's worker, started with the first read; in unit tests (no build) its code runs here, or a test's transport. */
class LogThread {
  private worker: Worker | null = null
  private here: Transport | null = null
  /** The callers waiting, each for one read (at most MAX_PENDING): a caller past its deadline is gone from here. */
  private calls = new Map<number, (a: Lookup) => void>()
  private next = 0
  /**
   * HI-3376: the transport's own bookkeeping, apart from the callers: each read sent to this generation of the worker
   * and not answered by it yet (when it was sent), and when it last answered anything. A new generation (the worker
   * started again) starts both afresh, and a reply from an older one is ignored.
   */
  private generation = 0
  private outstanding = new Map<number, number>()
  private lastReply = 0
  private watchdog: ReturnType<typeof setTimeout> | null = null
  /** How many times a worker that stopped answering was started again (tests). */
  restarts = 0

  constructor(private readonly given: Transport | null = null) {}

  /** Reads under way. */
  get pending(): number {
    return this.calls.size
  }

  ask(body: Omit<LogRequest, 'id'>): Promise<Lookup> {
    if (this.calls.size >= MAX_PENDING || this.outstanding.size >= MAX_OUTSTANDING) return Promise.resolve({ row: null, why: 'full' })
    const id = ++this.next
    const m = { ...body, id }
    return new Promise((resolve) => {
      // The caller's deadline: none for it, the worker not faulted (its reply may still come, and counts for it).
      const timer = setTimeout(() => {
        if (this.calls.delete(id)) resolve({ row: null, why: 'deadline' })
      }, logLimits.deadlineMs)
      this.calls.set(id, (a) => {
        clearTimeout(timer)
        resolve(a)
      })
      try {
        this.send(m)
      } catch (e) {
        this.answer(id, { row: null, why: 'ended', detail: e instanceof Error ? e.message : String(e) })
      }
    })
  }

  /** The caller's answer, if it still waits. */
  private answer(id: number, a: Lookup): void {
    const done = this.calls.get(id)
    if (!done) return
    this.calls.delete(id)
    done(a)
  }

  /** A reply from generation `gen`: it answers its caller (if still waiting) and, from this generation, shows the worker working. */
  private replied(gen: number, id: number, a: Lookup): void {
    if (gen !== this.generation) return
    this.outstanding.delete(id)
    this.lastReply = Date.now()
    this.arm()
    this.answer(id, a)
  }

  /**
   * The watchdog, while reads are outstanding: due `unresponsiveMs` after the later of the oldest outstanding read's
   * sending and this generation's last reply. None while nothing is outstanding.
   */
  private arm(): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
    if (!this.outstanding.size) return
    const oldest = Math.min(...this.outstanding.values())
    const due = Math.max(oldest, this.lastReply) + logLimits.unresponsiveMs
    this.watchdog = setTimeout(() => {
      this.watchdog = null
      if (Date.now() >= due) this.restart(`answered nothing for ${Math.round(logLimits.unresponsiveMs / 1000)} s`) // i18n-ignore: for the log
      else this.arm()
    }, Math.max(0, due - Date.now()))
    this.watchdog.unref?.()
  }

  private send(m: LogRequest): void {
    const gen = this.generation
    this.outstanding.set(m.id, Date.now())
    if (this.outstanding.size === 1) this.arm()
    const run = this.given ?? this.here
    if (run) {
      void run(m).then(
        (a) => this.replied(gen, m.id, a),
        (e: unknown) => this.replied(gen, m.id, { row: null, why: 'error', detail: e instanceof Error ? e.message : String(e) })
      )
      return
    }
    if (!this.worker) {
      if (!bundledScriptExists(workerScript())) {
        workerHere("Codex's log", "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
        // Unit tests and an unbuilt run: the worker's code on this thread.
        this.here = async (r) => (await import('./threads/logWorker')).handleRequest(r)
        this.outstanding.delete(m.id)
        return this.send(m)
      }
      this.start()
    }
    this.worker!.postMessage(m)
  }

  private start(): void {
    const w = new Worker(workerScript())
    const gen = this.generation
    this.worker = w
    workerStarted("Codex's log", w) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
    w.on('message', (r: LogReply) => this.replied(gen, r.id, r.answer))
    const gone = (why: string): void => {
      if (this.worker !== w) return
      this.worker = null
      log.warn(`Codex's log's worker ended (${why}); it starts again with the next read`)
      this.newGeneration({ row: null, why: 'ended', detail: why })
    }
    w.on('error', (e: Error) => gone(e.message))
    w.on('exit', (code) => gone(`exit code ${code}`)) // i18n-ignore: for the log
    w.unref()
  }

  /** What was sent to this generation is forgotten (its callers answered `a`), the watchdog stopped: the next read is a new generation's. */
  private newGeneration(a: Lookup): void {
    this.generation++
    this.outstanding.clear()
    this.lastReply = 0
    this.arm()
    for (const id of [...this.calls.keys()]) this.answer(id, a)
  }

  /** Ends a worker that stopped answering: its reads under way are answered none, and the next read starts another. */
  private restart(why: string): void {
    this.restarts++
    const w = this.worker
    this.worker = null
    log.warn(`Codex's log's worker ${why}: ended, to start again with the next read`)
    this.newGeneration({ row: null, why: 'ended', detail: why })
    void w?.terminate().catch(() => undefined)
  }

  /** Ends the worker (tests). */
  async stop(): Promise<void> {
    const w = this.worker
    this.worker = null
    this.newGeneration({ row: null, why: 'ended' })
    await w?.terminate()
  }
}

let thread = new LogThread()

/**
 * Tests: reads go through `transport` (null: the worker, or its code here when it isn't built), or the worker from
 * `script` (a build of threads/logWorker.ts); a new thread either way, the old one ended.
 */
export async function useCodexLogTransport(transport: Transport | null, script: string | null = null): Promise<void> {
  await thread.stop()
  scriptForTests = script
  thread = new LogThread(transport)
  noted.clear()
}

/** Reads under way (tests). */
export const pendingReads = (): number => thread.pending
/** How many times the worker was started again for answering nothing (tests). */
export const logWorkerRestarts = (): number => thread.restarts

/** When each home's reason for no answer was last logged. */
const noted = new Map<string, number>()

function noteOnce(home: string, why: NoAnswer, detail?: string): void {
  const key = `${home.toLowerCase()}\n${why}`
  const now = Date.now()
  if (now - (noted.get(key) ?? -Infinity) < NOTE_EVERY_MS) return
  noted.set(key, now)
  log.info(`Codex's log in ${userText(home)} gave no answer (${why}${detail ? `: ${userText(detail)}` : ''}); said once an hour`)
}

/** The CODEX_HOME a launch's Codex uses: its environment's, else ~/.codex. */
export const codexHomeOf = (env: NodeJS.ProcessEnv): string => env.CODEX_HOME || join(homedir(), '.codex')

/** The longest retry wait taken as real: a day. */
const MAX_WAIT_S = 86_400
/** Tries at most: Codex's own is 5. */
const MAX_TRIES = 100
/** How far ahead of this PC's clock a row may be written (Codex's clock is this PC's). */
const AHEAD_MS = 60_000

/**
 * A row's retry wait, read with the pattern's named groups (`attempt`, `max`, `seconds` or `millis`, `status`): null when the row
 * doesn't say one, a number isn't sensible (tries 1 ≤ attempt ≤ max ≤ 100, a wait of at most a day), or it was written
 * before `sinceMs` (an older turn's) or more than a minute after `now`.
 */
export function parseRetry(row: LogRow, pattern: RegExp, sinceMs: number, now = Date.now()): RetryWait | null {
  const g = pattern.exec(row.body)?.groups
  if (!g) return null
  const attempt = Number(g.attempt)
  const max = g.max === undefined ? null : Number(g.max)
  // Rust's Duration as Codex prints it: seconds ("399.9997619s"), or milliseconds under a second ("500ms").
  const seconds = g.seconds !== undefined ? Number(g.seconds) : g.millis !== undefined ? Number(g.millis) / 1000 : null
  const status = g.status === undefined ? null : Number(g.status)
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_TRIES) return null
  if (max !== null && (!Number.isInteger(max) || max < attempt || max > MAX_TRIES)) return null
  if (seconds !== null && (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_WAIT_S)) return null
  if (status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) return null
  const at = row.ts * 1000 + Math.floor(row.nanos / 1e6)
  if (!Number.isFinite(at) || at < sinceMs || at > now + AHEAD_MS) return null
  const iso = new Date(at).toISOString()
  return { at: iso, since: iso, retryAt: seconds === null ? null : new Date(at + Math.round(seconds * 1000)).toISOString(), attempt, max, status }
}

/** Codex's newest wait to retry in conversation `sessionId` since `since` (ms), or null (none, or Combwork can't tell). */
export async function codexRetryWait(q: { sessionId: string; env: NodeJS.ProcessEnv; since: number }): Promise<RetryWait | null> {
  const home = codexHomeOf(q.env)
  const got = await thread.ask({ file: join(home, 'logs_2.sqlite'), thread: q.sessionId, target: advanced.get<string>('codex.retry.logTarget'), sinceSec: Math.floor(q.since / 1000) })
  if (got.why) noteOnce(home, got.why, got.detail)
  if (!got.row) return null
  const wait = parseRetry(got.row, advanced.pattern('codex.retry.pattern'), q.since)
  if (!wait) noteOnce(home, 'error', `a row it couldn't read: ${got.row.body.slice(-160)}`)
  return wait
}
