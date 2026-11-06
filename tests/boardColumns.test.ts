// On Hold and Passed (#170): six fixed columns. On Hold is the user's and the Assistant's (a project agent can't park a
// card), a reviewer moves a passed card to Passed with its verdict, Done means merged, and neither On Hold nor Passed
// is ever stalled. Wake lines say Passed isn't merged.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { BOARD_FOLD_WORKSPACES, COLUMN_CHOICES, TASK_COLUMNS, applyBoardFold, archivedAt, columnColor, sortCards, stalledReason, taskOverview, taskPrompt } from '../src/shared/tasks'
import { cardChange, readCondition, wakeAbout, wakeLine, watchLabel } from '../src/shared/watch'
import type { TaskCard } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('cw-columns-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
type WS = ReturnType<typeof createWorkspaceService>

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const script = { kind: 'agent', name: 'Agent API' } as const
const as = (agentId: string, name: string, own = 'alpha') => ({ kind: 'agent', name: `${name} (${own})`, self: { project: own, agentId }, scope: own }) as const
const coder = as('c1', 'Coder')
const reviewer = as('r1', 'Reviewer')

function project(ws: string, name: string, agents: { id: string; name: string }[]): string {
  const p = join(ws, name)
  mkdirSync(join(p, '.combwork'), { recursive: true })
  writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents }))
  return p
}

const card = (over: Partial<TaskCard>): TaskCard => ({
  number: 7,
  title: 'A card',
  description: '',
  project: 'alpha',
  agent: null,
  column: 'todo',
  order: 1,
  labels: [],
  blocked: null,
  blockedBy: [],
  links: [],
  comments: [],
  history: [],
  archived: false,
  createdAt: '2026-10-06T00:00:00.000Z',
  createdBy: 'You',
  updatedAt: '2026-10-06T00:00:00.000Z',
  ...over
})

describe('the six columns', () => {
  it('are On Hold, Todo, Doing, Review, Passed and Done, in that order, each with its own colour', () => {
    expect(TASK_COLUMNS.map((c) => c.label)).toEqual(['On Hold', 'Todo', 'Doing', 'Review', 'Passed', 'Done'])
    expect(COLUMN_CHOICES).toBe('hold, todo, doing, review, passed or done')
    const colours = TASK_COLUMNS.map((c) => columnColor(undefined, c.id))
    expect(new Set(colours).size).toBe(6)
    // A setting saved before the new columns existed falls back to their defaults.
    expect(columnColor({ todo: '#123456' }, 'passed')).toBe(columnColor(undefined, 'passed'))
  })

  it('sorts cards in board order, On Hold first and Passed before Done', () => {
    const order = sortCards([card({ number: 1, column: 'done' }), card({ number: 2, column: 'passed' }), card({ number: 3, column: 'hold' }), card({ number: 4, column: 'todo' })])
    expect(order.map((c) => c.column)).toEqual(['hold', 'todo', 'passed', 'done'])
  })

  it('counts On Hold and Passed in the overview, and never calls them stalled', () => {
    const cards = [card({ number: 1, column: 'hold' }), card({ number: 2, column: 'passed', agent: 'gone' }), card({ number: 3, column: 'doing' })]
    const o = taskOverview(cards, null, (c) => !!stalledReason(c, null))
    expect([o.hold, o.passed, o.doing, o.stalled]).toEqual([1, 1, 1, 1])
    expect(stalledReason(card({ column: 'hold' }), null)).toBeNull()
    expect(stalledReason(card({ column: 'passed', agent: 'a1' }), null)).toBeNull()
  })

  it('an archived card says when it was archived: its latest "Archived…", else its last change (#249)', () => {
    const h = (at: string, what: string) => ({ at, by: 'You', what })
    expect(archivedAt(card({ history: [h('2026-10-01T00:00:00Z', 'Archived'), h('2026-10-02T00:00:00Z', 'Brought back from the archive'), h('2026-10-03T00:00:00Z', 'Archived after 14 days in Done')] }))).toBe('2026-10-03T00:00:00Z')
    expect(archivedAt(card({ history: [h('2026-10-04T00:00:00Z', 'Archived: alpha was hidden')] }))).toBe('2026-10-04T00:00:00Z')
    expect(archivedAt(card({ history: [h('2026-10-01T00:00:00Z', 'Created in Todo')], updatedAt: '2026-10-05T00:00:00Z' }))).toBe('2026-10-05T00:00:00Z')
  })

  it('a card started again from Passed says where it was', () => {
    expect(taskPrompt(card({ column: 'doing' }), true, { from: 'passed' })).toMatch(/It was in Passed and is back in Doing for more work\./)
  })
})

describe("a board's fold, saved as a change (#170)", () => {
  it("changes one workspace's fold on what is saved now, leaving every other workspace's as it is", () => {
    // Two windows read the folds before either changed them: A collapses On Hold, then B collapses Done. Each sends a
    // change, applied to what is saved then, so A's survives B's.
    let saved = applyBoardFold({}, 'C:\\WS\\A', { columns: { ids: ['hold'], collapsed: true }, cards: { numbers: [3, 4], folded: true } })
    saved = applyBoardFold(saved, 'C:\\WS\\B', { columns: { ids: ['done'], collapsed: true } })
    expect(saved).toEqual({ 'c:\\ws\\a': { columns: ['hold'], cards: [3, 4] }, 'c:\\ws\\b': { columns: ['done'] } })
    // Expanding and unfolding remove; columns are kept in board order; an empty fold is dropped altogether.
    saved = applyBoardFold(saved, 'c:\\ws\\a', { columns: { ids: ['todo'], collapsed: true }, cards: { numbers: [3], folded: false } })
    expect(saved['c:\\ws\\a']).toEqual({ columns: ['hold', 'todo'], cards: [4] })
    saved = applyBoardFold(saved, 'C:\\WS\\B', { columns: { ids: ['done'], collapsed: false } })
    expect(Object.keys(saved)).toEqual(['c:\\ws\\a'])
  })

  it('keeps Merging collapsed, in board order after Approved, and expands it again (#1662)', () => {
    let saved = applyBoardFold({}, 'ws', { columns: { ids: ['merging'], collapsed: true } })
    expect(saved.ws).toEqual({ columns: ['merging'] })
    saved = applyBoardFold(saved, 'ws', { columns: { ids: ['done', 'passed', 'hold'], collapsed: true } })
    expect(saved.ws.columns).toEqual(['hold', 'passed', 'merging', 'done'])
    saved = applyBoardFold(saved, 'ws', { columns: { ids: ['merging'], collapsed: false } })
    expect(saved.ws.columns).toEqual(['hold', 'passed', 'done'])
  })

  it('drops folds of cards no longer on the board, ignores what is not a column or card, and keeps the newest workspaces', () => {
    const saved = applyBoardFold({ ws: { columns: ['hold'], cards: [1, 2, 3] } }, 'ws', { cards: { numbers: [4, -1, 2.5, 'x' as never], folded: true }, columns: { ids: ['merged' as never, 'passed'], collapsed: true }, known: [2, 4] })
    expect(saved.ws).toEqual({ columns: ['hold', 'passed'], cards: [2, 4] })
    let many = {}
    for (let i = 0; i < BOARD_FOLD_WORKSPACES + 5; i++) many = applyBoardFold(many, `w${i}`, { columns: { ids: ['done'], collapsed: true } })
    expect(Object.keys(many)).toHaveLength(BOARD_FOLD_WORKSPACES)
    expect(Object.keys(many).at(-1)).toBe(`w${BOARD_FOLD_WORKSPACES + 4}`)
    expect(many).not.toHaveProperty('w0')
  })
})

describe('waiting on the new columns', () => {
  it('a wait can be for Passed or On Hold; another word is refused, listing the columns', () => {
    expect(readCondition({ cards: [3], column: 'passed', changes: ['verdict', 'column'] })).toEqual({ cards: [3], changes: ['verdict', 'column'], column: 'passed', moveInto: true })
    expect(readCondition({ cards: [3], column: 'hold' })).toEqual({ cards: [3], changes: ['column'], column: 'hold' })
    expect(readCondition({ cards: [3], column: 'merged' })).toBe(`column must be ${COLUMN_CHOICES}`)
    expect(watchLabel({ cards: [3], column: 'passed' })).toBe('Waiting for #3 → Passed')
  })

  const at = (s: number) => new Date(Date.UTC(2026, 9, 6, 0, 0, s)).toISOString()
  const line = (c: TaskCard, watcher = 'a2') => wakeLine({ ...cardChange(c.number, c, ['column']), about: wakeAbout(c, ['column'], watcher) })

  it("another agent's card in Passed: who passed it, and that Passed isn't merged; in Done (merged), no such note", () => {
    const history = [
      { at: at(1), by: 'Claude (demo)', what: 'Moved to Review' },
      { at: at(2), by: 'Codex (demo)', what: 'Review passed' },
      { at: at(2), by: 'Codex (demo)', what: 'Moved to Passed' }
    ]
    expect(line(card({ agent: 'a1', agentName: 'Claude', column: 'passed', history }))).toMatch(/^\[CW\] #7 \(Claude's card\) is in Passed: Codex \(demo\) passed it \(Passed isn't merged\)\. /)
    const merged = [...history, { at: at(3), by: 'Claude (demo)', what: 'Moved to Done' }]
    expect(line(card({ agent: 'a1', agentName: 'Claude', column: 'done', history: merged }))).toMatch(/^\[CW\] #7 \(Claude's card\) is in Done: Codex \(demo\) passed it\. /)
    // The watcher's own card says nothing of whose it is or of merging.
    expect(line(card({ agent: 'a2', column: 'passed', history }), 'a2')).toMatch(/^\[CW\] #7 is in Passed\. /)
  })

  it('a card moved On Hold starts a new round: an earlier verdict no longer speaks for it', () => {
    const history = [
      { at: at(1), by: 'Codex (demo)', what: 'Review passed' },
      { at: at(2), by: 'You', what: 'Moved to On Hold' },
      { at: at(3), by: 'You', what: 'Moved to Passed' }
    ]
    expect(line(card({ agent: 'a1', agentName: 'Claude', column: 'passed', history }))).toMatch(/^\[CW\] #7 \(Claude's card\) is in Passed \(Passed isn't merged\)\. /)
  })
})

describe('who moves cards to On Hold and Passed', () => {
  let w: WS
  const wsPath = join(base, 'ws')
  beforeAll(async () => {
    project(wsPath, 'alpha', [
      { id: 'c1', name: 'Coder' },
      { id: 'r1', name: 'Reviewer' }
    ])
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const history = (c: { history: { by: string; what: string }[] }) => c.history.map((h) => `${h.by}: ${h.what}`)

  it('only the user and the Assistant (and the workspace token) park a card: a project agent is refused, moving or creating it there', async () => {
    const c = await run(() => tasks.createTask({ title: 'Park me', project: 'alpha' }, user))
    await expect(run(() => tasks.updateTask(c.number, { column: 'hold' }, coder))).rejects.toThrow(/Only the user or the Assistant puts cards On Hold\. Where the user has decided to park #\d+, ask the Assistant \(cw_ask_assistant\); otherwise ask the user\./)
    await expect(run(() => tasks.updateTask(c.number, { column: 'hold' }, coder))).rejects.toBeInstanceOf(tasks.TaskPermissionError)
    await expect(run(() => tasks.createTask({ title: 'Parked', project: 'alpha', column: 'hold' }, coder))).rejects.toBeInstanceOf(tasks.TaskPermissionError)
    expect((await run(() => tasks.getTask(c.number))).column).toBe('todo')
    for (const who of [user, assistant, script]) {
      const moved = await run(() => tasks.updateTask(c.number, { column: 'hold' }, who))
      expect(moved.column).toBe('hold')
      await run(() => tasks.updateTask(c.number, { column: 'todo' }, user))
    }
    expect((await run(() => tasks.createTask({ title: 'Parked', project: 'alpha', column: 'hold' }, assistant))).history.map((h) => h.what)).toEqual(['Created in On Hold'])
  })

  it('a project agent may take a parked card out (the user asked it to work on it), and reorder On Hold', async () => {
    const a = await run(() => tasks.createTask({ title: 'Parked A', project: 'alpha', column: 'hold' }, user))
    const b = await run(() => tasks.createTask({ title: 'Parked B', project: 'alpha', column: 'hold' }, user))
    const ordered = await run(() => tasks.reorderTasks('hold', [b.number, a.number], coder))
    expect(ordered.slice(0, 2).map((c) => c.number)).toEqual([b.number, a.number])
    const taken = await run(() => tasks.updateTask(a.number, { column: 'doing' }, coder))
    expect([taken.column, taken.agent]).toEqual(['doing', 'c1'])
    expect(history(taken).at(-1)).toBe('Coder (alpha): Moved to Doing')
  })

  it('a reviewer moves a passed card to Passed with its verdict; it keeps its agent, and the builder moves it to Done once merged', async () => {
    const c = await run(() => tasks.createTask({ title: 'Built', project: 'alpha', agent: 'c1', column: 'review' }, user))
    await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    const passed = await run(() => tasks.updateTask(c.number, { review: 'passed', column: 'passed' }, reviewer, { comment: 'Round 1: PASSED.' }))
    expect([passed.column, passed.agent, passed.review]).toEqual(['passed', 'c1', undefined])
    expect(history(passed).slice(-2)).toEqual(['Reviewer (alpha): Review passed', 'Reviewer (alpha): Moved to Passed'])
    const merged = await run(() => tasks.updateTask(c.number, { column: 'done' }, coder))
    expect(history(merged).at(-1)).toBe('Coder (alpha): Moved to Done')
  })

  it("a failed verdict can't move the card anywhere but back to Doing, its builder's (HI-1946)", async () => {
    const c = await run(() => tasks.createTask({ title: 'Not yet', project: 'alpha', agent: 'c1', column: 'review' }, user))
    await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    const was = await run(() => tasks.getTask(c.number))
    // Refused before anything is written: no verdict, no move, no hold.
    for (const column of ['passed', 'done', 'review', 'todo'] as const) await expect(run(() => tasks.updateTask(c.number, { review: 'failed', column }, reviewer))).rejects.toThrow(/A failed review sends #\d+ back to Doing, to its builder/)
    const still = await run(() => tasks.getTask(c.number))
    expect([still.column, still.review?.agent, still.history.length, still.held?.length]).toEqual(['review', 'r1', was.history.length, was.held?.length])
    // To Doing named, or no column: the same verdict.
    const failed = await run(() => tasks.updateTask(c.number, { review: 'failed', column: 'doing' }, reviewer))
    expect([failed.column, failed.agent, failed.review]).toEqual(['doing', 'c1', undefined])
  })

  it("another agent's card in Doing can't be moved on to Passed by a project agent", async () => {
    const c = await run(() => tasks.createTask({ title: 'In progress', project: 'alpha', agent: 'c1', column: 'doing' }, user))
    await expect(run(() => tasks.updateTask(c.number, { column: 'passed' }, reviewer))).rejects.toThrow(/another agent can't move it to Approved/)
  })

  it('an unknown column lists the six', async () => {
    const c = await run(() => tasks.createTask({ title: 'Somewhere', project: 'alpha' }, user))
    await expect(run(() => tasks.updateTask(c.number, { column: 'merged' as never }, user))).rejects.toThrow(`Unknown column "merged": ${COLUMN_CHOICES}.`)
  })
})
