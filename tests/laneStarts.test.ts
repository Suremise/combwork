// Combwork starts a lane's next card on its builder (HI-1990): once the card before it is Done and the builder's turn is
// over, as the Assistant's Start gives one (its doorbell typed into the idle builder); its first card too (HI-2029), never
// while the lane's own start launches its agents, never into a turn, and not with the workflow rules off.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { claudeInput } from './claudeInputStandIn'

// What Combwork types into agents' terminals, recorded instead (no process runs).
const pty = vi.hoisted(() => ({ typed: [] as string[] }))
vi.mock('../src/main/ptyHost', async (original) => ({
  ...(await original<object>()),
  writePty: (_key: string, data: string) => {
    pty.typed.push(data)
  }
}))

const base = tempDir('hive-lanestarts-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const { checkLaneStarts, laneStartsTestHooks } = await import('../src/main/laneStarts')
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { advanced } = await import('../src/main/advanced')
const { ENFORCE } = await import('../src/main/workflow/service')
const { laneStartTestHooks, retryFreshStart } = await import('../src/main/laneStart')
const { createDelivery, launchWith, deliveryNow } = await import('../src/main/deliveries')

const user = { kind: 'user' } as const
const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
const s = sessions as unknown as { live: Map<string, unknown> }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)

/** A builder running, as SessionManager keeps one (no process): its runtime facts follow its status (#648, #649). */
function builder(status: string, id = 'b1'): { status: string } {
  let now = status
  const rt = { lifecycle: 'running', maintenance: null, attention: null, composer: 'free' }
  const state = { provider: 'claude', runId: `run-${id}`, projectPath: p, agentId: id, cwd: p, sessionId: '', startedAt: '', launchSignature: '', unseen: false, runtime: rt, turn: { state: 'over' } } as Record<string, unknown>
  Object.defineProperty(state, 'status', {
    get: () => now,
    set: (v: string) => {
      now = v
      state.turn = { state: v === 'working' ? 'running' : 'over' }
    },
    enumerable: true
  })
  state.status = status
  // Its input box (HI-1979: Combwork types into Claude Code only once its own key shows the box empty), fed what is typed.
  const input = claudeInput({ paste: false })
  input.from(() => pty.typed)
  s.live.set(`${p.toLowerCase()}#${id}`, { state, adapter: claudeCode, screen: input.screen, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null })
  return state as unknown as { status: string }
}

const card = async (title: string, agent = 'b1'): Promise<number> => (await run(() => tasks.createTask({ title, project: 'alpha', agent }, user))).number
const columnOf = async (n: number): Promise<string> => (await run(() => tasks.getTask(n, w))).column
// The builder's doorbell for its task (#650: the task's id, which it reads with cw_inbox).
const rung = (): boolean => pty.typed.join('').includes('New in your inbox: 1 task')

describe("Combwork starts a lane's next card (HI-1990)", () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [...['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'h1'].map((id) => ({ id, name: id.toUpperCase() })), { id: 'r1', name: 'R1' }, { id: 'o1', name: 'O1' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    s.live.clear()
    await advanced.set(ENFORCE, true)
    await disposeWorkspaceService(w)
    ;(await import('../src/main/boardStore')).closeAllBoards()
  })
  beforeEach(async () => {
    laneStartsTestHooks.beforeStart = null
    for (const l of await lanes.listLanes(w)) if (l.state === 'active' || l.state === 'paused') await lanes.endLane(w, l.id, { abandoned: true })
    pty.typed.length = 0
    s.live.clear()
    await advanced.set(ENFORCE, true)
  })

  it("a lane's first card (HI-2029): while its builder is in a turn the lane says why it waits, and Combwork starts it once the turn is over", async () => {
    const first = await card('Retry the sync')
    const next = await card('Show sync progress')
    const lane = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [first, next], by: 'the Assistant' })).lane
    const b = builder('working')
    await checkLaneStarts(w)
    expect([await columnOf(first), await columnOf(next)]).toEqual(['todo', 'todo'])
    // Never "active" with its card untouched and nothing said: why it waits, at once.
    expect((await lanes.getLane(w, lane.id)).status).toMatchObject({ reason: 'startWait', card: first, why: 'busy', agent: 'B1' })
    expect(rung()).toBe(false)
    b.status = 'ready'
    await checkLaneStarts(w)
    const started = await run(() => tasks.getTask(first, w))
    expect([started.column, started.agent]).toEqual(['doing', 'b1'])
    expect(started.history.some((h) => h.by === 'Combwork' && /^Moved to (the (top|bottom) of )?Doing\b/.test(h.what))).toBe(true)
    expect(rung()).toBe(true)
    expect((await lanes.getLane(w, lane.id)).status?.reason).not.toBe('startWait')
    await lanes.endLane(w, lane.id, { abandoned: true })
  })

  it("a lane's first card isn't started while the lane's own start launches its agents (HI-2029: slotswitches' slot taken, p5lane's builder given a second conversation); once it is over, it is", async () => {
    const first = await card('Retry the export', 'e4')
    // Held from before the lane is recorded, as Start Lane… and POST /v1/lanes hold it, with its builder not running yet.
    const release = lanes.holdLaneStart(w, 'alpha', 'e4')
    let lane: { id: string }
    try {
      lane = (await lanes.startLane(w, { project: 'alpha', builder: 'e4', reviewer: 'r1', cards: [first], by: 'the user' })).lane
      await checkLaneStarts(w)
      expect(await columnOf(first)).toBe('todo')
      expect((await lanes.getLane(w, lane.id)).status).toMatchObject({ reason: 'startWait', card: first, why: 'busy' })
    } finally {
      release()
    }
    // A second release is nothing (the start's finally after an early one).
    release()
    expect(lanes.laneStartHeld(w, 'alpha', 'e4')).toBe(false)
    builder('ready', 'e4')
    await checkLaneStarts(w)
    expect(await columnOf(first)).toBe('doing')
    expect(rung()).toBe(true)
    await lanes.endLane(w, lane!.id, { abandoned: true })
  })

  it("a start decided as the lane's own start begins is dropped where it is checked again (HI-2029)", async () => {
    const first = await card('Retry the import', 'e5')
    const lane = (await lanes.startLane(w, { project: 'alpha', builder: 'e5', reviewer: 'r1', cards: [first], by: 'the user' })).lane
    builder('ready', 'e5')
    let release: (() => void) | null = null
    laneStartsTestHooks.beforeStart = async () => {
      release = lanes.holdLaneStart(w, 'alpha', 'e5')
    }
    await checkLaneStarts(w)
    expect(await columnOf(first)).toBe('todo')
    expect(rung()).toBe(false)
    laneStartsTestHooks.beforeStart = null
    release!()
    await checkLaneStarts(w)
    expect(await columnOf(first)).toBe('doing')
    await lanes.endLane(w, lane.id, { abandoned: true })
  })

  it("a lane waiting for a slot (a stoppedOnly wait too) isn't started until the slot pass's deferred launch clears it, even with the slot lent meanwhile (HR1 on HI-2029)", async () => {
    const first = await card('Retry the backup', 'e6')
    const lane = (await lanes.startLane(w, { project: 'alpha', builder: 'e6', reviewer: 'r1', cards: [first], by: 'the Assistant' })).lane
    // POST /v1/lanes over stopped agents with no slot free (launchRecordedLane), then the slot pass lends one and is
    // launching the agents (startWaitingLane, its awaits before launchAgents): the wait is kept until that is done.
    await lanes.setLaneSlotWait(w, lane.id, { since: new Date().toISOString(), note: '', stoppedOnly: true })
    // Its slot lent (its view no longer says it waits for one, so nothing in it pauses the lane), its launch under way.
    lanes.setLaneSlots((_ws, l) => (l.id === lane.id ? { name: 'slot-x', carried: false, line: null, state: 'ready', since: new Date().toISOString() } : null))
    try {
      builder('ready', 'e6')
      await checkLaneStarts(w)
      expect(await columnOf(first)).toBe('todo')
      expect(rung()).toBe(false)
      // Launched: the pass clears the wait, and Combwork's start comes after.
      await lanes.setLaneSlotWait(w, lane.id, null)
      await checkLaneStarts(w)
      expect(await columnOf(first)).toBe('doing')
    } finally {
      lanes.setLaneSlots(null)
    }
    await lanes.endLane(w, lane.id, { abandoned: true })
  })

  it("a wait for a slot that begins after the look is checked again just before the start: nothing started (HR1 on HI-2029)", async () => {
    const first = await card('Retry the restore', 'e7')
    const lane = (await lanes.startLane(w, { project: 'alpha', builder: 'e7', reviewer: 'r1', cards: [first], by: 'the Assistant' })).lane
    builder('ready', 'e7')
    // Lent at once as it waits (the slot pass's lend between the look and the start).
    lanes.setLaneSlots((_ws, l) => (l.id === lane.id ? { name: 'slot-y', carried: false, line: null, state: 'ready', since: new Date().toISOString() } : null))
    laneStartsTestHooks.beforeStart = async () => {
      await lanes.setLaneSlotWait(w, lane.id, { since: new Date().toISOString(), note: '' })
    }
    try {
      await checkLaneStarts(w)
      expect(await columnOf(first)).toBe('todo')
      expect(rung()).toBe(false)
    } finally {
      laneStartsTestHooks.beforeStart = null
      lanes.setLaneSlots(null)
    }
    await lanes.endLane(w, lane.id, { abandoned: true })
  })

  it('a later card once the card before it is Done and its builder is free; never into a turn', async () => {
    const first = await card('Retry the upload', 'e1')
    const next = await card('Show upload progress', 'e1')
    const lane = (await lanes.startLane(w, { project: 'alpha', builder: 'e1', reviewer: 'r1', cards: [first, next], by: 'E1 (alpha)' })).lane
    await run(() => tasks.updateTask(first, { column: 'doing', agent: 'e1' }, user))
    const b = builder('working', 'e1')
    // Done while the builder is in a turn (reading its wake): the next card waits for the turn's end.
    await run(() => tasks.updateTask(first, { column: 'done' }, user))
    await checkLaneStarts(w)
    expect(await columnOf(next)).toBe('todo')
    expect(rung()).toBe(false)
    b.status = 'ready'
    await checkLaneStarts(w)
    const started = await run(() => tasks.getTask(next, w))
    expect([started.column, started.agent]).toEqual(['doing', 'e1'])
    expect(rung()).toBe(true)
    await lanes.endLane(w, lane.id, { abandoned: true })
  })

  it("a lane recorded over a running builder (Legible's LE-259): a message for its conversation is offered; one queued for it is offered first and never overlapped by the first card, which is given once its line is free, the lane saying so meanwhile", async () => {
    const { leaveMessage } = await import('../src/main/agentMessages')
    const sender = { kind: 'user' as const, name: 'the user' }
    // Offered: a message to the conversation the builder runs, once it is idle.
    const offeredTo = builder('ready', 'e2') as unknown as Record<string, unknown>
    offeredTo.sessionId = 'conv-e2'
    const told = await run(() => leaveMessage(p, 'e2', 'E2', sender, 'You are the builder of lane L: start its card.'))
    expect(['typed']).toContain(told.fate)
    // A line queued for D6 and not offered yet (as m637 was), D6 idle: Combwork has the delivery service offer it first, under
    // its own rules, and never gives the card over it; the lane says so meanwhile (HR1 on HI-2029: no time bound).
    const first = await card('Retest installer', 'd6')
    const b = builder('working', 'd6')
    const lane = (await lanes.startLane(w, { project: 'alpha', builder: 'd6', reviewer: 'r1', cards: [first], by: 'the Assistant' })).lane
    const sent = await createDelivery(p, { agentId: 'd6', agentName: 'D6', kind: 'rebrief', from: sender, body: 'You are the builder of lane L: start its card.' })
    b.status = 'ready'
    await checkLaneStarts(w)
    expect(await columnOf(first)).toBe('todo')
    expect((await lanes.getLane(w, lane.id)).status).toMatchObject({ reason: 'startWait', card: first, why: 'queued', agent: 'D6' })
    // Offered by that look (typed into D6), not overlapped by the card.
    expect(['offered', 'received', 'acked']).toContain(deliveryNow(p, sent.id)?.state)
    // D6 takes it (its CLI submits the line: its prompt count goes up, as its hook does; a turn of its own) and is idle
    // again: the card is given then, once its line is free.
    const taken = s.live.get(`${p.toLowerCase()}#d6`) as { prompts?: number }
    taken.prompts = (taken.prompts ?? 0) + 1
    b.status = 'working'
    b.status = 'ready'
    await vi.waitFor(async () => {
      await checkLaneStarts(w)
      expect(await columnOf(first)).toBe('doing')
    }, { timeout: 10_000 })
    await lanes.endLane(w, lane.id, { abandoned: true })
  })

  it("a lane's start task, unchanged, survives its own startup and is offered (HI-2029: HB5's m26484, cancelled as 'its lane brief is no longer current')", async () => {
    // Its start task shares the lane-brief source's id (laneStart.ts: kind task, ref <lane>:builder): that source's refresh,
    // run as the deliveries offer it, read the role as a brief rev and cancelled it.
    ;(await import('../src/main/laneBriefs')).startLaneBriefs()
    const { offerNow } = await import('../src/main/deliveries')
    const first = await card('Polish the panel', 'e3')
    const b = builder('working', 'e3')
    const lane = (await lanes.startLane(w, { project: 'alpha', builder: 'e3', reviewer: 'r1', cards: [first], by: 'the Assistant', brief: 'Polish first.' })).lane
    const task = await createDelivery(p, { agentId: 'e3', agentName: 'E3', kind: 'task', from: { kind: 'user', name: 'the user' }, body: 'You are the builder of a lane: start its card.', source: 'lane-brief', ref: `${lane.id}:builder` })
    // Its reviewer's too (the mcp project's MR1, m23 on rc.11: started in a new conversation, cancelled 13 s later).
    const r = builder('working', 'r1')
    const review = await createDelivery(p, { agentId: 'r1', agentName: 'R1', kind: 'task', from: { kind: 'user', name: 'the user' }, body: 'You are the reviewer of a lane: join it.', source: 'lane-brief', ref: `${lane.id}:reviewer` })
    b.status = 'ready'
    await offerNow(p, 'e3')
    expect(['offered', 'received', 'acked']).toContain(deliveryNow(p, task.id)?.state)
    expect(pty.typed.join('')).toContain('New in your inbox: 1 task')
    pty.typed.length = 0
    r.status = 'ready'
    await offerNow(p, 'r1')
    expect(['offered', 'received', 'acked']).toContain(deliveryNow(p, review.id)?.state)
    expect(pty.typed.join('')).toContain('New in your inbox: 1 task')
    await lanes.endLane(w, lane.id, { abandoned: true })
  })

  it('not with the workflow rules off: the builder carries the lane on itself', async () => {
    await advanced.set(ENFORCE, false)
    const first = await card('Retry the upload')
    const next = await card('Show upload progress')
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [first, next], by: 'B1 (alpha)' })
    builder('ready')
    await run(() => tasks.updateTask(first, { column: 'doing', agent: 'b1' }, user))
    await run(() => tasks.updateTask(first, { column: 'done' }, user))
    await checkLaneStarts(w)
    expect(await columnOf(next)).toBe('todo')
    expect(rung()).toBe(false)
  })

  /**
   * Two lanes, builders `x` and `y` (each test its own: a builder just given a card stays reserved a moment), each with
   * its first card Done and its next in Todo; both builders idle.
   */
  async function twoDue(x: string, y: string) {
    const [a1, a2] = [await card('A one', x), await card('A two', x)]
    const [b1, b2] = [await card('B one', y), await card('B two', y)]
    const l1 = (await lanes.startLane(w, { project: 'alpha', builder: x, reviewer: 'r1', cards: [a1, a2], by: 'B (alpha)' })).lane
    const l2 = (await lanes.startLane(w, { project: 'alpha', builder: y, reviewer: 'r1', cards: [b1, b2], by: 'B (alpha)' })).lane
    for (const [n, a] of [[a1, x], [b1, y]] as const) {
      await run(() => tasks.updateTask(n, { column: 'doing', agent: a }, user))
      await run(() => tasks.updateTask(n, { column: 'done' }, user))
    }
    builder('ready', x)
    builder('ready', y)
    return { a2, b2, l1, l2 }
  }

  it("a lane abandoned while an earlier lane's start is on its way gets nothing; the earlier one starts (HR1's round 1)", async () => {
    const { a2, b2, l1, l2 } = await twoDue('b2', 'b3')
    // While the first start of the batch is decided, the user abandons the other lane.
    laneStartsTestHooks.beforeStart = async (lane) => {
      if (lane === l1.id) await lanes.endLane(w, l2.id, { abandoned: true })
    }
    await checkLaneStarts(w)
    expect(await columnOf(a2)).toBe('doing')
    const b = await run(() => tasks.getTask(b2, w))
    expect([b.column, b.agent]).toEqual(['todo', 'b3'])
    expect(pty.typed.join('').split('New in your inbox: 1 task').length - 1).toBe(1)
  })

  it("a lane's next card given to another agent meanwhile isn't started; the lane whose start comes first still is", async () => {
    const { a2, b2, l2 } = await twoDue('b4', 'b5')
    laneStartsTestHooks.beforeStart = async (lane, n) => {
      if (lane === l2.id && n === b2) await run(() => tasks.updateTask(b2, { agent: 'o1' }, user))
    }
    await checkLaneStarts(w)
    const b = await run(() => tasks.getTask(b2, w))
    expect([b.column, b.agent]).toEqual(['todo', 'o1'])
    expect(await columnOf(a2)).toBe('doing')
  })

  it("a start whose condition no longer holds where it is written assigns, writes and delivers nothing (the guard Combwork's start checks there)", async () => {
    const n = await card('Guarded', 'b6')
    builder('ready', 'b6')
    const { startTask } = await import('../src/main/taskStart')
    let seen: string | null = null
    const refused = await run(() => startTask(n, { kind: 'agent', agentId: 'b6' }, tasks.HIVE_LANE_START, undefined, undefined, (now) => {
      seen = now.column
      throw new Error('its lane changed meanwhile')
    })).then(() => null, (e: Error) => e.message)
    expect(refused).toMatch(/its lane changed meanwhile/)
    expect(seen).toBe('todo')
    const c = await run(() => tasks.getTask(n, w))
    expect([c.column, c.agent]).toEqual(['todo', 'b6'])
    expect(c.history.some((h) => /Doing/.test(h.what))).toBe(false)
    expect(pty.typed.join('')).not.toContain('New in your inbox')
  })

  it("a first card whose rules wait for the card it depends on (HI-2129): the lane says it waits for that card to merge, never stalled, whatever its builder does; started once that card is Done", async () => {
    await w.mutateProjectConfig(p, () => ({ workflow: { platform: 'none', preset: null, options: { dependenciesDone: true } } }))
    const dep = await card('Choose the connection', 'o1')
    const first = await card('Use the connection choice', 'b9')
    await run(() => tasks.updateTask(first, { blockedBy: [dep] }, user))
    const depKey = (await (await import('../src/main/workflow/service')).workflowFor(w, p))!.store.card(dep).key
    const lane = (await lanes.startLane(w, { project: 'alpha', builder: 'b9', reviewer: 'r1', cards: [first], by: 'B9 (alpha)' })).lane
    // Its builder watching the card it depends on, as HB5 watched HI-2108 → Done.
    const b = builder('watching', 'b9')
    await checkLaneStarts(w)
    expect(await columnOf(first)).toBe('todo')
    const view = await lanes.getLane(w, lane.id)
    expect(view.status).toMatchObject({ reason: 'startWait', card: first, why: 'dependencies', waitsFor: depKey })
    const { laneStatusText } = await import('../src/shared/lanes')
    expect(laneStatusText(view.status!)).toMatch(new RegExp(` waits to start: it waits for ${depKey} to merge$`))
    // The stall check's reading of the lane: its first card waits on its dependency, so the lane-next stall says nothing.
    const { laneOrderView, laneNextWaitReason, LANE_NEXT_STALL_MS } = await import('../src/main/cardStall')
    const order = laneOrderView(view, () => undefined)
    expect(order.waitsForDependency).toEqual({ card: first, on: depKey })
    const c = await run(() => tasks.getTask(first, w))
    expect(laneNextWaitReason(c, order, { name: 'B9', status: 'watching' }, Date.parse(view.startedAt) + 2 * LANE_NEXT_STALL_MS)).toBeNull()
    // Idle too: Combwork starts it once the card it depends on is Done, so nothing waits on its builder.
    b.status = 'ready'
    await checkLaneStarts(w)
    expect(await columnOf(first)).toBe('todo')
    expect((await lanes.getLane(w, lane.id)).status).toMatchObject({ why: 'dependencies' })
    expect(rung()).toBe(false)
    // Done (by hand, never started: nothing of it to find in the target): the wait is over, and Combwork starts it on its
    // free builder.
    await run(() => tasks.updateTask(dep, { column: 'done' }, user))
    await checkLaneStarts(w)
    expect(await columnOf(first)).toBe('doing')
    expect(rung()).toBe(true)
    expect(laneOrderView(await lanes.getLane(w, lane.id), () => undefined).waitsForDependency).toBeUndefined()
    await lanes.endLane(w, lane.id, { abandoned: true })
  })

  // Last: it gives the project a workflow (no version control), so a card can carry a request for the user.
  it("a lane paused for the user meanwhile (a request on its next card) gets nothing until it is answered (HR1's round 2)", async () => {
    await w.mutateProjectConfig(p, () => ({ workflow: { platform: 'none', preset: null, options: { review: 'agent', noSelfReview: true } } }))
    const { workflowFor } = await import('../src/main/workflow/service')
    const wf = (await workflowFor(w, p))!
    const { forYou, foldCard } = await import('../src/shared/workflow/facts')
    const { a2, b2, l1, l2 } = await twoDue('b7', 'b8')
    // While the first lane's start is decided, an agent asks the user something on the other lane's next card.
    laneStartsTestHooks.beforeStart = async (lane) => {
      if (lane !== l1.id) return
      await wf.askTheUser(`#${b2}`, 'user', { kind: 'decide', text: 'Should this card go ahead?' })
      expect((await lanes.getLane(w, l2.id)).state).toBe('paused')
    }
    await checkLaneStarts(w)
    expect(await columnOf(a2)).toBe('doing')
    expect(await columnOf(b2)).toBe('todo')
    expect(pty.typed.join('').split('New in your inbox: 1 task').length - 1).toBe(1)
    // Answered: the lane goes on, and its next card starts.
    laneStartsTestHooks.beforeStart = null
    const asked = forYou(foldCard(wf.store.facts(b2)))[0]
    expect(asked).toBeTruthy()
    const answered = await wf.answer(`#${b2}`, asked.request, 'answered', { note: 'Yes, go ahead.' })
    expect('ok' in answered && answered.ok).toBe(true)
    expect((await lanes.getLane(w, l2.id)).state).toBe('active')
    await checkLaneStarts(w)
    expect(await columnOf(b2)).toBe('doing')
  })

  describe('a lane reordered now (HI-1995; the project with a workflow, as the case above left it)', () => {
    /** A lane on builder `b` of `titles`, its first card Active (started by its builder), its builder idle. */
    async function inFlight(b: string, titles: string[]) {
      const cards: number[] = []
      for (const t of titles) cards.push(await card(t, b))
      const lane = (await lanes.startLane(w, { project: 'alpha', builder: b, reviewer: 'r1', cards, by: 'B (alpha)' })).lane
      await run(() => tasks.updateTask(cards[0], { column: 'doing', agent: b }, user))
      const st = builder('ready', b)
      return { cards, lane, st }
    }
    const runningOf = async (b: string) => (await lanes.listLanes(w)).filter((l) => l.builder.id === b && (l.state === 'active' || l.state === 'paused'))
    /** After the put back's own write, `then` runs (another decision on the lane), once: the seam between the two steps. */
    async function afterPutBack(then: () => Promise<void>) {
      const { Workflow } = await import('../src/main/workflow/runtime')
      const original = Workflow.prototype.putBack
      let ran = false
      const spy = vi.spyOn(Workflow.prototype, 'putBack').mockImplementation(async function (this: InstanceType<typeof Workflow>, ref, actor, args) {
        const reply = await original.call(this, ref, actor, args)
        if (!ran && 'ok' in reply && reply.ok) {
          ran = true
          await then()
        }
        return reply
      })
      return { ran: () => ran, restore: () => spy.mockRestore() }
    }

    it('puts the card in flight back (its line kept) and applies the new order at once; its builder is told', async () => {
      const { cards: [x1, x2], lane } = await inFlight('b9', ['X one', 'X two'])
      const r = await lanes.startLane(w, { project: 'alpha', builder: 'b9', reviewer: 'r1', cards: [x2, x1], by: 'the user', applyNow: true })
      expect(r.note).toContain('Applied now: ')
      expect(r.note).toContain('is back in Todo')
      expect(await columnOf(x1)).toBe('todo')
      expect(r.lane.id).toBe(lane.id)
      expect(r.lane.cards.map((c) => c.number)).toEqual([x2, x1])
      expect(r.lane.queued).toBeNull()
      // Told in its inbox (a rebrief), as the doorbell typed into it says.
      expect(pty.typed.join('')).toContain('New in your inbox')
    })

    it("HI-2273: applied now with a reviewer that is no agent, nothing is put back whatever lane runs: refused under the lock, its card in flight left in Doing", async () => {
      // The lane runs from the start here: the put back is never tried with an unknown reviewer, so a lane another start
      // makes meanwhile can't have its card put back before the refusal either.
      const { cards: [x1, x2], lane } = await inFlight('h1', ['H one', 'H two'])
      const { Workflow } = await import('../src/main/workflow/runtime')
      const putBack = vi.spyOn(Workflow.prototype, 'putBack')
      try {
        await expect(lanes.startLane(w, { project: 'alpha', builder: 'h1', reviewer: null, unknownReviewer: 'Guessed', cards: [x2, x1], by: 'H1 (alpha)', applyNow: true, ownBuilder: true })).rejects.toThrow(`No agent "Guessed" in alpha; this lane's reviewer is R1: leave reviewer out to keep it.`)
        expect(putBack).not.toHaveBeenCalled()
      } finally {
        putBack.mockRestore()
      }
      expect(await columnOf(x1)).toBe('doing')
      const now = await lanes.getLane(w, lane.id)
      expect([now.state, now.reviewer?.id, now.cards.map((c) => c.number), now.queued]).toEqual(['active', 'r1', [x1, x2], null])
    })

    it('refuses while its builder is in a turn, or its card is in Review, changing nothing', async () => {
      const { cards: [x1, x2], st } = await inFlight('d1', ['W one', 'W two'])
      st.status = 'working'
      await expect(lanes.startLane(w, { project: 'alpha', builder: 'd1', reviewer: 'r1', cards: [x2, x1], by: 'the user', applyNow: true })).rejects.toThrow(/D1 is working: a reorder applied now never puts its card back under it/)
      expect(await columnOf(x1)).toBe('doing')
      expect((await lanes.laneOf(w, 'alpha', 'd1'))!.cards.map((c) => c.number)).toEqual([x1, x2])
    })

    it('with its card in flight still first, it changes nothing: the list is queued behind that card as ever', async () => {
      const { cards: [x1, x2, x3] } = await inFlight('d2', ['Y one', 'Y two', 'Y three'])
      const r = await lanes.startLane(w, { project: 'alpha', builder: 'd2', reviewer: 'r1', cards: [x1, x3, x2], by: 'the user', applyNow: true })
      expect(r.note ?? '').not.toContain('Applied now')
      expect(r.lane.queued).toEqual([x1, x3, x2])
      expect(await columnOf(x1)).toBe('doing')
    })

    it("a lane ended, replaced or changed between the put back and the edit: the edit is refused, the newer decision kept, nothing resumed or recreated (Darren's decision)", async () => {
      // Ended (abandoned) in between: no lane runs for its builder afterwards; the put back stays, and says so.
      const { cards: [a1, a2], lane: ended } = await inFlight('d3', ['E one', 'E two'])
      const end = await afterPutBack(async () => {
        await lanes.endLane(w, ended.id, { abandoned: true })
      })
      try {
        await expect(lanes.startLane(w, { project: 'alpha', builder: 'd3', reviewer: 'r1', cards: [a2, a1], by: 'the user', applyNow: true })).rejects.toThrow(/was put back in Todo .*but the lane was ended meanwhile: its list wasn't changed and nothing was started/)
        expect(end.ran()).toBe(true)
        expect(await runningOf('d3')).toEqual([])
        expect(await columnOf(a1)).toBe('todo')
      } finally {
        end.restore()
      }
      // Replaced in between by a newer lane of the same builder: that lane keeps its cards, and is the only one running.
      const { cards: [b1, b2], lane: old } = await inFlight('d4', ['R one', 'R two'])
      const b3 = await card('R three', 'd4')
      let newer: string | null = null
      const replace = await afterPutBack(async () => {
        await lanes.endLane(w, old.id, { abandoned: true })
        newer = (await lanes.startLane(w, { project: 'alpha', builder: 'd4', reviewer: 'r1', cards: [b3], by: 'a newer start' })).lane.id
      })
      try {
        await expect(lanes.startLane(w, { project: 'alpha', builder: 'd4', reviewer: 'r1', cards: [b2, b1], by: 'the user', applyNow: true })).rejects.toThrow(/the lane was ended meanwhile/)
        expect((await runningOf('d4')).map((l) => [l.id, l.cards.map((c) => c.number)])).toEqual([[newer, [b3]]])
      } finally {
        replace.restore()
      }
      // Its list changed in between: refused, the newer list kept.
      const { cards: [c1, c2, c3], lane: changed } = await inFlight('d5', ['C one', 'C two', 'C three'])
      const change = await afterPutBack(async () => {
        await lanes.startLane(w, { project: 'alpha', builder: 'd5', reviewer: 'r1', cards: [c3, c1, c2], by: 'a newer change' })
      })
      try {
        await expect(lanes.startLane(w, { project: 'alpha', builder: 'd5', reviewer: 'r1', cards: [c2, c1, c3], by: 'the user', applyNow: true })).rejects.toThrow(/the lane's list changed meanwhile: this list wasn't applied/)
        expect((await lanes.getLane(w, changed.id)).cards.map((c) => c.number)).toEqual([c3, c1, c2])
      } finally {
        change.restore()
      }
    })
  })
  describe("a lane agent's new conversation owed (HI-2034)", () => {
    /** Each new conversation given, by agent: a stand-in for SessionManager's (its `allowed` before the old run stops, as the real one). */
    let launches: string[] = []
    let notices: string[] = []
    /** Awaited between the stand-in's `allowed` before the old run stops and its `allowed` before the new launch spawns. */
    let midLaunch: (() => Promise<void>) | null = null
    beforeEach(() => {
      launches = []
      notices = []
      midLaunch = null
      laneStartTestHooks.beforeFreshLaunch = null
      laneStartTestHooks.retryCancelling = null
      vi.spyOn(sessions, 'newConversation').mockImplementation(async (_p: string, id: string, _line: string, allowed?: () => void) => {
        allowed?.()
        await midLaunch?.()
        allowed?.()
        launches.push(id)
        const st = builder('starting', id) as unknown as Record<string, unknown>
        st.sessionId = `new-${id}-${launches.length}`
        st.runId = `run-new-${id}-${launches.length}`
        return st as never
      })
      vi.spyOn(sessions, 'notice').mockImplementation((_p: string, title: unknown) => void notices.push(JSON.stringify(title)))
      // A stopped agent's start: its `allowed` just before it spawns, after the start's own awaits.
      vi.spyOn(sessions, 'start').mockImplementation(async (_p: string, o: { agentId?: string; allowed?: () => void }) => {
        await midLaunch?.()
        o.allowed?.()
        launches.push(o.agentId!)
        const st = builder('starting', o.agentId!) as unknown as Record<string, unknown>
        st.sessionId = `new-${o.agentId}-${launches.length}`
        st.runId = `run-new-${o.agentId}-${launches.length}`
        return st as never
      })
    })
    afterEach(() => vi.restoreAllMocks())
    /** A running agent in its old conversation (`old-<id>`, run `run-<id>`). */
    const old = (status: string, id: string): { status: string } => {
      const st = builder(status, id)
      ;(st as unknown as Record<string, unknown>).sessionId = `old-${id}`
      return st
    }
    const owed = (lane: string) => lanes.freshStartsNow(w, lane)
    const laneOf = async (agent: string, cards: number[], reviewer = 'r1') => (await lanes.startLane(w, { project: 'alpha', builder: agent, reviewer, cards, by: 'the user' })).lane

    it("a builder busy as its lane starts is owed its new conversation: never its old one given the card; launched once free, then its card follows", async () => {
      const first = await card('Fresh one', 'f1')
      const lane = await laneOf('f1', [first])
      const b = old('working', 'f1')
      await lanes.oweFreshStart(w, lane.id, 'f1', 'builder', 'old-f1')
      await checkLaneStarts(w)
      expect(launches).toEqual([])
      expect(await columnOf(first)).toBe('todo')
      expect((await lanes.getLane(w, lane.id)).status).toMatchObject({ reason: 'startWait', why: 'fresh', agent: 'F1' })
      // Free: its new conversation, once; the obligation gone, and only then its first card (in the new conversation).
      b.status = 'ready'
      await checkLaneStarts(w)
      expect(launches).toEqual(['f1'])
      expect(owed(lane.id)).toEqual([])
      expect(await columnOf(first)).toBe('todo')
      const now = sessions.liveFor(p, 'f1') as unknown as { status: string; sessionId: string }
      expect(now.sessionId).toBe('new-f1-1')
      now.status = 'ready'
      await checkLaneStarts(w)
      expect(await columnOf(first)).toBe('doing')
      expect(launches).toEqual(['f1'])
      await lanes.endLane(w, lane.id, { abandoned: true })
    })

    it('the first-card barrier holds at the write too: an obligation recorded between the look and the start leaves the card in Todo', async () => {
      const first = await card('Fresh barrier', 'f2')
      const lane = await laneOf('f2', [first])
      old('ready', 'f2')
      laneStartsTestHooks.beforeStart = async () => {
        await lanes.oweFreshStart(w, lane.id, 'f2', 'builder', 'old-f2')
      }
      await checkLaneStarts(w)
      laneStartsTestHooks.beforeStart = null
      expect(await columnOf(first)).toBe('todo')
      expect(rung()).toBe(false)
      await lanes.endLane(w, lane.id, { abandoned: true })
    })

    it('past its wait, no more is tried: blocked, the user told, no turn interrupted and no card given; Retry owes it again and it launches once free', async () => {
      const first = await card('Fresh deadline', 'f3')
      const lane = await laneOf('f3', [first])
      const b = old('working', 'f3')
      await lanes.oweFreshStart(w, lane.id, 'f3', 'builder', 'old-f3')
      const [f] = owed(lane.id)
      await lanes.changeFreshStart(w, lane.id, f.id, (x) => ({ ...x, since: new Date(Date.now() - 11 * 60_000).toISOString() }))
      await checkLaneStarts(w)
      expect(owed(lane.id)[0].blocked?.why).toBe('timeout')
      expect(notices).toHaveLength(1)
      expect((await lanes.getLane(w, lane.id)).status).toMatchObject({ why: 'fresh', freshBlocked: 'timeout' })
      // Free now, still blocked: nothing launched, no card given.
      b.status = 'ready'
      await checkLaneStarts(w)
      expect(launches).toEqual([])
      expect(await columnOf(first)).toBe('todo')
      expect(rung()).toBe(false)
      // The user's Retry: a new obligation from now, launched once free.
      expect(await run(() => retryFreshStart(w, lane.id))).toBe(1)
      expect(owed(lane.id)).toHaveLength(1)
      expect(owed(lane.id)[0].id).not.toBe(f.id)
      await checkLaneStarts(w)
      expect(launches).toEqual(['f3'])
      expect(owed(lane.id)).toEqual([])
      await lanes.endLane(w, lane.id, { abandoned: true })
    })

    it('a launch begun and not proven (a crash after its start task was saved, the old conversation still running): never launched again by itself nor given the card; blocked as uncertain until Retry, which launches once', async () => {
      const first = await card('Fresh crash', 'f4')
      const lane = await laneOf('f4', [first])
      old('ready', 'f4')
      await lanes.oweFreshStart(w, lane.id, 'f4', 'builder', 'old-f4')
      const [f] = owed(lane.id)
      // As a crash leaves it: claimed, and its start task saved as offered into a launch that never ran.
      await lanes.changeFreshStart(w, lane.id, f.id, (x) => ({ ...x, launching: new Date().toISOString() }))
      await createDelivery(p, { agentId: 'f4', agentName: 'F4', kind: 'task', from: { kind: 'user', name: 'the user' }, body: 'You are the builder of a lane.', source: 'lane-brief', ref: `${lane.id}:builder`, launching: true })
      await checkLaneStarts(w)
      expect(launches).toEqual([])
      expect(owed(lane.id)[0].blocked?.why).toBe('uncertain')
      expect(await columnOf(first)).toBe('todo')
      expect(rung()).toBe(false)
      expect(await run(() => retryFreshStart(w, lane.id))).toBe(1)
      await checkLaneStarts(w)
      expect(launches).toEqual(['f4'])
      expect(owed(lane.id)).toEqual([])
      await lanes.endLane(w, lane.id, { abandoned: true })
    })

    it('positive evidence only: a new run resuming the old conversation does not prove it; the agent live in the run its start task went into, in another conversation, does', async () => {
      const first = await card('Fresh proof', 'f5')
      const lane = await laneOf('f5', [first])
      const st = old('ready', 'f5') as unknown as Record<string, unknown>
      await lanes.oweFreshStart(w, lane.id, 'f5', 'builder', 'old-f5')
      const [f] = owed(lane.id)
      await lanes.changeFreshStart(w, lane.id, f.id, (x) => ({ ...x, launching: new Date().toISOString() }))
      // Its start task went into run `run-x`; that run is live, resuming the old conversation.
      const made = await launchWith(p, { agentId: 'f5', agentName: 'F5', kind: 'task', from: { kind: 'user', name: 'the user' }, body: 'You are the builder of a lane.', source: 'lane-brief', ref: `${lane.id}:builder` }, async () => ({ runId: 'run-x' }))
      expect(deliveryNow(p, made.record!.id)?.offerRun).toBe('run-x')
      st.runId = 'run-x'
      await checkLaneStarts(w)
      expect(owed(lane.id)[0].blocked?.why).toBe('uncertain')
      expect(launches).toEqual([])
      // Retried, then the same evidence in a new conversation: the obligation is met, nothing launched again.
      await run(() => retryFreshStart(w, lane.id))
      const again = await launchWith(p, { agentId: 'f5', agentName: 'F5', kind: 'task', from: { kind: 'user', name: 'the user' }, body: 'You are the builder of a lane.', source: 'lane-brief', ref: `${lane.id}:builder` }, async () => ({ runId: 'run-y' }))
      expect(again.record).not.toBeNull()
      const [g] = owed(lane.id)
      await lanes.changeFreshStart(w, lane.id, g.id, (x) => ({ ...x, launching: new Date().toISOString() }))
      st.runId = 'run-y'
      st.sessionId = 'new-f5'
      await checkLaneStarts(w)
      expect(owed(lane.id)).toEqual([])
      expect(launches).toEqual([])
      await lanes.endLane(w, lane.id, { abandoned: true })
    })

    it('ended or reassigned while its launch is on its way: nothing launched', async () => {
      const first = await card('Fresh ended', 'f6')
      const lane = await laneOf('f6', [first])
      old('ready', 'f6')
      await lanes.oweFreshStart(w, lane.id, 'f6', 'builder', 'old-f6')
      laneStartTestHooks.beforeFreshLaunch = async () => void (await lanes.endLane(w, lane.id, { abandoned: true }))
      await checkLaneStarts(w)
      expect(launches).toEqual([])
      // Its reviewer reassigned as its launch is on its way: the new reviewer is never given the old one's.
      const second = await card('Fresh reassigned', 'f7')
      const lane2 = await laneOf('f7', [second], 'f9')
      old('ready', 'f9')
      await lanes.oweFreshStart(w, lane2.id, 'f9', 'reviewer', 'old-f9')
      old('working', 'f7')
      laneStartTestHooks.beforeFreshLaunch = async () => void (await lanes.startLane(w, { project: 'alpha', builder: 'f7', reviewer: 'o1', cards: [second], by: 'the user' }))
      await checkLaneStarts(w)
      expect(launches).toEqual([])
      expect(owed(lane2.id)).toEqual([])
      await lanes.endLane(w, lane2.id, { abandoned: true })
    })

    it("ended or reassigned after the old run's stop began (HR1 round 1, finding 1): the obligation is checked again before the new launch spawns, for a stopped agent too", async () => {
      const first = await card('Fresh mid', 'g1')
      const lane = await laneOf('g1', [first])
      old('ready', 'g1')
      await lanes.oweFreshStart(w, lane.id, 'g1', 'builder', 'old-g1')
      midLaunch = async () => void (await lanes.endLane(w, lane.id, { abandoned: true }))
      await checkLaneStarts(w)
      expect(launches).toEqual([])
      // A stopped reviewer, reassigned while its start prepares: never spawned for the lane it no longer has.
      const second = await card('Fresh mid stopped', 'g2')
      const lane2 = await laneOf('g2', [second], 'g7')
      old('working', 'g2')
      await lanes.oweFreshStart(w, lane2.id, 'g7', 'reviewer', 'old-g7')
      midLaunch = async () => void (await lanes.startLane(w, { project: 'alpha', builder: 'g2', reviewer: 'o1', cards: [second], by: 'the user' }))
      await checkLaneStarts(w)
      expect(launches).toEqual([])
      await lanes.endLane(w, lane2.id, { abandoned: true })
    })

    it("its launch's brief carries the note it was owed with (HR1 round 1, finding 2: the user's Start Lane note)", async () => {
      const first = await card('Fresh note', 'g3')
      const lane = await laneOf('g3', [first])
      old('ready', 'g3')
      await lanes.oweFreshStart(w, lane.id, 'g3', 'builder', 'old-g3', 'Use the staging database')
      expect(owed(lane.id)[0].note).toBe('Use the staging database')
      await checkLaneStarts(w)
      expect(launches).toEqual(['g3'])
      const { deliveriesOf } = await import('../src/main/deliveries')
      const brief = (await deliveriesOf(p, 'g3')).filter((d) => d.source === 'lane-brief' && d.ref === `${lane.id}:builder`).at(-1)
      expect(brief?.body).toContain('Use the staging database')
      await lanes.endLane(w, lane.id, { abandoned: true })
    })

    it('with the workflow rules off, or turned off while it is owed, it is still launched once free (HR1 round 1, finding 3)', async () => {
      const first = await card('Fresh rules', 'g4')
      const lane = await laneOf('g4', [first])
      const b = old('working', 'g4')
      await lanes.oweFreshStart(w, lane.id, 'g4', 'builder', 'old-g4')
      await checkLaneStarts(w)
      expect(launches).toEqual([])
      await advanced.set(ENFORCE, false)
      b.status = 'ready'
      await checkLaneStarts(w)
      expect(launches).toEqual(['g4'])
      expect(owed(lane.id)).toEqual([])
      // Past its wait with the rules off: blocked, told.
      const second = await card('Fresh rules off', 'g5')
      const lane2 = await laneOf('g5', [second])
      old('working', 'g5')
      await lanes.oweFreshStart(w, lane2.id, 'g5', 'builder', 'old-g5')
      const [g] = owed(lane2.id)
      await lanes.changeFreshStart(w, lane2.id, g.id, (x) => ({ ...x, since: new Date(Date.now() - 11 * 60_000).toISOString() }))
      await checkLaneStarts(w)
      expect(owed(lane2.id)[0].blocked?.why).toBe('timeout')
      expect(notices).toHaveLength(1)
      await advanced.set(ENFORCE, true)
      await lanes.endLane(w, lane.id, { abandoned: true })
      await lanes.endLane(w, lane2.id, { abandoned: true })
    })

    it("Retry cancels only the earlier attempt's start task, before owing it again (HR1 round 1, finding 4): a pass meanwhile launches nothing, and the new attempt's task is never cancelled", async () => {
      const first = await card('Fresh retry', 'g6')
      const lane = await laneOf('g6', [first])
      old('ready', 'g6')
      await lanes.oweFreshStart(w, lane.id, 'g6', 'builder', 'old-g6')
      const [f] = owed(lane.id)
      // An earlier attempt's start task left on its way, then blocked (uncertain).
      await lanes.changeFreshStart(w, lane.id, f.id, (x) => ({ ...x, launching: new Date().toISOString() }))
      const earlier = await createDelivery(p, { agentId: 'g6', agentName: 'G6', kind: 'task', from: { kind: 'user', name: 'the user' }, body: 'Earlier attempt.', source: 'lane-brief', ref: `${lane.id}:builder`, launching: true })
      await checkLaneStarts(w)
      expect(owed(lane.id)[0].blocked?.why).toBe('uncertain')
      // Its cancellation held while a pass runs: still blocked, nothing launched.
      laneStartTestHooks.retryCancelling = async () => {
        await checkLaneStarts(w)
        expect(launches).toEqual([])
        expect(owed(lane.id)[0].blocked).toBeTruthy()
      }
      expect(await run(() => retryFreshStart(w, lane.id))).toBe(1)
      laneStartTestHooks.retryCancelling = null
      expect(deliveryNow(p, earlier.id)?.state).toBe('cancelled')
      await checkLaneStarts(w)
      expect(launches).toEqual(['g6'])
      const { deliveriesOf } = await import('../src/main/deliveries')
      const latest = (await deliveriesOf(p, 'g6')).filter((d) => d.source === 'lane-brief' && d.ref === `${lane.id}:builder` && d.id !== earlier.id)
      expect(latest).toHaveLength(1)
      expect(latest[0].state).not.toBe('cancelled')
      await lanes.endLane(w, lane.id, { abandoned: true })
    })

    it('builder and reviewer both owed: each launched once, when each is free (the reviewer after the builder has started its card), the builder never again', async () => {
      const first = await card('Fresh both', 'f8')
      const lane = await laneOf('f8', [first], 'o1')
      const b = old('working', 'f8')
      const r = old('working', 'o1')
      await lanes.oweFreshStart(w, lane.id, 'f8', 'builder', 'old-f8')
      await lanes.oweFreshStart(w, lane.id, 'o1', 'reviewer', 'old-o1')
      b.status = 'ready'
      await checkLaneStarts(w)
      expect(launches).toEqual(['f8'])
      ;(sessions.liveFor(p, 'f8') as unknown as { status: string }).status = 'ready'
      await checkLaneStarts(w)
      expect(await columnOf(first)).toBe('doing')
      expect(owed(lane.id).map((f) => f.role)).toEqual(['reviewer'])
      r.status = 'ready'
      await checkLaneStarts(w)
      expect(launches).toEqual(['f8', 'o1'])
      expect(owed(lane.id)).toEqual([])
      await checkLaneStarts(w)
      expect(launches).toEqual(['f8', 'o1'])
      await lanes.endLane(w, lane.id, { abandoned: true })
    })
  })
})
