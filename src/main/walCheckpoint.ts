import { Worker } from 'worker_threads'
import { statSync } from 'original-fs'
import { basename } from 'path'
import { pathToFileURL } from 'url'
import type { DatabaseSync } from 'node:sqlite'
import { createLogger } from './logger'

/**
 * The WAL's checkpoints off main's thread (#1633). SQLite checkpoints a WAL database itself inside whichever COMMIT
 * takes its WAL past `wal_autocheckpoint` pages, on the committing connection's thread: for the board and the journal,
 * main's. A checkpoint copies the WAL into the file and fsyncs it (`synchronous=NORMAL` syncs at checkpoints only): on a
 * copy of a real board, 10–30 ms on an idle disk and 50–110 ms beside a slot's kind of disk load, against 0.1 ms for a
 * commit without one, all of it main's thread waiting. So their writers have it off (`wal_autocheckpoint = 0`), and a
 * worker thread checkpoints them every few seconds (PASSIVE: neither main's reads nor its writes wait for it; again
 * while commits landed during it, so the WAL is whole for the writer's next write, which starts it from its beginning),
 * each time on a connection of its own opened for that checkpoint and closed after it (`mode=rw`: a file gone is never
 * made again).
 *
 * Closing: a database's stop (its close) cancels a checkpoint of it still queued, so the worker never opens it, and one
 * under way stops after its pass; the stop returns once the worker's connection is closed (waiting at most STOP_WAIT_MS),
 * so a caller replacing or deleting the file after a close (Restore the 0.9 Board Backup's sole copy, a journal's
 * deletion) finds no other connection. Each job has a slot in a shared array that both threads change atomically.
 *
 * Bounded: where the worker can't run (it ended more than RESTARTS times), a checkpoint hangs, FAILURES of a database's
 * checkpoints fail in a row, or its WAL holds more than BOUND_FRAMES a checkpoint couldn't copy whole (writes faster
 * than its checkpoints catch up), the writer gets SQLite's own auto-checkpoint back, as before this change, and the log
 * says so; a checkpoint that succeeds with the WAL under the bound takes it off again.
 */

const log = createLogger('db')

/** How often each open database is checkpointed. */
export const CHECKPOINT_EVERY_MS = 5000
/** SQLite's own auto-checkpoint (its default, in pages), given back when the worker can't do it. */
const SQLITE_AUTO = 1000
/** A checkpoint this slow is logged (it held up nothing, but says what the disk was like). */
const SLOW_MS = 250
/** How many times the worker may end before SQLite's own auto-checkpoint takes over for good. */
const RESTARTS = 3
/** Passes of one checkpoint at most: each copies what commits added during the one before. */
const PASSES = 5
/** How long a stop waits for a checkpoint under way to close its connection (main's thread waits: a pass at most). */
const STOP_WAIT_MS = 10_000

/** The bounds, changeable by tests. */
export const checkpointLimits = {
  /** A WAL holding more pages than this, not all copied by a checkpoint: SQLite's own auto-checkpoint takes over. */
  boundFrames: 8 * SQLITE_AUTO,
  /** A checkpoint under way this long has hung: SQLite's own takes over meanwhile. */
  hungMs: 60_000,
  /** This many of a database's checkpoints failing in a row: SQLite's own takes over until one succeeds. */
  failures: 3
}

// A job's slot in the shared array: main makes it QUEUED; the worker RUNNING, or skips one CANCELLED; main asks a
// running one to stop (STOPPING); the worker makes it DONE once its connection is closed; main frees it at the reply.
const FREE = 0
const QUEUED = 1
const RUNNING = 2
const STOPPING = 3
const CANCELLED = 4
const DONE = 5
const SLOTS = 64
/** Past the job slots: tests hold a checkpoint between its passes while this is 1 (HELD says it got there). */
const GATE = SLOTS
const HELD = SLOTS + 1
const ctrl = new Int32Array(new SharedArrayBuffer((SLOTS + 2) * 4))

/** The worker's code (plain JavaScript, so it runs unbuilt in tests as in the app): one checkpoint per request. */
const WORKER_CODE = `
const { DatabaseSync } = require('node:sqlite')
const { parentPort, workerData } = require('worker_threads')
const ctrl = workerData.ctrl
parentPort.on('message', ({ id, url, slot }) => {
  const t = performance.now()
  if (Atomics.compareExchange(ctrl, slot, ${QUEUED}, ${RUNNING}) !== ${QUEUED}) {
    Atomics.store(ctrl, slot, ${DONE})
    Atomics.notify(ctrl, slot)
    parentPort.postMessage({ id, ok: true, skipped: true, ms: 0 })
    return
  }
  const stopping = () => Atomics.load(ctrl, slot) === ${STOPPING}
  let db = null
  try {
    db = new DatabaseSync(new URL(url), { timeout: 0 })
    let r = null
    for (let i = 0; i < ${PASSES}; i++) {
      r = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
      if (Atomics.load(ctrl, ${GATE}) === 1) {
        Atomics.store(ctrl, ${HELD}, 1)
        while (Atomics.load(ctrl, ${GATE}) === 1 && !stopping()) Atomics.wait(ctrl, slot, ${RUNNING}, 10)
      }
      if (r.busy || r.checkpointed >= r.log || stopping()) break
    }
    parentPort.postMessage({ id, ok: true, busy: r.busy, frames: r.log, copied: r.checkpointed, ms: performance.now() - t })
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String((e && e.message) || e), ms: performance.now() - t })
  } finally {
    try { if (db) db.close() } catch {}
    Atomics.store(ctrl, slot, ${DONE})
    Atomics.notify(ctrl, slot)
  }
})
`

interface Reply {
  id: number
  ok: boolean
  skipped?: boolean
  busy?: number
  frames?: number
  copied?: number
  error?: string
  ms: number
}

interface Registered {
  /** Its key in `dbs`. */
  key: number
  file: string
  url: string
  writer: DatabaseSync
  /** SQLite's own auto-checkpoint is on (the fallback). */
  auto: boolean
  /** The checkpoint of it in the worker (its slot, and when it was asked for), else null. */
  job: { slot: number; since: number } | null
  /** Its WAL held more than the bound, not all copied, at its last checkpoint. */
  over: boolean
  /** Its checkpoints that failed in a row. */
  failed: number
}

const dbs = new Map<number, Registered>()
const pending = new Map<number, { r: Registered; slot: number }>()
let nextId = 1
let worker: Worker | null = null
let ended = 0
let timer: ReturnType<typeof setInterval> | null = null

/** Counts, for tests and the log. */
export const checkpointStats = { done: 0, failed: 0, skipped: 0, fallbacks: 0 }

function setAuto(r: Registered, on: boolean, why: string): void {
  if (r.auto === on) return
  try {
    r.writer.exec(`PRAGMA wal_autocheckpoint = ${on ? SQLITE_AUTO : 0}`)
  } catch {
    // Closed meanwhile: it is being stopped.
    return
  }
  r.auto = on
  if (on) checkpointStats.fallbacks++
  log.info(`${basename(r.file)}: ${on ? 'SQLite checkpoints its WAL in commits again' : "its WAL is checkpointed off main's thread"} (${why})`)
}

/** Why SQLite's own auto-checkpoint should be on for `r` now, or null when the worker can do it. */
function fallbackReason(r: Registered, now: number): string | null {
  if (r.job && now - r.job.since > checkpointLimits.hungMs) return 'a checkpoint of it hangs' // i18n-ignore: for the log
  if (r.failed >= checkpointLimits.failures) return `${r.failed} checkpoints of it failed in a row` // i18n-ignore: for the log
  if (r.over) return `its WAL holds more than ${checkpointLimits.boundFrames} pages` // i18n-ignore: for the log
  return null
}

function startWorker(): Worker | null {
  if (worker) return worker
  if (ended > RESTARTS) return null
  const w = new Worker(WORKER_CODE, { eval: true, workerData: { ctrl } })
  worker = w
  w.on('message', (m: Reply) => settle(m))
  const gone = (why: string): void => {
    if (worker !== w) return
    worker = null
    ended++
    log.warn(`the checkpoint worker ended (${why})${ended > RESTARTS ? '; SQLite checkpoints the WALs itself from now on' : ''}`)
    forgetJobs()
    for (const r of dbs.values()) setAuto(r, true, 'the checkpoint worker ended') // i18n-ignore: for the log
  }
  w.on('error', (e: Error) => gone(e.message))
  w.on('exit', (code) => gone(`exit code ${code}`)) // i18n-ignore: for the log
  w.unref()
  return w
}

/** The worker is gone: its jobs with it, their slots free. */
function forgetJobs(): void {
  for (const { r, slot } of pending.values()) {
    r.job = null
    Atomics.store(ctrl, slot, FREE)
  }
  pending.clear()
}

function settle(m: Reply): void {
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  Atomics.store(ctrl, p.slot, FREE)
  const r = p.r
  r.job = null
  if (m.skipped) {
    checkpointStats.skipped++
    return
  }
  if (!m.ok) {
    checkpointStats.failed++
    r.failed++
    log.warn(`checkpointing ${basename(r.file)}'s WAL failed: ${m.error}`)
    // A database still open falls back as soon as its failures reach the bound, not at the next round.
    if (dbs.get(r.key) === r) holdToBounds(r, performance.now())
    return
  }
  checkpointStats.done++
  r.failed = 0
  // A WAL copied whole starts again at the next write, however big it was; one never copied whole only grows.
  r.over = (m.frames ?? 0) > checkpointLimits.boundFrames && (m.copied ?? 0) < (m.frames ?? 0)
  if (m.ms >= SLOW_MS) log.info(`checkpointed ${basename(r.file)}'s WAL off main's thread in ${Math.round(m.ms)} ms (${m.copied} of ${m.frames} pages)`)
  if (dbs.get(r.key) === r) holdToBounds(r, performance.now())
}

/** SQLite's own auto-checkpoint on or off for `r`, as its state says. */
function holdToBounds(r: Registered, now: number): void {
  const why = worker ? fallbackReason(r, now) : 'the checkpoint worker ended' // i18n-ignore: for the log
  if (why) setAuto(r, true, why)
  else setAuto(r, false, 'the worker checkpoints it') // i18n-ignore: for the log
}

const freeSlot = (): number => {
  for (let i = 0; i < SLOTS; i++) if (Atomics.load(ctrl, i) === FREE) return i
  return -1
}

/** One round: each database held to its bounds, and checkpointed by the worker. */
export function checkpointRound(): void {
  const now = performance.now()
  for (const r of dbs.values()) {
    const thread = startWorker()
    holdToBounds(r, now)
    if (!thread || r.job) continue
    const slot = freeSlot()
    if (slot < 0) continue
    const id = nextId++
    Atomics.store(ctrl, slot, QUEUED)
    r.job = { slot, since: now }
    pending.set(id, { r, slot })
    const job: { id: number; url: string; slot: number } = { id, url: r.url, slot }
    // A worker thread's port, not a window's: no target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    thread.postMessage(job)
  }
}

/** Resolves once no checkpoint is under way (tests). */
export async function checkpointsSettled(): Promise<void> {
  while (pending.size) await new Promise((res) => setTimeout(res, 10))
}

/**
 * Ends `r`'s checkpoint in the worker, if any: one queued is cancelled (never opened), one under way stops after its
 * pass; returns once the worker's connection to the file is closed, or after STOP_WAIT_MS (logged).
 */
function endJob(r: Registered): void {
  const job = r.job
  if (!job || !worker) return
  const { slot } = job
  if (Atomics.compareExchange(ctrl, slot, QUEUED, CANCELLED) === QUEUED) return
  Atomics.compareExchange(ctrl, slot, RUNNING, STOPPING)
  const until = performance.now() + STOP_WAIT_MS
  for (;;) {
    const v = Atomics.load(ctrl, slot)
    if (v !== RUNNING && v !== STOPPING) return
    const left = until - performance.now()
    if (left <= 0) {
      log.warn(`closing ${basename(r.file)} while its checkpoint still runs (waited ${STOP_WAIT_MS} ms)`)
      return
    }
    Atomics.wait(ctrl, slot, v, left)
  }
}

/**
 * Takes a database's checkpoints off its writer's thread: `checkpointer` for openDb (db.ts). Returns what stops it
 * (the database closing; its own close checkpoints once more, as before): no checkpoint of it is queued or under way
 * once that returns.
 */
export function checkpointOffThread(file: string, writer: DatabaseSync): () => void {
  const key = nextId++
  const url = pathToFileURL(file)
  url.searchParams.set('mode', 'rw')
  const r: Registered = { key, file, url: url.href, writer, auto: true, job: null, over: false, failed: 0 }
  dbs.set(key, r)
  if (startWorker()) setAuto(r, false, 'opened') // i18n-ignore: for the log
  if (!timer) {
    timer = setInterval(checkpointRound, CHECKPOINT_EVERY_MS)
    timer.unref?.()
  }
  return () => {
    if (!dbs.delete(key)) return
    endJob(r)
    if (!dbs.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** Whether SQLite checkpoints this writer's WAL itself (not registered, or fallen back): tests and timedCommit. */
export const checkpointsInCommits = (writer: DatabaseSync): boolean => [...dbs.values()].find((r) => r.writer === writer)?.auto ?? true

/** A commit on main this slow is logged (timedCommit). */
export const SLOW_COMMIT_MS = 100

const walSize = (file: string): number => {
  try {
    return statSync(`${file}-wal`).size
  } catch {
    return 0
  }
}

/**
 * COMMITs `db` (a writer `checkpointOffThread` may have), timed: one over SLOW_COMMIT_MS is logged with its WAL's size
 * before and after and whether SQLite checkpoints that WAL itself (inside the commit) or the worker does, so a stall's
 * cause shows in the log whichever it is.
 */
export function timedCommit(db: DatabaseSync, file: string): void {
  const before = walSize(file)
  const t = performance.now()
  db.exec('COMMIT')
  const ms = performance.now() - t
  if (ms < SLOW_COMMIT_MS) return
  const mb = (n: number): string => (n / 1048576).toFixed(1)
  log.warn(`a commit to ${basename(file)} took ${Math.round(ms)} ms on main's thread (WAL ${mb(before)} MB before, ${mb(walSize(file))} MB after; ${checkpointsInCommits(db) ? 'SQLite checkpoints it in commits' : "checkpointed off main's thread"})`)
}

/** For tests: hold checkpoints between their passes (true) or let them go on, and whether one is held now. */
export const checkpointGate = {
  hold: (on: boolean): void => {
    Atomics.store(ctrl, HELD, 0)
    Atomics.store(ctrl, GATE, on ? 1 : 0)
  },
  held: (): boolean => Atomics.load(ctrl, HELD) === 1
}

/** For tests: the worker as it is, to end it as a crash would. */
export const checkpointWorker = (): Worker | null => worker

/** Ends the worker (tests); the next round starts it again. */
export async function stopCheckpointWorker(): Promise<void> {
  const w = worker
  worker = null
  forgetJobs()
  ended = 0
  if (w) await w.terminate().catch(() => undefined)
}
