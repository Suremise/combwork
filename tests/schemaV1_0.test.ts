// combwork.db's 1.0 schema (#1208): every step's tables made on an empty file, each module's real query using its index
// (EXPLAIN QUERY PLAN), and the card JSON contract: a card's document split into rows, through SQLite and back, is the
// same bytes. CW_CARD_ROUNDTRIP_DB=<a combwork.db> runs the round trip over every card of that board, on a copy made in
// tempDir() (the file itself is never opened).
import { copyFileSync, existsSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import { QUERIES, V1_0_STEPS } from '../src/main/schema/v1_0'
import { composeCard, decomposeCard, readCardRows, writeCardRows } from '../src/main/schema/cardRows'

/** A new database (in memory) with every 1.0 step's tables. */
function schemaDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const step of V1_0_STEPS) for (const sql of step.ddl) db.exec(sql)
  return db
}

/** The document after a trip through the tables, as text. */
function roundTrip(db: DatabaseSync, n: number, doc: Record<string, unknown>): string {
  db.exec('BEGIN')
  writeCardRows(db, decomposeCard(n, doc))
  db.exec('COMMIT')
  const [rows] = readCardRows(db, { numbers: [n] })
  return JSON.stringify(composeCard(rows))
}

/** A card as 0.9.3 saves it (saveCard's order). */
const card = (n: number, more: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: n,
  title: `Card ${n}`,
  description: 'What to do',
  project: 'alpha',
  projectId: 'p-1',
  agent: 'a-1',
  agentName: 'B1',
  column: 'doing',
  order: 3.5,
  labels: ['1.0.0', 'storage'],
  blocked: null,
  blockedBy: [2],
  links: [3, 4],
  comments: [{ at: '2026-10-20T10:00:00.000Z', by: 'You', text: 'Go', id: 'c1' }],
  history: [{ at: '2026-10-20T10:00:00.000Z', by: 'You', what: 'Created', whatText: { id: 'tasks.history.created' }, id: 'h1' }],
  archived: false,
  createdAt: '2026-10-20T10:00:00.000Z',
  createdBy: 'You',
  updatedAt: '2026-10-20T10:00:00.000Z',
  ...more
})

describe('the 1.0 schema', () => {
  it('makes every step on an empty file, in order', () => {
    const db = schemaDb()
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name)
    for (const t of ['cards', 'card_labels', 'card_links', 'card_context', 'card_comments', 'card_history', 'card_decisions', 'card_holds', 'sessions', 'session_cards', 'sessions_deleted', 'sessions_deleted_usage', 'deliveries', 'lanes', 'lane_cards', 'lane_frozen', 'watches', 'watch_cards', 'metrics_buckets', 'metrics_series', 'card_facts', 'card_actions', 'rulesets', 'folder_commits', 'project_keys', 'project_counters', 'card_aliases', 'lane_runs', 'lane_pending', 'assistant_changes', 'assistant_change_values', 'assistant_change_outcomes', 'queue_runners', 'queue_runner_procs', 'queue_worktrees', 'slots', 'slot_leases', 'copies', 'copy_leases', 'skill_copies']) expect(tables).toContain(t)
    // One lane record (#1291): the runtime's own lane tables are gone.
    for (const t of ['workflow_lanes', 'workflow_lane_cards']) expect(tables).not.toContain(t)
    expect(V1_0_STEPS.map((s) => s.name)).toEqual(['cards in tables', 'sessions and deliveries in tables', 'lanes, watches and metrics in tables', 'facts', 'project keys', 'one lane record', 'actions delivered by deliveries, lane notices', 'card search', 'assistant changes', 'undo outcomes', 'queue runners', 'queue pause messages', 'queue pause by', 'queue pause state', 'queue seen', 'slots', 'copies', 'skill copies', 'session leases', 'card attachments', 'card revisions', 'integrations by target'])
    db.close()
  })

  it.each(Object.entries(QUERIES))('%s uses its index', (_name, q) => {
    const db = schemaDb()
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.args) as { detail: string }[]).map((r) => r.detail)
    db.close()
    const uses = [q.index].flat().map((i) => (i === 'INTEGER PRIMARY KEY' || i === 'PRIMARY KEY' ? ` USING ${i} ` : ` INDEX ${i} `))
    expect(plan.some((d) => uses.some((u) => `${d} `.includes(u))), plan.join('\n')).toBe(true)
  })

  it("HI-2709: a page of a target's merges is a range of its index, never a scan of other targets' facts, nor a sort", () => {
    const db = schemaDb()
    const q = QUERIES['facts.integratedOn']
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.args) as { detail: string }[]).map((r) => r.detail)
    db.close()
    expect(plan.some((d) => /SEARCH f USING INDEX card_facts_integrated_target \(<expr>=\? AND rowid<\?\)/.test(d)), plan.join('\n')).toBe(true)
    expect(plan.some((d) => /SCAN f\b|TEMP B-TREE/.test(d)), plan.join('\n')).toBe(false)
  })

  it("keeps a key's case out of the way, and a card's facts go with the card", () => {
    const db = schemaDb()
    db.prepare("INSERT INTO project_keys (key, project_id, current, since) VALUES ('AM', 'p1', 1, '')").run()
    expect(() => db.prepare("INSERT INTO project_keys (key, project_id, current, since) VALUES ('am', 'p2', 1, '')").run()).toThrow(/UNIQUE/)
    writeCardRows(db, decomposeCard(5, card(5)))
    db.prepare("UPDATE cards SET project_id = 'p1', project_number = 12 WHERE number = 5").run()
    expect(db.prepare(QUERIES['keys.resolve'].sql).get(12, 'am')).toEqual({ number: 5 })
    db.prepare("INSERT INTO card_facts (card, seq, kind, at, actor, source, dedupe, data) VALUES (5, 1, 'HeadMoved', '', 'outside', 'observed', 'prev:0', '{}')").run()
    expect(() => db.prepare("INSERT INTO card_facts (card, seq, kind, at, actor, source, dedupe, data) VALUES (5, 2, 'HeadMoved', '', 'outside', 'observed', 'prev:0', '{}')").run()).toThrow(/UNIQUE/)
    db.prepare('DELETE FROM cards WHERE number = 5').run()
    for (const t of ['card_facts', 'card_comments', 'card_history', 'card_labels', 'card_links']) expect(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()).toEqual({ n: 0 })
    db.close()
  })

  it('never gives an action id again once its card is deleted, while its delivery is kept (HR4 round 1)', () => {
    const db = schemaDb()
    writeCardRows(db, decomposeCard(1, card(1)))
    const first = Number(db.prepare("INSERT INTO card_actions (card, kind, payload) VALUES (1, 'wake', '{}')").run().lastInsertRowid)
    db.prepare("INSERT INTO deliveries (host, id, seq, agent_id, conversation, kind, sender, body, state, created, expires, received, action) VALUES ('p1', 'm1', 1, 'a1', NULL, 'card-event', '{}', 'x', 'received', '', '', '', ?)").run(first)
    db.prepare('DELETE FROM cards WHERE number = 1').run()
    expect(db.prepare('SELECT count(*) AS n FROM card_actions').get()).toEqual({ n: 0 })
    writeCardRows(db, decomposeCard(2, card(2)))
    const next = Number(db.prepare("INSERT INTO card_actions (card, kind, payload) VALUES (2, 'wake', '{}')").run().lastInsertRowid)
    expect(next).toBeGreaterThan(first)
    db.prepare("INSERT INTO deliveries (host, id, seq, agent_id, conversation, kind, sender, body, state, created, expires, action) VALUES ('p1', 'm2', 2, 'a1', NULL, 'card-event', '{}', 'x', 'queued', '', '', ?)").run(next)
    expect(db.prepare(QUERIES['deliveries.byAction'].sql).get(first)).toEqual({ id: 'm1' })
    db.close()
  })

  it("reads a folder's commits in the order seen, not by SHA (HR4 round 1)", () => {
    const db = schemaDb()
    const ins = db.prepare('INSERT INTO folder_commits (folder, sha, card, how) VALUES (?, ?, ?, ?)')
    ins.run('D:\\ws\\p', 'ffff', 1, 'trailer')
    ins.run('D:\\ws\\p', 'aaaa', null, 'unattributed')
    expect(() => ins.run('d:\\WS\\p', 'aaaa', null, 'unattributed')).toThrow(/UNIQUE/)
    expect((db.prepare(QUERIES['folderCommits.of'].sql).all('d:\\ws\\P') as { sha: string }[]).map((r) => r.sha)).toEqual(['ffff', 'aaaa'])
    db.close()
  })
})

describe('the card JSON contract', () => {
  const db = schemaDb()
  afterAll(() => db.close())
  const cases: [string, Record<string, unknown>][] = [
    ['a card as 0.9.3 saves it', card(1)],
    ['an unassigned card, blocked, with no lists', card(2, { agent: null, agentName: undefined, blocked: 'Waiting', labels: [], blockedBy: [], links: [], comments: [], history: [] })],
    ['being reviewed, with decisions, holds and context', card(3, { review: { agent: 'a-2', agentName: 'R1', since: '2026-10-20T11:00:00.000Z' }, context: ['docs/SPEC.md#164-facts'], contextProblems: [{ ref: 'docs/SPEC.md#x', problem: 'noHeading', closest: ['y'] }], decisions: [{ id: 'd1', text: 'Do it', decidedBy: 'user', recordedBy: 'Assistant', at: '2026-10-20T12:00:00.000Z', editedAt: '2026-10-20T12:30:00.000Z' }], held: [{ agent: 'a-1', name: 'B1', role: 'build', from: 'x', to: 'y' }, { name: 'R1', role: 'review', from: 'z' }] })],
    ['archived, its fields after updatedAt (an older order)', { ...card(4, { archived: true }), archivedFor: 'done', archivedBatch: 'b1' }],
    ['an order of its own and a field missing', { title: 'Odd', number: 5, description: '', project: '', agent: null, column: 'todo', order: 1, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: 'a', createdBy: 'b', updatedAt: 'c' }],
    ['fields Combwork does not know, and known ones of another type', card(6, { worktree: 'old', archived: 1, order: '2', labels: ['a', 7], blockedBy: [1.5], agent: '', review: { agent: 'a', since: 's' }, title: 42 })],
    ['entries not of Combwork\'s form', card(7, { comments: [{ by: 'You', at: 'x', text: 'order' }, null, 'text', { at: 'x', by: 'y', text: 'z', extra: true }, { at: 'x', by: 'y', text: 5 }], history: [{ at: 'x', by: 'y', what: 'z', whatText: null }], held: [] })],
    ['an empty optional list kept', card(8, { decisions: [] })],
    ['a lone surrogate in text', card(9, { title: 'bad \ud800 title', comments: [{ at: 'x', by: 'y', text: 'half \udc00' }] })],
    ['the wrong number inside', card(10, { number: 11 })],
    ['numbers of every kind', card(12, { order: -0.000001, links: [9007199254740991] })],
    // As JSON.parse makes them (own fields), never as an object literal would (HR4 round 1).
    ['fields named like Object.prototype\'s', JSON.parse('{"number":13,"title":"Test","__proto__":{"future":true},"constructor":1,"toString":"x"}')],
    ['such a field in an entry and inside extra', card(14, { comments: JSON.parse('[{"at":"x","by":"y","text":"z","__proto__":1}]'), worktree: JSON.parse('{"__proto__":[1]}') })]
  ]
  it.each(cases)('%s', (_name, doc) => {
    const want = JSON.stringify(doc)
    const n = cases.findIndex(([, d]) => d === doc) + 100
    expect(JSON.stringify(composeCard(decomposeCard(n, doc)))).toBe(want)
    expect(roundTrip(db, n, doc)).toBe(want)
  })

  it('keeps the columns readers query, and no layout for a card of Combwork\'s form', () => {
    const r = decomposeCard(1, card(1))
    expect(r.card).toMatchObject({ col: 'doing', ord: 3.5, agent: 'a-1', archived: 0, extra: null, layout: null })
    const odd = decomposeCard(6, card(6, { title: 42, order: '2' }))
    expect(odd.card).toMatchObject({ title: 'Task 6', ord: 2 })
    expect(JSON.parse(odd.card.extra!)).toEqual({ title: 42, order: '2' })
  })

  const live = process.env.CW_CARD_ROUNDTRIP_DB
  it.skipIf(!live)("round-trips every card of a live board's copy", () => {
    const copy = join(tempDir('cw-roundtrip-'), 'combwork.db')
    copyFileSync(live!, copy)
    if (existsSync(`${live}-wal`)) copyFileSync(`${live}-wal`, `${copy}-wal`)
    const old = new DatabaseSync(copy)
    const docs = old.prepare('SELECT number, doc FROM cards ORDER BY number').all() as { number: number; doc: string }[]
    old.close()
    const to = schemaDb()
    const t0 = performance.now()
    to.exec('BEGIN')
    const layouts = docs.filter(({ number, doc }) => {
      const r = decomposeCard(number, JSON.parse(doc))
      writeCardRows(to, r)
      return r.card.layout !== null
    }).length
    to.exec('COMMIT')
    const wrote = performance.now() - t0
    const back = new Map(readCardRows(to).map((r) => [r.card.number, JSON.stringify(composeCard(r))]))
    const total = performance.now() - t0
    to.close()
    const differ = docs.filter(({ number, doc }) => back.get(number) !== doc).map((d) => d.number)
    console.log(`round trip: ${docs.length} cards, ${layouts} with a layout of their own; written in ${Math.round(wrote)} ms, read back and composed in ${Math.round(total - wrote)} ms; ${differ.length} differ`)
    expect(differ).toEqual([])
    expect(back.size).toBe(docs.length)
  })
})
