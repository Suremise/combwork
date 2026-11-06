// Sessions and deliveries in their 1.0 tables (#1211, schema/sessionDeliveryTables.ts and sessionDeliveryCodec.ts): every record reads back
// equal as JSON (odd ones too: a field Combwork doesn't know, a null, a lone surrogate, one missing), a change writes only
// the rows it changed, the 1.0 step moves store_rows' rows into the tables and keeps aside what isn't of Combwork's form, and
// the queries use their indexes. CW_STORE_ROUNDTRIP_DB=<a combwork.db> runs the step over a copy of that board made in
// tempDir() (the file itself is never opened): counts equal, every session and delivery equal as JSON.
import { copyFileSync, existsSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import { BOARD_MIGRATIONS } from '../src/main/boardStore'
import { openDb, schemaVersion } from '../src/main/db'
import { readDelivery } from '../src/shared/deliveries'
import { deliveryFromRow, deliveryToRow, keptUsageFromRow, keptUsageToRow, sessionFromRows, sessionToRows } from '../src/main/schema/sessionDeliveryCodec'
import { addDeliveries, addSessionRecords, moveStoreRows, readAgentSessionRecords, readCardSessionRecords, readDeleted, readDeletedUsage, readDeliveries, readSessionRecord, readSessionRecords, writeDeliveries, writeSessionRecords } from '../src/main/schema/sessionDeliveryTables'
import { QUERIES, V1_0_STEPS } from '../src/main/schema/v1_0'

const base = tempDir('cw-store-tables-')
let n = 0
type Rec = Record<string, unknown>

/**
 * A database (in memory, or with `file` in that file, in WAL mode as Combwork opens its own) with the sessions and deliveries
 * tables, and store_meta as 0.9's step 2 makes it.
 */
function tables(file?: string): DatabaseSync {
  const db = new DatabaseSync(file ?? ':memory:')
  if (file) db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  for (const sql of V1_0_STEPS.find((s) => s.name === 'sessions and deliveries in tables')!.ddl) db.exec(sql)
  db.exec('CREATE TABLE store_meta (store TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, scope, key)) STRICT, WITHOUT ROWID')
  return db
}
const meta = (db: DatabaseSync, store: string, scope: string, key: string): unknown => {
  const r = db.prepare('SELECT value FROM store_meta WHERE store = ? AND scope = ? AND key = ?').get(store, scope, key) as { value: string } | undefined
  return r ? JSON.parse(r.value) : undefined
}
const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v))

const at = '2026-10-20T10:00:00.000Z'
/** A session record with every field Combwork writes. */
const fullSession = (id: string, over: Rec = {}): Rec => ({
  id,
  agent: 'claude-code',
  name: `Session ${id}`,
  createdAt: at,
  lastActiveAt: at,
  archived: false,
  agentId: 'a1',
  agentName: 'Coder',
  cwd: 'D:\\w\\p',
  branch: 'cw/a1',
  transcriptPath: 'C:\\t.jsonl',
  handedOverFrom: 'older',
  cards: [{ number: 5, title: 'Five' }, { number: 6, title: 'Six', review: true }],
  titleAtRename: null,
  keptUsage: { inputTokens: 10, outputTokens: 20 },
  screenStops: [{ at, kind: 'stop' }],
  sub: { parentId: null, kind: 'guardian review' },
  mode: 'planner',
  ...over
})
const fullDelivery = (id: string, seq: number, over: Rec = {}): Rec => ({
  id,
  seq,
  agentId: 'a1',
  agentName: 'Coder',
  conversation: null,
  kind: 'task',
  from: { kind: 'assistant', name: 'Assistant' },
  card: 12,
  round: 2,
  body: 'Do the thing',
  state: 'received',
  created: at,
  expires: at,
  offered: at,
  offers: 2,
  received: at,
  receivedVia: 'inbox',
  offerRun: 'run-1',
  detail: 'why',
  again: 'once more',
  source: 'watch',
  ref: 'w1',
  meta: { cards: '12', n: 3, yes: true },
  need: 'free',
  forRun: 'run-2',
  ...over
})

describe('records through their rows (storeCodec.ts)', () => {
  const session = (rec: Rec): Rec => {
    const r = sessionToRows('p1', 0, rec)!
    return sessionFromRows(r.row, r.cards)
  }
  it('a session with every field reads back equal, its cards, sub and JSON columns typed', () => {
    const rec = fullSession('s1')
    const r = sessionToRows('p1', 0, rec)!
    expect(r.cards).toHaveLength(2)
    expect(r.row.sub_kind).toBe('guardian review')
    expect(JSON.parse(String(r.row.extra))).toEqual({ titleAtRename: null })
    expect(session(rec)).toEqual(rec)
    expect(session(fullSession('s2', { sub: { parentId: 's1', kind: 'sub-agent' } }))).toEqual(fullSession('s2', { sub: { parentId: 's1', kind: 'sub-agent' } }))
  })

  it('a minimal session, and odd ones, read back equal: fields Combwork doesn\'t know, other types, a lone surrogate, one missing', () => {
    const min = { id: 'm', agent: 'codex', name: 'n', createdAt: at, lastActiveAt: at, archived: true }
    expect(session(min)).toEqual(min)
    const odd = { ...min, agentId: 42, extraField: { nested: [1, 2] }, name: 'lone \ud800 surrogate', cards: [{ number: 'x', title: 'bad' }], sub: { parentId: 1, kind: 'k' } }
    expect(session(odd)).toEqual(odd)
    // A record without a name (a hand edit): kept, read back without it.
    const { name: _n, ...noName } = min
    expect(session(noName)).toEqual(noName)
    // Without an id it has no key: not of Combwork's form.
    const { id: _i, ...noId } = min
    expect(sessionToRows('p1', 0, noId)).toBeNull()
  })

  it("a deleted session's usage, and a delivery with every field, read back equal", () => {
    const k = { id: 'g', provider: 'claude-code', agentId: 'a1', agentName: 'Coder', cwd: 'D:\\w', name: 'gone', usage: { inputTokens: 1 } }
    expect(keptUsageFromRow(keptUsageToRow('p1', 0, k)!)).toEqual(k)
    const { name: _n, ...kNoName } = k
    expect(keptUsageFromRow(keptUsageToRow('p1', 0, kNoName)!)).toEqual(kNoName)
    const d = fullDelivery('m1', 1)
    expect(deliveryFromRow(deliveryToRow('p1', d)!)).toEqual(d)
    const odd = { ...fullDelivery('m2', 2, { conversation: 'c-1' }), unknown: 'kept', offers: 'two' }
    expect(deliveryFromRow(deliveryToRow('p1', odd)!)).toEqual(odd)
    // Missing a field its row needs: kept (deliveries.ts's readDelivery sets it aside as it loads), read back as it was.
    const { state: _s, ...noState } = d
    expect(deliveryFromRow(deliveryToRow('p1', noState)!)).toEqual(noState)
    // Without an id it has no key: not of Combwork's form.
    const { id: _i, ...noId } = d
    expect(deliveryToRow('p1', noId)).toBeNull()
  })

  it('JSON\'s edges read back as they were (#1211 round 1): an empty list, an own __proto__, keys starting with $, a lone surrogate', () => {
    const own = (o: Rec, k: string, v: unknown): Rec => (Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }), o)
    const min = { id: 'm', agent: 'codex', name: 'n', createdAt: at, lastActiveAt: at, archived: false }
    const cases: Rec[] = [
      { ...min, cards: [] },
      own({ ...min }, '__proto__', { polluted: true }),
      { ...min, $absent: ['name'], $$x: 1, $: 'dollar' },
      { ...min, $absent: ['id', 'agent'] }
    ]
    for (const rec of cases) {
      const back = session(rec)
      expect(JSON.stringify(back)).toBe(JSON.stringify(rec))
      expect(Object.getPrototypeOf(back)).toBe(Object.prototype)
    }
    // A delivery whose body has a lone surrogate: deliveries.ts reads it, so it keeps its row.
    const lone = { id: 'm9', seq: 9, agentId: 'a1', conversation: null, kind: 'task', from: { kind: 'combwork', name: 'Combwork' }, body: 'half \ud83d of an emoji', state: 'queued', created: at, expires: at }
    expect(readDelivery(json(lone))).not.toBeNull()
    expect(deliveryFromRow(deliveryToRow('p1', lone)!)).toEqual(lone)
    const prot = own(fullDelivery('m8', 8), '__proto__', 1)
    expect(JSON.stringify(deliveryFromRow(deliveryToRow('p1', prot)!))).toBe(JSON.stringify(prot))
  })
})

describe("a host's records in the tables (storeTables.ts)", () => {
  it('written and read in order; a change writes only the rows it changed; the deleted lists apart', () => {
    const db = tables()
    db.exec('BEGIN')
    writeSessionRecords(db, 'p1', { sessions: [fullSession('a'), fullSession('b'), fullSession('c')], deleted: ['g1', 'g2'], deletedUsage: [{ id: 'g1', provider: 'codex', name: 'g', usage: {} }] })
    db.exec('COMMIT')
    expect(readSessionRecords(db, 'p1')).toEqual([fullSession('a'), fullSession('b'), fullSession('c')])
    expect(readDeleted(db, 'p1')).toEqual(['g1', 'g2'])
    expect(readDeletedUsage(db, 'p1')).toEqual([{ id: 'g1', provider: 'codex', name: 'g', usage: {} }])
    expect(readSessionRecord(db, 'p1', 'b')).toEqual(fullSession('b'))
    expect(readSessionRecord(db, 'p1', 'none')).toBeNull()
    // Counted from here: each row written.
    db.exec('CREATE TEMP TABLE w (t TEXT)')
    for (const t of ['sessions', 'session_cards', 'sessions_deleted', 'sessions_deleted_usage']) for (const op of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TEMP TRIGGER w_${t}_${op} AFTER ${op} ON ${t} BEGIN INSERT INTO w VALUES ('${t} ${op}'); END`)
    const written = (): string[] => (db.prepare('SELECT t FROM w').all() as { t: string }[]).map((r) => r.t)
    db.exec('BEGIN')
    // b's last activity, c removed, a new one, the deleted lists left as they were (not given).
    writeSessionRecords(db, 'p1', { sessions: [fullSession('a'), fullSession('b', { lastActiveAt: '2026-10-21T00:00:00.000Z' }), fullSession('d')] })
    db.exec('COMMIT')
    expect(written().sort()).toEqual(['session_cards DELETE', 'session_cards DELETE', 'session_cards INSERT', 'session_cards INSERT', 'sessions DELETE', 'sessions INSERT', 'sessions UPDATE'])
    expect(readSessionRecords(db, 'p1').map((r) => r.id)).toEqual(['a', 'b', 'd'])
    expect(readDeleted(db, 'p1')).toEqual(['g1', 'g2'])
  })

  it("an agent's records and a card's (HI-1236): read by their indexes, the same as filtering every record", () => {
    const db = tables()
    const day = (d: number): string => `2026-10-${String(d).padStart(2, '0')}T10:00:00.000Z`
    const card = (k: number) => ({ number: k, title: `Card ${k}` })
    const recs = [
      fullSession('z1', { agentId: 'a1', lastActiveAt: day(3), cards: [card(5)] }),
      fullSession('m2', { agentId: 'a2', lastActiveAt: day(9), cards: [card(5), card(7)] }),
      fullSession('b3', { agentId: 'a1', lastActiveAt: day(8), cards: [] }),
      fullSession('k4', { agentId: 'a1', lastActiveAt: day(1), cards: [card(7), card(5)] })
    ]
    db.exec('BEGIN')
    writeSessionRecords(db, 'p1', { sessions: recs })
    // Another host's, with the same agent and card: never read for p1.
    writeSessionRecords(db, 'p2', { sessions: [fullSession('o1', { agentId: 'a1', lastActiveAt: day(20), cards: [card(5)] })] })
    db.exec('COMMIT')
    const all = readSessionRecords(db, 'p1') as { id: string; agentId?: string; lastActiveAt: string; cards?: { number: number }[] }[]
    const newest = (list: typeof all) => [...list].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
    expect(readAgentSessionRecords(db, 'p1', 'a1')).toEqual(newest(all.filter((r) => r.agentId === 'a1')))
    expect(readAgentSessionRecords(db, 'p1', 'a1').map((r) => r.id)).toEqual(['b3', 'z1', 'k4'])
    expect(readAgentSessionRecords(db, 'p1', 'nobody')).toEqual([])
    expect(readCardSessionRecords(db, 'p1', 5)).toEqual(all.filter((r) => r.cards?.some((c) => c.number === 5)))
    expect(readCardSessionRecords(db, 'p1', 7).map((r) => r.id)).toEqual(['m2', 'k4'])
    expect(readCardSessionRecords(db, 'p1', 99)).toEqual([])
    // Through their indexes, not a scan of the host's records.
    const plan = (sql: string, ...args: (string | number)[]): string => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail).join('; ')
    expect(plan(QUERIES['sessions.byAgent'].sql, 'p1', 'a1')).toMatch(/USING (COVERING )?INDEX sessions_agent/)
    expect(plan(QUERIES['sessions.byCard'].sql, 5, 'p1')).toMatch(/USING (COVERING )?INDEX session_cards_card/)
    expect(plan(QUERIES['sessions.byIds'].sql, 'p1', '["z1"]')).toMatch(/USING PRIMARY KEY/)
    expect(plan(QUERIES['sessions.cardsOf'].sql, 'p1', '["z1"]')).toMatch(/USING PRIMARY KEY/)
  })

  it("an agent's records as new as each other: in the host's order, as a stable sort of every record gives them (HR5's round 1)", () => {
    const db = tables()
    // Saved z, a, m, all at the same time: by id another order.
    db.exec('BEGIN')
    writeSessionRecords(db, 'p1', { sessions: [fullSession('z'), fullSession('a'), fullSession('m', { lastActiveAt: '2026-10-21T00:00:00.000Z' }), fullSession('b')] })
    db.exec('COMMIT')
    const all = readSessionRecords(db, 'p1') as { lastActiveAt: string }[]
    expect(readAgentSessionRecords(db, 'p1', 'a1')).toEqual([...all].sort((x, y) => y.lastActiveAt.localeCompare(x.lastActiveAt)))
    expect(readAgentSessionRecords(db, 'p1', 'a1').map((r) => r.id)).toEqual(['m', 'z', 'a', 'b'])
  })

  it("another connection committing between an index's read and its records' (HR5's round 1): what is read is of one commit", () => {
    // Its index's query on `db`, and right after it, `write` on another connection.
    const between = (db: DatabaseSync, sql: string, write: () => void): DatabaseSync =>
      new Proxy(db, {
        get(target, key) {
          if (key !== 'prepare') {
            const v = Reflect.get(target, key, target)
            return typeof v === 'function' ? v.bind(target) : v
          }
          return (q: string) => {
            const st = target.prepare(q)
            if (q !== sql) return st
            return new Proxy(st, {
              get(s, k) {
                if (k === 'all') return (...args: never[]) => {
                  const out = s.all(...args)
                  write()
                  return out
                }
                const v = Reflect.get(s, k, s)
                return typeof v === 'function' ? v.bind(s) : v
              }
            })
          }
        }
      })
    const file = join(base, `between-${++n}.db`)
    const db = tables(file)
    const other = new DatabaseSync(file)
    try {
      db.exec('BEGIN')
      writeSessionRecords(db, 'p1', { sessions: [fullSession('s', { cards: [{ number: 5, title: 'Five' }] })] })
      db.exec('COMMIT')
      // Moved to another agent once a1's ids are read: a1's record as it was, never a2's.
      const moved = between(db, QUERIES['sessions.byAgent'].sql, () => other.exec("UPDATE sessions SET agent_id = 'a2' WHERE host = 'p1' AND id = 's'"))
      expect(readAgentSessionRecords(moved, 'p1', 'a1').map((r) => [r.id, r.agentId])).toEqual([['s', 'a1']])
      expect(readAgentSessionRecords(db, 'p1', 'a1')).toEqual([])
      // Its card 5 taken off once the card's sessions are read: the record as it was then, with card 5.
      const taken = between(db, QUERIES['sessions.byCard'].sql, () => other.exec("DELETE FROM session_cards WHERE host = 'p1' AND card = 5"))
      expect(readCardSessionRecords(taken, 'p1', 5).map((r) => (r.cards as { number: number }[] | undefined)?.map((c) => c.number))).toEqual([[5]])
      expect(readCardSessionRecords(db, 'p1', 5)).toEqual([])
      // Inside a transaction already open: that one's snapshot, left open.
      db.exec('BEGIN')
      expect(readAgentSessionRecords(db, 'p1', 'a2').map((r) => r.id)).toEqual(['s'])
      expect(db.isTransaction).toBe(true)
      db.exec('COMMIT')
    } finally {
      other.close()
      db.close()
    }
  })

  it("a file's records moved in beside the host's: one it has wins, and one its deleted list holds is never written back (HI-1736)", () => {
    const db = tables()
    db.exec('BEGIN')
    writeSessionRecords(db, 'p1', { sessions: [fullSession('a', { name: 'kept' })], deleted: ['gone'] })
    const added = addSessionRecords(db, 'p1', { sessions: [fullSession('a', { name: 'older' }), fullSession('gone'), fullSession('new')], deleted: ['also'] })
    db.exec('COMMIT')
    expect(added).toBe(1)
    expect(readSessionRecords(db, 'p1').map((r) => [r.id, r.name])).toEqual([
      ['a', 'kept'],
      ['new', fullSession('new').name]
    ])
    expect(readDeleted(db, 'p1')).toEqual(['gone', 'also'])
  })

  it('a record without the fields Combwork keeps, or two with one id, throw: nothing written', () => {
    const db = tables()
    db.exec('BEGIN')
    expect(() => writeSessionRecords(db, 'p1', { sessions: [fullSession('a'), fullSession('a')] })).toThrow('two session records with the id a')
    db.exec('ROLLBACK')
    expect(readSessionRecords(db, 'p1')).toEqual([])
    const d = fullDelivery('m1', 1)
    db.exec('BEGIN')
    expect(() => writeDeliveries(db, 'p1', [d, d])).toThrow('two deliveries with the id m1')
    db.exec('ROLLBACK')
  })

  it("deliveries: in their seq's order; a change writes only what changed; the expired ones deleted by their key", () => {
    const db = tables()
    db.exec('BEGIN')
    writeDeliveries(db, 'p1', [fullDelivery('m2', 2), fullDelivery('m1', 1), fullDelivery('m3', 3)])
    db.exec('COMMIT')
    expect(readDeliveries(db, 'p1').map((d) => d.id)).toEqual(['m1', 'm2', 'm3'])
    db.exec('CREATE TEMP TABLE w (t TEXT)')
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TEMP TRIGGER w_${op} AFTER ${op} ON deliveries BEGIN INSERT INTO w VALUES ('${op} ' || ${op === 'DELETE' ? 'old' : 'new'}.id); END`)
    db.exec('BEGIN')
    // m1 expired (pruned), m2 acked, m3 as it was.
    writeDeliveries(db, 'p1', [fullDelivery('m2', 2, { state: 'acked', acked: at }), fullDelivery('m3', 3)])
    db.exec('COMMIT')
    expect((db.prepare('SELECT t FROM w').all() as { t: string }[]).map((r) => r.t).sort()).toEqual(['DELETE m1', 'UPDATE m2'])
    expect(readDeliveries(db, 'p1')).toEqual([fullDelivery('m2', 2, { state: 'acked', acked: at }), fullDelivery('m3', 3)])
    // Another host's are its own.
    expect(readDeliveries(db, 'p2')).toEqual([])
  })

  it("deliveries moved in that aren't of Combwork's form, or repeat an id, go with those kept aside", () => {
    const db = tables()
    db.exec('BEGIN')
    // One with an id but little else keeps its row (deliveries.ts's readDelivery sets it aside as it loads).
    expect(addDeliveries(db, 'p1', [fullDelivery('m1', 1), { id: 'nope' }, fullDelivery('m1', 1, { body: 'again' }), 'text', { seq: 3 }])).toBe(2)
    db.exec('COMMIT')
    expect(readDeliveries(db, 'p1')).toEqual([{ id: 'nope' }, json(fullDelivery('m1', 1))])
    expect(meta(db, 'deliveries', 'p1', 'invalid')).toEqual([json(fullDelivery('m1', 1, { body: 'again' })), 'text', { seq: 3 }])
  })
})

describe('the 1.0 step: store_rows into the tables', () => {
  /** A board file at 0.9's schema (and the group's steps before this one), with these store_rows rows. */
  function board09(rows: { store: string; scope: string; key: string; ord: number; doc: string }[], metas: [string, string, string, string][] = []): string {
    const file = join(base, `b-${++n}`, 'combwork.db')
    const step = BOARD_MIGRATIONS.find((m) => m.name === 'sessions and deliveries in tables')!
    const db = openDb(file, { migrations: BOARD_MIGRATIONS.filter((m) => m.version < step.version), appVersion: '0.9.3' })
    try {
      const put = db.writer.prepare('INSERT INTO store_rows (store, scope, key, ord, doc) VALUES (?, ?, ?, ?, ?)')
      for (const r of rows) put.run(r.store, r.scope, r.key, r.ord, r.doc)
      for (const m of metas) db.writer.prepare('INSERT INTO store_meta (store, scope, key, value) VALUES (?, ?, ?, ?)').run(...m)
    } finally {
      db.close()
    }
    return file
  }

  it('every host moves, in order, equal as JSON; the odd ones kept aside; the rows gone and the values kept', () => {
    const min = (id: string): Rec => ({ id, agent: 'codex', name: 'n', createdAt: at, lastActiveAt: at, archived: false })
    const edges: Rec[] = [{ ...min('e0'), cards: [] }, JSON.parse(`{"id":"e1","agent":"codex","name":"n","createdAt":"${at}","lastActiveAt":"${at}","archived":false,"__proto__":{"x":1}}`) as Rec, { ...min('e2'), $absent: ['name'], $$y: 2 }]
    const s = (scope: string, key: string, ord: number, v: unknown) => ({ store: 'sessions', scope, key, ord, doc: typeof v === 'string' && key === 'raw' ? v : JSON.stringify(v) })
    const file = board09(
      [
        s('p1', 's:a', 0, fullSession('a')),
        s('p1', 's:b', 1, fullSession('b', { cards: undefined })),
        // The same id twice (a hand edit): the first kept; a row whose JSON is damaged; one without an id.
        s('p1', 's:#2', 2, fullSession('a', { name: 'second a' })),
        { store: 'sessions', scope: 'p1', key: 's:x', ord: 3, doc: '{ damaged' },
        s('p1', 's:#4', 4, { name: 'no id' }),
        s('p1', 'd:g1', 0, 'g1'),
        s('p1', 'u:g1', 0, { id: 'g1', provider: 'codex', name: 'g', usage: { inputTokens: 3 } }),
        s('assistant', 's:as', 0, fullSession('as', { mode: 'coordinator' })),
        { store: 'deliveries', scope: 'p1', key: 'm1', ord: 0, doc: JSON.stringify(fullDelivery('m1', 1)) },
        { store: 'deliveries', scope: 'p1', key: 'm2', ord: 1, doc: JSON.stringify(fullDelivery('m2', 2, { conversation: 'c' })) },
        { store: 'deliveries', scope: 'p1', key: 'bad', ord: 2, doc: JSON.stringify({ id: 'bad' }) },
        { store: 'deliveries', scope: 'p1', key: 'm3', ord: 3, doc: JSON.stringify(fullDelivery('m3', 3, { body: 'lone \ud800' })) },
        { store: 'deliveries', scope: 'p1', key: '#4', ord: 4, doc: JSON.stringify({ noId: true }) },
        ...edges.map((r, i) => s('edges', `s:e${i}`, i, r)),
        { store: 'deliveries', scope: 'folder:x', key: 'm1', ord: 0, doc: JSON.stringify(fullDelivery('m1', 1)) },
      ],
      [
        ['sessions', 'p1', 'imported', '{"rows":7}'],
        ['deliveries', 'p1', 'next', '3'],
        ['deliveries', 'p1', 'invalid', '[{"kept":"before"}]']
      ]
    )
    const db = openDb(file, { migrations: BOARD_MIGRATIONS, appVersion: '1.0.0', approve: () => true })
    try {
      const w = db.writer
      expect(readSessionRecords(w, 'p1')).toEqual([json(fullSession('a')), json(fullSession('b', { cards: undefined }))])
      expect(readDeleted(w, 'p1')).toEqual(['g1'])
      expect(readDeletedUsage(w, 'p1')).toEqual([{ id: 'g1', provider: 'codex', name: 'g', usage: { inputTokens: 3 } }])
      expect(readSessionRecords(w, 'assistant')).toEqual([json(fullSession('as', { mode: 'coordinator' }))])
      expect(meta(w, 'sessions', 'p1', 'setAside')).toEqual([{ name: 'no id' }, json(fullSession('a', { name: 'second a' })), '{ damaged'])
      expect(readDeliveries(w, 'p1')).toEqual([{ id: 'bad' }, json(fullDelivery('m1', 1)), json(fullDelivery('m2', 2, { conversation: 'c' })), json(fullDelivery('m3', 3, { body: 'lone \ud800' }))])
      expect(readDeliveries(w, 'folder:x')).toEqual([json(fullDelivery('m1', 1))])
      expect(meta(w, 'deliveries', 'p1', 'invalid')).toEqual([{ kept: 'before' }, { noId: true }])
      // JSON's edges, through the step too.
      expect(readSessionRecords(w, 'edges').map((r) => JSON.stringify(r))).toEqual(edges.map((r) => JSON.stringify(r)))
      expect(meta(w, 'deliveries', 'p1', 'next')).toBe(3)
      expect(meta(w, 'sessions', 'p1', 'imported')).toEqual({ rows: 7 })
      // The last of its stores: store_rows goes (store_meta stays, with these values).
      expect(w.prepare("SELECT 1 FROM sqlite_master WHERE name = 'store_rows'").get()).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it("refuses while store_rows still has another store's rows (they would be lost): the whole group, the file left as it was", () => {
    const file = board09([{ store: 'lanes', scope: '', key: 'l1', ord: 0, doc: '{"id":"l1"}' }])
    expect(() => openDb(file, { migrations: BOARD_MIGRATIONS, appVersion: '1.0.0', approve: () => true })).toThrow('store_rows still has rows of lanes (1)')
    const raw = new DatabaseSync(file, { readOnly: true })
    try {
      // As it was: every step before this one (board09 makes it so), none after.
      expect(schemaVersion(raw)).toBe(BOARD_MIGRATIONS.find((m) => m.name === 'sessions and deliveries in tables')!.version - 1)
    } finally {
      raw.close()
    }
  })

  it('a new file takes the step with nothing to move', () => {
    const file = join(base, `b-${++n}`, 'combwork.db')
    const db = openDb(file, { migrations: BOARD_MIGRATIONS, appVersion: '1.0.0' })
    try {
      expect(schemaVersion(db.writer)).toBe(Math.max(...BOARD_MIGRATIONS.map((m) => m.version)))
      expect(readSessionRecords(db.writer, 'p1')).toEqual([])
    } finally {
      db.close()
    }
  })

  const live = process.env.CW_STORE_ROUNDTRIP_DB
  it.skipIf(!live)("moves every session and delivery of a live board's copy: counts equal, each equal as JSON", () => {
    const copy = join(tempDir('cw-store-roundtrip-'), 'combwork.db')
    copyFileSync(live!, copy)
    if (existsSync(`${live}-wal`)) copyFileSync(`${live}-wal`, `${copy}-wal`)
    const db = new DatabaseSync(copy)
    try {
      const before = (store: string): Map<string, unknown[]> => {
        const out = new Map<string, unknown[]>()
        for (const r of db.prepare('SELECT scope, key, doc FROM store_rows WHERE store = ? ORDER BY scope, ord, key').all(store) as { scope: string; key: string; doc: string }[]) {
          if (store === 'sessions' && !r.key.startsWith('s:')) continue
          out.set(r.scope, [...(out.get(r.scope) ?? []), JSON.parse(r.doc)])
        }
        return out
      }
      const sessions = before('sessions')
      const deliveries = before('deliveries')
      const t0 = performance.now()
      db.exec('BEGIN')
      const counts = moveStoreRows(db)
      db.exec('COMMIT')
      const ms = Math.round(performance.now() - t0)
      const total = (m: Map<string, unknown[]>): number => [...m.values()].reduce((a, l) => a + l.length, 0)
      console.log(`moved ${counts.sessions} of ${total(sessions)} sessions and ${counts.deliveries} of ${total(deliveries)} deliveries in ${ms} ms`)
      for (const [host, list] of sessions) expect(readSessionRecords(db, host)).toEqual(list)
      for (const [host, list] of deliveries) expect(readDeliveries(db, host)).toEqual([...list].sort((a, b) => (a as Rec).seq as number - ((b as Rec).seq as number)))
      expect(counts).toEqual({ sessions: total(sessions), deliveries: total(deliveries) })
    } finally {
      db.close()
    }
  })
})
