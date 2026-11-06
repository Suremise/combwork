import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { cardChange, laneNextWords, loopWakeLine, readCondition, wakeAbout, type WatchCondition } from '../src/shared/watch'
import { laneStartDue } from '../src/shared/lanes'
import type { LaneCard } from '../src/shared/types'
import { tempDir } from './tempDir'
import { follow } from './followDoorbell'

/** The merge queue's returns as queueReturnOf finds them (HI-1721), by card: none unless a test sets one. */
const { returns, resubmits } = vi.hoisted(() => ({ returns: new Map<number, { at: string; text: string; builder: string | null }>(), resubmits: new Map<number, string>() }))
vi.mock('../src/main/queueReturn', () => ({ queueReturnOf: async (_ws: unknown, _p: string, n: number) => returns.get(n) ?? null, returnIn: () => null, resubmittedOf: async (_ws: unknown, _p: string, n: number) => resubmits.get(n) ?? null, resubmittedIn: () => null, staleApprovalOf: async () => null, staleIn: () => null }))

describe('loop wake lines (#405)', () => {
  const card = { number: 12, title: 'T', description: '', project: 'alpha', agent: 'b1', agentName: 'B1', column: 'review' as const, order: 1, labels: [], blocked: null, blockedBy: [], links: [], comments: [{ at: '2026-10-10T00:00:00.000Z', by: 'R1 (alpha)', text: 'Round 1: FAILED. 1. No delay.' }], history: [{ at: '2026-10-10T00:00:00.000Z', by: 'R1 (alpha)', what: 'Review failed' }], archived: false, createdAt: '2026-10-10T00:00:00.000Z', createdBy: 'You', updatedAt: '2026-10-10T00:00:00.000Z' }
  it("words a reviewer's and a builder's wake as a watch's line, with what to do", () => {
    const arrived = { ...card, comments: [], history: [{ at: '2026-10-10T00:00:00.000Z', by: 'You', what: 'Moved to Review' }] }
    expect(loopWakeLine({ ...cardChange(12, arrived, ['column']), about: wakeAbout(arrived, ['column'], 'r1') }, 'review')).toBe(
      "[CW] #12 (B1's card) is in Review. You review this card in its loop: carry on with it (cw_read_task with latestComment for the comment in full)."
    )
    expect(loopWakeLine({ ...cardChange(12, card, ['verdict']), about: wakeAbout(card, ['verdict'], 'b1') }, 'verdict')).toBe(
      '[CW] #12 is in Review: R1 (alpha) failed it; latest comment by R1 (alpha): "Round 1: FAILED. 1. No delay.". This is your card in its loop: carry on (cw_read_task with latestComment for the comment in full).'
    )
  })
})

describe("a lane's next card, after a Done one (HI-1990)", () => {
  const lc = (number: number, column: LaneCard['column'], more: Partial<LaneCard> = {}): LaneCard => ({ number, title: `Card ${number}`, column, blocked: null, round: 1, reviewing: false, ...more })
  it('is due for Combwork to start as the first open card, in Todo, not blocked, in an active lane (its first card too, HI-2029)', () => {
    expect(laneStartDue({ state: 'active', cards: [lc(1, 'done'), lc(2, 'todo')] })?.number).toBe(2)
    // Another lane's card before it doesn't hold it up; one Done before that does count.
    expect(laneStartDue({ state: 'active', cards: [lc(1, 'done'), lc(3, 'doing', { elsewhere: 'x' }), lc(2, 'todo')] })?.number).toBe(2)
    // Its first card too (HI-2029).
    expect(laneStartDue({ state: 'active', cards: [lc(1, 'todo'), lc(2, 'todo')] })?.number).toBe(1)
    expect(laneStartDue({ state: 'active', cards: [lc(1, 'passed'), lc(2, 'todo')] })).toBeNull()
    expect(laneStartDue({ state: 'active', cards: [lc(1, 'done'), lc(2, 'todo', { blocked: 'Which icon?' })] })).toBeNull()
    expect(laneStartDue({ state: 'active', cards: [lc(1, 'done'), lc(2, 'doing')] })).toBeNull()
    expect(laneStartDue({ state: 'paused', cards: [lc(1, 'done'), lc(2, 'todo')] })).toBeNull()
    expect(laneStartDue({ state: 'active', cards: [lc(1, 'done')] })).toBeNull()
  })
  it("words what comes next in the builder's Done wake", () => {
    expect(laneNextWords({ card: 7, title: 'Show progress', is: 'started' })).toBe(`Your lane's next card, #7 ("Show progress"), is under way: carry on with it`)
    expect(laneNextWords({ card: 7, title: 'x'.repeat(80), is: 'waits' })).toBe(`Your lane's next card is #7 ("${'x'.repeat(59)}…"): cw_lane next says when it can start`)
    expect(laneNextWords('last')).toBe("That was your lane's last card: the lane ends by itself, so end your turn unless you have other work")
    expect(laneNextWords('paused')).toBe('Your lane is paused: cw_lane next says why')
  })
})

describe('loop wakes (main/loopWakes.ts, #405)', async () => {
  const base = tempDir('cw-loopwakes-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(async () => {
    // The workspace database (#1018: deliveries are kept in it) is open until its board closes.
    ;(await import('../src/main/boardStore')).closeAllBoards()
    rmSync(base, { recursive: true, force: true })
  })
  const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
  const tasks = await import('../src/main/tasks')
  const watches = await import('../src/main/watches')
  watches.testHooks.settleMs = 0
  const lanes = await import('../src/main/lanes')

  /** Workflow rules off for one test (#1270: Combwork owns the lane while they are on), on again after it. */
  const { advanced } = await import('../src/main/advanced')
  const { ENFORCE } = await import('../src/main/workflow/service')
  const rulesOff = (): Promise<unknown> => advanced.set(ENFORCE, false)
  afterEach(async () => {
    await advanced.set(ENFORCE, true)
  })
  const loopWakes = await import('../src/main/loopWakes')
  loopWakes.initLoopWakes()
  const { sessions } = await import('../src/main/sessions')
  let n = 0
  /** A workspace whose project alpha has a builder (b1), a reviewer (r1) and another agent (o1). */
  const open = async (cfg: Record<string, unknown> = {}) => {
    const path = join(base, `ws-${++n}`)
    const alpha = join(path, 'alpha')
    mkdirSync(join(alpha, '.combwork'), { recursive: true })
    writeFileSync(join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }, { id: 'o1', name: 'O1' }], ...cfg }))
    const w = createWorkspaceService()
    await w.open(path)
    return { w, alpha }
  }
  /**
   * Stand-in sessions: every agent of alpha running, its status, and what each was told: #650, it follows Combwork's doorbell
   * with cw_inbox, as a model does, and `text` is what it read.
   */
  const fake = (alpha: string) => {
    const state = { status: new Map<string, string>([['b1', 'ready'], ['r1', 'ready'], ['o1', 'ready']]), typed: [] as { agent: string; text: string }[] }
    Object.assign(sessions, {
      liveFor: (p: string, id: string) => (p.toLowerCase() === alpha.toLowerCase() && state.status.has(id) ? ({ projectPath: alpha, agentId: id, status: state.status.get(id), runId: `run-${id}` } as never) : null),
      userMayBeTyping: () => false,
      lineWaiting: () => false,
      // Each line typed is taken, and read (#650: a wake is received then, and noted on its card).
      promptsTaken: (p: string, id: string) => (p.toLowerCase() === alpha.toLowerCase() && state.status.has(id) ? { runId: `run-${id}`, count: state.typed.filter((t) => t.agent === id).length } : null),
      sendPrompt: async (_p: string, id: string, text: string, guard?: () => void) => {
        guard?.()
        state.status.set(id, 'working')
        // Recorded once it has read what the line named, so a check never sees it part way.
        state.typed.push({ agent: id, text: await follow(alpha, id, text) })
      },
      watchChanged: () => undefined
    })
    return state
  }
  const user = { kind: 'user' } as const
  const agent = (id: string, name: string) => ({ kind: 'agent', name: `${name} (alpha)`, self: { project: 'alpha', agentId: id }, scope: 'alpha' }) as const
  const b1 = agent('b1', 'B1')
  const r1 = agent('r1', 'R1')
  // What a change queues comes later (its handoff runs after the change), and a wake tried while another board change
  // lands is kept for later (#560): so a check waits for the outcome, trying the waiting wakes as it polls, never reads
  // once after a try. Waiting gives up after 10 s, not vi.waitFor's 1 s, which four unit suites at once outran (#560):
  // the bound only says when one has hung.
  const HANG = { timeout: 10_000 }
  /** Waits until `count` lines in all were typed, trying the waiting wakes meanwhile. */
  const typedUntil = async (st: { typed: unknown[] }, count: number) =>
    vi.waitFor(async () => {
      await loopWakes.tryLoopWakes()
      expect(st.typed).toHaveLength(count)
    }, HANG)
  /**
   * Waits until what the changes so far started has finished (#570): every handoff worked out and its wake tried, typed,
   * kept or dropped, and the watches' work it led to. Then a check reads the outcome, not a moment.
   */
  const settled = async () => {
    await loopWakes.settled()
    await loopWakes.tryLoopWakes()
    await loopWakes.settled()
  }
  /** Waits until no wake is left waiting (each typed or dropped), trying them meanwhile. */
  const drained = async () =>
    vi.waitFor(async () => {
      await loopWakes.tryLoopWakes()
      expect(loopWakes.pendingLoopWakes()).toEqual([])
    }, HANG)
  const newCard = async (w: Awaited<ReturnType<typeof open>>['w']) => (await inWorkspace(w, () => tasks.createTask({ title: 'Retry', project: 'alpha', agent: 'b1', column: 'doing' }, user))).number
  const history = async (w: Awaited<ReturnType<typeof open>>['w'], c: number) => (await inWorkspace(w, () => tasks.getTask(c, w))).history.map((h) => `${h.by}: ${h.what}`)

  it("wakes a lane's reviewer when the card arrives in Review, and its builder on each verdict, with no watches; noted on the card", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await typedUntil(st, 1)
    expect(st.typed).toEqual([{ agent: 'r1', text: `[CW] #${c} (B1's card) is in Review. You review this card in its loop: carry on with it (cw_read_task with latestComment for the comment in full).` }])
    await vi.waitFor(async () => expect(await history(w, c)).toContain('Combwork: Woke R1 (alpha) to review it (a loop wake)'), HANG)
    // Failed: the builder is woken with the verdict, the card back in Doing (HI-1946).
    st.status.set('r1', 'working')
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, r1, { comment: 'Round 1: FAILED. 1. No delay.' }))
    await typedUntil(st, 2)
    expect(st.typed.at(-1)).toEqual({ agent: 'b1', text: `[CW] #${c} is in Doing: R1 (alpha) failed it; latest comment by R1 (alpha): "Round 1: FAILED. 1. No delay.". This is your card in its loop: carry on (cw_read_task with latestComment for the comment in full).` })
    await vi.waitFor(async () => expect(await history(w, c)).toContain('Combwork: Woke B1 (alpha) with its verdict (a loop wake)'), HANG)
    // Round 2 submitted by the builder: the reviewer again; passed: the builder again.
    st.status.set('r1', 'ready')
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await typedUntil(st, 3)
    expect(st.typed.at(-1)).toEqual({ agent: 'r1', text: `[CW] #${c} (B1's card) is in Review; latest comment by R1 (alpha): "Round 1: FAILED. 1. No delay.". You review this card in its loop: carry on with it (cw_read_task with latestComment for the comment in full).` })
    st.status.set('b1', 'ready')
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'passed', column: 'passed' }, r1, { comment: 'Round 2: PASSED.' }))
    await typedUntil(st, 4)
    expect(st.typed.at(-1)?.agent).toBe('b1')
    expect(st.typed.at(-1)?.text).toMatch(new RegExp(`^\\[CW\\] #${c} is in Passed: R1 \\(alpha\\) passed it; latest comment by R1 \\(alpha\\): "Round 2: PASSED."\\. This is your card in its loop`))
    expect(st.typed).toHaveLength(4)
    await disposeWorkspaceService(w)
  })

  it('never types into a working agent: the wake waits for it to be idle, once, the latest per card', async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    st.status.set('r1', 'working')
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await settled()
    expect(st.typed).toEqual([])
    st.status.set('r1', 'finished')
    await typedUntil(st, 1)
    expect(st.typed.map((t) => t.agent)).toEqual(['r1'])
    await settled()
    expect(st.typed).toHaveLength(1)
    expect(loopWakes.pendingLoopWakes()).toEqual([])
    await disposeWorkspaceService(w)
  })

  it('a card nobody reviews wakes no one; its own change wakes no agent; the last reviewer is its reviewer without a lane', async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    // No lane, never reviewed: no reviewer.
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await settled()
    expect(loopWakes.pendingLoopWakes()).toEqual([])
    // R1 reviews it and fails it (B1 woken); B1 returns it itself: R1, its last reviewer, is woken; B1 isn't.
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, r1, { comment: 'Round 1: FAILED.' }))
    await typedUntil(st, 1)
    expect(st.typed.map((t) => t.agent)).toEqual(['b1'])
    st.status.set('b1', 'ready')
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await typedUntil(st, 2)
    expect(st.typed.map((t) => t.agent)).toEqual(['b1', 'r1'])
    // A reviewer that moves a card into Review itself isn't woken by its own move.
    const d = (await inWorkspace(w, () => tasks.createTask({ title: 'Docs', project: 'alpha', agent: 'b1' }, user))).number
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c, d], by: 'B1 (alpha)' })
    st.status.set('r1', 'ready')
    await inWorkspace(w, () => tasks.updateTask(d, { column: 'review' }, r1))
    await settled()
    expect(st.typed.map((t) => t.agent)).toEqual(['b1', 'r1'])
    await disposeWorkspaceService(w)
  })

  it("leaves it to the agent's own watch: one line, not two", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    st.status.set('r1', 'watching')
    await watches.registerWatch(w, alpha, 'r1', { cards: [c], changes: ['column'], column: 'review' })
    // A fired watch covers the card until its line is typed after Combwork's settle, which this file sets to 0: a handoff
    // later than that found no watch and queued a second line (#560, under load). Here the settle is Combwork's own, as when
    // it runs, so the handoff meets the fired watch.
    watches.testHooks.settleMs = undefined
    try {
      await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.typed).toHaveLength(1), HANG)
    } finally {
      watches.testHooks.settleMs = 0
    }
    await drained()
    await settled()
    expect(st.typed).toHaveLength(1)
    expect(st.typed[0].text).toMatch(/Your card watch has ended/)
    await disposeWorkspaceService(w)
  })

  it('a handoff slower than the watch that told the same arrival types nothing more (#578)', async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    st.status.set('r1', 'watching')
    await watches.registerWatch(w, alpha, 'r1', { cards: [c], changes: ['column'], column: 'review' })
    // The handoff held until the watch has told the arrival and ended, as on a machine too busy to work it out in time.
    let release = (): void => undefined
    const held = new Promise<void>((r) => (release = r))
    loopWakes.testHooks.beforeHandoff = () => held
    // The clock stands still throughout (round 1 finding): every change below has the same time, so only which change
    // the watch told, not when, can tell the arrival it told from the next round's.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    try {
      await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
      await watches.evaluateWatches(w)
      await watches.settled()
      expect(st.typed).toHaveLength(1)
      expect(st.typed[0].text).toMatch(/is in Review.*Your card watch has ended/)
      expect(watches.watchFor(alpha, 'r1')).toBeNull()
      // Idle again, with no watch left to leave it to: the late handoff finds the arrival already told.
      st.status.set('r1', 'ready')
      release()
      await settled()
      expect(st.typed).toHaveLength(1)
      expect(loopWakes.pendingLoopWakes()).toEqual([])
      // A later arrival (the next round) is news the watch never told: the reviewer is woken for it.
      await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
      await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, r1, { comment: 'Round 1: FAILED.' }))
      st.status.set('r1', 'working')
      st.status.set('b1', 'ready')
      // Typed once a try finds the board as its wake was made (#1045: a board change landing as it is offered keeps it
      // for the next try), then nothing more.
      await typedUntil(st, 2)
      await settled()
      expect(st.typed).toHaveLength(2)
      expect(st.typed[1].agent).toBe('b1')
      st.status.set('r1', 'ready')
      await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
      await typedUntil(st, 3)
      await settled()
      expect(st.typed).toHaveLength(3)
      expect(st.typed[2]).toMatchObject({ agent: 'r1', text: expect.stringMatching(/\(B1's card\) is in Review/) })
      expect(loopWakes.pendingLoopWakes()).toEqual([])
    } finally {
      vi.useRealTimers()
      release()
      delete loopWakes.testHooks.beforeHandoff
    }
    await disposeWorkspaceService(w)
  })

  it("goes to whoever reviews it when it is typed: the lane's reviewer changed or taken off while it waited (round 1 finding 1)", async () => {
    // A list changed (or a lane ended) at once, as with workflow rules off: with them on, a change waits for the card boundary (#1270, tests/laneOwnership.test.ts).
    await rulesOff()
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    st.status.set('r1', 'working')
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await vi.waitFor(() => expect(loopWakes.pendingLoopWakes()).toEqual([{ agentId: 'r1', n: c, kind: 'review' }]), HANG)
    // The lane's reviewer is now O1: R1, idle again, gets nothing; O1 gets it.
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'o1', cards: [c], by: 'B1 (alpha)' })
    st.status.set('r1', 'ready')
    await typedUntil(st, 1)
    expect(st.typed.map((t) => t.agent)).toEqual(['o1'])
    expect(st.typed[0].text).toMatch(/You review this card in its loop/)
    // Taken off the lane while O1 works (no reviewer, none before): its wake is dropped, nobody is woken.
    const d = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'o1', cards: [c, d], by: 'B1 (alpha)' })
    st.status.set('o1', 'working')
    await inWorkspace(w, () => tasks.updateTask(d, { column: 'review' }, b1))
    await vi.waitFor(() => expect(loopWakes.pendingLoopWakes()).toEqual([{ agentId: 'o1', n: d, kind: 'review' }]), HANG)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: null, cards: [c, d], by: 'B1 (alpha)' })
    st.status.set('o1', 'ready')
    await drained()
    expect(st.typed.map((t) => t.agent)).toEqual(['o1'])
    await disposeWorkspaceService(w)
  })

  it("cw_inbox gives out a loop wake only while it is still its agent's: the lane's reviewer changed while it waited, it isn't handed out to the old one (#649 round 3)", async () => {
    await loopWakes.clearLoopWakes()
    const deliveries = await import('../src/main/deliveries')
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    // The reviewer works: its wake waits.
    st.status.set('r1', 'working')
    st.status.set('o1', 'working')
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await vi.waitFor(() => expect(loopWakes.pendingLoopWakes()).toEqual([{ agentId: 'r1', n: c, kind: 'review' }]), HANG)
    // The lane's reviewer is O1 now; R1 fetches its inbox.
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'o1', cards: [c], by: 'B1 (alpha)' })
    expect((await deliveries.readInbox(alpha, 'r1')).items).toEqual([])
    expect((await deliveries.deliveriesOf(alpha, 'r1')).map((r) => `${r.state}: ${r.detail}`)).toEqual(["cancelled: it is another agent's wake now"])
    await settled()
    await disposeWorkspaceService(w)
  })

  it('a lane changed while its wake is being typed stops it at once, not when the lanes event comes (#578 round 2)', async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'o1', cards: [c], by: 'B1 (alpha)' })
    // While O1's wake is being typed, the lane loses its reviewer; the guard before the next piece runs straight after.
    const send = sessions.sendPrompt
    let tookOff = false
    sessions.sendPrompt = (async (p: string, id: string, text: string, guard?: () => void) => {
      if (!tookOff) {
        tookOff = true
        await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: null, cards: [c], by: 'B1 (alpha)' })
      }
      return send(p, id, text, guard)
    }) as typeof sessions.sendPrompt
    try {
      await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
      await settled()
      expect(tookOff).toBe(true)
      expect(st.typed).toEqual([])
      expect(loopWakes.pendingLoopWakes()).toEqual([])
    } finally {
      sessions.sendPrompt = send
    }
    await disposeWorkspaceService(w)
  })

  it('another card changing before every send does not starve a loop wake (HI-2486)', async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    const unrelated = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    st.status.set('r1', 'working')
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await settled()
    const send = sessions.sendPrompt
    let attempts = 0
    sessions.sendPrompt = (async (p: string, id: string, text: string, guard?: () => void) => {
      attempts++
      await inWorkspace(w, () => tasks.updateTask(unrelated, {}, user, { comment: `Other work ${attempts}.` }))
      return send(p, id, text, guard)
    }) as typeof sessions.sendPrompt
    try {
      st.status.set('r1', 'ready')
      await loopWakes.tryLoopWakes()
      expect(attempts).toBe(1)
      expect(st.typed).toEqual([{ agent: 'r1', text: expect.stringContaining(`#${c} (B1's card) is in Review`) }])
    } finally {
      sessions.sendPrompt = send
      await drained()
      await settled()
      await disposeWorkspaceService(w)
    }
  })

  it('its own card changing while a wake is being typed still stops that offer (HI-2486)', async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    st.status.set('r1', 'working')
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await settled()
    const send = sessions.sendPrompt
    let changed = false
    sessions.sendPrompt = (async (p: string, id: string, text: string, guard?: () => void) => {
      changed = true
      await inWorkspace(w, () => tasks.updateTask(c, {}, user, { comment: 'New information on this card.' }))
      return send(p, id, text, guard)
    }) as typeof sessions.sendPrompt
    try {
      st.status.set('r1', 'ready')
      await loopWakes.tryLoopWakes()
      expect(changed).toBe(true)
      expect(st.typed).toEqual([])
    } finally {
      sessions.sendPrompt = send
      await drained()
      await settled()
      await disposeWorkspaceService(w)
    }
  })

  it("a builder's watch for Passed alone doesn't stand in for a failed verdict, which leaves the card in Review; it does for a passing one (round 1 finding 2)", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await typedUntil(st, 1)
    expect(st.typed.map((t) => t.agent)).toEqual(['r1'])
    st.status.set('b1', 'watching')
    await watches.registerWatch(w, alpha, 'b1', readCondition({ cards: [c], column: 'passed' }) as WatchCondition)
    // Failed: the watch doesn't fire (still in Review), so Combwork wakes the builder, once.
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, r1, { comment: 'Round 1: FAILED.' }))
    await watches.evaluateWatches(w)
    await typedUntil(st, 2)
    expect(st.typed.map((t) => t.agent)).toEqual(['r1', 'b1'])
    expect(st.typed[1].text).toMatch(/failed it; .*This is your card in its loop/)
    // Its watch still waits for Passed. Returned and passed: the watch tells it, and Combwork doesn't too.
    st.status.set('b1', 'watching')
    st.status.set('r1', 'working')
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'passed', column: 'passed' }, r1, { comment: 'Round 2: PASSED.' }))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.typed.filter((t) => t.agent === 'b1')).toHaveLength(2), HANG)
    await settled()
    const toBuilder = st.typed.filter((t) => t.agent === 'b1')
    expect(toBuilder).toHaveLength(2)
    expect(toBuilder[1].text).toMatch(/Your card watch has ended/)
    expect((await history(w, c)).filter((x) => x === 'Combwork: Woke B1 (alpha) with its verdict (a loop wake)')).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  it("HI-2023: the failed verdict's loop wake says it failed however slowly the verdict's lines are written (the flake under load)", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await typedUntil(st, 1)
    st.status.set('b1', 'watching')
    await watches.registerWatch(w, alpha, 'b1', readCondition({ cards: [c], column: 'passed' }) as WatchCondition)
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    // A loaded machine between the verdict's lines: the clock moves on by a millisecond at each read (HI-2016's cause).
    const RealDate = Date
    let tick = 0
    ;(globalThis as { Date: DateConstructor }).Date = class extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length) super(...(args as [number]))
        else super(RealDate.now() + tick++)
      }
      static now(): number {
        return RealDate.now() + tick++
      }
    } as DateConstructor
    try {
      await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, r1, { comment: 'Round 1: FAILED.' }))
    } finally {
      ;(globalThis as { Date: DateConstructor }).Date = RealDate
    }
    await watches.evaluateWatches(w)
    await typedUntil(st, 2)
    expect(st.typed[1].agent).toBe('b1')
    expect(st.typed[1].text).toMatch(new RegExp(`^\\[CW\\] #${c} is in Doing: R1 \\(alpha\\) failed it; .*This is your card in its loop`))
    await disposeWorkspaceService(w)
  })

  it('a waiting arrival is dropped once that round is reviewed: a review started and failed before the reviewer was idle (round 2 finding)', async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    st.status.set('r1', 'working')
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await vi.waitFor(() => expect(loopWakes.pendingLoopWakes()).toEqual([{ agentId: 'r1', n: c, kind: 'review' }]), HANG)
    // Still working (it had the user's prompt to review it), R1 reviews and fails it: the arrival is told.
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, r1, { comment: 'Round 1: FAILED.' }))
    st.status.set('r1', 'ready')
    await typedUntil(st, 1)
    await drained()
    expect(st.typed.map((t) => t.agent)).toEqual(['b1'])
    // The builder submits it again (HI-1946: from Doing): that new round wakes the reviewer.
    st.status.set('b1', 'ready')
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await typedUntil(st, 2)
    expect(st.typed.map((t) => t.agent)).toEqual(['b1', 'r1'])
    expect(st.typed[1].text).toMatch(/\(B1's card\) is in Review/)
    await disposeWorkspaceService(w)
  })

  it('is off for a project that turned it off before HI-1766, with no workflow options: its old key is read as its own', async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open({ loopWakes: false })
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await settled()
    expect(loopWakes.pendingLoopWakes()).toEqual([])
    expect(st.typed).toEqual([])
    expect(JSON.parse(readFileSync(join(alpha, '.combwork', 'project.json'), 'utf8')).loopWakes).toBe(false)
    await disposeWorkspaceService(w)
  })

  it("follows the workflow option (HI-1766): the workspace's default off reaches its projects, a project's own on wins", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open({ workflow: { platform: 'none', preset: null, options: {} } })
    await w.saveWorkspaceConfigWith(() => ({ workflow: { none: { loopWakes: false }, git: { loopWakes: false } } }))
    expect(await loopWakes.wakesOn(w, alpha)).toBe(false)
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await settled()
    expect(loopWakes.pendingLoopWakes()).toEqual([])
    expect(st.typed).toEqual([])
    await w.mutateProjectConfig(alpha, (cfg) => ({ workflow: { ...cfg.workflow!, options: { ...cfg.workflow!.options, loopWakes: true } } }))
    expect(await loopWakes.wakesOn(w, alpha)).toBe(true)
    await disposeWorkspaceService(w)
  })

  it("a lane reviewer's comment on a card it hasn't started reviewing is its request: the builder is woken with it (#1410)", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const first = (await inWorkspace(w, () => tasks.createTask({ title: 'First', project: 'alpha' }, user))).number
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [first, c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await typedUntil(st, 1)
    st.status.set('b1', 'ready')
    // HR2's comment on 22 Oct: keeping the lane's order, it waits for the earlier card.
    await inWorkspace(w, () => tasks.updateTask(c, {}, r1, { comment: `Keeping the lane order: #${first} first.` }))
    await typedUntil(st, 2)
    expect(st.typed.at(-1)?.agent).toBe('b1')
    expect(st.typed.at(-1)?.text).toContain(`The reviewer asks: "Keeping the lane order: #${first} first."`)
    expect(await history(w, c)).toContain(`R1 (alpha): Asked the builder: "Keeping the lane order: #${first} first."`)
    // Once its review has started, a comment is only a comment (its requests are cw_request_builder's); nor is another agent's.
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(c, {}, r1, { comment: 'Reading the diff.' }))
    await inWorkspace(w, () => tasks.updateTask(c, {}, agent('o1', 'O1'), { comment: 'Looks related to #12.' }))
    await settled()
    expect(st.typed).toHaveLength(2)
    expect((await history(w, c)).filter((h) => h.includes('Asked the builder'))).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  /** A card of alpha's lane (b1 builds, r1 reviews) started by its builder's intent, under a workflow (#1382: steps are intents). */
  const WORKFLOW = { workflow: { platform: 'none', preset: null, options: { review: 'agent', noSelfReview: true } } }
  const startedInLane = async (w: Awaited<ReturnType<typeof open>>['w']) => {
    const c = (await inWorkspace(w, () => tasks.createTask({ title: 'Design first', project: 'alpha' }, user))).number
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'start' }))
    return c
  }
  const { runCardIntent } = await import('../src/main/cardIntents')

  it("a builder's design wakes its reviewer though its watch counts only arrivals in Review; the answer wakes the builder (#1382)", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open(WORKFLOW)
    const st = fake(alpha)
    const c = await startedInLane(w)
    // HR5 on #1305: waiting for the card to arrive in Review, and nothing else.
    st.status.set('r1', 'watching')
    await watches.registerWatch(w, alpha, 'r1', readCondition({ cards: [c], column: 'review' }) as WatchCondition)
    const id = String((await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'loopStep', step: 'design', text: 'Design: a step the reviewer is woken for.' }))).done.data?.design)
    await typedUntil(st, 1)
    expect(st.typed[0].agent).toBe('r1')
    // It names the design, which the answer names.
    expect(st.typed[0].text).toContain(`The builder: "design ${id} posted for your check (answer with its id): Design: a step the reviewer is woken for."`)
    expect(st.typed[0].text).toContain("check it and answer with cw_loop_step (ok, or gaps saying what's missing, and its id)")
    st.status.set('b1', 'ready')
    await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, r1, { kind: 'loopStep', step: 'ok', text: 'Holds: build it.', design: id }))
    await typedUntil(st, 2)
    expect(st.typed[1]).toMatchObject({ agent: 'b1' })
    expect(st.typed[1].text).toContain(`The reviewer: "design ${id} is OK: Holds: build it."`)
    await vi.waitFor(async () => expect(await history(w, c)).toEqual(expect.arrayContaining(['Combwork: Woke R1 (alpha) with a card loop step (a loop wake)', 'Combwork: Woke B1 (alpha) with a card loop step (a loop wake)'])), HANG)
    await disposeWorkspaceService(w)
  })

  it("leaves a step to a watch that counts it: the builder's watch for its verdict tells it the reviewer's answer, one line (#1382)", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open(WORKFLOW)
    const st = fake(alpha)
    const c = await startedInLane(w)
    const id = String((await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'loopStep', step: 'design', text: 'Plan' }))).done.data?.design)
    await typedUntil(st, 1)
    st.status.set('b1', 'watching')
    await watches.registerWatch(w, alpha, 'b1', readCondition({ cards: [c], changes: ['verdict', 'column', 'comment'], column: 'passed' }) as WatchCondition)
    watches.testHooks.settleMs = undefined
    try {
      await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, r1, { kind: 'loopStep', step: 'gaps', text: 'What bounds the wait?', design: id }))
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.typed).toHaveLength(2), HANG)
    } finally {
      watches.testHooks.settleMs = 0
    }
    await drained()
    await settled()
    expect(st.typed).toHaveLength(2)
    expect(st.typed[1].agent).toBe('b1')
    expect(st.typed[1].text).toMatch(/a card loop step: read its latest comment.*Your card watch has ended/)
    await disposeWorkspaceService(w)
  })

  it("a reviewer whose own comment watch tells it of a design learns its id from that line and answers it (#1382, HR4's round 2 finding 1)", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open(WORKFLOW)
    const st = fake(alpha)
    const c = await startedInLane(w)
    st.status.set('r1', 'watching')
    await watches.registerWatch(w, alpha, 'r1', readCondition({ cards: [c], changes: ['comment'] }) as WatchCondition)
    watches.testHooks.settleMs = undefined
    try {
      await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'loopStep', step: 'design', text: 'Design: the id rides in the first line.' }))
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.typed).toHaveLength(1), HANG)
    } finally {
      watches.testHooks.settleMs = 0
    }
    await drained()
    await settled()
    // One line, its watch's: the loop wake stands aside, and the line's latest comment names the design.
    expect(st.typed).toHaveLength(1)
    expect(st.typed[0].text).toMatch(/Your card watch has ended/)
    const learned = /Design (\S+\/s\d+), for the reviewer's check/.exec(st.typed[0].text)?.[1]
    expect(learned).toBeTruthy()
    // So does the card's latest comment, as cw_read_task with latestComment gives it.
    expect((await inWorkspace(w, () => tasks.getTask(c, w))).comments.at(-1)?.text.split('\n')[0]).toContain(learned!)
    // The reviewer answers with what it learned: taken.
    await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, r1, { kind: 'loopStep', step: 'ok', text: 'Holds.', design: learned }))
    expect((await history(w, c)).at(-1)).toBe('R1 (alpha): Checked the design: OK: "Holds."')
    await disposeWorkspaceService(w)
  })

  it("going ahead unchecked tells the reviewer, with nothing to answer (#1382, HR4's round 1 finding 5)", async () => {
    await loopWakes.clearLoopWakes()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { w, alpha } = await open(WORKFLOW)
      const st = fake(alpha)
      const c = await startedInLane(w)
      const id = String((await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'loopStep', step: 'design', text: 'Plan' }))).done.data?.design)
      await typedUntil(st, 1)
      st.status.set('r1', 'ready')
      vi.setSystemTime(Date.now() + 31 * 60_000)
      await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'loopStep', step: 'proceed', text: 'No answer: building as posted.', design: id }))
      await typedUntil(st, 2)
      expect(st.typed[1].agent).toBe('r1')
      expect(st.typed[1].text).toContain(`The builder: "no check of design ${id} came in time: the builder goes ahead with it as posted: No answer: building as posted."`)
      expect(st.typed[1].text).toContain('Nothing to answer: carry on with your loop')
      expect(st.typed[1].text).not.toContain('answer with cw_loop_step')
      await disposeWorkspaceService(w)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * A pool lane's card (HI-2310) started by b1, its first design posted and given by the pool to r1 (the pool's own
   * write, as reviewerPool.ts makes it: its pass isn't running here). Before any submission: the design's answer closes
   * it, and the card has no reviewer until the pool gives out its build (HI-2325).
   */
  const POOL = { agents: [{ id: 'b1', name: 'B1', workflowRole: 'builder' }, { id: 'r1', name: 'R1', workflowRole: 'reviewer' }, { id: 'o1', name: 'O1', workflowRole: 'builder' }], workflow: { platform: 'none', preset: null, options: { review: 'agent', noSelfReview: true, reviewerMode: 'pool' } } }
  const designedInPool = async (w: Awaited<ReturnType<typeof open>>['w'], alpha: string) => {
    const c = (await inWorkspace(w, () => tasks.createTask({ title: 'Pool design', project: 'alpha' }, user))).number
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: null, pool: true, cards: [c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'start' }))
    const id = String((await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'loopStep', step: 'design', text: 'Plan' }))).done.data?.design)
    const wf = (await workflowFor(w, alpha))!
    const rec = wf.store.card(c)
    const submission = wf.store.facts(c).findLast((f) => f.kind === 'LoopStep')!.seq
    await wf.write(rec, null, 'combwork', (x) => void x.fact('ReviewerAssigned', { reviewer: 'r1', submission, design: true }))
    expect((await loopReviewerOf(w, await inWorkspace(w, () => tasks.getTask(c, w))))?.id).toBe('r1')
    return { c, id }
  }
  const { workflowFor } = await import('../src/main/workflow/service')
  const { loopReviewerOf } = await import('../src/main/loopReviewer')
  const { reviewDueOf } = await import('../src/main/cardStall')

  it('a pool card waiting in Review is owed by the reviewer the pool gave it, nobody before (HI-2636)', async () => {
    await loopWakes.clearLoopWakes()
    // A pool lane is the lane's; the review rules are WORKFLOW's (HI-2428's test, below).
    const { w, alpha } = await open({ ...WORKFLOW, agents: POOL.agents })
    fake(alpha)
    const c = (await inWorkspace(w, () => tasks.createTask({ title: 'Pool review', project: 'alpha' }, user))).number
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: null, pool: true, cards: [c], by: 'B1 (alpha)' })
    const intent = (who: typeof b1, i: Parameters<typeof runCardIntent>[2]) => inWorkspace(w, () => runCardIntent({ n: c, plain: false }, who, i))
    await intent(b1, { kind: 'start' })
    await intent(b1, { kind: 'submit', summary: 'Ready', paths: ['a.txt'] })
    const now = () => inWorkspace(w, () => tasks.getTask(c, w))
    expect((await now()).column).toBe('review')
    // Not given out yet: nobody owes it, so no watcher (a builder watching it for Done) is named.
    expect(await reviewDueOf(w, await now())).toEqual({ owed: null })
    // Given to R1 (the pool's own write, as reviewerPool.ts makes it: its pass isn't running here).
    const wf = (await workflowFor(w, alpha))!
    const submission = wf.store.facts(c).findLast((f) => f.kind === 'Submitted')!.seq
    await wf.write(wf.store.card(c), null, 'combwork', (x) => void x.fact('ReviewerAssigned', { reviewer: 'r1', submission }))
    const givenAt = wf.store.facts(c).findLast((f) => f.kind === 'ReviewerAssigned')!.at
    expect(await reviewDueOf(w, await now())).toMatchObject({ owed: { agentId: 'r1', name: 'R1', givenAt } })
    // Its review started: the check can't stall it on the wait, so nothing is read.
    await intent(r1, { kind: 'startReview' })
    expect(await reviewDueOf(w, await now())).toBeUndefined()
    await disposeWorkspaceService(w)
  })

  it.each(['ok', 'gaps'] as const)("a pool design's %s answer before any submission wakes its builder, with no watch (HI-2325)", async (step) => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open(POOL)
    const st = fake(alpha)
    const { c, id } = await designedInPool(w, alpha)
    await settled()
    // The pool tells its design's reviewer itself: no loop wake.
    expect(st.typed).toEqual([])
    await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, r1, { kind: 'loopStep', step, text: 'Answered.', design: id }))
    // Closed by its answer: the card has no reviewer until its build is given out, and none is made the owner meanwhile.
    expect(await loopReviewerOf(w, await inWorkspace(w, () => tasks.getTask(c, w)))).toBeNull()
    await typedUntil(st, 1)
    expect(st.typed[0].agent).toBe('b1')
    expect(st.typed[0].text).toContain(`design ${id}`)
    await vi.waitFor(async () => expect(await history(w, c)).toContain('Combwork: Woke B1 (alpha) with a card loop step (a loop wake)'), HANG)
    await disposeWorkspaceService(w)
  })

  it("a pool design's builder going ahead unchecked tells the reviewer the pool gave it, with no watch (HI-2325)", async () => {
    await loopWakes.clearLoopWakes()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { w, alpha } = await open(POOL)
      const st = fake(alpha)
      const { c, id } = await designedInPool(w, alpha)
      vi.setSystemTime(Date.now() + 31 * 60_000)
      await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'loopStep', step: 'proceed', text: 'No answer: building as posted.', design: id }))
      await typedUntil(st, 1)
      expect(st.typed[0].agent).toBe('r1')
      expect(st.typed[0].text).toContain(`no check of design ${id} came in time`)
      await disposeWorkspaceService(w)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a design to check is dropped once nothing waits: posted again, the newer one is told, not the older (#1382)', async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open(WORKFLOW)
    const st = fake(alpha)
    const c = await startedInLane(w)
    // The reviewer is busy: its wakes wait.
    st.status.set('r1', 'working')
    await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'loopStep', step: 'design', text: 'Design v1' }))
    const v2 = String((await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'loopStep', step: 'design', text: 'Design v2' }))).done.data?.design)
    await settled()
    st.status.set('r1', 'ready')
    await typedUntil(st, 1)
    await drained()
    expect(st.typed[0].text).toContain(`design ${v2} posted for your check`)
    expect(st.typed[0].text).not.toContain('Design v1')
    // Answered by the user meanwhile: a waiting design wake has nothing left to ask.
    st.status.set('r1', 'working')
    const v3 = String((await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'loopStep', step: 'design', text: 'Design v3' }))).done.data?.design)
    await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, user, { kind: 'loopStep', step: 'ok', text: 'Fine by me', design: v3 }))
    await settled()
    st.status.set('r1', 'ready')
    await drained()
    expect(st.typed.filter((t) => t.agent === 'r1')).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  it("a follow-up of a card in Passed wakes its reviewer though its watch counts only Review; the answer wakes the builder (#1467)", async () => {
    await loopWakes.clearLoopWakes()
    // A workflow whose passed work waits in Passed (for the user's OK too), as a card waiting to be merged does.
    const { w, alpha } = await open({ workflow: { ...WORKFLOW.workflow, options: { review: 'agentThenYou', noSelfReview: true } } })
    const st = fake(alpha)
    const c = await startedInLane(w)
    const intent = (who: typeof b1, i: Parameters<typeof runCardIntent>[2]) => inWorkspace(w, () => runCardIntent({ n: c, plain: false }, who, i))
    await intent(b1, { kind: 'submit', summary: 'Ready', paths: ['a.txt'] })
    await intent(r1, { kind: 'startReview' })
    await intent(r1, { kind: 'verdict', pass: true, comment: 'Round 1: PASSED.' })
    await drained()
    await settled()
    const k = st.typed.length
    // HR3 on #1419: the screenshot OK asked for changes for it to check, and it waited for the card's move into Review.
    st.status.set('r1', 'watching')
    await watches.registerWatch(w, alpha, 'r1', readCondition({ cards: [c], column: 'review' }) as WatchCondition)
    const id = String((await intent(b1, { kind: 'loopStep', step: 'followUp', text: 'Fixes ready: the dark theme.' })).done.data?.design)
    await typedUntil(st, k + 1)
    expect(st.typed[k].agent).toBe('r1')
    expect(st.typed[k].text).toContain(`The builder: "follow-up ${id} ready for your check (answer with its id): Fixes ready: the dark theme."`)
    expect(st.typed[k].text).toContain("check it and answer with cw_loop_step (ok, or gaps saying what's missing, and its id)")
    st.status.set('b1', 'ready')
    await intent(r1, { kind: 'loopStep', step: 'ok', text: 'Both themes fine.', design: id })
    await typedUntil(st, k + 2)
    expect(st.typed[k + 1]).toMatchObject({ agent: 'b1' })
    expect(st.typed[k + 1].text).toContain(`The reviewer: "follow-up ${id} is OK: Both themes fine."`)
    expect(await history(w, c)).toContain('R1 (alpha): Checked the follow-up: OK: "Both themes fine."')
    await disposeWorkspaceService(w)
  })

  it("a follow-up's wake and stall outlast its card's change of place in Passed (HR4's round 1 finding on #1467)", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open({ workflow: { ...WORKFLOW.workflow, options: { review: 'agentThenYou', noSelfReview: true } } })
    const st = fake(alpha)
    const c = await startedInLane(w)
    const intent = (who: typeof b1, i: Parameters<typeof runCardIntent>[2]) => inWorkspace(w, () => runCardIntent({ n: c, plain: false }, who, i))
    await intent(b1, { kind: 'submit', summary: 'Ready', paths: ['a.txt'] })
    await intent(r1, { kind: 'startReview' })
    await intent(r1, { kind: 'verdict', pass: true, comment: 'Round 1: PASSED.' })
    // Another card waiting in Passed, below it.
    await inWorkspace(w, () => tasks.createTask({ title: 'Also passed', project: 'alpha', column: 'passed' }, user))
    await drained()
    await settled()
    const k = st.typed.length
    // The reviewer is busy when the follow-up comes; the builder then puts its card below the other one.
    st.status.set('r1', 'working')
    const posted = await intent(b1, { kind: 'loopStep', step: 'followUp', text: 'Fixes ready.' })
    await inWorkspace(w, () => tasks.updateTask(c, { position: 'bottom' }, b1))
    const now = await inWorkspace(w, () => tasks.getTask(c, w))
    expect(now.column).toBe('passed')
    expect(now.history.at(-1)?.what).toBe('Moved to the bottom of Passed')
    // Still waiting: so is its stall, aged from the follow-up, with the builder only watching it.
    const { loopStepWaitReason } = await import('../src/shared/tasks')
    const hb = { name: 'B1', project: 'alpha', agentId: 'b1', cards: [c], status: 'watching' }
    const at = Date.parse(now.history.findLast((h) => h.what.startsWith('Posted a follow-up'))!.at)
    expect(loopStepWaitReason(now, [hb], 30 * 60_000, at + 16 * 60_000)).toMatch(/posted a follow-up .* has waited 16 min:/)
    // And its wake is still due: the reviewer, once free, is told.
    st.status.set('r1', 'ready')
    await typedUntil(st, k + 1)
    expect(st.typed[k].agent).toBe('r1')
    expect(st.typed[k].text).toContain(`follow-up ${String(posted.done.data?.design)} ready for your check`)
    await disposeWorkspaceService(w)
  })

  it("a reviewer waiting for a failed card's next round (fresh) hears a follow-up from its own watch, one line (#1467)", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open({ workflow: { ...WORKFLOW.workflow, options: { review: 'agentThenYou', noSelfReview: true } } })
    const st = fake(alpha)
    const c = await startedInLane(w)
    const intent = (who: typeof b1, i: Parameters<typeof runCardIntent>[2]) => inWorkspace(w, () => runCardIntent({ n: c, plain: false }, who, i))
    await intent(b1, { kind: 'submit', summary: 'Ready', paths: ['a.txt'] })
    await intent(r1, { kind: 'startReview' })
    await intent(r1, { kind: 'verdict', pass: true, comment: 'Round 1: PASSED.' })
    await drained()
    await settled()
    const k = st.typed.length
    st.status.set('r1', 'watching')
    await watches.registerWatch(w, alpha, 'r1', readCondition({ cards: [c], column: 'review', fresh: true }) as WatchCondition)
    watches.testHooks.settleMs = undefined
    try {
      await intent(b1, { kind: 'loopStep', step: 'followUp', text: 'Fixes ready.' })
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.typed).toHaveLength(k + 1), HANG)
    } finally {
      watches.testHooks.settleMs = 0
    }
    await drained()
    await settled()
    // Its watch's line, naming the follow-up in the latest comment; the loop wake stands aside.
    expect(st.typed).toHaveLength(k + 1)
    expect(st.typed[k].agent).toBe('r1')
    expect(st.typed[k].text).toMatch(/Follow-up \S+\/s\d+, for the reviewer's check.*Your card watch has ended/)
    await disposeWorkspaceService(w)
  })

  it("a step wakes no one while the project's loop wakes are off (#1382)", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open({ ...WORKFLOW, loopWakes: false })
    const st = fake(alpha)
    const c = await startedInLane(w)
    await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'loopStep', step: 'design', text: 'Plan' }))
    await settled()
    expect(loopWakes.pendingLoopWakes()).toEqual([])
    expect(st.typed).toEqual([])
    await disposeWorkspaceService(w)
  })

  // HI-1687: the Stop hook named a loop wake (m4790) that cw_inbox wouldn't give, nor ack: the read made it again, then
  // found the board changed (any card's change) by its hand-out, and kept it unread. Now a notice names only what a read
  // would give (deliveries.countable, which makes nothing again), and a read's hand-out asks only whether this wake's own
  // card, lanes and project changed: another card's change doesn't keep it from being read, a change of its own does.
  describe('a card the merge queue returned (HI-1721)', async () => {
    const deliveries = await import('../src/main/deliveries')
    /** A wake as wakeFromAction makes the queue's return: a note, anchored at the card's latest entry (the return writes none). */
    const queueReturnWake = async (w: Awaited<ReturnType<typeof open>>['w'], alpha: string, c: number, text: string) => {
      const card = await inWorkspace(w, () => tasks.getTask(c, w))
      const since = card.history.at(-1)!
      await deliveries.createDelivery(alpha, { agentId: 'b1', agentName: 'B1 (alpha)', kind: 'card-event', from: { kind: 'combwork', name: 'Combwork' }, card: c, body: `[CW] #${c}: ${text}`, source: 'loop', ref: `#${c}`, replace: true, meta: { n: c, kind: 'note', agentName: 'B1 (alpha)', sinceAt: since.at, sinceId: since.id ?? '', text } })
    }

    it("HI-1694's sequence: the builder's watch told it the pass; the return comes, and a watch for Done begins before it reads it: the return is still given, and the builder told of the conflict", async () => {
      await loopWakes.clearLoopWakes()
      const { w, alpha } = await open()
      const st = fake(alpha)
      const c = await newCard(w)
      await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
      await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
      await typedUntil(st, 1)
      // B1 watches for its verdict; R1 passes it: the watch's line tells B1 the card is in Passed (its told boundary).
      st.status.set('b1', 'watching')
      await watches.registerWatch(w, alpha, 'b1', { cards: [c], changes: ['verdict', 'column', 'comment'], column: 'passed' })
      st.status.set('r1', 'working')
      await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
      await inWorkspace(w, () => tasks.updateTask(c, { review: 'passed', column: 'passed' }, r1, { comment: 'Round 1: PASSED.' }))
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.typed.filter((t) => t.agent === 'b1').map((t) => t.text).join('\n')).toMatch(/is in Passed/), HANG)
      await settled()
      const before = st.typed.length
      // The queue returns it with a conflict (a wake anchored at the entry B1's watch has read), and B1, still acting on
      // the pass, starts a watch for Done before it reads that.
      const conflict = `#${c} came back from the merge queue: a conflict with main in src/a.ts. Merge main into your worktree, resolve the conflict, commit and submit again (cw_submit).`
      st.status.set('b1', 'watching')
      await queueReturnWake(w, alpha, c, conflict)
      await watches.registerWatch(w, alpha, 'b1', { cards: [c], changes: ['column'], column: 'done' })
      await typedUntil(st, before + 1)
      expect(st.typed.at(-1)).toMatchObject({ agent: 'b1', text: expect.stringContaining('came back from the merge queue: a conflict with main in src/a.ts') })
      await disposeWorkspaceService(w)
    })

    it('a watch begun on its own returned card for another column tells the builder of the return at once, from the card as it is; not one for Doing, nor another agent\'s card', async () => {
      await loopWakes.clearLoopWakes()
      const { w, alpha } = await open()
      const st = fake(alpha)
      const c = await newCard(w)
      await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
      const text = `#${c} came back from the merge queue: a conflict with main in src/b.ts. Merge main into your worktree, resolve the conflict, commit and submit again (cw_submit).`
      returns.set(c, { at: new Date().toISOString(), text, builder: 'b1' })
      try {
        // For Doing (where it already waits): nothing more; R1 watching it: not R1's card to fix.
        st.status.set('r1', 'watching')
        await watches.registerWatch(w, alpha, 'r1', { cards: [c], changes: ['column'], column: 'done' })
        st.status.set('b1', 'watching')
        await watches.registerWatch(w, alpha, 'b1', { cards: [c], changes: ['column'], column: 'doing' })
        await settled()
        expect(st.typed).toEqual([])
        // For Done: told of the return now.
        await watches.registerWatch(w, alpha, 'b1', { cards: [c], changes: ['column'], column: 'done' })
        await typedUntil(st, 1)
        expect(st.typed[0]).toMatchObject({ agent: 'b1', text: expect.stringContaining('came back from the merge queue: a conflict with main in src/b.ts') })
      } finally {
        returns.delete(c)
      }
      await disposeWorkspaceService(w)
    })

    it("HI-2122's sequence (HI-2143): the reviewer's watch on any move, begun before its pass; returned and submitted again, the card wakes the reviewer once, led by the return", async () => {
      await loopWakes.clearLoopWakes()
      await rulesOff()
      const { w, alpha } = await open()
      const st = fake(alpha)
      const c = await newCard(w)
      await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
      await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
      await typedUntil(st, 1)
      // R1 reviews, starts its watch on any move of the card (HR2's: changes column, no column), then passes it.
      st.status.set('r1', 'working')
      await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
      await watches.registerWatch(w, alpha, 'r1', { cards: [c], changes: ['column'] })
      await inWorkspace(w, () => tasks.updateTask(c, { review: 'passed', column: 'passed' }, r1, { comment: 'Round 1: PASSED.' }))
      st.status.set('r1', 'watching')
      // The queue returns it to Doing in its approver's name, as it does.
      await inWorkspace(w, () => tasks.updateTask(c, { column: 'doing' }, r1))
      await watches.evaluateWatches(w)
      await settled()
      const before = st.typed.filter((t) => t.agent === 'r1').length
      const text = `#${c} is back in Review after the merge queue returned it (a conflict with main in src/a.ts (1 conflict, line 4)); B1 resolved it and submitted it again: review the resolution`
      resubmits.set(c, text)
      try {
        // B1 resolves it and submits again: R1, back to waiting on it, is woken once, led by the return.
        await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
        await watches.evaluateWatches(w)
        await vi.waitFor(async () => {
          await loopWakes.tryLoopWakes()
          expect(st.typed.filter((t) => t.agent === 'r1')).toHaveLength(before + 1)
        }, HANG)
        await settled()
        const toR1 = st.typed.filter((t) => t.agent === 'r1')
        expect(toR1).toHaveLength(before + 1)
        expect(toR1.at(-1)!.text).toContain(`[CW] ${text}`)
        expect(toR1.at(-1)!.text).not.toContain('Round 1: PASSED')
      } finally {
        resubmits.delete(c)
      }
      await disposeWorkspaceService(w)
    })

    it("the user's answer stays due until the agent reads it, though it acted on the card meanwhile (HI-1694's m4917)", async () => {
      await loopWakes.clearLoopWakes()
      const { w, alpha } = await open()
      const st = fake(alpha)
      const c = await newCard(w)
      await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
      const card = await inWorkspace(w, () => tasks.getTask(c, w))
      const since = card.history.at(-1)!
      st.status.set('b1', 'working')
      await deliveries.createDelivery(alpha, { agentId: 'b1', agentName: 'B1 (alpha)', kind: 'answer', from: { kind: 'user', name: 'the user' }, card: c, body: 'Defender excludes Tools.', source: 'loop', ref: `#${c}/answer`, meta: { n: c, kind: 'answer', agentName: 'B1 (alpha)', sinceAt: since.at, sinceId: since.id ?? '', text: 'Defender excludes Tools.', to: 'b1' } })
      // B1 submits its next round before it reads the answer.
      await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
      st.status.set('b1', 'ready')
      await vi.waitFor(async () => {
        await loopWakes.tryLoopWakes()
        expect(st.typed.filter((t) => t.agent === 'b1').map((t) => t.text).join('\n')).toContain('Defender excludes Tools.')
      }, HANG)
      await disposeWorkspaceService(w)
    })
  })

  describe('what the notices name, cw_inbox gives (HI-1687)', async () => {
    const deliveries = await import('../src/main/deliveries')
    const { noticeFor } = await import('../src/main/inboxNotices')
    const liveOf = (alpha: string, agentId: string) => ({ projectPath: alpha, agentId, sessionId: null }) as never
    const idsIn = (text: string | null): string[] => [...(text ?? '').matchAll(/\bm\d+\b/g)].map((m) => m[0])
    const given = (read: { items: { ids: string[] }[] }): string[] => read.items.flatMap((i) => i.ids)
    const loopOf = async (alpha: string, agentId: string) => (await deliveries.deliveriesOf(alpha, agentId)).filter((r) => r.source === 'loop')
    /** The builder working while its card passes: its verdict's wake waits in its inbox, made once by a read that gave it nothing. */
    const passedWhileWorking = async () => {
      await loopWakes.clearLoopWakes()
      await rulesOff()
      const { w, alpha } = await open()
      const st = fake(alpha)
      const c = await newCard(w)
      const later = await newCard(w)
      const unrelated = await newCard(w)
      const lane = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c, later], by: 'B1 (alpha)' })).lane
      st.status.set('b1', 'working')
      st.status.set('r1', 'working')
      st.status.set('o1', 'working')
      await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
      await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
      await inWorkspace(w, () => tasks.updateTask(c, { review: 'passed', column: 'passed' }, r1, { comment: 'Round 1: PASSED.' }))
      await vi.waitFor(async () => expect((await loopOf(alpha, 'b1')).filter((r) => r.state === 'queued')).toHaveLength(1), HANG)
      const [wake] = await loopOf(alpha, 'b1')
      return { w, alpha, st, c, later, unrelated, lane, wake }
    }
    afterEach(() => {
      deliveries.setBeforePlanForTests(null)
      loopWakes.loopWakeTestHooks.afterKey = null
    })

    it('another card changes while cw_inbox reads it: it is given and acked, and the Stop hook named nothing a read would not give', async () => {
      const { w, alpha, unrelated, wake } = await passedWhileWorking()
      const named = idsIn(await noticeFor(liveOf(alpha, 'b1'), 'drain'))
      let changed = false
      deliveries.setBeforePlanForTests(async () => {
        if (changed) return
        changed = true
        await inWorkspace(w, () => tasks.updateTask(unrelated, {}, user, { comment: 'Another lane at work.' }))
      })
      const read = await deliveries.readInbox(alpha, 'b1')
      expect(changed).toBe(true)
      expect(given(read)).toEqual([wake.id])
      expect(named.every((id) => given(read).includes(id))).toBe(true)
      expect((await deliveries.ackDeliveries(alpha, 'b1', [wake.id])).acked).toEqual([wake.id])
      await settled()
      await disposeWorkspaceService(w)
    })

    it('once made, the Stop hook names it, and a read made again after its own card changed gives it', async () => {
      const { w, alpha, c, wake } = await passedWhileWorking()
      // Made by a read held back once (the card itself changed between its making and its hand-out): named now.
      let changed = false
      deliveries.setBeforePlanForTests(async () => {
        if (changed) return
        changed = true
        await inWorkspace(w, () => tasks.updateTask(c, {}, user, { comment: 'A note on the card itself.' }))
      })
      const read = await deliveries.readInbox(alpha, 'b1')
      expect(changed).toBe(true)
      // Its own card changed: made again (the next attempt), then given.
      expect(given(read)).toEqual([wake.id])
      await settled()
      await disposeWorkspaceService(w)
    })

    it("the lane's reviewer changes after a reviewer's wake is made and before its hand-out: the old reviewer gets nothing", async () => {
      await loopWakes.clearLoopWakes()
      await rulesOff()
      const { w, alpha } = await open()
      const st = fake(alpha)
      const c = await newCard(w)
      await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
      st.status.set('r1', 'working')
      st.status.set('o1', 'working')
      await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
      await vi.waitFor(async () => expect((await loopOf(alpha, 'r1')).filter((r) => r.state === 'queued')).toHaveLength(1), HANG)
      let changed = false
      deliveries.setBeforePlanForTests(async () => {
        if (changed) return
        changed = true
        await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'o1', cards: [c], by: 'B1 (alpha)' })
      })
      expect(given(await deliveries.readInbox(alpha, 'r1'))).toEqual([])
      expect(changed).toBe(true)
      expect((await loopOf(alpha, 'r1')).map((r) => `${r.state}: ${r.detail}`)).toEqual(["cancelled: it is another agent's wake now"])
      expect(idsIn(await noticeFor(liveOf(alpha, 'r1'), 'drain'))).toEqual([])
      await settled()
      await disposeWorkspaceService(w)
    })

    it('the card changes while its wake is made again (before the read reaches the hand-out): that version is not given; the next one is', async () => {
      const { w, alpha, c, wake } = await passedWhileWorking()
      let changed = false
      loopWakes.loopWakeTestHooks.afterKey = async () => {
        if (changed) return
        changed = true
        await inWorkspace(w, () => tasks.updateTask(c, {}, user, { comment: 'Changed while it was made.' }))
      }
      const read = await deliveries.readInbox(alpha, 'b1')
      expect(changed).toBe(true)
      expect(given(read)).toEqual([wake.id])
      // The version given is the one made after the change, not the one made across it.
      expect((await deliveries.deliveriesOf(alpha, 'b1')).find((r) => r.id === wake.id)?.meta?.v).not.toBe(undefined)
      await settled()
      await disposeWorkspaceService(w)
    })

    it("a Done card's step whose lane ends before its hand-out is dropped as no longer due, and never named", async () => {
      await loopWakes.clearLoopWakes()
      await rulesOff()
      const { w, alpha } = await open()
      const st = fake(alpha)
      const c = await newCard(w)
      const lane = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })).lane
      st.status.set('b1', 'working')
      st.status.set('r1', 'working')
      await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
      await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
      await inWorkspace(w, () => tasks.updateTask(c, { review: 'passed', column: 'done' }, r1, { comment: 'Round 1: PASSED.' }))
      await vi.waitFor(async () => expect((await loopOf(alpha, 'b1')).filter((r) => r.state === 'queued')).toHaveLength(1), HANG)
      let ended = false
      deliveries.setBeforePlanForTests(async () => {
        if (ended) return
        ended = true
        await lanes.endLane(w, lane.id, {})
      })
      expect(given(await deliveries.readInbox(alpha, 'b1'))).toEqual([])
      expect(ended).toBe(true)
      expect((await loopOf(alpha, 'b1')).map((r) => `${r.state}: ${r.detail}`)).toEqual(['cancelled: no longer due'])
      expect(idsIn(await noticeFor(liveOf(alpha, 'b1'), 'drain'))).toEqual([])
      await settled()
      await disposeWorkspaceService(w)
    })

    it('counting changes nothing: no version made, no wake for the new recipient, and a read in progress still gives it', async () => {
      const { w, alpha, c, later, wake } = await passedWhileWorking()
      // The lane's reviewer changes (a builder's wake stays the builder's), and the notices count, again and again.
      await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'o1', cards: [c, later], by: 'B1 (alpha)' })
      const snapshot = async () => JSON.stringify(await Promise.all(['b1', 'r1', 'o1'].map(async (a) => (await deliveries.deliveriesOf(alpha, a)).map((r) => [r.id, r.state, r.meta?.v ?? null]))))
      const before = await snapshot()
      let counted = 0
      deliveries.setBeforePlanForTests(async () => {
        // While the read waits at its hand-out: the notices count for both agents.
        for (let i = 0; i < 3; i++) for (const a of ['b1', 'o1']) await noticeFor(liveOf(alpha, a), i % 2 ? 'checkpoint' : 'drain')
        counted++
      })
      for (let i = 0; i < 3; i++) for (const a of ['b1', 'o1']) await noticeFor(liveOf(alpha, a), 'drain')
      expect(await snapshot()).toBe(before)
      const read = await deliveries.readInbox(alpha, 'b1')
      expect(counted).toBeGreaterThan(0)
      expect(given(read)).toEqual([wake.id])
      await settled()
      await disposeWorkspaceService(w)
    })
  })

  it("a builder's comment after its reviewer's in the round is its reply: the reviewer is woken with it (HI-2302)", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await typedUntil(st, 1)
    expect(st.typed[0].agent).toBe('r1')
    st.status.set('r1', 'ready')
    // A builder's comment before its reviewer said anything this round is only a comment.
    await inWorkspace(w, () => tasks.updateTask(c, {}, b1, { comment: 'The run record is in the summary.' }))
    // PE-39: the reviewer, reviewing, asks for the logs; the builder answers.
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(c, {}, r1, { comment: 'Please attach the e2e logs.' }))
    await inWorkspace(w, () => tasks.updateTask(c, {}, b1, { comment: 'Logs attached: run-12.' }))
    await typedUntil(st, 2)
    expect(st.typed[1].agent).toBe('r1')
    expect(st.typed[1].text).toContain('The builder replies: "Logs attached: run-12."')
    expect(st.typed[1].text).toContain('You review this card in its loop: carry on with your review')
    const h = await history(w, c)
    expect(h.filter((x) => x.includes('Replied to the reviewer'))).toEqual(['B1 (alpha): Replied to the reviewer: "Logs attached: run-12."'])
    await vi.waitFor(async () => expect(await history(w, c)).toContain('Combwork: Woke R1 (alpha) with a card loop step (a loop wake)'), HANG)
    // Another agent's comment is no reply, nor the reviewer's own.
    await inWorkspace(w, () => tasks.updateTask(c, {}, agent('o1', 'O1'), { comment: 'Looks related to #12.' }))
    await inWorkspace(w, () => tasks.updateTask(c, {}, r1, { comment: 'Thanks, reading them.' }))
    await settled()
    expect(st.typed).toHaveLength(2)
    expect((await history(w, c)).filter((x) => x.includes('Replied to the reviewer'))).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  it.each(['pool', 'paired'] as const)("a %s reviewer that asked with cw_request_builder and ended its turn is woken by each answer of its builder (HI-2428)", async (mode) => {
    await loopWakes.clearLoopWakes()
    // A pool lane is the lane's (its card's reviewerPool); the review rules are WORKFLOW's, which take no reviewerMode here.
    const { w, alpha } = await open({ ...WORKFLOW, ...(mode === 'pool' ? { agents: POOL.agents } : {}) })
    const st = fake(alpha)
    const c = (await inWorkspace(w, () => tasks.createTask({ title: 'Asked for a run', project: 'alpha' }, user))).number
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: mode === 'pool' ? null : 'r1', ...(mode === 'pool' ? { pool: true } : {}), cards: [c], by: 'B1 (alpha)' })
    const intent = (who: typeof b1, i: Parameters<typeof runCardIntent>[2]) => inWorkspace(w, () => runCardIntent({ n: c, plain: false }, who, i))
    await intent(b1, { kind: 'start' })
    await intent(b1, { kind: 'submit', summary: 'Ready', paths: ['a.txt'] })
    if (mode === 'pool') {
      // The pool's own assignment, as reviewerPool.ts writes it (its pass isn't running here).
      const wf = (await workflowFor(w, alpha))!
      const submission = wf.store.facts(c).findLast((f) => f.kind === 'Submitted')!.seq
      await wf.write(wf.store.card(c), null, 'combwork', (x) => void x.fact('ReviewerAssigned', { reviewer: 'r1', submission }))
    }
    await intent(r1, { kind: 'startReview' })
    await drained()
    await settled()
    const k = st.typed.length
    st.status.set('b1', 'ready')
    st.status.set('r1', 'ready')
    // HI-2410: the reviewer asks for a full run, and ends its turn with no watch.
    await intent(r1, { kind: 'request', text: 'Please post a full npm test record.' })
    await typedUntil(st, k + 1)
    expect(st.typed[k].agent).toBe('b1')
    // The builder answers at once, then posts the result later as a plain comment: each a comment alone, as
    // cw_update_task with only a comment writes it (commentTask, which HI-2302's reply missed).
    await inWorkspace(w, () => tasks.commentTask(c, "@R1: you're right, running it now.", b1))
    await typedUntil(st, k + 2)
    expect(st.typed[k + 1].agent).toBe('r1')
    expect(st.typed[k + 1].text).toContain(`The builder replies: "@R1: you're right, running it now."`)
    st.status.set('r1', 'ready')
    await inWorkspace(w, () => tasks.commentTask(c, 'Full run: 8948 passed, log attached.', b1))
    await typedUntil(st, k + 3)
    expect(st.typed[k + 2].agent).toBe('r1')
    expect(st.typed[k + 2].text).toContain('The builder replies: "Full run: 8948 passed, log attached."')
    expect((await history(w, c)).filter((x) => x.includes('Replied to the reviewer'))).toHaveLength(2)
    // Its verdict closes the round: a comment after it, in Passed, wakes nobody.
    await intent(r1, { kind: 'verdict', pass: true, comment: 'Round 1: PASSED.' })
    await settled()
    const after = st.typed.length
    await inWorkspace(w, () => tasks.commentTask(c, 'Thanks.', b1))
    await settled()
    expect(st.typed.slice(after).filter((t) => t.agent === 'r1')).toEqual([])
    await disposeWorkspaceService(w)
  })

  it("a lane reviewer's comment alone, before its review, is its request to the builder (HI-2428, #1410)", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await typedUntil(st, 1)
    st.status.set('b1', 'ready')
    await inWorkspace(w, () => tasks.commentTask(c, 'Waiting for #12 first: rebase on it.', r1))
    await typedUntil(st, 2)
    expect(st.typed[1].agent).toBe('b1')
    expect(await history(w, c)).toContain('R1 (alpha): Asked the builder: "Waiting for #12 first: rebase on it."')
    await disposeWorkspaceService(w)
  })

  it("a builder's reply is only a comment while the project's loop wakes are off (HI-2302)", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open({ loopWakes: false })
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(c, {}, r1, { comment: 'Please attach the e2e logs.' }))
    await inWorkspace(w, () => tasks.updateTask(c, {}, b1, { comment: 'Logs attached.' }))
    await settled()
    expect(st.typed).toEqual([])
    expect((await history(w, c)).some((h) => h.includes('Replied to the reviewer'))).toBe(false)
    await disposeWorkspaceService(w)
  })

  it("a lane reviewer's comment is only a comment while the project's loop wakes are off (#1410)", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open({ loopWakes: false })
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await inWorkspace(w, () => tasks.updateTask(c, {}, r1, { comment: 'Waiting for the earlier card.' }))
    await settled()
    expect(st.typed).toEqual([])
    expect((await history(w, c)).some((h) => h.includes('Asked the builder'))).toBe(false)
    await disposeWorkspaceService(w)
  })

  it("a builder's Done wake in its lane names the lane's next card: Combwork starts it with the rules on, the builder with them off (HI-1990)", async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await newCard(w)
    const next = (await inWorkspace(w, () => tasks.createTask({ title: 'Show progress', project: 'alpha', agent: 'b1' }, user))).number
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c, next], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'done' }, user))
    await typedUntil(st, 1)
    expect(st.typed).toEqual([{ agent: 'b1', text: `[CW] #${c} is in Done. Your lane's next card is #${next} ("Show progress"): Combwork starts it for you once your turn ends, so end your turn now (cw_read_task with latestComment for the comment in full).` }])
    await disposeWorkspaceService(w)
    // With the rules off the lane is the builder's to carry on: it starts the next card itself, whatever its card's prompt said.
    await rulesOff()
    const off = await open()
    const st2 = fake(off.alpha)
    const c2 = await newCard(off.w)
    const next2 = (await inWorkspace(off.w, () => tasks.createTask({ title: 'Show progress', project: 'alpha', agent: 'b1' }, user))).number
    await lanes.startLane(off.w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c2, next2], by: 'B1 (alpha)' })
    await inWorkspace(off.w, () => tasks.updateTask(c2, { column: 'done' }, user))
    await typedUntil(st2, 1)
    expect(st2.typed[0].text).toBe(`[CW] #${c2} is in Done. Your lane's next card is #${next2} ("Show progress"): start it now (cw_lane next, then cw_start_card); this card's own prompt doesn't narrow the lane (cw_read_task with latestComment for the comment in full).`)
    await disposeWorkspaceService(off.w)
  })
})
