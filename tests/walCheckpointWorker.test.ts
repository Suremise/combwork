// The WAL checkpoints' worker (HI-1691): the idle checkpoints #1633 took out of the commits run in a thread of their own,
// on a connection of their own, so the copy and its fsync never hold main's thread. Here: a checkpoint due runs there
// (its answer comes after the tick, and the WAL starts again at the next write); a database closing waits for the
// worker to let go of the file, so it can be moved at once (Windows refuses a file another connection holds); one asked
// for before a close began is skipped; a file gone is never made again.
import { existsSync, renameSync } from 'fs'
import { join } from 'path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'

const { openDb, transaction } = await import('../src/main/db')
const wal = await import('../src/main/walCheckpoint')
const { BUSY, CLOSING, runCheckpoint } = await import('../src/main/walCheckpointWorker')

/** A bound for a hung run (the waits are for conditions). */
const HUNG_MS = 15_000
const base = tempDir('hive-wal-checkpoint-worker-')
const bundle = join(base, 'wal-checkpoint-worker.cjs')
let n = 0
const DEFAULTS = { ...wal.checkpointLimits }

beforeAll(async () => {
  await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'walCheckpointWorker.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
  wal.useCheckpointWorker(bundle)
}, 60_000)
afterAll(() => {
  wal.useCheckpointWorker(null)
  Object.assign(wal.checkpointLimits, DEFAULTS)
})

const MIGRATIONS = [{ version: 1, name: 'rows', up: (db: DatabaseSync) => db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, doc BLOB) STRICT') }]
const open = () => openDb(join(base, `db-${++n}.db`), { migrations: MIGRATIONS, hiveVersion: 'test', checkpointer: wal.checkpointWhenIdle })
const write = (db: DatabaseSync, commits: number): void => {
  const ins = db.prepare('INSERT INTO t (doc) VALUES (?)')
  for (let i = 0; i < commits; i++) transaction(db, () => ins.run(Buffer.alloc(6000, i % 251)))
}
const walPages = (db: DatabaseSync): number => (db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as { log: number }).log

describe("the WAL checkpoints' worker (HI-1691)", () => {
  it('a checkpoint due runs in the worker: its answer comes after the tick, the whole WAL copied, and the next write starts it again', async () => {
    const db = open()
    try {
      write(db.writer, 20)
      const done = wal.checkpointStats.done
      const t = performance.now()
      wal.checkpointTick(t)
      wal.checkpointTick(t + wal.checkpointLimits.everyMs + wal.checkpointLimits.idleMs)
      // Not on main's thread: nothing done yet as the tick returns.
      expect(wal.checkpointStats.done).toBe(done)
      await vi.waitFor(() => expect(wal.checkpointStats.done).toBe(done + 1), { timeout: HUNG_MS })
      // The writer's next write starts the WAL from its beginning: a few pages, not the twenty commits' forty.
      write(db.writer, 1)
      expect(walPages(db.writer)).toBeLessThan(10)
    } finally {
      db.close()
    }
  })

  it('a database closing as a checkpoint is asked for: its file is free the moment the close returns', () => {
    for (let i = 0; i < 5; i++) {
      const db = open()
      write(db.writer, 20)
      const t = performance.now()
      wal.checkpointTick(t)
      wal.checkpointTick(t + wal.checkpointLimits.everyMs + wal.checkpointLimits.idleMs)
      db.close()
      // Windows refuses to move a file a connection holds: the worker's is closed, or never opened.
      expect(() => renameSync(db.file, `${db.file}.moved`)).not.toThrow()
      expect(existsSync(db.file)).toBe(false)
    }
  })

  it('a checkpoint asked for before a close began is skipped, its file never opened; a file gone is never made', () => {
    const state = new Int32Array(new SharedArrayBuffer(8))
    const db = open()
    try {
      write(db.writer, 5)
      Atomics.add(state, CLOSING, 1)
      expect(runCheckpoint({ id: 1, file: db.file, closing: 0 }, state)).toBeNull()
      expect(Atomics.load(state, BUSY)).toBe(0)
      // Asked for since: it runs.
      expect(runCheckpoint({ id: 2, file: db.file, closing: 1 }, state)).toMatchObject({ busy: 0 })
    } finally {
      db.close()
    }
    const gone = join(base, 'gone.db')
    expect(runCheckpoint({ id: 3, file: gone, closing: 1 }, state)).toBeNull()
    expect(existsSync(gone)).toBe(false)
  })
})
