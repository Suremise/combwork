import { existsSync } from 'original-fs'
import { parentPort, workerData } from 'worker_threads'
import { DatabaseSync } from 'node:sqlite'

/**
 * The WAL checkpoints' worker (HI-1691): a thread of its own that checkpoints a database's WAL (PASSIVE) on a connection
 * of its own, opened for the checkpoint and closed after it, so the copy into the file and its fsync (100 ms to most of a
 * second on a loaded disk) never hold up Combwork's main process, and with it the keystrokes typed into a pane. When to
 * checkpoint, and the fallback to SQLite's own, stay main's (walCheckpoint.ts). A PASSIVE checkpoint can run on any
 * connection to the file: it never waits for readers or writers, and copies what no reader still needs.
 *
 * Main and the worker share one number (`state`), CLOSING, which main moves on as it closes a database: a checkpoint asked
 * for before a close began since is skipped, its file never opened. One already under way finishes on its own connection
 * (two connections to a file are fine for SQLite); its answer, sent once that connection is closed, is how main knows the
 * file is let go of (walCheckpoint.ts's checkpointsReleased). No Electron here (a worker can't load it): main logs.
 */

export const CLOSING = 0

/**
 * A request: a checkpoint, or (HI-3289) the WAL's first write after a whole checkpoint (`restart`), so its restart and
 * the sync of its new header are this thread's, not those of main's next commit.
 */
export type CheckpointRequest = { id: number; file: string; closing: number; kind?: 'checkpoint' | 'restart' }

/** What the WAL's first write did: written (`busy` false), or skipped because another connection had the write lock; how long it took. */
export interface RestartDone {
  restart: true
  busy: boolean
  ms: number
}

/** What SQLite says of a checkpoint (`busy`: it couldn't finish; `checkpointed` of `log` pages), and how long it took. */
export interface CheckpointDone {
  busy: number
  log: number
  checkpointed: number
  ms: number
}

/** A checkpoint's answer: done, or skipped (null: a close began since it was asked for, or the file is gone). */
export type CheckpointReply = { id: number; ok: true; value: CheckpointDone | RestartDone | null } | { id: number; ok: false; error: string }

/**
 * Tests: a checkpoint of these files throws, as one refused by SQLite or the disk would; `inRestart` runs inside the
 * WAL's first write, its write lock held, and `afterRestart` once it is committed and its connection closed, before its
 * answer (in-process only: a worker's thread has its own copy of this module).
 */
export const checkpointHooks = { fail: null as ((file: string) => boolean) | null, inRestart: null as ((file: string) => void) | null, afterRestart: null as ((file: string) => void) | null }

/** Checkpoints `m.file`'s WAL on a connection of its own; `state` is shared with main (null: run on main, in tests). */
export function runCheckpoint(m: CheckpointRequest, state: Int32Array | null): CheckpointDone | null {
  if (state && Atomics.load(state, CLOSING) !== m.closing) return null
  // Never one made: a database moved or removed since stays so.
  if (!existsSync(m.file)) return null
  if (checkpointHooks.fail?.(m.file)) throw new Error('database table is locked (test)') // i18n-ignore: a test's stand-in for SQLite's error
  const db = new DatabaseSync(m.file, { timeout: 0 })
  try {
    const t = performance.now()
    const res = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as { busy: number; log: number; checkpointed: number } // i18n-ignore: SQL
    return { busy: res.busy, log: res.log, checkpointed: res.checkpointed, ms: performance.now() - t }
  } finally {
    db.close()
  }
}

/**
 * The WAL's first write after a whole checkpoint (HI-3289), on a connection of its own: SQLite starts the WAL again from
 * its beginning at the first write after a whole checkpoint and syncs its new header there, even at `synchronous=NORMAL`
 * (`walFrames`: an out-of-order write after a restart could otherwise corrupt the file), so whichever connection writes
 * first pays that sync, on its thread. Made here, it is this thread's: `user_version` written back as it is (a page of
 * the file's header written, nothing in it changed), in a transaction that never waits for the write lock (another
 * connection holding it, it is skipped: `busy`, and that connection's commit restarts the WAL itself).
 */
export function runRestart(m: CheckpointRequest, state: Int32Array | null): RestartDone | null {
  if (state && Atomics.load(state, CLOSING) !== m.closing) return null
  if (!existsSync(m.file)) return null
  const db = new DatabaseSync(m.file, { timeout: 0 })
  try {
    // As the file's own writers have it: the header's sync alone, no sync at the commit, and never a checkpoint in it.
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA wal_autocheckpoint = 0')
    const t = performance.now()
    try {
      db.exec('BEGIN IMMEDIATE')
    } catch (e) {
      if (/locked|busy/i.test(e instanceof Error ? e.message : '')) return { restart: true, busy: true, ms: performance.now() - t }
      throw e
    }
    try {
      checkpointHooks.inRestart?.(m.file)
      const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version // i18n-ignore: SQL
      db.exec(`PRAGMA user_version = ${Number(v) | 0}`)
      db.exec('COMMIT')
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw e
    }
    const ms = performance.now() - t
    db.close()
    checkpointHooks.afterRestart?.(m.file)
    return { restart: true, busy: false, ms }
  } finally {
    if (db.isOpen) db.close()
  }
}

const port = parentPort
if (port) {
  const state = new Int32Array(workerData as SharedArrayBuffer)
  port.on('message', (m: CheckpointRequest) => {
    try {
      port.postMessage({ id: m.id, ok: true, value: m.kind === 'restart' ? runRestart(m, state) : runCheckpoint(m, state) } satisfies CheckpointReply)
    } catch (e) {
      port.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies CheckpointReply)
    }
  })
}
