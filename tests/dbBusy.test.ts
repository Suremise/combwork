// HI-3374, rows 4-6: a database connection opened by openDb waits for another connection's write lock for
// cw.db.busySeconds (dbLimits.busyMs, 15 s by default) before its write is refused. Another process is a worker thread
// here, holding the lock on a connection of its own and letting go 8 s after the waiting write has begun (its own timer:
// the test's thread is blocked inside that write). The order of what happened is kept and checked, never assumed.
import { join } from 'path'
import { Worker } from 'worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'

const { openDb, transaction, dbLimits, setDbBusyMs } = await import('../src/main/db')

/** A bound for a hung run only (a worker that never answers). */
const HUNG_MS = 60_000
const DEFAULT = dbLimits.busyMs
afterEach(() => setDbBusyMs(DEFAULT))

const MIGRATIONS = [{ version: 1, name: 'rows', up: (db: DatabaseSync) => db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) STRICT') }]
let n = 0

/** A message to a worker thread: its postMessage's second argument is a transfer list (no target origin: that is a window's). */
const tell = (w: Worker, m: string): void => w.postMessage(m, [])

/** Another "process" holding `file`'s write lock: it says `held`, and lets go `holdMs` after it is told `writing`. */
function holder(file: string, holdMs: number) {
  const w = new Worker(
    `const { parentPort, workerData } = require('worker_threads')
     const { DatabaseSync } = require('node:sqlite')
     const db = new DatabaseSync(workerData.file)
     db.exec('BEGIN IMMEDIATE')
     db.exec("INSERT INTO t (v) VALUES ('holder')")
     parentPort.postMessage({ held: Date.now() })
     parentPort.once('message', () => setTimeout(() => {
       db.exec('ROLLBACK')
       db.close()
       parentPort.postMessage({ released: Date.now() })
     }, workerData.holdMs))`,
    { eval: true, workerData: { file, holdMs } }
  )
  const seen: Record<string, number> = {}
  const next = (key: 'held' | 'released'): Promise<number> =>
    new Promise((res, rej) => {
      if (seen[key]) return res(seen[key])
      const t = setTimeout(() => rej(new Error(`the holder didn't say ${key}`)), HUNG_MS)
      const on = (m: Record<string, number>): void => {
        Object.assign(seen, m)
        if (m[key]) {
          clearTimeout(t)
          w.off('message', on)
          res(m[key])
        }
      }
      w.on('message', on)
    })
  const exited = new Promise<number>((res) => w.once('exit', res))
  return { w, next, exited, seen }
}

describe("a write waits for another program's lock, as long as cw.db.busySeconds says (HI-3374)", () => {
  it('by default (15 s): a lock let go 8 s after the write began lets it through; it really waited for it', async () => {
    expect(DEFAULT).toBe(15_000)
    const db = openDb(join(tempDir('cw-db-busy-'), `busy-${++n}.db`), { migrations: MIGRATIONS, appVersion: 'test' })
    try {
      const h = holder(db.file, 8000)
      await h.next('held')
      // Told just before the write blocks: its 8 s start now.
      tell(h.w, 'writing')
      const began = Date.now()
      transaction(db.writer, () => db.writer.prepare("INSERT INTO t (v) VALUES ('mine')").run())
      const ended = Date.now()
      const released = await h.next('released')
      expect(await h.exited).toBe(0)
      // The write began before the lock was let go and ended after: it met the lock and waited for it.
      expect(began).toBeLessThan(released)
      expect(ended).toBeGreaterThanOrEqual(released)
      expect(db.reader.prepare('SELECT v FROM t').all()).toEqual([{ v: 'mine' }])
    } finally {
      db.close()
    }
  }, HUNG_MS)

  it('set shorter (2 s): a lock kept longer refuses the write whole, nothing of it written', async () => {
    setDbBusyMs(2000)
    const db = openDb(join(tempDir('cw-db-busy-'), `busy-${++n}.db`), { migrations: MIGRATIONS, appVersion: 'test' })
    try {
      const h = holder(db.file, 8000)
      await h.next('held')
      tell(h.w, 'writing')
      const began = Date.now()
      expect(() => transaction(db.writer, () => {
        db.writer.prepare("INSERT INTO t (v) VALUES ('a')").run()
        db.writer.prepare("INSERT INTO t (v) VALUES ('b')").run()
      })).toThrow(/locked|busy/i)
      const refusedAt = Date.now()
      const released = await h.next('released')
      expect(await h.exited).toBe(0)
      // Refused at its own bound, before the holder let go.
      expect(refusedAt - began).toBeGreaterThanOrEqual(1900)
      expect(refusedAt).toBeLessThan(released)
      expect(db.reader.prepare('SELECT count(*) AS c FROM t').get()).toEqual({ c: 0 })
    } finally {
      db.close()
    }
  }, HUNG_MS)
})
