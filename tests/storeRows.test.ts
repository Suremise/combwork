// The workspace's small stores in its database (#1018, storeRows.ts; sessions and deliveries since #1212): a store's file moved in once and kept as a backup,
// a file found after that kept and never read, saves that write only what changed and are all or nothing, never inside a
// change of the board, and a database from before (the board's schema 1) migrated with its cards kept.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import type { StoreName } from '../src/main/storeRows'

const base = tempDir('hive-store-rows-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// The longest a wait here waits for what it waits on: a bound for a hung run (tests/README.md).
const HUNG_MS = 10_000

const rows = await import('../src/main/storeRows')
const board = await import('../src/main/boardStore')
const { openDb, schemaVersion } = await import('../src/main/db')

let n = 0
/** A new workspace folder (no board yet). */
const workspace = (): string => {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, '.hive'), { recursive: true })
  return ws
}
const docs = (ws: string, store: StoreName, scope = ''): unknown[] => rows.readStore(ws, store, scope).rows.map((r) => JSON.parse(r.doc))
const files = (ws: string): string[] => readdirSync(join(ws, '.hive')).sort()

afterEach(() => {
  rows.storeTestHooks.failSave = null
})
afterAll(() => board.closeAllBoards())

describe("a store's file moved in", () => {
  it('once, in order, with its values; the file kept as a backup, as it was', async () => {
    const ws = workspace()
    const file = join(ws, '.hive', 'lanes.json')
    const text = JSON.stringify({ version: 1, lanes: [{ id: 'b' }, { id: 'a' }] })
    writeFileSync(file, text)
    let reads = 0
    const read = async () => {
      reads++
      const v = JSON.parse(readFileSync(file, 'utf8')) as { lanes: { id: string }[] }
      return { rows: v.lanes.map((l) => ({ key: l.id, doc: JSON.stringify(l) })), meta: { next: '7' } }
    }
    const got = await rows.openStore(ws, 'sessions', '', file, read)
    expect(got.rows.map((r) => r.key)).toEqual(['b', 'a'])
    expect(got.meta.get('next')).toBe('7')
    expect(JSON.parse(got.meta.get('imported')!)).toMatchObject({ rows: 2, file })
    expect(existsSync(file)).toBe(false)
    const backup = files(ws).find((f) => f.startsWith('lanes.json.imported-'))!
    expect(readFileSync(join(ws, '.hive', backup), 'utf8')).toBe(text)
    // Opened again: not read again.
    await rows.openStore(ws, 'sessions', '', file, read)
    expect(reads).toBe(1)
  })

  it('a file found after the move (an older Hive wrote one) is kept as a backup and never read: the database is the store', async () => {
    const ws = workspace()
    const file = join(ws, '.hive', 'watches.json')
    await rows.openStore(ws, 'sessions', '', file, async () => null)
    await rows.saveStore(ws, 'sessions', '', [{ key: 'w1', doc: '{"id":"w1"}' }])
    writeFileSync(file, JSON.stringify({ version: 1, watches: [{ id: 'older' }] }))
    const got = await rows.openStore(ws, 'sessions', '', file, async () => {
      throw new Error('read again')
    })
    expect(got.rows.map((r) => r.key)).toEqual(['w1'])
    expect(existsSync(file)).toBe(false)
    expect(files(ws).filter((f) => f.startsWith('watches.json.imported-'))).toHaveLength(1)
  })

  it('no file: nothing moved in, and marked so it is never looked for again', async () => {
    const ws = workspace()
    const got = await rows.openStore(ws, 'deliveries', 'p-1', join(ws, 'p', '.hive', 'deliveries.json'), async () => null)
    expect(got.rows).toEqual([])
    expect(JSON.parse(got.meta.get('imported')!)).toMatchObject({ rows: 0, file: null })
  })

  it('stores and their scopes are kept apart', async () => {
    const ws = workspace()
    await rows.saveStore(ws, 'deliveries', 'p-1', [{ key: 'm1', doc: '{"a":1}' }])
    await rows.saveStore(ws, 'deliveries', 'assistant', [{ key: 'm1', doc: '{"a":2}' }])
    await rows.saveStore(ws, 'sessions', '', [{ key: 'm1', doc: '{"a":3}' }])
    expect([docs(ws, 'deliveries', 'p-1'), docs(ws, 'deliveries', 'assistant'), docs(ws, 'sessions')]).toEqual([[{ a: 1 }], [{ a: 2 }], [{ a: 3 }]])
  })
})

describe('moving a file in, when it goes wrong (#1018 round 1; lanes.json: storeTables.test.ts)', () => {
  it('two rows of one change with the same key are refused, nothing saved (the second would replace the first)', async () => {
    const ws = workspace()
    await expect(rows.saveStore(ws, 'sessions', '', [{ key: 'k', doc: '1' }, { key: 'k', doc: '2' }])).rejects.toThrow(/same key/)
    await expect(rows.openStore(ws, 'sessions', '', join(ws, '.hive', 'none.json'), async () => ({ rows: [{ key: 'k', doc: '1' }, { key: 'k', doc: '2' }] }))).rejects.toThrow(/same key/)
    expect(rows.readStore(ws, 'sessions').meta.has('imported')).toBe(false)
  })
})

describe('saves', () => {
  it('write only the rows that changed, keep the order given, and remove those left out', async () => {
    const ws = workspace()
    const put = (list: [string, string][]) => rows.saveStore(ws, 'sessions', '', list.map(([key, doc]) => ({ key, doc })))
    await put([['a', '1'], ['b', '2'], ['c', '3']])
    const db = board.workspaceDb(ws).writer
    const before = db.prepare('SELECT total_changes() AS n').get() as { n: number }
    await put([['a', '1'], ['c', '9'], ['b', '2']])
    const after = db.prepare('SELECT total_changes() AS n').get() as { n: number }
    // c changed, and b and c changed places: two rows, nothing else.
    expect(after.n - before.n).toBe(2)
    await put([['c', '9']])
    expect(docs(ws, 'sessions')).toEqual([9])
  })

  it('are all or nothing: one that fails as it is written leaves the rows and values as they were', async () => {
    const ws = workspace()
    await rows.saveStore(ws, 'deliveries', 's', [{ key: 'm1', doc: '"one"' }], { next: '2' })
    rows.storeTestHooks.failSave = (store) => store === 'deliveries'
    await expect(rows.saveStore(ws, 'deliveries', 's', [{ key: 'm2', doc: '"two"' }], { next: '3' })).rejects.toThrow(/SQLITE_FULL/)
    const kept = rows.readStore(ws, 'deliveries', 's')
    expect([kept.rows.map((r) => r.key), kept.meta.get('next')]).toEqual([['m1'], '2'])
  })

  it('a guard that throws stops the save before anything is written (a workspace closed meanwhile)', async () => {
    const ws = workspace()
    await expect(
      rows.saveStore(ws, 'sessions', '', [{ key: 'w', doc: '{}' }], {}, () => {
        throw new Error('The workspace was closed')
      })
    ).rejects.toThrow(/closed/)
    expect(docs(ws, 'sessions')).toEqual([])
  })

  it("never run inside a change of the board (they'd wait for its lock): refused there; outside, they wait for it", async () => {
    const ws = workspace()
    const w = { path: ws } as never
    await expect(board.boardWrite(w, () => rows.saveStore(ws, 'sessions', '', []))).rejects.toThrow(/inside a change of the board/)
    // A save while the board's change is under way waits for its commit, then goes in a transaction of its own.
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const change = board.boardWrite(w, async () => {
      board.boardChanged(w)
      await held
    })
    const save = rows.saveStore(ws, 'sessions', '', [{ key: 'l', doc: '1' }])
    await expect.poll(() => board.workspaceDb(ws).writer.isTransaction, { timeout: HUNG_MS }).toBe(true)
    expect(docs(ws, 'sessions')).toEqual([])
    release()
    await Promise.all([change, save])
    expect(docs(ws, 'sessions')).toEqual([1])
  })
})

describe('the workspace database from before (#1017: schema 1)', () => {
  it('gets the stores tables (schema 2), its cards kept, after a backup', () => {
    const ws = workspace()
    const file = join(ws, '.hive', 'hive.db')
    const v1 = openDb(file, { migrations: board.BOARD_MIGRATIONS.slice(0, 1), hiveVersion: '0.9.0' })
    v1.writer.prepare('INSERT INTO cards (number, doc) VALUES (1, ?)').run(JSON.stringify({ number: 1, title: 'Kept', column: 'todo' }))
    v1.close()
    // 0.9's steps (the 1.0 group's have their own tests: boardUpgrade.test.ts).
    const db = openDb(file, { migrations: board.BOARD_MIGRATIONS.filter((m) => !m.group), hiveVersion: '0.9.0', backupDir: join(ws, '.hive', 'backups') })
    try {
      expect(schemaVersion(db.writer)).toBe(2)
      expect((db.reader.prepare('SELECT count(*) AS n FROM cards').get() as { n: number }).n).toBe(1)
      expect(readdirSync(join(ws, '.hive', 'backups')).some((f) => f.startsWith('hive-v1-'))).toBe(true)
      expect(db.reader.prepare("SELECT name FROM sqlite_master WHERE name IN ('store_rows', 'store_meta') ORDER BY name").all().map((r) => (r as { name: string }).name)).toEqual(['store_meta', 'store_rows'])
    } finally {
      db.close()
    }
    const check = new DatabaseSync(file, { readOnly: true })
    expect({ ...(check.prepare('SELECT max(version) AS v FROM schema_version').get() as object) }).toEqual({ v: 2 })
    check.close()
  })
})
