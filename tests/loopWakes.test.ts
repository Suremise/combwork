import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { cardChange, loopWakeLine, readCondition, wakeAbout, type WatchCondition } from '../src/shared/watch'
import { tempDir } from './tempDir'
import { follow } from './followDoorbell'

describe('loop wake lines (#405)', () => {
  const card = { number: 12, title: 'T', description: '', project: 'alpha', agent: 'b1', agentName: 'B1', column: 'review' as const, order: 1, labels: [], blocked: null, blockedBy: [], links: [], comments: [{ at: '2026-10-10T00:00:00.000Z', by: 'R1 (alpha)', text: 'Round 1: FAILED. 1. No delay.' }], history: [{ at: '2026-10-10T00:00:00.000Z', by: 'R1 (alpha)', what: 'Review failed' }], archived: false, createdAt: '2026-10-10T00:00:00.000Z', createdBy: 'You', updatedAt: '2026-10-10T00:00:00.000Z' }
  it("words a reviewer's and a builder's wake as a watch's line, with what to do", () => {
    const arrived = { ...card, comments: [], history: [{ at: '2026-10-10T00:00:00.000Z', by: 'You', what: 'Moved to Review' }] }
    expect(loopWakeLine({ ...cardChange(12, arrived, ['column']), about: wakeAbout(arrived, ['column'], 'r1') }, 'review')).toBe(
      "[Hive] #12 (B1's card) is in Review. You review this card in its loop: carry on with it (hive_read_task with latestComment for the comment in full)."
    )
    expect(loopWakeLine({ ...cardChange(12, card, ['verdict']), about: wakeAbout(card, ['verdict'], 'b1') }, 'verdict')).toBe(
      '[Hive] #12 is in Review: R1 (alpha) failed it; latest comment by R1 (alpha): "Round 1: FAILED. 1. No delay.". This is your card in its loop: carry on (hive_read_task with latestComment for the comment in full).'
    )
  })
})

describe('loop wakes (main/loopWakes.ts, #405)', async () => {
  const base = tempDir('hive-loopwakes-')
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

  /** Workflow rules off for one test (#1270: Hive owns the lane while they are on), on again after it. */
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
    mkdirSync(join(alpha, '.hive'), { recursive: true })
    writeFileSync(join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }, { id: 'o1', name: 'O1' }], ...cfg }))
    const w = createWorkspaceService()
    await w.open(path)
    return { w, alpha }
  }
  /**
   * Stand-in sessions: every agent of alpha running, its status, and what each was told: #650, it follows Hive's doorbell
   * with hive_inbox, as a model does, and `text` is what it read.
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
    expect(st.typed).toEqual([{ agent: 'r1', text: `[Hive] #${c} (B1's card) is in Review. You review this card in its loop: carry on with it (hive_read_task with latestComment for the comment in full).` }])
    await vi.waitFor(async () => expect(await history(w, c)).toContain('Hive: Woke R1 (alpha) to review it (a loop wake)'), HANG)
    // Failed: the builder is woken with the verdict.
    st.status.set('r1', 'working')
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, r1, { comment: 'Round 1: FAILED. 1. No delay.' }))
    await typedUntil(st, 2)
    expect(st.typed.at(-1)).toEqual({ agent: 'b1', text: `[Hive] #${c} is in Review: R1 (alpha) failed it; latest comment by R1 (alpha): "Round 1: FAILED. 1. No delay.". This is your card in its loop: carry on (hive_read_task with latestComment for the comment in full).` })
    await vi.waitFor(async () => expect(await history(w, c)).toContain('Hive: Woke B1 (alpha) with its verdict (a loop wake)'), HANG)
    // Returned for round 2 by the builder: the reviewer again; passed: the builder again.
    st.status.set('r1', 'ready')
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await typedUntil(st, 3)
    expect(st.typed.at(-1)).toEqual({ agent: 'r1', text: `[Hive] #${c} (B1's card) was returned for review (round 2); latest comment by R1 (alpha): "Round 1: FAILED. 1. No delay.". You review this card in its loop: carry on with it (hive_read_task with latestComment for the comment in full).` })
    st.status.set('b1', 'ready')
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'passed', column: 'passed' }, r1, { comment: 'Round 2: PASSED.' }))
    await typedUntil(st, 4)
    expect(st.typed.at(-1)?.agent).toBe('b1')
    expect(st.typed.at(-1)?.text).toMatch(new RegExp(`^\\[Hive\\] #${c} is in Passed: R1 \\(alpha\\) passed it; latest comment by R1 \\(alpha\\): "Round 2: PASSED."\\. This is your card in its loop`))
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
    // A fired watch covers the card until its line is typed after Hive's settle, which this file sets to 0: a handoff
    // later than that found no watch and queued a second line (#560, under load). Here the settle is Hive's own, as when
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
      expect(st.typed[2]).toMatchObject({ agent: 'r1', text: expect.stringMatching(/was returned for review \(round 2\)/) })
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

  it("hive_inbox gives out a loop wake only while it is still its agent's: the lane's reviewer changed while it waited, it isn't handed out to the old one (#649 round 3)", async () => {
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
    // Failed: the watch doesn't fire (still in Review), so Hive wakes the builder, once.
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, r1, { comment: 'Round 1: FAILED.' }))
    await watches.evaluateWatches(w)
    await typedUntil(st, 2)
    expect(st.typed.map((t) => t.agent)).toEqual(['r1', 'b1'])
    expect(st.typed[1].text).toMatch(/failed it; .*This is your card in its loop/)
    // Its watch still waits for Passed. Returned and passed: the watch tells it, and Hive doesn't too.
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
    expect((await history(w, c)).filter((x) => x === 'Hive: Woke B1 (alpha) with its verdict (a loop wake)')).toHaveLength(1)
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
    // The builder returns it: that new round wakes the reviewer.
    st.status.set('b1', 'ready')
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await typedUntil(st, 2)
    expect(st.typed.map((t) => t.agent)).toEqual(['b1', 'r1'])
    expect(st.typed[1].text).toMatch(/was returned for review \(round 2\)/)
    await disposeWorkspaceService(w)
  })

  it('is off for a project that turned it off (Project Settings → Card loops)', async () => {
    await loopWakes.clearLoopWakes()
    const { w, alpha } = await open({ loopWakes: false })
    const st = fake(alpha)
    const c = await newCard(w)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, b1))
    await settled()
    expect(loopWakes.pendingLoopWakes()).toEqual([])
    expect(st.typed).toEqual([])
    expect(JSON.parse(readFileSync(join(alpha, '.hive', 'project.json'), 'utf8')).loopWakes).toBe(false)
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
    // Once its review has started, a comment is only a comment (its requests are hive_request_builder's); nor is another agent's.
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
    expect(st.typed[0].text).toContain("check it and answer with hive_loop_step (ok, or gaps saying what's missing, and its id)")
    st.status.set('b1', 'ready')
    await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, r1, { kind: 'loopStep', step: 'ok', text: 'Holds: build it.', design: id }))
    await typedUntil(st, 2)
    expect(st.typed[1]).toMatchObject({ agent: 'b1' })
    expect(st.typed[1].text).toContain(`The reviewer: "design ${id} is OK: Holds: build it."`)
    await vi.waitFor(async () => expect(await history(w, c)).toEqual(expect.arrayContaining(['Hive: Woke R1 (alpha) with a card loop step (a loop wake)', 'Hive: Woke B1 (alpha) with a card loop step (a loop wake)'])), HANG)
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
    // So does the card's latest comment, as hive_read_task with latestComment gives it.
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
      expect(st.typed[1].text).not.toContain('answer with hive_loop_step')
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
    expect(st.typed[k].text).toContain("check it and answer with hive_loop_step (ok, or gaps saying what's missing, and its id)")
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
})
