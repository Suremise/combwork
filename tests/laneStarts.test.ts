// Hive starts a lane's next card on its builder (HI-1990): once the card before it is Done and the builder's turn is
// over, as the Assistant's Start gives one (its doorbell typed into the idle builder); never the lane's first card, never
// into a turn, and not with the workflow rules off.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

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
  s.live.set(`${p.toLowerCase()}#${id}`, { state, adapter: claudeCode, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null })
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
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [...['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'].map((id) => ({ id, name: id.toUpperCase() })), { id: 'r1', name: 'R1' }, { id: 'o1', name: 'O1' }] }))
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
})
