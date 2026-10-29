// Hive starts a lane's next card on its builder (HI-1990): once the card before it is Done and the builder's turn is
// over, as the Assistant's Start gives one (its doorbell typed into the idle builder); never the lane's first card, never
// into a turn, and not with the workflow rules off.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { claudeInput } from './claudeInputStandIn'

// What Hive types into agents' terminals, recorded instead (no process runs).
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
  // Its input box (HI-1979: Hive types into Claude Code only once its own key shows the box empty), fed what is typed.
  const input = claudeInput({ paste: false })
  input.from(() => pty.typed)
  s.live.set(`${p.toLowerCase()}#${id}`, { state, adapter: claudeCode, screen: input.screen, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null })
  return state as unknown as { status: string }
}

const card = async (title: string, agent = 'b1'): Promise<number> => (await run(() => tasks.createTask({ title, project: 'alpha', agent }, user))).number
const columnOf = async (n: number): Promise<string> => (await run(() => tasks.getTask(n, w))).column
// The builder's doorbell for its task (#650: the task's id, which it reads with hive_inbox).
const rung = (): boolean => pty.typed.join('').includes('New in your inbox: 1 task')

describe("Hive starts a lane's next card (HI-1990)", () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [...['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((id) => ({ id, name: id.toUpperCase() })), { id: 'r1', name: 'R1' }, { id: 'o1', name: 'O1' }] }))
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

  it('on its builder once the card before it is Done and its turn is over; never its first card', async () => {
    const first = await card('Retry the sync')
    const next = await card('Show sync progress')
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [first, next], by: 'B1 (alpha)' })
    const b = builder('ready')
    // Its first card is the builder's to start.
    await checkLaneStarts(w)
    expect([await columnOf(first), await columnOf(next)]).toEqual(['todo', 'todo'])
    await run(() => tasks.updateTask(first, { column: 'doing', agent: 'b1' }, user))
    // Done while the builder is in a turn (reading its wake): the next card waits for the turn's end.
    b.status = 'working'
    await run(() => tasks.updateTask(first, { column: 'done' }, user))
    await checkLaneStarts(w)
    expect(await columnOf(next)).toBe('todo')
    expect(rung()).toBe(false)
    b.status = 'ready'
    await checkLaneStarts(w)
    const started = await run(() => tasks.getTask(next, w))
    expect([started.column, started.agent]).toEqual(['doing', 'b1'])
    expect(started.history.some((h) => h.by === 'Hive' && /^Moved to (the (top|bottom) of )?Doing\b/.test(h.what))).toBe(true)
    expect(rung()).toBe(true)
    await lanes.endLane(w, (await lanes.laneOf(w, 'alpha', 'b1'))!.id, { abandoned: true })
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

  it("a start whose condition no longer holds where it is written assigns, writes and delivers nothing (the guard Hive's start checks there)", async () => {
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
    /** A lane of two on `b`: its first card Active (started by its builder), its builder idle. */
    async function inFlight(b: string) {
      const [x1, x2] = [await card('X one', b), await card('X two', b)]
      const lane = (await lanes.startLane(w, { project: 'alpha', builder: b, reviewer: 'r1', cards: [x1, x2], by: 'B (alpha)' })).lane
      await run(() => tasks.updateTask(x1, { column: 'doing', agent: b }, user))
      const st = builder('ready', b)
      return { x1, x2, lane, st }
    }

    it('puts the card in flight back and Hive starts the new first card once its builder is free; the reply and the builder say so', async () => {
      const { x1, x2, lane } = await inFlight('b9')
      const r = await lanes.startLane(w, { project: 'alpha', builder: 'b9', reviewer: 'r1', cards: [x2, x1], by: 'the user', applyNow: true })
      expect(r.note).toContain('Applied now: ')
      expect(r.note).toContain(`${x1} is back in Todo`)
      expect(r.note).toContain(`${x2} starts next, once B9's turn is over and its slot is ready`)
      expect(await columnOf(x1)).toBe('todo')
      expect(r.lane.cards.map((c) => c.number)).toEqual([x2, x1])
      expect(r.lane.startNext).toBe(x2)
      await checkLaneStarts(w)
      expect(await columnOf(x2)).toBe('doing')
      expect((await lanes.getLane(w, lane.id)).startNext).toBeUndefined()
    })

    it("refuses while its builder is in a turn or waits on a watch of other work, changing nothing; a watch on that card alone doesn't stop it", async () => {
      const { x1, x2, st } = await inFlight('d1')
      st.status = 'working'
      await expect(lanes.startLane(w, { project: 'alpha', builder: 'd1', reviewer: 'r1', cards: [x2, x1], by: 'the user', applyNow: true })).rejects.toThrow(/D1 is working: a reorder applied now never puts its card back under it/)
      const live = s.live.get(`${p.toLowerCase()}#d1`) as { state: Record<string, unknown> }
      st.status = 'watching'
      live.state.watch = { cards: [x2], changes: ['column'] }
      await expect(lanes.startLane(w, { project: 'alpha', builder: 'd1', reviewer: 'r1', cards: [x2, x1], by: 'the user', applyNow: true })).rejects.toThrow(/waiting on a watch of other work/)
      expect(await columnOf(x1)).toBe('doing')
      expect((await lanes.laneOf(w, 'alpha', 'd1'))!.cards.map((c) => c.number)).toEqual([x1, x2])
      // Watching only the card it puts back: that wait is obsolete, so the reorder goes ahead.
      live.state.watch = { cards: [x1], changes: ['column'] }
      const r = await lanes.startLane(w, { project: 'alpha', builder: 'd1', reviewer: 'r1', cards: [x2, x1], by: 'the user', applyNow: true })
      expect(r.note).toMatch(/^Applied now/)
      expect(await columnOf(x1)).toBe('todo')
    })

    it("a newer list saved just after the reorder's own write stays: the reorder never writes its list again (HR1's round 1)", async () => {
      const [one, two, three] = [await card('Z one', 'd3'), await card('Z two', 'd3'), await card('Z three', 'd3')]
      const lane = (await lanes.startLane(w, { project: 'alpha', builder: 'd3', reviewer: 'r1', cards: [one, two, three], by: 'B (alpha)' })).lane
      await run(() => tasks.updateTask(one, { column: 'doing', agent: 'd3' }, user))
      builder('ready', 'd3')
      const { Workflow } = await import('../src/main/workflow/runtime')
      const original = Workflow.prototype.reorderLaneNow
      let newer = false
      const spy = vi.spyOn(Workflow.prototype, 'reorderLaneNow').mockImplementation(async function (this: InstanceType<typeof Workflow>, id, cards, o) {
        const reply = await original.call(this, id, cards, o)
        // Its write committed: another change of the lane's list lands before the start's own edit goes on.
        if (!newer && 'ok' in reply && reply.ok) {
          newer = true
          await lanes.startLane(w, { project: 'alpha', builder: 'd3', reviewer: 'r1', cards: [three, one, two], by: 'a newer change' })
        }
        return reply
      })
      try {
        const r = await lanes.startLane(w, { project: 'alpha', builder: 'd3', reviewer: 'r1', cards: [two, one, three], by: 'the user', applyNow: true })
        expect(newer).toBe(true)
        expect(r.note).toContain('Applied now: ')
        const now = await lanes.getLane(w, lane.id)
        expect(now.cards.map((c) => c.number)).toEqual([three, one, two])
        // The newer list dropped the mark the reorder set, as any list change does.
        expect(now.startNext).toBeUndefined()
      } finally {
        spy.mockRestore()
      }
    })

    /** After the reorder's own write commits, `then` runs (another decision on the lane), once. */
    async function afterCommit(then: () => Promise<void>) {
      const { Workflow } = await import('../src/main/workflow/runtime')
      const original = Workflow.prototype.reorderLaneNow
      let ran = false
      const spy = vi.spyOn(Workflow.prototype, 'reorderLaneNow').mockImplementation(async function (this: InstanceType<typeof Workflow>, id, cards, o) {
        const reply = await original.call(this, id, cards, o)
        if (!ran && 'ok' in reply && reply.ok) {
          ran = true
          await then()
        }
        return reply
      })
      return { ran: () => ran, restore: () => spy.mockRestore() }
    }

    it("a lane ended or replaced just after the reorder's own write stays as that decision left it: never started again (HR1's round 2)", async () => {
      // Ended: no running lane afterwards.
      const [a1, a2] = [await card('E one', 'd5'), await card('E two', 'd5')]
      const ended = (await lanes.startLane(w, { project: 'alpha', builder: 'd5', reviewer: 'r1', cards: [a1, a2], by: 'B (alpha)' })).lane
      await run(() => tasks.updateTask(a1, { column: 'doing', agent: 'd5' }, user))
      builder('ready', 'd5')
      const end = await afterCommit(async () => {
        await lanes.endLane(w, ended.id, { abandoned: true })
      })
      try {
        await lanes.startLane(w, { project: 'alpha', builder: 'd5', reviewer: 'r1', cards: [a2, a1], by: 'the user', applyNow: true })
        expect(end.ran()).toBe(true)
        expect((await lanes.listLanes(w)).filter((l) => l.builder.id === 'd5' && (l.state === 'active' || l.state === 'paused'))).toEqual([])
      } finally {
        end.restore()
      }
      // Replaced: the newer lane of the same builder keeps its cards, and no other is started.
      const [b1, b2, b3] = [await card('R one', 'd6'), await card('R two', 'd6'), await card('R three', 'd6')]
      const old = (await lanes.startLane(w, { project: 'alpha', builder: 'd6', reviewer: 'r1', cards: [b1, b2], by: 'B (alpha)' })).lane
      await run(() => tasks.updateTask(b1, { column: 'doing', agent: 'd6' }, user))
      builder('ready', 'd6')
      let newer: string | null = null
      const replace = await afterCommit(async () => {
        await lanes.endLane(w, old.id, { abandoned: true })
        newer = (await lanes.startLane(w, { project: 'alpha', builder: 'd6', reviewer: 'r1', cards: [b3], by: 'a newer start' })).lane.id
      })
      try {
        await lanes.startLane(w, { project: 'alpha', builder: 'd6', reviewer: 'r1', cards: [b2, b1], by: 'the user', applyNow: true })
        const running = (await lanes.listLanes(w)).filter((l) => l.builder.id === 'd6' && (l.state === 'active' || l.state === 'paused'))
        expect(running.map((l) => [l.id, l.cards.map((c) => c.number)])).toEqual([[newer, [b3]]])
      } finally {
        replace.restore()
      }
    })

    it("a watch of other work begun as the reorder is written refuses it there, nothing moved (HR1's round 1)", async () => {
      const [one, two] = [await card('W one', 'd4'), await card('W two', 'd4')]
      const other = await card('W other', 'd4')
      const lane = (await lanes.startLane(w, { project: 'alpha', builder: 'd4', reviewer: 'r1', cards: [one, two], by: 'B (alpha)' })).lane
      await run(() => tasks.updateTask(one, { column: 'doing', agent: 'd4' }, user))
      const st = builder('ready', 'd4')
      const { Workflow } = await import('../src/main/workflow/runtime')
      const original = Workflow.prototype.reorderLaneNow
      const spy = vi.spyOn(Workflow.prototype, 'reorderLaneNow').mockImplementation(async function (this: InstanceType<typeof Workflow>, id, cards, o) {
        const cfg = (this as unknown as { cfg: { hooks?: Record<string, unknown> } }).cfg
        const was = cfg.hooks
        cfg.hooks = {
          ...was,
          beforeWrite: async (move: string) => {
            if (move !== 'reorder') return
            st.status = 'watching'
            ;(s.live.get(`${p.toLowerCase()}#d4`) as { state: Record<string, unknown> }).state.watch = { cards: [other], changes: ['column'] }
          }
        }
        try {
          return await original.call(this, id, cards, o)
        } finally {
          cfg.hooks = was
        }
      })
      try {
        await expect(lanes.startLane(w, { project: 'alpha', builder: 'd4', reviewer: 'r1', cards: [two, one], by: 'the user', applyNow: true })).rejects.toThrow(/waiting on a watch of other work/)
        expect(await columnOf(one)).toBe('doing')
        const now = await lanes.getLane(w, lane.id)
        expect(now.cards.map((c) => c.number)).toEqual([one, two])
        expect(now.startNext).toBeUndefined()
      } finally {
        spy.mockRestore()
      }
    })

    it('with its card in flight still first, the list applies at once with nothing put back', async () => {
      const [x1, x2, x3] = [await card('Y one', 'd2'), await card('Y two', 'd2'), await card('Y three', 'd2')]
      await lanes.startLane(w, { project: 'alpha', builder: 'd2', reviewer: 'r1', cards: [x1, x2, x3], by: 'B (alpha)' })
      await run(() => tasks.updateTask(x1, { column: 'doing', agent: 'd2' }, user))
      builder('ready', 'd2')
      const r = await lanes.startLane(w, { project: 'alpha', builder: 'd2', reviewer: 'r1', cards: [x1, x3, x2], by: 'the user', applyNow: true })
      expect(r.lane.cards.map((c) => c.number)).toEqual([x1, x3, x2])
      expect(r.lane.queued).toBeNull()
      expect(await columnOf(x1)).toBe('doing')
    })
  })
})
