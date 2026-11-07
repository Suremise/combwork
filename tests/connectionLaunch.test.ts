import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaneRecord } from '../src/shared/lanes'
import type { AgentDef, Connection, TaskCard } from '../src/shared/types'

// Changing a connection's launch settings (HI-2670, main's connectionLaunch.ts): turning its Combwork tools off makes its
// agents Independent, so where that takes one off a running lane or from a card in Doing or Review the change is refused
// unless it names that exact set, worked out again as it is saved. The board, lanes and projects are stand-ins.

const state = vi.hoisted(() => ({
  connections: [] as Connection[],
  agents: [] as Partial<AgentDef>[],
  lanes: [] as Partial<LaneRecord>[],
  cards: [] as Partial<TaskCard>[],
  emitted: 0
}))

vi.mock('../src/main/config', () => ({
  config: {
    get: () => ({ connections: state.connections, accounts: [{ id: 'acc', provider: 'claude-code' }] }),
    update: (fn: (c: { connections: Connection[] }) => void) => {
      const c = { connections: state.connections }
      fn(c)
      state.connections = c.connections
    }
  }
}))
vi.mock('../src/main/accounts', () => ({
  NO_CONNECTION: { id: 'main.connections.notFound', defaultMessage: 'There is no such connection.', description: '' },
  getConnection: (id: string | undefined) => state.connections.find((c) => c.id === id),
  accountById: (id: string | undefined) => (id === 'acc' ? { id: 'acc', provider: 'claude-code' } : undefined),
  allAccounts: () => [{ id: 'acc', provider: 'claude-code' }],
  allConnections: () => state.connections
}))
vi.mock('../src/main/advanced', () => ({ advanced: { overrides: () => ({}), state: () => ({ fileError: null }) } }))
vi.mock('../src/main/events', () => ({ emit: () => void state.emitted++ }))
vi.mock('../src/main/lanes', () => ({ rawLanes: async () => state.lanes }))
vi.mock('../src/main/tasks', () => ({ agentCards: async (_p: string, id: string) => state.cards.filter((c) => c.agent === id) }))
vi.mock('../src/main/workspace', () => ({
  openWorkspaces: () => [{ path: 'C:/ws', info: () => ({ projects: [{ name: 'demo', path: 'C:/ws/demo' }] }), refresh: async () => undefined }]
}))
vi.mock('../src/main/fsutil', async (orig) => ({
  ...(await orig<typeof import('../src/main/fsutil')>()),
  withFileLock: async (_f: string, fn: () => unknown) => fn(),
  readKeptJson: async () => ({ agents: state.agents })
}))

const { launchImpact, setConnectionLaunch, ownRunOverride } = await import('../src/main/connectionLaunch')

beforeEach(() => {
  state.connections = [{ id: 'c-1', account: 'acc', name: 'Claude' }]
  state.agents = [
    { id: 'b1', name: 'HB1', workflowRole: 'builder', connection: 'c-1' },
    { id: 'r1', name: 'HR1', workflowRole: 'reviewer', connection: 'c-1' },
    { id: 'g1', name: 'Solo', workflowRole: 'independent', connection: 'c-1' },
    { id: 'x1', name: 'Other', workflowRole: 'builder', connection: 'c-2' }
  ]
  state.lanes = [{ id: 'lane-1', project: 'demo', state: 'active', builder: { id: 'b1', name: 'HB1' }, reviewer: null, cards: [7] }]
  state.cards = [{ number: 7, key: 'DE-7', agent: 'b1', column: 'doing' }]
})

describe('turning a connection\'s tools off', () => {
  it('names the agents it takes out of the workflow, each with its lanes and cards; not one already Independent, nor another connection\'s', async () => {
    const impact = await launchImpact('c-1', { tools: false })
    expect(impact?.agents.map((a) => [a.agent, a.lanes, a.cards.map((c) => c.key)])).toEqual([['HB1', ['lane-1'], ['DE-7']]])
    // Turning guidance off, or tools off when they are off already, takes nobody out.
    expect(await launchImpact('c-1', { guidance: false })).toBeNull()
    state.connections[0].launch = { tools: false }
    expect(await launchImpact('c-1', { tools: false, typing: false })).toBeNull()
  })

  it('is refused unconfirmed, saying what and the fingerprint to confirm with; confirmed, it is saved', async () => {
    const impact = (await launchImpact('c-1', { tools: false }))!
    await expect(setConnectionLaunch('c-1', { tools: false })).rejects.toThrow(new RegExp(`HB1 \\(lane-1, DE-7 doing\\).*confirm: ${impact.fingerprint}`))
    expect(state.connections[0].launch).toBeUndefined()
    const saved = await setConnectionLaunch('c-1', { tools: false }, impact.fingerprint)
    expect(saved.launch).toEqual({ tools: false })
    expect(state.connections[0].launch).toEqual({ tools: false })
  })

  it('refuses a stale confirmation: work that became affected after it was given is never approved by it', async () => {
    const impact = (await launchImpact('c-1', { tools: false }))!
    // Meanwhile the reviewer takes a card in Review.
    state.cards.push({ number: 8, key: 'DE-8', agent: 'r1', column: 'review' })
    await expect(setConnectionLaunch('c-1', { tools: false }, impact.fingerprint)).rejects.toThrow(/changed since you were asked.*HR1 \(DE-8 review\)/)
    expect(state.connections[0].launch).toBeUndefined()
    const again = (await launchImpact('c-1', { tools: false }))!
    expect(again.fingerprint).not.toBe(impact.fingerprint)
    await setConnectionLaunch('c-1', { tools: false }, again.fingerprint)
    expect(state.connections[0].launch).toEqual({ tools: false })
  })

  it('needs no confirmation where nobody is on a lane or holds a card, and {} turns everything on again', async () => {
    state.lanes = []
    state.cards = []
    expect(await launchImpact('c-1', { tools: false })).toBeNull()
    await setConnectionLaunch('c-1', { tools: false, overrides: { statusLine: false } })
    expect(state.connections[0].launch).toEqual({ tools: false, overrides: { statusLine: false } })
    await setConnectionLaunch('c-1', {})
    expect(state.connections[0].launch).toBeUndefined()
  })
})

describe("Combwork's own runs of a CLI", () => {
  it('read an override as off only when every connection of that CLI has it off', () => {
    state.connections = [{ id: 'c-1', account: 'acc', name: 'A', launch: { overrides: { statusLine: false } } }, { id: 'c-2', account: 'acc', name: 'B' }]
    expect(ownRunOverride('claude-code', 'statusLine')).toBe(true)
    state.connections[1].launch = { overrides: { statusLine: false } }
    expect(ownRunOverride('claude-code', 'statusLine')).toBe(false)
    // With no connection of its CLI: its default.
    expect(ownRunOverride('copilot', 'noAutoUpdate')).toBe(true)
  })
})
