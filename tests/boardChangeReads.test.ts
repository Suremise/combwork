// What a board change reads (HI-1690). Readers run for each change (freshStarts' look at newly Done cards, the cards a
// running session worked on, a loop's cards in play, a lane watch's waiting agents) read the live cards' heads from the
// board's columns: no archived card, and no card's document (its description, comments, history). The look at newly Done
// cards read every card in full, archived ones included (25.5 MB on a board of 1,641), on each change.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { HiveEvent, TaskCard } from '../src/shared/types'
import { tempDir } from './tempDir'

/** A bound for a hung run (the waits are for conditions). */
const HUNG_MS = 15_000

// The card documents read (one card's, or a list of them), counted; the reads themselves unchanged.
const reads = vi.hoisted(() => ({ docs: 0, heads: 0 }))
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
    },
    // The heads read again after a change (HI-1909), counted.
    headChanges: (...a: Parameters<typeof real.headChanges>) => {
      const out = real.headChanges(...a)
      reads.heads += out?.docs.length ?? 0
      return out
    }
  }
})

const base = tempDir('hive-board-change-reads-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const fresh = await import('../src/main/freshStarts')
const { sessions } = await import('../src/main/sessions')
const { tellListeners } = await import('../src/main/events')
const { coalescing } = await import('../src/main/coalesce')

const user = { kind: 'user' } as const
const wsPath = join(base, 'ws')
const alpha = join(wsPath, 'alpha')
const tasksDir = join(wsPath, '.combwork', 'tasks')
const BOARD = 200
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const COLUMNS = ['todo', 'doing', 'review', 'passed', 'done'] as const
/** A card as Combwork saves one, with a long description and comments: what a reader of heads must not parse. */
const card = (n: number): Record<string, unknown> => ({
  number: n,
  title: `Card ${n}`,
  description: 'x'.repeat(2000),
  project: n % 7 === 0 ? 'beta' : 'alpha',
  agent: n % 3 === 0 ? 'a1' : null,
  agentName: n % 3 === 0 ? 'Builder' : undefined,
  ...(COLUMNS[n % 5] === 'review' ? { review: { agent: 'a2', agentName: 'Reviewer', since: '2026-10-26T10:00:00.000Z' } } : {}),
  column: COLUMNS[n % 5],
  order: BOARD - n,
  labels: ['x'],
  blocked: null,
  blockedBy: [],
  links: [],
  comments: [{ at: '2026-10-26T10:00:00.000Z', by: 'B', text: 'y'.repeat(1000) }],
  history: [{ at: '2026-10-26T10:00:00.000Z', by: 'B', action: 'created' }],
  archived: n % 4 === 0,
  createdAt: '2026-10-26T10:00:00.000Z',
  createdBy: 'B',
  updatedAt: '2026-10-26T10:00:00.000Z'
})
/** The card documents `fn` reads. */
async function readsOf(fn: () => Promise<unknown>): Promise<number> {
  const was = reads.docs
  await fn()
  return reads.docs - was
}
/** What a head has of a card. */
const head = (c: TaskCard) => ({ number: c.number, title: c.title, project: c.project, column: c.column, order: c.order, archived: c.archived, agent: c.agent, agentName: c.agentName, review: c.review })

beforeAll(async () => {
  for (const p of ['alpha', 'beta']) {
    mkdirSync(join(wsPath, p, '.combwork'), { recursive: true })
    writeFileSync(join(wsPath, p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }, { id: 'a2', name: 'Reviewer' }] }))
  }
  // A board of 200 cards' files from before 0.9, a quarter archived: moved into the database as the board is first used.
  mkdirSync(tasksDir, { recursive: true })
  for (let n = 1; n <= BOARD; n++) writeFileSync(join(tasksDir, `${n}.json`), JSON.stringify(card(n)))
  w = createWorkspaceService()
  await w.open(wsPath)
  await run(() => tasks.boardPlaces(w))
})
afterAll(async () => disposeWorkspaceService(w))

describe('the live cards\' heads (HI-1690)', () => {
  it('are the live cards, each as allTasks has it in the fields a head has, with no card document read', async () => {
    let heads: TaskCard[] = []
    expect(await readsOf(async () => void (heads = await run(() => tasks.liveCardHeads(w))))).toBe(0)
    const full = await run(() => tasks.allTasks(w, { archived: false }))
    // In board order, as allTasks gives them (HR6's round 1): a reader taking the first card that fits takes the one
    // highest in its column. The board's order runs against the cards' numbers here, so number order would differ.
    expect(heads.map(head)).toEqual(full.map(head))
    const doing = heads.filter((c) => c.column === 'doing' && c.agent === 'a1')
    expect(doing[0].number).toBe(Math.max(...doing.map((c) => c.number)))
    expect(heads.length).toBe(BOARD - BOARD / 4)
    // Nothing else of a card: its description, comments and history as a card without them has them.
    expect(heads.every((c) => c.description === '' && c.comments.length === 0 && c.history.length === 0)).toBe(true)
  })

  it('with done, the live Done cards alone', async () => {
    let done: TaskCard[] = []
    expect(await readsOf(async () => void (done = await run(() => tasks.liveCardHeads(w, { done: true }))))).toBe(0)
    const want = Array.from({ length: BOARD }, (_, i) => i + 1).filter((n) => COLUMNS[n % 5] === 'done' && n % 4 !== 0).reverse()
    expect(done.map((c) => c.number)).toEqual(want)
    expect(done.every((c) => c.column === 'done' && !c.archived)).toBe(true)
  })
})

describe('the heads kept between board changes (HI-1909)', () => {
  it('a change reads again only the cards it touched: moved, new and archived cards as allTasks has them', async () => {
    await run(() => tasks.liveCardHeads(w))
    const was = reads.heads
    // Unchanged: the same lists, nothing read again.
    expect(await run(() => tasks.liveCardHeads(w))).toEqual(await run(() => tasks.liveCardHeads(w)))
    expect(reads.heads).toBe(was)
    await run(() => tasks.updateTask(2, { column: 'done' }, user))
    const made = await run(() => tasks.createTask({ title: 'New', project: 'alpha' }, user))
    let heads = await run(() => tasks.liveCardHeads(w))
    expect(reads.heads - was).toBeGreaterThan(0)
    expect(reads.heads - was).toBeLessThan(10)
    expect(heads.map(head)).toEqual((await run(() => tasks.allTasks(w, { archived: false }))).map(head))
    expect(heads.some((c) => c.number === made.number)).toBe(true)
    expect((await run(() => tasks.liveCardHeads(w, { done: true }))).map((c) => c.number)).toContain(2)
    // Archived: gone from the heads.
    const beta = heads.filter((c) => c.project === 'beta').map((c) => c.number)
    await run(() => tasks.archiveProjectCards(w, 'beta', 'project-hidden'))
    heads = await run(() => tasks.liveCardHeads(w))
    expect(beta.length > 0 && !heads.some((c) => beta.includes(c.number))).toBe(true)
    expect(heads.map(head)).toEqual((await run(() => tasks.allTasks(w, { archived: false }))).map(head))
  })
})

describe('a board change reads no card documents for the fresh-start nudge (HI-1690)', () => {
  it('the look at newly Done cards reads their heads alone; a card newly Done is still a trigger', async () => {
    const told: string[] = []
    Object.assign(sessions, {
      agentNow: (p: string) => (p.toLowerCase() === alpha.toLowerCase() ? { status: 'ready', pending: false, backgroundTasks: 0, runId: 'r', prompts: 0, statusMessage: null, reply: null } : null),
      notice: (p: string) => void told.push(p)
    })
    fresh.resetFreshNudgesForTests()
    fresh.startFreshNudges()
    const looked = (): Promise<void> => vi.waitFor(() => expect(coalescing(`freshDone:${wsPath.toLowerCase()}`)).toBe(false), { timeout: HUNG_MS })
    // The first look learns what is Done: no card's document read (the whole board, 200 here, before).
    const first = await readsOf(async () => {
      // Its handler starts the look as it is told (coalesced): waited for until it has run.
      tellListeners({ type: 'tasks-changed', workspacePath: wsPath } as unknown as HiveEvent)
      await looked()
    })
    expect(first).toBe(0)
    // Alpha's work finished (nothing in Review or Passed), then its card 1 (in Doing) done: told.
    const live = await run(() => tasks.liveCardHeads(w))
    for (const c of live.filter((x) => x.project === 'alpha' && (x.column === 'review' || x.column === 'passed'))) await run(() => tasks.updateTask(c.number, { column: 'todo' }, user))
    await looked()
    expect(told).toEqual([])
    const total = await readsOf(async () => {
      await run(() => tasks.updateTask(1, { column: 'done' }, user))
      await vi.waitFor(() => expect(told).toEqual([alpha]), { timeout: HUNG_MS })
      await looked()
    })
    // The move reads its own card; the look reads none (it read every card, 200, before).
    expect(total).toBeLessThanOrEqual(2)
  })
})
