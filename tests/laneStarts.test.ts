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
const { checkLaneStarts } = await import('../src/main/laneStarts')
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

/** The builder running, as SessionManager keeps one (no process): its runtime facts follow its status (#648, #649). */
function builder(status: string): { status: string } {
  let now = status
  const rt = { lifecycle: 'running', maintenance: null, attention: null, composer: 'free' }
  const state = { provider: 'claude', runId: 'run-b1', projectPath: p, agentId: 'b1', cwd: p, sessionId: '', startedAt: '', launchSignature: '', unseen: false, runtime: rt, turn: { state: 'over' } } as Record<string, unknown>
  Object.defineProperty(state, 'status', {
    get: () => now,
    set: (v: string) => {
      now = v
      state.turn = { state: v === 'working' ? 'running' : 'over' }
    },
    enumerable: true
  })
  state.status = status
  s.live.set(`${p.toLowerCase()}#b1`, { state, adapter: claudeCode, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null })
  return state as unknown as { status: string }
}

const card = async (title: string): Promise<number> => (await run(() => tasks.createTask({ title, project: 'alpha', agent: 'b1' }, user))).number
const columnOf = async (n: number): Promise<string> => (await run(() => tasks.getTask(n, w))).column
// The builder's doorbell for its task (#650: the task's id, which it reads with hive_inbox).
const rung = (): boolean => pty.typed.join('').includes('New in your inbox: 1 task')

describe("Hive starts a lane's next card (HI-1990)", () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }] }))
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
})
