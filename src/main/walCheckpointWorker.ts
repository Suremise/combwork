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

export type CheckpointRequest = { id: number; file: string; closing: number }

/** What SQLite says of a checkpoint (`busy`: it couldn't finish; `checkpointed` of `log` pages), and how long it took. */
export interface CheckpointDone {
  busy: number
  log: number
  checkpointed: number
  ms: number
}

/** A checkpoint's answer: done, or skipped (null: a close began since it was asked for, or the file is gone). */
export type CheckpointReply = { id: number; ok: true; value: CheckpointDone | null } | { id: number; ok: false; error: string }

/** Tests: a checkpoint of these files throws, as one refused by SQLite or the disk would. */
export const checkpointHooks = { fail: null as ((file: string) => boolean) | null }

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

const port = parentPort
if (port) {
  const state = new Int32Array(workerData as SharedArrayBuffer)
  port.on('message', (m: CheckpointRequest) => {
    try {
      port.postMessage({ id: m.id, ok: true, value: runCheckpoint(m, state) } satisfies CheckpointReply)
    } catch (e) {
      port.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies CheckpointReply)
    }
  })
}
