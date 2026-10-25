import { Worker } from 'worker_threads'
import { realpathSync, statSync } from 'original-fs'
import { basename, resolve } from 'path'
import { pathToFileURL } from 'url'
import type { DatabaseSync } from 'node:sqlite'
import { DbInUseError } from './db'
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
 * Closing, by construction: each job has a slot in its worker's shared array, which both threads change only
 * atomically. The worker closes its connection, then makes the slot DONE, then replies; a close that throws makes it
 * CLOSE_FAILED instead (never DONE), and that worker is ended. A database's stop (its close) cancels a job still queued
 * (the worker skips it without opening the file) and asks one under way to stop after its pass, then waits for DONE.
 * A job its stop couldn't see end within `stopWaitMs` stays the file's (`undrained`, by the file's real path, whatever
 * spelling or which opening of it) until its slot is DONE or its worker has exited (which releases its connection), so
 * every later stop of that file, a reopened one's too, and `assertDrained` before a replacement or deletion (Restore
 * the 0.9 Board Backup, Delete Journal) waits for it again or refuses with DbInUseError. A stop that couldn't drain
 * makes the database's close throw DbInUseError once its own connections are closed: the caller doesn't go on. Each
 * worker has an array of its own, so one that ended and finishes a job late never writes into a slot reused since.
 *
 * Bounded: where the worker can't run (it ended more than RESTARTS times), a checkpoint hangs, a database's checkpoints
 * fail `failures` times in a row, or its WAL holds more than `boundFrames` a checkpoint couldn't copy whole (writes
 * faster than its checkpoints catch up), the writer gets SQLite's own auto-checkpoint back, as before this change, and
 * the log says so; a checkpoint that succeeds with the WAL under the bound takes it off again.
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

/** The bounds, changeable by tests. */
export const checkpointLimits = {
  /** A WAL holding more pages than this, not all copied by a checkpoint: SQLite's own auto-checkpoint takes over. */
  boundFrames: 8 * SQLITE_AUTO,
  /** A checkpoint under way this long has hung: SQLite's own takes over meanwhile. */
  hungMs: 60_000,
  /** This many of a database's checkpoints failing in a row: SQLite's own takes over until one succeeds. */
  failures: 3,
  /** How long a stop waits for a checkpoint under way to close its connection (main's thread waits: a pass at most). */
  stopWaitMs: 10_000
}

// A job's slot: main makes it QUEUED; the worker RUNNING, or skips one CANCELLED; main asks a running one to stop
// (STOPPING); the worker makes it DONE once its connection is closed (CLOSE_FAILED when the close threw), and only
// then replies; main frees it at the reply.
const FREE = 0
const QUEUED = 1
const RUNNING = 2
const STOPPING = 3
const CANCELLED = 4
const DONE = 5
const CLOSE_FAILED = 6
const SLOTS = 64
/** The job slots of the worker running now: each worker gets an array of its own. */
let ctrl = new Int32Array(new SharedArrayBuffer(SLOTS * 4))
/**
 * For tests: while its GATE is 1 a checkpoint is held before it closes its connection until it is let go or asked to
 * stop; while it is 2, even when asked to stop (a checkpoint that won't end); 3 makes its close throw. HELD says one
 * got to the gate.
 */
const testGate = new Int32Array(new SharedArrayBuffer(8))
const GATE = 0
const HELD = 1

/** The worker's code (plain JavaScript, so it runs unbuilt in tests as in the app): one checkpoint per request. */
const WORKER_CODE = `
const { DatabaseSync } = require('node:sqlite')
const { parentPort, workerData } = require('worker_threads')
const { ctrl, gate } = workerData
const finish = (slot, state, reply) => {
  Atomics.store(ctrl, slot, state)
  Atomics.notify(ctrl, slot)
  parentPort.postMessage(reply)
}
parentPort.on('message', ({ id, url, slot }) => {
  const t = performance.now()
  if (Atomics.compareExchange(ctrl, slot, ${QUEUED}, ${RUNNING}) !== ${QUEUED}) return finish(slot, ${DONE}, { id, ok: true, skipped: true, ms: 0 })
  const stopping = () => Atomics.load(ctrl, slot) === ${STOPPING}
  let db = null
  let reply
  try {
    db = new DatabaseSync(new URL(url), { timeout: 0 })
    let r = null
    for (let i = 0; i < ${PASSES}; i++) {
      r = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
      if (r.busy || r.checkpointed >= r.log || stopping()) break
    }
    reply = { id, ok: true, busy: r.busy, frames: r.log, copied: r.checkpointed, ms: performance.now() - t }
  } catch (e) {
    reply = { id, ok: false, error: String((e && e.message) || e), ms: performance.now() - t }
  }
  const held = Atomics.load(gate, ${GATE})
  if (held === 1 || held === 2) {
    Atomics.store(gate, ${HELD}, 1)
    for (;;) {
      const g = Atomics.load(gate, ${GATE})
      if (g === 0 || (g === 1 && stopping())) break
      Atomics.wait(gate, ${GATE}, g, 10)
    }
  }
  try {
    if (held === 3) throw new Error('a close made to fail (a test)')
    if (db) db.close()
  } catch (e) {
    return finish(slot, ${CLOSE_FAILED}, { ...reply, closeFailed: String((e && e.message) || e) })
  }
  finish(slot, ${DONE}, reply)
})
`

interface Reply {
  id: number
  ok: boolean
  skipped?: boolean
  closeFailed?: string
  busy?: number
  frames?: number
  copied?: number
  error?: string
  ms: number
}

/** A job in the worker: its database, its file's real path, and its slot in its worker's array. */
interface Job {
  r: Registered
  place: string
  slot: number
  ctrl: Int32Array
  since: number
}

interface Registered {
  /** Its key in `dbs`. */
  key: number
  file: string
  /** The file's real path, lowercased: the same for every spelling and every opening of the file. */
  place: string
  url: string
  writer: DatabaseSync
  /** SQLite's own auto-checkpoint is on (the fallback). */
  auto: boolean
  /** The checkpoint of it in the worker, else null. */
  job: Job | null
  /** Its WAL held more than the bound, not all copied, at its last checkpoint. */
  over: boolean
  /** Its checkpoints that failed in a row. */
  failed: number
}

const dbs = new Map<number, Registered>()
const pending = new Map<number, Job>()
/** Jobs whose database closed before they were seen to end, by the file's real path: until DONE or their worker exits. */
const undrained = new Map<string, Set<Job>>()
let nextId = 1
let worker: Worker | null = null
let ended = 0
let timer: ReturnType<typeof setInterval> | null = null

/** Counts, for tests and the log. */
export const checkpointStats = { done: 0, failed: 0, skipped: 0, fallbacks: 0 }

/** A file's real path, lowercased (as it is where it can be resolved, else as given). */
function placeOf(file: string): string {
  try {
    return realpathSync.native(file).toLowerCase()
  } catch {
    return resolve(file).toLowerCase()
  }
}

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
  const own = new Int32Array(new SharedArrayBuffer(SLOTS * 4))
  ctrl = own
  const w = new Worker(WORKER_CODE, { eval: true, workerData: { ctrl: own, gate: testGate } })
  worker = w
  w.on('message', (m: Reply) => settle(m, w))
  const gone = (why: string): void => {
    if (worker !== w) return
    worker = null
    ended++
    log.warn(`the checkpoint worker ended (${why})${ended > RESTARTS ? '; SQLite checkpoints the WALs itself from now on' : ''}`)
    for (const [id, job] of pending) if (job.ctrl === own) forget(id, job)
    for (const r of dbs.values()) setAuto(r, true, 'the checkpoint worker ended') // i18n-ignore: for the log
  }
  w.on('error', (e: Error) => gone(e.message))
  w.on('exit', (code) => {
    // Its thread is gone, and with it every connection it had: its jobs no longer hold their files.
    for (const set of undrained.values()) for (const job of set) if (job.ctrl === own) set.delete(job)
    gone(`exit code ${code}`) // i18n-ignore: for the log
  })
  w.unref()
  return w
}

/** A job no longer waited for by its database (its worker ended, or it replied). */
function forget(id: number, job: Job): void {
  pending.delete(id)
  if (job.r.job === job) job.r.job = null
}

/** A job seen to end with its connection closed: no longer its file's. */
function drained(job: Job): void {
  const set = undrained.get(job.place)
  if (!set) return
  set.delete(job)
  if (!set.size) undrained.delete(job.place)
}

function settle(m: Reply, from: Worker): void {
  const job = pending.get(m.id)
  if (!job) return
  forget(m.id, job)
  const r = job.r
  if (m.closeFailed) {
    // Its connection may still be open: the file stays its until the worker, ended now, has exited.
    log.warn(`the checkpoint of ${basename(r.file)} couldn't close its connection (${m.closeFailed}): the checkpoint worker is ended`)
    let set = undrained.get(job.place)
    if (!set) undrained.set(job.place, (set = new Set()))
    set.add(job)
    void from.terminate().catch(() => undefined)
    return
  }
  // DONE: the worker closed its connection before it replied.
  drained(job)
  Atomics.store(job.ctrl, job.slot, FREE)
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
    r.job = { r, place: r.place, slot, ctrl, since: now }
    pending.set(id, r.job)
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
 * Waits up to `stopWaitMs` for the jobs still holding a file (by its real path) to end with their connections closed.
 * True when none holds it now.
 */
function drainPlace(place: string): boolean {
  const set = undrained.get(place)
  if (!set) return true
  const until = performance.now() + checkpointLimits.stopWaitMs
  for (const job of [...set]) {
    for (;;) {
      const v = Atomics.load(job.ctrl, job.slot)
      // DONE (or freed at its reply): closed. CLOSE_FAILED waits for its worker's exit, which can't be awaited here.
      if (v === DONE || v === FREE) {
        drained(job)
        break
      }
      const left = until - performance.now()
      if (v === CLOSE_FAILED || left <= 0) break
      Atomics.wait(job.ctrl, job.slot, v, left)
    }
  }
  const left = undrained.get(place)
  if (left?.size) {
    log.warn(`${basename(place)} is still open by a checkpoint ${Math.round(checkpointLimits.stopWaitMs)} ms after it was asked to stop`)
    return false
  }
  return true
}

/**
 * Refuses (DbInUseError) while a checkpoint of `file` that its database's close couldn't see end still has it open,
 * after waiting up to `stopWaitMs` for it: before the file is replaced or deleted (Restore the 0.9 Board Backup, Delete
 * Journal), however it is spelt and whether or not a database of it is open now.
 */
export function assertDrained(file: string): void {
  if (!drainPlace(placeOf(file))) throw new DbInUseError(file, "by its checkpoint, which hasn't stopped") // i18n-ignore: for the log
}

/**
 * Takes a database's checkpoints off its writer's thread: `checkpointer` for openDb (db.ts). Returns what stops it
 * (the database closing; its own close checkpoints once more, as before): true once no checkpoint of its file is queued
 * or under way, false when one still is, after waiting (drainPlace).
 */
export function checkpointOffThread(file: string, writer: DatabaseSync): () => boolean {
  const key = nextId++
  const url = pathToFileURL(file)
  url.searchParams.set('mode', 'rw')
  const r: Registered = { key, file, place: placeOf(file), url: url.href, writer, auto: true, job: null, over: false, failed: 0 }
  dbs.set(key, r)
  if (startWorker()) setAuto(r, false, 'opened') // i18n-ignore: for the log
  if (!timer) {
    timer = setInterval(checkpointRound, CHECKPOINT_EVERY_MS)
    timer.unref?.()
  }
  return () => {
    if (dbs.get(key) !== r) return drainPlace(r.place)
    dbs.delete(key)
    if (!dbs.size && timer) {
      clearInterval(timer)
      timer = null
    }
    const job = r.job
    // Queued: cancelled, never opened. Under way: asked to stop, and the file's until it is seen to end.
    if (job && Atomics.compareExchange(job.ctrl, job.slot, QUEUED, CANCELLED) !== QUEUED) {
      Atomics.compareExchange(job.ctrl, job.slot, RUNNING, STOPPING)
      let set = undrained.get(job.place)
      if (!set) undrained.set(job.place, (set = new Set()))
      set.add(job)
    }
    return drainPlace(r.place)
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

/**
 * For tests: hold checkpoints before they close their connections ('held': until let go or asked to stop; 'stuck': even
 * when asked to stop), make their closes throw ('closeFails'), or let them go on (false); and whether one got there.
 */
export const checkpointGate = {
  hold: (how: 'held' | 'stuck' | 'closeFails' | false): void => {
    Atomics.store(testGate, HELD, 0)
    Atomics.store(testGate, GATE, how === 'held' ? 1 : how === 'stuck' ? 2 : how === 'closeFails' ? 3 : 0)
    Atomics.notify(testGate, GATE)
  },
  held: (): boolean => Atomics.load(testGate, HELD) === 1
}

/** For tests: the worker as it is, to end it as a crash would. */
export const checkpointWorker = (): Worker | null => worker

/** For tests: whether a checkpoint still holds this file after its database closed. */
export const checkpointHolds = (file: string): boolean => !!undrained.get(placeOf(file))?.size

/** Ends the worker (tests) and waits for its exit; the next round starts it again. */
export async function stopCheckpointWorker(): Promise<void> {
  const w = worker
  if (w) await w.terminate().catch(() => undefined)
  worker = null
  for (const [id, job] of [...pending]) forget(id, job)
  ended = 0
}
