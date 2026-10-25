// The WAL's checkpoints off main's thread (#1633): a writer given to the worker never checkpoints in its commits, the
// worker's checkpoint lets the next write start the WAL again, closing stops it, and a file gone is never made again.
import { existsSync, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'

const { openDb, transaction } = await import('../src/main/db')
const wal = await import('../src/main/walCheckpoint')

const base = tempDir('hive-wal-checkpoint-')
// The longest a wait here waits for what it waits on: a bound for a hung run (tests/README.md).
const HUNG_MS = 10_000
let n = 0
afterAll(() => wal.stopCheckpointWorker())

const MIGRATIONS = [{ version: 1, name: 'rows', up: (db: DatabaseSync) => db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, doc BLOB) STRICT') }]
const open = (checkpointer?: typeof wal.checkpointOffThread) => openDb(join(base, `db-${++n}.db`), { migrations: MIGRATIONS, hiveVersion: 'test', checkpointer })

/** The WAL's checkpoint sequence (its header): it moves on each time a write starts the WAL from its beginning. */
function walRestarts(file: string): number {
  const fd = openSync(`${file}-wal`, 'r')
  try {
    const b = Buffer.alloc(4)
    readSync(fd, b, 0, 4, 12)
    return b.readUInt32BE(0)
  } finally {
    closeSync(fd)
  }
}

/** `commits` small commits of about two pages each. */
function write(db: DatabaseSync, commits: number): void {
  const ins = db.prepare('INSERT INTO t (doc) VALUES (?)')
  for (let i = 0; i < commits; i++) transaction(db, () => ins.run(Buffer.alloc(6000, i % 251)))
}

describe('checkpoints off main (#1633)', () => {
  it("SQLite's own: a commit past 1000 pages checkpoints and the WAL starts again (the behaviour moved off main)", () => {
    const db = open()
    try {
      write(db.writer, 10)
      const before = walRestarts(db.file)
      write(db.writer, 700)
      expect(walRestarts(db.file)).toBeGreaterThan(before)
    } finally {
      db.close()
    }
  })

  it("a writer given to the worker never checkpoints in its commits; the worker's checkpoint lets the next write start the WAL again", async () => {
    const db = open(wal.checkpointOffThread)
    try {
      expect((db.writer.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint).toBe(0)
      expect(wal.checkpointsInCommits(db.writer)).toBe(false)
      write(db.writer, 10)
      const before = walRestarts(db.file)
      write(db.writer, 700)
      expect(walRestarts(db.file)).toBe(before)
      const done = wal.checkpointStats.done
      wal.checkpointRound()
      await vi.waitFor(() => expect(wal.checkpointStats.done).toBeGreaterThan(done), { timeout: HUNG_MS })
      write(db.writer, 1)
      expect(walRestarts(db.file)).toBeGreaterThan(before)
      // The rows are all there, through the reader too.
      expect((db.reader.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c).toBe(711)
    } finally {
      db.close()
    }
    // Closed: no longer the worker's.
    expect(wal.checkpointsInCommits(db.writer)).toBe(true)
  })

  it("a file gone is never made again by the worker's connection", async () => {
    const file = join(base, 'gone.db')
    const writer = new DatabaseSync(':memory:')
    const stop = wal.checkpointOffThread(file, writer)
    try {
      const failed = wal.checkpointStats.failed
      wal.checkpointRound()
      await vi.waitFor(() => expect(wal.checkpointStats.failed).toBeGreaterThan(failed), { timeout: HUNG_MS })
      expect(existsSync(file)).toBe(false)
    } finally {
      stop()
      writer.close()
    }
  })
})
