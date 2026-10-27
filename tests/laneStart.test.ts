// Start lane… in main (#1280): each agent is checked free where it is launched, with no await before its conversation
// is replaced (HR6's round 1): one that started work after the lane was recorded keeps it, reported as not started,
// and the lane stays. The session layer, deliveries, the lane record and the board are stand-ins.
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Live = { status: string; sessionId: string }
const state = vi.hoisted(() => ({ live: new Map<string, Live>(), calls: [] as string[], afterRecord: null as null | (() => void), enforced: false, options: null as unknown, recorded: [] as unknown[], briefs: [] as string[], onStart: null as null | ((id: string) => void), lanes: [] as unknown[], lanesHeld: null as null | Promise<void> }))

vi.mock('../src/main/sessions', () => ({
  sessions: {
    liveFor: (_p: string, id: string) => state.live.get(id) ?? null,
    start: async (_p: string, o: { agentId: string }) => {
      state.calls.push(`start ${o.agentId}`)
      state.onStart?.(o.agentId)
      state.live.set(o.agentId, { status: 'starting', sessionId: `new-${o.agentId}` })
      return { runId: `run-${o.agentId}` }
    },
    // As the real one: `allowed` before the agent is stopped, and again while the new conversation starts.
    newConversation: async (_p: string, id: string, _line: string, allowed?: () => void) => {
      allowed?.()
      state.calls.push(`newConversation ${id}`)
      state.live.set(id, { status: 'starting', sessionId: `new-${id}` })
      allowed?.()
      return { runId: `run-${id}` }
    }
  }
}))
vi.mock('../src/main/deliveries', () => ({
  deliveriesOf: async () => [],
  launchWith: async (_p: string, nd: { body: string }, start: (line: string) => Promise<unknown>) => {
    state.briefs.push(nd.body)
    return { record: null, launched: await start(nd.body) }
  }
}))
vi.mock('../src/main/lanes', () => ({
  startLane: async (_ws: unknown, s: unknown) => {
    state.recorded.push(s)
    state.calls.push('record')
    state.afterRecord?.()
    // Its rounds as recorded (HI-1805: what its agents' briefs say, whatever today's default).
    return { lane: { id: 'lane-1', builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, rounds: 3 }, did: 'started', replaced: null }
  },
  rawLanes: async () => {
    await state.lanesHeld
    return state.lanes
  }
}))
vi.mock('../src/main/tasks', () => ({
  getTask: async (n: number) => ({ number: n, key: `AL-${n}`, title: `Card ${n}`, project: 'alpha', column: 'todo', archived: false })
}))
vi.mock('../src/main/workflow/service', () => ({ workflowEnforced: () => state.enforced }))
vi.mock('../src/main/workflow/rulesets', () => ({ resolvedOf: () => ({ options: state.options }) }))

const { laneStartInfo, startLaneFromWindow, startWaitingLane } = await import('../src/main/laneStart')
const { allOff } = await import('../src/shared/workflow/options')

const ws = {
  config: {},
  info: () => ({ projects: [{ path: 'D:\\ws\\alpha', name: 'alpha', platform: { id: 'git' } }] }),
  projectConfig: async () => ({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }, { id: 'r2', name: 'R2', workflowRole: 'reviewer' }, { id: 'b2', name: 'B2', workflowRole: 'builder' }] })
} as never

beforeEach(() => {
  state.live.clear()
  state.calls.length = 0
  state.afterRecord = null
  state.enforced = false
  state.options = null
  state.recorded.length = 0
  state.briefs.length = 0
  state.onStart = null
  state.lanes = []
  state.lanesHeld = null
})

describe('Start Lane… with the reviewer pool (#1443)', () => {
  const pool = (): void => {
    state.enforced = true
    state.options = { ...allOff('git'), review: 'agent', noSelfReview: true, reviewerMode: 'pool' }
  }

  it("offers the pool only where the project's rules have one, with the agents whose role reviews", async () => {
    expect(await laneStartInfo(ws, 'D:\\ws\\alpha')).toEqual({ pool: null })
    state.enforced = true
    state.options = { ...allOff('git'), review: 'agent', noSelfReview: true }
    expect(await laneStartInfo(ws, 'D:\\ws\\alpha')).toEqual({ pool: null })
    pool()
    expect(await laneStartInfo(ws, 'D:\\ws\\alpha')).toEqual({ pool: [{ id: 'r1', name: 'R1' }, { id: 'r2', name: 'R2' }] })
  })

  it("records the lane with the pool and starts only its builder, whose brief names the pool's reviewers", async () => {
    pool()
    const r = await startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b1', reviewer: null, pool: true, cards: [1] })
    expect(state.recorded).toEqual([expect.objectContaining({ builder: 'b1', reviewer: null, pool: true })])
    expect(state.calls).toEqual(['record', 'start b1'])
    expect(r.started.map((s) => s.role)).toEqual(['builder'])
    expect(state.briefs[0]).toContain('reviewed by the pool (R1 and R2)')
  })

  it("is refused while the rules have one reviewer per lane or are off, and with nobody in the pool but the builder", async () => {
    await expect(startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b1', reviewer: null, pool: true, cards: [1] })).rejects.toThrow(/one reviewer per lane/)
    state.enforced = true
    state.options = { ...allOff('git'), review: 'agent', noSelfReview: true }
    await expect(startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b1', reviewer: null, pool: true, cards: [1] })).rejects.toThrow(/one reviewer per lane/)
    pool()
    const lonely = { ...(ws as object), projectConfig: async () => ({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'e1', name: 'E1', workflowRole: 'either' }] }) } as never
    await expect(startLaneFromWindow(lonely, 'D:\\ws\\alpha', { builder: 'e1', reviewer: null, pool: true, cards: [1] })).rejects.toThrow(/pool has nobody/)
    expect(state.recorded).toEqual([])
  })
})

describe('Start lane… in main (#1280)', () => {
  it('a stopped builder is started and an idle reviewer gets a new conversation, each with its brief', async () => {
    state.live.set('r1', { status: 'ready', sessionId: 'old-r1' })
    const r = await startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b1', reviewer: 'r1', cards: [1, 2] })
    expect(state.calls).toEqual(['record', 'start b1', 'newConversation r1'])
    expect(r.started.map((s) => [s.name, s.how])).toEqual([
      ['B1', 'started'],
      ['R1', 'fresh']
    ])
  })

  it('an agent busy before anything is recorded: refused, nothing recorded or started', async () => {
    state.live.set('r1', { status: 'working', sessionId: 'old-r1' })
    await expect(startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b1', reviewer: 'r1', cards: [1] })).rejects.toThrow(/R1 is working/)
    expect(state.calls).toEqual([])
  })

  it("a reviewer that starts work after the lane is recorded keeps it: not replaced, reported as not started, the lane kept (HR6's round 1)", async () => {
    state.live.set('r1', { status: 'ready', sessionId: 'old-r1' })
    state.afterRecord = () => state.live.set('r1', { status: 'working', sessionId: 'old-r1' })
    const r = await startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b1', reviewer: 'r1', cards: [1] })
    expect(state.calls).toEqual(['record', 'start b1'])
    expect(state.live.get('r1')).toEqual({ status: 'working', sessionId: 'old-r1' })
    expect(r.lane.id).toBe('lane-1')
    expect(r.started.find((s) => s.name === 'R1')).toMatchObject({ how: 'failed', why: expect.stringMatching(/R1 is working/) })
  })

  it('a reviewer that turns busy while the builder starts is caught where it is launched', async () => {
    state.live.set('r1', { status: 'ready', sessionId: 'old-r1' })
    // The builder's start is the await before the reviewer's launch: the reviewer begins a turn meanwhile.
    state.afterRecord = () => {
      const was = state.live.get('r1')!
      queueMicrotask(() => state.live.set('r1', { ...was, status: 'working' }))
    }
    const r = await startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b1', reviewer: 'r1', cards: [1] })
    expect(state.calls).not.toContain('newConversation r1')
    expect(r.started.find((s) => s.name === 'R1')?.how).toBe('failed')
  })
})

describe('a lane waiting for a slot, started as Hive quits (#1628)', () => {
  const waiting = (): void => void (state.lanes = [{ id: 'lane-1', state: 'active', builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, cards: [1], rounds: 3 }])

  it('quitting while its lane is read: nothing is started, and it keeps waiting (false)', async () => {
    waiting()
    let quitting = false
    let release!: () => void
    state.lanesHeld = new Promise<void>((r) => (release = r))
    const started = startWaitingLane(ws, 'D:\\ws\\alpha', 'lane-1', 'slot-a', () => quitting)
    quitting = true
    release()
    expect(await started).toBe(false)
    expect(state.calls).toEqual([])
  })

  it("quitting while its builder starts: its reviewer isn't launched, nothing counts as failed, and it keeps waiting", async () => {
    waiting()
    let quitting = false
    state.onStart = (id) => void (id === 'b1' && (quitting = true))
    expect(await startWaitingLane(ws, 'D:\\ws\\alpha', 'lane-1', 'slot-a', () => quitting)).toBe(false)
    expect(state.calls).toEqual(['start b1'])
    expect(state.briefs).toHaveLength(1)
  })

  it('not quitting: both are started', async () => {
    waiting()
    expect(await startWaitingLane(ws, 'D:\\ws\\alpha', 'lane-1', 'slot-a', () => false)).toBe(true)
    expect(state.calls).toEqual(['start b1', 'start r1'])
  })
})

describe("a lane's briefs say its own rounds, as recorded, never today's default (HI-1805)", () => {
  /** Today's default for the project's platform (git): 10 rounds, changed since the lane was recorded with 3. */
  const withDefault = async <T>(fn: () => Promise<T>): Promise<T> => {
    const cfg = (ws as { config: Record<string, unknown> }).config
    cfg.workflow = { git: { loopRounds: 10 } }
    try {
      return await fn()
    } finally {
      delete cfg.workflow
    }
  }
  const roundsIn = (): string[] => state.briefs.map((b) => /rounds: (\d+)/.exec(b)?.[1] ?? 'none')

  it('a lane waiting for a slot, its default changed meanwhile: both briefs say the rounds it was recorded with', async () => {
    state.lanes = [{ id: 'lane-1', state: 'active', builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, cards: [1], rounds: 3 }]
    expect(await withDefault(() => startWaitingLane(ws, 'D:\\ws\\alpha', 'lane-1', 'slot-a', () => false))).toBe(true)
    expect(state.calls).toEqual(['start b1', 'start r1'])
    expect(roundsIn()).toEqual(['3', '3'])
  })

  it("Start Lane… from the window: the lane's recorded rounds, not the default read again", async () => {
    await withDefault(() => startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b1', reviewer: 'r1', cards: [1] }))
    expect(roundsIn()).toEqual(['3', '3'])
  })
})
