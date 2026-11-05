// The WAL checkpoints' worker (HI-1691): the idle checkpoints #1633 took out of the commits run in a thread of their own,
// on a connection of their own, so the copy and its fsync never hold main's thread. Here: a checkpoint due runs there (its
// answer comes after the tick, and the WAL starts again at the next write). Closing a database never waits for the worker
// (the Assistant's design call after HR6's rounds 1 and 2): what needs the file free awaits checkpointsReleased, which
// resolves once the worker has let go of it (main running on meanwhile), or has ended (HR6's worker that exits during a
// close). One asked for before a close began is skipped; a file gone is never made again.
import { existsSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'

const { openDb, transaction } = await import('../src/main/db')
const wal = await import('../src/main/walCheckpoint')
const { CLOSING, runCheckpoint } = await import('../src/main/walCheckpointWorker')

/** A bound for a hung run (the waits are for conditions). */
const HUNG_MS = 15_000
const base = tempDir('cw-wal-checkpoint-worker-')
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
const open = () => openDb(join(base, `db-${++n}.db`), { migrations: MIGRATIONS, appVersion: 'test', checkpointer: wal.checkpointWhenIdle })
const write = (db: DatabaseSync, commits: number): void => {
  const ins = db.prepare('INSERT INTO t (doc) VALUES (?)')
  for (let i = 0; i < commits; i++) transaction(db, () => ins.run(Buffer.alloc(6000, i % 251)))
}
const walPages = (db: DatabaseSync): number => (db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as { log: number }).log
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
      due()
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
