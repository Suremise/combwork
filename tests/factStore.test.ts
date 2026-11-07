// The fact store in the workspace's combwork.db (#1215, SPEC §16.4): facts, actions and the stage cache written in the board's
// transaction (a change undone leaves none of them), the actions worker (each action's effect once, also when run
// again after a crash or at the same time: claimed before it runs, or found delivered, #1266), two Combworks observing one transition writing it once, and the runtime's
// columns of a card kept by the board's own saves while the card's JSON stays as it was.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import { writeCardOutside } from './boardDb'

const base = tempDir('cw-fact-store-')
// The longest a wait here waits for what it waits on: a bound for a hung run (tests/README.md).
const HUNG_MS = 10_000
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore, factStoreTestHooks } = await import('../src/main/workflow/factStore')
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
  factStoreTestHooks.afterCards = null
})

async function workspace(): Promise<{ ws: string; w: WS }> {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, 'p', '.combwork'), { recursive: true })
  writeFileSync(join(ws, 'p', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { ws, w }
}
const scope = { project: 'p', key: 'P' }
type Store = import('../src/main/workflow/factStore').FactStore
const factsOf = (s: Store, card: number): string[] => s.facts(card).map((f) => f.kind)
const actionsOf = (ws: string): { id: number; kind: string; state: string }[] =>
  store.workspaceDb(ws).reader.prepare('SELECT id, kind, state FROM card_actions ORDER BY id').all() as { id: number; kind: string; state: string }[]

describe('the facts step (#1215)', () => {
  it('is in the 1.0 group after the cards step, and a new board has its tables', async () => {
    const step = store.BOARD_MIGRATIONS.find((m) => m.name === 'facts')
    expect(step).toMatchObject({ group: '1.0' })
    expect(step!.version).toBeGreaterThan(store.BOARD_MIGRATIONS.find((m) => m.name === 'cards in tables')!.version)
    const { ws } = await workspace()
    const tables = (store.workspaceDb(ws).reader.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name)
    expect(tables).toEqual(expect.arrayContaining(['card_facts', 'card_actions', 'rulesets', 'folder_commits', 'card_paths', 'workflow_queue_pauses']))
  })
})

describe('the fact store in combwork.db (#1215)', () => {
  it("writes inside the caller's board change: undone with it, a fact, an action and the stage leave nothing", async () => {
    const { ws, w } = await workspace()
    const facts = FactStore.forBoard(w, scope)
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
    const facts = FactStore.forBoard(w, scope)
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
    // The worker starts once the change has committed (a notice is claimed, done, before it runs).
    await vi.waitFor(() => expect(ran).toHaveLength(1), HUNG_MS)
    expect(actionsOf(ws)).toMatchObject([{ kind: 'notice', state: 'done' }])
    await worker.runActions(w)
    expect(ran).toHaveLength(1)
  })

  it('a restart runs a claimed action a crash left pending, once; one claimed before the crash is not run again (#1266)', async () => {
    const { ws, w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Crashed', project: 'p' }, user))).number
    // Written by another Combwork's connection (no worker there runs them): left pending, as a crash right after the commit.
    const other = FactStore.open(store.boardFile(ws), scope)
    stores.push(other)
    const [first, second] = other.tx((tx) => [tx.action(card, 'notice', { n: 1 }, null), tx.action(card, 'notice', { n: 2 }, null)])
    // The second was claimed (marked done before its effect), and Combwork ended before its effect: at most once, never again.
    other.markAction(second, 'done')
    const ran: unknown[] = []
    worker.onAction('notice', (a) => void ran.push(a.payload.n))
    // At start (the workspace opened), and again: each runs once at most.
    await worker.runActions(w)
    await worker.runActions(w)
    expect(ran).toEqual([1])
    expect(actionsOf(ws)).toMatchObject([{ id: first, state: 'done' }, { id: second, state: 'done' }])
  })

  it('a delivered action runs again until it is marked: after a crash between its delivery and its mark, its handler runs again and finds its delivery (#1266)', async () => {
    const { ws, w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Delivered', project: 'p' }, user))).number
    const other = FactStore.open(store.boardFile(ws), scope)
    stores.push(other)
    const [first, second] = other.tx((tx) => [tx.action(card, 'wake', { n: 1 }, null), tx.action(card, 'wake', { n: 2 }, null)])
    // A stand-in for deliveries: the second's was made before the crash, its action not yet marked.
    const made = new Set<number>([second])
    const runs: number[] = []
    const delivered: number[] = []
    worker.onAction(
      'wake',
      (a) => {
        runs.push(a.id)
        if (!made.has(a.id)) delivered.push(a.id)
        made.add(a.id)
      },
      'delivered'
    )
    expect(actionsOf(ws).map((a) => a.state)).toEqual(['pending', 'pending'])
    await worker.runActions(w)
    await worker.runActions(w)
    // Each pending one ran once more, the second finding its delivery made; then marked, never run again.
    expect(runs).toEqual([first, second])
    expect(delivered).toEqual([first])
    expect(actionsOf(ws)).toMatchObject([{ id: first, state: 'done' }, { id: second, state: 'done' }])
  })

  it('two runs at once, as two Combworks would: each claimed action runs once', async () => {
    const { ws, w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Twice', project: 'p' }, user))).number
    const other = FactStore.open(store.boardFile(ws), scope)
    stores.push(other)
    other.tx((tx) => [1, 2, 3].map((k) => tx.action(card, 'notice', { n: k }, null)))
    const ran: unknown[] = []
    worker.onAction('notice', async (a) => void ran.push(a.payload.n))
    await Promise.all([worker.runActions(w), worker.runActions(w)])
    expect(ran).toEqual([1, 2, 3])
    expect(actionsOf(ws).map((a) => a.state)).toEqual(['done', 'done', 'done'])
  })

  it("the runtime's own executor (tests/workflow) records a delivery once, by its action's id in deliveries (#1266)", async () => {
    const { ws, w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Runtime', project: 'p' }, user))).number
    const other = FactStore.open(store.boardFile(ws), scope)
    stores.push(other)
    const id = other.tx((tx) => tx.action(card, 'wake', { agent: 'r1' }, null))
    expect(other.deliver({ action: id, kind: 'wake', target: 'r1', payload: { agent: 'r1' } })).toBe(true)
    // Again (a restart, another Combwork's runner): the unique row is there.
    const again = FactStore.open(store.boardFile(ws), scope)
    stores.push(again)
    expect(again.deliver({ action: id, kind: 'wake', target: 'r1', payload: { agent: 'r1' } })).toBe(false)
    expect(again.deliveries()).toEqual([{ action: id, kind: 'wake', target: 'r1', payload: { agent: 'r1' } }])
    expect((store.workspaceDb(ws).reader.prepare('SELECT count(*) AS n FROM deliveries WHERE action = ?').get(id) as { n: number }).n).toBe(1)
  })

  it("the board's facts are read again after any commit, another connection's too, and never kept in a write (HI-1909)", async () => {
    const { ws, w } = await workspace()
    const facts = FactStore.forBoard(w, scope)
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Kept', project: 'p' }, user))).number
    const seen = (dedupe: string) => ({ kind: 'HeadMoved' as const, actor: 'outside' as const, source: 'observed' as const, dedupe, data: { line: 'main', from: null, to: dedupe } })
    expect(factsOf(facts, card)).toEqual([])
    // A copy each time: changing one read leaves the next as it was.
    facts.facts(card).push({} as never)
    expect(factsOf(facts, card)).toEqual([])
    // Another connection's commit (another Combwork's): read again.
    const other = FactStore.open(store.boardFile(ws), scope)
    stores.push(other)
    other.tx((tx) => tx.appendObserved(card, seen('a')))
    expect(factsOf(facts, card)).toEqual(['HeadMoved'])
    // This board's own write: what it appends is read inside it, and after it commits.
    await store.boardWrite(w, async () => {
      expect(facts.readToken()).toBeNull()
      facts.tx((tx) => tx.appendObserved(card, seen('b')))
      expect(factsOf(facts, card)).toEqual(['HeadMoved', 'HeadMoved'])
    })
    expect(facts.readToken()).not.toBeNull()
    expect(factsOf(facts, card)).toEqual(['HeadMoved', 'HeadMoved'])
    expect(facts.factsOfKind(['HeadMoved']).map((f) => f.data)).toEqual([{ line: 'main', from: null, to: 'a' }, { line: 'main', from: null, to: 'b' }])
  })

  it('what runs after a commit reads it, quiet writes too, and a change undone keeps what was read (HI-1909, HR5 r1)', async () => {
    const { w } = await workspace()
    const facts = FactStore.forBoard(w, scope)
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'After', project: 'p' }, user))).number
    const seen = (dedupe: string) => ({ kind: 'HeadMoved' as const, actor: 'outside' as const, source: 'observed' as const, dedupe, data: { line: 'main', from: null, to: dedupe } })
    expect(factsOf(facts, card)).toEqual([])
    let after: string[] = []
    await store.boardWrite(w, async () => {
      facts.tx((tx) => tx.appendObserved(card, seen('a')))
      store.afterBoardWrite(w, () => void (after = factsOf(facts, card)))
    })
    expect(after).toEqual(['HeadMoved'])
    // A quiet write (no tasks-changed: written straight, as a quiet store write is) moves the token on too.
    await store.boardWrite(w, async () => {
      store.boardWriteOp(w, (db) => db.prepare("INSERT INTO card_facts (card, seq, kind, at, actor, source, dedupe, data) VALUES (?, 2, 'HeadMoved', ?, 'outside', 'observed', 'b', ?)").run(card, new Date().toISOString(), JSON.stringify(seen('b').data)))
    })
    expect(factsOf(facts, card)).toEqual(['HeadMoved', 'HeadMoved'])
    // Undone: nothing committed, and the facts read stay what is there.
    await expect(
      store.boardWrite(w, async () => {
        facts.tx((tx) => tx.appendObserved(card, seen('c')))
        throw new Error('undone')
      })
    ).rejects.toThrow('undone')
    expect(factsOf(facts, card)).toEqual(['HeadMoved', 'HeadMoved'])
  })

  it("a read's snapshot neither fills the cache nor is served from it: another connection's commit during it is read after (HI-1909, HR5 r1)", async () => {
    const { ws, w } = await workspace()
    const facts = FactStore.forBoard(w, scope)
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Snapshot', project: 'p' }, user))).number
    const other = FactStore.open(store.boardFile(ws), scope)
    stores.push(other)
    expect(factsOf(facts, card)).toEqual([])
    store.boardRead(w, (db) => {
      db.prepare('SELECT count(*) FROM card_facts').get()
      other.tx((tx) => tx.appendObserved(card, { kind: 'HeadMoved', actor: 'outside', source: 'observed', dedupe: 'snap', data: { line: 'main', from: null, to: 'snap' } }))
      expect(facts.readToken()).toBeNull()
      // The snapshot's own view: before the other commit.
      expect(factsOf(facts, card)).toEqual([])
    })
    expect(factsOf(facts, card)).toEqual(['HeadMoved'])
  })

  it('two Combworks (two connections) observing one transition write it once; the loser reads what is there', async () => {
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
    const { w } = await workspace()
    const facts = FactStore.forBoard(w, scope)
    // The board's store writes inside a change of the board only.
    const made = await store.boardWrite(w, async () => facts.createCard({ title: 'The runtime’s', kind: 'no-code', labels: ['x'], blockedBy: [], target: 'release', paths: ['docs/a.md'] }))
    expect(made).toMatchObject({ key: `P-${made.id}`, kind: 'no-code', target: 'release', paths: ['docs/a.md'], stage: 'todo', category: 'todo' })
    // Its lane and reviewer are its lane's (#1291), read from the lanes' tables.
    expect(made).not.toHaveProperty('lane')
    await store.boardWrite(w, async () => facts.startLane('L', [made.id], 'r1', 'R1'))
    expect(facts.card(made.id)).toMatchObject({ lane: 'L', reviewer: 'R1' })
    expect(facts.cardByKey(`p-${made.id}`)?.id).toBe(made.id)
    const before = await inWorkspace(w, () => tasks.getTask(made.id, w))
    expect(Object.keys(before)).not.toEqual(expect.arrayContaining(['kind']))
    await inWorkspace(w, () => tasks.updateTask(made.id, { title: 'Renamed', addLabels: ['y'] }, user, { comment: 'Saved by the board' }))
    expect(facts.card(made.id)).toMatchObject({ title: 'Renamed', labels: ['x', 'y'], kind: 'no-code', target: 'release', paths: ['docs/a.md'], lane: 'L', reviewer: 'R1' })
    // Declared paths: an empty declaration is one (§16.3.3), and the pre-fill is apart from it.
    await store.boardWrite(w, async () => {
      facts.updateCard(made.id, { paths: [] })
      facts.addPrefill(made.id, 'docs/b.md')
      facts.addPrefill(made.id, 'docs/b.md')
    })
    expect(facts.card(made.id).paths).toEqual([])
    expect(facts.prefill(made.id)).toEqual(['docs/b.md'])
  })

  it("keeps each project's lanes, queue pauses and values apart", async () => {
    const { ws } = await workspace()
    const p = FactStore.open(store.boardFile(ws), scope)
    const q = FactStore.open(store.boardFile(ws), { project: 'q', key: 'Q' })
    stores.push(p, q)
    // One record per lane (#1291): lanes.ts's, its id the workspace's; a project reads only its own.
    p.startLane('L', [3, 1], 'r1')
    p.saveLane({ id: 'L', cards: [3, 1], ruleset: 'r1', pending: null, current: 3, ended: false })
    q.startLane('M', [9], 'r2')
    q.saveLane({ id: 'M', cards: [9], ruleset: 'r2', pending: [], current: null, ended: true })
    expect(p.lane('L')).toEqual({ id: 'L', cards: [3, 1], ruleset: 'r1', pending: null, current: 3, ended: false })
    expect(q.lane('M')).toEqual({ id: 'M', cards: [9], ruleset: 'r2', pending: [], current: null, ended: true })
    expect(q.lane('L')).toBeNull()
    expect(p.lane('M')).toBeNull()
    expect(() => q.startLane('L', [9], 'r2')).toThrow(/another project/)
    expect(() => q.saveLane({ id: 'L', cards: [9], ruleset: 'r2', pending: null, current: null, ended: false })).toThrow(/no lane/)
    p.setQueuePause('main', { reason: 'conflict', card: 'P-3', files: ['a.txt', 'b.txt'] })
    expect(p.queuePause('main')).toEqual({ reason: 'conflict', card: 'P-3', files: ['a.txt', 'b.txt'], at: expect.any(String) })
    expect(q.queuePause('main')).toBeNull()
    // Who paused it (#1353), kept with it; a project's paused targets are its own.
    p.setQueuePause('main', { reason: 'user', card: '', by: 'assistant' })
    expect(p.queuePause('main')).toMatchObject({ reason: 'user', by: 'assistant' })
    expect(p.pausedTargets()).toEqual(['main'])
    expect(q.pausedTargets()).toEqual([])
    p.setQueuePause('main', null)
    expect(p.queuePause('main')).toBeNull()
    p.setMeta('seen:main', 'abc')
    expect(q.meta('seen:main')).toBeNull()
    expect(p.meta('seen:main')).toBe('abc')
  })
})

// HR4's #1215 round 1: the board's store writes only inside the caller's own change, and never past a transaction SQLite
// undid; each read is one snapshot; and the worker stops with its workspace, never opening its board again.
describe('the fact store, owned writes and one snapshot (#1215 round 1)', () => {
  const moved = { kind: 'Moved' as const, actor: 'user' as const, source: 'recorded' as const, data: { from: 'todo' as const, to: 'active' as const, cause: 'user' as const } }
  /** A trigger, made by another connection, that has SQLite undo the transaction writing a card's second fact (as a full disk would). */
  const undoSecondFact = (ws: string): void => {
    const db = new DatabaseSync(store.boardFile(ws))
    db.exec("CREATE TRIGGER undo_test BEFORE INSERT ON card_facts WHEN new.seq = 2 BEGIN SELECT RAISE(ROLLBACK, 'disk I/O error (test)'); END")
    db.close()
  }

  it("another change's transaction is never the store's: outside it, reads see what was committed and writes fail", async () => {
    const { w } = await workspace()
    const facts = FactStore.forBoard(w, scope)
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Committed', project: 'p' }, user))).number
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let inside!: () => void
    const entered = new Promise<void>((r) => (inside = r))
    // Change A: an uncommitted title, then it waits, then fails.
    const a = store.boardWrite(w, async () => {
      store.putCard(w, card, { ...store.cardDoc(w, card)!, title: 'Uncommitted' })
      inside()
      await held
      throw new Error('change A fails')
    })
    await entered
    // Not inside A (another async context): what was committed, and no write.
    expect(facts.card(card).title).toBe('Committed')
    expect(() => facts.tx((tx) => tx.append(card, moved))).toThrow('A board write outside boardWrite')
    release()
    await expect(a).rejects.toThrow('change A fails')
    expect(factsOf(facts, card)).toEqual([])
    expect(facts.card(card).title).toBe('Committed')
  })

  it('a change SQLite undid part way writes no more facts, and the change fails whole', async () => {
    const { ws, w } = await workspace()
    const facts = FactStore.forBoard(w, scope)
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Lost', project: 'p' }, user))).number
    undoSecondFact(ws)
    let third: unknown = null
    await expect(
      store.boardWrite(w, async () => {
        facts.tx((tx) => {
          tx.append(card, moved)
          // The caller makes nothing of the second's error, and goes on: the third must not be written on its own.
          try {
            tx.append(card, moved)
          } catch {
            // undone
          }
          try {
            tx.append(card, moved)
          } catch (e) {
            third = e
          }
        })
      })
    ).rejects.toThrow(/undone part way/)
    expect(String(third)).toMatch(/undone part way/)
    expect(factsOf(facts, card)).toEqual([])
  })

  it("on a connection of the store's own: a transaction SQLite undid part way writes no more, and fails whole", async () => {
    const { ws, w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Own', project: 'p' }, user))).number
    const own = FactStore.open(store.boardFile(ws), scope)
    stores.push(own)
    undoSecondFact(ws)
    expect(() =>
      own.tx((tx) => {
        tx.append(card, moved)
        try {
          tx.append(card, moved)
        } catch {
          // undone
        }
        tx.append(card, moved)
      })
    ).toThrow(/undone part way/)
    expect(factsOf(own, card)).toEqual([])
  })

  for (const on of ['the board', 'its own connection'] as const) {
    it(`reads a card on one snapshot (${on}): another process changing its title and labels between the statements isn't mixed in`, async () => {
      const { ws, w } = await workspace()
      const facts = on === 'the board' ? FactStore.forBoard(w, scope) : FactStore.open(store.boardFile(ws), scope)
      stores.push(facts)
      const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Original', project: 'p', labels: ['old'] }, user))).number
      const doc = store.cardDoc(w, card)!
      let hits = 0
      factStoreTestHooks.afterCards = () => {
        if (++hits === 1) writeCardOutside(ws, card, { ...doc, title: 'Changed', labels: ['new'] })
      }
      expect(facts.card(card)).toMatchObject({ title: 'Original', labels: ['old'] })
      expect(hits).toBe(1)
      factStoreTestHooks.afterCards = null
      expect(facts.card(card)).toMatchObject({ title: 'Changed', labels: ['new'] })
    })
  }

  it("a project's cards on one snapshot: a card leaving it meanwhile keeps the lists of the read that picked it", async () => {
    const { ws, w } = await workspace()
    const facts = FactStore.forBoard(w, scope)
    const [a, b] = await inWorkspace(w, async () => [(await tasks.createTask({ title: 'A', project: 'p', labels: ['a'] }, user)).number, (await tasks.createTask({ title: 'B', project: 'p', labels: ['b'] }, user)).number])
    const before = facts.cards()
    factStoreTestHooks.afterCards = () => {
      factStoreTestHooks.afterCards = null
      writeCardOutside(ws, a, { ...store.cardDoc(w, a)!, project: 'q', labels: ['moved'] })
      writeCardOutside(ws, b, { ...store.cardDoc(w, b)!, labels: ['b', 'later'] })
    }
    expect(facts.cards()).toEqual(before)
    expect(facts.cards().map((c) => [c.id, c.labels])).toEqual([[b, ['b', 'later']]])
  })

  it('the worker stops when its workspace switches while a handler runs: the old board is neither opened again nor written', async () => {
    const { ws, w } = await workspace()
    // The other workspace has an action of the same id (each file numbers its own from 1): a run that went on after the
    // switch would mark it.
    const { ws: other, w: ow } = await workspace()
    const otherCard = (await inWorkspace(ow, () => tasks.createTask({ title: 'Other', project: 'p' }, user))).number
    const theirs = FactStore.open(store.boardFile(other), scope)
    const otherId = theirs.tx((tx) => tx.action(otherCard, 'other', {}, null))
    theirs.close()
    await ow.close()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Switched', project: 'p' }, user))).number
    const own = FactStore.open(store.boardFile(ws), scope)
    const id = own.tx((tx) => tx.action(card, 'notice', {}, null))
    own.close()
    expect(id).toBe(otherId)
    let openWhileRunning: boolean | null = null
    worker.onAction('notice', async () => {
      await w.open(other)
      openWhileRunning = store.boardOpen(ws)
    })
    await worker.runActions(w)
    expect(openWhileRunning).toBe(false)
    expect(store.boardOpen(ws)).toBe(false)
    // Claimed before the switch (done: at most once, never run again there).
    const raw = new DatabaseSync(store.boardFile(ws), { readOnly: true })
    try {
      expect({ ...(raw.prepare('SELECT state FROM card_actions WHERE id = ?').get(id) as object) }).toEqual({ state: 'done' })
    } finally {
      raw.close()
    }
    // And the workspace it switched to is untouched.
    const there = store.workspaceDb(other).reader
    expect({ ...(there.prepare('SELECT state FROM card_actions WHERE id = ?').get(otherId) as object) }).toEqual({ state: 'pending' })
  })

  it('the worker stops when its workspace closes while it waits for the board: nothing opened or written', async () => {
    const { ws, w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Closed', project: 'p' }, user))).number
    const own = FactStore.open(store.boardFile(ws), scope)
    const id = own.tx((tx) => tx.action(card, 'notice', {}, null))
    own.close()
    const ran: number[] = []
    worker.onAction('notice', (a) => void ran.push(a.id))
    // A change holds the board's lock; the run waits behind it, and the workspace closes meanwhile.
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let inside!: () => void
    const entered = new Promise<void>((r) => (inside = r))
    const holding = store.boardWrite(w, async () => {
      inside()
      await held
    })
    await entered
    const run = worker.runActions(w)
    const closing = w.close()
    release()
    await holding.catch(() => undefined)
    await closing
    await run
    expect(ran).toEqual([])
    expect(store.boardOpen(ws)).toBe(false)
    const raw = new DatabaseSync(store.boardFile(ws), { readOnly: true })
    try {
      expect({ ...(raw.prepare('SELECT state FROM card_actions WHERE id = ?').get(id) as object) }).toEqual({ state: 'pending' })
    } finally {
      raw.close()
    }
  })
})

// HR4's #1215 round 2: who a run belongs to. No handler runs once its workspace has gone, also when it went as the claim
// committed; and a request from a window still open on the board is never dropped because the run it joined belonged
// to a window that has gone.
describe('the actions worker, who a run belongs to (#1215 round 2)', () => {
  /** Two pending actions on a card of the workspace, written by another connection (no run of ours started for them). */
  async function twoActions(ws: string, w: WS): Promise<[number, number]> {
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Actions', project: 'p' }, user))).number
    const own = FactStore.open(store.boardFile(ws), scope)
    const ids = own.tx((tx) => [tx.action(card, 'notice', { n: 1 }, null), tx.action(card, 'notice', { n: 2 }, null)] as [number, number])
    own.close()
    return ids
  }
  const statesIn = (ws: string): { id: number; state: string }[] => {
    const raw = new DatabaseSync(store.boardFile(ws), { readOnly: true })
    try {
      return (raw.prepare('SELECT id, state FROM card_actions ORDER BY id').all() as { id: number; state: string }[]).map((r) => ({ ...r }))
    } finally {
      raw.close()
    }
  }

  it('closed as its claim commits: the handler never runs', async () => {
    const { ws, w } = await workspace()
    const [first] = await twoActions(ws, w)
    const ran: number[] = []
    worker.onAction('notice', (a) => void ran.push(a.id))
    let closing: Promise<void> | null = null
    // The first claim's commit closes the workspace (a listener of that commit, as anything after a change may).
    const off = store.onBoardCommitted(() => {
      if (closing || !store.boardOpen(ws)) return
      const claimed = store.workspaceDb(ws).reader.prepare("SELECT 1 FROM card_actions WHERE id = ? AND state = 'done'").get(first)
      if (claimed) closing = w.close()
    })
    try {
      await worker.runActions(w)
      await closing
    } finally {
      off()
    }
    expect(closing).not.toBeNull()
    expect(ran).toEqual([])
    expect(store.boardOpen(ws)).toBe(false)
    // Claimed (at most once: it isn't run again), the other untouched.
    expect(statesIn(ws)).toEqual([
      { id: first, state: 'done' },
      { id: first + 1, state: 'pending' }
    ])
  })

  it('a window still open on the board takes over a run whose window switched away: no request is dropped', async () => {
    const { ws, w } = await workspace()
    const other = join(base, `ws-${++n}`)
    mkdirSync(other, { recursive: true })
    const [first, second] = await twoActions(ws, w)
    const ran: number[] = []
    let second$: Promise<void> | null = null
    let w2: WS | null = null
    worker.onAction('notice', async (a) => {
      ran.push(a.id)
      if (a.id !== first) return
      // The old window opens another workspace; a new window opens this one and asks for a run while the old one is
      // still registered.
      await w.open(other)
      w2 = createWorkspaceService()
      await w2.open(ws)
      opened.push(w2)
      second$ = worker.runActions(w2)
    })
    await worker.runActions(w)
    await second$
    expect(w2).not.toBeNull()
    // The first ran once (claimed before it ran); the second ran in the new window.
    expect(ran).toEqual([first, second])
    expect(statesIn(ws)).toEqual([
      { id: first, state: 'done' },
      { id: second, state: 'done' }
    ])
  })

  // HR4's #1215 round 3 (#1240): one requester per window and lifetime, however often it asks while a run goes on.
  /** A handler that holds the first action until released, recording which window ran each. */
  function holdFirst(first: number): { ran: { id: number; ws: WS }[]; entered: Promise<void>; release: () => void } {
    const ran: { id: number; ws: WS }[] = []
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let inside!: () => void
    const entered = new Promise<void>((r) => (inside = r))
    worker.onAction('notice', async (a, ws) => {
      ran.push({ id: a.id, ws })
      if (a.id !== first) return
      inside()
      await held
    })
    return { ran, entered, release }
  }

  it('many requests from one window while a run goes on are one requester; each action runs once', async () => {
    const { ws, w } = await workspace()
    const [first, second] = await twoActions(ws, w)
    const h = holdFirst(first)
    const run = worker.runActions(w)
    await h.entered
    const asked = Array.from({ length: 200 }, () => worker.runActions(w))
    expect(worker.runRequesters(ws)).toBe(1)
    h.release()
    await Promise.all([run, ...asked])
    expect(worker.runRequesters(ws)).toBe(0)
    expect(h.ran.map((r) => r.id)).toEqual([first, second])
    expect(statesIn(ws).map((s) => s.state)).toEqual(['done', 'done'])
  })

  it('a window that asked again and again switches away: the window that opens the board next takes the rest, one requester', async () => {
    const { ws, w } = await workspace()
    const other = join(base, `ws-${++n}`)
    mkdirSync(other, { recursive: true })
    const [first, second] = await twoActions(ws, w)
    const h = holdFirst(first)
    const run = worker.runActions(w)
    await h.entered
    const asked = Array.from({ length: 50 }, () => worker.runActions(w))
    expect(worker.runRequesters(ws)).toBe(1)
    // The first window opens another workspace; a new window opens this one and asks, again and again: the switched
    // window's request is dropped as the new one comes in, the new window's kept once.
    await w.open(other)
    const w2 = createWorkspaceService()
    await w2.open(ws)
    opened.push(w2)
    for (let i = 0; i < 50; i++) asked.push(worker.runActions(w2))
    expect(worker.runRequesters(ws)).toBe(1)
    h.release()
    await Promise.all([run, ...asked])
    expect(h.ran).toEqual([
      { id: first, ws: w },
      { id: second, ws: w2 }
    ])
    expect(statesIn(ws).map((s) => s.state)).toEqual(['done', 'done'])
  })

  it('a window that closes and opens the workspace again asks as its new lifetime: the old request is gone, the new one runs the rest', async () => {
    const { ws, w } = await workspace()
    const [first, second] = await twoActions(ws, w)
    const h = holdFirst(first)
    const run = worker.runActions(w)
    await h.entered
    await w.close()
    await w.open(ws)
    const again = worker.runActions(w)
    expect(worker.runRequesters(ws)).toBe(1)
    const more = Array.from({ length: 20 }, () => worker.runActions(w))
    expect(worker.runRequesters(ws)).toBe(1)
    h.release()
    await Promise.all([run, again, ...more])
    // The first's delivery was recorded before the close, so it isn't run again: the new lifetime marks it and runs the second.
    expect(h.ran.map((r) => r.id)).toEqual([first, second])
    expect(statesIn(ws).map((s) => s.state)).toEqual(['done', 'done'])
  })
})

// #1294: cards named by #1219's keys; a prefix a project holds or held as a key is never read as the name form keys had
// before (HR5's round 1: `HI-2` found the board's #2 in a project named `hi`).
describe("a card by its key (#1294)", () => {
  /** A board with projects (name, id, keys: current first, then old), each card given its project and number there. */
  function board(cards: [project: string, projectNumber: number | null][], keys: [projectId: string, key: string, current: boolean][]): { file: string; ids: number[] } {
    const file = join(base, `keys-${++n}.db`)
    const ids = cards.map(([project]) => {
      const s = FactStore.open(file, { project, key: project })
      try {
        return s.createCard({ title: project, kind: 'code', labels: [], blockedBy: [] }).id
      } finally {
        s.close()
      }
    })
    const db = new DatabaseSync(file)
    try {
      for (const [projectId, key, current] of keys) db.prepare('INSERT INTO project_keys (key, project_id, current, since) VALUES (?, ?, ?, ?)').run(key, projectId, current ? 1 : 0, '2026-10-21T00:00:00Z')
      cards.forEach(([project, pn], i) => {
        if (pn !== null) db.prepare('UPDATE cards SET project_id = ?, project_number = ? WHERE number = ?').run(`p-${project}`, pn, ids[i])
      })
    } finally {
      db.close()
    }
    return { file, ids }
  }
  const storeOf = (file: string, project: string): Store => {
    const s = FactStore.open(file, { project, key: project, projectId: () => `p-${project}` })
    stores.push(s)
    return s
  }
  const byKey = (s: Store, refs: string[]): Record<string, number | null> => Object.fromEntries(refs.map((r) => [r, s.cardByKey(r)?.id ?? null]))

  it("a project whose name is its key: its keys and #N find its cards; a key no card has is none, never the board's card with that number", () => {
    // #1 another project's, #2 hi's first (HI-1): HI-2 is no card of hi's, though the board has a #2.
    const { file, ids } = board([['other', 1], ['hi', 1]], [['p-other', 'OT', true], ['p-hi', 'HI', true], ['p-hi', 'HX', false]])
    const hi = storeOf(file, 'hi')
    expect([hi.projectKey(), hi.card(ids[1]).key]).toEqual(['HI', 'HI-1'])
    expect(byKey(hi, ['HI-1', 'hi-1', 'HX-1', `#${ids[1]}`, 'HI-2', 'HX-2', 'HI-9', `#${ids[0]}`])).toEqual({ 'HI-1': ids[1], 'hi-1': ids[1], 'HX-1': ids[1], [`#${ids[1]}`]: ids[1], 'HI-2': null, 'HX-2': null, 'HI-9': null, [`#${ids[0]}`]: null })
  })

  it("another project's key is never this project's name form, nor finds that project's card here", () => {
    // `ot` is named like another project's key (OT): its cards go by its own key, XY.
    const { file, ids } = board([['other', 1], ['ot', 1]], [['p-other', 'OT', true], ['p-ot', 'XY', true]])
    const ot = storeOf(file, 'ot')
    expect(byKey(ot, ['XY-1', 'OT-1', `ot-${ids[1]}`, 'ZZ-1'])).toEqual({ 'XY-1': ids[1], 'OT-1': null, [`ot-${ids[1]}`]: null, 'ZZ-1': null })
  })

  it('the name form trailers were written with still finds a card where its name is no key; a card without a key keeps that name', () => {
    const { file, ids } = board([['other', 1], ['demo', 1], ['alpha-web', null]], [['p-other', 'OT', true], ['p-demo', 'DE', true]])
    const demo = storeOf(file, 'demo')
    expect(byKey(demo, [`demo-${ids[1]}`, 'DE-1', 'demo-1'])).toEqual({ [`demo-${ids[1]}`]: ids[1], 'DE-1': ids[1], 'demo-1': null })
    const web = storeOf(file, 'alpha-web')
    expect([web.projectKey(), web.card(ids[2]).key, web.cardByKey(`alpha-web-${ids[2]}`)?.id]).toEqual(['alpha-web', `alpha-web-${ids[2]}`, ids[2]])
  })
})
