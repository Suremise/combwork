// Start lane… in main (#1280): each agent is checked free where it is launched, with no await before its conversation
// is replaced (HR6's round 1): one that started work after the lane was recorded keeps it, reported as not started,
// and the lane stays. The session layer, deliveries, the lane record and the board are stand-ins.
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Live = { status: string; sessionId: string }
const state = vi.hoisted(() => ({ live: new Map<string, Live>(), calls: [] as string[], afterRecord: null as null | (() => void), enforced: false, options: null as unknown, recorded: [] as unknown[], briefs: [] as string[], onStart: null as null | ((id: string) => void), lanes: [] as unknown[], lanesHeld: null as null | Promise<void>, lend: { slot: 'slot-c' } as { slot: string } | { waiting: string }, slotWaits: [] as string[], waits: [] as unknown[], onGetTask: null as null | (() => void), beforeLaunch: null as null | ((agentId: string) => void) }))

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
  launchWith: async (_p: string, nd: { agentId: string; body: string }, start: (line: string) => Promise<unknown>) => {
    // As its delivery is saved (an await before its start): what changes meanwhile.
    state.beforeLaunch?.(nd.agentId)
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
  holdLaneStart: () => () => undefined,
  rawLanes: async () => {
    await state.lanesHeld
    return state.lanes
  },
  setLaneSlotWait: async (_ws: unknown, id: string, wait: unknown) => {
    state.slotWaits.push(id)
    state.waits.push(wait)
  }
}))
// A lane's slot (#1438): lent as `state.lend` says, before its agents start.
vi.mock('../src/main/slotCards', () => ({
  lendLane: async (_ws: unknown, _p: string, laneId: string) => {
    state.calls.push(`lend ${laneId}`)
    return state.lend
  }
}))
vi.mock('../src/main/tasks', () => ({
  getTask: async (n: number) => (state.onGetTask?.(), { number: n, key: `AL-${n}`, title: `Card ${n}`, project: 'alpha', column: 'todo', archived: false })
}))
vi.mock('../src/main/workflow/service', () => ({ workflowEnforced: () => state.enforced }))
vi.mock('../src/main/workflow/rulesets', () => ({ resolvedOf: () => ({ options: state.options }) }))

const { checkLanePool, launchRecordedLane, laneStartInfo, recordedLaneNote, resumeLaneBuilder, startLaneFromWindow, startWaitingLane } = await import('../src/main/laneStart')
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
  state.lend = { slot: 'slot-c' }
  state.slotWaits.length = 0
  state.waits.length = 0
  state.onGetTask = null
  state.beforeLaunch = null
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

  it('never offers a generalist in the pool, whatever its name (HI-686)', async () => {
    pool()
    const withGeneralist = { ...(ws as object), projectConfig: async () => ({ version: 2, agents: [{ id: 'b1', name: 'B1', workflowRole: 'builder' }, { id: 'r1', name: 'R1' }, { id: 'g1', name: 'GR1', workflowRole: 'generalist' }] }) } as never
    expect(await laneStartInfo(withGeneralist, 'D:\\ws\\alpha')).toEqual({ pool: [{ id: 'r1', name: 'R1' }] })
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

  it("the Assistant's pool lane (HI-1581) is refused as the window's is, and a recorded one starts only its builder, with the pool in its brief", async () => {
    await expect(checkLanePool(ws, 'D:\\ws\\alpha', 'b1')).rejects.toThrow(/one reviewer per lane/)
    state.enforced = true
    state.options = { ...allOff('git'), review: 'agent', noSelfReview: true }
    await expect(checkLanePool(ws, 'D:\\ws\\alpha', 'b1')).rejects.toThrow(/one reviewer per lane/)
    pool()
    await expect(checkLanePool(ws, 'D:\\ws\\alpha', 'b1')).resolves.toBeUndefined()
    const lonely = { ...(ws as object), projectConfig: async () => ({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'e1', name: 'E1', workflowRole: 'either' }] }) } as never
    await expect(checkLanePool(lonely, 'D:\\ws\\alpha', 'e1')).rejects.toThrow(/pool has nobody/)
    // Recorded with the pool (POST /v1/lanes), it starts as Start Lane's does: its builder alone.
    state.lanes = [{ id: 'lane-p', state: 'active', builder: { id: 'b1', name: 'B1' }, reviewer: null, pool: true, cards: [1], rounds: 3 }]
    const l = await launchRecordedLane(ws, 'D:\\ws\\alpha', 'lane-p')
    expect(state.calls).toEqual(['start b1'])
    expect(state.briefs[0]).toContain('reviewed by the pool (R1 and R2)')
    expect(recordedLaneNote(l)).toBe("Started B1 with the lane's brief.")
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

describe('a lane the Assistant or a script starts over stopped agents (HI-1900)', () => {
  const ALPHA = 'D:\\ws\\alpha'
  /** The lane as `hive_lane start` recorded it: B2 builds, R1 reviews, both stopped. */
  const recorded = (): void => void (state.lanes = [{ id: 'lane-9', state: 'active', builder: { id: 'b2', name: 'B2' }, reviewer: { id: 'r1', name: 'R1' }, cards: [1, 2], rounds: 3 }])
  const inSlots = (): void => {
    state.enforced = true
    state.options = { ...allOff('git'), review: 'agent', folder: 'slots' }
  }

  it('in slots: its slot is lent first, then its builder and reviewer start with the lane brief, which names the slot', async () => {
    recorded()
    inSlots()
    const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
    expect(state.calls).toEqual(['lend lane-9', 'start b2', 'start r1'])
    expect(state.briefs).toHaveLength(2)
    expect(state.briefs[0]).toContain('slot-c')
    expect(state.briefs[0]).toContain('AL-1')
    expect(recordedLaneNote(l)).toBe("Started B2 and R1 with the lane's brief, in slot-c.")
  })

  it("no slot free: nothing starts, the lane waits for one (its wait recorded, as the window's, for its stopped agents only), and the reply says so", async () => {
    recorded()
    inSlots()
    state.lend = { waiting: 'every working slot is taken' }
    const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
    expect(state.calls).toEqual(['lend lane-9'])
    expect(state.slotWaits).toEqual(['lane-9'])
    expect(state.waits).toEqual([expect.objectContaining({ stoppedOnly: true })])
    expect(recordedLaneNote(l)).toBe('No slot is free (every working slot is taken): the lane waits for one, and its stopped agents start once it is lent.')
  })

  it('outside slots: both start in a fresh conversation with the brief', async () => {
    recorded()
    expect(recordedLaneNote(await launchRecordedLane(ws, ALPHA, 'lane-9'))).toBe("Started B2 and R1 with the lane's brief.")
    expect(state.calls).toEqual(['start b2', 'start r1'])
  })

  it('its agents running, idle or busy (HI-1934): neither is refused, restarted or lent a slot, and the reply says to tell them', async () => {
    recorded()
    inSlots()
    state.live.set('b2', { status: 'ready', sessionId: 's-b2' })
    state.live.set('r1', { status: 'working', sessionId: 's-r1' })
    const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
    expect(state.calls).toEqual([])
    // The rules on: Hive gives the builder its first card itself (HI-2029), so the caller tells only the reviewer (HR1).
    expect(recordedLaneNote(l)).toBe("B2 is running, so Hive left it as it is: Hive gives it the lane's first card itself once it is free, so don't prompt it. R1 is running, so Hive left it as it is: tell it about the lane.")
    // The rules off: nothing starts the builder's card, so the caller tells both.
    state.enforced = false
    expect(recordedLaneNote(await launchRecordedLane(ws, ALPHA, 'lane-9'))).toBe('B2 and R1 are running, so Hive left them as they are: tell them about the lane.')
  })

  it('its builder running and its reviewer stopped: only the reviewer starts, with no slot lent for the builder', async () => {
    recorded()
    inSlots()
    state.live.set('b2', { status: 'watching', sessionId: 's-b2' })
    const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
    expect(state.calls).toEqual(['start r1'])
    expect(state.live.get('b2')?.sessionId).toBe('s-b2')
    expect(recordedLaneNote(l)).toBe("Started R1 with the lane's brief. B2 is running, so Hive left it as it is: Hive gives it the lane's first card itself once it is free, so don't prompt it.")
  })

  it('its builder stopped and its reviewer idle: the builder starts in its slot, the reviewer keeps its conversation', async () => {
    recorded()
    inSlots()
    state.live.set('r1', { status: 'ready', sessionId: 's-r1' })
    const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
    expect(state.calls).toEqual(['lend lane-9', 'start b2'])
    expect(recordedLaneNote(l)).toBe("Started B2 with the lane's brief, in slot-c. R1 is running, so Hive left it as it is: tell it about the lane.")
  })

  it('an agent started by someone else as it is launched is left as it is, never given a new conversation', async () => {
    recorded()
    // R1 starts between the check and its launch (the window, say).
    state.onStart = (id) => void (id === 'b2' && state.live.set('r1', { status: 'ready', sessionId: 's-r1' }))
    const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
    expect(state.calls).toEqual(['start b2'])
    expect(recordedLaneNote(l)).toBe("Started B2 with the lane's brief. R1 is running, so Hive left it as it is: tell it about the lane.")
  })

  it("its builder running when it looked and stopped meanwhile (HR6's round 1, finding 1): left out of this start, never started with no slot", async () => {
    recorded()
    inSlots()
    state.live.set('b2', { status: 'ready', sessionId: 's-b2' })
    // B2 stops while the lane's cards are read, after the look that decided no slot is lent for it.
    state.onGetTask = () => void state.live.delete('b2')
    const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
    expect(state.calls).toEqual(['start r1'])
    expect(recordedLaneNote(l)).toBe("Started R1 with the lane's brief. B2 is running, so Hive left it as it is: Hive gives it the lane's first card itself once it is free, so don't prompt it.")
  })

  for (const status of ['working', 'watching']) {
    it(`an agent found ${status} as its brief's delivery is saved (HR6's round 1, finding 2): left as it is, named as running, not as failed`, async () => {
      recorded()
      state.beforeLaunch = (id) => void (id === 'r1' && state.live.set('r1', { status, sessionId: 's-r1' }))
      const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
      expect(state.calls).toEqual(['start b2'])
      expect(l?.started.map((s) => [s.name, s.how])).toEqual([['B2', 'started']])
      expect(recordedLaneNote(l)).toBe("Started B2 with the lane's brief. R1 is running, so Hive left it as it is: tell it about the lane.")
    })
  }

  it("waiting for a slot it was recorded with (stoppedOnly): once lent, an agent running by then keeps its conversation", async () => {
    state.lanes = [{ id: 'lane-9', state: 'active', builder: { id: 'b2', name: 'B2' }, reviewer: { id: 'r1', name: 'R1' }, cards: [1], rounds: 3, slotWait: { since: '2026-10-28T09:00:00.000Z', note: '', stoppedOnly: true } }]
    state.live.set('r1', { status: 'ready', sessionId: 's-r1' })
    expect(await startWaitingLane(ws, ALPHA, 'lane-9', 'slot-c')).toBe(true)
    expect(state.calls).toEqual(['start b2'])
  })

  it('a lane no longer running starts nothing', async () => {
    state.lanes = [{ id: 'lane-9', state: 'ended', builder: { id: 'b2', name: 'B2' }, reviewer: null, cards: [1], rounds: 3 }]
    expect(await launchRecordedLane(ws, ALPHA, 'lane-9')).toBeNull()
    expect(state.calls).toEqual([])
  })
})

describe("a running lane the Assistant or a script updates while its builder is stopped (HR2's HI-1900 round 1)", () => {
  const ALPHA = 'D:\\ws\\alpha'

  it('a running lane updated while its builder is stopped: its builder is started on the lane; one running is left as it is', async () => {
    const lane = { id: 'lane-9', builder: { id: 'b2', name: 'B2' } }
    expect(await resumeLaneBuilder(ALPHA, lane)).toBe("B2 wasn't running: started it on the lane.")
    expect(state.calls).toEqual(['start b2'])
    expect(await resumeLaneBuilder(ALPHA, lane)).toBe('')
    expect(state.calls).toEqual(['start b2'])
  })
})
