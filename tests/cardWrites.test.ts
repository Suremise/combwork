// A card's save writes only what changed (#1210, cardRows.ts writeCardChanges): a comment on a large card is one row,
// an edit in place one update, and after any mix of edits the card still composes back to the bytes it was saved as
// (the card JSON contract, #1208). And a card's cost reads what it needs of the card, never its comments (costCards).
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { as09, writeCard } from './boardDb'
import { holdsOfCard } from '../src/shared/usageLedger'

const base = tempDir('hive-card-writes-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')

const user = { kind: 'user' } as const
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
let n = 0
async function workspace(): Promise<{ ws: string; w: WS }> {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, 'p', '.combwork'), { recursive: true })
  writeFileSync(join(ws, 'p', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { ws, w }
}

const at = (i: number): string => new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString()
/** A large card (in the form Combwork saves one): hundreds of comments and history lines, labels, links, holds, a decision. */
const bigCard = (num: number): Record<string, unknown> => ({
  number: num,
  title: 'A big card',
  description: 'x'.repeat(2000),
  project: 'p',
  agent: null,
  column: 'doing',
  order: 1,
  labels: ['a', 'b'],
  blocked: null,
  blockedBy: [2],
  links: [3, 4],
  comments: Array.from({ length: 300 }, (_, i) => ({ at: at(i), by: 'You', text: `Comment ${i} `.repeat(10), id: `c${i}` })),
  history: Array.from({ length: 300 }, (_, i) => ({ at: at(i), by: 'You', what: `Line ${i}` })),
  decisions: [{ id: 'd1', text: 'Do it', decidedBy: 'user', recordedBy: 'You', at: at(1) }],
  held: [{ agent: 'a1', name: 'Agent 1', role: 'build', from: at(1), to: at(2) }],
  archived: false,
  createdAt: at(0),
  createdBy: 'You',
  updatedAt: at(0)
})

/** The rows written by fn (SQLite's count of rows inserted, updated or deleted on the writer, triggers' none). */
async function rowsWritten(ws: string, fn: () => Promise<unknown>): Promise<number> {
  const db = store.workspaceDb(ws).writer
  const total = (): number => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  const before = total()
  await fn()
  return total() - before
}

describe("a card's save writes what changed (#1210)", () => {
  it('a comment on a large card is one row; an edit in place one; the card row only when a column changed', async () => {
    const { ws, w } = await workspace()
    const doc = bigCard(1)
    await inWorkspace(w, () => writeCard(w, 1, doc))
    const comment = { at: at(999), by: 'You', text: 'One more', id: 'c-new' }
    const withComment = { ...doc, comments: [...(doc.comments as unknown[]), comment] }
    expect(await rowsWritten(ws, () => inWorkspace(w, () => writeCard(w, 1, withComment)))).toBe(1)
    // With the card's own time moved on too: that row as well.
    const later = { ...withComment, comments: [...(withComment.comments as unknown[]), { ...comment, id: 'c-new2' }], updatedAt: at(1000) }
    expect(await rowsWritten(ws, () => inWorkspace(w, () => writeCard(w, 1, later)))).toBe(2)
    // A comment edited in place, and nothing else: one update.
    const comments = [...(later.comments as Record<string, unknown>[])]
    comments[150] = { ...comments[150], text: 'Edited' }
    expect(await rowsWritten(ws, () => inWorkspace(w, () => writeCard(w, 1, { ...later, comments })))).toBe(1)
    // The same card again: nothing.
    expect(await rowsWritten(ws, () => inWorkspace(w, () => writeCard(w, 1, { ...later, comments })))).toBe(0)
    expect(JSON.stringify(store.cardDoc(w, 1))).toBe(JSON.stringify({ ...later, comments }))
  })

  it('a comment through the board (commentTask) writes a few rows, not the card again', async () => {
    const { ws, w } = await workspace()
    // Its links to cards the board has (a link to a card that isn't there is dropped as the card is saved).
    // With its project's id, as Combwork saves a card (one saved without would take it, and its number there, #1219, now).
    const projectId = [...(await w.projectIds()).byId.keys()][0]
    await inWorkspace(w, () => writeCard(w, 1, { ...bigCard(1), blockedBy: [], links: [], projectId }))
    // Its comment and the card's own row (its time): never its 600 other entries.
    expect(await rowsWritten(ws, () => inWorkspace(w, () => tasks.commentTask(1, 'Through the board', user)))).toBe(2)
  })

  it('after any mix of edits the card composes back to the bytes it was saved as', async () => {
    const { w } = await workspace()
    let doc = bigCard(1)
    await inWorkspace(w, () => writeCard(w, 1, doc))
    // A fixed sequence of edits of every kind (deterministic: a seeded generator).
    let seed = 1211
    const rnd = (k: number): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % k)
    for (let step = 0; step < 60; step++) {
      const d = structuredClone(doc) as Record<string, unknown> & { comments: Record<string, unknown>[]; history: Record<string, unknown>[]; labels: string[]; links: number[]; blockedBy: number[]; held: Record<string, unknown>[] }
      switch (rnd(9)) {
        case 0: d.comments.push({ at: at(2000 + step), by: 'You', text: `New ${step}`, id: `n${step}` }); break
        case 1: d.comments.splice(rnd(d.comments.length), 1); break
        case 2: if (d.comments.length) d.comments[rnd(d.comments.length)].text = `Edited ${step}`; break
        case 3: d.history.push({ at: at(3000 + step), by: 'Agent 1', what: `Moved ${step}` }); break
        case 4: d.labels = rnd(2) ? [...d.labels, `l${step}`] : d.labels.slice(1); break
        case 5: d.links = rnd(2) ? [...d.links, 10 + step] : d.links.slice(0, -1); d.blockedBy = rnd(2) ? [] : [5, 6]; break
        case 6: d.held = [...d.held, { agent: 'a1', name: 'Agent 1', role: 'review', from: at(step), to: null }]; break
        case 7: d.title = `Title ${step}`; d.updatedAt = at(4000 + step); break
        // An entry not of Combwork's form (kept as its raw JSON) and a field Combwork doesn't know.
        default: d.comments.push({ odd: true, step } as Record<string, unknown>); (d as Record<string, unknown>).custom = { step }; break
      }
      doc = d
      await inWorkspace(w, () => writeCard(w, 1, doc))
      expect(JSON.stringify(store.cardDoc(w, 1))).toBe(JSON.stringify(doc))
    }
  })
})

describe('costs read what they need of the cards (#1210)', () => {
  it('costCards gives each card its title, project, column, holds and history as the card in full has them, in number order', async () => {
    const { w } = await workspace()
    await inWorkspace(w, () => writeCard(w, 7, { ...bigCard(7), column: 'review' }))
    await inWorkspace(w, () => writeCard(w, 3, { ...bigCard(3), title: 'Three', held: [] }))
    const full = await inWorkspace(w, () => tasks.allTasks(w, { numbers: [3, 7] }))
    const cost = await inWorkspace(w, () => tasks.costCards(w, [7, 3]))
    const pick = (c: { number: number; title: string; project: string; column: string; held?: unknown; history: unknown }) => ({ number: c.number, title: c.title, project: c.project, column: c.column, held: c.held, history: c.history })
    expect(cost.map(pick)).toEqual(full.map(pick))
    // Nothing else read: no comments, description or decisions.
    expect(cost.every((c) => c.comments.length === 0 && c.description === '')).toBe(true)
    expect(await inWorkspace(w, () => tasks.costCards(w, []))).toEqual([])
  })

  /** Cards from before Combwork kept holds (no `held`): their holds come from their history and their agent and reviewer now. */
  const unheld = (num: number): Record<string, unknown> => {
    const { held: _held, ...card } = bigCard(num)
    return {
      ...card,
      blockedBy: [],
      links: [],
      agent: 'a1',
      agentName: 'Agent 1',
      review: { agent: 'r1', agentName: 'Reviewer', since: at(5) },
      column: 'review',
      history: [
        { at: at(1), by: 'You', what: 'Created in Doing' },
        { at: at(3), by: 'Agent 1 (p)', what: 'Moved to Review' },
        { at: at(5), by: 'Reviewer (p)', what: 'Started reviewing' }
      ]
    }
  }

  it("a card without stored holds keeps them as its history and agents give them, builder's and reviewer's (HR1's #1210 round 1)", async () => {
    const { w } = await workspace()
    await inWorkspace(w, () => writeCard(w, 1, unheld(1)))
    const [full] = await inWorkspace(w, () => tasks.allTasks(w, { numbers: [1] }))
    const [cost] = await inWorkspace(w, () => tasks.costCards(w, [1]))
    expect(full.held).toBeUndefined()
    const holds = holdsOfCard(full)
    expect(holds.map((h) => h.role).sort()).toEqual(['build', 'review'])
    expect(holdsOfCard(cost)).toEqual(holds)
    expect([cost.agent, cost.agentName, cost.review]).toEqual([full.agent, full.agentName, full.review])
    expect(cost.comments).toEqual([])
  })

  it('the same on a 0.9 board waiting for its upgrade (its documents read for those fields)', async () => {
    const { ws, w } = await workspace()
    await inWorkspace(w, () => writeCard(w, 1, unheld(1)))
    const [full] = await inWorkspace(w, () => tasks.allTasks(w, { numbers: [1] }))
    await disposeWorkspaceService(w)
    opened.splice(opened.indexOf(w), 1)
    store.closeBoard(ws)
    as09(store.boardFile(ws))
    store.boardTestHooks.upgradeAnswer = 'no'
    try {
      const w2 = createWorkspaceService()
      await w2.open(ws)
      opened.push(w2)
      expect(inWorkspace(w2, () => store.boardState(w2)).readOnly).toBe('upgrade')
      const [cost] = await inWorkspace(w2, () => tasks.costCards(w2, [1]))
      expect(holdsOfCard(cost)).toEqual(holdsOfCard(full))
      expect(cost.comments).toEqual([])
    } finally {
      store.boardTestHooks.upgradeAnswer = null
    }
  })
})
