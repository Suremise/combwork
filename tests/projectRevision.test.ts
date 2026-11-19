// The facts' epoch (HI-3291, schema/projectRevsStep.ts), what FactStore's kept facts are checked against, and v33's drop
// of the project revision beside it (HI-3306, schema/projectRevsDropStep.ts: unread since HI-3296's queue revision): a
// new board and one upgraded from v32 keep the epoch, raised by triggers of its own for every connection's writes, and
// have no project revision. Facts kept across commits equal a full read after appends, a card deleted and another made
// (the card count unchanged), the highest facts deleted and their rowids reused, another connection's writes, and a card
// with its history moving into and out of a project.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import { writeCardOutside } from './boardDb'
import { timing } from './timing.cjs'

const base = tempDir('cw-project-revision-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { openDb } = await import('../src/main/db')
const { PROJECT_REVS_STEP } = await import('../src/main/schema/projectRevsStep')
const { dropProjectRevs } = await import('../src/main/schema/projectRevsDropStep')

const user = { kind: 'user' } as const
let n = 0
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

/** A workspace with two projects, p and q. */
async function workspace(): Promise<{ ws: string; w: WS }> {
  const ws = join(base, `ws-${++n}`)
  for (const p of ['p', 'q']) {
    mkdirSync(join(ws, p, '.combwork'), { recursive: true })
    writeFileSync(join(ws, p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  }
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { ws, w }
}

/** Runs `sql` on the board's file from another connection (another Combwork, a script), in a transaction of its own. */
function outside(ws: string, sql: string, ...args: (string | number)[]): void {
  const db = new DatabaseSync(store.boardFile(ws), { timeout: timing('db.busyMs') })
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.prepare(sql).run(...args)
  } finally {
    db.close()
  }
}

const card = (w: WS, project: string, title = 'Card') => inWorkspace(w, async () => (await tasks.createTask({ title, project }, user)).number)
const docOf = (w: WS, c: number): Record<string, unknown> => store.cardDoc(w, c)!

describe("v33 drops the project revision, unread since HI-3296's queue revision (HI-3306)", () => {
  /** v31's and v33's tables and triggers on a connection: name and SQL, by name. */
  const owned = (db: DatabaseSync) =>
    db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name = 'project_revs' OR name = 'facts_epoch' OR name LIKE '%\\_prev\\_%' ESCAPE '\\' OR name LIKE '%\\_epoch\\_%' ESCAPE '\\' ORDER BY name").all() as { type: string; name: string; sql: string }[]
  const names = (db: DatabaseSync) => owned(db).map((r) => r.name)
  const epoch = (ws: string): number => (store.workspaceDb(ws).reader.prepare('SELECT g FROM facts_epoch').get() as { g: number }).g
  const NEW_EPOCH = ['card_facts_epoch_ad', 'card_facts_epoch_au', 'cards_epoch_ad', 'cards_epoch_au', 'facts_epoch']

  /** The epoch moves for a fact rewritten or deleted, a card moved or deleted (an undone write's raise undone too), never for a fact appended or a comment. */
  async function epochHolds(ws: string, w: WS): Promise<void> {
    const c = await card(w, 'p')
    const d = await card(w, 'q')
    const e = await card(w, 'p')
    const fact = (k: number, seq: number) => outside(ws, "INSERT INTO card_facts (card, seq, kind, at, actor, source, data) VALUES (?, ?, 'Unblocked', '2026-11-15T00:00:00.000Z', 'outside', 'observed', '{}')", k, seq)
    let g = epoch(ws)
    fact(c, 1)
    fact(c, 2)
    await inWorkspace(w, () => tasks.commentTask(c, 'a note', user))
    expect(epoch(ws)).toBe(g)
    outside(ws, "UPDATE card_facts SET data = '{\"x\":1}' WHERE card = ? AND seq = 1", c)
    expect(epoch(ws)).toBe(++g)
    outside(ws, 'DELETE FROM card_facts WHERE card = ? AND seq = 2', c)
    expect(epoch(ws)).toBe(++g)
    writeCardOutside(ws, d, { ...docOf(w, d), project: 'p' })
    expect(epoch(ws)).toBeGreaterThan(g)
    g = epoch(ws)
    await expect(store.boardWrite(w, async () => {
      store.boardWriteOp(w, (db) => db.prepare('DELETE FROM cards WHERE number = ?').run(e))
      throw new Error('undone')
    })).rejects.toThrow('undone')
    expect(epoch(ws)).toBe(g)
    outside(ws, 'DELETE FROM cards WHERE number = ?', e)
    expect(epoch(ws)).toBeGreaterThan(g)
  }

  it('a new board has no project revision, keeps the epoch with triggers of its own, and its comment writes no revision row', async () => {
    const { ws, w } = await workspace()
    expect(names(store.workspaceDb(ws).reader)).toEqual(NEW_EPOCH)
    await epochHolds(ws, w)
    // Running the step again changes nothing.
    const before = owned(store.workspaceDb(ws).reader)
    await store.boardWrite(w, async () => void store.boardWriteOp(w, (db) => dropProjectRevs(db as DatabaseSync)))
    expect(owned(store.workspaceDb(ws).reader)).toEqual(before)
  })

  it('a board at v32 (the RC, a dev build) upgrades: its cards, comments and facts kept, the epoch kept as it was, the revision and its triggers gone', async () => {
    // The schema a board v32 made has, as v31 and v32 made it on a new file.
    const fresh = join(base, `v32-${++n}.db`)
    const v32 = openDb(fresh, { migrations: store.BOARD_MIGRATIONS.filter((m) => m.version <= 32), appVersion: '1.6.0-rc.1' })
    const atV32 = owned(v32.writer)
    v32.close()
    expect(atV32.map((r) => r.name)).toContain('project_revs')

    const { ws, w } = await workspace()
    const c = await card(w, 'p')
    await inWorkspace(w, () => tasks.commentTask(c, 'kept', user))
    outside(ws, "INSERT INTO card_facts (card, seq, kind, at, actor, source, data) VALUES (?, (SELECT max(seq) + 1 FROM card_facts WHERE card = ?), 'Unblocked', '2026-11-15T00:00:00.000Z', 'outside', 'observed', '{}')", c, c)
    const doc = JSON.stringify(docOf(w, c))
    await disposeWorkspaceService(w)
    opened.splice(opened.indexOf(w), 1)
    store.closeBoard(ws)
    // The board put back as v32 left it: v31's table and triggers, without v33's, at v32, its epoch moved on.
    const db = new DatabaseSync(store.boardFile(ws))
    try {
      db.exec('BEGIN')
      for (const t of ['cards_epoch_ad', 'card_facts_epoch_au', 'card_facts_epoch_ad']) db.exec(`DROP TRIGGER ${t}`)
      PROJECT_REVS_STEP.up(db)
      db.exec('UPDATE facts_epoch SET g = 41')
      db.exec('DELETE FROM schema_version WHERE version > 32')
      db.exec('COMMIT')
      expect(owned(db)).toEqual(atV32)
    } finally {
      db.close()
    }

    const w2 = createWorkspaceService()
    await w2.open(ws)
    opened.push(w2)
    const reader = store.workspaceDb(ws).reader
    // Upgraded through v33 and every step after it (HI-3374's v34 quiet claims): at the board's latest version.
    const latest = Math.max(...store.BOARD_MIGRATIONS.map((m) => m.version))
    expect(latest).toBeGreaterThanOrEqual(33)
    expect((reader.prepare('SELECT version FROM schema_version WHERE version = 33').get() as { version: number } | undefined)?.version, 'v33 ran').toBe(33)
    expect((reader.prepare('SELECT max(version) AS v FROM schema_version').get() as { v: number }).v).toBe(latest)
    expect(names(reader)).toEqual(NEW_EPOCH)
    expect(epoch(ws)).toBe(41)
    expect(JSON.stringify(docOf(w2, c))).toBe(doc)
    expect((reader.prepare('SELECT count(*) AS n FROM card_facts WHERE card = ?').get(c) as { n: number }).n).toBe(2)
    await epochHolds(ws, w2)
  })
})

describe('facts kept across commits equal a full read (HI-3291)', () => {
  const scope = { project: 'p', key: 'P' }
  const KIND = 'IntegrationRequested' as const
  const req = (entry: string) => ({ kind: KIND, actor: 'combwork' as const, source: 'recorded' as const, data: { entry, revision: 'f'.repeat(40), key: null, target: 'main', style: 'merge' } as never })
  /** What a store reading everything now gives, by kind and for a card. */
  const full = (w: WS, c?: number) => {
    const s = FactStore.forBoard(w, scope)
    return c === undefined ? s.factsOfKind(KIND) : s.facts(c)
  }
  const entries = (fs: { data: unknown }[]) => fs.map((f) => (f.data as { entry: string }).entry)

  it('after appends here and by another connection, a card deleted and another made, and the highest facts deleted and their rowids reused', async () => {
    const { ws, w } = await workspace()
    const kept = FactStore.forBoard(w, scope)
    const [a, b] = [await card(w, 'p'), await card(w, 'p')]
    const append = (c: number, entry: string) => store.boardWrite(w, async () => kept.tx((tx) => void tx.append(c, req(entry))))
    await append(a, 'a1')
    expect(entries(kept.factsOfKind(KIND))).toEqual(['a1'])
    expect(entries(kept.facts(a))).toEqual(['a1'])
    await append(b, 'b1')
    await append(a, 'a2')
    expect(kept.factsOfKind(KIND)).toEqual(full(w))
    expect(entries(kept.factsOfKind(KIND))).toEqual(['a1', 'b1', 'a2'])
    expect(kept.facts(a)).toEqual(full(w, a))
    // Another connection's fact (another Combwork): seen.
    outside(ws, "INSERT INTO card_facts (card, seq, kind, at, actor, source, data) VALUES (?, 3, ?, '2026-11-15T00:00:00.000Z', 'combwork', 'recorded', ?)", a, KIND, JSON.stringify({ entry: 'a3', revision: 'f'.repeat(40), key: null, target: 'main', style: 'merge' }))
    expect(entries(kept.factsOfKind(KIND))).toEqual(['a1', 'b1', 'a2', 'a3'])
    expect(kept.facts(a)).toEqual(full(w, a))
    // b deleted (its facts with it) and another card made: the count of cards as it was.
    outside(ws, 'DELETE FROM cards WHERE number = ?', b)
    const c = await card(w, 'p')
    await append(c, 'c1')
    expect(kept.factsOfKind(KIND)).toEqual(full(w))
    expect(entries(kept.factsOfKind(KIND))).toEqual(['a1', 'a2', 'a3', 'c1'])
    // The highest facts deleted (a3, c1), then appended again: their rowids reused by the new ones.
    const top = (store.workspaceDb(ws).reader.prepare('SELECT max(rowid) AS m FROM card_facts').get() as { m: number }).m
    outside(ws, 'DELETE FROM card_facts WHERE rowid >= ?', top - 1)
    await append(c, 'c2')
    expect((store.workspaceDb(ws).reader.prepare('SELECT max(rowid) AS m FROM card_facts').get() as { m: number }).m).toBeLessThanOrEqual(top)
    expect(kept.factsOfKind(KIND)).toEqual(full(w))
    expect(entries(kept.factsOfKind(KIND))).toEqual(['a1', 'a2', 'c2'])
    expect(kept.facts(a)).toEqual(full(w, a))
    expect(kept.facts(c)).toEqual(full(w, c))
  })

  it("a kept card's or kind's facts untouched by the commits since are served unread, and a touched one reads what was appended", async () => {
    const { ws, w } = await workspace()
    const kept = FactStore.forBoard(w, scope)
    const [a, b] = [await card(w, 'p'), await card(w, 'p')]
    const append = (c: number, entry: string, kind: typeof KIND | 'IntegrationCancelled' = KIND) =>
      store.boardWrite(w, async () => kept.tx((tx) => void tx.append(c, kind === KIND ? req(entry) : { kind, actor: 'combwork', source: 'recorded', data: { entry, reason: 'removed' } as never })))
    await append(a, 'a1')
    expect(entries(kept.facts(a))).toEqual(['a1'])
    expect(entries(kept.factsOfKind(KIND))).toEqual(['a1'])
    // b's fact of another kind: a's facts and the kind's list untouched, served as kept, and still what a full read gives.
    await append(b, 'b1', 'IntegrationCancelled')
    expect(kept.facts(a)).toEqual(full(w, a))
    expect(kept.factsOfKind(KIND)).toEqual(full(w))
    // Another connection's comment (no fact): the same.
    outside(ws, "INSERT INTO card_labels (card, ord, label) VALUES (?, 0, 'x')", a)
    expect(kept.facts(a)).toEqual(full(w, a))
    // A fact on a, from another connection: read.
    outside(ws, "INSERT INTO card_facts (card, seq, kind, at, actor, source, data) VALUES (?, 2, ?, '2026-11-15T00:00:00.000Z', 'combwork', 'recorded', ?)", a, KIND, JSON.stringify({ entry: 'a2', revision: 'f'.repeat(40), key: null, target: 'main', style: 'merge' }))
    expect(entries(kept.facts(a))).toEqual(['a1', 'a2'])
    expect(entries(kept.factsOfKind(KIND))).toEqual(['a1', 'a2'])
    // Several commits between reads (the marks' range spans them all).
    await append(b, 'b2')
    await append(a, 'a3')
    await append(b, 'b3', 'IntegrationCancelled')
    expect(entries(kept.facts(a))).toEqual(['a1', 'a2', 'a3'])
    expect(kept.facts(b)).toEqual(full(w, b))
    expect(entries(kept.factsOfKind(KIND))).toEqual(['a1', 'a2', 'b2', 'a3'])
  })

  it('a card with its history moving into and out of the project', async () => {
    const { ws, w } = await workspace()
    const kept = FactStore.forBoard(w, scope)
    const inQ = FactStore.forBoard(w, { project: 'q', key: 'Q' })
    const a = await card(w, 'p')
    const d = await card(w, 'q')
    await store.boardWrite(w, async () => kept.tx((tx) => void tx.append(a, req('a1'))))
    await store.boardWrite(w, async () => inQ.tx((tx) => void tx.append(d, req('d1'))))
    expect(entries(kept.factsOfKind(KIND))).toEqual(['a1'])
    expect(entries(inQ.factsOfKind(KIND))).toEqual(['d1'])
    writeCardOutside(ws, d, { ...docOf(w, d), project: 'p' })
    expect(entries(kept.factsOfKind(KIND))).toEqual(['a1', 'd1'])
    expect(inQ.factsOfKind(KIND)).toEqual([])
    writeCardOutside(ws, d, { ...docOf(w, d), project: 'q' })
    expect(entries(kept.factsOfKind(KIND))).toEqual(['a1'])
    expect(entries(inQ.factsOfKind(KIND))).toEqual(['d1'])
    expect(kept.factsOfKind(KIND)).toEqual(full(w))
  })

  it('inside a write, its own facts are seen and nothing it read is kept after it is undone', async () => {
    const { w } = await workspace()
    const kept = FactStore.forBoard(w, scope)
    const a = await card(w, 'p')
    await store.boardWrite(w, async () => kept.tx((tx) => void tx.append(a, req('a1'))))
    expect(entries(kept.factsOfKind(KIND))).toEqual(['a1'])
    await expect(
      store.boardWrite(w, async () => {
        kept.tx((tx) => void tx.append(a, req('a2')))
        expect(entries(kept.factsOfKind(KIND))).toEqual(['a1', 'a2'])
        throw new Error('undone')
      })
    ).rejects.toThrow('undone')
    expect(entries(kept.factsOfKind(KIND))).toEqual(['a1'])
    expect(kept.factsOfKind(KIND)).toEqual(full(w))
  })
})

describe('the cards changed since a snapshot (HI-3301, boardStore.changedCardsIn)', () => {
  /** The marks now, and the cards changed since `since` (null: it can't say), each on one read's snapshot. */
  const marks = (w: WS) => store.boardRead(w, (db) => store.changeMarksIn(w, db))
  const since = (w: WS, m: ReturnType<typeof marks>, most = 50) => store.boardRead(w, (db) => store.changedCardsIn(w, db, m, most)?.map((c) => [c.number, c.project]).sort())

  it("names a card written (its row, a child row, a fact), here or by another connection, with its project; the card at the mark too; nothing else", async () => {
    const { ws, w } = await workspace()
    const a = await card(w, 'p', 'A')
    const b = await card(w, 'q', 'B')
    const c = await card(w, 'p', 'C')
    const m0 = marks(w)
    // Only the card at the mark (written last: a card there keeps its revision when written again).
    expect(since(w, m0)).toEqual([[c, 'p']])
    outside(ws, "UPDATE cards SET title = 'A, renamed' WHERE number = ?", a)
    expect(since(w, m0)).toEqual([[a, 'p'], [c, 'p']])
    const m1 = marks(w)
    outside(ws, "INSERT INTO card_labels (card, ord, label) VALUES (?, 0, 'x')", b)
    expect(since(w, m1)).toEqual([[a, 'p'], [b, 'q']])
    const m2 = marks(w)
    outside(ws, "INSERT INTO card_facts (card, seq, kind, at, actor, source, data) VALUES (?, 1, 'Unblocked', '2026-11-15T00:00:00.000Z', 'outside', 'observed', '{}')", c)
    expect(since(w, m2)).toEqual([[b, 'q'], [c, 'p']])
  })

  it("can't say after a fact or a card deleted, nor past `most` cards", async () => {
    const { ws, w } = await workspace()
    const a = await card(w, 'p', 'A')
    const b = await card(w, 'p', 'B')
    outside(ws, "INSERT INTO card_facts (card, seq, kind, at, actor, source, data) VALUES (?, 1, 'Unblocked', '2026-11-15T00:00:00.000Z', 'outside', 'observed', '{}')", a)
    let m = marks(w)
    outside(ws, 'DELETE FROM card_facts WHERE card = ?', a)
    expect(since(w, m)).toBeUndefined()
    m = marks(w)
    outside(ws, 'DELETE FROM cards WHERE number = ?', b)
    expect(since(w, m)).toBeUndefined()
    m = marks(w)
    for (const t of ['C', 'D', 'E']) await card(w, 'p', t)
    expect(since(w, m, 2)).toBeUndefined()
    // The three made (the card at the mark was the one deleted).
    expect(since(w, m, 5)).toHaveLength(3)
  })
})
