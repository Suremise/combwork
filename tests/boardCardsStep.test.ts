// The 1.0 cards step (#1209): cards in #1208's tables, a row each and their child rows. A new board takes the step with
// no cards (HI-3602: a 0.9 board's documents are no longer moved; such a board isn't opened), card files from before 0.9
// go straight into the tables, and a change saves into them. And the board read on one snapshot.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import { removeCard, writeCard, writeCardOutside } from './boardDb'

const base = tempDir('cw-cards-step-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { cardRowsTestHooks } = await import('../src/main/schema/cardRows')

const user = { kind: 'user' } as const
let n = 0
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
afterEach(() => {
  cardRowsTestHooks.afterCards = null
})

async function open(ws: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}
async function close(w: WS): Promise<void> {
  const path = w.path!
  opened.splice(opened.indexOf(w), 1)
  await disposeWorkspaceService(w)
  store.closeBoard(path)
}

/** A workspace folder with a project `p`. */
function workspace(): string {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, 'p', '.combwork'), { recursive: true })
  writeFileSync(join(ws, 'p', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  return ws
}

/** Documents of every form a card can hold: Combwork's own, an older version's, hand-edited ones. */
const ODD: Record<number, Record<string, unknown>> = {
  // Another key order, a field Combwork doesn't know, and one named like Object.prototype's.
  901: { title: 'Out of order', number: 901, column: 'todo', project: 'p', agent: null, description: '', order: 3, labels: ['x'], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'You', updatedAt: '2026-01-01T00:00:00.000Z', custom: { deep: [1, 2] }, ['__proto__']: 'kept' },
  // Fields missing or of another type: what tasks.ts' clean reads safely.
  902: { number: 902, title: 42, column: 'nowhere', order: '2', labels: 'not a list', comments: [{ text: 'a comment', by: 'You' }, 'not an entry'], held: [], archived: 1 },
  // A string with a lone surrogate, and a review not of Combwork's form.
  903: { number: 903, title: 'Lone \ud800 surrogate', description: 'tail \udc00', project: 'p', agent: 'a1', review: { agent: 'a2', since: '2026-01-02T00:00:00.000Z' }, column: 'review', order: 1, labels: [], blocked: null, blockedBy: [999], links: [1], comments: [], history: [], archived: false, createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'You', updatedAt: '2026-01-01T00:00:00.000Z' },
  // Archived, with holds and decisions of Combwork's form.
  904: { number: 904, title: 'Archived', description: 'd', project: 'p', agent: 'a1', agentName: 'Agent 1', column: 'done', order: 2, labels: ['1.0.0'], blocked: null, blockedBy: [], links: [], comments: [], history: [{ at: '2026-01-01T00:00:00.000Z', by: 'You', what: 'Moved to Done' }], archived: true, decisions: [{ id: 'd1', text: 'Keep it', decidedBy: 'You', recordedBy: 'You', at: '2026-01-01T00:00:00.000Z' }], held: [{ agent: 'a1', name: 'Agent 1', role: 'agent', from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' }], createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'You', updatedAt: '2026-01-01T00:00:00.000Z', archivedFor: 'done', archivedBatch: 'b1' }
}

/** A board with cards made by this Combwork and the odd ones. */
async function madeBoard(): Promise<{ ws: string; numbers: number[] }> {
  const ws = workspace()
  const w = await open(ws)
  const numbers = await inWorkspace(w, async () => {
    const a = await tasks.createTask({ title: 'Made here', project: 'p', labels: ['1.0.0'], description: 'With **Markdown**' }, user)
    await tasks.commentTask(a.number, 'A comment', user)
    await tasks.updateTask(a.number, { column: 'doing', blockedBy: [], links: [] }, user, { comment: 'Started' })
    const b = await tasks.createTask({ title: 'The workspace', project: '' }, user)
    for (const [k, doc] of Object.entries(ODD)) await writeCard(w, Number(k), doc)
    return [a.number, b.number, ...Object.keys(ODD).map(Number)]
  })
  await close(w)
  return { ws, numbers }
}

const columnsOf = (file: string): string[] => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (db.prepare("SELECT name FROM pragma_table_info('cards')").all() as { name: string }[]).map((r) => r.name)
  } finally {
    db.close()
  }
}

describe('the cards step (#1209)', () => {
  it("is in the 1.0 group, after #1212's step, before the keys step (#1219) that numbers its cards", () => {
    const step = store.BOARD_MIGRATIONS.find((m) => m.name === 'cards in tables')
    expect(step).toMatchObject({ version: 5, group: '1.0' })
    expect(store.BOARD_MIGRATIONS.find((m) => m.name === 'project keys')!.version).toBeGreaterThan(5)
  })

  it('a change saves into the tables and reads back the same', async () => {
    const { ws, numbers } = await madeBoard()
    const w = await open(ws)
    const [a] = numbers
    const card = await inWorkspace(w, async () => {
      await tasks.updateTask(a, { column: 'review', addLabels: ['p3'] }, user, { comment: 'Round 1' })
      return tasks.getTask(a, w)
    })
    expect(card.column).toBe('review')
    expect(card.labels).toEqual(['1.0.0', 'p3'])
    expect(card.comments.map((c) => c.text)).toEqual(['A comment', 'Started', 'Round 1'])
    const db = new DatabaseSync(store.boardFile(ws), { readOnly: true })
    try {
      expect((db.prepare('SELECT label FROM card_labels WHERE card = ? ORDER BY ord').all(a) as { label: string }[]).map((r) => r.label)).toEqual(['1.0.0', 'p3'])
      expect((db.prepare('SELECT col FROM cards WHERE number = ?').get(a) as { col: string }).col).toBe('review')
    } finally {
      db.close()
    }
    // A card deleted takes its rows with it.
    await removeCard(w, a)
    const after = new DatabaseSync(store.boardFile(ws), { readOnly: true })
    try {
      for (const t of ['card_labels', 'card_comments', 'card_history', 'card_links']) expect((after.prepare(`SELECT count(*) AS n FROM ${t} WHERE card = ?`).get(a) as { n: number }).n, t).toBe(0)
    } finally {
      after.close()
    }
    await close(w)
  })

  it('a new workspace takes the step with no cards, and moves its card files straight into the tables', async () => {
    const ws = workspace()
    mkdirSync(join(ws, '.combwork', 'tasks'), { recursive: true })
    writeFileSync(join(ws, '.combwork', 'tasks', '7.json'), JSON.stringify(ODD[901]).replace('"number":901', '"number":7'))
    writeFileSync(join(ws, '.combwork', 'tasks', 'board.json'), JSON.stringify({ version: 1, next: 8 }))
    const w = await open(ws)
    const doc = await inWorkspace(w, () => store.cardDoc(w, 7))
    expect(JSON.stringify(doc)).toBe(JSON.stringify(ODD[901]).replace('"number":901', '"number":7'))
    expect(columnsOf(store.boardFile(ws))).not.toContain('doc')
    await close(w)
  })

})

// A card is its row and its child rows, read by separate statements: another process committing between them must
// never give a card neither of them saved (HR4's #1209 round 1 finding). The commit is made at that very point, by a
// connection of its own, from the hook a read runs once it has read the cards' rows.
describe('the board read on one snapshot (#1209 round 1)', () => {
  /** Commits these documents from another connection the `at`-th time a read has read its cards' rows; says how many reads there were. */
  function commitAt(ws: string, at: number, docs: Record<number, Record<string, unknown>>): { reads: number } {
    const seen = { reads: 0 }
    cardRowsTestHooks.afterCards = () => {
      if (++seen.reads === at) for (const [k, doc] of Object.entries(docs)) writeCardOutside(ws, Number(k), doc)
    }
    return seen
  }
  const comment = (text: string): Record<string, unknown> => ({ at: '2026-10-20T17:00:00.000Z', by: 'Agent 2 (q)', text, id: `c-${text.length}` })
  const text = (v: unknown): string => JSON.stringify(v)

  async function board(): Promise<{ ws: string; w: WS; a: number; b: number }> {
    const ws = workspace()
    mkdirSync(join(ws, 'q', '.combwork'), { recursive: true })
    writeFileSync(join(ws, 'q', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a2', name: 'Agent 2' }] }))
    const w = await open(ws)
    const [a, b] = await inWorkspace(w, async () => {
      const first = await tasks.createTask({ title: 'Old title', project: 'p', agent: 'a1' }, user)
      await tasks.commentTask(first.number, 'Old comment', user)
      const second = await tasks.createTask({ title: 'Second', project: 'p', agent: 'a1' }, user)
      return [first.number, second.number]
    })
    return { ws, w, a, b }
  }

  it("a card read while another process moves it to another project, with a new comment, is the card before, never a mix", async () => {
    const { ws, w, a } = await board()
    const old = store.cardDoc(w, a)!
    const moved = { ...old, title: 'New title', project: 'q', agent: 'a2', comments: [...(old.comments as unknown[]), comment('New private comment')] }
    const seen = commitAt(ws, 1, { [a]: moved })
    expect(text(store.cardDoc(w, a))).toBe(text(old))
    expect(seen.reads).toBe(1)
    cardRowsTestHooks.afterCards = null
    // The change was committed: the next read has it whole.
    expect(text(store.cardDoc(w, a))).toBe(text(moved))
    await close(w)
  })

  it('cards picked by a query keep their own child rows when another process changes which cards it picks', async () => {
    const { ws, w, a, b } = await board()
    const before = store.cardDocs(w, { agents: ['a1'] })
    expect(before.map((d) => d.number)).toEqual([a, b])
    const docA = before[0].doc
    // Card a leaves the query (another agent), with a comment more; b stays and gets one too.
    const seen = commitAt(ws, 1, {
      [a]: { ...docA, agent: 'a2', comments: [...(docA.comments as unknown[]), comment('Moved on')] },
      [b]: { ...before[1].doc, comments: [comment('Later')] }
    })
    expect(text(store.cardDocs(w, { agents: ['a1'] }))).toBe(text(before))
    expect(seen.reads).toBe(1)
    cardRowsTestHooks.afterCards = null
    expect(store.cardDocs(w, { agents: ['a1'] }).map((d) => d.number)).toEqual([b])
    await close(w)
  })

  it("costs' holds and the history read after them for cards without holds are one snapshot", async () => {
    const { ws, w, a } = await board()
    const before = store.holdDocs(w)
    const old = store.cardDoc(w, a)!
    // Between the holds' read and the history read (the second read of cards' rows): a history line more.
    const seen = commitAt(ws, 2, { [a]: { ...old, history: [...(old.history as unknown[]), { at: '2026-10-20T17:00:00.000Z', by: 'Agent 2 (q)', what: 'Moved to Review' }] } })
    expect(text(store.holdDocs(w))).toBe(text(before))
    expect(seen.reads).toBe(2)
    cardRowsTestHooks.afterCards = null
    expect(text(store.holdDocs(w))).not.toBe(text(before))
    await close(w)
  })

  it('a read inside a board change uses the change’s own transaction and sees its writes', async () => {
    const { w, a } = await board()
    await store.boardWrite(w, async () => {
      store.putCard(w, a, { ...store.cardDoc(w, a)!, title: 'Inside' })
      expect(store.cardDoc(w, a)!.title).toBe('Inside')
      expect(store.cardDocs(w, { numbers: [a] })[0].doc.title).toBe('Inside')
    })
    expect(store.cardDoc(w, a)!.title).toBe('Inside')
    await close(w)
  })
})
