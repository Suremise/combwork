import { statSync } from 'original-fs'
import { basename } from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { createLogger } from './logger'

/**
 * The WAL's checkpoints out of the commits (#1633). SQLite checkpoints a WAL database itself inside whichever COMMIT
 * takes its WAL past `wal_autocheckpoint` pages, on the committing connection's thread: for the board and the journal,
 * main's, in the middle of whatever the user or an agent was doing. A checkpoint copies the WAL into the file and
 * fsyncs it (`synchronous=NORMAL` syncs at checkpoints only): on a copy of a real board, 10–30 ms on an idle disk and
 * 50–110 ms beside a slot's kind of disk load, against 0.1 ms for a commit without one.
 *
 * So their writers have it off (`wal_autocheckpoint = 0`), and a timer checkpoints each one (PASSIVE: it never waits
 * for readers or writers) on main once it has been idle: nothing written for `idleMs` (its WAL file's size and time
 * unchanged), something written since its last checkpoint, and at least `everyMs` since that one. A WAL growing past
 * `walBytes` is checkpointed at once, idle or not, as is one written to without a pause for `maxGapMs`. The WAL starts
 * again from its beginning at the writer's next write after a whole checkpoint, as before.
 *
 * Bounded: `incomplete` checkpoints in a row that couldn't copy the whole WAL (a reader on an old snapshot, another
 * process's checkpoint) give the writer SQLite's own auto-checkpoint back, logged; one that copies it whole takes it
 * off again. Kept simple on purpose: an off-thread checkpointer is a later card's, if the field's logs call for it.
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
  changed: number
  /** Something was written since the last checkpoint. */
  dirty: boolean
  /** When it was last checkpointed (or registered). */
  last: number
  /** Checkpoints in a row that couldn't copy the whole WAL. */
  short: number
}

const dbs = new Map<DatabaseSync, Registered>()
let timer: ReturnType<typeof setInterval> | null = null

/** Counts, for tests and the log. */
export const checkpointStats = { done: 0, incomplete: 0, failed: 0, fallbacks: 0 }

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

/** Checkpoints `r` now (PASSIVE, on its writer), counting one that couldn't copy the whole WAL towards the fallback. */
function checkpoint(r: Registered, now: number, why: string): void {
  const t = performance.now()
  let res: { busy: number; log: number; checkpointed: number }
  try {
    res = r.writer.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as typeof res // i18n-ignore: SQL
  } catch (e) {
    checkpointStats.failed++
    log.warn(`checkpointing ${basename(r.file)}'s WAL`, e)
    return
  }
  const ms = performance.now() - t
  r.last = now
  r.dirty = false
  if (ms >= SLOW_MS) log.info(`checkpointed ${basename(r.file)}'s WAL in ${Math.round(ms)} ms (${why}; ${res.checkpointed} of ${res.log} pages)`)
  if (res.busy || res.checkpointed < res.log) {
    checkpointStats.incomplete++
    // Not whole: looked at again once it is due.
    r.dirty = true
    if (++r.short >= checkpointLimits.incomplete) setAuto(r, true, `${r.short} checkpoints in a row couldn't copy its whole WAL`) // i18n-ignore: for the log
    return
  }
  checkpointStats.done++
  r.short = 0
  setAuto(r, false, 'a checkpoint copied its whole WAL') // i18n-ignore: for the log
}

/** One look at each database: checkpointed if it is idle and due, or its WAL is growing past the bound. */
export function checkpointTick(now = performance.now()): void {
  for (const r of dbs.values()) {
    // A write under way (a board change spans awaits): never inside its transaction.
    if (r.writer.isTransaction) continue
    const s = walStat(r.file)
    const grew = s.size > r.size
    if (s.size !== r.size || s.mtime !== r.mtime) {
      r.size = s.size
      r.mtime = s.mtime
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
 * Takes a database's checkpoints out of its commits: `checkpointer` for openDb (db.ts). Returns what stops it (the
 * database closing; its own close checkpoints once more, as before).
 */
export function checkpointWhenIdle(file: string, writer: DatabaseSync): () => void {
  const s = walStat(file)
  const now = performance.now()
  const r: Registered = { file, writer, auto: true, size: s.size, mtime: s.mtime, changed: now, dirty: false, last: now, short: 0 }
  dbs.set(writer, r)
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
    if (!dbs.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }
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
  const before = walStat(file).size
  const t = performance.now()
  db.exec('COMMIT')
  const ms = performance.now() - t
  if (ms < SLOW_COMMIT_MS) return
  const mb = (n: number): string => (n / 1048576).toFixed(1)
  log.warn(`a commit to ${basename(file)} took ${Math.round(ms)} ms on main's thread (WAL ${mb(before)} MB before, ${mb(walStat(file).size)} MB after; ${checkpointsInCommits(db) ? 'SQLite checkpoints it in commits' : 'checkpointed when idle'})`)
}
