// The WAL checkpoints' worker (HI-1691): the idle checkpoints #1633 took out of the commits run in a thread of their own,
// on a connection of their own, so the copy and its fsync never hold main's thread. Here: a checkpoint due runs there (its
// answer comes after the tick, and the WAL starts again at the next write). Closing a database never waits for the worker
// (the Assistant's design call after HR6's rounds 1 and 2): what needs the file free awaits checkpointsReleased, which
// resolves once the worker has let go of it (main running on meanwhile), or has ended (HR6's worker that exits during a
// close). One asked for before a close began is skipped; a file gone is never made again.
import { closeSync, existsSync, openSync, readSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import { timing } from './timing.cjs'

const { openDb, transaction } = await import('../src/main/db')
const wal = await import('../src/main/walCheckpoint')
const { CLOSING, runCheckpoint, runRestart } = await import('../src/main/walCheckpointWorker')

/** A bound for a hung run (the waits are for conditions). */
const HUNG_MS = timing('wait.hang')
const base = tempDir('cw-wal-checkpoint-worker-')
const bundle = join(base, 'wal-checkpoint-worker.cjs')
let n = 0
const DEFAULTS = { ...wal.checkpointLimits }

beforeAll(async () => {
  await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'walCheckpointWorker.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
  wal.useCheckpointWorker(bundle)
}, timing('hook.hang'))
afterAll(() => {
  wal.useCheckpointWorker(null)
  Object.assign(wal.checkpointLimits, DEFAULTS)
})

const MIGRATIONS = [{ version: 1, name: 'rows', up: (db: DatabaseSync) => db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, doc BLOB) STRICT') }]
const open = () => openDb(join(base, `db-${++n}.db`), { migrations: MIGRATIONS, appVersion: 'test', checkpointer: wal.checkpointWhenIdle })
const write = (db: DatabaseSync, commits: number): void => {
  const ins = db.prepare('INSERT INTO t (doc) VALUES (?)')
  for (let i = 0; i < commits; i++) transaction(db, () => ins.run(Buffer.alloc(6000, i % 251)))
}
const walPages = (db: DatabaseSync): number => (db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as { log: number }).log
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
/** Asks for a checkpoint of everything registered: due by the idle trigger. */
const due = (): void => {
  const t = performance.now()
  wal.checkpointTick(t)
  wal.checkpointTick(t + wal.checkpointLimits.everyMs + wal.checkpointLimits.idleMs)
}

/**
 * A stand-in for the worker (its protocol: a request in, an answer out once its connection is closed) whose checkpoint
 * holds the file, as on a stalled disk: until `<file>.release` appears, or, with `exitOnClose`, until a close begins
 * (CLOSING moves on), when it lets go and its thread exits without answering (HR6's round 2).
 */
function standIn(name: string, exitOnClose: boolean): string {
  const file = join(base, name)
  writeFileSync(
    file,
    `const { parentPort, workerData } = require('worker_threads')
const { DatabaseSync } = require('node:sqlite')
const fs = require('fs')
const state = new Int32Array(workerData)
const pause = new Int32Array(new SharedArrayBuffer(4))
parentPort.on('message', (m) => {
  const db = new DatabaseSync(m.file, { timeout: 0 })
  db.prepare('SELECT count(*) FROM t').get()
  fs.writeFileSync(m.file + '.holding', '')
  if (${exitOnClose}) {
    while (Atomics.load(state, ${CLOSING}) === m.closing) Atomics.wait(state, ${CLOSING}, m.closing, 50)
    db.close()
    process.exit(23)
  }
  while (!fs.existsSync(m.file + '.release')) Atomics.wait(pause, 0, 0, 20)
  db.close()
  parentPort.postMessage({ id: m.id, ok: true, value: null })
})
`
  )
  return file
}

describe("the WAL checkpoints' worker (HI-1691)", () => {
  it('a checkpoint due runs in the worker: its answer comes after the tick, the whole WAL copied, and the next write starts it again', async () => {
    const db = open()
    try {
      write(db.writer, 20)
      const done = wal.checkpointStats.done
      const restarts = wal.checkpointStats.restarts
      due()
      // Not on main's thread: nothing done yet as the tick returns.
      expect(wal.checkpointStats.done).toBe(done)
      await vi.waitFor(() => expect(wal.checkpointStats.done).toBe(done + 1), { timeout: HUNG_MS })
      // HI-3289: the WAL's first write after it is the worker's too, after the checkpoint's answer; main's writers wait
      // for it (here, as the journal's do, for the write gate).
      await vi.waitFor(() => expect(wal.checkpointStats.restarts).toBe(restarts + 1), { timeout: HUNG_MS })
      await wal.walWritable(db.writer)
      const restarted = walRestarts(db.file)
      // The writer's next write goes on from the WAL's beginning: a few pages, not the twenty commits' forty; and it
      // doesn't start the WAL again itself (the worker did, and synced its header there).
      write(db.writer, 1)
      expect(walPages(db.writer)).toBeLessThan(10)
      expect(walRestarts(db.file)).toBe(restarted)
    } finally {
      db.close()
    }
  })

  it("HI-3362: in the worker too, the restart's own write is no change: idle after it, nothing more is checkpointed or restarted", async () => {
    const db = open()
    try {
      write(db.writer, 5)
      const done = wal.checkpointStats.done
      const restarts = wal.checkpointStats.restarts
      due()
      await vi.waitFor(() => expect(wal.checkpointStats.restarts).toBe(restarts + 1), { timeout: HUNG_MS })
      await wal.walWritable(db.writer)
      // Three cycles of idle ticks, each due; whatever they asked of the worker is answered once it lets go of the file.
      let t = performance.now() + 2 * (wal.checkpointLimits.everyMs + wal.checkpointLimits.idleMs)
      for (let i = 0; i < 3; i++) {
        wal.checkpointTick(t)
        t += wal.checkpointLimits.everyMs + wal.checkpointLimits.idleMs
        wal.checkpointTick(t)
        t += wal.checkpointLimits.everyMs + wal.checkpointLimits.idleMs
        await wal.checkpointsReleased(db.file)
      }
      expect(wal.checkpointStats.done).toBe(done + 1)
      expect(wal.checkpointStats.restarts).toBe(restarts + 1)
    } finally {
      db.close()
    }
  })

  it('a database closed as a checkpoint is asked for: once checkpointsReleased resolves, its file is free', async () => {
    for (let i = 0; i < 5; i++) {
      const db = open()
      write(db.writer, 20)
      due()
      db.close()
      await wal.checkpointsReleased(db.file)
      // Windows refuses to move a file a connection holds: the worker's is closed, or never opened.
      expect(() => renameSync(db.file, `${db.file}.moved`)).not.toThrow()
      expect(existsSync(db.file)).toBe(false)
    }
  })

  it("HI-3414: the worker's connection, kept after its checkpoint and restart, is closed once the database closes: checkpointsReleased waits for that, and the file can be moved", async () => {
    const db = open()
    write(db.writer, 20)
    const restarts = wal.checkpointStats.restarts
    due()
    await vi.waitFor(() => expect(wal.checkpointStats.restarts).toBe(restarts + 1), { timeout: HUNG_MS })
    await wal.walWritable(db.writer)
    // Nothing in flight now, but the worker still holds the file on its kept connection.
    expect(() => renameSync(db.file, `${db.file}.held`)).toThrow()
    db.close()
    await wal.checkpointsReleased(db.file)
    expect(() => renameSync(db.file, `${db.file}.moved`)).not.toThrow()
  })

  it('a checkpoint holding the file: the close returns at once, main runs on while what needs the file waits, and it goes on once the worker lets go', async () => {
    wal.useCheckpointWorker(standIn('holding-worker.cjs', false))
    const db = open()
    try {
      write(db.writer, 20)
      due()
      await vi.waitFor(() => expect(existsSync(`${db.file}.holding`)).toBe(true), { timeout: HUNG_MS })
      db.close()
      // Closed while the worker holds the file: a rename would fail on Windows, so a replace awaits the release.
      expect(existsSync(`${db.file}.release`)).toBe(false)
      let released = false
      const waiting = wal.checkpointsReleased(db.file).then(() => (released = true))
      // Main's own timer ticks meanwhile (a wait on main would stop it); let go only after it has, more than once.
      let ticks = 0
      const tick = setInterval(() => ticks++, 5)
      try {
        await vi.waitFor(() => expect(ticks).toBeGreaterThanOrEqual(5), { timeout: HUNG_MS })
        expect(released).toBe(false)
        writeFileSync(`${db.file}.release`, '')
        await waiting
      } finally {
        clearInterval(tick)
      }
      expect(() => renameSync(db.file, `${db.file}.moved`)).not.toThrow()
    } finally {
      wal.useCheckpointWorker(bundle)
    }
  })

  it("the worker exits during a close without answering (HR6's round 2): checkpointsReleased resolves on its exit, and the file is free", async () => {
    wal.useCheckpointWorker(standIn('exiting-worker.cjs', true))
    const db = open()
    try {
      write(db.writer, 20)
      due()
      await vi.waitFor(() => expect(existsSync(`${db.file}.holding`)).toBe(true), { timeout: HUNG_MS })
      // The close returns at once; the stand-in lets go and exits as CLOSING moves on.
      db.close()
      await wal.checkpointsReleased(db.file)
      expect(() => renameSync(db.file, `${db.file}.moved`)).not.toThrow()
    } finally {
      wal.useCheckpointWorker(bundle)
    }
  })

  it('a checkpoint asked for before a close began is skipped, its file never opened; a file gone is never made', () => {
    const state = new Int32Array(new SharedArrayBuffer(4))
    const db = open()
    try {
      write(db.writer, 5)
      Atomics.add(state, CLOSING, 1)
      expect(runCheckpoint({ id: 1, file: db.file, closing: 0 }, state)).toBeNull()
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

/**
 * A stand-in for the worker (HI-3289) whose checkpoints are real and whose restart takes the file's write lock, writes,
 * and then waits inside its transaction, as on a disk slow to sync: until `<file>.release` appears (then it commits and
 * answers), or, with `exit`, it exits there without answering (the worker ending mid-restart).
 */
function restartStandIn(name: string, exit: boolean): string {
  const file = join(base, name)
  writeFileSync(
    file,
    `const { parentPort } = require('worker_threads')
const { DatabaseSync } = require('node:sqlite')
const fs = require('fs')
const pause = new Int32Array(new SharedArrayBuffer(4))
parentPort.on('message', (m) => {
  const db = new DatabaseSync(m.file, { timeout: 0 })
  if (m.kind !== 'restart') {
    const r = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
    db.close()
    return parentPort.postMessage({ id: m.id, ok: true, value: { busy: r.busy, log: r.log, checkpointed: r.checkpointed, ms: 0 } })
  }
  db.exec('BEGIN IMMEDIATE')
  db.exec('PRAGMA user_version = 0')
  fs.writeFileSync(m.file + '.restarting', '')
  if (${exit}) process.exit(24)
  while (!fs.existsSync(m.file + '.release')) Atomics.wait(pause, 0, 0, 20)
  db.exec('COMMIT')
  db.close()
  parentPort.postMessage({ id: m.id, ok: true, value: { restart: true, busy: false, ms: 0 } })
})
`
  )
  return file
}

/** The board's kind of lock: an async queue (withFileLock), and whether it is held. */
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

describe("the WAL's first write after a checkpoint, in the worker (HI-3289)", () => {
  const insert = (db: DatabaseSync): void => void transaction(db, () => db.prepare('INSERT INTO t (doc) VALUES (?)').run(Buffer.alloc(10)))

  it("while the worker holds the write lock to restart the WAL, main's thread runs on and its writers wait (the gate's and the lock's) until it lets go; one past both is refused", async () => {
    wal.useCheckpointWorker(restartStandIn('restart-pausing-worker.cjs', false))
    const l = lock()
    const db = openDb(join(base, `db-${++n}.db`), { migrations: MIGRATIONS, appVersion: 'test', checkpointer: (f, w) => wal.checkpointWhenIdle(f, w, { hold: l.hold }) })
    let ticks = 0
    const tick = setInterval(() => ticks++, 5)
    try {
      write(db.writer, 20)
      due()
      await vi.waitFor(() => expect(existsSync(`${db.file}.restarting`)).toBe(true), { timeout: HUNG_MS })
      expect(l.held()).toBe(true)
      expect(wal.walGate(db.writer)).not.toBeNull()
      // The journal's kind of writer (the gate) and the board's (its lock), started while the worker holds the file.
      const done: string[] = []
      const gated = wal.walWritable(db.writer).then(() => {
        insert(db.writer)
        done.push('gated')
      })
      const locked = l.hold(async () => {
        insert(db.writer)
        done.push('locked')
      })
      // A write past both would wait for the worker's sync on main: refused, never begun.
      expect(() => insert(db.writer)).toThrow(/began while the checkpoints' worker made its WAL's first write/)
      expect(db.writer.isTransaction).toBe(false)
      // Main's thread runs on meanwhile (a busy wait on main would stop its timer), and neither writer has gone ahead.
      const from = ticks
      await vi.waitFor(() => expect(ticks).toBeGreaterThanOrEqual(from + 5), { timeout: HUNG_MS })
      expect(done).toEqual([])
      writeFileSync(`${db.file}.release`, '')
      await Promise.all([gated, locked])
      expect(done.sort()).toEqual(['gated', 'locked'])
      expect(wal.walGate(db.writer)).toBeNull()
      expect((db.reader.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c).toBe(22)
    } finally {
      clearInterval(tick)
      db.close()
      wal.useCheckpointWorker(bundle)
    }
  })

  it('the worker ending mid-restart opens the gate and lets go of the lock; the next write restarts the WAL itself', async () => {
    wal.useCheckpointWorker(restartStandIn('restart-exiting-worker.cjs', true))
    const l = lock()
    const db = openDb(join(base, `db-${++n}.db`), { migrations: MIGRATIONS, appVersion: 'test', checkpointer: (f, w) => wal.checkpointWhenIdle(f, w, { hold: l.hold }) })
    try {
      write(db.writer, 20)
      due()
      await vi.waitFor(() => expect(existsSync(`${db.file}.restarting`)).toBe(true), { timeout: HUNG_MS })
      // Its thread ended, its connection (and the transaction) with it.
      await vi.waitFor(() => expect(wal.walGate(db.writer)).toBeNull(), { timeout: HUNG_MS })
      await vi.waitFor(() => expect(l.held()).toBe(false), { timeout: HUNG_MS })
      const before = walRestarts(db.file)
      await l.hold(async () => insert(db.writer))
      expect(walRestarts(db.file)).toBeGreaterThan(before)
    } finally {
      db.close()
      wal.useCheckpointWorker(bundle)
    }
  })

  it("a restart's request that can't be sent to the worker (HR1's error path): answered at once, so the gate opens, the lock and the warning's interval are let go, nothing is left in flight, and the next write and restart go through", async () => {
    const l = lock()
    const db = openDb(join(base, `db-${++n}.db`), { migrations: MIGRATIONS, appVersion: 'test', checkpointer: (f, w) => wal.checkpointWhenIdle(f, w, { hold: l.hold }) })
    const WARN_MS = 987_654 // timing-ok: data, not a wait
    const warnMs = wal.closeLimits.warnMs
    wal.closeLimits.warnMs = WARN_MS
    const set = vi.spyOn(globalThis, 'setInterval')
    const cleared = vi.spyOn(globalThis, 'clearInterval')
    let thrown = 0
    try {
      write(db.writer, 20)
      wal.checkpointThreadHooks.beforePost = (kind) => {
        if (kind !== 'restart') return
        thrown++
        throw new Error('DataCloneError (test)')
      }
      const restarts = wal.checkpointStats.restarts
      due()
      await vi.waitFor(() => expect(thrown).toBe(1), { timeout: HUNG_MS })
      await vi.waitFor(() => expect(l.held()).toBe(false), { timeout: HUNG_MS })
      expect(wal.walGate(db.writer)).toBeNull()
      await wal.walWritable(db.writer)
      // The restart's warning interval, cleared.
      const warnings = set.mock.calls.flatMap((c, i) => (c[1] === WARN_MS ? [set.mock.results[i].value] : []))
      expect(warnings).toHaveLength(1)
      expect(cleared).toHaveBeenCalledWith(warnings[0])
      // Nothing of it in flight: what needs the file free goes on at once.
      await wal.checkpointsReleased(db.file)
      expect(wal.checkpointStats.restarts).toBe(restarts)
      wal.checkpointThreadHooks.beforePost = undefined
      await l.hold(async () => insert(db.writer))
      // Later than the first checkpoint's idle mark, which due() set ahead of now.
      const later = performance.now() + 4 * (wal.checkpointLimits.everyMs + wal.checkpointLimits.idleMs)
      wal.checkpointTick(later)
      wal.checkpointTick(later + wal.checkpointLimits.everyMs + wal.checkpointLimits.idleMs)
      await vi.waitFor(() => expect(wal.checkpointStats.restarts).toBe(restarts + 1), { timeout: HUNG_MS })
      await vi.waitFor(() => expect(l.held()).toBe(false), { timeout: HUNG_MS })
      expect((db.reader.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c).toBe(21)
    } finally {
      wal.checkpointThreadHooks.beforePost = undefined
      wal.closeLimits.warnMs = warnMs
      set.mockRestore()
      cleared.mockRestore()
      db.close()
    }
  })

  it('the restart itself: skipped once a close began, never made for a file gone; with another writer holding the lock, skipped at once', () => {
    const state = new Int32Array(new SharedArrayBuffer(4))
    const db = open()
    const other = new DatabaseSync(db.file)
    try {
      write(db.writer, 5)
      Atomics.add(state, CLOSING, 1)
      expect(runRestart({ id: 1, file: db.file, closing: 0, kind: 'restart' }, state)).toBeNull()
      other.exec('BEGIN IMMEDIATE')
      const t = performance.now()
      expect(runRestart({ id: 2, file: db.file, closing: 1, kind: 'restart' }, state)).toMatchObject({ restart: true, busy: true })
      expect(performance.now() - t).toBeLessThan(timing('budget.walCheckpointMs'))
      other.exec('ROLLBACK')
      expect(runRestart({ id: 3, file: db.file, closing: 1, kind: 'restart' }, state)).toMatchObject({ restart: true, busy: false })
    } finally {
      other.close()
      db.close()
    }
    const gone = join(base, 'gone-restart.db')
    expect(runRestart({ id: 4, file: gone, closing: 1, kind: 'restart' }, state)).toBeNull()
    expect(existsSync(gone)).toBe(false)
  })
})
