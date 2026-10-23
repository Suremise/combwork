// Start lane… in main (#1280): each agent is checked free where it is launched, with no await before its conversation
// is replaced (HR6's round 1): one that started work after the lane was recorded keeps it, reported as not started,
// and the lane stays. The session layer, deliveries, the lane record and the board are stand-ins.
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Live = { status: string; sessionId: string }
const state = vi.hoisted(() => ({ live: new Map<string, Live>(), calls: [] as string[], afterRecord: null as null | (() => void) }))

vi.mock('../src/main/sessions', () => ({
  sessions: {
    liveFor: (_p: string, id: string) => state.live.get(id) ?? null,
    start: async (_p: string, o: { agentId: string }) => {
      state.calls.push(`start ${o.agentId}`)
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
  launchWith: async (_p: string, nd: { body: string }, start: (line: string) => Promise<unknown>) => ({ record: null, launched: await start(nd.body) })
}))
vi.mock('../src/main/lanes', () => ({
  startLane: async () => {
    state.calls.push('record')
    state.afterRecord?.()
    return { lane: { id: 'lane-1', builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' } }, did: 'started', replaced: null }
  }
}))
vi.mock('../src/main/tasks', () => ({
  getTask: async (n: number) => ({ number: n, key: `AL-${n}`, title: `Card ${n}`, project: 'alpha', column: 'todo', archived: false })
}))
vi.mock('../src/main/workflow/service', () => ({ workflowEnforced: () => false }))
vi.mock('../src/main/workflow/rulesets', () => ({ resolvedOf: () => ({ options: null }) }))

const { startLaneFromWindow } = await import('../src/main/laneStart')

const ws = {
  config: {},
  info: () => ({ projects: [{ path: 'D:\\ws\\alpha', name: 'alpha', platform: { id: 'git' } }] }),
  projectConfig: async () => ({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }] })
} as never

beforeEach(() => {
  state.live.clear()
  state.calls.length = 0
  state.afterRecord = null
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
