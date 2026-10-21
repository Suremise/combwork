// The durable actions' handlers (#1266, SPEC §16.4.5): wakes and notices from the runtime's facts, each delivered once
// through deliveries (the action's id on its delivery, unique), the loop's handoffs from the facts the board's changes
// record (no second path), a decision waking the loop's builder and reviewer (S5), a reviewer's request waking the
// builder at once (S23), a notice claimed before it is shown, and their off switches (the project's loop wakes; the
// workflow rules switch, which they don't answer to: they aren't gates).
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
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
  mkdirSync(join(alpha, '.hive'), { recursive: true })
  writeFileSync(join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], ...cfg }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, ws, alpha }
}

/** Stand-in sessions (as loopWakes.test's): each agent running in a status, and what each read from Hive's doorbell. */
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
    notice: (_p: string, title: unknown, body: unknown) => void state.notices.push({ title, body })
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
/** Writes a fact and a `wake` action for it, as the runtime does (its own connection: another Hive, or before a restart). */
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
    expect(st.typed.at(-1)!.text).toMatch(new RegExp(`^\\[Hive\\] #${c} is in Done.*This is your card in its loop: carry on`))
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
    await watches.registerWatch(w, alpha, 'b1', { cards: [c], changes: ['verdict', 'column'], column: 'passed' })
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
    expect(st.typed[0].text).toContain('Hive: "stale: submit again"')
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
  it('a notify action is claimed: shown once, however often the actions run', async () => {
    const { w, ws, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    const own = FactStore.open(store.boardFile(ws), { project: 'alpha', key: 'alpha' })
    own.tx((tx) => tx.action(c, 'notify', { text: 'alpha-1 waits for your review' }, null))
    own.close()
    await Promise.all([worker.runActions(w), worker.runActions(w)])
    await worker.runActions(w)
    expect(st.notices).toHaveLength(1)
    expect(JSON.stringify(st.notices[0])).toContain('waits for your review')
  })

  it("a notify action with Hive's own message (#1264) shows it in the language shown, its English kept beside it", async () => {
    const { w, ws, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    const own = FactStore.open(store.boardFile(ws), { project: 'alpha', key: 'alpha' })
    own.tx((tx) => tx.action(c, 'notify', { text: 'AL-9 is approved: OK to merge?', shown: { id: 'workflow.forYou.okBefore', values: { card: 'AL-9' } } }, null))
    own.close()
    await worker.runActions(w)
    expect(st.notices).toHaveLength(1)
    expect(JSON.stringify(st.notices[0].body)).toContain('"shown":"AL-9 is approved: OK to merge?"')
    expect(JSON.stringify(st.notices[0].body)).toContain('"english":"AL-9 is approved: OK to merge?"')
  })

  it("a lane's failed review, a card blocked and its merge due are told, one notice per lane at a time; a lane already running starts from now", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha, { b1: 'working', r1: 'working' })
    const c = await inReview(w)
    // Hive begins following: the lane, already running, from now.
    notices.forgetLaneNotices()
    await notices.checkLanesNow(w)
    st.notices.length = 0
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, r1, { comment: 'FAILED' }))
    await inWorkspace(w, () => tasks.updateTask(c, { blocked: 'Waiting for the API key' }, b1))
    await notices.checkLanesNow(w)
    expect(st.notices).toHaveLength(1)
    const told = JSON.stringify(st.notices[0])
    expect(told).toContain('B1 / R1')
    expect(told).toContain('failed review')
    expect(told).toContain('Waiting for the API key')
    // Nothing new: nothing told.
    await notices.checkLanesNow(w)
    expect(st.notices).toHaveLength(1)
    // Its merge due: every card passed.
    await inWorkspace(w, () => tasks.updateTask(c, { blocked: '' }, b1))
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'passed', column: 'passed' }, r1, { comment: 'PASSED' }))
    await notices.checkLanesNow(w)
    expect(st.notices).toHaveLength(2)
    expect(JSON.stringify(st.notices[1])).toContain('its merge is due')
  })
})
