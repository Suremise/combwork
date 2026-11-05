// The durable actions' handlers (#1266, SPEC §16.4.5): wakes and notices from the runtime's facts, each delivered once
// through deliveries (the action's id on its delivery, unique), the loop's handoffs from the facts the board's changes
// record (no second path), a decision waking the loop's builder and reviewer (S5), a reviewer's request waking the
// builder at once (S23), a notice claimed before it is shown, and their off switches (the project's loop wakes; the
// workflow rules switch, which they don't answer to: they aren't gates).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { follow } from './followDoorbell'

const base = tempDir('hive-action-handlers-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
mkdirSync(join(base, 'profile'), { recursive: true })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const watches = await import('../src/main/watches')
watches.testHooks.settleMs = 0
const lanes = await import('../src/main/lanes')
const loopWakes = await import('../src/main/loopWakes')
const decisionWakes = await import('../src/main/decisionWakes')
const notices = await import('../src/main/workflowNotices')
const store = await import('../src/main/boardStore')
const deliveries = await import('../src/main/deliveries')
const worker = await import('../src/main/workflow/actionWorker')
const { FactStore } = await import('../src/main/workflow/factStore')
const { sessions } = await import('../src/main/sessions')
const { advanced } = await import('../src/main/advanced')
const { ENFORCE } = await import('../src/main/workflow/service')
const { runCardIntent } = await import('../src/main/cardIntents')
const { allOff } = await import('../src/shared/workflow/options')
const { readCondition } = await import('../src/shared/watch')
type WatchCondition = import('../src/shared/watch').WatchCondition
advanced.load(join(base, 'profile'))
loopWakes.initLoopWakes()
decisionWakes.initDecisionWakes()
notices.initWorkflowNotices()
decisionWakes.testHooks.settleMs = 0

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w).catch(() => undefined)
  store.closeAllBoards()
  rmSync(base, { recursive: true, force: true })
})
afterEach(async () => {
  await advanced.set(ENFORCE, true)
  await loopWakes.clearLoopWakes()
})

let n = 0
/** A workspace whose project alpha has a builder (b1) and a reviewer (r1). */
async function open(cfg: Record<string, unknown> = {}): Promise<{ w: WS; ws: string; alpha: string }> {
  const ws = join(base, `ws-${++n}`)
  const alpha = join(ws, 'alpha')
  mkdirSync(join(alpha, '.combwork'), { recursive: true })
  writeFileSync(join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], ...cfg }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, ws, alpha }
}

/** Stand-in sessions (as loopWakes.test's): each agent running in a status, and what each read from Combwork's doorbell. */
function fake(alpha: string, status: Record<string, string> = { b1: 'ready', r1: 'ready' }) {
  const state = { status: new Map(Object.entries(status)), typed: [] as { agent: string; text: string }[], notices: [] as { title: unknown; body: unknown }[] }
  Object.assign(sessions, {
    liveFor: (p: string, id: string) => (p.toLowerCase() === alpha.toLowerCase() && state.status.has(id) ? ({ projectPath: alpha, agentId: id, status: state.status.get(id), runId: `run-${id}` } as never) : null),
    liveStates: () => [...state.status].map(([id, s]) => ({ projectPath: alpha, agentId: id, status: s, runId: `run-${id}` })),
    userMayBeTyping: () => false,
    lineWaiting: () => false,
    promptsTaken: (p: string, id: string) => (p.toLowerCase() === alpha.toLowerCase() && state.status.has(id) ? { runId: `run-${id}`, count: state.typed.filter((t) => t.agent === id).length } : null),
    sendPrompt: async (_p: string, id: string, text: string, guard?: () => void) => {
      guard?.()
      state.status.set(id, 'working')
      state.typed.push({ agent: id, text: await follow(alpha, id, text) })
    },
    watchChanged: () => undefined,
    notice: (p: string, title: unknown, body: unknown) => {
      // Other tests' workspaces can still finish a lane check after this stand-in is installed (HI-2431).
      if (p.toLowerCase() === alpha.toLowerCase()) state.notices.push({ title, body })
    }
  })
  return state
}

const user = { kind: 'user' } as const
const agent = (id: string, name: string) => ({ kind: 'agent', name: `${name} (alpha)`, self: { project: 'alpha', agentId: id }, scope: 'alpha' }) as const
const b1 = agent('b1', 'B1')
const r1 = agent('r1', 'R1')
const HANG = { timeout: 10_000 }
/** Everything the changes so far started: their actions run, their wakes made and tried. */
async function settled(): Promise<void> {
  await worker.actionsSettled()
  await loopWakes.settled()
  await deliveries.offerAllForTests()
  await loopWakes.settled()
}
const typedUntil = async (st: { typed: unknown[] }, count: number) =>
  vi.waitFor(async () => {
    await deliveries.offerAllForTests()
    expect(st.typed).toHaveLength(count)
  }, HANG)
const newCard = async (w: WS) => (await inWorkspace(w, () => tasks.createTask({ title: 'Work', project: 'alpha', agent: 'b1', column: 'doing' }, user))).number
/** A card in a lane (b1 builds, r1 reviews), in Review with r1's review started. */
async function inReview(w: WS): Promise<number> {
  const c = await newCard(w)
  await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
  await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
  await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
  return c
}
/** The workspace's deliveries a durable action made (its id on them). */
const madeBy = (ws: string, action: number): number => (store.workspaceDb(ws).reader.prepare('SELECT count(*) AS n FROM deliveries WHERE action = ?').get(action) as { n: number }).n
/** Writes a fact and a `wake` action for it, as the runtime does (its own connection: another Combwork, or before a restart). */
function runtimeWake(ws: string, card: number, kind: 'ReviewerRequest' | 'Stale', data: Record<string, unknown>, payload: Record<string, unknown>): number {
  const own = FactStore.open(store.boardFile(ws), { project: 'alpha', key: 'alpha' })
  try {
    return own.tx((tx) => {
      const f = tx.append(card, { kind, actor: 'agent:r1', source: 'recorded', data } as never)
      return tx.action(card, 'wake', payload, f.seq)
    })
  } finally {
    own.close()
  }
}

describe('loop wakes from the facts (#1266)', () => {
  it('a move into Done by hand wakes its builder (Moved into Done, no verdict); its own move wakes no one', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inReview(w)
    // A card after it, so the lane runs on once this one is Done (with its lane over, a Done card's step is dropped: HI-1687).
    const next = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c, next], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'passed', column: 'passed' }, r1, { comment: 'Round 1: PASSED.' }))
    // Its verdict (the reviewer's arrival wake was dropped: it started reviewing first).
    await typedUntil(st, 1)
    expect(st.typed.map((t) => t.agent)).toEqual(['b1'])
    // The user merges it: Done, its builder told, though its watch counts verdicts (no verdict moved it there).
    st.status.set('b1', 'ready')
    await watches.registerWatch(w, alpha, 'b1', { cards: [c], changes: ['verdict'] })
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'done' }, user))
    await typedUntil(st, 2)
    expect(st.typed.at(-1)).toMatchObject({ agent: 'b1' })
    // HI-1990: what comes next in its lane, in place of carrying on with the card (the next one is in Doing already).
    expect(st.typed.at(-1)!.text).toMatch(new RegExp(`^\\[CW\\] #${c} is in Done.*Your lane's next card, #${next} \\("Work"\\), is under way: carry on with it`))
    // Moved back by the user (its builder told) and on again by its own builder: its own change wakes it not.
    st.status.set('b1', 'ready')
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'passed' }, user))
    await typedUntil(st, 3)
    st.status.set('b1', 'ready')
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'done' }, b1))
    await settled()
    expect(st.typed).toHaveLength(3)
  })

  it('a move into Review is one wake, not two (no other path: tasks.ts tells nothing of its own)', async () => {
    const { w, ws, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await typedUntil(st, 1)
    await settled()
    expect(st.typed).toHaveLength(1)
    const actions = store.workspaceDb(ws).reader.prepare("SELECT id, state FROM card_actions WHERE card = ? AND kind = 'wake'").all(c) as { id: number; state: string }[]
    expect(actions).toHaveLength(1)
    expect(actions[0].state).toBe('done')
    expect(madeBy(ws, actions[0].id)).toBe(1)
  })

  it("S23: a reviewer's request wakes the builder at once, its watch for Passed notwithstanding, with what it asks", async () => {
    const { w, ws, alpha } = await open()
    const st = fake(alpha, { b1: 'watching', r1: 'working' })
    const c = await inReview(w)
    await settled()
    st.typed.length = 0
    // A watch only for the card to be in Passed (one counting its verdict tells the request itself, #1272: below).
    await watches.registerWatch(w, alpha, 'b1', { cards: [c], changes: ['column'], column: 'passed' })
    const id = runtimeWake(ws, c, 'ReviewerRequest', { text: 'Which branch did you test on?' }, { agent: 'b1', why: `alpha-${c}: the reviewer asks: Which branch did you test on?` })
    await worker.runActions(w)
    await typedUntil(st, 1)
    expect(st.typed[0].agent).toBe('b1')
    expect(st.typed[0].text).toContain('The reviewer asks: "Which branch did you test on?"')
    expect(st.typed[0].text).toContain('This is your card in its loop')
    expect(madeBy(ws, id)).toBe(1)
  })

  it("a wake of the runtime's that names its fact plainly (a pass gone stale) is a note, in its own words", async () => {
    const { w, ws, alpha } = await open()
    const st = fake(alpha)
    const c = await inReview(w)
    await settled()
    st.typed.length = 0
    runtimeWake(ws, c, 'Stale', { approved: 'abc', current: 'def', why: 'change' }, { agent: 'b1', why: 'stale: submit again' })
    await worker.runActions(w)
    await typedUntil(st, 1)
    expect(st.typed[0]).toMatchObject({ agent: 'b1' })
    expect(st.typed[0].text).toContain('Combwork: "stale: submit again"')
  })
})

describe("the merge queue's comment on a card it returned (HI-2087)", () => {
  /** Writes a `comment` action, as the queue's return does (its own connection). */
  const commentAction = (ws: string, card: number): number => {
    const own = FactStore.open(store.boardFile(ws), { project: 'alpha', key: 'alpha' })
    try {
      return own.tx((tx) => tx.action(card, 'comment', { text: `alpha-${card} came back from the merge queue: a conflict with main in a.txt. Merge main into your worktree, resolve the conflict, commit and submit again (cw_submit).`, shown: { id: 'tasks.history.queueReturned', values: { reason: 'conflict', target: 'main', check: '', files: 'a.txt' } } }, null))
    } finally {
      own.close()
    }
  }
  const stateOf = (ws: string, id: number): string => (store.workspaceDb(ws).reader.prepare('SELECT state FROM card_actions WHERE id = ?').get(id) as { state: string }).state
  const hiveComments = async (w: WS, c: number) => (await inWorkspace(w, () => tasks.getTask(c))).comments.filter((x) => x.by === 'Combwork')

  it('written once on the card, its English and its message; a run again (after a restart) writes nothing more', async () => {
    const { w, ws } = await open()
    const c = await newCard(w)
    const id = commentAction(ws, c)
    await worker.runActions(w)
    await worker.actionsSettled()
    expect(stateOf(ws, id)).toBe('done')
    const said = await hiveComments(w, c)
    expect(said).toHaveLength(1)
    expect(said[0]).toMatchObject({ id: `action-${id}`, text: expect.stringMatching(/^alpha-\d+ came back from the merge queue: a conflict with main in a\.txt\./), appText: { id: 'tasks.history.queueReturned' } })
    // As a restart would find it: pending again, run again. Its comment is there already (its id): none more.
    store.workspaceDb(ws).writer.prepare("UPDATE card_actions SET state = 'pending' WHERE id = ?").run(id)
    await worker.runActions(w)
    await worker.actionsSettled()
    expect(stateOf(ws, id)).toBe('done')
    expect(await hiveComments(w, c)).toHaveLength(1)
  })

  it("a write that fails: the action is recorded failed, never done without its comment; an archived card's is done with none", async () => {
    const { w, ws } = await open()
    const failing = await newCard(w)
    const id = commentAction(ws, failing)
    notices.noticeTestHooks.commentFails = true
    try {
      await worker.runActions(w)
      await worker.actionsSettled()
    } finally {
      notices.noticeTestHooks.commentFails = undefined
    }
    expect(stateOf(ws, id)).toBe('failed')
    expect(await hiveComments(w, failing)).toHaveLength(0)
    // Archived since: nothing to say it on, done.
    const c = await newCard(w)
    await inWorkspace(w, () => tasks.archiveTask(c, true))
    const gone = commentAction(ws, c)
    await worker.runActions(w)
    await worker.actionsSettled()
    expect(stateOf(ws, gone)).toBe('done')
    expect(await hiveComments(w, c)).toHaveLength(0)
  })
})

describe('delivered once (#1266, S33(b))', () => {
  it('two runs of the actions at once (two windows on one board) make one delivery; after a restart, a run again makes none', async () => {
    const { w, ws, alpha } = await open()
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    const c = await inReview(w)
    await settled()
    const before = st.typed.length
    // Written by another connection (a crash right after its commit): pending, no run of ours started for it.
    const id = runtimeWake(ws, c, 'ReviewerRequest', { text: 'Once?' }, { agent: 'b1', why: 'once' })
    await Promise.all([worker.runActions(w), worker.runActions(w)])
    await settled()
    expect(madeBy(ws, id)).toBe(1)
    // A restart before the action was marked: the delivery is on disk, the action pending again, nothing in memory.
    store.workspaceDb(ws).writer.prepare("UPDATE card_actions SET state = 'pending' WHERE id = ?").run(id)
    await deliveries.forgetDeliveriesForTests()
    await deliveries.load(alpha)
    await worker.runActions(w)
    await worker.runActions(w)
    await settled()
    expect(madeBy(ws, id)).toBe(1)
    expect((store.workspaceDb(ws).reader.prepare('SELECT state FROM card_actions WHERE id = ?').get(id) as { state: string }).state).toBe('done')
    st.status.set('b1', 'ready')
    await typedUntil(st, before + 1)
    await settled()
    expect(st.typed).toHaveLength(before + 1)
  })

  it('a newer wake of the same card replaces one still waiting by a delivery of its own (each action keeps its row)', async () => {
    const { w, ws, alpha } = await open()
    fake(alpha, { b1: 'working', r1: 'working' })
    const c = await inReview(w)
    await settled()
    const first = runtimeWake(ws, c, 'ReviewerRequest', { text: 'One' }, { agent: 'b1', why: 'one' })
    await worker.runActions(w)
    const second = runtimeWake(ws, c, 'ReviewerRequest', { text: 'Two' }, { agent: 'b1', why: 'two' })
    await worker.runActions(w)
    await settled()
    expect([madeBy(ws, first), madeBy(ws, second)]).toEqual([1, 1])
    const rows = store.workspaceDb(ws).reader.prepare('SELECT action, state FROM deliveries WHERE action IN (?, ?) ORDER BY action').all(first, second) as { action: number; state: string }[]
    expect(rows.map((r) => r.state)).toEqual(['cancelled', 'queued'])
  })
})

describe('decisions wake the loop (#1266, S5; #587)', () => {
  it('a decision on a card in Review wakes its builder and its reviewer, each watching (not waiting for the user)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inReview(w)
    await settled()
    st.typed.length = 0
    st.status.set('b1', 'watching')
    st.status.set('r1', 'watching')
    await inWorkspace(w, () => tasks.updateTask(c, { decision: 'Use the second option.' }, user))
    await typedUntil(st, 2)
    expect(st.typed.map((t) => t.agent).sort()).toEqual(['b1', 'r1'])
    for (const t of st.typed) expect(t.text).toContain(`#${c} has 1 new decision from the user`)
  })

  it('in Passed: its builder and the reviewer that passed it; not whoever recorded it', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inReview(w)
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'passed', column: 'passed' }, r1, { comment: 'PASSED' }))
    await typedUntil(st, 1)
    st.typed.length = 0
    st.status.set('b1', 'watching')
    st.status.set('r1', 'watching')
    // Recorded by the builder (an agent writes down what the user decided): only the reviewer is told.
    await inWorkspace(w, () => tasks.updateTask(c, { decision: 'Ship it as it is.' }, b1))
    await typedUntil(st, 1)
    await settled()
    expect(st.typed.map((t) => t.agent)).toEqual(['r1'])
  })
})

describe("the builder's watch hears its reviewer's request and the user's decisions (#1272, SPEC §16.8.2)", () => {
  /** A project with a workflow (no version control: the intents need one) and a lane, its card in Review by intent with r1 reviewing it. */
  async function byIntent(): Promise<{ w: WS; ws: string; alpha: string; c: number }> {
    const { w, ws, alpha } = await open({ workflow: { platform: 'none', preset: null, options: { ...allOff('none'), review: 'agent', noSelfReview: true } } })
    const c = (await inWorkspace(w, () => tasks.createTask({ title: 'Work', project: 'alpha' }, user))).number
    // A card with no code (S25): submitted with a summary, no revision.
    await store.boardWrite(w, async () => void FactStore.forBoard(w, { project: 'alpha', key: 'alpha' }).updateCard(c, { kind: 'no-code' }))
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    const act = (who: typeof b1 | typeof r1, intent: Parameters<typeof runCardIntent>[2]) => inWorkspace(w, () => runCardIntent({ n: c, plain: false }, who, intent))
    await act(b1, { kind: 'start' })
    await act(b1, { kind: 'submit', summary: 'Round 1 ready' })
    await act(r1, { kind: 'startReview' })
    return { w, ws, alpha, c }
  }
  const wakeActions = (ws: string, c: number, kind: string): number[] => (store.workspaceDb(ws).reader.prepare('SELECT id FROM card_actions WHERE card = ? AND kind = ? ORDER BY id').all(c, kind) as { id: number }[]).map((r) => r.id)

  it("S23's watch side: a request by intent wakes the builder's watch for its verdict and Passed within seconds, with what it asks; the loop wake stands aside (one line)", async () => {
    const { w, ws, alpha, c } = await byIntent()
    const st = fake(alpha, { b1: 'watching', r1: 'working' })
    await settled()
    st.typed.length = 0
    // #912's case: the watch counts its verdict and a move into Passed, not comments.
    await watches.registerWatch(w, alpha, 'b1', readCondition({ cards: [c], changes: ['verdict', 'column'], column: 'passed' }) as WatchCondition)
    const before = wakeActions(ws, c, 'wake').length
    await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, r1, { kind: 'request', text: 'Which commit did you test?' }))
    await watches.evaluateWatches(w)
    await typedUntil(st, 1)
    expect(st.typed[0].agent).toBe('b1')
    expect(st.typed[0].text).toBe(`[CW] #${c} is in Review (its reviewer asks you something); latest comment by R1 (alpha): "Which commit did you test?". Your card watch has ended: carry on (cw_read_task with latestComment for the comment in full).`)
    // The request's history line, which the watch counted; the runtime's wake ran (left to the watch, or made and
    // dropped as told by it, whichever came first) and typed no second line.
    expect((await inWorkspace(w, () => tasks.getTask(c, w))).history.map((h) => `${h.by}: ${h.what}`)).toContain('R1 (alpha): Asked the builder: "Which commit did you test?"')
    await settled()
    expect(wakeActions(ws, c, 'wake').slice(before)).toHaveLength(1)
    // Idle again: anything left for it is offered, and dropped as told.
    st.status.set('b1', 'ready')
    await vi.waitFor(async () => {
      await deliveries.offerAllForTests()
      expect(loopWakes.pendingLoopWakes().filter((p) => p.agentId === 'b1')).toEqual([])
    }, HANG)
    expect(st.typed).toHaveLength(1)
  })

  it('a decision wakes the watches that count it, each with one line, the decision lines standing aside; a watch waiting only for its card in a column gets the decision line', async () => {
    const { w, alpha, c } = await byIntent()
    const st = fake(alpha, { b1: 'watching', r1: 'watching' })
    await settled()
    st.typed.length = 0
    await watches.registerWatch(w, alpha, 'b1', readCondition({ cards: [c], changes: ['verdict', 'column', 'comment'], column: 'passed' }) as WatchCondition)
    // The reviewer's watch after a failed round (a fresh move into Review) counts them too.
    await watches.registerWatch(w, alpha, 'r1', readCondition({ cards: [c], column: 'review', fresh: true }) as WatchCondition)
    await inWorkspace(w, () => tasks.updateTask(c, { decision: 'Keep the old name.' }, user))
    await watches.evaluateWatches(w)
    await typedUntil(st, 2)
    // Idle again: no decision line is left to come.
    st.status.set('b1', 'ready')
    st.status.set('r1', 'ready')
    await settled()
    await deliveries.offerAllForTests()
    expect(st.typed).toHaveLength(2)
    for (const t of st.typed) expect(t.text).toMatch(new RegExp(`^\\[CW\\] #${c} (\\(B1's card\\) )?is in Review \\(a new decision from the user: read its decisions\\).*Your card watch has ended`))
    // A watch for the card to be in Done only doesn't count it: the decision line tells it.
    st.typed.length = 0
    st.status.set('b1', 'watching')
    await watches.registerWatch(w, alpha, 'b1', readCondition({ cards: [c], column: 'done' }) as WatchCondition)
    await inWorkspace(w, () => tasks.updateTask(c, { decision: 'And keep its icon.' }, user))
    await watches.evaluateWatches(w)
    await vi.waitFor(async () => {
      await deliveries.offerAllForTests()
      expect(st.typed.filter((t) => t.agent === 'b1')).toHaveLength(1)
    }, HANG)
    expect(st.typed.find((t) => t.agent === 'b1')!.text).toContain(`#${c} has 1 new decision from the user`)
  })

  it("a watch that doesn't count decisions, fired or ended, doesn't stand in for the decision line", async () => {
    const { w, alpha, c } = await byIntent()
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    await settled()
    st.typed.length = 0
    // Waiting only to see the card back in Doing: it fires when the review fails it, its line kept while the builder works.
    await watches.registerWatch(w, alpha, 'b1', readCondition({ cards: [c], column: 'doing' }) as WatchCondition)
    await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, r1, { kind: 'verdict', pass: false, failKind: 'content', comment: 'Round 1: FAILED. 1. Add a test.' }))
    // Fired (its line waits for the builder to be idle) before the decision lands.
    await watches.evaluateWatches(w)
    await settled()
    await inWorkspace(w, () => tasks.updateTask(c, { decision: 'Rename it after all.' }, user))
    await watches.evaluateWatches(w)
    await settled()
    st.status.set('b1', 'ready')
    // What it read (one doorbell can hand it both): the decision line too, not taken as told by the watch.
    const read = () => st.typed.filter((t) => t.agent === 'b1').map((t) => t.text).join(' ')
    await vi.waitFor(async () => {
      // Idle again (the session's status event, in Combwork): its watch's line is made, then the lines are offered.
      await watches.evaluateWatches(w)
      await deliveries.offerAllForTests()
      if (st.status.get('b1') === 'working') st.status.set('b1', 'ready')
      expect(read()).toContain(`#${c} has 1 new decision from the user`)
    }, HANG)
  })

  // HR1's round 1 probes: what a watch told is by the entries' places, not their times, and stays told.
  it('a decision made in the same millisecond as the one a watch told is still news: the decision line tells it, and only it', async () => {
    const { w, alpha, c } = await byIntent()
    const st = fake(alpha, { b1: 'watching', r1: 'working' })
    await settled()
    st.typed.length = 0
    await watches.registerWatch(w, alpha, 'b1', readCondition({ cards: [c], changes: ['comment'] }) as WatchCondition)
    // Two separate writes with the same time (a coarse or corrected clock): only Date is frozen.
    const instant = new Date(Date.now() + 1000)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(instant)
    try {
      await inWorkspace(w, () => tasks.updateTask(c, { decision: 'First decision' }, user))
      await watches.evaluateWatches(w)
      await typedUntil(st, 1)
      expect(st.typed[0].text).toContain('a new decision from the user')
      await watches.settled()
      await settled()
      vi.setSystemTime(instant)
      await inWorkspace(w, () => tasks.updateTask(c, { decision: 'Second decision' }, user))
      await settled()
      expect(watches.watchToldDecisions(alpha, 'b1', await inWorkspace(w, () => tasks.getTask(c, w)), 'B1 (alpha)')).toEqual({ untold: 1 })
      st.status.set('b1', 'ready')
      await decisionWakes.tellNow(w, alpha, 'b1')
      await typedUntil(st, 2)
      expect(st.typed[1].text).toContain(`#${c} has 1 new decision from the user`)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a later watch that doesn't count decisions keeps what an earlier one told: the decision isn't told again", async () => {
    const { w, alpha, c } = await byIntent()
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    await settled()
    // Blocked, so its builder may be told of decisions when idle (not only by a loop's decision wake).
    await inWorkspace(w, () => tasks.updateTask(c, { blocked: 'Need a decision' }, b1))
    await settled()
    st.status.set('b1', 'watching')
    st.typed.length = 0
    await watches.registerWatch(w, alpha, 'b1', readCondition({ cards: [c], changes: ['comment'] }) as WatchCondition)
    await inWorkspace(w, () => tasks.updateTask(c, { decision: 'Keep the name' }, user))
    await watches.evaluateWatches(w)
    await typedUntil(st, 1)
    await watches.settled()
    await settled()
    // Then a watch only for Passed, which the user's move fires and its line tells.
    st.status.set('b1', 'watching')
    await watches.registerWatch(w, alpha, 'b1', readCondition({ cards: [c], column: 'passed' }) as WatchCondition)
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'passed' }, user))
    await watches.evaluateWatches(w)
    await typedUntil(st, 2)
    await watches.settled()
    await settled()
    expect(watches.watchToldDecisions(alpha, 'b1', await inWorkspace(w, () => tasks.getTask(c, w)), 'B1 (alpha)')).toEqual({ untold: 0 })
    st.status.set('b1', 'ready')
    await decisionWakes.tellNow(w, alpha, 'b1')
    await deliveries.offerAllForTests()
    await settled()
    expect(st.typed.filter((t) => t.agent === 'b1')).toHaveLength(2)
  })

  it("a watch on its agent only doesn't count the request: its loop wake wakes the builder, once", async () => {
    const { w, alpha, c } = await byIntent()
    const st = fake(alpha, { b1: 'watching', r1: 'working' })
    await settled()
    st.typed.length = 0
    await watches.registerWatch(w, alpha, 'b1', readCondition({ cards: [c], changes: ['agent'] }) as WatchCondition)
    await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, r1, { kind: 'request', text: 'Please rerun the e2e.' }))
    await watches.evaluateWatches(w)
    await typedUntil(st, 1)
    await settled()
    expect(st.typed).toHaveLength(1)
    expect(st.typed[0].text).toContain('The reviewer asks: "Please rerun the e2e."')
    expect(st.typed[0].text).toContain('This is your card in its loop')
  })
})

describe('decisions on several cards, and another Combwork (#1266 round 2)', () => {
  it("decisions on two Review cards for one busy builder: its line tells both (the second's wake carries the first's card on)", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    const first = await inReview(w)
    const second = await inReview(w)
    await settled()
    await inWorkspace(w, () => tasks.updateTask(first, { decision: 'First card decision' }, user))
    await settled()
    await inWorkspace(w, () => tasks.updateTask(second, { decision: 'Second card decision' }, user))
    await settled()
    st.status.set('b1', 'ready')
    await typedUntil(st, 1)
    await settled()
    const said = st.typed.filter((t) => t.agent === 'b1').map((t) => t.text).join(' ')
    expect(said).toContain(`#${first} has 1 new decision`)
    expect(said).toContain(`#${second} has 1 new decision`)
  })

  it("another Combwork's delivery, saved after this one read its own, outlives this one's next save", async () => {
    const { w, ws, alpha } = await open()
    fake(alpha, { b1: 'working', r1: 'working' })
    await inReview(w)
    await settled()
    const mine = await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: { kind: 'combwork', name: 'Combwork' }, body: 'old local' })
    const db = store.workspaceDb(ws).writer
    const row = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(mine.id) as Record<string, unknown>
    // Another Combwork's, with the id this one would give next, and an action's.
    const next = `m${mine.seq + 1}`
    const theirs = { ...row, id: next, seq: mine.seq + 1, body: 'another Combwork wake', action: 99999 }
    const { DatabaseSync } = await import('node:sqlite')
    const outside = new DatabaseSync(store.boardFile(ws))
    try {
      outside.prepare(`INSERT INTO deliveries (${Object.keys(theirs).join(', ')}) VALUES (${Object.keys(theirs).map(() => '?').join(', ')})`).run(...(Object.values(theirs) as never[]))
    } finally {
      outside.close()
    }
    const later = await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: { kind: 'combwork', name: 'Combwork' }, body: 'later local' })
    // Theirs is kept as they saved it; this one's new delivery took the next free id instead of theirs.
    expect({ ...(db.prepare('SELECT id, body FROM deliveries WHERE action = 99999').get() as object) }).toEqual({ id: next, body: 'another Combwork wake' })
    expect(later.id).not.toBe(next)
    expect({ ...(db.prepare('SELECT body FROM deliveries WHERE host = (SELECT host FROM deliveries WHERE action = 99999) AND id = ?').get(later.id) as object) }).toEqual({ body: 'later local' })
    expect(deliveries.deliveryNow(alpha, later.id)?.body).toBe('later local')
  })
})

describe('off switches (#1266)', () => {
  it("the project's loop wakes off: no arrival, request or decision wakes anyone", async () => {
    const { w, ws, alpha } = await open({ loopWakes: false })
    // Watching (not waiting for the user, whom decision lines reach whatever the switch: #401).
    const st = fake(alpha, { b1: 'watching', r1: 'watching' })
    const c = await inReview(w)
    runtimeWake(ws, c, 'ReviewerRequest', { text: 'Off?' }, { agent: 'b1', why: 'off' })
    await inWorkspace(w, () => tasks.updateTask(c, { decision: 'Off.' }, user))
    await settled()
    // The actions ran (done), and made nothing.
    const states = (store.workspaceDb(ws).reader.prepare('SELECT state FROM card_actions WHERE card = ?').all(c) as { state: string }[]).map((r) => r.state)
    expect(states.length).toBeGreaterThan(0)
    expect(states.every((s) => s === 'done')).toBe(true)
    expect((store.workspaceDb(ws).reader.prepare('SELECT count(*) AS n FROM deliveries WHERE action IS NOT NULL').get() as { n: number }).n).toBe(0)
    expect(st.typed).toEqual([])
  })

  it('workflow rules not enforced: wakes still come (they are no gate)', async () => {
    await advanced.set(ENFORCE, false)
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await typedUntil(st, 1)
    expect(st.typed[0].agent).toBe('r1')
  })
})

describe('notices (#1266, §16.11.4)', () => {
  /** A notice action written as another Combwork's change would (pending), with `attempts` tries already counted. */
  const noticeAction = (ws: string, card: number, kind: string, payload: Record<string, unknown>, attempts = 0): number => {
    const own = FactStore.open(store.boardFile(ws), { project: 'alpha', key: 'alpha' })
    try {
      const id = own.tx((tx) => tx.action(card, kind, payload, null))
      store.workspaceDb(ws).writer.prepare('UPDATE card_actions SET attempts = ? WHERE id = ?').run(attempts, id)
      return id
    } finally {
      own.close()
    }
  }
  const stateOf = (ws: string, id: number) => ({ ...(store.workspaceDb(ws).reader.prepare('SELECT state, attempts FROM card_actions WHERE id = ?').get(id) as { state: string; attempts: number }) })
  /** What the notices told so far, as one text (their titles and lines). */
  const toldText = (st: { notices: unknown[] }) => JSON.stringify(st.notices)

  it('HI-2431: a late notice from another workspace is not counted for the current project', async () => {
    const first = await open()
    const one = await newCard(first.w)
    const second = await open()
    const two = await newCard(second.w)
    await settled()
    const st = fake(second.alpha)
    // Earlier tests' workspaces stay open: their actions can finish after fake() changes the session stand-in.
    noticeAction(first.ws, one, 'notify', { text: 'Earlier workspace' })
    noticeAction(second.ws, two, 'notify', { text: 'Current project' })
    await Promise.all([worker.runActions(first.w), worker.runActions(second.w)])
    expect(st.notices).toHaveLength(1)
    expect(toldText(st)).toContain('Current project')
    expect(toldText(st)).not.toContain('Earlier workspace')
  })

  it('a notify action is shown once, however often the actions run at once', async () => {
    const { w, ws, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    const id = noticeAction(ws, c, 'notify', { text: 'alpha-1 waits for your review' })
    await Promise.all([worker.runActions(w), worker.runActions(w)])
    await worker.runActions(w)
    expect(st.notices).toHaveLength(1)
    expect(toldText(st)).toContain('waits for your review')
    expect(stateOf(ws, id)).toEqual({ state: 'done', attempts: 1 })
  })

  it('a notice is never lost to a crash between its try and its mark: tried once more on reopen, and never a third time', async () => {
    const { w, ws, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    // Its try counted, then Combwork ended (or the workspace closed) before it was marked, perhaps before it was shown.
    const once = noticeAction(ws, c, 'notify', { text: 'tried once' }, 1)
    // Tried twice already: it may have been shown twice; never a third time.
    const twice = noticeAction(ws, c, 'notify', { text: 'tried twice' }, 2)
    await worker.runActions(w)
    expect(st.notices).toHaveLength(1)
    expect(toldText(st)).toContain('tried once')
    expect(stateOf(ws, once)).toEqual({ state: 'done', attempts: 2 })
    expect(stateOf(ws, twice)).toEqual({ state: 'done', attempts: 2 })
  })

  it("a notify action with Combwork's own message (#1264) shows it in the language shown, its English kept beside it", async () => {
    const { w, ws, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    noticeAction(ws, c, 'notify', { text: 'AL-9 is approved: OK to merge?', shown: { id: 'workflow.forYou.okBefore', values: { card: 'AL-9' } } })
    await worker.runActions(w)
    expect(st.notices).toHaveLength(1)
    expect(JSON.stringify(st.notices[0].body)).toContain('"shown":"AL-9 is approved: OK to merge?"')
    expect(JSON.stringify(st.notices[0].body)).toContain('"agent":"AL-9 is approved: OK to merge?"')
  })

  it("a lane's failed review, a card blocked and its merge due are told; a lane already running starts from now; nothing new tells nothing", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    const c = await inReview(w)
    await notices.checkLanesNow(w)
    await settled()
    // Already running when Combwork began following it: nothing of before is told.
    expect(st.notices).toEqual([])
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, r1, { comment: 'FAILED' }))
    await inWorkspace(w, () => tasks.updateTask(c, { blocked: 'Waiting for the API key' }, b1))
    await vi.waitFor(async () => {
      await notices.checkLanesNow(w)
      await worker.actionsSettled()
      expect(toldText(st)).toContain('Waiting for the API key')
    }, HANG)
    expect(toldText(st)).toContain('B1 / R1')
    expect(toldText(st)).toContain('failed review')
    const told = st.notices.length
    // Each event once: looking again tells nothing.
    await notices.checkLanesNow(w)
    await settled()
    expect(st.notices).toHaveLength(told)
    // Its merge due: every card passed.
    await inWorkspace(w, () => tasks.updateTask(c, { blocked: '' }, b1))
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'passed', column: 'passed' }, r1, { comment: 'PASSED' }))
    await vi.waitFor(async () => {
      await notices.checkLanesNow(w)
      await worker.actionsSettled()
      expect(JSON.stringify(st.notices.slice(told))).toContain('its merge is due')
    }, HANG)
  })

  it('#1631: a failed round in a lane started since is told once, also once the lane has ended and after a reload', async () => {
    const { w, ws, alpha } = await open()
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    const db = () => store.workspaceDb(ws).reader
    const failedNotices = () => (db().prepare("SELECT count(*) AS n FROM card_actions WHERE kind = 'laneNotice' AND payload LIKE '%\"failed\"%'").get() as { n: number }).n
    // Combwork follows the board's lanes from its first look; the lane starts after it (as HI-1626's did on rc.1).
    await notices.checkLanesNow(w)
    const since = Date.parse((db().prepare("SELECT value FROM board_meta WHERE key = 'lane_notices_since'").get() as { value: string }).value)
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(since), HANG)
    const c = await inReview(w)
    await notices.checkLanesNow(w)
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, r1, { comment: 'FAILED' }))
    await vi.waitFor(async () => {
      await notices.checkLanesNow(w)
      await worker.actionsSettled()
      expect(toldText(st)).toContain('failed review')
    }, HANG)
    const lane = (await lanes.listLanes(w, { all: true })).find((l) => l.cards.some((x) => x.number === c))!
    await lanes.endLane(w, lane.id, { abandoned: true })
    // Each look writes nothing more: no notice, no history line (whose change would start the next look).
    for (let i = 0; i < 3; i++) await notices.checkLanesNow(w)
    await settled()
    expect(failedNotices()).toBe(1)
    expect(st.notices).toHaveLength(1)
    await disposeWorkspaceService(w)
    const again = createWorkspaceService()
    await again.open(ws)
    opened.push(again)
    await notices.checkLanesNow(again)
    await worker.runActions(again)
    expect(failedNotices()).toBe(1)
    expect(st.notices).toHaveLength(1)
  })

  it("#1645: a card's events name the running lane that holds it, never an abandoned lane that once listed it", async () => {
    const agents = [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }, { id: 'b4', name: 'B4' }, { id: 'r4', name: 'R4' }]
    // Each way in a workspace of its own: the wrong lane abandoned before the round (seen by a look in between), or still
    // running when the right one starts and abandoned in the same look as the failure.
    for (const between of [true, false]) {
      const { w, ws, alpha } = await open({ agents })
      const st = fake(alpha, { b1: 'working', r1: 'working', b4: 'working', r4: 'working' })
      const db = () => store.workspaceDb(ws).reader
      await notices.checkLanesNow(w)
      const since = Date.parse((db().prepare("SELECT value FROM board_meta WHERE key = 'lane_notices_since'").get() as { value: string }).value)
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(since), HANG)
      const lanesOf = async (c: number) => (await lanes.listLanes(w, { all: true })).filter((l) => l.cards.some((x) => x.number === c))
      const c = await newCard(w)
      const wrong = (await lanes.startLane(w, { project: 'alpha', builder: 'b4', reviewer: 'r4', cards: [c], by: 'Assistant', name: 'Narrow card chips' })).lane
      await notices.checkLanesNow(w)
      if (between) {
        await lanes.endLane(w, wrong.id, { abandoned: true })
        await notices.checkLanesNow(w)
      }
      await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)', name: 'WAL checkpoint' })
      await notices.checkLanesNow(w)
      await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
      await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
      await notices.checkLanesNow(w)
      if (!between) await lanes.endLane(w, wrong.id, { abandoned: true })
      const told = st.notices.length
      await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, r1, { comment: 'FAILED' }))
      await vi.waitFor(async () => {
        await notices.checkLanesNow(w)
        await worker.actionsSettled()
        expect(JSON.stringify(st.notices.slice(told))).toContain('failed review')
      }, HANG)
      await settled()
      const shown = JSON.stringify(st.notices.slice(told))
      expect(shown, `between: ${between}`).toContain('B1 / R1 (WAL checkpoint)')
      expect(shown, `between: ${between}`).not.toContain('Narrow card chips')
      // The card's history names the running lane too.
      const card = await inWorkspace(w, () => tasks.getTask(c, w))
      expect(JSON.stringify(card.history.filter((h) => /failed/i.test(JSON.stringify(h))))).not.toContain('Narrow card chips')
      expect((await lanesOf(c)).map((l) => l.state).sort()).toEqual(['abandoned', 'active'])
      // Closed with its test (HI-1946): its failed card is back in Doing, its builder's, and a later test's stand-in
      // sessions don't run that builder, so the lane's next look would tell its card stalled in that test.
      await disposeWorkspaceService(w)
    }
  })

  it('an event before a restart is told after it: what lanes were told is kept with the board, not in memory', async () => {
    const { w, ws, alpha } = await open()
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    const c = await inReview(w)
    await notices.checkLanesNow(w)
    await settled()
    // The failure commits, and Combwork stops before it looked at the lanes again.
    notices.noticeTestHooks.hold = true
    try {
      await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, r1, { comment: 'FAILED' }))
      await settled()
      expect(st.notices).toEqual([])
      await disposeWorkspaceService(w)
    } finally {
      notices.noticeTestHooks.hold = false
    }
    const again = createWorkspaceService()
    await again.open(ws)
    opened.push(again)
    await notices.checkLanesNow(again)
    await vi.waitFor(async () => {
      await worker.runActions(again)
      expect(toldText(st)).toContain('failed review')
    }, HANG)
    expect(st.notices).toHaveLength(1)
  })

  it('two followers of one board (two Hives) tell an event once', async () => {
    const { w, ws, alpha } = await open()
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    const c = await inReview(w)
    await notices.checkLanesNow(w)
    await settled()
    notices.noticeTestHooks.hold = true
    try {
      await inWorkspace(w, () => tasks.updateTask(c, { blocked: 'Which greeting?' }, b1))
      // Two looks at once, each reading the marks before either writes (as two Hives would; Combwork opens a workspace once
      // per process): the second's board change finds the marks the first moved on.
      await Promise.all([notices.checkLanesNow(w), notices.checkLanesNow(w)])
    } finally {
      notices.noticeTestHooks.hold = false
    }
    await settled()
    const written = store.workspaceDb(ws).reader.prepare("SELECT count(*) AS n FROM card_actions WHERE kind = 'laneNotice'").get() as { n: number }
    expect(written.n).toBe(1)
    expect(st.notices).toHaveLength(1)
  })

  it("the project's loop wakes off: no lane notice and no request notice", async () => {
    const { w, ws, alpha } = await open({ loopWakes: false })
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    const c = await inReview(w)
    await notices.checkLanesNow(w)
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, r1, { comment: 'FAILED' }))
    await notices.checkLanesNow(w)
    noticeAction(ws, c, 'notify', { text: 'needs you' })
    await worker.runActions(w)
    await settled()
    expect(st.notices).toEqual([])
    // Its lane's marks still moved on: turned on again, what happened while off isn't told then.
    expect((store.workspaceDb(ws).reader.prepare('SELECT failed FROM lane_notice_cards WHERE card = ?').get(c) as { failed: string }).failed).not.toBe('')
  })

  it('workflow rules not enforced: notices still come (they are no gate)', async () => {
    await advanced.set(ENFORCE, false)
    const { w, ws, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    noticeAction(ws, c, 'notify', { text: 'needs you, rules off' })
    await worker.runActions(w)
    expect(toldText(st)).toContain('needs you, rules off')
  })
})

/**
 * The actions worker as another Combwork runs it: the same code, a module of its own (its runs, handlers and lease owner),
 * copied into a temp folder with its imports pointing at this tree's modules, run only when the test asks (as HR1's
 * #1266 probe did).
 */
async function anotherWorker(): Promise<typeof worker> {
  const src = join(__dirname, '..', 'src', 'main', 'workflow')
  const abs = (rel: string): string => join(src, rel).replace(/\\/g, '/')
  const code = readFileSync(join(src, 'actionWorker.ts'), 'utf8')
    .replace(/from '(\.\.?\/[^']+)'/g, (_m, rel: string) => `from '${abs(rel)}'`)
    // Runs only when the test asks: no subscription of its own to the board's commits, which would outlive the test.
    .replace(/\nonBoardCommitted\(\(ws\) => \{[\s\S]*$/, '\n')
  const file = join(tempDir('hive-another-worker-'), 'actionWorker.ts')
  writeFileSync(file, code)
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as typeof worker
}

// HR1's round 2 probes (#1266): three races between writers, each a regression test.
describe('writers at once (#1266 round 3)', () => {
  /** A connection of another process's to the workspace's database (another Combwork). */
  async function outside<T>(ws: string, fn: (db: import('node:sqlite').DatabaseSync) => T): Promise<T> {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(store.boardFile(ws))
    try {
      return fn(db)
    } finally {
      db.close()
    }
  }

  it("another Combwork's receipt of a delivery this one holds survives this one's next, unrelated save", async () => {
    const { w, ws, alpha } = await open()
    fake(alpha, { b1: 'working', r1: 'working' })
    await inReview(w)
    await settled()
    const own = await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: { kind: 'combwork', name: 'Combwork' }, body: 'action wake', action: 99999 })
    const at = new Date().toISOString()
    await outside(ws, (db) => db.prepare("UPDATE deliveries SET state = 'received', received = ?, received_via = 'inbox' WHERE id = ?").run(at, own.id))
    await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: { kind: 'combwork', name: 'Combwork' }, body: 'unrelated local' })
    expect({ ...(store.workspaceDb(ws).reader.prepare('SELECT state, received FROM deliveries WHERE action = 99999').get() as object) }).toEqual({ state: 'received', received: at })
  })

  it("an overlapping change is planned again on the other Combwork's: a cancel of a delivery it received meanwhile cancels nothing", async () => {
    const { w, ws, alpha } = await open()
    fake(alpha, { b1: 'working', r1: 'working' })
    await inReview(w)
    await settled()
    const own = await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: { kind: 'combwork', name: 'Combwork' }, body: 'received elsewhere' })
    await outside(ws, (db) => db.prepare("UPDATE deliveries SET state = 'received', received = ?, received_via = 'inbox' WHERE id = ?").run(new Date().toISOString(), own.id))
    // Cancelling: from what this one read (queued), it would cancel it; read again, it was received, and isn't.
    expect(await deliveries.cancelDeliveries(alpha, 'b1', 'a test')).toBe(0)
    expect((store.workspaceDb(ws).reader.prepare('SELECT state FROM deliveries WHERE id = ?').get(own.id) as { state: string }).state).toBe('received')
  })

  it('two independent workers (two Hives) never run a repeatable action at once; one whose Combwork ended runs once its lease passes', async () => {
    const { w, ws } = await open()
    const c = await newCard(w)
    await settled()
    const second = await anotherWorker()
    let ran = 0
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const fn: Parameters<typeof worker.onAction>[1] = async (_a, _w, ctx) => {
      if (!(await ctx.dispatch(() => ran++))) return
      await held
    }
    worker.onAction('probeNotice', fn, 'repeatable')
    second.onAction('probeNotice', fn, 'repeatable')
    const own = FactStore.open(store.boardFile(ws), { project: 'alpha', key: 'alpha' })
    const id = own.tx((tx) => tx.action(c, 'probeNotice', {}, null))
    own.close()
    try {
      const first = worker.runActions(w)
      await vi.waitFor(() => expect(ran).toBe(1), HANG)
      // The other Combwork finds it leased, and leaves it.
      await second.runActions(w)
      expect(ran).toBe(1)
      release()
      await first
      expect({ ...(store.workspaceDb(ws).reader.prepare('SELECT state, attempts, lease_owner FROM card_actions WHERE id = ?').get(id) as object) }).toEqual({ state: 'done', attempts: 1, lease_owner: null })
      // A Combwork that took one and ended before its effect (its lease left, no dispatch counted): run once the lease has passed.
      const own2 = FactStore.open(store.boardFile(ws), { project: 'alpha', key: 'alpha' })
      const left = own2.tx((tx) => tx.action(c, 'probeNotice', {}, null))
      own2.close()
      store.workspaceDb(ws).writer.prepare("UPDATE card_actions SET lease_owner = 'a-hive-that-ended', lease_until = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), left)
      await second.runActions(w)
      expect(ran).toBe(2)
      expect({ ...(store.workspaceDb(ws).reader.prepare('SELECT state, attempts FROM card_actions WHERE id = ?').get(left) as object) }).toEqual({ state: 'done', attempts: 1 })
    } finally {
      release()
      // The other Combwork's handlers go; this one's `probeNotice` stays (no other test writes one), its notices' and wakes' too.
      second.clearActionHandlers()
    }
  })

  it("a lane notice's older read never moves its marks back: one blocked event is told once", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    const c = await inReview(w)
    await settled()
    await notices.checkLanesNow(w)
    await settled()
    st.notices.length = 0
    notices.noticeTestHooks.hold = true
    let captured = false
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const real = watches.lanesNowIn
    const spy = vi.spyOn(watches, 'lanesNowIn').mockImplementationOnce(async (...args) => {
      const snapshot = await real(...args)
      captured = true
      await held
      return snapshot
    })
    let older: Promise<void> | undefined
    try {
      // A look reads the lanes (the card not blocked yet) and is held; the card is blocked, and another look tells it.
      older = notices.checkLanesNow(w)
      await vi.waitFor(() => expect(captured).toBe(true), HANG)
      await inWorkspace(w, () => tasks.updateTask(c, { blocked: 'Need a decision' }, b1))
      await notices.checkLanesNow(w)
      await settled()
      expect(st.notices).toHaveLength(1)
      // The older look goes on: its read is stale, so it reads again and finds nothing new.
      release()
      await older
      await notices.checkLanesNow(w)
      await settled()
      expect(st.notices).toHaveLength(1)
    } finally {
      release()
      await older
      spy.mockRestore()
      notices.noticeTestHooks.hold = false
    }
  })
})

// HR1's round 3 probes (#1266): the boundaries of the same three invariants, each a regression test.
describe('boundaries (#1266 round 4)', () => {
  it('a lease that expired before its dispatch shows nothing and leaves the action pending, never done; it runs again and shows it', async () => {
    const { w, ws } = await open()
    const c = await newCard(w)
    await settled()
    let shown = 0
    let expire = true
    worker.onAction(
      'probeExpired',
      async (a, _w, ctx) => {
        // The handler took longer than its lease (suspended, slow IO): it has expired by its dispatch.
        if (expire) store.workspaceDb(ws).writer.prepare('UPDATE card_actions SET lease_until = ? WHERE id = ?').run(new Date(Date.now() - 1).toISOString(), a.id)
        await ctx.dispatch(() => shown++)
      },
      'repeatable'
    )
    const own = FactStore.open(store.boardFile(ws), { project: 'alpha', key: 'alpha' })
    const id = own.tx((tx) => tx.action(c, 'probeExpired', {}, null))
    own.close()
    await worker.runActions(w)
    expect(shown).toBe(0)
    expect({ ...(store.workspaceDb(ws).reader.prepare('SELECT state, attempts, lease_owner FROM card_actions WHERE id = ?').get(id) as object) }).toEqual({ state: 'pending', attempts: 0, lease_owner: null })
    // Its next run (a retry, or the next change) shows it, once.
    expire = false
    await vi.waitFor(async () => {
      await worker.runActions(w)
      expect(shown).toBe(1)
    }, HANG)
    expect({ ...(store.workspaceDb(ws).reader.prepare('SELECT state, attempts FROM card_actions WHERE id = ?').get(id) as object) }).toEqual({ state: 'done', attempts: 1 })
  })

  it('a lease is renewed while its handler runs: a handler slower than the lease still dispatches, and no other claim takes it meanwhile', async () => {
    const { w, ws } = await open()
    const c = await newCard(w)
    await settled()
    worker.setLeaseMsForTests(300)
    let shown = 0
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let entered = false
    worker.onAction(
      'probeSlow',
      async (_a, _w, ctx) => {
        entered = true
        await held
        await ctx.dispatch(() => shown++)
      },
      'repeatable'
    )
    const own = FactStore.open(store.boardFile(ws), { project: 'alpha', key: 'alpha' })
    const id = own.tx((tx) => tx.action(c, 'probeSlow', {}, null))
    own.close()
    const leaseOf = () => ({ ...(store.workspaceDb(ws).reader.prepare('SELECT lease_owner, lease_until FROM card_actions WHERE id = ?').get(id) as { lease_owner: string; lease_until: string }) })
    try {
      const run = worker.runActions(w)
      await vi.waitFor(() => expect(entered).toBe(true), HANG)
      const first = leaseOf()
      // Renewed past its first expiry while the handler waits.
      await vi.waitFor(() => expect(Date.parse(leaseOf().lease_until)).toBeGreaterThan(Date.parse(first.lease_until) + 300), HANG)
      expect(leaseOf().lease_owner).toBe(first.lease_owner)
      release()
      await run
      expect(shown).toBe(1)
      expect({ ...(store.workspaceDb(ws).reader.prepare('SELECT state, attempts FROM card_actions WHERE id = ?').get(id) as object) }).toEqual({ state: 'done', attempts: 1 })
    } finally {
      release()
      worker.setLeaseMsForTests(null)
    }
  })

  it("a delivery's record and the base a save checks it against are one read's: another Combwork's receipt just after the read is kept", async () => {
    const { w, ws, alpha } = await open()
    fake(alpha, { b1: 'working', r1: 'working' })
    await inReview(w)
    await settled()
    const own = await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: { kind: 'combwork', name: 'Combwork' }, body: 'received right after the read' })
    await deliveries.forgetDeliveriesForTests()
    const tables = await import('../src/main/schema/sessionDeliveryTables')
    const real = tables.readDeliveriesWithBases
    let injected = false
    const spy = vi.spyOn(tables, 'readDeliveriesWithBases').mockImplementationOnce((db, host) => {
      const read = real(db, host)
      // Another Combwork receives it the moment after this one read the rows.
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
      const outside = new DatabaseSync(store.boardFile(ws))
      try {
        outside.prepare("UPDATE deliveries SET state = 'received', received = ?, received_via = 'inbox' WHERE id = ?").run(new Date().toISOString(), own.id)
      } finally {
        outside.close()
      }
      injected = true
      return read
    })
    try {
      await deliveries.load(alpha)
      expect(injected).toBe(true)
      expect(await deliveries.cancelDeliveries(alpha, 'b1', 'a test')).toBe(0)
      expect((store.workspaceDb(ws).reader.prepare('SELECT state FROM deliveries WHERE id = ?').get(own.id) as { state: string }).state).toBe('received')
    } finally {
      spy.mockRestore()
    }
  })

  it("an unrelated card's future timestamp can't hide a lane card's change: the board's revision isn't a clock", async () => {
    const { w, ws, alpha } = await open()
    notices.noticeTestHooks.hold = true
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    const c = await inReview(w)
    const other = await newCard(w)
    await settled()
    await notices.checkLanesNow(w)
    await settled()
    // A stored time after the clock (the machine's clock corrected backwards, say).
    store.workspaceDb(ws).writer.prepare('UPDATE cards SET updated_at = ? WHERE number = ?').run('2099-01-01T00:00:00.000Z', other)
    let captured = false
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const real = watches.lanesNowIn
    const spy = vi.spyOn(watches, 'lanesNowIn').mockImplementationOnce(async (...args) => {
      const snapshot = await real(...args)
      captured = true
      await held
      return snapshot
    })
    let older: Promise<void> | undefined
    try {
      older = notices.checkLanesNow(w)
      await vi.waitFor(() => expect(captured).toBe(true), HANG)
      await inWorkspace(w, () => tasks.updateTask(c, { blocked: 'Read the board as it is' }, b1))
      release()
      await older
      await settled()
      // The look read again: the card's mark is blocked, and it was told.
      expect((store.workspaceDb(ws).reader.prepare('SELECT blocked FROM lane_notice_cards WHERE card = ?').get(c) as { blocked: number }).blocked).toBe(1)
      expect(JSON.stringify(st.notices)).toContain('Read the board as it is')
    } finally {
      release()
      await older
      spy.mockRestore()
      notices.noticeTestHooks.hold = false
    }
  })
})

// HR1's round 4 (#1266): two workspaces' actions with one id are two actions; and the durable notice, a translated
// line in its card's history, written with the action.
describe('workspaces apart, and the durable notice (#1266 round 5)', () => {
  /** A repeatable action of a kind, written as another Combwork's change would (pending). */
  const add = (ws: string, c: number, kind: string, payload: Record<string, unknown> = {}): number => {
    const own = FactStore.open(store.boardFile(ws), { project: 'alpha', key: 'alpha' })
    try {
      return own.tx((tx) => tx.action(c, kind, payload, null))
    } finally {
      own.close()
    }
  }
  /** A card's history lines that are notices (HISTORY.notified), as their values. */
  const notesOn = async (w: WS, c: number) => (await inWorkspace(w, () => tasks.getTask(c, w))).history.filter((h) => h.whatText?.id === 'tasks.history.notified').map((h) => h.whatText!.values)

  it('equal action ids in two open workspaces: one held in the first never holds up the second', async () => {
    const first = await open()
    const second = await open()
    const one = await newCard(first.w)
    const two = await newCard(second.w)
    await settled()
    let entered = false
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const ran: string[] = []
    worker.onAction(
      'probeTwoWorkspaces',
      async (_a, w, ctx) => {
        if (w === first.w) {
          entered = true
          await held
        }
        await ctx.dispatch(() => ran.push(w.path!))
      },
      'repeatable'
    )
    expect(add(first.ws, one, 'probeTwoWorkspaces')).toBe(add(second.ws, two, 'probeTwoWorkspaces'))
    const run = worker.runActions(first.w)
    try {
      await vi.waitFor(() => expect(entered).toBe(true), HANG)
      await worker.runActions(second.w)
      expect(ran).toEqual([second.ws])
    } finally {
      release()
      await run
    }
    expect(ran).toEqual([second.ws, first.ws])
  })

  it("one workspace's refused dispatch doesn't make the other's action with its id wait", async () => {
    const first = await open()
    const second = await open()
    const one = await newCard(first.w)
    const two = await newCard(second.w)
    await settled()
    const ran: string[] = []
    worker.onAction(
      'probeCooling',
      async (a, w, ctx) => {
        // The first's lease expires before its dispatch: refused, and it waits a moment before it is taken again.
        if (w === first.w) store.workspaceDb(first.ws).writer.prepare('UPDATE card_actions SET lease_until = ? WHERE id = ?').run(new Date(Date.now() - 1).toISOString(), a.id)
        await ctx.dispatch(() => ran.push(w.path!))
      },
      'repeatable'
    )
    expect(add(first.ws, one, 'probeCooling')).toBe(add(second.ws, two, 'probeCooling'))
    await worker.runActions(first.w)
    expect(ran).toEqual([])
    await worker.runActions(second.w)
    expect(ran).toEqual([second.ws])
  })

  it("a lane notice is a line in its card's history, written with it: kept after a restart, its event long resolved", async () => {
    const { w, ws, alpha } = await open()
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    const c = await inReview(w)
    await settled()
    await notices.checkLanesNow(w)
    await settled()
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, r1, { comment: 'FAILED' }))
    await vi.waitFor(async () => {
      await notices.checkLanesNow(w)
      await worker.actionsSettled()
      expect(await notesOn(w, c)).toEqual([{ event: 'failed', lane: 'B1 / R1', hasWhy: 'no', why: '' }])
    }, HANG)
    // In the card's history in the user's language, said by Combwork.
    const line = (await inWorkspace(w, () => tasks.getTask(c, w))).history.find((h) => h.whatText?.id === 'tasks.history.notified')!
    expect(line).toMatchObject({ by: 'Combwork', what: 'Notified you that its review failed' })
    // The failure resolved since (fixed, passed), and Combwork restarted: the notice is still on the card, once.
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'passed', column: 'passed' }, r1, { comment: 'PASSED' }))
    await settled()
    await disposeWorkspaceService(w)
    const again = createWorkspaceService()
    await again.open(ws)
    opened.push(again)
    expect((await notesOn(again, c)).filter((v) => v?.event === 'failed')).toHaveLength(1)
    expect(st.notices.length).toBeGreaterThan(0)
  })

  it('an uncertain dispatch (a crash after it was counted) shows the toast once more at most, its history line once', async () => {
    const { w, ws, alpha } = await open()
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    const c = await inReview(w)
    await settled()
    await notices.checkLanesNow(w)
    await settled()
    notices.noticeTestHooks.hold = true
    try {
      await inWorkspace(w, () => tasks.updateTask(c, { blocked: 'Which greeting?' }, b1))
      await notices.checkLanesNow(w)
      await settled()
    } finally {
      notices.noticeTestHooks.hold = false
    }
    const shown = st.notices.length
    expect(shown).toBe(1)
    // Its dispatch counted, then Combwork ended before its mark: pending again, one try left.
    const id = (store.workspaceDb(ws).reader.prepare("SELECT max(id) AS id FROM card_actions WHERE kind = 'laneNotice'").get() as { id: number }).id
    store.workspaceDb(ws).writer.prepare("UPDATE card_actions SET state = 'pending', attempts = 1, lease_owner = NULL, lease_until = NULL WHERE id = ?").run(id)
    await worker.runActions(w)
    await worker.runActions(w)
    expect(st.notices).toHaveLength(2)
    expect({ ...(store.workspaceDb(ws).reader.prepare('SELECT state, attempts FROM card_actions WHERE id = ?').get(id) as object) }).toEqual({ state: 'done', attempts: 2 })
    expect(await notesOn(w, c)).toEqual([{ event: 'blocked', lane: 'B1 / R1', hasWhy: 'yes', why: 'Which greeting?' }])
  })

  it("a request the runtime writes for the user is noted on its card in the same change (a history line before any toast)", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    const c = await newCard(w)
    await settled()
    const { workflowFor } = await import('../src/main/workflow/service')
    const wf = (await workflowFor(w, alpha))!
    expect(wf).toBeTruthy()
    const before = st.notices.length
    const reply = await wf.askTheUser(c, 'user', { kind: 'decide', text: 'Which greeting?' })
    expect(reply).toMatchObject({ ok: true })
    await settled()
    expect(await notesOn(w, c)).toEqual([{ event: 'request', lane: '', hasWhy: 'yes', why: 'Which greeting?' }])
    expect(st.notices.length).toBe(before + 1)
  })

  it("a request's question is in its history line, kept after a restart (HR1's round 5 probe)", async () => {
    const { w, ws, alpha } = await open()
    fake(alpha, { b1: 'working', r1: 'working' })
    const c = await newCard(w)
    await settled()
    const { workflowFor } = await import('../src/main/workflow/service')
    await (await workflowFor(w, alpha))!.askTheUser(c, 'user', { kind: 'decide', text: 'Which greeting should the offline installer show?' })
    await settled()
    await disposeWorkspaceService(w)
    const again = createWorkspaceService()
    await again.open(ws)
    opened.push(again)
    const line = (await inWorkspace(again, () => tasks.getTask(c, again))).history.find((h) => h.whatText?.id === 'tasks.history.notified')!
    expect(line.what).toBe('Notified you that it needs you: Which greeting should the offline installer show?')
  })

  it("Combwork's own request (its message, #1264) is kept as that message within the line, shown in the window's language", async () => {
    const { w, alpha } = await open()
    fake(alpha, { b1: 'working', r1: 'working' })
    const c = await newCard(w)
    await settled()
    const { lastActionId, noteRequestsSince } = await import('../src/main/workflowNotices')
    // As the runtime's askUser writes one of its own requests: its English and its message.
    await store.boardWrite(w, async () => {
      const after = lastActionId(w)
      FactStore.forBoard(w, { project: 'alpha', key: 'alpha' }).tx((tx) => tx.action(c, 'notify', { text: 'AL-1 is approved: OK to merge?', shown: { id: 'workflow.forYou.okBefore', values: { card: 'AL-1' } } }, null))
      await noteRequestsSince(w, after)
    })
    const line = (await inWorkspace(w, () => tasks.getTask(c, w))).history.find((h) => h.whatText?.id === 'tasks.history.notified')!
    expect(line.whatText!.values!.why).toEqual({ id: 'workflow.forYou.okBefore', values: { card: 'AL-1' } })
    expect(line.what).toBe('Notified you that it needs you: AL-1 is approved: OK to merge?')
  })

  it("a card's slot notices (a preparation that failed, a placement waiting or giving up) are lines in its history, in English and in German (HI-1796)", async () => {
    const { w, alpha } = await open()
    fake(alpha, { b1: 'working', r1: 'working' })
    const c = await newCard(w)
    await settled()
    const { lastActionId, noteRequestsSince } = await import('../src/main/workflowNotices')
    const { SLOT_NOTICES, workflowText } = await import('../src/shared/workflow/texts')
    const { setLanguage } = await import('../src/shared/i18n')
    // As slotCards.ts writes them (prepare's failure, place's waits): the notify action's English and its message.
    const written = [
      workflowText(SLOT_NOTICES.notPrepared, { slot: 'slot-a', card: 'AL-1', why: 'git checkout failed (test)' }),
      workflowText(SLOT_NOTICES.resumeHeld, { card: 'AL-1', agent: 'B1', slot: 'slot-a', why: 'its slot holds other work now' }),
      workflowText(SLOT_NOTICES.resumeFailed, { card: 'AL-1', agent: 'B1', slot: 'slot-a', why: "its CLI couldn't start (test)" })
    ]
    for (const shown of written) {
      await store.boardWrite(w, async () => {
        const after = lastActionId(w)
        FactStore.forBoard(w, { project: 'alpha', key: 'alpha' }).tx((tx) => tx.action(c, 'notify', { text: 'the English (test)', shown }, null))
        await noteRequestsSince(w, after)
      })
    }
    const lines = async () => (await inWorkspace(w, () => tasks.getTask(c, w))).history.filter((h) => h.whatText?.id === 'tasks.history.notified')
    expect((await lines()).map((l) => l.whatText!.values!.why)).toEqual(written)
    expect((await lines()).map((l) => l.what)).toEqual([
      "Notified you that it needs you: Combwork couldn't get slot-a ready for AL-1: git checkout failed (test)",
      "Notified you that it needs you: Combwork can't give AL-1 to B1 yet: B1's conversation in slot-a can't resume now (its slot holds other work now). Combwork gives it AL-1 once it can.",
      "Notified you that it needs you: Combwork couldn't resume B1's conversation in slot-a for AL-1 (three tries): its CLI couldn't start (test). Resume B1 from Sessions, or start it fresh, and Combwork gives it AL-1."
    ])
    // Shown in the window's language, as its history shows a line (Board.tsx's storedLine): German, from its catalogue.
    const { storedLineText } = await import('../src/shared/taskHistory')
    const { tr } = await import('../src/shared/i18n')
    const { providerMessage } = await import('../src/shared/providers')
    const { workflowMessage } = await import('../src/shared/workflow/texts')
    const de = join(__dirname, '..', 'locales', 'de')
    const { readdirSync } = await import('fs')
    setLanguage('de', Object.assign({}, ...readdirSync(de).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(de, f), 'utf8')))))
    try {
      const german = (await lines()).map((l) => storedLineText(l.whatText, (m, values) => tr(m, values), (id) => providerMessage(id) ?? workflowMessage(id)))
      expect(german[0]).toContain('Combwork konnte slot-a nicht für AL-1 vorbereiten: git checkout failed (test)')
      expect(german[1]).toContain('Combwork kann B1 die Karte AL-1 noch nicht geben')
      expect(german[2]).toContain('Combwork konnte die Unterhaltung von B1 in slot-a für AL-1 nicht fortsetzen (drei Versuche)')
    } finally {
      setLanguage('en', {})
    }
  })

  it("a stall's detail is in its history line, kept after the stall has cleared and a restart", async () => {
    const { w, ws, alpha } = await open()
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    const c = await inReview(w)
    await settled()
    await notices.checkLanesNow(w)
    await settled()
    // The card stalls (a session's state, which the board doesn't keep): the lanes as read say so, with why.
    const real = watches.lanesNowIn
    const why = "R1 is watching it but hasn't started reviewing it: in Review for 40 min"
    const spy = vi.spyOn(watches, 'lanesNowIn').mockImplementation(async (...args) =>
      (await real(...args)).map((l) => ({ ...l, mark: { ...l.mark, cards: { ...l.mark.cards, [c]: { ...l.mark.cards[c], s: true } } }, cards: l.cards.map((x) => (x.number === c ? { ...x, stalled: why } : x)) }))
    )
    try {
      await notices.checkLanesNow(w)
      await settled()
    } finally {
      spy.mockRestore()
    }
    expect(JSON.stringify(st.notices)).toContain('has stalled')
    // The stall clears (the next look reads it as it is), and Combwork restarts: the line is still on the card.
    await notices.checkLanesNow(w)
    await settled()
    await disposeWorkspaceService(w)
    const again = createWorkspaceService()
    await again.open(ws)
    opened.push(again)
    const lines = (await inWorkspace(again, () => tasks.getTask(c, again))).history.filter((h) => h.whatText?.id === 'tasks.history.notified').map((h) => h.what)
    expect(lines).toEqual([`Notified you that it has stalled: ${why}`])
  })
})

describe("a lane builder whose watch a decision's notice ended, and that ends its turn without another (HI-1693)", () => {
  it("isn't flagged as not watching; the reviewer's verdict reaches it through its loop wake, and only then, its move again, is it flagged when it sits idle", async () => {
    process.env.CW_TEST_LOOP_GRACE_MS = '0'
    const loopCheck = await import('../src/main/loopCheck')
    const { emit } = await import('../src/main/events')
    loopCheck.initLoopCheck()
    const { w, alpha } = await open({ workflow: { platform: 'none', preset: null, options: { ...allOff('none'), review: 'agent', noSelfReview: true } } })
    const c = (await inWorkspace(w, () => tasks.createTask({ title: 'Work', project: 'alpha' }, user))).number
    await store.boardWrite(w, async () => void FactStore.forBoard(w, { project: 'alpha', key: 'alpha' }).updateCard(c, { kind: 'no-code' }))
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    const act = (who: typeof b1 | typeof r1, intent: Parameters<typeof runCardIntent>[2]) => inWorkspace(w, () => runCardIntent({ n: c, plain: false }, who, intent))
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    // What loopCheck reads and marks of each session: its status (the stand-in's), no watch of its own, its stalled cards.
    const marked = new Map<string, number[] | null>()
    const told: number[][] = []
    const liveFor = sessions.liveFor.bind(sessions)
    Object.assign(sessions, {
      liveFor: (p: string, id: string) => {
        const s = liveFor(p, id) as Record<string, unknown> | null
        // As sessions.ts does: a mark lasts only while the agent is idle.
        if (s && s.status !== 'ready' && s.status !== 'finished') marked.delete(id)
        return s ? { ...s, provider: 'claude-code', notWatching: marked.get(id) ?? undefined } : null
      },
      setNotWatching: (_p: string, id: string, cards: number[] | null) => void marked.set(id, cards),
      notifyNotWatching: (_p: string, _id: string, cards: number[]) => void told.push(cards)
    })
    /** Its turn ends: idle with no watch, as a session-status event says; then its own grace check has run. */
    const idleChecked = async (id: string) => {
      const from = loopCheck.loopChecksOf(alpha, id)
      st.status.set(id, 'finished')
      emit({ type: 'session-status', state: sessions.liveFor(alpha, id) as never })
      await vi.waitFor(() => expect(loopCheck.loopChecksOf(alpha, id)).toBeGreaterThan(from), HANG)
    }
    await act(b1, { kind: 'start' })
    await act(b1, { kind: 'submit', summary: 'Round 1 ready' })
    await act(r1, { kind: 'startReview' })
    await settled()
    st.typed.length = 0
    // HB5 on HI-1682: the builder watches for its verdict; the reviewer is at work.
    st.status.set('b1', 'watching')
    await watches.registerWatch(w, alpha, 'b1', readCondition({ cards: [c], changes: ['verdict', 'column', 'comment'], column: 'passed' }) as WatchCondition)
    // The user records a decision: its line ends the builder's watch, and it reads it.
    await inWorkspace(w, () => tasks.updateTask(c, { decision: 'Keep the old wording.' }, user))
    await watches.evaluateWatches(w)
    await vi.waitFor(async () => {
      await deliveries.offerAllForTests()
      expect(st.typed.filter((t) => t.agent === 'b1')).toHaveLength(1)
    }, HANG)
    expect(st.typed.find((t) => t.agent === 'b1')!.text).toMatch(/a new decision from the user.*Your card watch has ended/)
    // It ends its turn without a new watch: the verdict is the reviewer's to give, so it isn't flagged.
    await idleChecked('b1')
    expect(marked.get('b1') ?? null).toBeNull()
    expect(told).toEqual([])
    // The reviewer, idle a moment, reads the decision (a verdict needs it received), and fails the card.
    st.status.set('r1', 'ready')
    await vi.waitFor(async () => {
      await deliveries.offerAllForTests()
      await act(r1, { kind: 'verdict', pass: false, failKind: 'content', comment: 'Round 1: FAILED. 1. Fix it.' })
    }, HANG)
    // The verdict reaches the builder through its loop wake, read through its inbox: no watch needed.
    await vi.waitFor(async () => {
      await deliveries.offerAllForTests()
      expect(st.typed.filter((t) => t.agent === 'b1')).toHaveLength(2)
    }, HANG)
    expect(st.typed.filter((t) => t.agent === 'b1')[1].text).toMatch(new RegExp(`^\\[CW\\] #${c} is in Doing: R1 \\(alpha\\) failed it; latest comment by R1 \\(alpha\\): "Round 1: FAILED`))
    // Its move now: idle again with no watch, it is flagged, and the user told (in Combwork the grace lets the wake land
    // first; here, with none, a check can also flag it in the moment before it is typed).
    await idleChecked('b1')
    await vi.waitFor(() => expect(marked.get('b1')).toEqual([c]), HANG)
    expect(told.at(-1)).toEqual([c])
  })
})
