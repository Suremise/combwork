// The WAL's checkpoints out of the commits (#1633): a writer given to the idle checkpointer never checkpoints in its
// commits; it is checkpointed once idle (and due), at once when its WAL grows past the bound, or after writes without a
// pause; checkpoints that can't copy the whole WAL give SQLite's own back until one can. Time is passed in: no waits.
import { closeSync, openSync, readSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'

/** A bound for a hung run only: each wait polls for its condition (tests/README.md). */
const HUNG_MS = 10_000

const { openDb, transaction } = await import('../src/main/db')
const wal = await import('../src/main/walCheckpoint')
const { checkpointHooks } = await import('../src/main/walCheckpointWorker')

const base = tempDir('cw-wal-checkpoint-')
let n = 0
const DEFAULTS = { ...wal.checkpointLimits }
afterEach(() => Object.assign(wal.checkpointLimits, DEFAULTS))

const MIGRATIONS = [{ version: 1, name: 'rows', up: (db: DatabaseSync) => db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, doc BLOB) STRICT') }]
const open = (checkpointer?: typeof wal.checkpointWhenIdle) => openDb(join(base, `db-${++n}.db`), { migrations: MIGRATIONS, appVersion: 'test', checkpointer })

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

// HI-3289: the first write after a whole checkpoint starts the WAL again and syncs its new header, on whichever thread
// writes first; the checkpointer makes that write itself (the worker's runRestart, here in-process), under the
// database's lock (`hold`) with its write gate closed meanwhile, so main's next commit is an ordinary one.
describe("the WAL's first write after a checkpoint is the checkpointer's (HI-3289)", () => {
  afterEach(() => {
    checkpointHooks.inRestart = null
    checkpointHooks.fail = null
  })
  /** A checkpoint due now (the idle trigger), for every database registered. */
  const due = (): void => {
    const t = performance.now()
    wal.checkpointTick(t)
    wal.checkpointTick(t + wal.checkpointLimits.everyMs + wal.checkpointLimits.idleMs)
  }
  /** The board's kind of lock: an async queue (withFileLock), with what waits on it. */
  function lock(): { hold: (fn: () => Promise<void>) => Promise<void>; held: () => boolean } {
    let tail: Promise<unknown> = Promise.resolve()
    let held = false
    const hold = (fn: () => Promise<void>): Promise<void> => {
      const run = tail.then(async () => {
        held = true
        try {
          await fn()
        } finally {
          held = false
        }
      })
      tail = run.catch(() => undefined)
      return run
    }
    return { hold, held: () => held }
  }

  it("restarts the WAL as the checkpoint finishes: the writer's next commit doesn't, and its data is the same", () => {
    const db = open(wal.checkpointWhenIdle)
    try {
      write(db.writer, 5)
      const before = walRestarts(db.file)
      const restarts = wal.checkpointStats.restarts
      due()
      expect(wal.checkpointStats.restarts).toBe(restarts + 1)
      // The checkpointer's write started the WAL again, its header synced there.
      const after = walRestarts(db.file)
      expect(after).toBeGreaterThan(before)
      write(db.writer, 3)
      expect(walRestarts(db.file)).toBe(after)
      expect((db.reader.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c).toBe(8)
      expect((db.reader.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0)
    } finally {
      db.close()
    }
  })

  it('a write begun on main since the checkpoint restarts the WAL itself: the checkpointer makes none then', async () => {
    const l = lock()
    const db = open((f, w) => wal.checkpointWhenIdle(f, w, { hold: l.hold }))
    try {
      write(db.writer, 5)
      // A change holds the lock as the checkpoint finishes: the restart waits for it, and its write goes first.
      let release = (): void => undefined
      const change = l.hold(() => new Promise<void>((r) => (release = r)))
      await vi.waitFor(() => expect(l.held()).toBe(true), { timeout: HUNG_MS })
      const restarts = wal.checkpointStats.restarts
      const before = walRestarts(db.file)
      due()
      write(db.writer, 1)
      expect(walRestarts(db.file)).toBeGreaterThan(before)
      release()
      await change
      await vi.waitFor(() => expect(l.held()).toBe(false), { timeout: HUNG_MS })
      expect(wal.checkpointStats.restarts).toBe(restarts)
    } finally {
      db.close()
    }
  })

  it("runs under the database's lock with its write gate closed: writers wait for it without holding the thread, and a BEGIN past both is refused", async () => {
    const l = lock()
    const db = open((f, w) => wal.checkpointWhenIdle(f, w, { hold: l.hold }))
    try {
      write(db.writer, 5)
      const order: string[] = []
      let refused: unknown = null
      let gated: Promise<void> | null = null
      let queued: Promise<void> | null = null
      checkpointHooks.inRestart = (file) => {
        if (file !== db.file) return
        order.push('restart')
        expect(l.held()).toBe(true)
        // A writer that awaits the gate (the journal's), and one that takes the lock (the board's): both wait.
        gated = wal.walWritable(db.writer).then(() => {
          order.push('gated')
          transaction(db.writer, () => db.writer.prepare('INSERT INTO t (doc) VALUES (?)').run(Buffer.alloc(10)))
        })
        queued = l.hold(async () => {
          order.push('locked')
          transaction(db.writer, () => db.writer.prepare('INSERT INTO t (doc) VALUES (?)').run(Buffer.alloc(10)))
        })
        // One past both would wait for the restart's sync on main: refused, never begun.
        try {
          transaction(db.writer, () => db.writer.prepare('INSERT INTO t (doc) VALUES (?)').run(Buffer.alloc(10)))
        } catch (e) {
          refused = e
        }
        expect(db.writer.isTransaction).toBe(false)
      }
      due()
      await vi.waitFor(() => expect(order).toContain('restart'), { timeout: HUNG_MS })
      await gated
      await queued
      expect(order.slice(0, 1)).toEqual(['restart'])
      expect(order).toEqual(expect.arrayContaining(['gated', 'locked']))
      expect(String(refused)).toMatch(/began while the checkpoints' worker made its WAL's first write/)
      expect(wal.walGate(db.writer)).toBeNull()
      expect((db.reader.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c).toBe(7)
    } finally {
      db.close()
    }
  })

  it("a close while the restart holds the write lock is told so (its optional PRAGMA optimize is skipped, never waited for); otherwise it isn't", () => {
    let stop: (() => boolean) | null = null
    const db = open((f, w) => (stop = wal.checkpointWhenIdle(f, w)))
    write(db.writer, 5)
    let during: boolean | null = null
    checkpointHooks.inRestart = (file) => {
      if (file === db.file) during = stop!()
    }
    due()
    expect(during).toBe(true)
    db.close()
    const db2 = open((f, w) => (stop = wal.checkpointWhenIdle(f, w)))
    expect(stop!()).toBe(false)
    db2.close()
  })

  it('another connection holding the write lock: skipped, never waited for, and the gate opens', () => {
    const db = open(wal.checkpointWhenIdle)
    const other = new DatabaseSync(db.file)
    try {
      write(db.writer, 5)
      // Taken as the checkpoint finishes, as another process's writer might.
      checkpointHooks.inRestart = null
      const skipped = wal.checkpointStats.restartsSkipped
      const t = performance.now()
      wal.checkpointTick(t)
      other.exec('BEGIN IMMEDIATE')
      wal.checkpointTick(t + wal.checkpointLimits.everyMs + wal.checkpointLimits.idleMs)
      other.exec('ROLLBACK')
      expect(wal.checkpointStats.restartsSkipped).toBe(skipped + 1)
      expect(wal.walGate(db.writer)).toBeNull()
      // The writer's own commit restarts it then, as before.
      const before = walRestarts(db.file)
      write(db.writer, 1)
      expect(walRestarts(db.file)).toBeGreaterThan(before)
    } finally {
      other.close()
      db.close()
    }
  })

  it("a throw before the restart is answered (its worker can't be started: HR1's error path), with the lock or without: the gate opens, the lock and the warning's interval are let go, and the next write and restart go through", async () => {
    const WARN_MS = 987_653
    const warnMs = wal.closeLimits.warnMs
    wal.closeLimits.warnMs = WARN_MS
    const set = vi.spyOn(globalThis, 'setInterval')
    const cleared = vi.spyOn(globalThis, 'clearInterval')
    let thrown = 0
    wal.checkpointThreadHooks.beforeDispatch = (kind) => {
      if (kind !== 'restart') return
      thrown++
      throw new Error('worker creation failed (test)')
    }
    const l = lock()
    const held = open((f, w) => wal.checkpointWhenIdle(f, w, { hold: l.hold }))
    const bare = open(wal.checkpointWhenIdle)
    try {
      write(held.writer, 5)
      write(bare.writer, 5)
      const restarts = wal.checkpointStats.restarts
      // The bare one's (no lock) runs in the tick: its throw doesn't escape it.
      expect(() => due()).not.toThrow()
      await vi.waitFor(() => expect(thrown).toBe(2), { timeout: HUNG_MS })
      await vi.waitFor(() => expect(l.held()).toBe(false), { timeout: HUNG_MS })
      for (const db of [held, bare]) {
        expect(wal.walGate(db.writer)).toBeNull()
        await wal.walWritable(db.writer)
      }
      const warnings = set.mock.calls.flatMap((c, i) => (c[1] === WARN_MS ? [set.mock.results[i].value] : []))
      expect(warnings).toHaveLength(2)
      for (const h of warnings) expect(cleared).toHaveBeenCalledWith(h)
      expect(wal.checkpointStats.restarts).toBe(restarts)
      // Nothing left in flight: the next write goes through, and the next checkpoint's restart is made.
      wal.checkpointThreadHooks.beforeDispatch = undefined
      await l.hold(async () => void transaction(held.writer, () => held.writer.prepare('INSERT INTO t (doc) VALUES (?)').run(Buffer.alloc(10))))
      write(bare.writer, 1)
      // Later than the first checkpoint's idle mark, which due() set ahead of now.
      const later = performance.now() + 4 * (wal.checkpointLimits.everyMs + wal.checkpointLimits.idleMs)
      wal.checkpointTick(later)
      wal.checkpointTick(later + wal.checkpointLimits.everyMs + wal.checkpointLimits.idleMs)
      await vi.waitFor(() => expect(wal.checkpointStats.restarts).toBe(restarts + 2), { timeout: HUNG_MS })
      await vi.waitFor(() => expect(l.held()).toBe(false), { timeout: HUNG_MS })
    } finally {
      wal.checkpointThreadHooks.beforeDispatch = undefined
      wal.closeLimits.warnMs = warnMs
      set.mockRestore()
      cleared.mockRestore()
      held.close()
      bare.close()
    }
  })

  it('a restart that throws opens the gate and lets go of the lock; a database closed while it waits for the lock makes none', async () => {
    const l = lock()
    const db = open((f, w) => wal.checkpointWhenIdle(f, w, { hold: l.hold }))
    try {
      write(db.writer, 5)
      checkpointHooks.inRestart = (file) => {
        if (file === db.file) throw new Error('disk I/O error (test)')
      }
      due()
      await vi.waitFor(() => expect(l.held()).toBe(false), { timeout: HUNG_MS })
      expect(wal.walGate(db.writer)).toBeNull()
      // The lock is free: a change takes it at once.
      await l.hold(async () => void transaction(db.writer, () => db.writer.prepare('INSERT INTO t (doc) VALUES (?)').run(Buffer.alloc(10))))
    } finally {
      db.close()
    }
    const l2 = lock()
    const db2 = open((f, w) => wal.checkpointWhenIdle(f, w, { hold: l2.hold }))
    let release = (): void => undefined
    const change = l2.hold(() => new Promise<void>((r) => (release = r)))
    await vi.waitFor(() => expect(l2.held()).toBe(true), { timeout: HUNG_MS })
    const restarts = wal.checkpointStats.restarts
    try {
      write(db2.writer, 5)
      due()
    } finally {
      db2.close()
    }
    release()
    await change
    await vi.waitFor(() => expect(l2.held()).toBe(false), { timeout: HUNG_MS })
    expect(wal.checkpointStats.restarts).toBe(restarts)
  })
})
