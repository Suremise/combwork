// HI-1693: a lane agent left with no card watch (a notice ended it, or its limit) isn't stalled while Combwork's loop wakes
// will bring it the other side's move: a builder waiting for its verdict or for its design's answer, a reviewer waiting
// for the next submission. Once the move is its own again (a verdict sends the card back, a step waits for its
// reviewer's answer), or nothing can wake it (loop wakes off, no inbox), it is flagged after the grace, as before (#376).
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { LiveSessionState } from '../src/shared/types'
import { tempDir } from './tempDir'

describe('loop agents with no watch, and the loop wakes that reach them (HI-1693)', async () => {
  const base = tempDir('hive-loopcheck-wakes-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  // No grace in tests (loopCheck's test seam): a check runs as soon as the agent is idle.
  process.env.HIVE_TEST_LOOP_GRACE_MS = '0'
  afterAll(async () => {
    ;(await import('../src/main/boardStore')).closeAllBoards()
    rmSync(base, { recursive: true, force: true })
  })
  const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
  const tasks = await import('../src/main/tasks')
  const lanes = await import('../src/main/lanes')
  const loopCheck = await import('../src/main/loopCheck')
  const deliveries = await import('../src/main/deliveries')
  const { emit } = await import('../src/main/events')
  const { config } = await import('../src/main/config')
  const { runCardIntent } = await import('../src/main/cardIntents')
  const { sessions } = await import('../src/main/sessions')
  loopCheck.initLoopCheck()
  afterEach(() => deliveries.setReadsInboxForTests(null))

  // The longest a wait here waits: a bound for a hung run, never how long it should take.
  const HANG = { timeout: 10_000 }
  const WORKFLOW = { workflow: { platform: 'none', preset: null, options: { review: 'agent', noSelfReview: true } } }
  let n = 0
  /** A workspace whose project alpha has a builder (b1) and a reviewer (r1). */
  const open = async (cfg: Record<string, unknown> = WORKFLOW) => {
    const path = join(base, `ws-${++n}`)
    const alpha = join(path, 'alpha')
    mkdirSync(join(alpha, '.combwork'), { recursive: true })
    writeFileSync(join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], ...cfg }))
    const w = createWorkspaceService()
    await w.open(path)
    return { w, alpha }
  }
  /** Stand-in sessions: each agent's status, and its stalled cards as loopCheck marks them. */
  const fake = (alpha: string) => {
    const live = new Map<string, LiveSessionState>()
    for (const id of ['b1', 'r1']) live.set(id, { projectPath: alpha, agentId: id, agentName: id.toUpperCase(), provider: 'claude-code', status: 'working', statusSince: new Date().toISOString() } as LiveSessionState)
    const told: { agent: string; cards: number[] }[] = []
    Object.assign(sessions, {
      liveFor: (p: string, id: string) => (p.toLowerCase() === alpha.toLowerCase() ? (live.get(id) ?? null) : null),
      setNotWatching: (_p: string, id: string, cards: number[] | null) => {
        const st = live.get(id)
        if (st) live.set(id, { ...st, notWatching: cards ?? undefined })
      },
      notifyNotWatching: (_p: string, id: string, cards: number[]) => void told.push({ agent: id, cards })
    })
    /** Its turn ends with no watch (a notice ended it): idle, as a session-status event says. */
    const idle = (id: string) => {
      const st = { ...live.get(id)!, status: 'finished' as const, watch: undefined, statusSince: new Date().toISOString() }
      live.set(id, st)
      emit({ type: 'session-status', state: st })
    }
    return { live, told, idle, flagged: (id: string) => live.get(id)?.notWatching ?? null }
  }
  const b1 = { kind: 'agent', name: 'B1 (alpha)', self: { project: 'alpha', agentId: 'b1' }, scope: 'alpha' } as const
  const r1 = { kind: 'agent', name: 'R1 (alpha)', self: { project: 'alpha', agentId: 'r1' }, scope: 'alpha' } as const
  const user = { kind: 'user' } as const
  /** A card of alpha's lane (b1 builds, r1 reviews), started by its builder; both agents have watched it (in a loop). */
  const inLane = async (w: Awaited<ReturnType<typeof open>>['w'], alpha: string) => {
    const c = (await inWorkspace(w, () => tasks.createTask({ title: 'Loop card', project: 'alpha', kind: 'no-code' }, user))).number
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c], by: 'B1 (alpha)' })
    await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'start' }))
    loopCheck.noteLoopWatch(alpha, 'b1', [c])
    loopCheck.noteLoopWatch(alpha, 'r1', [c])
    return c
  }
  /** A step of the card's by intent (as the agents' tools take it): a no-code card is submitted with its summary. */
  const act = (w: Awaited<ReturnType<typeof open>>['w'], c: number, who: typeof b1 | typeof r1, intent: Parameters<typeof runCardIntent>[2]) => inWorkspace(w, () => runCardIntent({ n: c, plain: false }, who, intent))
  const submit = (w: Awaited<ReturnType<typeof open>>['w'], c: number) => act(w, c, b1, { kind: 'submit', summary: 'Round 1 ready' })
  /** Runs `step`, then waits until this agent's own grace check begun after it has finished: its outcome, not a moment, is read. */
  const checked = async (alpha: string, agentId: string, step: () => unknown) => {
    const from = loopCheck.loopChecksOf(alpha, agentId)
    await step()
    await vi.waitFor(() => expect(loopCheck.loopChecksOf(alpha, agentId)).toBeGreaterThan(from), HANG)
  }

  it('a builder waiting for its verdict is not flagged; once the verdict sends the move back and it stays idle, it is', async () => {
    const { w, alpha } = await open()
    const s = fake(alpha)
    const c = await inLane(w, alpha)
    await submit(w, c)
    // A notice ended its watch, and its turn ended without a new one: the reviewer's verdict will wake it.
    await checked(alpha, 'b1', () => s.idle('b1'))
    expect(s.flagged('b1')).toBeNull()
    expect(s.told).toEqual([])
    // Failed: its move now. Still idle with no watch (no new session-status): flagged after the grace, and told.
    await act(w, c, r1, { kind: 'startReview' })
    await act(w, c, r1, { kind: 'verdict', pass: false, failKind: 'content', comment: 'Round 1: FAILED. 1. Fix it.' })
    await vi.waitFor(() => expect(s.flagged('b1')).toEqual([c]), HANG)
    expect(s.told).toEqual([{ agent: 'b1', cards: [c] }])
    await disposeWorkspaceService(w)
  })

  it("a reviewer's request leaves the move to the builder: flagged while it sits idle unanswered, and not once it has answered", async () => {
    const { w, alpha } = await open()
    const s = fake(alpha)
    const c = await inLane(w, alpha)
    await submit(w, c)
    await checked(alpha, 'b1', () => s.idle('b1'))
    expect(s.flagged('b1')).toBeNull()
    // Mid-review, the reviewer asks the builder something: its answer is owed, the card still in Review.
    await act(w, c, r1, { kind: 'startReview' })
    await act(w, c, r1, { kind: 'request', text: 'Which commit should I review?' })
    await vi.waitFor(() => expect(s.flagged('b1')).toEqual([c]), HANG)
    // Answered on the card: the verdict is the reviewer's again, and the mark goes.
    await inWorkspace(w, () => tasks.updateTask(c, {}, b1, { comment: 'The latest: 1a2b3c4.' }))
    await vi.waitFor(() => expect(s.flagged('b1')).toBeNull(), HANG)
    await disposeWorkspaceService(w)
  })

  it('a builder whose design waits for the answer is not flagged; once the reviewer answers with gaps, it is', async () => {
    const { w, alpha } = await open()
    const s = fake(alpha)
    const c = await inLane(w, alpha)
    const id = String((await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'loopStep', step: 'design', text: 'Plan' }))).done.data?.design)
    await checked(alpha, 'b1', () => s.idle('b1'))
    expect(s.flagged('b1')).toBeNull()
    await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, r1, { kind: 'loopStep', step: 'gaps', text: '1. Say how.', design: id }))
    await vi.waitFor(() => expect(s.flagged('b1')).toEqual([c]), HANG)
    await disposeWorkspaceService(w)
  })

  it('a reviewer waiting for the submission is not flagged; a design waiting for its answer is its move, and it is', async () => {
    const { w, alpha } = await open()
    const s = fake(alpha)
    const c = await inLane(w, alpha)
    await checked(alpha, 'r1', () => s.idle('r1'))
    expect(s.flagged('r1')).toBeNull()
    // The builder posts a design: the reviewer's to answer. Idle with no watch, it is flagged after the grace.
    await inWorkspace(w, () => runCardIntent({ n: c, plain: false }, b1, { kind: 'loopStep', step: 'design', text: 'Plan' }))
    await vi.waitFor(() => expect(s.flagged('r1')).toEqual([c]), HANG)
    await disposeWorkspaceService(w)
  })

  it('a reviewer idle on a card in Review it has not given a verdict on is flagged, as before', async () => {
    const { w, alpha } = await open()
    const s = fake(alpha)
    const c = await inLane(w, alpha)
    await submit(w, c)
    await checked(alpha, 'r1', () => s.idle('r1'))
    await vi.waitFor(() => expect(s.flagged('r1')).toEqual([c]), HANG)
    await disposeWorkspaceService(w)
  })

  it('with no inbox to receive a loop wake (the Agent API off), a builder waiting for its verdict is flagged; with it back, it is not', async () => {
    const { w, alpha } = await open()
    const s = fake(alpha)
    const c = await inLane(w, alpha)
    await submit(w, c)
    deliveries.setReadsInboxForTests(() => false)
    await checked(alpha, 'b1', () => s.idle('b1'))
    await vi.waitFor(() => expect(s.flagged('b1')).toEqual([c]), HANG)
    // Its hive tools back (Settings changed): a loop wake reaches it again, and the mark goes.
    deliveries.setReadsInboxForTests(() => true)
    emit({ type: 'settings-changed', settings: config.settings })
    await vi.waitFor(() => expect(s.flagged('b1')).toBeNull(), HANG)
    await disposeWorkspaceService(w)
  })

  it("with the project's loop wakes off, a builder waiting for its verdict is flagged, as before", async () => {
    const { w, alpha } = await open({ ...WORKFLOW, loopWakes: false })
    const s = fake(alpha)
    const c = await inLane(w, alpha)
    await submit(w, c)
    await checked(alpha, 'b1', () => s.idle('b1'))
    await vi.waitFor(() => expect(s.flagged('b1')).toEqual([c]), HANG)
    await disposeWorkspaceService(w)
  })
})
