// A batch of card changes under load ran main out of memory (#988, #1011): each tasks-changed is a read of the whole
// board for its listeners, the board folder's watcher told one for each card written (a temporary file and a rename),
// and recording the running agents' cards read the board once per agent per event, never one run at a time. Now a batch
// is one transaction, told once as it commits (#1017); a change by another process is told by the board's poll; the
// readers run one at a time, with one more run for the changes told meanwhile.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { HiveEvent, LiveSessionState } from '../src/shared/types'
import { tempDir } from './tempDir'
import { writeCardOutside } from './boardDb'
import { DatabaseSync } from 'node:sqlite'

const base = tempDir('hive-board-events-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

// Every read of the whole board that recording the running agents' cards makes, counted (the reads themselves unchanged).
const boardReads = vi.hoisted(() => ({ n: 0 }))
vi.mock('../src/main/tasks', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/main/tasks')>()
  return {
    ...orig,
    allTasks: (...a: Parameters<typeof orig.allTasks>) => {
      boardReads.n++
      return orig.allTasks(...a)
    }
  }
})

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const { onHiveEvent } = await import('../src/main/events')
const { coalesced, coalescing } = await import('../src/main/coalesce')
const { recordLiveCardsSoon } = await import('../src/main/cardSessions')
const { boardFile } = await import('../src/main/boardStore')

/** Bounds a hung run; the tests wait for what they expect, never for a time. */
const HUNG_MS = 15_000
const user = { kind: 'user' } as const

describe('coalesced (#1011)', () => {
  it('runs one at a time: asked meanwhile, however often, it runs once more after, and each ask resolves after a run that started after it', async () => {
    let running = 0
    let most = 0
    let runs = 0
    const gates: (() => void)[] = []
    const fn = async (): Promise<void> => {
      runs++
      running++
      most = Math.max(most, running)
      await new Promise<void>((r) => gates.push(r))
      running--
    }
    const first = coalesced('t1', fn)
    const later = Array.from({ length: 20 }, () => coalesced('t1', fn))
    expect(runs).toBe(1)
    gates.shift()!()
    // The one more run, for all 20 asks.
    await vi.waitFor(() => expect(runs).toBe(2), { timeout: HUNG_MS })
    // The asks made during the first run wait for the second, the first's included (it ran on): none has settled yet.
    let settled = false
    void Promise.all([first, ...later]).then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    gates.shift()!()
    await Promise.all([first, ...later])
    expect(runs).toBe(2)
    expect(most).toBe(1)
    expect(coalescing('t1')).toBe(false)
  })

  it("a run that fails doesn't stop the one after it, and other keys run beside it", async () => {
    let runs = 0
    const failing = coalesced('t2', async () => {
      runs++
      throw new Error('no')
    })
    const again = coalesced('t2', async () => void runs++)
    const other = coalesced('t3', async () => void runs++)
    await Promise.all([failing, again, other])
    expect(runs).toBe(3)
  })
})

describe('board events (#1011)', () => {
  const wsPath = join(base, 'ws')
  const alpha = join(wsPath, 'alpha')
  let w: ReturnType<typeof createWorkspaceService>
  const seen: number[] = []
  let off: () => void
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)

  beforeAll(async () => {
    mkdirSync(join(alpha, '.hive'), { recursive: true })
    writeFileSync(join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    off = onHiveEvent((e: HiveEvent) => {
      if (e.type === 'tasks-changed' && e.workspacePath === wsPath) seen.push(Date.now())
    })
  })
  afterAll(async () => {
    off()
    await disposeWorkspaceService(w)
  })
  afterEach(() => void (seen.length = 0))

  /** Cards in Done; what their creation told the board is cleared before the test looks. */
  async function doneCards(n: number): Promise<number[]> {
    const made: number[] = []
    for (let i = 0; i < n; i++) made.push((await run(() => tasks.createTask({ title: `Card ${i}`, project: 'alpha', column: 'done' }, user))).number)
    // Each was told as it was saved (#1017: Hive's own writes tell the board, no folder watched).
    expect(seen).toHaveLength(n)
    seen.length = 0
    return made
  }

  /** What `batch` told the board: once, as its one transaction committed (#1017), before it returned. */
  async function toldOnceAfter(batch: () => Promise<unknown>): Promise<void> {
    await batch()
    expect(seen).toHaveLength(1)
  }

  it('Archive All of 40 cards tells the board once, after it (its 40 writes were 80 events)', async () => {
    const cards = await doneCards(40)
    await toldOnceAfter(async () => {
      const r = await run(() => tasks.archiveBatch(cards, { label: 'Archive All', column: 'done', project: null, query: '', includeBusy: true }, user))
      expect(r.archived).toHaveLength(40)
    })
  })

  it('a batch update of 30 cards tells the board once, after it (it told one for each card)', async () => {
    const cards = await doneCards(30)
    await toldOnceAfter(async () => {
      const items = await run(() => tasks.updateTasks(cards, { labels: ['x'] }, user))
      expect(items.every((i) => i.error === null)).toBe(true)
    })
  })

  it('a batch that fails part way saves none of it and tells nothing (#1017: one transaction)', async () => {
    const cards = await doneCards(3)
    const before = await Promise.all(cards.map((n) => run(() => tasks.getTask(n))))
    await expect(
      run(() =>
        tasks.cardBatch(w, async () => {
          await tasks.updateTask(cards[0], { labels: ['first'] }, user)
          await tasks.updateTask(cards[1], { labels: ['second'] }, user)
          throw new Error('stopped part way')
        })
      )
    ).rejects.toThrow('stopped part way')
    expect(await Promise.all(cards.map((n) => run(() => tasks.getTask(n))))).toEqual(before)
    expect(seen).toHaveLength(0)
  })

  it('a batch whose transaction SQLite undoes part way (an error that rolls it back) saves none of it, however it handles the error (#1017 round 1)', async () => {
    const cards = await doneCards(3)
    const before = await Promise.all(cards.map((n) => run(() => tasks.getTask(n))))
    // As a full disk or an I/O error would: SQLite rolls the whole transaction back on the middle card's write.
    const outside = new DatabaseSync(boardFile(wsPath), { timeout: 5000 })
    outside.exec(`CREATE TRIGGER undo_test BEFORE UPDATE ON cards WHEN old.number = ${cards[1]} BEGIN SELECT RAISE(ROLLBACK, 'disk I/O error (test)'); END`)
    // The trigger is another connection's commit, which the board's poll tells (#1017): wait for that, so it isn't taken for the batches'.
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: HUNG_MS })
    seen.length = 0
    try {
      // Archive All skips a card it can't save and goes on: the change still fails whole, and nothing is saved after it.
      await expect(run(() => tasks.archiveBatch(cards, { label: 'Archive All', column: 'done', project: null, query: '', includeBusy: true }, user))).rejects.toThrow(/undone part way/)
      // A batch move does the same with each card's refusal.
      await expect(run(() => tasks.updateTasks(cards, { labels: ['x'] }, user))).rejects.toThrow(/undone part way/)
      expect(seen).toHaveLength(0)
    } finally {
      outside.exec('DROP TRIGGER undo_test')
      outside.close()
    }
    // Dropping it is told the same way: wait for it, so it isn't counted by the next test.
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: HUNG_MS })
    seen.length = 0
    expect(await Promise.all(cards.map((n) => run(() => tasks.getTask(n))))).toEqual(before)
    // The board goes on as before.
    await run(() => tasks.updateTasks(cards, { labels: ['after'] }, user))
    expect((await run(() => tasks.getTask(cards[2]))).labels).toEqual(['after'])
  })

  it("a loop's handoff is told once its change is saved, in a batch too, and sees the card as saved (#1017)", async () => {
    const [x, y] = await doneCards(2)
    await run(() => tasks.updateTasks([x, y], { column: 'todo' }, user))
    const builder = { kind: 'agent', name: 'Agent 1 (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' } as const
    await run(() => tasks.updateTasks([x, y], { agent: 'a1' }, user))
    const handed: { n: number; column: string; seen: number }[] = []
    tasks.onLoopEvent((e) => {
      // Read as any reader outside the change reads it: the last commit.
      void tasks.getTask(e.card.number, w).then((c) => handed.push({ n: c.number, column: c.column, seen: seen.length }))
    })
    try {
      seen.length = 0
      await run(() => tasks.updateTasks([x, y], { column: 'review' }, builder))
      await vi.waitFor(() => expect(handed).toHaveLength(2), { timeout: HUNG_MS })
      // Both after the batch's one event, each reading its card in Review.
      expect(handed.map((h) => [h.n, h.column, h.seen])).toEqual([
        [x, 'review', 1],
        [y, 'review', 1]
      ])
    } finally {
      tasks.onLoopEvent(() => undefined)
    }
  })

  it('a card changed by another process (another copy of Hive, a script) is told, and a burst of them a few times, not once a card', async () => {
    const doc = (n: number) => ({ number: n, title: 'From outside', project: 'alpha', column: 'todo', order: n, history: [], comments: [] })
    writeCardOutside(wsPath, 9001, doc(9001))
    // Seen by the board's poll of its file (once a second), within a bound for a slow machine, not a time slept for.
    await vi.waitFor(() => expect(seen.length).toBe(1), { timeout: HUNG_MS })
    expect((await run(() => tasks.getTask(9001))).title).toBe('From outside')
    seen.length = 0
    for (let i = 0; i < 30; i++) writeCardOutside(wsPath, 9100 + i, doc(9100 + i))
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: HUNG_MS })
    await vi.waitFor(async () => expect((await run(() => tasks.allTasks(w))).filter((c) => c.number >= 9100).length).toBe(30), { timeout: HUNG_MS })
    expect(seen.length).toBeLessThan(10)
  })

  it("recording the running agents' cards reads the board once a run, one run at a time, with one more for the changes told meanwhile", async () => {
    const live = Array.from({ length: 12 }, (_, i) => ({ projectPath: alpha, agentId: `a${i}`, sessionId: `s${i}`, settingUp: false }) as unknown as LiveSessionState)
    boardReads.n = 0
    // 50 board changes told while the first run reads: 12 agents each, they were 600 reads.
    const all = Array.from({ length: 50 }, () => recordLiveCardsSoon(wsPath, () => live))
    await Promise.all(all)
    expect(boardReads.n).toBe(2)
  })
})
