// Start lane… in main (#1280): each agent is checked free where it is launched, with no await before its conversation
// is replaced (HR6's round 1): one that started work after the lane was recorded keeps it, and is owed its new
// conversation (HI-2034: `deferred`, recorded with the lane), the lane staying. The session layer, deliveries, the lane
// record and the board are stand-ins.
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Live = { status: string; sessionId: string; cwd?: string }
const state = vi.hoisted(() => ({ live: new Map<string, Live>(), calls: [] as string[], afterRecord: null as null | (() => void), enforced: false, options: null as unknown, recorded: [] as unknown[], briefs: [] as string[], onStart: null as null | ((id: string) => void), lanes: [] as unknown[], lanesHeld: null as null | Promise<void>, lend: { slot: 'slot-c' } as { slot: string } | { waiting: string }, slotWaits: [] as string[], waits: [] as unknown[], onGetTask: null as null | (() => void), beforeLaunch: null as null | ((agentId: string) => void), whileStopping: null as null | ((agentId: string) => void), pending: new Set<string>(), oldTools: new Set<string>(), switching: new Map<string, 'waiting' | 'restarting'>(), stoppedAt: new Map<string, number>(), owed: [] as unknown[], noCode: [] as number[], lanesOn: false, view: null as unknown, starts: [] as { n: number; agentId: string; note: string; guard?: (now: unknown) => void }[], startRefuses: null as null | string, placementDue: null as unknown, startGuardView: null as unknown }))

vi.mock('../src/main/sessions', () => ({
  sessions: {
    liveFor: (_p: string, id: string) => state.live.get(id) ?? null,
    // A prompt Combwork typed that its CLI hasn't taken yet (HI-2034): `state.pending`.
    agentNow: (_p: string, id: string) => (state.live.has(id) ? { pending: state.pending.has(id) } : null),
    // Its session has its role's tools (HI-2664): `state.oldTools` hasn't restarted since its role changed.
    sideAllows: (_p: string, id: string) => !state.oldTools.has(id),
    // Its switch under way (HI-2739: a restart for its tools): `state.switching`.
    switchUnderWay: (_p: string, id: string) => state.switching.get(id) ?? null,
    // When someone last stopped it (HI-2815): `state.stoppedAt`.
    stoppedOnPurposeAt: (_p: string, id: string) => state.stoppedAt.get(id) ?? 0,
    start: async (_p: string, o: { agentId: string }) => {
      state.calls.push(`start ${o.agentId}`)
      state.onStart?.(o.agentId)
      state.live.set(o.agentId, { status: 'starting', sessionId: `new-${o.agentId}` })
      return { runId: `run-${o.agentId}` }
    },
    // As the real one: `allowed` before the agent is stopped, and again while the new conversation starts.
    newConversation: async (_p: string, id: string, _line: string, allowed?: () => void) => {
      allowed?.()
      // While the old run stops (an await in the real one): what changes meanwhile (HR1 on HI-2232).
      state.whileStopping?.(id)
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
  // The team never paused here (HI-2081's refusal is teamPause.test's).
  refuseWhileTeamPaused: () => undefined,
  startLane: async (_ws: unknown, s: unknown) => {
    state.recorded.push(s)
    state.calls.push('record')
    state.afterRecord?.()
    // Its rounds as recorded (HI-1805: what its agents' briefs say, whatever today's default).
    return { lane: { id: 'lane-1', builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, rounds: 3 }, did: 'started', replaced: null }
  },
  holdLaneStart: () => () => undefined,
  // A renewal's lane as kept now (HI-2232, HR1's round 1): `state.lanes`, read synchronously.
  laneRunsWith: (_ws: unknown, id: string, role: string, agent: string) => (state.lanes as { id: string; state: string; builder: { id: string }; reviewer?: { id: string } | null }[]).some((l) => l.id === id && l.state === 'active' && (role === 'builder' ? l.builder.id : l.reviewer?.id) === agent),
  // A new conversation owed (HI-2034), as recorded.
  oweFreshStart: async (_ws: unknown, lane: string, agent: string, role: string, oldSession: string | null, note = '') => void state.owed.push({ lane, agent, role, oldSession, ...(note ? { note } : {}) }),
  rawLanes: async () => {
    await state.lanesHeld
    return state.lanes
  },
  setLaneSlotWait: async (_ws: unknown, id: string, wait: unknown) => {
    state.slotWaits.push(id)
    state.waits.push(wait)
  },
  // An owed fresh start's entry (HI-2034), changed in `state.lanes` as the lanes' lock would.
  changeFreshStart: async (_ws: unknown, id: string, entry: string, fn: (f: unknown) => unknown) => {
    const lane = (state.lanes as { id: string; freshStart?: { id: string }[] }[]).find((l) => l.id === id)
    const f = lane?.freshStart?.find((x) => x.id === entry)
    if (!lane || !f) return false
    const next = fn(f) as { id: string } | null
    lane.freshStart = next ? lane.freshStart!.map((x) => (x.id === entry ? next : x)) : lane.freshStart!.filter((x) => x.id !== entry)
    return true
  },
  freshStartsNow: (_ws: unknown, id: string) => (state.lanes as { id: string; freshStart?: unknown[] }[]).find((l) => l.id === id)?.freshStart ?? [],
  listLanes: async () => [],
  // HI-2558: whether lanes' rules are on, and the lane's view (`state.view`).
  lanesEnforced: async () => state.lanesOn,
  laneNow: (_ws: unknown, _by: unknown, now?: unknown) => (now && state.startGuardView ? state.startGuardView : state.view)
}))
// A lane's slot (#1438): lent as `state.lend` says, before its agents start.
vi.mock('../src/main/slotCards', () => ({
  lendLane: async (_ws: unknown, _p: string, laneId: string) => {
    state.calls.push(`lend ${laneId}`)
    return state.lend
  },
  // HI-2558: a started card's placement still to come, and the slots' folders.
  placementDue: async () => state.placementDue,
  slotFolderOf: async (_ws: unknown, _p: string, slot: string) => 'D:\\ws.worktrees\\alpha\\' + slot
}))
// A lane's first card started with its brief (HI-2558): recorded, or refused as `state.startRefuses` says.
vi.mock('../src/main/taskStart', () => ({
  START_NOTE_MAX: 4000,
  startTask: async (n: number, target: { agentId: string }, _actor: unknown, note: string, _reason: unknown, guard?: (now: unknown) => void) => {
    state.calls.push(`startTask ${n} ${target.agentId}`)
    if (state.startRefuses) throw new Error(state.startRefuses)
    guard?.({ number: n })
    state.starts.push({ n, agentId: target.agentId, note, guard })
    return { card: { number: n }, agentId: target.agentId, agentName: target.agentId, added: false }
  }
}))
vi.mock('../src/main/workspace', () => ({ inWorkspace: (_ws: unknown, fn: () => unknown) => fn() }))
// No line of Combwork's on its way (HI-2034: its own conditions are lineWriter's).
vi.mock('../src/main/lineWriter', () => ({ whyNoLine: () => null }))
// Each workspace's board (HI-2288): a workspace with `board` has those cards; any other given has alpha's AL-n. Read with
// no workspace (the default one's, the last focused window's), it is another workspace's card of the same number.
vi.mock('../src/main/tasks', () => ({
  CW_LANE_START: { kind: 'agent', name: 'Combwork' },
  getTask: async (n: number, w?: { board?: Record<number, unknown> }) => {
    state.onGetTask?.()
    if (!w) return { number: n, key: `HI-${n}`, title: `Another workspace's card ${n}`, project: 'demo', column: 'todo', archived: false }
    if (w.board) {
      if (!w.board[n]) throw new Error(`Unknown card #${n}`)
      return w.board[n]
    }
    return { number: n, key: `AL-${n}`, title: `Card ${n}`, project: 'alpha', column: 'todo', archived: false }
  }
}))
vi.mock('../src/main/workflow/service', () => ({ workflowEnforced: () => state.enforced }))
// Each card's kind (HI-2338): `state.noCode`'s are no-code, the rest code.
vi.mock('../src/main/workflow/cardWork', () => ({ openCardsNoCode: (_ws: unknown, ns: number[]) => ns.length > 0 && ns.every((n) => state.noCode.includes(n)) }))
vi.mock('../src/main/workflow/rulesets', () => ({ resolvedOf: () => ({ options: state.options }) }))

const { briefAfterFailedPrepare, checkLanePool, launchFresh, launchRecordedLane, laneStartInfo, recordedLaneNote, resumeLaneBuilder, startLaneFromWindow, startWaitingLane } = await import('../src/main/laneStart')
const { allOff } = await import('../src/shared/workflow/options')

const ws = {
  config: {},
  info: () => ({ projects: [{ path: 'D:\\ws\\alpha', name: 'alpha', platform: { id: 'git' } }] }),
  projectConfig: async () => ({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }, { id: 'r2', name: 'R2', workflowRole: 'reviewer' }, { id: 'b2', name: 'B2', workflowRole: 'builder' }] })
} as never

beforeEach(() => {
  state.live.clear()
  state.pending.clear()
  state.oldTools.clear()
  state.switching.clear()
  state.stoppedAt.clear()
  state.owed.length = 0
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
  state.whileStopping = null
  state.noCode = []
  state.lanesOn = false
  state.view = null
  state.starts.length = 0
  state.startRefuses = null
  state.placementDue = null
  state.startGuardView = null
})

describe('Start Lane… with the reviewer pool (#1443)', () => {
  const pool = (): void => {
    state.enforced = true
    state.options = { ...allOff('git'), review: 'agent', noSelfReview: true, reviewerMode: 'pool' }
  }

  it("offers the pool only where the project's rules have one, with the agents whose role reviews", async () => {
    expect(await laneStartInfo(ws, 'D:\\ws\\alpha')).toEqual({ pool: null, targets: null })
    state.enforced = true
    state.options = { ...allOff('git'), review: 'agent', noSelfReview: true }
    expect(await laneStartInfo(ws, 'D:\\ws\\alpha')).toEqual({ pool: null, targets: null })
    pool()
    expect(await laneStartInfo(ws, 'D:\\ws\\alpha')).toEqual({ pool: [{ id: 'r1', name: 'R1' }, { id: 'r2', name: 'R2' }], targets: null })
  })

  it('never offers a generalist in the pool, whatever its name (HI-686)', async () => {
    pool()
    const withGeneralist = { ...(ws as object), projectConfig: async () => ({ version: 2, agents: [{ id: 'b1', name: 'B1', workflowRole: 'builder' }, { id: 'r1', name: 'R1' }, { id: 'g1', name: 'GR1', workflowRole: 'generalist' }] }) } as never
    expect(await laneStartInfo(withGeneralist, 'D:\\ws\\alpha')).toEqual({ pool: [{ id: 'r1', name: 'R1' }], targets: null })
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

  it("a reviewer that starts work after the lane is recorded keeps it: not replaced, owed its new conversation, the lane kept (HR6's round 1, HI-2034)", async () => {
    state.live.set('r1', { status: 'ready', sessionId: 'old-r1' })
    state.afterRecord = () => state.live.set('r1', { status: 'working', sessionId: 'old-r1' })
    const r = await startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b1', reviewer: 'r1', cards: [1] })
    expect(state.calls).toEqual(['record', 'start b1'])
    expect(state.live.get('r1')).toEqual({ status: 'working', sessionId: 'old-r1' })
    expect(r.lane.id).toBe('lane-1')
    expect(r.started.find((s) => s.name === 'R1')).toMatchObject({ how: 'deferred' })
    expect(state.owed).toEqual([{ lane: 'lane-1', agent: 'r1', role: 'reviewer', oldSession: 'old-r1' }])
  })

  it("an idle builder with a prompt not taken yet (HI-2034: p5lane's lane A end notice as lane B starts): not replaced, owed its new conversation, never failed", async () => {
    state.live.set('b1', { status: 'ready', sessionId: 'old-b1' })
    state.pending.add('b1')
    const r = await startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b1', reviewer: null, cards: [1] })
    expect(state.calls).toEqual(['record'])
    expect(r.started).toEqual([{ agentId: 'b1', name: 'B1', role: 'builder', how: 'deferred' }])
    expect(state.owed).toEqual([{ lane: 'lane-1', agent: 'b1', role: 'builder', oldSession: 'old-b1' }])
  })

  it("owed with the user's Start Lane note (HR1 round 1, finding 2): its later launch's brief says the same", async () => {
    state.live.set('b1', { status: 'ready', sessionId: 'old-b1' })
    state.pending.add('b1')
    await startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b1', reviewer: null, cards: [1], note: 'Use the staging database' })
    expect(state.owed).toEqual([{ lane: 'lane-1', agent: 'b1', role: 'builder', oldSession: 'old-b1', note: 'Use the staging database' }])
  })

  it('an agent asked to sign in again is refused, not owed (that does not pass by itself)', async () => {
    state.live.set('r1', { status: 'signin', sessionId: 'old-r1' })
    const r = await startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b1', reviewer: 'r1', cards: [1] }).catch((e: Error) => e)
    // Refused up front, as busy (the dialog's Wait and Start), with nothing owed.
    expect(r).toBeInstanceOf(Error)
    expect(state.owed).toEqual([])
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
    expect(r.started.find((s) => s.name === 'R1')?.how).toBe('deferred')
  })
})

describe('a lane waiting for a slot, started as Combwork quits (#1628)', () => {
  const waiting = (): void => void (state.lanes = [{ id: 'lane-1', state: 'active', builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, cards: [1], rounds: 3 }])

  it("lent its slot with its builder not free: owed its new conversation with the slot wait's note (HR1 round 1, finding 2), never failed", async () => {
    state.lanes = [{ id: 'lane-1', state: 'active', builder: { id: 'b1', name: 'B1' }, reviewer: null, cards: [1], rounds: 3, slotWait: { since: new Date().toISOString(), note: 'Use the staging database' } }]
    state.live.set('b1', { status: 'ready', sessionId: 'old-b1' })
    state.pending.add('b1')
    expect(await startWaitingLane(ws, 'D:\\ws\\alpha', 'lane-1', 'slot-a', () => false)).toBe(true)
    expect(state.owed).toEqual([{ lane: 'lane-1', agent: 'b1', role: 'builder', oldSession: 'old-b1', note: 'Use the staging database' }])
  })

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

  // HI-2664 (HR3's round 1): made the lane's builder or reviewer while running and not restarted since, it has its old
  // role's tools: the lane keeps waiting, nothing started or typed, and starts once it has restarted with them.
  it.each(['b1', 'r1'])("%s still on its old role's tools: the lane waits, nothing started, until it has restarted", async (id) => {
    waiting()
    state.oldTools.add(id)
    expect(await startWaitingLane(ws, 'D:\\ws\\alpha', 'lane-1', 'slot-a', () => false)).toBe(false)
    expect(state.calls).toEqual([])
    state.oldTools.delete(id)
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
  /** The lane as `cw_lane start` recorded it: B2 builds, R1 reviews, both stopped. */
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

  it('in slots, its cards all no-code (HI-2338): no slot lent, both start where they are, the brief naming the project folder', async () => {
    recorded()
    inSlots()
    state.noCode = [1, 2]
    state.lend = { waiting: 'every working slot is taken' }
    const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
    expect(state.calls).toEqual(['start b2', 'start r1'])
    expect(state.slotWaits).toEqual([])
    expect(state.briefs[0]).toContain('B2 works in the project folder')
    expect(recordedLaneNote(l)).toBe("Started B2 and R1 with the lane's brief.")
  })

  it('in slots, one of its cards code (HI-2338): lent its slot first, as before', async () => {
    recorded()
    inSlots()
    state.noCode = [1]
    await launchRecordedLane(ws, ALPHA, 'lane-9')
    expect(state.calls).toEqual(['lend lane-9', 'start b2', 'start r1'])
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
    // The rules on: Combwork gives the builder its first card itself (HI-2029), so the caller tells only the reviewer (HR1).
    expect(recordedLaneNote(l)).toBe("B2 is running, so Combwork left it as it is: Combwork gives it the lane's first card itself once it is free, so don't prompt it. R1 is running, so Combwork left it as it is: tell it about the lane.")
    // The rules off: nothing starts the builder's card, so the caller tells both (a busy builder: an idle one outside
    // slots gets the lane in a new conversation, HI-2232).
    state.enforced = false
    state.live.set('b2', { status: 'working', sessionId: 's-b2' })
    expect(recordedLaneNote(await launchRecordedLane(ws, ALPHA, 'lane-9'))).toBe('B2 and R1 are running, so Combwork left them as they are: tell them about the lane.')
  })

  it('its builder running and its reviewer stopped: only the reviewer starts, with no slot lent for the builder', async () => {
    recorded()
    inSlots()
    state.live.set('b2', { status: 'watching', sessionId: 's-b2' })
    const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
    expect(state.calls).toEqual(['start r1'])
    expect(state.live.get('b2')?.sessionId).toBe('s-b2')
    expect(recordedLaneNote(l)).toBe("Started R1 with the lane's brief. B2 is running, so Combwork left it as it is: Combwork gives it the lane's first card itself once it is free, so don't prompt it.")
  })

  it('its builder stopped and its reviewer idle: the builder starts in its slot, the reviewer keeps its conversation', async () => {
    recorded()
    inSlots()
    state.live.set('r1', { status: 'ready', sessionId: 's-r1' })
    const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
    expect(state.calls).toEqual(['lend lane-9', 'start b2'])
    expect(recordedLaneNote(l)).toBe("Started B2 with the lane's brief, in slot-c. R1 is running, so Combwork left it as it is: tell it about the lane.")
  })

  describe('an idle builder outside slots (HI-2232, decision (a)): given the lane in a new conversation, as Start Lane… gives it', () => {
    for (const rules of ['off', 'on, folder per agent'] as const) {
      it(`rules ${rules}: its conversation is replaced with the lane's brief; an idle reviewer is left as it is`, async () => {
        recorded()
        if (rules !== 'off') {
          state.enforced = true
          state.options = { ...allOff('git'), review: 'agent' }
        }
        state.live.set('b2', { status: 'finished', sessionId: 's-b2' })
        state.live.set('r1', { status: 'ready', sessionId: 's-r1' })
        const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
        expect(state.calls).toEqual(['newConversation b2'])
        expect(state.live.get('b2')?.sessionId).toBe('new-b2')
        expect(state.live.get('r1')?.sessionId).toBe('s-r1')
        expect(state.briefs).toHaveLength(1)
        expect(state.briefs[0]).toContain('AL-1')
        expect(l?.started.map((s) => [s.name, s.how])).toEqual([['B2', 'fresh']])
        expect(recordedLaneNote(l)).toBe("Gave B2 the lane in a new conversation (its last stays in its Sessions history): don't prompt it. R1 is running, so Combwork left it as it is: tell it about the lane.")
      })
    }

    it('with its reviewer stopped: the builder gets its new conversation and the reviewer starts', async () => {
      recorded()
      state.live.set('b2', { status: 'ready', sessionId: 's-b2' })
      const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
      expect(state.calls).toEqual(['newConversation b2', 'start r1'])
      expect(recordedLaneNote(l)).toBe("Started R1 with the lane's brief. Gave B2 the lane in a new conversation (its last stays in its Sessions history): don't prompt it.")
    })

    for (const status of ['working', 'watching', 'waiting', 'starting']) {
      it(`a builder ${status} (in a turn or on a watch) is never renewed: left as it is, as before`, async () => {
        recorded()
        state.enforced = true
        state.options = { ...allOff('git'), review: 'agent' }
        state.live.set('b2', { status, sessionId: 's-b2' })
        const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
        expect(state.calls).toEqual(['start r1'])
        expect(state.owed).toEqual([])
        expect(state.live.get('b2')?.sessionId).toBe('s-b2')
        expect(recordedLaneNote(l)).toBe("Started R1 with the lane's brief. B2 is running, so Combwork left it as it is: Combwork gives it the lane's first card itself once it is free, so don't prompt it.")
      })
    }

    // HI-2739: a workflow change restarts an idle agent for its tools (HI-2694), and a lane recorded meanwhile found it
    // neither idle nor stopped, so it was left in its resumed conversation, never given a new one.
    for (const status of ['ready', 'working', 'stopped']) {
      it(`restarting for a switch (its exit typed, ${status}) as the lane is recorded: its new conversation is owed, nothing launched now`, async () => {
        recorded()
        state.enforced = true
        state.options = { ...allOff('git'), review: 'agent' }
        state.live.set('b2', { status, sessionId: 's-b2' })
        state.switching.set('b2', 'restarting')
        const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
        expect(state.calls).toEqual(['start r1'])
        expect(state.owed).toEqual([{ lane: 'lane-9', agent: 'b2', role: 'builder', oldSession: 's-b2' }])
        expect(state.live.get('b2')?.sessionId).toBe('s-b2')
        expect(recordedLaneNote(l)).toBe("Started R1 with the lane's brief. B2 wasn't free: Combwork gives it the lane in a new conversation once it is, so don't prompt it.")
      })
    }

    it('its run ended for a switch, not resumed yet (not live) as the lane is recorded: owed its new conversation, never started over the resume', async () => {
      recorded()
      state.switching.set('b2', 'restarting')
      state.live.set('r1', { status: 'ready', sessionId: 's-r1' })
      const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
      expect(state.calls).toEqual([])
      expect(state.owed).toEqual([{ lane: 'lane-9', agent: 'b2', role: 'builder', oldSession: null }])
      expect(l?.started.map((s) => [s.name, s.how])).toEqual([['B2', 'deferred']])
    })

    it('in a turn with a switch waiting for its safe point (nothing typed): left as it is, as a busy builder is', async () => {
      recorded()
      state.enforced = true
      state.options = { ...allOff('git'), review: 'agent' }
      state.live.set('b2', { status: 'working', sessionId: 's-b2' })
      state.switching.set('b2', 'waiting')
      const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
      expect(state.calls).toEqual(['start r1'])
      expect(state.owed).toEqual([])
      expect(recordedLaneNote(l)).toBe("Started R1 with the lane's brief. B2 is running, so Combwork left it as it is: Combwork gives it the lane's first card itself once it is free, so don't prompt it.")
    })

    it('idle with a switch about to type its exit: not free, so owed its new conversation rather than racing the switch', async () => {
      recorded()
      state.live.set('b2', { status: 'ready', sessionId: 's-b2' })
      state.live.set('r1', { status: 'ready', sessionId: 's-r1' })
      state.switching.set('b2', 'waiting')
      const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
      expect(state.calls).toEqual([])
      expect(state.owed).toEqual([{ lane: 'lane-9', agent: 'b2', role: 'builder', oldSession: 's-b2' }])
      expect(l?.started.map((s) => [s.name, s.how])).toEqual([['B2', 'deferred']])
    })

    it('idle as the lane is recorded, not free at its launch (a prompt not taken yet): its new conversation is owed (HI-2034), never the old one kept', async () => {
      recorded()
      state.live.set('b2', { status: 'ready', sessionId: 's-b2' })
      state.live.set('r1', { status: 'ready', sessionId: 's-r1' })
      state.beforeLaunch = (id) => void (id === 'b2' && state.pending.add('b2'))
      const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
      expect(state.calls).toEqual([])
      expect(state.owed).toEqual([{ lane: 'lane-9', agent: 'b2', role: 'builder', oldSession: 's-b2' }])
      expect(recordedLaneNote(l)).toBe("B2 wasn't free: Combwork gives it the lane in a new conversation once it is, so don't prompt it. R1 is running, so Combwork left it as it is: tell it about the lane.")
    })

    // HR1's round 1: the lane is read before the awaits of the launch; it is checked again just before the old run stops
    // and before the new one spawns, so a lane ended or given to another builder meanwhile replaces nothing and owes nothing.
    const ended = (): void => void ((state.lanes as { state: string }[])[0].state = 'ended')
    const reassigned = (): void => void ((state.lanes as { builder: { id: string; name: string } }[])[0].builder = { id: 'b1', name: 'B1' })
    for (const [what, change] of [['ended', ended], ['given to another builder', reassigned]] as const) {
      it(`its lane ${what} as the brief is saved: the old conversation kept, nothing launched or owed`, async () => {
        recorded()
        state.live.set('b2', { status: 'ready', sessionId: 's-b2' })
        state.live.set('r1', { status: 'ready', sessionId: 's-r1' })
        state.beforeLaunch = (id) => void (id === 'b2' && change())
        const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
        expect(state.calls).toEqual([])
        expect(state.owed).toEqual([])
        expect(state.live.get('b2')?.sessionId).toBe('s-b2')
        expect(l?.started).toEqual([])
      })

      it(`its lane ${what} during the awaits before the launch (its cards read): no brief made, nothing launched`, async () => {
        recorded()
        state.live.set('b2', { status: 'ready', sessionId: 's-b2' })
        state.live.set('r1', { status: 'ready', sessionId: 's-r1' })
        state.onGetTask = change
        const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
        expect(state.briefs).toEqual([])
        expect(state.calls).toEqual([])
        expect(state.owed).toEqual([])
        expect(l?.started).toEqual([])
      })

      it(`its lane ${what} while the old run stops: the new conversation isn't spawned, nothing owed`, async () => {
        recorded()
        state.live.set('b2', { status: 'ready', sessionId: 's-b2' })
        state.live.set('r1', { status: 'ready', sessionId: 's-r1' })
        state.whileStopping = (id) => void (id === 'b2' && change())
        const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
        expect(state.calls).toEqual([])
        expect(state.owed).toEqual([])
        expect(l?.started).toEqual([])
      })
    }

    it('stopped meanwhile: started with the brief', async () => {
      recorded()
      state.live.set('b2', { status: 'ready', sessionId: 's-b2' })
      state.live.set('r1', { status: 'ready', sessionId: 's-r1' })
      state.onGetTask = () => void state.live.delete('b2')
      const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
      expect(state.calls).toEqual(['start b2'])
      expect(recordedLaneNote(l)).toBe("Started B2 with the lane's brief. R1 is running, so Combwork left it as it is: tell it about the lane.")
    })
  })

  it('an agent started by someone else as it is launched is left as it is, never given a new conversation', async () => {
    recorded()
    // R1 starts between the check and its launch (the window, say).
    state.onStart = (id) => void (id === 'b2' && state.live.set('r1', { status: 'ready', sessionId: 's-r1' }))
    const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
    expect(state.calls).toEqual(['start b2'])
    expect(recordedLaneNote(l)).toBe("Started B2 with the lane's brief. R1 is running, so Combwork left it as it is: tell it about the lane.")
  })

  it("its builder running when it looked and stopped meanwhile (HR6's round 1, finding 1): left out of this start, never started with no slot", async () => {
    recorded()
    inSlots()
    state.live.set('b2', { status: 'ready', sessionId: 's-b2' })
    // B2 stops while the lane's cards are read, after the look that decided no slot is lent for it.
    state.onGetTask = () => void state.live.delete('b2')
    const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
    expect(state.calls).toEqual(['start r1'])
    expect(recordedLaneNote(l)).toBe("Started R1 with the lane's brief. B2 is running, so Combwork left it as it is: Combwork gives it the lane's first card itself once it is free, so don't prompt it.")
  })

  for (const status of ['working', 'watching']) {
    it(`an agent found ${status} as its brief's delivery is saved (HR6's round 1, finding 2): left as it is, named as running, not as failed`, async () => {
      recorded()
      state.beforeLaunch = (id) => void (id === 'r1' && state.live.set('r1', { status, sessionId: 's-r1' }))
      const l = await launchRecordedLane(ws, ALPHA, 'lane-9')
      expect(state.calls).toEqual(['start b2'])
      expect(l?.started.map((s) => [s.name, s.how])).toEqual([['B2', 'started']])
      expect(recordedLaneNote(l)).toBe("Started B2 with the lane's brief. R1 is running, so Combwork left it as it is: tell it about the lane.")
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

describe("a lane's brief names its own workspace's cards, never the default workspace's of the same number (HI-2288)", () => {
  const ALPHA = 'D:\\ws\\alpha'
  /** A second workspace, its alpha project's card numbered 324 (OV-238), and beta's 325 in the same workspace. */
  const second = { ...(ws as object), board: { 324: { number: 324, key: 'OV-238', title: 'Overmark card', project: 'alpha', column: 'todo', archived: false }, 325: { number: 325, key: 'BE-9', title: "Beta's card", project: 'beta', column: 'todo', archived: false } } } as never
  /** The builder's brief: the lane's cards named, never the other workspace's HI-324. */
  const named = (brief: string | undefined): void => {
    expect(brief).toContain('1. OV-238 Overmark card')
    expect(brief).not.toContain('HI-324')
    expect(brief).not.toContain("Another workspace's card")
  }

  it('Start Lane… from the window', async () => {
    await startLaneFromWindow(second, ALPHA, { builder: 'b1', reviewer: 'r1', cards: [324] })
    named(state.briefs[0])
  })

  it('a lane the Assistant or a script recorded (cw_lane start, the reported case)', async () => {
    state.lanes = [{ id: 'lane-o', state: 'active', builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, cards: [324], rounds: 3 }]
    await launchRecordedLane(second, ALPHA, 'lane-o')
    named(state.briefs[0])
  })

  it('a lane that waited for a slot (the slot pass runs with no workspace of its own)', async () => {
    state.lanes = [{ id: 'lane-o', state: 'active', builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, cards: [324], rounds: 3 }]
    expect(await startWaitingLane(second, ALPHA, 'lane-o', 'slot-a', () => false)).toBe(true)
    named(state.briefs[0])
  })

  it('an owed new conversation (the fresh-start pass runs with no workspace of its own)', async () => {
    state.lanes = [{ id: 'lane-o', state: 'active', builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, cards: [324], rounds: 3, freshStart: [{ id: 'f1', agent: 'b1', role: 'builder', since: new Date().toISOString(), oldSession: null }] }]
    expect(await launchFresh(second, ALPHA, 'lane-o', 'f1')).toBe('launched')
    named(state.briefs[0])
  })

  it("another project's card of the lane's workspace is left out of a recorded lane's brief, never named", async () => {
    state.lanes = [{ id: 'lane-o', state: 'active', builder: { id: 'b1', name: 'B1' }, reviewer: null, cards: [325, 324], rounds: 3 }]
    await launchRecordedLane(second, ALPHA, 'lane-o')
    named(state.briefs[0])
    expect(state.briefs[0]).not.toContain('BE-9')
  })
})

describe("an owed new conversation whose agent someone stopped since (HI-2815: a user's Stop stops it)", () => {
  const ALPHA = 'D:\\ws\\alpha'
  const owedAt = new Date(Date.now() - 60_000)
  const owing = (): void => {
    state.lanes = [{ id: 'lane-o', state: 'active', builder: { id: 'b1', name: 'B1' }, reviewer: null, cards: [324], rounds: 3, freshStart: [{ id: 'f1', agent: 'b1', role: 'builder', since: owedAt.toISOString(), oldSession: null }] }]
  }
  const entries = (): unknown[] => (state.lanes as { freshStart?: unknown[] }[])[0].freshStart ?? []

  it("stopped after it was owed (the reported case: not free at the lane's start, then the user stopped it): never started again, and owed no more", async () => {
    owing()
    state.stoppedAt.set('b1', owedAt.getTime() + 1000)
    expect(await launchFresh(ws, ALPHA, 'lane-o', 'f1')).toBe('gone')
    expect(state.calls).toEqual([])
    expect(state.briefs).toEqual([])
    expect(entries()).toEqual([])
  })

  it('stopped while its launch was under way: nothing started, and owed no more', async () => {
    owing()
    state.beforeLaunch = (id) => void state.stoppedAt.set(id, Date.now())
    expect(await launchFresh(ws, ALPHA, 'lane-o', 'f1')).toBe('gone')
    expect(state.calls).toEqual([])
    expect(entries()).toEqual([])
  })

  it("stopped before it was owed (or never): started with the lane's brief, as before", async () => {
    owing()
    state.stoppedAt.set('b1', owedAt.getTime() - 1000)
    expect(await launchFresh(ws, ALPHA, 'lane-o', 'f1')).toBe('launched')
    expect(state.calls).toEqual(['start b1'])
    expect(entries()).toEqual([])
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

describe('Start Lane… of only no-code cards, in slots (HI-2338)', () => {
  const inSlots = (): void => {
    state.enforced = true
    state.options = { ...allOff('git'), review: 'agent', folder: 'slots' }
  }

  it('every slot lent: nothing is lent or waited for, both start where they are, the brief naming the project folder', async () => {
    inSlots()
    state.noCode = [1, 2]
    state.lend = { waiting: 'every working slot is taken' }
    const r = await startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b2', reviewer: 'r1', cards: [1, 2] })
    expect(state.calls).toEqual(['record', 'start b2', 'start r1'])
    expect(r.waitingForSlot).toBeUndefined()
    expect(r.slot).toBeUndefined()
    expect(state.slotWaits).toEqual([])
    expect(state.briefs[0]).toContain('B2 works in the project folder')
  })

  it('one code card among them: the lane is lent its slot before its agents start, or waits for one, as before', async () => {
    inSlots()
    state.noCode = [1]
    expect((await startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b2', reviewer: 'r1', cards: [1, 2] })).slot).toBe('slot-c')
    expect(state.calls).toEqual(['record', 'lend lane-1', 'start b2', 'start r1'])
    state.calls.length = 0
    state.live.clear()
    state.lend = { waiting: 'every working slot is taken' }
    expect((await startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b2', reviewer: 'r1', cards: [1, 2] })).waitingForSlot).toBe('every working slot is taken')
    expect(state.calls).toEqual(['record', 'lend lane-1'])
  })

  it('outside slots, or Solo: no-code or not, nothing is lent', async () => {
    state.enforced = true
    state.options = { ...allOff('git'), review: 'agent', folder: 'project' }
    await startLaneFromWindow(ws, 'D:\\ws\\alpha', { builder: 'b2', reviewer: 'r1', cards: [1, 2] })
    expect(state.calls).toEqual(['record', 'start b2', 'start r1'])
  })
})

describe("a lane's first card and brief in one task, in slots (HI-2558)", () => {
  const ALPHA = 'D:\\ws\\alpha'
  const FIRST = "Combwork started this card for you: it is your lane's first card, and your lane's brief follows."
  /** The rules on, cards built in slots, and the lane's view: AL-1 then AL-2 in Todo, its builder `builder`. */
  const on = (builder = 'b1', first: Partial<{ column: string; number: number }> = {}): void => {
    state.enforced = true
    state.lanesOn = true
    state.options = { ...allOff('git'), review: 'agent', folder: 'slots' }
    state.view = { id: 'lane-1', state: 'active', builder: { id: builder }, cards: [{ number: 1, column: 'todo', blocked: null, ...first }, { number: 2, column: 'todo', blocked: null }] }
  }

  it("Start Lane… with its builder stopped: Combwork starts the first card with the builder's brief in its note, and launches only the reviewer with its own", async () => {
    on()
    const r = await startLaneFromWindow(ws, ALPHA, { builder: 'b1', reviewer: 'r1', cards: [1, 2] })
    expect(state.calls).toEqual(['record', 'lend lane-1', 'startTask 1 b1', 'start r1'])
    expect(state.starts).toHaveLength(1)
    expect(state.starts[0].note.startsWith(FIRST)).toBe(true)
    // The brief whole, after that line: the cards, its slot, the rules.
    expect(state.starts[0].note).toContain('You are the builder of a lane in alpha')
    expect(state.starts[0].note).toContain('1. AL-1 Card 1')
    expect(state.starts[0].note).toContain('slot-c')
    // The reviewer's brief only: the builder is given none of its own.
    expect(state.briefs).toHaveLength(1)
    expect(state.briefs[0]).toContain('You are the reviewer')
    expect(r.started.map((s) => [s.name, s.role, s.how])).toEqual([
      ['B1', 'builder', 'started'],
      ['R1', 'reviewer', 'started']
    ])
  })

  it("Start Lane… with its builder idle outside the slot: the card's start gives it the card and brief (its new conversation there)", async () => {
    on()
    state.live.set('b1', { status: 'ready', sessionId: 'old-b1', cwd: 'D:\\ws\\alpha' })
    const r = await startLaneFromWindow(ws, ALPHA, { builder: 'b1', reviewer: 'r1', cards: [1, 2] })
    expect(state.calls).toEqual(['record', 'lend lane-1', 'startTask 1 b1', 'start r1'])
    expect(r.started[0]).toMatchObject({ name: 'B1', how: 'fresh' })
  })

  it('Start Lane… with its builder idle in the slot already: step by step, as before (its new conversation with the brief)', async () => {
    on()
    state.live.set('b1', { status: 'ready', sessionId: 'old-b1', cwd: 'D:\\ws.worktrees\\alpha\\slot-c' })
    await startLaneFromWindow(ws, ALPHA, { builder: 'b1', reviewer: 'r1', cards: [1, 2] })
    expect(state.calls).toEqual(['record', 'lend lane-1', 'newConversation b1', 'start r1'])
    expect(state.starts).toEqual([])
  })

  it("the card's start refused (its rules, a dependency, the builder busy): the builder is launched with its brief, step by step", async () => {
    on()
    state.startRefuses = 'AL-1 waits for AL-0 to be Done'
    const r = await startLaneFromWindow(ws, ALPHA, { builder: 'b1', reviewer: 'r1', cards: [1, 2] })
    expect(state.calls).toEqual(['record', 'lend lane-1', 'startTask 1 b1', 'start b1', 'start r1'])
    expect(state.briefs).toHaveLength(2)
    expect(r.started.map((s) => s.how)).toEqual(['started', 'started'])
  })

  it('the lane changed where the start is written (another builder by then): refused, so step by step', async () => {
    on()
    const before = state.view as { builder: { id: string } }
    // The start's guard reads the lane again as it writes: another builder by then.
    state.startGuardView = { ...before, builder: { id: 'b2' } }
    await startLaneFromWindow(ws, ALPHA, { builder: 'b1', reviewer: 'r1', cards: [1, 2] })
    expect(state.starts).toEqual([])
    expect(state.calls).toEqual(['record', 'lend lane-1', 'startTask 1 b1', 'start b1', 'start r1'])
  })

  it('a first card that is no-code, the rules off for lanes, or a brief too long for a note: step by step', async () => {
    on()
    state.noCode = [1]
    await startLaneFromWindow(ws, ALPHA, { builder: 'b1', reviewer: 'r1', cards: [1, 2] })
    expect(state.calls).toEqual(['record', 'lend lane-1', 'start b1', 'start r1'])
    state.noCode = []
    state.calls.length = 0
    state.live.clear()
    state.lanesOn = false
    await startLaneFromWindow(ws, ALPHA, { builder: 'b1', reviewer: 'r1', cards: [1, 2] })
    expect(state.calls).toEqual(['record', 'lend lane-1', 'start b1', 'start r1'])
    state.lanesOn = true
    state.calls.length = 0
    state.live.clear()
    await startLaneFromWindow(ws, ALPHA, { builder: 'b1', reviewer: 'r1', cards: [1, 2], note: 'x'.repeat(4000) })
    expect(state.calls).toEqual(['record', 'lend lane-1', 'start b1', 'start r1'])
    expect(state.starts).toEqual([])
  })

  it('a lane the Assistant or a script recorded over a stopped builder: its first card with the brief, the reviewer with its own, and the reply as before', async () => {
    on('b2')
    state.lanes = [{ id: 'lane-1', state: 'active', builder: { id: 'b2', name: 'B2' }, reviewer: { id: 'r1', name: 'R1' }, cards: [1, 2], rounds: 3 }]
    const l = await launchRecordedLane(ws, ALPHA, 'lane-1')
    expect(state.calls).toEqual(['lend lane-1', 'startTask 1 b2', 'start r1'])
    expect(state.starts[0].note).toContain('You are the builder')
    expect(recordedLaneNote(l)).toBe("Started B2 and R1 with the lane's brief, in slot-c.")
  })

  it('a recorded lane whose builder is idle: left as it is (never given the card by the lane start), as before', async () => {
    on('b2')
    state.lanes = [{ id: 'lane-1', state: 'active', builder: { id: 'b2', name: 'B2' }, reviewer: { id: 'r1', name: 'R1' }, cards: [1, 2], rounds: 3 }]
    state.live.set('b2', { status: 'ready', sessionId: 'old-b2', cwd: ALPHA })
    await launchRecordedLane(ws, ALPHA, 'lane-1')
    expect(state.calls).toEqual(['start r1'])
    expect(state.starts).toEqual([])
  })

  it('a lane that waited for a slot, lent one now: its first card with the brief', async () => {
    on()
    state.lanes = [{ id: 'lane-1', state: 'active', builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, cards: [1, 2], rounds: 3, slotWait: { since: new Date().toISOString(), note: '' } }]
    expect(await startWaitingLane(ws, ALPHA, 'lane-1', 'slot-a', () => false)).toBe(true)
    expect(state.calls).toEqual(['startTask 1 b1', 'start r1'])
    expect(state.starts[0].note).toContain('slot-a')
  })

  it('made again after a start cut short (its first card Active on the builder, its placement to come): the builder is neither started again nor given a second brief', async () => {
    on('b1', { column: 'doing' })
    state.placementDue = { slot: 'slot-a', lease: 'l1' }
    const board = { ...(ws as object), board: { 1: { number: 1, key: 'AL-1', title: 'Card 1', project: 'alpha', column: 'doing', archived: false, agent: 'b1' }, 2: { number: 2, key: 'AL-2', title: 'Card 2', project: 'alpha', column: 'todo', archived: false } } } as never
    state.lanes = [{ id: 'lane-1', state: 'active', builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, cards: [1, 2], rounds: 3, slotWait: { since: new Date().toISOString(), note: '' } }]
    expect(await startWaitingLane(board, ALPHA, 'lane-1', 'slot-a', () => false)).toBe(true)
    expect(state.calls).toEqual(['start r1'])
  })

  describe("its slot not prepared for the card (the slot pass's failure)", () => {
    const lane = (): void => void (state.lanes = [{ id: 'lane-1', state: 'active', builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, cards: [1, 2], rounds: 3 }])

    it('its builder, stopped and never briefed, starts with its brief, so it reads the wake and why', async () => {
      on()
      lane()
      await briefAfterFailedPrepare(ws, ALPHA, 1, 'b1')
      expect(state.calls).toEqual(['start b1'])
      expect(state.briefs).toHaveLength(1)
      expect(state.briefs[0]).toContain('You are the builder')
    })

    it("nothing for a builder running, a card not its lane's first still to do, or another lane's builder", async () => {
      on()
      lane()
      state.live.set('b1', { status: 'ready', sessionId: 's' })
      await briefAfterFailedPrepare(ws, ALPHA, 1, 'b1')
      state.live.clear()
      await briefAfterFailedPrepare(ws, ALPHA, 2, 'b1')
      await briefAfterFailedPrepare(ws, ALPHA, 1, 'b2')
      expect(state.calls).toEqual([])
    })
  })
})
