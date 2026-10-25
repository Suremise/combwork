// The WAL's checkpoints off main's thread (#1633): a writer given to the worker never checkpoints in its commits, the
// worker's checkpoint lets the next write start the WAL again, closing stops it, and a file gone is never made again.
import { existsSync, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'

const { DbInUseError, openDb, transaction } = await import('../src/main/db')
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

/** The writer's auto-checkpoint setting, as SQLite has it. */
const autoPages = (writer: DatabaseSync): number => (writer.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint

/** One round, waited for until each of its checkpoints has answered. */
async function round(): Promise<void> {
  wal.checkpointRound()
  await wal.checkpointsSettled()
}

/** Whether another connection could have the file to itself now (Restore the 0.9 Board Backup's sole copy needs it). */
function soleAccess(file: string): boolean {
  const other = new DatabaseSync(file, { timeout: 0 })
  try {
    other.exec('PRAGMA locking_mode = EXCLUSIVE')
    other.exec('BEGIN EXCLUSIVE')
    other.exec('COMMIT')
    return true
  } catch {
    return false
  } finally {
    other.close()
  }
}

describe('falling back to SQLite and back (#1633 round 2)', () => {
  afterEach(() => {
    wal.checkpointGate.hold(false)
    wal.checkpointLimits.hungMs = 60_000
    wal.checkpointLimits.boundFrames = 8000
    wal.checkpointLimits.stopWaitMs = 10_000
  })

  it('checkpoints failing in a row give SQLite its own back, and the first that succeeds takes it off again', async () => {
    const file = join(base, `later-${++n}.db`)
    const writer = new DatabaseSync(':memory:')
    const stop = wal.checkpointOffThread(file, writer)
    try {
      expect(autoPages(writer)).toBe(0)
      // No file yet: each checkpoint fails (and makes none).
      for (let i = 1; i < wal.checkpointLimits.failures; i++) {
        await round()
        expect(autoPages(writer)).toBe(0)
      }
      await round()
      expect(autoPages(writer)).toBe(1000)
      expect(wal.checkpointsInCommits(writer)).toBe(true)
      await round()
      expect(autoPages(writer)).toBe(1000)
      // The file there: the next checkpoint succeeds, and the worker has it again.
      const made = new DatabaseSync(file)
      made.exec('PRAGMA journal_mode = WAL')
      made.exec('CREATE TABLE t (x)')
      made.close()
      await round()
      expect(autoPages(writer)).toBe(0)
    } finally {
      stop()
      writer.close()
    }
  })

  it('the worker ending gives SQLite its own back; the next round starts it again and takes it off', async () => {
    const db = open(wal.checkpointOffThread)
    try {
      await round()
      expect(autoPages(db.writer)).toBe(0)
      await wal.checkpointWorker()!.terminate()
      await vi.waitFor(() => expect(autoPages(db.writer)).toBe(1000), { timeout: HUNG_MS })
      await round()
      expect(autoPages(db.writer)).toBe(0)
      expect(wal.checkpointWorker()).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it('a checkpoint that hangs gives SQLite its own back until it answers', async () => {
    const db = open(wal.checkpointOffThread)
    try {
      write(db.writer, 5)
      wal.checkpointGate.hold('held')
      wal.checkpointRound()
      await vi.waitFor(() => expect(wal.checkpointGate.held()).toBe(true), { timeout: HUNG_MS })
      wal.checkpointLimits.hungMs = 0
      wal.checkpointRound()
      expect(autoPages(db.writer)).toBe(1000)
      wal.checkpointGate.hold(false)
      await wal.checkpointsSettled()
      expect(autoPages(db.writer)).toBe(0)
    } finally {
      db.close()
    }
  })

  it("a WAL a checkpoint can't copy whole past the bound gives SQLite its own back until it can", async () => {
    const db = open(wal.checkpointOffThread)
    // A reader on an old snapshot: the checkpoint copies only up to it.
    const reader = new DatabaseSync(db.file)
    try {
      wal.checkpointLimits.boundFrames = 1
      write(db.writer, 5)
      reader.exec('BEGIN')
      reader.prepare('SELECT count(*) FROM t').get()
      write(db.writer, 5)
      await round()
      expect(autoPages(db.writer)).toBe(1000)
      reader.exec('COMMIT')
      await round()
      expect(autoPages(db.writer)).toBe(0)
    } finally {
      reader.close()
      db.close()
    }
  })

  it("closing a database during its checkpoint returns once the worker's connection is closed (round 2's gate: after the checkpoint, before its close)", async () => {
    const db = open(wal.checkpointOffThread)
    write(db.writer, 20)
    const done = wal.checkpointStats.done
    wal.checkpointGate.hold('held')
    wal.checkpointRound()
    await vi.waitFor(() => expect(wal.checkpointGate.held()).toBe(true), { timeout: HUNG_MS })
    // Checkpointed, its connection still open: nothing says it ended (no reply), and the file isn't free.
    await new Promise((res) => setImmediate(res))
    expect(wal.checkpointStats.done).toBe(done)
    expect(soleAccess(db.file)).toBe(false)
    // The close stops it and returns once its connection is closed.
    db.close()
    expect(soleAccess(db.file)).toBe(true)
    expect(wal.checkpointHolds(db.file)).toBe(false)
    wal.checkpointGate.hold(false)
    await wal.checkpointsSettled()
    expect(wal.checkpointStats.done).toBe(done + 1)
  })

  it("a checkpoint that doesn't stop within the wait: the close throws, and the file stays its, across closes and reopenings, until it ends", async () => {
    const db = open(wal.checkpointOffThread)
    write(db.writer, 20)
    wal.checkpointLimits.stopWaitMs = 50
    wal.checkpointGate.hold('stuck')
    try {
      wal.checkpointRound()
      await vi.waitFor(() => expect(wal.checkpointGate.held()).toBe(true), { timeout: HUNG_MS })
      expect(() => db.close()).toThrow(DbInUseError)
      // Its own connections are closed; the worker's isn't.
      expect(soleAccess(db.file)).toBe(false)
      // Asked again before a replacement or deletion, with nothing of it open: refused.
      expect(() => wal.assertDrained(db.file)).toThrow(DbInUseError)
      // Opened again: its close refuses too, while the old checkpoint holds the file.
      const again = openDb(db.file, { migrations: MIGRATIONS, hiveVersion: 'test', checkpointer: wal.checkpointOffThread })
      expect(() => again.close()).toThrow(DbInUseError)
      wal.checkpointGate.hold(false)
      await vi.waitFor(() => expect(wal.checkpointHolds(db.file)).toBe(false), { timeout: HUNG_MS })
      expect(() => wal.assertDrained(db.file)).not.toThrow()
      expect(soleAccess(db.file)).toBe(true)
    } finally {
      wal.checkpointGate.hold(false)
      await wal.checkpointsSettled()
    }
  })

  it("a checkpoint whose close throws is never taken as closed: the file stays its until its worker has exited", async () => {
    const db = open(wal.checkpointOffThread)
    try {
      write(db.writer, 20)
      const done = wal.checkpointStats.done
      const w = wal.checkpointWorker()!
      const exited = new Promise((res) => w.once('exit', res))
      wal.checkpointGate.hold('closeFails')
      wal.checkpointRound()
      await exited
      wal.checkpointGate.hold(false)
      expect(wal.checkpointStats.done).toBe(done)
      expect(wal.checkpointHolds(db.file)).toBe(false)
      expect(soleAccess(db.file)).toBe(false) // our own connections only: the worker's went with its thread
    } finally {
      db.close()
    }
    expect(soleAccess(db.file)).toBe(true)
  })

  it('a checkpoint still queued when its database closes is never made', async () => {
    const a = open(wal.checkpointOffThread)
    const b = open(wal.checkpointOffThread)
    try {
      write(a.writer, 5)
      write(b.writer, 5)
      wal.checkpointGate.hold('held')
      const skipped = wal.checkpointStats.skipped
      wal.checkpointRound()
      // a's checkpoint is held between its passes; b's waits behind it.
      await vi.waitFor(() => expect(wal.checkpointGate.held()).toBe(true), { timeout: HUNG_MS })
      b.close()
      expect(soleAccess(b.file)).toBe(true)
      wal.checkpointGate.hold(false)
      await wal.checkpointsSettled()
      expect(wal.checkpointStats.skipped).toBe(skipped + 1)
    } finally {
      a.close()
    }
  })
})
