import { statSync } from 'original-fs'
import { stat } from 'original-fs/promises'
import { basename, join } from 'path'
import { Worker } from 'worker_threads'
import type { DatabaseSync } from 'node:sqlite'
import { beginGuards } from './db'
import { createLogger } from './logger'
import { timedStep } from './stallWork'
import { CLOSING, runCheckpoint, runRestart, walMark, type CheckpointDone, type CheckpointReply, type CheckpointRequest, type RestartDone } from './walCheckpointWorker'
import { bundledScriptExists, workerHere, workerStarted } from './workerThreads'

/**
 * The WAL's checkpoints out of the commits (#1633). SQLite checkpoints a WAL database itself inside whichever COMMIT
 * takes its WAL past `wal_autocheckpoint` pages, on the committing connection's thread: for the board and the journal,
 * main's, in the middle of whatever the user or an agent was doing. A checkpoint copies the WAL into the file and
 * fsyncs it (`synchronous=NORMAL` syncs at checkpoints only): on a copy of a real board, 10–30 ms on an idle disk and
 * 50–110 ms beside a slot's kind of disk load, against 0.1 ms for a commit without one.
 *
 * So their writers have it off (`wal_autocheckpoint = 0`), and a timer checkpoints each one (PASSIVE: it never waits
 * for readers or writers) on main once it has been idle: nothing written for `idleMs` (its WAL-index's frames and salts
 * unchanged, HI-3414: the WAL file's modified time moves only at the clock's tick, so a write in the same tick that doesn't
 * grow the file left its size and time as they were), something written since its last checkpoint, and at least `everyMs` since that one. A WAL growing past
 * `walBytes` is checkpointed at once, idle or not, as is one written to without a pause for `maxGapMs`. The WAL starts
 * again from its beginning at the writer's next write after a whole checkpoint, as before.
 *
 * Bounded: `incomplete` checkpoints in a row that couldn't copy the whole WAL (a reader on an old snapshot, another
 * process's checkpoint) or threw (a statement of the writer's still running, an I/O error) give the writer SQLite's own
 * auto-checkpoint back, logged; one that copies it whole takes it off again. A failed one is tried again at the
 * triggers' pace (its attempt counts as its last checkpoint), never at every tick.
 *
 * Off main's thread (HI-1691): the field's logs had idle checkpoints of 100-893 ms on main, so the checkpoint itself runs
 * in a worker, on a connection of its own (walCheckpointWorker.ts); the triggers (a stat a second) and the fallback (a
 * pragma on the writer) stay here. One checkpoint of a database at a time. Closing a database never waits for the worker
 * (the Assistant's design call, HR6's rounds 1 and 2: a wait on main for another thread either went on with the file held
 * or, the worker dead, never ended): only what needs the file free (a restore, the upgrade, deleting the journal) awaits
 * `checkpointsReleased`. Without the worker's script (unit tests) the checkpoint runs here, on a connection of its own.
 *
 * The WAL's restart off main's thread too (HI-3289): the first write after a whole checkpoint starts the WAL again and
 * syncs its new header (SQLite does at `synchronous=NORMAL` too: a crash-safety sync, kept), and that write was main's
 * next commit, hundreds of ms on a loaded disk. So once a checkpoint has copied the whole WAL the worker makes that first
 * write itself (walCheckpointWorker.ts's runRestart), while main's writers of the file are held off without holding main:
 * under the database's own async write lock (`hold`, the board's for combwork.db), and behind its write gate
 * (`walWritable`, which the journal's writes await). A BEGIN through db.ts's `beginWrite` while the gate is closed is
 * refused, never waited for (`beginGuards`). Another connection's commit still moves the board's `data_version`, and so
 * does this write: the board takes it for another process's change (one refresh), never missing a real one. The write
 * itself isn't a change to checkpoint again (HI-3362): the worker reads the WAL as its commit left it, and main starts
 * its next tick from there (restart's answer, RestartDone's `wal`).
 */

const log = createLogger('db')

/** How often the timer looks at each database. */
const TICK_MS = 1000
/** SQLite's own auto-checkpoint (its default, in pages), given back when these checkpoints can't finish. */
const SQLITE_AUTO = 1000
/** A checkpoint this slow is logged (it ran between actions, but says what the disk was like). */
const SLOW_MS = 100

/** The triggers and bounds, changeable by tests. */
export const checkpointLimits = {
  /** Nothing written for this long: the database is idle. */
  idleMs: 1000,
  /** At most one idle checkpoint this often. */
  everyMs: 30_000,
  /** A WAL file growing past this is checkpointed at once, idle or not. */
  walBytes: 8 * 1024 * 1024,
  /** Written to without a pause this long since its last checkpoint: checkpointed anyway. */
  maxGapMs: 120_000,
  /** This many checkpoints in a row that couldn't copy the whole WAL: SQLite's own auto-checkpoint takes over. */
  incomplete: 5
}

interface Registered {
  file: string
  writer: DatabaseSync
  /** SQLite's own auto-checkpoint is on (the fallback). */
  auto: boolean
  /** The WAL file's size and modified time as last seen, and when they last changed. */
  size: number
  mtime: number
  /** HI-3414: its WAL-index's frames and salts as last seen (walMark), what says whether anything was written; null unread. */
  mark: string | null
  changed: number
  /** Something was written since the last checkpoint. */
  dirty: boolean
  /** When it was last checkpointed (or registered). */
  last: number
  /** Checkpoints in a row that couldn't copy the whole WAL. */
  short: number
  /** A checkpoint of it, or the WAL's first write after one, is under way in the worker. */
  inFlight: boolean
  /** Its writers' own async lock, the WAL's first write made under it (HI-3289); none: the write gate alone. */
  hold: Hold | null
  /** Closed (a promise) while the worker makes the WAL's first write: main's writers await it (walWritable). */
  gate: Promise<void> | null
  /** A checkpoint copied the whole WAL and nothing has written since: the next write restarts the WAL. */
  restartDue: boolean
  /** The write under way began with restartDue (for a slow commit's line). */
  restarting: boolean
}

/** A database's own async write lock: runs `fn` with it held. */
export type Hold = (fn: () => Promise<void>) => Promise<void>

const dbs = new Map<DatabaseSync, Registered>()
let timer: ReturnType<typeof setInterval> | null = null

/** Counts, for tests and the log. */
export const checkpointStats = { done: 0, incomplete: 0, failed: 0, fallbacks: 0, restarts: 0, restartsSkipped: 0 }

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
  log.info(`${basename(r.file)}: ${on ? 'SQLite checkpoints its WAL in commits again' : 'its WAL is checkpointed when it is idle'} (${why})`)
}

const walStat = (file: string): { size: number; mtime: number } => {
  try {
    const s = statSync(`${file}-wal`)
    return { size: s.size, mtime: s.mtimeMs }
  } catch {
    return { size: 0, mtime: 0 }
  }
}

/**
 * Checkpoints `r` (PASSIVE, on a connection of the worker's): its answer is taken when it comes. One that couldn't copy
 * the whole WAL, or threw (SQLite refused it, an I/O error), counts towards the fallback alike, and the database stays due
 * from this attempt on: tried again at the triggers' pace, not at every tick.
 */
function checkpoint(r: Registered, now: number, why: string): void {
  r.last = now
  r.inFlight = true
  thread.run(r.file, 'checkpoint', (res, where) => {
    r.inFlight = false
    // Closed meanwhile: nothing more of it.
    if (dbs.get(r.writer) !== r || res === null || 'restart' in res) return
    if ('error' in res) {
      checkpointStats.failed++
      log.warn(`checkpointing ${basename(r.file)}'s WAL${where}: ${res.error}`)
      return unfinished(r, 'failed') // i18n-ignore: for the log
    }
    if (res.ms >= SLOW_MS) log.info(`checkpointed ${basename(r.file)}'s WAL in ${Math.round(res.ms)} ms${where} (${why}; ${res.checkpointed} of ${res.log} pages)`)
    if (res.busy || res.checkpointed < res.log) {
      checkpointStats.incomplete++
      return unfinished(r, "couldn't copy its whole WAL") // i18n-ignore: for the log
    }
    checkpointStats.done++
    r.dirty = false
    r.short = 0
    setAuto(r, false, 'a checkpoint copied its whole WAL') // i18n-ignore: for the log
    // A WAL with nothing in it has no restart to make.
    if (res.log === 0) return
    r.restartDue = true
    restart(r)
  })
}

/**
 * The WAL's first write after a whole checkpoint, made in the worker (HI-3289; walCheckpointWorker.ts's runRestart):
 * under the database's lock when it has one (`hold`), the write gate closed meanwhile, opened again whatever the answer
 * (written, skipped, refused, the worker ended, or the database closing: the answer comes once the worker has let go).
 * Never while a write of main's is under way, nor once one has begun since the checkpoint (that write restarts the WAL).
 */
function restart(r: Registered): void {
  if (dbs.get(r.writer) !== r || r.writer.isTransaction || r.inFlight) return
  r.inFlight = true
  const write = (done: () => void): void => {
    // Checked again once the lock is held: closed, written since, or a write under way.
    if (dbs.get(r.writer) !== r || !r.restartDue || r.writer.isTransaction) return done()
    let open = (): void => undefined
    r.gate = new Promise<void>((go) => (open = go))
    const from = performance.now()
    const say = setInterval(() => log.warn(`main's writes to ${basename(r.file)} wait for its WAL's first write in the checkpoints' worker (${Math.round(performance.now() - from)} ms so far)`), closeLimits.warnMs)
    say.unref?.()
    // Answered once, whichever way it ends: the worker's reply, its end, or a throw before the request was ever sent.
    let answered = false
    const answer: Answer = (res, where) => {
      if (answered) return
      answered = true
      clearInterval(say)
      r.gate = null
      open()
      done()
      if (res === null || !('restart' in res || 'error' in res)) return
      if ('error' in res) return log.warn(`making the first write of ${basename(r.file)}'s WAL after its checkpoint${where}: ${res.error}`)
      if (res.busy) return void checkpointStats.restartsSkipped++
      checkpointStats.restarts++
      if (dbs.get(r.writer) === r) {
        r.restartDue = false
        // HI-3362: the restart's own write isn't a change to checkpoint (it would ask for another restart, every
        // `everyMs`, for as long as Combwork runs): the WAL as the worker read it, under the write lock after its
        // commit, is where the next tick starts. Without that reading (another connection writing then), as before.
        if (res.wal) {
          r.size = res.wal.size
          r.mtime = res.wal.mtime
          r.mark = res.wal.mark
        }
      }
      if (res.ms >= SLOW_MS) log.info(`restarted ${basename(r.file)}'s WAL in ${Math.round(res.ms)} ms${where} (its first write after a whole checkpoint, off main's thread)`)
    }
    try {
      thread.run(r.file, 'restart', answer)
    } catch (e) {
      answer({ error: e instanceof Error ? e.message : String(e) }, '')
    }
  }
  const landed = (): void => {
    r.inFlight = false
  }
  if (!r.hold) return write(landed)
  r.hold(() => new Promise<void>(write))
    .catch((e) => log.warn(`restarting ${basename(r.file)}'s WAL`, e))
    .finally(landed)
}

/**
 * Resolves once main may write to `db` (HI-3289): at once, unless the worker is making its WAL's first write, then once
 * that is done. A write that awaits it must begin with no other await after it (JS is single-threaded: the gate closes
 * only between tasks). For a database with no async lock of its own (the journal); the board's writers have its lock.
 */
export async function walWritable(db: DatabaseSync): Promise<void> {
  for (let g = walGate(db); g; g = walGate(db)) await g
}

/** The write gate of `db` while it is closed (the worker making its WAL's first write), else null. */
export const walGate = (db: DatabaseSync): Promise<void> | null => dbs.get(db)?.gate ?? null

/** A checkpoint that didn't finish: still due, and `incomplete` in a row give SQLite its own back until one finishes. */
function unfinished(r: Registered, how: string): void {
  r.dirty = true
  if (++r.short >= checkpointLimits.incomplete) setAuto(r, true, `${r.short} checkpoints in a row failed or ${how}`) // i18n-ignore: for the log
}

/** One look at each database: checkpointed if it is idle and due, or its WAL is growing past the bound. */
export function checkpointTick(now = performance.now()): void {
  for (const r of dbs.values()) {
    // A write under way (a board change spans awaits): never inside its transaction; and one checkpoint at a time.
    if (r.writer.isTransaction || r.inFlight) continue
    const s = walStat(r.file)
    const mark = walMark(r.file)
    const grew = s.size > r.size
    // HI-3414: the WAL-index's mark when both readings have it (exact); the file's size and time only without it.
    const written = mark !== null && r.mark !== null ? mark !== r.mark : s.size !== r.size || s.mtime !== r.mtime
    r.size = s.size
    r.mtime = s.mtime
    r.mark = mark
    if (written) {
      r.changed = now
      r.dirty = true
    }
    if (!r.dirty) continue
    if (grew && s.size > checkpointLimits.walBytes) checkpoint(r, now, `its WAL grew past ${Math.round(checkpointLimits.walBytes / 1048576)} MB`) // i18n-ignore: for the log
    else if (now - r.changed >= checkpointLimits.idleMs && now - r.last >= checkpointLimits.everyMs) checkpoint(r, now, 'idle') // i18n-ignore: for the log
    else if (now - r.last >= checkpointLimits.maxGapMs) checkpoint(r, now, 'written to without a pause') // i18n-ignore: for the log
  }
}

/**
 * Takes a database's checkpoints out of its commits: `checkpointer` for openDb (db.ts). `hold`: the database's own async
 * write lock, which every write of main's to it takes (HI-3289: the WAL's first write after a checkpoint is made under
 * it). Returns what stops it (the database closing; its own close checkpoints once more, as before), which says whether
 * the worker is making the WAL's first write then (its write lock held: the close writes nothing that would wait for it).
 */
export function checkpointWhenIdle(file: string, writer: DatabaseSync, opts: { hold?: Hold } = {}): () => boolean {
  const s = walStat(file)
  const now = performance.now()
  const r: Registered = { file, writer, auto: true, size: s.size, mtime: s.mtime, mark: walMark(file), changed: now, dirty: false, last: now, short: 0, inFlight: false, hold: opts.hold ?? null, gate: null, restartDue: false, restarting: false }
  dbs.set(writer, r)
  // A write begun while the worker holds the file's write lock would wait for its sync on main: refused, never waited for.
  beginGuards.set(writer, () => {
    if (dbs.get(writer) !== r) return
    if (r.gate) {
      const e = new Error(`A write to ${basename(file)} began while the checkpoints' worker made its WAL's first write: it must await walWritable or the database's lock first`) // i18n-ignore: a mistake in Combwork's code, logged, never shown
      log.error(e.message, e)
      throw e
    }
    r.restarting = r.restartDue
    r.restartDue = false
  })
  setAuto(r, false, 'opened') // i18n-ignore: for the log
  if (!timer) {
    timer = setInterval(() => {
      try {
        checkpointTick()
      } catch (e) {
        log.warn('checkpointing the WALs', e)
      }
    }, TICK_MS)
    timer.unref?.()
  }
  return () => {
    dbs.delete(writer)
    beginGuards.delete(writer)
    // A checkpoint asked for before now is skipped; one under way finishes on its own connection (checkpointsReleased).
    thread.closing()
    if (!dbs.size && timer) {
      clearInterval(timer)
      timer = null
    }
    return r.gate !== null
  }
}

/** A checkpoint's answer: done, refused (its error), or skipped (null); `where` says where it ran, for the log. */
type Answer = (res: CheckpointDone | RestartDone | { error: string } | null, where: string) => void

/**
 * The checkpoints' worker (HI-1691), started with the first checkpoint, as the repository lock's is (HI-1680). Without its
 * script (unit tests), each checkpoint runs at once, here. It answers each checkpoint once its connection is closed, so a
 * file's checkpoints in flight say whether the worker still holds it.
 */
class CheckpointThread {
  private worker: Worker | null = null
  /** CLOSING, shared with the worker (walCheckpointWorker.ts). */
  private state = new Int32Array(new SharedArrayBuffer(4))
  private calls = new Map<number, { key: string; answer: Answer }>()
  private next = 0
  /** Checkpoints in flight, and what waits for them to end, by file (lower case). */
  private flying = new Map<string, number>()
  private waiting = new Map<string, (() => void)[]>()

  /**
   * Runs a checkpoint or a restart of `file`, answered once. Never throws: a worker that can't be started, or a request
   * that can't be sent, is answered at once with its error, nothing of it left in flight (HI-3289: a restart's gate
   * opens only with its answer).
   */
  run(file: string, kind: 'checkpoint' | 'restart', answer: Answer): void {
    let w: Worker | null
    try {
      checkpointThreadHooks.beforeDispatch?.(kind)
      w = this.worker ?? this.start()
    } catch (e) {
      return answer({ error: `its worker couldn't be started: ${e instanceof Error ? e.message : String(e)}` }, '') // i18n-ignore: for the log
    }
    if (!w) {
      let res: CheckpointDone | RestartDone | { error: string } | null
      try {
        const m: CheckpointRequest = { id: 0, file, closing: 0, kind }
        res = kind === 'restart' ? runRestart(m, null) : runCheckpoint(m, null)
      } catch (e) {
        res = { error: e instanceof Error ? e.message : String(e) }
      }
      return answer(res, '')
    }
    const id = ++this.next
    const key = file.toLowerCase()
    this.calls.set(id, { key, answer })
    this.flying.set(key, (this.flying.get(key) ?? 0) + 1)
    try {
      const m: CheckpointRequest = { id, file, closing: Atomics.load(this.state, CLOSING), kind }
      checkpointThreadHooks.beforePost?.(kind)
      w.postMessage(m)
    } catch (e) {
      // Not sent: nothing of it in flight (a reply can't come), answered here.
      if (!this.calls.delete(id)) return
      this.landed(key)
      answer({ error: `it couldn't be sent to its worker: ${e instanceof Error ? e.message : String(e)}` }, ' in its worker') // i18n-ignore: for the log
    }
  }

  /** A database is closing: checkpoints asked for before now are skipped (never waited for). */
  closing(): void {
    Atomics.add(this.state, CLOSING, 1)
  }

  /** Resolves once no checkpoint of `file` is in flight: the worker has let go of it, or ended. */
  released(file: string): Promise<void> {
    const key = file.toLowerCase()
    if (!this.flying.get(key)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const from = performance.now()
      const say = setInterval(() => log.warn(`waiting for the WAL's checkpoint of ${basename(file)} in its worker to let go of the file (${Math.round(performance.now() - from)} ms so far)`), closeLimits.warnMs)
      say.unref?.()
      this.waiting.set(key, [
        ...(this.waiting.get(key) ?? []),
        () => {
          clearInterval(say)
          resolve()
        }
      ])
    })
  }

  /** One of `key`'s checkpoints ended: what waited for the last of them goes on. */
  private landed(key: string): void {
    const left = (this.flying.get(key) ?? 1) - 1
    if (left > 0) return void this.flying.set(key, left)
    this.flying.delete(key)
    for (const go of this.waiting.get(key) ?? []) go()
    this.waiting.delete(key)
  }

  private start(): Worker | null {
    if (!bundledScriptExists(workerScript())) {
      workerHere('WAL checkpoints', "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
      return null
    }
    const w = new Worker(workerScript(), { workerData: this.state.buffer })
    this.worker = w
    workerStarted('WAL checkpoints', w) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
    w.on('message', (m: CheckpointReply) => {
      const call = this.calls.get(m.id)
      if (!call) return
      this.calls.delete(m.id)
      this.landed(call.key)
      call.answer(m.ok ? m.value : { error: m.error }, ' in its worker') // i18n-ignore: for the log
    })
    const gone = (why: string): void => {
      if (this.worker !== w) return
      this.worker = null
      log.warn(`the WAL checkpoints' worker ended (${why}); it starts again with the next checkpoint`)
      const calls = [...this.calls.values()]
      this.calls.clear()
      // Ended, it holds nothing (a handle it leaked is the process's: a rename then says why it failed).
      for (const c of calls) this.landed(c.key)
      for (const c of calls) c.answer({ error: `its worker ended (${why})` }, ' in its worker') // i18n-ignore: for the log
    }
    w.on('error', (e: Error) => gone(e.message))
    w.on('exit', (code) => gone(`exit code ${code}`)) // i18n-ignore: for the log
    w.unref()
    return w
  }
}

/** Tests: a throw where the worker is started (beforeDispatch) or a request is sent to it (beforePost). */
export const checkpointThreadHooks: { beforeDispatch?: (kind: 'checkpoint' | 'restart') => void; beforePost?: (kind: 'checkpoint' | 'restart') => void } = {}

/** How often something waiting for a database's file to be let go of by the worker says so in the log (tests change it). */
export const closeLimits = { warnMs: 10_000 }

/**
 * Resolves once the checkpoints' worker has let go of `file` (HI-1691): awaited after a database is closed by what renames,
 * replaces or deletes its file. At once when no checkpoint of it is in flight.
 */
export const checkpointsReleased = (file: string): Promise<void> => thread.released(file)

/** The worker's script, beside main's (as the repository lock's); a test's build of it (`useCheckpointWorker`). */
let scriptForTests: string | null = null
const workerScript = (): string => scriptForTests ?? join(__dirname, 'wal-checkpoint-worker.js')

let thread = new CheckpointThread()

/** Tests: the checkpoints' worker from this script (a build of walCheckpointWorker.ts), or null for the default; a new thread. */
export function useCheckpointWorker(file: string | null): void {
  scriptForTests = file
  thread = new CheckpointThread()
}

/** Whether SQLite checkpoints this writer's WAL itself (not registered, or fallen back): tests and timedCommit. */
export const checkpointsInCommits = (writer: DatabaseSync): boolean => dbs.get(writer)?.auto ?? true

/** A commit on main this slow is logged (timedCommit). */
export const SLOW_COMMIT_MS = 100

/**
 * COMMITs `db` (a writer `checkpointWhenIdle` may have), timed: one over SLOW_COMMIT_MS is logged with its WAL's size
 * before and after and whether SQLite checkpoints that WAL itself (inside the commit) or not, so a stall's cause shows
 * in the log whichever it is.
 */
export function timedCommit(db: DatabaseSync, file: string): void {
  // The WAL's size as the commit starts, read on the thread pool (HI-1783: a stat here on main's thread, before every
  // commit, cost it a few ms each on Windows), taken only for a slow commit's line: the pool reads it at once, while
  // a commit slow enough to be logged has barely begun.
  const before = stat(`${file}-wal`).then(
    (s) => s.size,
    () => 0
  )
  const t = performance.now()
  timedStep(`db commit ${basename(file)}`, () => db.exec('COMMIT'))
  const ms = performance.now() - t
  const r = dbs.get(db)
  // The write began as the first since a whole checkpoint the worker hadn't restarted the WAL after (HI-3289).
  const restarted = !!r?.restarting
  if (r) r.restarting = false
  if (ms < SLOW_COMMIT_MS) return
  const mb = (n: number): string => (n / 1048576).toFixed(1)
  const auto = checkpointsInCommits(db)
  void Promise.all([before, stat(`${file}-wal`).then((s) => s.size, () => 0)]).then(([b, a]) => log.warn(`a commit to ${basename(file)} took ${Math.round(ms)} ms on main's thread (WAL ${mb(b)} MB before, ${mb(a)} MB after; ${auto ? 'SQLite checkpoints it in commits' : 'checkpointed when idle'}; ${restarted ? 'the first write since a whole checkpoint: it restarted the WAL and synced its header' : 'not the first write since a checkpoint'})`))
}
