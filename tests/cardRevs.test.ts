// A window's board read sends only what changed (HI-1715): each card's revision, kept by triggers on its row and the child
// tables a window's card is made of (whoever writes them: another connection too), and the board's mark; tasks:changes
// sends the cards at the window's mark or above, every card's number, and the whole board when the board was opened again
// or a card's key or project name changed; a read the board's reopening overtook is stale.
import { copyFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import type { TaskChanges, TaskCursor } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('cw-card-revs-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')

const user = { kind: 'user' } as const
const wsPath = join(base, 'ws')
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const changes = (since: TaskCursor | null): Promise<TaskChanges> => run(() => tasks.windowChanges(w, since))
type Read = Extract<TaskChanges, { board: string }>
const read = async (since: TaskCursor | null): Promise<Read> => {
  const r = await changes(since)
  if (r.stale) throw new Error('stale')
  return r
}
const cursor = (r: Read): TaskCursor => ({ board: r.board, mark: r.mark! })
const sent = (r: Read): number[] => r.cards.map((c) => c.number).sort((a, b) => a - b)
/** Another connection to the board's file, as another Combwork or a script has. */
const other = (): DatabaseSync => new DatabaseSync(store.boardFile(wsPath))
const rev = (db: DatabaseSync, n: number): number => (db.prepare('SELECT rev FROM cards WHERE number = ?').get(n) as { rev: number }).rev
const mark = (db: DatabaseSync): number => (db.prepare('SELECT g FROM board_rev').get() as { g: number }).g

let a = 0
let b = 0
let c = 0
beforeAll(async () => {
  mkdirSync(join(wsPath, 'alpha', '.combwork'), { recursive: true })
  // Two agents, for cards held (the usage history's holds, HI-1748).
  writeFileSync(join(wsPath, 'alpha', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'agent-1', name: 'Agent 1' }, { id: 'agent-2', name: 'Agent 2' }] }))
  w = createWorkspaceService()
  await w.open(wsPath)
  a = (await run(() => tasks.createTask({ title: 'A', project: 'alpha' }, user))).number
  b = (await run(() => tasks.createTask({ title: 'B', project: 'alpha' }, user))).number
  c = (await run(() => tasks.createTask({ title: 'C', project: 'alpha' }, user))).number
})
afterAll(async () => disposeWorkspaceService(w))

describe("a card's revision (HI-1715)", () => {
  it("is raised by a write to its row and to each child table a window's card is made of, by another connection too", async () => {
    const db = other()
    try {
      const writes: [string, string][] = [
        ['row', `UPDATE cards SET title = 'A2' WHERE number = ${a}`],
        ['label', `INSERT INTO card_labels (card, ord, label) VALUES (${a}, 0, 'x')`],
        ['link', `INSERT INTO card_links (card, kind, ord, target) VALUES (${a}, 'link', 0, ${b})`],
        ['context', `INSERT INTO card_context (card, ord, ref) VALUES (${a}, 0, 'docs/X.md')`],
        ['comment', `INSERT INTO card_comments (card, ord, at, by, text) VALUES (${a}, 0, '2026-10-26T00:00:00.000Z', 'T', 'hi')`],
        ['history', `UPDATE card_history SET by = 'T' WHERE card = ${a}`],
        ['decision', `INSERT INTO card_decisions (card, ord, id, text) VALUES (${a}, 0, 'd1', 'yes')`],
        ['hold', `INSERT INTO card_holds (card, ord, agent) VALUES (${a}, 0, 'a1')`],
        ['label removed', `DELETE FROM card_labels WHERE card = ${a}`]
      ]
      for (const [what, sql] of writes) {
        // Another card changed last, so this card is below the mark: the write raises it to the next.
        db.exec(`UPDATE cards SET title = title || '.' WHERE number = ${c}`)
        const g = mark(db)
        db.exec(sql)
        expect([what, rev(db, a)]).toEqual([what, g + 1])
        expect(mark(db)).toBe(g + 1)
      }
      // The raw rows taken out again: not all of them are of Combwork's form (a card read with them would fail).
      for (const t of ['card_links', 'card_context', 'card_comments', 'card_decisions', 'card_holds']) db.exec(`DELETE FROM ${t} WHERE card = ${a}`)
    } finally {
      db.close()
    }
  })

  it('is raised once for a write of many of its rows, and not again while it is the newest change', async () => {
    const db = other()
    try {
      db.exec(`UPDATE cards SET title = title || '.' WHERE number = ${c}`)
      const g = mark(db)
      db.exec('BEGIN')
      for (let i = 0; i < 50; i++) db.exec(`INSERT INTO card_comments (card, ord, at, by, text) VALUES (${b}, ${100 + i}, '2026-10-26T00:00:00.000Z', 'T', 'many')`)
      db.exec('COMMIT')
      expect(rev(db, b)).toBe(g + 1)
      expect(mark(db)).toBe(g + 1)
      // At the mark: changed again, it keeps it (the window's next read asks for the mark and above, so it is sent).
      db.exec(`UPDATE cards SET title = 'B2' WHERE number = ${b}`)
      expect(rev(db, b)).toBe(g + 1)
      expect(mark(db)).toBe(g + 1)
      db.exec(`DELETE FROM card_comments WHERE card = ${b} AND ord >= 100`)
    } finally {
      db.close()
    }
  })

  it('a rolled-back write leaves the revision and the mark as they were', async () => {
    const db = other()
    try {
      db.exec(`UPDATE cards SET title = title || '.' WHERE number = ${c}`)
      const before = { g: mark(db), a: rev(db, a) }
      db.exec('BEGIN')
      db.exec(`UPDATE cards SET title = 'rolled back' WHERE number = ${a}`)
      expect(rev(db, a)).toBe(before.g + 1)
      db.exec('ROLLBACK')
      expect({ g: mark(db), a: rev(db, a) }).toEqual(before)
    } finally {
      db.close()
    }
  })
})

describe('tasks:changes (HI-1715)', () => {
  it('without a cursor sends every card, and from its cursor only the cards at the mark or above', async () => {
    const all = await read(null)
    expect(all.full).toBe(true)
    expect(sent(all)).toEqual([a, b, c])
    expect(all.numbers).toEqual([a, b, c])
    await run(() => tasks.commentTask(b, 'one change', user))
    const next = await read(cursor(all))
    expect(next.full).toBe(false)
    expect(next.board).toBe(all.board)
    expect(next.mark).toBeGreaterThan(all.mark!)
    expect(sent(next)).toContain(b)
    // A card below the mark the window had isn't sent (the newest change before, at that mark, is).
    expect(sent(next)).not.toContain(a)
    expect(next.cards.find((x) => x.number === b)!.comments.at(-1)!.text).toBe('one change')
    // Nothing changed since: only the newest change, at the mark, is sent again.
    expect(sent(await read(cursor(next)))).toEqual([b])
  })

  it("a write another connection commits after a read is in the next read from that read's cursor, also to the card at the mark", async () => {
    const first = await read(null)
    const db = other()
    let at = 0
    try {
      // The card at the mark (the newest change), and another below it.
      at = (db.prepare('SELECT number FROM cards ORDER BY rev DESC LIMIT 1').get() as { number: number }).number
      const below = at === c ? a : c
      db.exec(`UPDATE cards SET description = 'again' WHERE number = ${at}`)
      db.exec(`UPDATE cards SET title = 'by another' WHERE number = ${below}`)
    } finally {
      db.close()
    }
    const next = await read(cursor(first))
    expect(sent(next)).toEqual(expect.arrayContaining([at, at === c ? a : c]))
    expect(next.cards.find((x) => x.number === (at === c ? a : c))!.title).toBe('by another')
    expect(next.cards.find((x) => x.number === at)!.description).toBe('again')
  })

  it('archived cards come in short, and in full again once unarchived; a deleted card leaves the numbers', async () => {
    const first = await read(null)
    await run(() => tasks.archiveTask(c, true))
    const archived = await read(cursor(first))
    expect(archived.cards.find((x) => x.number === c)).toMatchObject({ archived: true, summary: true })
    await run(() => tasks.archiveTask(c, false))
    const back = await read(cursor(archived))
    expect(back.cards.find((x) => x.number === c)!.summary).toBeUndefined()
    const gone = (await run(() => tasks.createTask({ title: 'Gone', project: 'alpha' }, user))).number
    await run(() => tasks.updateTask(a, { links: [gone] }, user))
    const withIt = await read(cursor(back))
    // Deleted (as Delete permanently leaves the board: its row gone, its child rows with it).
    const db = other()
    db.exec(`PRAGMA foreign_keys = ON; DELETE FROM cards WHERE number = ${gone}`)
    db.close()
    const without = await read(cursor(withIt))
    expect(without.numbers).not.toContain(gone)
    expect(without.full).toBe(false)
    // A card sent now leaves out its link to it, as main reads every card.
    await run(() => tasks.commentTask(a, 'after the delete', user))
    expect((await read(cursor(without))).cards.find((x) => x.number === a)!.links).toEqual([])
  })

  it("is whole when a card's key changes, and after the board is opened again (a database replaced)", async () => {
    const first = await read(null)
    const { changeProjectKey } = await import('../src/main/projectKeys')
    await run(() => changeProjectKey(w, join(wsPath, 'alpha'), 'ZZ'))
    const keyed = await read(cursor(first))
    expect(keyed.full).toBe(true)
    expect(keyed.board).not.toBe(first.board)
    expect(sent(keyed)).toEqual(keyed.numbers)
    // A copy of the board as it is, put back after a change: the board's file replaced, opened again.
    store.closeBoard(wsPath)
    const copy = join(base, 'copy.db')
    copyFileSync(store.boardFile(wsPath), copy)
    await run(() => tasks.commentTask(a, 'after the copy', user))
    store.closeBoard(wsPath)
    copyFileSync(copy, store.boardFile(wsPath))
    const replaced = await read(cursor(keyed))
    expect(replaced.full).toBe(true)
    expect(replaced.cards.find((x) => x.number === a)!.comments.some((x) => x.text === 'after the copy')).toBe(false)
  })

  it('is stale when the board is opened again while the project ids are read', async () => {
    const first = await read(null)
    const real = w.projectIds.bind(w)
    w.projectIds = async (o) => {
      const ids = await real(o)
      store.closeBoard(wsPath)
      return ids
    }
    try {
      expect(await changes(cursor(first))).toEqual({ stale: true })
    } finally {
      w.projectIds = real
    }
    expect((await read(cursor(first))).full).toBe(true)
  })
})

describe("the usage history's card holds, kept and read again for the cards a change touched (HI-1748)", () => {
  const kept = (): Promise<import('../src/main/tasks').CardHolds[]> => run(() => tasks.boardHolds(w))
  const whole = (): Promise<import('../src/main/tasks').CardHolds[]> => run(() => tasks.cardHolds(w))
  const same = async (): Promise<import('../src/main/tasks').CardHolds[]> => {
    const got = await kept()
    expect(got).toEqual(await whole())
    return got
  }

  it('are every card holds as a whole read gives them, through moves, comments, new, archived, deleted cards and another connection', async () => {
    const first = await same()
    // A comment changes no holds: every card the same object, read again for that card alone.
    await run(() => tasks.commentTask(a, 'no holds change', user))
    const at = store.holdChanges(w, null)!.mark
    await run(() => tasks.commentTask(b, 'one card', user))
    // B, and A at the mark (the read is inclusive: a write committed after it is in the next).
    expect(store.holdChanges(w, at)!.docs.map((d) => d.number)).toEqual([a, b])
    const after = await same()
    for (const x of after) if (x.number !== a && x.number !== b) expect(x).toBe(first.find((y) => y.number === x.number))
    // A move into Doing for an agent: a hold begins; out of it, it ends.
    await run(() => tasks.updateTask(a, { column: 'doing', agent: 'agent-1' }, user))
    expect((await same()).find((x) => x.number === a)!.held?.length).toBeGreaterThan(0)
    await run(() => tasks.updateTask(a, { column: 'todo' }, user))
    await same()
    const made = (await run(() => tasks.createTask({ title: 'Held later', project: 'alpha', column: 'doing', agent: 'agent-2' }, user))).number
    expect((await same()).some((x) => x.number === made)).toBe(true)
    await run(() => tasks.archiveTask(made, true))
    await same()
    // Another connection's write to a card's holds, and a card it deletes.
    const db = other()
    db.exec(`DELETE FROM card_holds WHERE card = ${made}`)
    db.exec(`PRAGMA foreign_keys = ON; DELETE FROM cards WHERE number = ${c}`)
    db.close()
    expect((await same()).some((x) => x.number === c)).toBe(false)
  })

  it('are read whole again after the board is opened again', async () => {
    await same()
    store.closeBoard(wsPath)
    await run(() => tasks.commentTask(a, 'reopened', user))
    await same()
  })
})

describe('cards kept until they change, as getTask reads them (HI-1780)', () => {
  const now = (numbers: number[]): ReturnType<typeof tasks.cardsNow> => run(() => tasks.cardsNow(w, numbers))
  const fresh = (n: number): Promise<unknown> => run(() => tasks.getTask(n, w))

  it("give each card as getTask does, the same object until it changes, and a link to a card gone since left out", async () => {
    const x = (await run(() => tasks.createTask({ title: 'X', project: 'alpha' }, user))).number
    const y = (await run(() => tasks.createTask({ title: 'Y', project: 'alpha' }, user))).number
    const z = (await run(() => tasks.createTask({ title: 'Z', project: 'alpha' }, user))).number
    const first = await now([x, y])
    expect(first.get(x)).toEqual(await fresh(x))
    expect(first.get(y)).toEqual(await fresh(y))
    // Y changes: Y read again, X the very same.
    await run(() => tasks.commentTask(y, 'changed', user))
    const second = await now([x, y])
    expect(second.get(x)).toBe(first.get(x))
    expect(second.get(y)).not.toBe(first.get(y))
    expect(second.get(y)).toEqual(await fresh(y))
    // X links to Z; Z deleted by another connection (as Delete permanently leaves the board): X no longer links to it.
    await run(() => tasks.updateTask(x, { links: [z] }, user))
    expect((await now([x])).get(x)!.links).toEqual([z])
    const db = other()
    db.exec(`PRAGMA foreign_keys = ON; DELETE FROM cards WHERE number = ${z}`)
    db.close()
    expect((await now([x])).get(x)).toEqual(await fresh(x))
    expect((await now([x])).get(x)!.links).toEqual([])
    // Not on the board: null.
    expect((await now([z])).get(z)).toBeNull()
  })

  it('give the newest card as it is after each change, though a card at the mark keeps its revision through them', async () => {
    const x = (await run(() => tasks.createTask({ title: 'Newest', project: 'alpha' }, user))).number
    await run(() => tasks.commentTask(x, 'first', user))
    const db = other()
    const at = rev(db, x)
    expect((await now([x])).get(x)!.comments.map((m) => m.text)).toContain('first')
    await run(() => tasks.commentTask(x, 'second', user))
    // Still at the mark: its revision didn't move, and it is read as it is all the same.
    expect(rev(db, x)).toBe(at)
    db.close()
    expect((await now([x])).get(x)).toEqual(await fresh(x))
    expect((await now([x])).get(x)!.comments.map((m) => m.text)).toContain('second')
  })

  it("are read again once a card's key changes, and after the board is opened again", async () => {
    const x = (await run(() => tasks.createTask({ title: 'Keyed', project: 'alpha' }, user))).number
    const first = (await now([x])).get(x)!
    const { changeProjectKey } = await import('../src/main/projectKeys')
    await run(() => changeProjectKey(w, join(wsPath, 'alpha'), 'KQ'))
    const keyed = (await now([x])).get(x)!
    expect(keyed.key).not.toBe(first.key)
    expect(keyed).toEqual(await fresh(x))
    store.closeBoard(wsPath)
    const reopened = (await now([x])).get(x)!
    expect(reopened).not.toBe(keyed)
    expect(reopened).toEqual(await fresh(x))
  })
})

describe("decision notices' live cards with decisions, kept and read again for the cards a change touched (HI-1789)", () => {
  type Live = { cards: import('../src/shared/types').TaskCard[]; generations: Map<number, number> }
  // What a decision notice reads of a card (boardStore's DECISION_FIELDS): all that is kept of it.
  const notice = (t: import('../src/shared/types').TaskCard) => ({ number: t.number, project: t.project, column: t.column, agent: t.agent, agentName: t.agentName, review: t.review, blocked: t.blocked, history: t.history, decisions: t.decisions })
  const kept = (): Promise<Live> => run(() => tasks.liveDecisionCards(w))
  // A whole read, as decision notices read it before: every live card in full, those with decisions kept.
  const whole = async (): Promise<Live> => {
    const all = await run(() => tasks.allTasksSeen(w, { archived: false }))
    const cards = all.cards.filter((x) => x.decisions?.length)
    return { cards, generations: new Map(cards.map((x) => [x.number, all.generations.get(x.number) ?? 0])) }
  }
  const same = async (): Promise<Live> => {
    const got = await kept()
    const all = await whole()
    expect(got.cards.map(notice)).toEqual(all.cards.map(notice))
    expect(got.generations).toEqual(all.generations)
    return got
  }

  it('are the live cards with decisions a whole read gives, with their generations, through decisions, comments, new, archived and deleted cards', async () => {
    const d = (await run(() => tasks.createTask({ title: 'Decided', project: 'alpha' }, user))).number
    const e = (await run(() => tasks.createTask({ title: 'Decided too', project: 'alpha' }, user))).number
    await run(() => tasks.updateTask(d, { decision: 'Keep it small.' }, user))
    await run(() => tasks.updateTask(e, { decision: 'Use the old API.' }, user))
    const first = await same()
    expect(first.cards.map((x) => x.number)).toEqual(expect.arrayContaining([d, e]))
    expect(first.generations.get(d)).toBeGreaterThan(0)
    // Nothing of a card but what a notice reads: no comments.
    await run(() => tasks.commentTask(d, 'a comment', user))
    expect((await same()).cards.find((x) => x.number === d)!.comments).toEqual([])
    // Comments on a card without decisions, A, at the mark (a read is inclusive: the card at the mark is read again):
    // every kept card the same object.
    await run(() => tasks.commentTask(a, 'no decision', user))
    const before = await kept()
    await run(() => tasks.commentTask(a, 'still no decision', user))
    const after = await same()
    for (const x of after.cards) expect(x).toBe(before.cards.find((y) => y.number === x.number))
    // A second decision: that card read again, its generation moved.
    await run(() => tasks.updateTask(d, { decision: 'And keep it fast.' }, user))
    const second = await same()
    expect(second.generations.get(d)).toBeGreaterThan(first.generations.get(d)!)
    // A card without decisions given one; a card archived leaves; another connection removes a card's decisions, and
    // deletes a card.
    await run(() => tasks.updateTask(b, { decision: 'Now decided.' }, user))
    expect((await same()).cards.some((x) => x.number === b)).toBe(true)
    await run(() => tasks.archiveTask(e, true))
    expect((await same()).cards.some((x) => x.number === e)).toBe(false)
    const db = other()
    db.exec(`DELETE FROM card_decisions WHERE card = ${b}`)
    db.exec(`PRAGMA foreign_keys = ON; DELETE FROM cards WHERE number = ${d}`)
    db.close()
    const left = await same()
    expect(left.cards.some((x) => x.number === b || x.number === d)).toBe(false)
  })

  it('are read whole again after the board is opened again', async () => {
    const x = (await run(() => tasks.createTask({ title: 'Decided, reopened', project: 'alpha' }, user))).number
    await run(() => tasks.updateTask(x, { decision: 'Before the reopen.' }, user))
    const first = await same()
    store.closeBoard(wsPath)
    await run(() => tasks.commentTask(a, 'reopened', user))
    const reopened = await same()
    expect(reopened.cards.find((t) => t.number === x)).not.toBe(first.cards.find((t) => t.number === x))
  })
})
