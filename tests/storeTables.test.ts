// Lanes, watches and metrics in hive.db's typed tables (#1212): each entry written in columns and read back equal as
// JSON, an odd one kept whole, the 1.0 step moving 0.9's store_rows in (order, values, entries no row can hold kept aside),
// saves that write only what changed and are all or nothing, 0.8's lanes.json moved in once, and a copy of a live board
// migrated with every lane, watch and metric equal (HIVE_STORE_MIGRATION_DB names its hive.db).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { canonical, entryOfRows, moveStores, readEntries, rowsOfEntry, STORES_STEP, TABLE_DEFS, TABLE_STORES, type TableStore } from '../src/main/schema/storeCodec'

const base = tempDir('hive-store-tables-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
afterAll(() => rmSync(base, { recursive: true, force: true }))

const tables = await import('../src/main/storeTables')
const board = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const { openDb } = await import('../src/main/db')
const { admit, dismiss: dismissPlace } = await import('../src/main/openingFence')
const { placeKey } = await import('../src/main/fsutil')
const dismiss = (ws: string): void => dismissPlace(placeKey(ws))

let n = 0
/** A new workspace folder (its board made at the first use: every step, the 1.0 group's included), a window's (#1395). */
const dismissals: (() => void)[] = []
const workspace = (): string => {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, '.hive'), { recursive: true })
  dismissals.push(admitted(ws))
  return ws
}
const files = (ws: string): string[] => readdirSync(join(ws, '.hive')).sort()
/** Its window closes it: dismissed (#1395), then its board closed, as WorkspaceService.close does; `reopen` opens it again. */
const closed = (ws: string): void => {
  dismiss(ws)
  board.closeBoard(ws)
}
const reopen = (ws: string): void => {
  admit(placeKey(ws))
  board.workspaceDb(ws)
}

afterEach(() => {
  tables.tableTestHooks.failSave = null
})
afterAll(() => {
  board.closeAllBoards()
  for (const d of dismissals.splice(0)) d()
})

const LANE = {
  id: 'lane-1',
  project: 'hive',
  projectId: 'p-abc',
  name: 'P3 D',
  builder: { id: 'a-b6', name: 'HB6' },
  reviewer: { id: 'a-r6', name: 'HR6' },
  cards: [1220, 1212],
  rounds: 10,
  waitMinutes: 360,
  state: 'ended',
  startedBy: 'HB6',
  startedAt: '2026-10-20T14:00:00.000Z',
  updatedAt: '2026-10-20T15:00:00.000Z',
  endedAt: '2026-10-20T15:00:00.000Z',
  mergeCommit: '5831d5c6',
  frozen: [
    { number: 1220, title: 'Runs', column: 'done', blocked: null, round: 3, reviewing: false },
    { number: 1212, title: 'Stores', column: 'doing', blocked: 'waits', round: 1, reviewing: true }
  ]
}
const WATCH = {
  id: 'w-1',
  projectPath: 'D:\\ws\\hive',
  projectId: 'p-abc',
  agentId: 'a-b6',
  cond: { cards: [1220, 1220, 1212], changes: ['verdict', 'column'], column: 'passed' },
  marks: { '1220': { column: 'review', verdicts: 1 } },
  since: '2026-10-20T14:00:00.000Z',
  seen: { '1220': { history: 3, comments: 2 } },
  limitMinutes: 360,
  limitAt: '2026-10-20T20:00:00.000Z',
  waitSeq: 4,
  on: { '1220': 'agent' },
  watcherName: 'HB6 (hive)',
  fired: { line: '[CW] …', at: '2026-10-20T15:00:00.000Z', cards: [1220], delivery: 'm12' }
}
/** A bucket with a project named like Object's own properties, as the store keeps them (maps with no prototype). */
const bucket = (start: number) => {
  const d = <T>(o: Record<string, T>): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, o)
  const part = (key: string) => ({ api: d({ [key]: { count: 2, ms: [1, 2] } }), mcp: d({}), guidance: d({ claude: { launches: 1 } }), catalog: d({}) })
  const projects = Object.create(null) as Record<string, unknown>
  Object.defineProperty(projects, '__proto__', { value: part('GET /v1/tasks'), enumerable: true, writable: true, configurable: true })
  projects.hive = part('POST /v1/progress')
  return { start, span: 'hour', projects, workspace: part('GET /v1/projects'), skills: { scans: { count: 0 }, hits: 1 }, dropped: 2, droppedBy: { hive: 2 }, series: 5 }
}
const roundTrip = (store: TableStore, doc: unknown) => {
  const def = TABLE_DEFS[store]
  const e = rowsOfEntry(def, doc, store === 'metrics' ? 'hour:0' : (doc as { id: string }).id, 0)
  return { back: entryOfRows(def, e.main, e.children), whole: typeof e.main.extra === 'string' && e.main.extra.startsWith('['), e }
}

describe('entries as rows, and back (#1212)', () => {
  it('a lane, a watch and a metrics bucket go in columns and read back equal as JSON', () => {
    for (const [store, doc] of [['lanes', LANE], ['lanes', { ...LANE, reviewer: null, frozen: undefined, projectId: undefined, endedAt: null, state: 'active', mergeCommit: null }], ['watches', WATCH], ['watches', { ...WATCH, fired: null, projectId: undefined }], ['metrics', bucket(3_600_000)]] as [TableStore, unknown][]) {
      const plain = JSON.parse(JSON.stringify(doc))
      const r = roundTrip(store, plain)
      expect({ store, whole: r.whole }).toEqual({ store, whole: false })
      expect(canonical(r.back)).toBe(canonical(plain))
    }
    // The columns hold what is queried: a lane's builder and state, its cards; a watch's agent, limit and delivery, its cards once each.
    expect(roundTrip('lanes', LANE).e.main).toMatchObject({ builder_id: 'a-b6', state: 'ended', extra: null })
    expect(roundTrip('lanes', LANE).e.children.lane_cards.map((r) => r.card)).toEqual([1220, 1212])
    expect(roundTrip('watches', WATCH).e.main).toMatchObject({ agent_id: 'a-b6', limit_at: WATCH.limitAt, fired_delivery: 'm12' })
    expect(roundTrip('watches', WATCH).e.children.watch_cards.map((r) => r.card)).toEqual([1220, 1212])
    expect(roundTrip('metrics', JSON.parse(JSON.stringify(bucket(0)))).e.children.metrics_series).toHaveLength(6)
  })

  it("a project named __proto__ stays a project's name (no prototype is set), as the store's maps keep it", () => {
    const r = roundTrip('metrics', JSON.parse(JSON.stringify(bucket(0))))
    const projects = (r.back as { projects: Record<string, unknown> }).projects
    expect(Object.keys(projects).sort()).toEqual(['__proto__', 'hive'])
    expect(Object.getPrototypeOf(projects)).toBeNull()
  })

  it('fields this build has no column for go in extra; an entry its columns would change is kept whole, unchanged', () => {
    const newer = { ...LANE, laterField: { x: 1 } }
    expect(roundTrip('lanes', newer)).toMatchObject({ whole: false, back: newer })
    expect(roundTrip('lanes', newer).e.main.extra).toBe('{"laterField":{"x":1}}')
    // A state no column takes, a builder with more to it, a number that isn't whole, a field the store never writes as null.
    for (const odd of [{ ...LANE, state: 'running' }, { ...LANE, builder: { id: 'a', name: 'b', more: 1 } }, { ...LANE, rounds: 1.5 }, { ...LANE, projectId: null }, { id: 'x' }, { ...WATCH, cond: undefined }, { ...WATCH, waitSeq: 'four' }]) {
      const store: TableStore = 'cond' in odd || 'agentId' in odd ? 'watches' : 'lanes'
      const r = roundTrip(store, JSON.parse(JSON.stringify(odd)))
      expect(r.whole).toBe(true)
      expect(canonical(r.back)).toBe(canonical(JSON.parse(JSON.stringify(odd))))
    }
    // A bucket with a family Hive doesn't know, or a project named '' (the workspace's own part).
    for (const odd of [{ ...bucket(0), workspace: { api: {}, mcp: {}, guidance: {}, catalog: {}, later: {} } }, { ...bucket(0), projects: { '': { api: {}, mcp: {}, guidance: {}, catalog: {} } } }]) {
      const plain = JSON.parse(JSON.stringify(odd))
      expect(roundTrip('metrics', plain)).toMatchObject({ whole: true })
      expect(canonical(roundTrip('metrics', plain).back)).toBe(canonical(plain))
    }
  })
})

/** A 0.9 board's file (every step before the 1.0 group) with these store_rows rows and store_meta values. */
function board09(rows: [string, string, string, number, string][], meta: [string, string, string][] = []): DatabaseSync {
  const file = join(base, `board-09-${++n}.db`)
  openDb(file, { migrations: board.BOARD_MIGRATIONS.filter((m) => !m.group), hiveVersion: '0.9.3' }).close()
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  for (const r of rows) db.prepare('INSERT INTO store_rows (store, scope, key, ord, doc) VALUES (?, ?, ?, ?, ?)').run(...r)
  for (const m of meta) db.prepare("INSERT INTO store_meta (store, scope, key, value) VALUES (?, '', ?, ?)").run(...m)
  return db
}

describe("the 1.0 step: 0.9's store_rows moved into the tables", () => {
  it('every entry in its order, the values into board_meta, the old rows gone; other stores left as they were', () => {
    const lane2 = { ...LANE, id: 'lane-2', state: 'active', endedAt: null, frozen: undefined }
    const db = board09(
      [
        ['lanes', '', 'lane-2', 0, JSON.stringify(lane2)],
        ['lanes', '', 'lane-1', 1, JSON.stringify(LANE)],
        ['watches', '', 'w-1', 0, JSON.stringify(WATCH)],
        ['metrics', '', 'hour:0', 0, JSON.stringify(bucket(0))],
        ['metrics', '', 'hour:3600000', 3_600_000, JSON.stringify(bucket(3_600_000))],
        ['deliveries', 'p-1', 'm1', 0, '{"id":"m1"}']
      ],
      [
        ['metrics', 'observed', '[[0,10]]'],
        ['metrics', 'imported', '{"rows":2}'],
        ['watches', 'invalid', '[{"bad":1}]']
      ]
    )
    db.exec('BEGIN')
    moveStores(db)
    db.exec('COMMIT')
    expect(readEntries(db, 'lanes').map((e) => canonical(e.doc))).toEqual([canonical(JSON.parse(JSON.stringify(lane2))), canonical(LANE)])
    expect(readEntries(db, 'watches').map((e) => canonical(e.doc))).toEqual([canonical(WATCH)])
    expect(readEntries(db, 'metrics').map((e) => canonical(e.doc))).toEqual([canonical(JSON.parse(JSON.stringify(bucket(0)))), canonical(JSON.parse(JSON.stringify(bucket(3_600_000))))])
    const meta = db.prepare("SELECT key, value FROM board_meta WHERE key LIKE '%.%' ORDER BY key").all()
    expect(meta.map((r) => ({ ...r }))).toEqual([
      { key: 'metrics.imported', value: '{"rows":2}' },
      { key: 'metrics.observed', value: '[[0,10]]' },
      { key: 'watches.invalid', value: '[{"bad":1}]' }
    ])
    expect(db.prepare("SELECT store, key FROM store_rows").all().map((r) => ({ ...r }))).toEqual([{ store: 'deliveries', key: 'm1' }])
    expect(db.prepare("SELECT count(*) AS n FROM store_meta WHERE store IN ('lanes', 'watches', 'metrics')").get()).toEqual({ n: 0 })
    db.close()
  })

  it('an entry no row can hold, or one that is not JSON, is kept aside as it was (watches: with their invalid ones)', () => {
    const db = board09([
      ['watches', '', 'w-1', 0, JSON.stringify(WATCH)],
      // The same agent's second watch (an agent has one).
      ['watches', '', 'w-2', 1, JSON.stringify({ ...WATCH, id: 'w-2' })],
      ['metrics', '', 'hour:0', 0, JSON.stringify(bucket(0))],
      ['metrics', '', 'hour:0#', 0, JSON.stringify({ ...bucket(0), dropped: 9 })],
      ['lanes', '', 'x', 0, '{ not json']
    ], [['watches', 'invalid', '[{"bad":1}]']])
    db.exec('BEGIN')
    moveStores(db)
    db.exec('COMMIT')
    expect(readEntries(db, 'watches').map((e) => e.key)).toEqual(['w-1'])
    const meta = (k: string): unknown => JSON.parse((db.prepare('SELECT value FROM board_meta WHERE key = ?').get(k) as { value: string }).value)
    expect(meta('watches.invalid')).toEqual([{ bad: 1 }, { ...WATCH, id: 'w-2' }])
    expect(readEntries(db, 'metrics')).toHaveLength(1)
    expect((meta('metrics.unmapped') as { dropped: number }[]).map((b) => b.dropped)).toEqual([9])
    expect(meta('lanes.unmapped')).toEqual(['{ not json'])
    db.close()
  })

  it("is the 1.0 group's step after the upgrade's first, and makes #1208's tables", () => {
    const step = board.BOARD_MIGRATIONS.find((m) => m.name === STORES_STEP.name)!
    expect(step.group).toBe('1.0')
    expect(step.version).toBeGreaterThan(board.BOARD_MIGRATIONS.find((m) => m.name === '1.0 upgrade')!.version)
    const db = board09([])
    db.exec('BEGIN')
    moveStores(db)
    db.exec('COMMIT')
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name)
    for (const t of ['lanes', 'lane_cards', 'lane_frozen', 'watches', 'watch_cards', 'metrics_buckets', 'metrics_series']) expect(names).toContain(t)
    db.close()
  })
})

describe('reads and saves', () => {
  it('while the tables are not there (a 0.9 file waiting for its upgrade), a store reads its store_rows', async () => {
    const ws = workspace()
    const db = board.workspaceDb(ws).writer
    // As a 0.9 file has them: store_rows' rows, and none of the tables.
    db.exec('PRAGMA foreign_keys = OFF')
    for (const t of ['lane_frozen', 'lane_cards', 'lanes']) db.exec(`DROP TABLE ${t}`)
    // A 1.0 file has no store_rows (#1211's step drops it): made again as 0.9's step 2 makes it.
    db.exec('CREATE TABLE IF NOT EXISTS store_rows (store TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, ord INTEGER NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (store, scope, key)) STRICT, WITHOUT ROWID')
    db.prepare("INSERT INTO store_rows (store, scope, key, ord, doc) VALUES ('lanes', '', 'lane-1', 0, ?)").run(JSON.stringify(LANE))
    db.prepare("INSERT INTO store_meta (store, scope, key, value) VALUES ('lanes', '', 'imported', '{}')").run()
    const got = tables.readTable(ws, 'lanes')
    expect([got.docs, got.meta.get('imported')]).toEqual([[LANE], '{}'])
    board.closeBoard(ws)
  })

  it('write only the entries that changed, keep the order given, and remove those left out', async () => {
    const ws = workspace()
    const lane = (id: string, rounds = 10) => ({ ...LANE, id, rounds })
    await tables.saveTable(ws, 'lanes', [lane('a'), lane('b'), lane('c')])
    const db = board.workspaceDb(ws).writer
    const changes = (): number => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    let before = changes()
    await tables.saveTable(ws, 'lanes', [lane('a'), lane('b'), lane('c')])
    expect(changes() - before).toBe(0)
    before = changes()
    await tables.saveTable(ws, 'lanes', [lane('a'), lane('b'), lane('c', 3)])
    // c: its row out and in again, with its 2 cards and 2 frozen cards each way.
    expect(changes() - before).toBe(10)
    await tables.saveTable(ws, 'lanes', [lane('c', 3), lane('a')])
    expect(tables.readTable(ws, 'lanes').docs.map((l) => (l as { id: string }).id)).toEqual(['c', 'a'])
    expect(db.prepare('SELECT count(*) AS n FROM lane_cards').get()).toEqual({ n: 4 })
  })

  it('a watch replacing another of the same agent in one save goes in (the old one leaves first)', async () => {
    const ws = workspace()
    await tables.saveTable(ws, 'watches', [WATCH])
    await tables.saveTable(ws, 'watches', [{ ...WATCH, id: 'w-new' }])
    expect(tables.readTable(ws, 'watches').docs.map((w) => (w as { id: string }).id)).toEqual(['w-new'])
  })

  it('are all or nothing: one that fails as it is written leaves the entries and values as they were, and the next save writes it', async () => {
    const ws = workspace()
    await tables.saveTable(ws, 'metrics', [bucket(0)], { observed: '[1]' })
    tables.tableTestHooks.failSave = (store) => store === 'metrics'
    await expect(tables.saveTable(ws, 'metrics', [bucket(0), bucket(3_600_000)], { observed: '[2]' })).rejects.toThrow(/SQLITE_FULL/)
    const kept = tables.readTable(ws, 'metrics')
    expect([kept.docs.length, kept.meta.get('observed')]).toEqual([1, '[1]'])
    tables.tableTestHooks.failSave = null
    await tables.saveTable(ws, 'metrics', [bucket(0), bucket(3_600_000)], { observed: '[2]' })
    expect(tables.readTable(ws, 'metrics').docs).toHaveLength(2)
  })

  it('a guard that throws stops the save before anything is written; never inside a change of the board', async () => {
    const ws = workspace()
    await expect(
      tables.saveTable(ws, 'lanes', [LANE], {}, () => {
        throw new Error('The workspace was closed')
      })
    ).rejects.toThrow(/closed/)
    expect(tables.readTable(ws, 'lanes').docs).toEqual([])
    await expect(board.boardWrite({ path: ws } as never, () => tables.saveTable(ws, 'lanes', []))).rejects.toThrow(/inside a change of the board/)
  })

  it('a second bucket of one hour is kept aside, never written over the first', async () => {
    const ws = workspace()
    await tables.saveTable(ws, 'metrics', [bucket(0), { ...bucket(0), dropped: 9 }])
    const got = tables.readTable(ws, 'metrics')
    expect((got.docs as { dropped: number }[]).map((b) => b.dropped)).toEqual([2])
    expect((JSON.parse(got.meta.get('unmapped')!) as { dropped: number }[]).map((b) => b.dropped)).toEqual([9])
  })
})

describe("a field named $doc is just a field (round 1, finding 1)", () => {
  // Each store's entry with a field called $doc (null, text, an object), in columns and kept whole.
  const odd = (v: unknown): [TableStore, unknown][] => [
    ['lanes', { ...LANE, $doc: v }],
    ['lanes', { ...LANE, state: 'running', $doc: v }],
    ['watches', { ...WATCH, $doc: v }],
    // Another agent's (an agent has one watch).
    ['watches', { ...WATCH, id: 'w-2', agentId: 'a-r6', waitSeq: 'four', $doc: v }],
    ['metrics', { ...JSON.parse(JSON.stringify(bucket(0))), $doc: v }],
    ['metrics', { ...JSON.parse(JSON.stringify(bucket(3_600_000))), span: 'week', $doc: v }]
  ]
  const VALUES = [null, 'text', { later: 'field' }]

  it('reads back as it was, through the reader a read uses', () => {
    for (const v of VALUES)
      for (const [store, doc] of odd(v)) {
        const r = roundTrip(store, doc)
        expect({ store, v, back: canonical(r.back) }).toEqual({ store, v, back: canonical(doc) })
      }
  })

  it('is moved in by the 1.0 step as it was', () => {
    for (const v of VALUES) {
      const entries = odd(v)
      const db = board09(entries.map(([store, doc], i) => [store, '', `k${i}`, i, JSON.stringify(doc)]))
      db.exec('BEGIN')
      moveStores(db)
      db.exec('COMMIT')
      for (const store of TABLE_STORES) {
        const want = entries.filter(([s]) => s === store).map(([, d]) => canonical(d))
        // Metrics read back by their start: the same two buckets.
        const got = readEntries(db, store).map((e) => canonical(e.doc))
        expect({ store, v, got: store === 'metrics' ? got.sort() : got }).toEqual({ store, v, got: store === 'metrics' ? [...want].sort() : want })
      }
      db.close()
    }
  })

  it('is saved and read back as it was, after the database is closed and opened again', async () => {
    for (const v of VALUES) {
      const ws = workspace()
      const entries = odd(v)
      for (const store of TABLE_STORES) await tables.saveTable(ws, store, entries.filter(([s]) => s === store).map(([, d]) => d))
      board.closeBoard(ws)
      for (const store of TABLE_STORES) {
        const want = entries.filter(([s]) => s === store).map(([, d]) => canonical(d))
        const got = tables.readTable(ws, store).docs.map((d) => canonical(d))
        expect({ store, v, got: store === 'metrics' ? got.sort() : got }).toEqual({ store, v, got: store === 'metrics' ? [...want].sort() : want })
      }
      board.closeBoard(ws)
    }
  })
})

describe("what saves keep of committed entries is bounded (round 1, finding 2)", () => {
  it("a closed workspace's last save keeps nothing; one closed since goes at the next save; an open one keeps its own", async () => {
    const a = workspace()
    const b = workspace()
    // Open, as a workspace's are while its window has it.
    board.workspaceDb(a)
    board.workspaceDb(b)
    await tables.saveTable(a, 'lanes', [LANE])
    expect(tables.committedFor()).toContain(a)
    // Closed, its stores' last saves open the database for the save and close it again: nothing kept.
    closed(a)
    await tables.saveTable(a, 'lanes', [{ ...LANE, rounds: 3 }])
    expect(tables.committedFor()).not.toContain(a)
    // Kept while open, gone at the next save (anyone's) once closed.
    reopen(a)
    await tables.saveTable(a, 'watches', [WATCH])
    expect(tables.committedFor()).toContain(a)
    closed(a)
    await tables.saveTable(b, 'lanes', [LANE])
    expect(tables.committedFor()).not.toContain(a)
    expect(tables.committedFor()).toContain(b)
    // Still saving only what changed for the open one.
    const db = board.workspaceDb(b).writer
    const before = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    await tables.saveTable(b, 'lanes', [LANE])
    expect((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n - before).toBe(0)
  })

  it('at most MAX_COMMITTED stores are kept however many workspaces stay open, the least recently saved going first', async () => {
    const open: string[] = []
    for (let i = 0; i < tables.MAX_COMMITTED / 3 + 4; i++) {
      const ws = workspace()
      open.push(ws)
      board.workspaceDb(ws)
      for (const store of TABLE_STORES) await tables.saveTable(ws, store, [])
    }
    expect(tables.committedFor().length).toBeLessThanOrEqual(tables.MAX_COMMITTED / 3)
    expect(tables.committedFor()).toContain(open[open.length - 1])
    expect(tables.committedFor()).not.toContain(open[0])
    for (const ws of open) board.closeBoard(ws)
  })
})

describe("0.8's lanes.json moved in (from #1018's tests)", () => {
  it('once, in order; the file kept as a backup, as it was; not read again', async () => {
    const ws = workspace()
    const file = join(ws, '.hive', 'lanes.json')
    const list = [{ ...LANE, id: 'b' }, { ...LANE, id: 'a' }]
    const text = JSON.stringify({ version: 1, lanes: list })
    writeFileSync(file, text)
    let reads = 0
    const read = () => (reads++, lanes.readLanesFile(file))
    const got = await tables.openTable(ws, 'lanes', file, read)
    expect(got.docs).toEqual(list)
    expect(JSON.parse(got.meta.get('imported')!)).toMatchObject({ rows: 2, file })
    const backup = files(ws).find((f) => f.startsWith('lanes.json.imported-'))!
    expect(readFileSync(join(ws, '.hive', backup), 'utf8')).toBe(text)
    await tables.openTable(ws, 'lanes', file, read)
    expect(reads).toBe(1)
  })

  it("a file that can't be read now is not marked moved: it stays, and the next open moves it in", async () => {
    const ws = workspace()
    const file = join(ws, '.hive', 'lanes.json')
    // A folder where the file is: reading it fails as a file Windows holds open would (not "there is none").
    mkdirSync(file)
    await expect(tables.openTable(ws, 'lanes', file, () => lanes.readLanesFile(file))).rejects.toThrow(/Could not read the lanes/)
    expect(tables.readTable(ws, 'lanes').meta.has('imported')).toBe(false)
    rmSync(file, { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, lanes: [{ id: 'lane-a', state: 'running' }] }))
    const got = await tables.openTable(ws, 'lanes', file, () => lanes.readLanesFile(file))
    // An entry its columns can't hold is kept whole: moved in as it was.
    expect(got.docs).toEqual([{ id: 'lane-a', state: 'running' }])
  })

  it('a damaged lanes file is set aside, kept as it was, and none are moved in', async () => {
    const ws = workspace()
    const file = join(ws, '.hive', 'lanes.json')
    writeFileSync(file, '{ not json')
    const got = await tables.openTable(ws, 'lanes', file, () => lanes.readLanesFile(file))
    expect(got.docs).toEqual([])
    const aside = files(ws).find((f) => f.startsWith('lanes.json.damaged-'))!
    expect(readFileSync(join(ws, '.hive', aside), 'utf8')).toBe('{ not json')
  })

  it("every entry moved in has a row of its own, whatever ids the file gives (one another's fallback, the same twice, none)", async () => {
    const ws = workspace()
    const file = join(ws, '.hive', 'lanes.json')
    const list = [{ id: '#1', n: 0 }, { n: 1 }, { id: 'a', n: 2 }, { id: 'a', n: 3 }, { id: '#1', n: 4 }, { id: '#3', n: 5 }]
    writeFileSync(file, JSON.stringify({ version: 1, lanes: list }))
    const got = await tables.openTable(ws, 'lanes', file, () => lanes.readLanesFile(file))
    expect(got.docs).toEqual(list)
    expect(JSON.parse(got.meta.get('imported')!)).toMatchObject({ rows: list.length })
  })
})

const live = process.env.HIVE_STORE_MIGRATION_DB
describe.skipIf(!live)("a copy of a live board's hive.db (HIVE_STORE_MIGRATION_DB)", () => {
  it('migrates with every lane, watch and metric equal as JSON, in order, and their values kept', () => {
    const copy = join(base, `live-${++n}.db`)
    copyFileSync(live!, copy)
    if (existsSync(`${live}-wal`)) copyFileSync(`${live}-wal`, `${copy}-wal`)
    const db = new DatabaseSync(copy)
    db.exec('PRAGMA foreign_keys = ON')
    const old = Object.fromEntries(TABLE_STORES.map((s) => [s, (db.prepare("SELECT doc FROM store_rows WHERE store = ? AND scope = '' ORDER BY ord, key").all(s) as { doc: string }[]).map((r) => canonical(JSON.parse(r.doc)))]))
    const oldMeta = (db.prepare("SELECT store, key, value FROM store_meta WHERE store IN ('lanes', 'watches', 'metrics') ORDER BY store, key").all() as { store: string; key: string; value: string }[]).map((r) => [`${r.store}.${r.key}`, r.value])
    db.exec('BEGIN')
    moveStores(db)
    db.exec('COMMIT')
    for (const s of TABLE_STORES) {
      const now = readEntries(db, s).map((e) => canonical(e.doc))
      expect({ store: s, count: now.length }).toEqual({ store: s, count: old[s].length })
      expect(now).toEqual(old[s])
    }
    for (const [k, v] of oldMeta) expect((db.prepare('SELECT value FROM board_meta WHERE key = ?').get(k) as { value: string }).value).toBe(v)
    // Kept whole only where columns couldn't hold one exactly: say how many, for the record.
    const whole = TABLE_STORES.map((s) => `${s}: ${(db.prepare(`SELECT count(*) AS n FROM ${TABLE_DEFS[s].main} WHERE extra LIKE '[%'`).get() as { n: number }).n} kept whole of ${old[s].length}`)
    console.log(`live copy: ${whole.join('; ')}`)
    db.close()
  })
})
