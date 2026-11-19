import { closeSync, existsSync, openSync, readSync, statSync } from 'original-fs'
import { parentPort, workerData } from 'worker_threads'
import { DatabaseSync } from 'node:sqlite'

/**
 * The WAL checkpoints' worker (HI-1691): a thread of its own that checkpoints a database's WAL (PASSIVE) on a connection
 * of its own, so the copy into the file and its fsync (100 ms to most of a second on a loaded disk) never hold up
 * Combwork's main process, and with it the keystrokes typed into a pane. When to checkpoint, and the fallback to SQLite's
 * own, stay main's (walCheckpoint.ts). A PASSIVE checkpoint can run on any connection to the file: it never waits for
 * readers or writers, and copies what no reader still needs.
 *
 * HI-3414: that connection is kept, one per database, from its first request until main lets go of the file (`release`),
 * so its `PRAGMA data_version` says whether another connection has committed since this one last looked. Main's stat of
 * the WAL can't always: Windows stamps the file's time from its clock tick (about 15.6 ms by default), and a write after a
 * restart goes over old frames without growing the file. So while the stat says idle, main asks (`check`) every `everyMs`,
 * and the worker checkpoints only when data_version has moved. Its own commits never move it (SQLite's rule), and the
 * WAL's restart is written on this same connection, so the restart is never taken for a change (HI-3362's loop).
 *
 * Main and the worker share one number (`state`), CLOSING, which main moves on as it closes a database: a request asked
 * for before a close began since is skipped, its file never opened. One already under way finishes; the `release` main
 * sends as it closes comes after it and closes the kept connection, and its answer is how main knows the file is let go
 * of (walCheckpoint.ts's checkpointsReleased). A worker that ends has let go of everything, and a new one's first check of
 * a database checkpoints once (no data_version to compare). No Electron here (a worker can't load it): main logs.
 */

export const CLOSING = 0

/**
 * What main asks of the worker: a checkpoint; (HI-3414) a checkpoint only if another connection has committed since the
 * kept connection last looked (`check`); (HI-3289) the WAL's first write after a whole checkpoint (`restart`), so its
 * restart and the sync of its new header are this thread's, not those of main's next commit; or (HI-3414) the kept
 * connection closed (`release`), as main closes the database.
 */
export type CheckpointKind = 'checkpoint' | 'check' | 'restart' | 'release'

/** A request. A `release` runs whatever CLOSING says: it is sent once the close has moved it on. */
export type CheckpointRequest = { id: number; file: string; closing: number; kind?: CheckpointKind }

/**
 * What the WAL's first write did: written (`busy` false), or skipped because another connection had the write lock; how
 * long it took. `wal` (HI-3362): the WAL file's size and modified time after that write, read while this connection held
 * the write lock again (so no other connection's write is in them); none when another connection took it first.
 */
export interface RestartDone {
  restart: true
  busy: boolean
  ms: number
  wal?: { size: number; mtime: number }
}

/** HI-3414: a check found nothing committed by another connection since the kept connection last looked. */
export interface CheckUnchanged {
  unchanged: true
}

/** What SQLite says of a checkpoint (`busy`: it couldn't finish; `checkpointed` of `log` pages), and how long it took. */
export interface CheckpointDone {
  busy: number
  log: number
  checkpointed: number
  ms: number
}

/** A request's answer: done, or skipped (null: a close began since it was asked for, the file is gone, or a release). */
export type CheckpointReply = { id: number; ok: true; value: CheckpointDone | CheckUnchanged | RestartDone | null } | { id: number; ok: false; error: string }

/**
 * Tests: a checkpoint of these files throws, as one refused by SQLite or the disk would; `inRestart` runs inside the
 * WAL's first write, its write lock held, `beforeWalStat` once it is committed, before the WAL is read under the write
 * lock again (HI-3362), and `afterRestart` once that reading is done, before its answer (in-process only: a worker's
 * thread has its own copy of this module).
 */
export const checkpointHooks = { fail: null as ((file: string) => boolean) | null, inRestart: null as ((file: string) => void) | null, afterRestart: null as ((file: string) => void) | null, beforeWalStat: null as ((file: string) => void) | null }

/**
 * HI-3414: the connection kept for a database (by its file, lower case), and its data_version as it was read before its
 * last checkpoint (null: none on this connection yet, so a check checkpoints). Never moved by the restart: whatever
 * another connection committed since that checkpoint is for the next one.
 */
interface Kept {
  db: DatabaseSync
  seen: number | null
}
const kept = new Map<string, Kept>()

/** The kept connection of `file`, opened if there is none. */
function keep(file: string): Kept {
  const key = file.toLowerCase()
  const k = kept.get(key)
  if (k?.db.isOpen) return k
  const db = new DatabaseSync(file, { timeout: 0 })
  try {
    // As the file's own writers have it (the restart's write): the header's sync alone, no sync at the commit, and never a
    // checkpoint in it. A checkpoint syncs the WAL before it and the file after it at NORMAL too.
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA wal_autocheckpoint = 0')
  } catch (e) {
    db.close()
    throw e
  }
  const made: Kept = { db, seen: null }
  kept.set(key, made)
  return made
}

/**
 * HI-3414: closes the kept connection of `file`, if any (main closing the database, a request that threw on it, or the
 * file gone). The next request opens another, whose first check checkpoints.
 */
export function releaseConnection(file: string): void {
  const key = file.toLowerCase()
  const k = kept.get(key)
  kept.delete(key)
  if (k?.db.isOpen) k.db.close()
}

/** Runs `fn` on `file`'s kept connection; one that throws closes it (it may be what is wrong). */
function onKept<T>(file: string, fn: (k: Kept) => T): T {
  try {
    return fn(keep(file))
  } catch (e) {
    releaseConnection(file)
    throw e
  }
}

/**
 * Checkpoints `m.file`'s WAL on its kept connection; `state` is shared with main (null: run on main, in tests). A `check`
 * (HI-3414) checkpoints only when data_version has moved since this connection last looked (another connection's commit,
 * main's included), or never has: else it answers `unchanged`.
 */
export function runCheckpoint(m: CheckpointRequest, state: Int32Array | null): CheckpointDone | CheckUnchanged | null {
  if (state && Atomics.load(state, CLOSING) !== m.closing) return null
  // Never one made: a database moved or removed since stays so.
  if (!existsSync(m.file)) {
    releaseConnection(m.file)
    return null
  }
  if (checkpointHooks.fail?.(m.file)) throw new Error('database table is locked (test)') // i18n-ignore: a test's stand-in for SQLite's error
  return onKept(m.file, (k) => {
    // Read before the checkpoint: a commit after it moves it, whether or not the checkpoint copied that commit.
    const v = dataVersion(k.db)
    if (m.kind === 'check' && k.seen === v) return { unchanged: true }
    const t = performance.now()
    const res = k.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as { busy: number; log: number; checkpointed: number } // i18n-ignore: SQL
    k.seen = v
    return { busy: res.busy, log: res.log, checkpointed: res.checkpointed, ms: performance.now() - t }
  })
}

/**
 * The WAL's first write after a whole checkpoint (HI-3289), on the kept connection: SQLite starts the WAL again from its
 * beginning at the first write after a whole checkpoint and syncs its new header there, even at `synchronous=NORMAL`
 * (`walFrames`: an out-of-order write after a restart could otherwise corrupt the file), so whichever connection writes
 * first pays that sync, on its thread. Made here, it is this thread's: `user_version` written back as it is (a page of
 * the file's header written, nothing in it changed), in a transaction that never waits for the write lock (another
 * connection holding it, it is skipped: `busy`, and that connection's commit restarts the WAL itself). Its commit is this
 * connection's own, so it never moves data_version (HI-3414): the next check sees only other connections' commits since
 * the checkpoint, those before this restart included.
 */
export function runRestart(m: CheckpointRequest, state: Int32Array | null): RestartDone | null {
  if (state && Atomics.load(state, CLOSING) !== m.closing) return null
  if (!existsSync(m.file)) {
    releaseConnection(m.file)
    return null
  }
  return onKept(m.file, (k) => {
    const db = k.db
    const t = performance.now()
    let seen = 0
    try {
      db.exec('BEGIN IMMEDIATE')
    } catch (e) {
      if (/locked|busy/i.test(e instanceof Error ? e.message : '')) return { restart: true, busy: true, ms: performance.now() - t }
      throw e
    }
    // HI-3362 (HR3's round 1): the WAL's salts as this transaction begins, its write lock held.
    const salts = walSalts(m.file)
    try {
      checkpointHooks.inRestart?.(m.file)
      const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version // i18n-ignore: SQL
      db.exec(`PRAGMA user_version = ${Number(v) | 0}`)
      // HI-3362: another connection's commit from here on moves this connection's data_version (its own doesn't). Read
      // with the write lock held, so no commit falls between it and this one.
      seen = dataVersion(db)
      db.exec('COMMIT')
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw e
    }
    // Its own commit leaves data_version as it was, so `k.seen` stays the checkpoint's: a commit of another connection's
    // since (HR1's round 4: one between the checkpoint and this transaction) is still seen by the next check.
    const ms = performance.now() - t
    const wal = walAfter(db, m.file, seen, salts)
    checkpointHooks.afterRestart?.(m.file)
    return { restart: true, busy: false, ms, ...(wal ? { wal } : {}) }
  })
}

const dataVersion = (db: DatabaseSync): number => (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version // i18n-ignore: SQL

/**
 * The WAL's salts (its header's bytes 16-23), as hex: SQLite writes new ones (the first incremented, the second random)
 * each time a write starts the WAL again from its beginning. Not its checkpoint sequence (bytes 12-15): that one is the
 * writing connection's own count, so a new connection's first restart always writes 1. Null when they can't be read.
 */
function walSalts(file: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(`${file}-wal`, 'r')
    const b = Buffer.alloc(8)
    return readSync(fd, b, 0, 8, 16) === 8 ? b.toString('hex') : null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * HI-3362: the WAL file's size and modified time after this connection's commit, when it holds that commit alone. Read
 * under the write lock (a transaction begun and rolled back, writing nothing), so no other connection writes while it is
 * read, and only when:
 * - this connection's data_version is still `seen`, the one read before its commit: no other connection committed since;
 * - and the WAL's salts changed from `salts`, those read as its transaction began (HR3's round 1): this commit started
 *   the WAL again, which SQLite does only when everything in it was checkpointed. A commit of another connection's since
 *   the checkpoint would have started it again itself, or (a reader holding it back) left frames no checkpoint had
 *   copied, and this one couldn't have; either way the salts wouldn't have changed here.
 * Null otherwise (main sees what is in the WAL as a change, as before), or when the file can't be read.
 */
function walAfter(db: DatabaseSync, file: string, seen: number, salts: string | null): RestartDone['wal'] | null {
  checkpointHooks.beforeWalStat?.(file)
  try {
    db.exec('BEGIN IMMEDIATE')
  } catch {
    return null
  }
  try {
    if (dataVersion(db) !== seen || salts === null || walSalts(file) === salts) return null
    const s = statSync(`${file}-wal`)
    return { size: s.size, mtime: s.mtimeMs }
  } catch {
    return null
  } finally {
    db.exec('ROLLBACK')
  }
}

const port = parentPort
if (port) {
  const state = new Int32Array(workerData as SharedArrayBuffer)
  port.on('message', (m: CheckpointRequest) => {
    try {
      const value = m.kind === 'release' ? (releaseConnection(m.file), null) : m.kind === 'restart' ? runRestart(m, state) : runCheckpoint(m, state)
      port.postMessage({ id: m.id, ok: true, value } satisfies CheckpointReply)
    } catch (e) {
      port.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies CheckpointReply)
    }
  })
}
