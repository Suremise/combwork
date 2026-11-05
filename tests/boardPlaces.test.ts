// Placing a card doesn't read the whole board (#458). Each change that places a card (creating one, a move, a batch)
// did read every card file, one at a time, under the board's lock: N cards created in a row cost about N²/2 reads. With
// the board in SQLite (#1017), placement reads each card's place from the board's index, parsing no card's document, so a
// card changed or removed by another process is placed by what the board says now.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import type { TaskCard } from '../src/shared/types'
import { tempDir } from './tempDir'
import { writeCardOutside } from './boardDb'

// The card documents read (one card's, or a list of them), counted; the reads themselves unchanged.
const reads = vi.hoisted(() => ({ docs: 0 }))
vi.mock('../src/main/boardStore', async (original) => {
  const real = await original<typeof import('../src/main/boardStore')>()
  return {
    ...real,
    cardDoc: (...a: Parameters<typeof real.cardDoc>) => {
      reads.docs++
      return real.cardDoc(...a)
    },
    cardDocs: (...a: Parameters<typeof real.cardDocs>) => {
      const out = real.cardDocs(...a)
      reads.docs += out.length
      return out
    }
  }
})

const base = tempDir('hive-board-places-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const { boardFile } = await import('../src/main/boardStore')

const user = { kind: 'user' } as const
const wsPath = join(base, 'ws')
const tasksDir = join(wsPath, '.combwork', 'tasks')
const BOARD = 200
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
/** A card as Combwork saves one. */
const card = (n: number, fields: Partial<TaskCard> = {}): Record<string, unknown> => ({ number: n, title: `Card ${n}`, description: 'x'.repeat(500), project: 'p', agent: null, column: 'todo', order: n, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: '', createdBy: '', updatedAt: '', ...fields })
/** The card documents `fn` reads. */
async function readsOf(fn: () => Promise<unknown>): Promise<number> {
  const was = reads.docs
  await fn()
  return reads.docs - was
}

beforeAll(async () => {
  mkdirSync(join(wsPath, 'p', '.combwork'), { recursive: true })
  writeFileSync(join(wsPath, 'p', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  // A board of 200 cards' files from before 0.9: moved into the database as the board is first used.
  mkdirSync(tasksDir, { recursive: true })
  for (let n = 1; n <= BOARD; n++) writeFileSync(join(tasksDir, `${n}.json`), JSON.stringify(card(n, { column: (['todo', 'review', 'passed', 'done'] as const)[n % 4], archived: n % 5 === 0 })))
  w = createWorkspaceService()
  await w.open(wsPath)
})
afterAll(async () => disposeWorkspaceService(w))

describe('placing a card on a big board (#458, #1017)', () => {
  it('creating a card reads no card', async () => {
    await run(() => tasks.boardPlaces(w))
    expect(await readsOf(() => run(() => tasks.createTask({ title: 'One', project: 'p' }, user)))).toBe(0)
    expect(await readsOf(() => run(() => tasks.createTask({ title: 'Two', project: 'p' }, user)))).toBe(0)
  })

  it('a move, and a batch of 30 moves, read the cards they change, not the board', async () => {
    // A move reads its own card.
    expect(await readsOf(() => run(() => tasks.updateTask(3, { column: 'review', position: 'top' }, user)))).toBe(1)
    const numbers = Array.from({ length: 30 }, (_, i) => 101 + i).filter((n) => n % 5 !== 0)
    const n = await readsOf(async () => {
      const items = await run(() => tasks.updateTasks(numbers, { column: 'passed' }, user))
      expect(items.every((i) => i.error === null && i.card?.column === 'passed')).toBe(true)
    })
    // Each card: itself. Reading the board would be 30 × 200.
    expect(n).toBe(numbers.length)
  })

  it('a card changed or removed by another process is placed by what the board says now', async () => {
    // Changed: now the last card in Passed.
    writeCardOutside(wsPath, 7, card(7, { column: 'passed', order: 10_000 }))
    expect((await run(() => tasks.createTask({ title: 'After 7', project: 'p', column: 'passed' }, user))).order).toBe(10_001)
    // The last card in Hold, then removed: the next card goes after the one that is left.
    writeCardOutside(wsPath, 8, card(8, { column: 'hold', order: 500 }))
    writeCardOutside(wsPath, 9, card(9, { column: 'hold', order: 600 }))
    const db = new DatabaseSync(boardFile(wsPath), { timeout: 5000 })
    db.prepare('DELETE FROM cards WHERE number = 9').run()
    db.close()
    expect((await run(() => tasks.createTask({ title: 'After 8', project: 'p', column: 'hold' }, user))).order).toBe(501)
  })

  it('places the same as the whole board read: every card, in board order', async () => {
    const all = await run(() => tasks.allTasks(w))
    const places = await run(() => tasks.boardPlaces(w))
    expect(places).toEqual(all.map((c) => ({ number: c.number, column: c.column, order: c.order, archived: c.archived, project: c.project })))
  })

  it("a column's live cards (a change's short reply, HI-1887): as the whole board read lists them, a card with no known column in To Do's, reading no card", async () => {
    // Saved with a column Combwork doesn't know (a later version's, or by hand): read as To Do.
    writeCardOutside(wsPath, 11, card(11, { column: 'later' as TaskCard['column'], order: 2 }))
    for (const column of ['todo', 'review', 'passed', 'hold', 'doing'] as const) {
      const listed = (await run(() => tasks.listTasks({ column }))).map((c) => c.number)
      let places: number[] = []
      expect(await readsOf(async () => void (places = (await run(() => tasks.columnPlaces(w, column))).map((c) => c.number)))).toBe(0)
      expect(places).toEqual(listed)
    }
    expect((await run(() => tasks.columnPlaces(w, 'todo'))).map((c) => c.number)).toContain(11)
  })
})
