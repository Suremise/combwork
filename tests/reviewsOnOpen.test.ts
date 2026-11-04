// A reviewer's mark a close left (#1392): a reviewer's session ending as its window closes the workspace can't end its
// reviews (the board is fenced from the close on, #1379), so the card kept a reviewer that had gone. As the workspace
// opens again (WorkspaceService.openedListeners, reviewsOnOpen.ts) the reviews of reviewers with no session end, with
// the history line a session's end writes; a running reviewer's stay, and another workspace's board is never touched,
// also when the window switches away while the repair waits.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-reviews-open-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, WorkspaceService } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const { boardOpen } = await import('../src/main/boardStore')
const { sessions } = await import('../src/main/sessions')
const { initReviewsOnOpen, repairsForTests, setBeforeRepairForTests } = await import('../src/main/reviewsOnOpen')
type WS = ReturnType<typeof createWorkspaceService>

const user = { kind: 'user' } as const
const as = (agentId: string, name: string) => ({ kind: 'agent', name: `${name} (alpha)`, self: { project: 'alpha', agentId }, scope: 'alpha' }) as const
const reviewer = as('r1', 'Reviewer')
const third = as('t1', 'Third')
const STOPPED = 'Combwork: Review by Reviewer stopped: its session ended'

/** Holds a promise until `release()`: the moment a test closes or switches the workspace in. */
function gate(): { held: Promise<void>; release: () => void } {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  return { held, release }
}

describe("a reviewer's mark a close left ends as the workspace opens again (#1392)", () => {
  const [wsA, wsB, wsC, wsD] = ['alpha-ws', 'beta-ws', 'gamma-ws', 'delta-ws'].map((n) => join(base, n))
  let w: WS
  let other: WS
  /** The sessions running, as `<project path>#<agent>`, lower-case (sessions.liveFor stands in). */
  const running = new Set<string>()
  const run = <T>(ws: WS, fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)
  const card = (ws: WS, n: number) => run(ws, () => tasks.getTask(n, ws))
  const lines = (c: { history: { by: string; what: string }[] }) => c.history.map((h) => `${h.by}: ${h.what}`)
  /** A card Coder did, in Review, with `by` reviewing it (its session running as it starts). */
  const reviewed = async (ws: WS, title: string, by: typeof reviewer): Promise<number> => {
    const c = await run(ws, () => tasks.createTask({ title, project: 'alpha', agent: 'c1', column: 'review' }, user))
    await run(ws, () => tasks.updateTask(c.number, { review: 'start' }, by))
    return c.number
  }
  const live = (ws: string, agentId: string) => `${join(ws, 'alpha')}#${agentId}`.toLowerCase()

  beforeAll(async () => {
    for (const ws of [wsA, wsB, wsC, wsD]) {
      mkdirSync(join(ws, 'alpha', '.combwork'), { recursive: true })
      writeFileSync(join(ws, 'alpha', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'c1', name: 'Coder' }, { id: 'r1', name: 'Reviewer' }, { id: 't1', name: 'Third' }] }))
    }
    mkdirSync(join(base, 'profile'), { recursive: true })
    Object.assign(sessions, { liveFor: (p: string, id: string) => (running.has(`${p}#${id}`.toLowerCase()) ? ({ projectPath: p, agentId: id } as never) : null) })
    initReviewsOnOpen()
    w = createWorkspaceService()
    // Another window, with a workspace whose project has the same name and agents.
    other = createWorkspaceService()
    await other.open(wsB)
  })
  afterAll(async () => {
    setBeforeRepairForTests(null)
    await disposeWorkspaceService(w)
    await disposeWorkspaceService(other)
  })

  it("a reviewer's session ending as its window switches away leaves its mark; reopening ends it, once, and leaves a running reviewer's and the other window's alone", async () => {
    await w.open(wsA)
    await repairsForTests()
    running.add(live(wsA, 't1'))
    const left = await reviewed(w, 'Left by the close', reviewer)
    const kept = await reviewed(w, 'Third still reviews it', third)
    const theirs = await reviewed(other, "The other window's", reviewer)
    // Reviewer's session ends as the window switches away: its exit lands after the close fenced the board, as index.ts
    // sends it (endReviews on the workspace the session's folder is in, its path still set).
    let exit: Promise<unknown> | null = null
    const exiting = () => {
      exit = tasks.endReviews('alpha', 'r1', 'its session ended', w).catch((e: Error) => e)
    }
    WorkspaceService.closingListeners.add(exiting)
    try {
      await w.open(wsC)
    } finally {
      WorkspaceService.closingListeners.delete(exiting)
    }
    expect(exit).not.toBeNull()
    await exit
    await repairsForTests()
    expect(boardOpen(wsA)).toBe(false)

    // Opened again: Reviewer isn't running, so its review ends; Third's stays; the other window's card is as it was.
    await w.open(wsA)
    await repairsForTests()
    const a = await card(w, left)
    expect([a.review, a.column, a.agent]).toEqual([undefined, 'review', 'c1'])
    expect(lines(a).filter((l) => l === STOPPED)).toHaveLength(1)
    expect(lines(a).at(-1)).toBe(STOPPED)
    expect((await card(w, kept)).review?.agent).toBe('t1')
    const b = await card(other, theirs)
    expect(b.review?.agent).toBe('r1')
    expect(lines(b)).not.toContain(STOPPED)
    // Opened once more: nothing left to end, no second line.
    await w.open(wsC)
    await w.open(wsA)
    await repairsForTests()
    expect(lines(await card(w, left)).filter((l) => l === STOPPED)).toHaveLength(1)
  })

  it('a repair waiting as the window switches away does nothing: its board stays closed and the next workspace is left alone', async () => {
    // A mark the close left in A (Reviewer ran as it started its review, and has stopped since).
    await w.open(wsA)
    await repairsForTests()
    running.add(live(wsA, 'r1'))
    const left = await reviewed(w, 'Left again', reviewer)
    running.delete(live(wsA, 'r1'))
    // D: Reviewer reviews a card there and is running there, so D's own repair keeps it; A's, made with A's sessions,
    // would end it.
    // Numbered as A's, so a repair of A reading or saving through D would find it.
    await w.open(wsD)
    running.add(live(wsD, 'r1'))
    while ((await run(w, () => tasks.allTasks(w))).length < left - 1) await run(w, () => tasks.createTask({ title: 'Filler', project: 'alpha', column: 'todo' }, user))
    const there = await reviewed(w, "D's card", reviewer)
    expect(there).toBe(left)
    await w.open(wsC)
    await repairsForTests()

    // Held in turn: before the repair starts, and inside it, A's cards listed under A's board lock, about to be changed
    // (its reads and saves go through the window's workspace, which is D's by then).
    for (const hold of ['start', 'inside'] as const) {
      const g = gate()
      const held = vi.fn(() => g.held)
      if (hold === 'start') setBeforeRepairForTests(held)
      else tasks.setAmidRepairForTests(held)
      try {
        await w.open(wsA)
        const lifeA = w.lifetime
        await vi.waitFor(() => expect(held).toHaveBeenCalled(), { timeout: 20000 })
        setBeforeRepairForTests(null)
        tasks.setAmidRepairForTests(null)
        // Released once D is open in the window: the repair goes on with the window's workspace D's.
        await w.open(wsD)
        expect(lifeA.aborted).toBe(true)
        g.release()
        await repairsForTests()
      } finally {
        setBeforeRepairForTests(null)
        tasks.setAmidRepairForTests(null)
        g.release()
      }
      expect(boardOpen(wsA), hold).toBe(false)
      const d = await card(w, there)
      expect(d.review?.agent, hold).toBe('r1')
      expect(lines(d), hold).not.toContain(STOPPED)
      expect((await card(w, there)).column, hold).toBe('review')
      await w.open(wsC)
      await repairsForTests()
    }
    // A's mark waits for A's next opening, which ends it.
    await w.open(wsA)
    await repairsForTests()
    expect((await card(w, left)).review).toBeUndefined()
  })
})
