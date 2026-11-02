// The WAL's checkpoints out of the commits (#1633): a writer given to the idle checkpointer never checkpoints in its
// commits; it is checkpointed once idle (and due), at once when its WAL grows past the bound, or after writes without a
// pause; checkpoints that can't copy the whole WAL give SQLite's own back until one can. Time is passed in: no waits.
import { closeSync, openSync, readSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'

const { openDb, transaction } = await import('../src/main/db')
const wal = await import('../src/main/walCheckpoint')
const { checkpointHooks } = await import('../src/main/walCheckpointWorker')

const base = tempDir('hive-wal-checkpoint-')
let n = 0
const DEFAULTS = { ...wal.checkpointLimits }
afterEach(() => Object.assign(wal.checkpointLimits, DEFAULTS))

const MIGRATIONS = [{ version: 1, name: 'rows', up: (db: DatabaseSync) => db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, doc BLOB) STRICT') }]
const open = (checkpointer?: typeof wal.checkpointWhenIdle) => openDb(join(base, `db-${++n}.db`), { migrations: MIGRATIONS, hiveVersion: 'test', checkpointer })

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

/** The writer's auto-checkpoint setting, as SQLite has it. */
const autoPages = (writer: DatabaseSync): number => (writer.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint

describe('checkpoints out of the commits (#1633)', () => {
  it("SQLite's own: a commit past 1000 pages checkpoints and the WAL starts again (what moves out of the commits)", () => {
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

  it('the idle trigger: never in a commit, nor while writes go on or before it is due; once idle and due, and the next write starts the WAL again', () => {
    // The size trigger out of the way: this WAL grows past 8 MB.
    wal.checkpointLimits.walBytes = 1024 * 1024 * 1024
    const db = open(wal.checkpointWhenIdle)
    try {
      expect(autoPages(db.writer)).toBe(0)
      expect(wal.checkpointsInCommits(db.writer)).toBe(false)
      write(db.writer, 10)
      const before = walRestarts(db.file)
      write(db.writer, 700)
      expect(walRestarts(db.file)).toBe(before)
      const done = wal.checkpointStats.done
      const t = performance.now()
      // Just written: not idle.
      wal.checkpointTick(t)
      // Idle, but its last checkpoint (its opening) too recent.
      wal.checkpointTick(t + wal.checkpointLimits.idleMs)
      expect(wal.checkpointStats.done).toBe(done)
      // Idle and due.
      wal.checkpointTick(t + wal.checkpointLimits.everyMs + wal.checkpointLimits.idleMs)
      expect(wal.checkpointStats.done).toBe(done + 1)
      write(db.writer, 1)
      expect(walRestarts(db.file)).toBeGreaterThan(before)
      // Nothing written since: no other.
      wal.checkpointTick(t + 3 * wal.checkpointLimits.everyMs)
      expect(wal.checkpointStats.done).toBe(done + 1)
      expect((db.reader.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c).toBe(711)
    } finally {
      db.close()
    }
    // Closed: no longer the checkpointer's.
    expect(wal.checkpointsInCommits(db.writer)).toBe(true)
  })

  it('the size trigger: a WAL growing past the bound is checkpointed at once, idle or not', () => {
    wal.checkpointLimits.walBytes = 256 * 1024
    const db = open(wal.checkpointWhenIdle)
    try {
      const t = performance.now()
      wal.checkpointTick(t)
      const done = wal.checkpointStats.done
      write(db.writer, 100)
      wal.checkpointTick(t)
      expect(wal.checkpointStats.done).toBe(done + 1)
      // Written again without growing the file past where it was: not at once.
      write(db.writer, 5)
      wal.checkpointTick(t)
      expect(wal.checkpointStats.done).toBe(done + 1)
    } finally {
      db.close()
    }
  })

  it('written to without a pause: checkpointed once the longest gap has passed', () => {
    // Its registration (its "last checkpoint") falls between t0 and t1, however long the open takes on a loaded machine.
    const t0 = performance.now()
    const db = open(wal.checkpointWhenIdle)
    const t1 = performance.now()
    try {
      const done = wal.checkpointStats.done
      write(db.writer, 5)
      wal.checkpointTick(t0 + wal.checkpointLimits.maxGapMs - 1)
      expect(wal.checkpointStats.done).toBe(done)
      write(db.writer, 5)
      // Just written again (not idle), but past the longest gap since its last checkpoint.
      wal.checkpointTick(t1 + wal.checkpointLimits.maxGapMs)
      expect(wal.checkpointStats.done).toBe(done + 1)
    } finally {
      db.close()
    }
  })

  it('never inside a write under way', () => {
    const db = open(wal.checkpointWhenIdle)
    try {
      write(db.writer, 5)
      const done = wal.checkpointStats.done
      db.writer.exec('BEGIN IMMEDIATE')
      wal.checkpointTick(performance.now() + 10 * wal.checkpointLimits.maxGapMs)
      expect(wal.checkpointStats.done).toBe(done)
      db.writer.exec('COMMIT')
    } finally {
      db.close()
    }
  })

  it("the fallback: checkpoints that can't copy the whole WAL give SQLite its own back; one that can takes it off again", () => {
    wal.checkpointLimits.incomplete = 2
    const db = open(wal.checkpointWhenIdle)
    // A reader on an old snapshot: a checkpoint copies only up to it.
    const reader = new DatabaseSync(db.file)
    try {
      write(db.writer, 5)
      reader.exec('BEGIN')
      reader.prepare('SELECT count(*) FROM t').get()
      write(db.writer, 5)
      const step = wal.checkpointLimits.everyMs + wal.checkpointLimits.idleMs
      let t = performance.now()
      wal.checkpointTick(t)
      wal.checkpointTick((t += step))
      expect(autoPages(db.writer)).toBe(0)
      wal.checkpointTick((t += step))
      expect(autoPages(db.writer)).toBe(1000)
      expect(wal.checkpointsInCommits(db.writer)).toBe(true)
      reader.exec('COMMIT')
      wal.checkpointTick((t += step))
      expect(autoPages(db.writer)).toBe(0)
    } finally {
      reader.close()
      db.close()
    }
  })
  it("a checkpoint that throws counts towards the fallback too, is tried again at the triggers' pace, and one that finishes takes the fallback off (round 4)", () => {
    wal.checkpointLimits.incomplete = 2
    const db = open(wal.checkpointWhenIdle)
    try {
      write(db.writer, 5)
      // SQLite (or the disk) refuses the checkpoint: on its own connection, as the worker runs it (HI-1691).
      checkpointHooks.fail = (file) => file === db.file
      const step = wal.checkpointLimits.everyMs + wal.checkpointLimits.idleMs
      const failed = wal.checkpointStats.failed
      let t = performance.now()
      wal.checkpointTick(t)
      wal.checkpointTick((t += step))
      expect(wal.checkpointStats.failed).toBe(failed + 1)
      expect(autoPages(db.writer)).toBe(0)
      // Not again at the next tick: at the triggers' pace.
      wal.checkpointTick(t + 1000)
      wal.checkpointTick(t + wal.checkpointLimits.everyMs - 1)
      expect(wal.checkpointStats.failed).toBe(failed + 1)
      wal.checkpointTick((t += step))
      expect(wal.checkpointStats.failed).toBe(failed + 2)
      expect(autoPages(db.writer)).toBe(1000)
      expect(wal.checkpointsInCommits(db.writer)).toBe(true)
      // The cause goes: the next checkpoint due finishes, and the fallback goes.
      checkpointHooks.fail = null
      const done = wal.checkpointStats.done
      wal.checkpointTick((t += step))
      expect(wal.checkpointStats.done).toBe(done + 1)
      expect(autoPages(db.writer)).toBe(0)
    } finally {
      checkpointHooks.fail = null
      db.close()
    }
  })
})
