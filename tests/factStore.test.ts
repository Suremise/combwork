// The fact store in the workspace's hive.db (#1215, SPEC §16.4): facts, actions and the stage cache written in the board's
// transaction (a change undone leaves none of them), the actions worker (each action delivered once, also when run
// again after a crash or at the same time), two Hives observing one transition writing it once, and the runtime's
// columns of a card kept by the board's own saves while the card's JSON stays as it was.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-fact-store-')
// The longest a wait here waits for what it waits on: a bound for a hung run (tests/README.md).
const HUNG_MS = 10_000
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const worker = await import('../src/main/workflow/actionWorker')

const user = { kind: 'user' } as const
let n = 0
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
const stores: { close: () => void }[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  worker.clearActionHandlers()
})

async function workspace(): Promise<{ ws: string; w: WS }> {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, 'p', '.hive'), { recursive: true })
  writeFileSync(join(ws, 'p', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { ws, w }
}
const scope = { project: 'p', key: 'P' }
const factsOf = (s: InstanceType<typeof FactStore>, card: number): string[] => s.facts(card).map((f) => f.kind)
const actionsOf = (ws: string): { id: number; kind: string; state: string; delivered: string | null }[] =>
  store.workspaceDb(ws).reader.prepare('SELECT id, kind, state, delivered FROM card_actions ORDER BY id').all() as { id: number; kind: string; state: string; delivered: string | null }[]

describe('the facts step (#1215)', () => {
  it('is in the 1.0 group after the cards step, and a new board has its tables', async () => {
    const step = store.BOARD_MIGRATIONS.find((m) => m.name === 'facts')
    expect(step).toMatchObject({ group: '1.0' })
    expect(step!.version).toBeGreaterThan(store.BOARD_MIGRATIONS.find((m) => m.name === 'cards in tables')!.version)
    const { ws } = await workspace()
    const tables = (store.workspaceDb(ws).reader.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name)
    expect(tables).toEqual(expect.arrayContaining(['card_facts', 'card_actions', 'rulesets', 'folder_commits', 'card_paths', 'workflow_lanes', 'workflow_lane_cards', 'workflow_queue_pauses']))
  })
})

describe('the fact store in hive.db (#1215)', () => {
  it("writes inside the caller's board change: undone with it, a fact, an action and the stage leave nothing", async () => {
    const { ws, w } = await workspace()
    const facts = new FactStore(store.workspaceDb(ws), scope)
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Undone', project: 'p' }, user))).number
    await expect(
      store.boardWrite(w, async () => {
        facts.tx((tx) => {
          const f = tx.append(card, { kind: 'Moved', actor: 'user', source: 'recorded', data: { from: 'todo', to: 'active', cause: 'user' } })
          tx.setStage(card, 'active')
          tx.action(card, 'notice', { text: 'x' }, f.seq)
        })
        // Inside the change, the write sees its own facts.
        expect(factsOf(facts, card)).toEqual(['Moved'])
        throw new Error('the change fails after its facts')
      })
    ).rejects.toThrow('the change fails after its facts')
    expect(factsOf(facts, card)).toEqual([])
    expect(actionsOf(ws)).toEqual([])
    expect(facts.card(card)).toMatchObject({ stage: 'todo', category: 'todo' })
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('todo')
  })

  it('commits with the change: the fact, the stage and its column, and the action, which the worker then runs once', async () => {
    const { ws, w } = await workspace()
    const facts = new FactStore(store.workspaceDb(ws), scope)
    const ran: number[] = []
    worker.onAction('notice', (a) => void ran.push(a.id))
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Moved', project: 'p' }, user))).number
    await store.boardWrite(w, async () => {
      facts.tx((tx) => {
        const f = tx.append(card, { kind: 'Moved', actor: 'user', source: 'recorded', data: { from: 'todo', to: 'active', cause: 'user' } })
        tx.setStage(card, 'active')
        tx.action(card, 'notice', { text: 'x' }, f.seq)
      })
      store.boardChanged(w)
    })
    expect(factsOf(facts, card)).toEqual(['Moved'])
    expect(facts.card(card)).toMatchObject({ stage: 'active', category: 'doing' })
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('doing')
    // The worker starts once the change has committed.
    await vi.waitFor(() => expect(actionsOf(ws)).toMatchObject([{ kind: 'notice', state: 'done' }]), HUNG_MS)
    expect(ran).toHaveLength(1)
    await worker.runActions(w)
    expect(ran).toHaveLength(1)
  })

  it('a restart runs the actions a crash left pending, once; one delivered but not marked is marked, not run again', async () => {
    const { ws, w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Crashed', project: 'p' }, user))).number
    // Written by another Hive's connection (no worker there runs them): left pending, as a crash right after the commit.
    const other = FactStore.open(store.boardFile(ws), scope)
    stores.push(other)
    const [first, second] = other.tx((tx) => [tx.action(card, 'notice', { n: 1 }, null), tx.action(card, 'notice', { n: 2 }, null)])
    // The second's delivery was recorded, and Hive ended before it was marked.
    expect(other.deliver({ action: second, kind: 'notice', target: '', payload: { n: 2 } })).toBe(true)
    expect(actionsOf(ws).map((a) => a.state)).toEqual(['pending', 'pending'])
    const ran: unknown[] = []
    worker.onAction('notice', (a) => void ran.push(a.payload.n))
    // At start (the workspace opened), and again: each runs once.
    await worker.runActions(w)
    await worker.runActions(w)
    expect(ran).toEqual([1])
    expect(actionsOf(ws)).toMatchObject([{ id: first, state: 'done' }, { id: second, state: 'done' }])
    expect(other.deliveries().map((d) => d.action)).toEqual([first, second])
  })

  it('two runs at once, as two Hives would: each action delivered once', async () => {
    const { ws, w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Twice', project: 'p' }, user))).number
    const other = FactStore.open(store.boardFile(ws), scope)
    stores.push(other)
    other.tx((tx) => [1, 2, 3].map((k) => tx.action(card, 'notice', { n: k }, null)))
    const ran: unknown[] = []
    worker.onAction('notice', async (a) => void ran.push(a.payload.n))
    await Promise.all([worker.runActions(w), worker.runActions(w)])
    expect(ran).toEqual([1, 2, 3])
    // The other Hive running them again (its own runtime's runner): every delivery is already there.
    for (const a of other.pendingActions()) expect(other.deliver({ action: a.id, kind: a.kind, target: '', payload: a.payload })).toBe(false)
  })

  it('two Hives (two connections) observing one transition write it once; the loser reads what is there', async () => {
    const { ws, w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Observed', project: 'p' }, user))).number
    const a = FactStore.open(store.boardFile(ws), scope)
    const b = FactStore.open(store.boardFile(ws), scope)
    stores.push(a, b)
    const seen = { kind: 'HeadMoved' as const, actor: 'outside' as const, source: 'observed' as const, dedupe: 'prev:0', data: { line: 'main', from: null, to: 'abc' } }
    expect(a.tx((tx) => tx.appendObserved(card, seen))).toMatchObject({ seq: 1, kind: 'HeadMoved' })
    expect(b.tx((tx) => tx.appendObserved(card, seen))).toBeNull()
    expect(factsOf(b, card)).toEqual(['HeadMoved'])
    // A later transition from the same point is another key: recorded.
    expect(b.tx((tx) => tx.appendObserved(card, { ...seen, dedupe: 'prev:1', data: { line: 'main', from: 'abc', to: 'def' } }))).toMatchObject({ seq: 2 })
    expect(factsOf(a, card)).toEqual(['HeadMoved', 'HeadMoved'])
  })

  it("keeps the runtime's columns of a card through the board's saves, and the card's JSON as it was", async () => {
    const { ws, w } = await workspace()
    const facts = new FactStore(store.workspaceDb(ws), scope)
    const made = facts.createCard({ title: 'The runtime’s', kind: 'no-code', labels: ['x'], blockedBy: [], target: 'release', paths: ['docs/a.md'], lane: 'L', reviewer: 'R1' })
    expect(made).toMatchObject({ key: `P-${made.id}`, kind: 'no-code', target: 'release', paths: ['docs/a.md'], lane: 'L', reviewer: 'R1', stage: 'todo', category: 'todo' })
    expect(facts.cardByKey(`p-${made.id}`)?.id).toBe(made.id)
    const before = await inWorkspace(w, () => tasks.getTask(made.id, w))
    expect(Object.keys(before)).not.toEqual(expect.arrayContaining(['kind']))
    await inWorkspace(w, () => tasks.updateTask(made.id, { title: 'Renamed', addLabels: ['y'] }, user, { comment: 'Saved by the board' }))
    expect(facts.card(made.id)).toMatchObject({ title: 'Renamed', labels: ['x', 'y'], kind: 'no-code', target: 'release', paths: ['docs/a.md'], lane: 'L', reviewer: 'R1' })
    // Declared paths: an empty declaration is one (§16.3.3), and the pre-fill is apart from it.
    facts.updateCard(made.id, { paths: [] })
    facts.addPrefill(made.id, 'docs/b.md')
    facts.addPrefill(made.id, 'docs/b.md')
    expect(facts.card(made.id).paths).toEqual([])
    expect(facts.prefill(made.id)).toEqual(['docs/b.md'])
  })

  it("keeps each project's lanes, queue pauses and values apart", async () => {
    const { ws } = await workspace()
    const p = new FactStore(store.workspaceDb(ws), scope)
    const q = new FactStore(store.workspaceDb(ws), { project: 'q', key: 'Q' })
    p.saveLane({ id: 'L', cards: [3, 1], ruleset: 'r1', pending: null, current: 3, ended: false })
    q.saveLane({ id: 'L', cards: [9], ruleset: 'r2', pending: [], current: null, ended: true })
    expect(p.lane('L')).toEqual({ id: 'L', cards: [3, 1], ruleset: 'r1', pending: null, current: 3, ended: false })
    expect(q.lane('L')).toEqual({ id: 'L', cards: [9], ruleset: 'r2', pending: [], current: null, ended: true })
    p.setQueuePause('main', { reason: 'conflict', card: 'P-3', files: ['a.txt', 'b.txt'] })
    expect(p.queuePause('main')).toEqual({ reason: 'conflict', card: 'P-3', files: ['a.txt', 'b.txt'] })
    expect(q.queuePause('main')).toBeNull()
    p.setQueuePause('main', null)
    expect(p.queuePause('main')).toBeNull()
    p.setMeta('seen:main', 'abc')
    expect(q.meta('seen:main')).toBeNull()
    expect(p.meta('seen:main')).toBe('abc')
  })
})
