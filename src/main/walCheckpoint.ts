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
 * each time on a connection of its own opened for that checkpoint and closed after it (nothing of a closed workspace
 * stays open; `mode=rw`: a file gone is never made again).
 *
 * Bounded: where the worker can't run (it ended more than RESTARTS times), a checkpoint hangs, or a WAL holds more than
 * BOUND_FRAMES all the same (writes faster than its checkpoints catch up), the writer gets SQLite's own auto-checkpoint
 * back, as before this change, and the log says so; a WAL back under the bound with the worker running takes it off again.
 */

const log = createLogger('db')

/** How often each open database is checkpointed. */
export const CHECKPOINT_EVERY_MS = 5000
/** SQLite's own auto-checkpoint (its default, in pages), given back when the worker can't do it. */
const SQLITE_AUTO = 1000
/** A WAL holding more pages than this, not all copied by a checkpoint: SQLite's own auto-checkpoint takes over until it is back under. */
export const BOUND_FRAMES = 8 * SQLITE_AUTO
/** A checkpoint under way this long has hung: SQLite's own auto-checkpoint takes over meanwhile. */
const HUNG_MS = 60_000
/** A checkpoint this slow is logged (it held up nothing, but says what the disk was like). */
const SLOW_MS = 250
/** How many times the worker may end before SQLite's own auto-checkpoint takes over for good. */
const RESTARTS = 3
/** Passes of one checkpoint at most: each copies what commits added during the one before. */
const PASSES = 5

/** The worker's code (plain JavaScript, so it runs unbuilt in tests as in the app): one checkpoint per request. */
const WORKER_CODE = `
const { DatabaseSync } = require('node:sqlite')
const { parentPort } = require('worker_threads')
parentPort.on('message', ({ id, url }) => {
  const t = performance.now()
  let db = null
  try {
    db = new DatabaseSync(new URL(url), { timeout: 0 })
    let r = null
    for (let i = 0; i < ${PASSES}; i++) {
      r = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
      if (r.busy || r.checkpointed >= r.log) break
    }
    parentPort.postMessage({ id, ok: true, busy: r.busy, frames: r.log, copied: r.checkpointed, ms: performance.now() - t })
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String((e && e.message) || e), ms: performance.now() - t })
  } finally {
    try { if (db) db.close() } catch {}
  }
})
`

interface Reply {
  id: number
  ok: boolean
  busy?: number
  frames?: number
  copied?: number
  error?: string
  ms: number
}

interface Registered {
  file: string
  url: string
  writer: DatabaseSync
  /** SQLite's own auto-checkpoint is on (the fallback). */
  auto: boolean
  /** When the checkpoint of it under way in the worker was asked for, else null. */
  since: number | null
  /** Its WAL held more than BOUND_FRAMES after its last checkpoint. */
  over: boolean
}

const dbs = new Map<number, Registered>()
const pending = new Map<number, Registered>()
let nextId = 1
let worker: Worker | null = null
let ended = 0
let timer: ReturnType<typeof setInterval> | null = null

/** Counts, for tests and the log. */
export const checkpointStats = { done: 0, failed: 0, fallbacks: 0 }

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

function startWorker(): Worker | null {
  if (worker) return worker
  if (ended > RESTARTS) return null
  const w = new Worker(WORKER_CODE, { eval: true })
  worker = w
  w.on('message', (m: Reply) => settle(m))
  const gone = (why: string): void => {
    if (worker !== w) return
    worker = null
    ended++
    log.warn(`the checkpoint worker ended (${why})${ended > RESTARTS ? '; SQLite checkpoints the WALs itself from now on' : ''}`)
    for (const r of pending.values()) r.since = null
    pending.clear()
    for (const r of dbs.values()) setAuto(r, true, 'the checkpoint worker ended') // i18n-ignore: for the log
  }
  w.on('error', (e: Error) => gone(e.message))
  w.on('exit', (code) => gone(`exit code ${code}`)) // i18n-ignore: for the log
  w.unref()
  return w
}

function settle(m: Reply): void {
  const r = pending.get(m.id)
  pending.delete(m.id)
  if (!r) return
  r.since = null
  if (!m.ok) {
    checkpointStats.failed++
    log.warn(`checkpointing ${basename(r.file)}'s WAL failed: ${m.error}`)
    return
  }
  checkpointStats.done++
  // A WAL copied whole starts again at the next write, however big it was; one never copied whole only grows.
  r.over = (m.frames ?? 0) > BOUND_FRAMES && (m.copied ?? 0) < (m.frames ?? 0)
  if (m.ms >= SLOW_MS) log.info(`checkpointed ${basename(r.file)}'s WAL off main's thread in ${Math.round(m.ms)} ms (${m.copied} of ${m.frames} pages)`)
}

/** One round: each database's WAL held to its bound, and checkpointed by the worker. */
export function checkpointRound(): void {
  const now = performance.now()
  for (const r of dbs.values()) {
    const thread = startWorker()
    const hung = r.since !== null && now - r.since > HUNG_MS
    if (!thread) continue
    if (r.over || hung) setAuto(r, true, hung ? 'a checkpoint of it hangs' : `its WAL holds more than ${BOUND_FRAMES} pages`) // i18n-ignore: for the log
    else setAuto(r, false, 'the worker checkpoints it') // i18n-ignore: for the log
    if (r.since !== null) continue
    const id = nextId++
    r.since = now
    pending.set(id, r)
    const job: { id: number; url: string } = { id, url: r.url }
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
 * Takes a database's checkpoints off its writer's thread: `checkpointer` for openDb (db.ts). Returns what stops it
 * (the database closing; its own close checkpoints once more, as before).
 */
export function checkpointOffThread(file: string, writer: DatabaseSync): () => void {
  const key = nextId++
  const url = pathToFileURL(file)
  url.searchParams.set('mode', 'rw')
  const r: Registered = { file, url: url.href, writer, auto: true, since: null, over: false }
  dbs.set(key, r)
  if (startWorker()) setAuto(r, false, 'opened')
  if (!timer) {
    timer = setInterval(checkpointRound, CHECKPOINT_EVERY_MS)
    timer.unref?.()
  }
  return () => {
    dbs.delete(key)
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

/** Ends the worker (tests); the next round starts it again. */
export async function stopCheckpointWorker(): Promise<void> {
  const w = worker
  worker = null
  for (const r of pending.values()) r.since = null
  pending.clear()
  ended = 0
  if (w) await w.terminate().catch(() => undefined)
}
