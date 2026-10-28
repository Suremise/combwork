import { homedir } from 'os'
import { join } from 'path'
import { Worker } from 'worker_threads'
import type { RetryWait } from '../../../shared/types'
import type { LogAnswer, LogReply, LogRequest, LogRow, NoRow } from '../../codexLogWorker'
import { advanced } from '../../advanced'
import { createLogger, userText } from '../../logger'
import { bundledScriptExists, workerHere, workerStarted } from '../../workerThreads'

const log = createLogger('codexLog')

/**
 * Codex waiting to retry its model request (HI-1972). Codex 0.164.0 shows nothing of it (its screen says "Working", its
 * rollout and hooks are silent): its only record is a row in its log database, `logs_2.sqlite` in its CODEX_HOME,
 * `target` codex_core::responses_retry, `thread_id` the conversation, its message "stream disconnected - retrying
 * sampling request (1/5 in 399.9997619s)... last status: 429 Too Many Requests". Hive reads the newest such row of a
 * session's turn there, read-only, in a worker of its own (codexLogWorker.ts: main's thread never waits on that file);
 * the row's target and the message's pattern are Settings → Advanced's (codex.retry.*), so a Codex that words it
 * otherwise can be followed without a release.
 */

/** How long a read may take before it counts as none (and as a miss: two in a row start the worker again). */
export const DEADLINE_MS = 3000
/** Reads under way at most, across sessions: past it a session's look is skipped this time. */
export const MAX_PENDING = 8
const MISSES_TO_RESTART = 2
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
  private calls = new Map<number, (a: Lookup) => void>()
  private next = 0
  private misses = 0

  constructor(private readonly given: Transport | null = null) {}

  /** Reads under way. */
  get pending(): number {
    return this.calls.size
  }

  ask(body: Omit<LogRequest, 'id'>): Promise<Lookup> {
    if (this.calls.size >= MAX_PENDING) return Promise.resolve({ row: null, why: 'full' })
    const id = ++this.next
    const m = { ...body, id }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.calls.delete(id)) return
        resolve({ row: null, why: 'deadline' })
        if (++this.misses >= MISSES_TO_RESTART) this.restart('missed its deadline twice') // i18n-ignore: for the log
      }, DEADLINE_MS)
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

  private answer(id: number, a: Lookup): void {
    const done = this.calls.get(id)
    if (!done) return
    this.calls.delete(id)
    if (a.why !== 'deadline') this.misses = 0
    done(a)
  }

  private send(m: LogRequest): void {
    const run = this.given ?? this.here
    if (run) {
      void run(m).then(
        (a) => this.answer(m.id, a),
        (e: unknown) => this.answer(m.id, { row: null, why: 'error', detail: e instanceof Error ? e.message : String(e) })
      )
      return
    }
    if (!this.worker) {
      if (!bundledScriptExists(workerScript())) {
        workerHere("Codex's log", "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
        // Unit tests and an unbuilt run: the worker's code on this thread.
        this.here = async (r) => (await import('../../codexLogWorker')).handleRequest(r)
        return this.send(m)
      }
      this.start()
    }
    this.worker!.postMessage(m)
  }

  private start(): void {
    const w = new Worker(workerScript())
    this.worker = w
    workerStarted("Codex's log", w) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
    w.on('message', (r: LogReply) => this.answer(r.id, r.answer))
    const gone = (why: string): void => {
      if (this.worker !== w) return
      this.worker = null
      log.warn(`Codex's log's worker ended (${why}); it starts again with the next read`)
      for (const id of [...this.calls.keys()]) this.answer(id, { row: null, why: 'ended', detail: why })
    }
    w.on('error', (e: Error) => gone(e.message))
    w.on('exit', (code) => gone(`exit code ${code}`)) // i18n-ignore: for the log
    w.unref()
  }

  /** Ends a worker that stopped answering: its reads under way are answered none, and the next read starts another. */
  private restart(why: string): void {
    this.misses = 0
    const w = this.worker
    if (!w) return
    this.worker = null
    log.warn(`Codex's log's worker ${why}: ended, to start again with the next read`)
    for (const id of [...this.calls.keys()]) this.answer(id, { row: null, why: 'ended', detail: why })
    void w.terminate().catch(() => undefined)
  }

  /** Ends the worker (tests). */
  async stop(): Promise<void> {
    const w = this.worker
    this.worker = null
    for (const id of [...this.calls.keys()]) this.answer(id, { row: null, why: 'ended' })
    await w?.terminate()
  }
}

let thread = new LogThread()

/**
 * Tests: reads go through `transport` (null: the worker, or its code here when it isn't built), or the worker from
 * `script` (a build of codexLogWorker.ts); a new thread either way, the old one ended.
 */
export async function useCodexLogTransport(transport: Transport | null, script: string | null = null): Promise<void> {
  await thread.stop()
  scriptForTests = script
  thread = new LogThread(transport)
  noted.clear()
}

/** Reads under way (tests). */
export const pendingReads = (): number => thread.pending

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

/** Codex's newest wait to retry in conversation `sessionId` since `since` (ms), or null (none, or Hive can't tell). */
export async function codexRetryWait(q: { sessionId: string; env: NodeJS.ProcessEnv; since: number }): Promise<RetryWait | null> {
  const home = codexHomeOf(q.env)
  const got = await thread.ask({ file: join(home, 'logs_2.sqlite'), thread: q.sessionId, target: advanced.get<string>('codex.retry.logTarget'), sinceSec: Math.floor(q.since / 1000) })
  if (got.why) noteOnce(home, got.why, got.detail)
  if (!got.row) return null
  const wait = parseRetry(got.row, advanced.pattern('codex.retry.pattern'), q.since)
  if (!wait) noteOnce(home, 'error', `a row it couldn't read: ${got.row.body.slice(-160)}`)
  return wait
}
