// A project's revision and the facts' epoch (HI-3291, schema/projectRevsStep.ts): what caches of a project's board reads
// (its queue listings, FactStore.factsOfKind and facts) are checked against. Raised by triggers for every connection's
// writes: a write to one of a project's cards, its facts or the child rows a card is made of raises that project only,
// even for a card already at the board's highest revision (whose `rev` stays as it is); a card moving between projects
// raises both; reading changes nothing. Facts kept across commits equal a full read after appends, a card deleted and
// another made (the card count unchanged), the highest facts deleted and their rowids reused, another connection's
// writes, and a card with its history moving into and out of a project.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import { writeCardOutside } from './boardDb'

const base = tempDir('cw-project-revision-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')

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
  const db = new DatabaseSync(store.boardFile(ws), { timeout: 5000 })
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.prepare(sql).run(...args)
  } finally {
    db.close()
  }
}

/** A raw write in a board change of this Combwork's. */
const inside = (w: WS, sql: string, ...args: (string | number)[]) => store.boardWrite(w, async () => void store.boardWriteOp(w, (db) => db.prepare(sql).run(...args)))
const card = (w: WS, project: string, title = 'Card') => inWorkspace(w, async () => (await tasks.createTask({ title, project }, user)).number)
const atTop = (ws: string, c: number): boolean => {
  const db = store.workspaceDb(ws).reader
  return (db.prepare('SELECT rev FROM cards WHERE number = ?').get(c) as { rev: number }).rev === (db.prepare('SELECT g FROM board_rev').get() as { g: number }).g
}
const docOf = (w: WS, c: number): Record<string, unknown> => store.cardDoc(w, c)!

describe("a project's revision (HI-3291)", () => {
  it("a card's child-only writes at the board's highest revision each raise its project, never another; a read raises nothing", async () => {
    const { ws, w } = await workspace()
    const c = await card(w, 'p')
    await card(w, 'q')
    const c2 = await card(w, 'p', 'Last')
    // The card written last is at the board's mark: its later writes leave its `rev` as it is (CARD_REVS_STEP).
    expect(atTop(ws, c2)).toBe(true)
    const p0 = store.projectRevision(w, 'p')
    const q0 = store.projectRevision(w, 'q')
    expect(p0).not.toBeNull()
    // Read again with no write: the same, for both.
    expect([store.projectRevision(w, 'p'), store.projectRevision(w, 'q')]).toEqual([p0, q0])
    // Two child-only writes, each its own commit (a label here, then one from another connection), no fact, no row change.
    await inside(w, "INSERT INTO card_labels (card, ord, label) VALUES (?, 0, 'one')", c2)
    expect(atTop(ws, c2)).toBe(true)
    const p1 = store.projectRevision(w, 'p')
    expect(p1).not.toBe(p0)
    expect(store.projectRevision(w, 'q')).toBe(q0)
    outside(ws, "INSERT INTO card_labels (card, ord, label) VALUES (?, 1, 'two')", c2)
    const p2 = store.projectRevision(w, 'p')
    expect(p2).not.toBe(p1)
    expect(store.projectRevision(w, 'q')).toBe(q0)
    // An update and a delete of child rows, and a comment, raise it too.
    outside(ws, "UPDATE card_labels SET label = 'three' WHERE card = ? AND ord = 0", c2)
    expect(store.projectRevision(w, 'p')).not.toBe(p2)
    const p3 = store.projectRevision(w, 'p')
    await inWorkspace(w, () => tasks.commentTask(c, 'a note', user))
    expect(store.projectRevision(w, 'p')).not.toBe(p3)
    expect(store.projectRevision(w, 'q')).toBe(q0)
  })

  it('a fact raises its project; a card moved between projects raises both; a card deleted raises its own', async () => {
    const { ws, w } = await workspace()
    const c = await card(w, 'p')
    const d = await card(w, 'q')
    const facts = FactStore.forBoard(w, { project: 'p', key: 'P' })
    let [p, q] = [store.projectRevision(w, 'p'), store.projectRevision(w, 'q')]
    await store.boardWrite(w, async () => facts.tx((tx) => void tx.append(c, { kind: 'IntegrationRequested', actor: 'combwork', source: 'recorded', data: { entry: 'e1', revision: 'f'.repeat(40), key: null, target: 'main', style: 'merge' } as never })))
    expect(store.projectRevision(w, 'p')).not.toBe(p)
    expect(store.projectRevision(w, 'q')).toBe(q)
    ;[p, q] = [store.projectRevision(w, 'p'), store.projectRevision(w, 'q')]
    writeCardOutside(ws, d, { ...docOf(w, d), project: 'p' })
    expect(store.projectRevision(w, 'p')).not.toBe(p)
    expect(store.projectRevision(w, 'q')).not.toBe(q)
    ;[p, q] = [store.projectRevision(w, 'p'), store.projectRevision(w, 'q')]
    outside(ws, 'DELETE FROM cards WHERE number = ?', c)
    expect(store.projectRevision(w, 'p')).not.toBe(p)
    expect(store.projectRevision(w, 'q')).toBe(q)
  })

  it('is null inside a write (a cache keeps nothing there)', async () => {
    const { w } = await workspace()
    await card(w, 'p')
    let inWrite: string | null = 'unset'
    await store.boardWrite(w, async () => void (inWrite = store.projectRevision(w, 'p')))
    expect(inWrite).toBeNull()
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
