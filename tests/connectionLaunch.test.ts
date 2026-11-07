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
  // A read that fails (HR3 on s45): the board's cards, its lanes, or one project's file.
  failCards: false,
  failLanes: false,
  failProject: '' as string,
  files: {} as Record<string, string | null>,
  projects: [{ name: 'demo', path: 'C:/ws/demo' }] as { name: string; path: string }[],
  cards: [] as Partial<TaskCard>[],
  emitted: 0,
  // The board's revision (boardRevision), moved by every write a test makes, and what a card read does meanwhile.
  rev: 0,
  duringCardRead: null as null | ((agent: string) => void),
  valuesSaved: [] as unknown[]
}))
/** A card given to an agent, as a board write: its revision moves. */
const give = (card: Partial<TaskCard>): void => {
  state.cards.push(card)
  state.rev++
}

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
  allConnections: () => state.connections,
  updateConnection: (id: string, v: Record<string, unknown>) => {
    if (v.model === 'bad') throw new Error('no such model')
    state.valuesSaved.push(v)
    state.connections = state.connections.map((c) => (c.id === id ? { ...c, ...v } : c))
    return state.connections.find((c) => c.id === id)
  }
}))
vi.mock('../src/main/boardStore', () => ({ boardRevision: () => String(state.rev) }))
vi.mock('../src/main/advanced', () => ({ advanced: { overrides: () => ({}), state: () => ({ fileError: null }) } }))
vi.mock('../src/main/events', () => ({ emit: () => void state.emitted++ }))
vi.mock('../src/main/lanes', () => ({
  rawLanes: async () => {
    if (state.failLanes) throw new Error('lanes read unavailable')
    return state.lanes
  }
}))
vi.mock('../src/main/tasks', () => ({
  agentCards: async (_p: string, id: string) => {
    if (state.failCards) throw new Error('board read unavailable')
    const now = state.cards.filter((c) => c.agent === id)
    state.duringCardRead?.(id)
    return now
  }
}))
vi.mock('../src/main/workspace', () => ({
  openWorkspaces: () => [{ path: 'C:/ws', info: () => (state.projects ? { projects: state.projects } : null), projectConfigWrites: () => 0, refresh: async () => undefined }]
}))
vi.mock('../src/main/fsutil', async (orig) => ({
  ...(await orig<typeof import('../src/main/fsutil')>()),
  withFileLock: async (_f: string, fn: () => unknown) => fn()
}))
// Each project's project.json as it is (HR3 on s46: read as the file is, never a kept file's stand-in).
vi.mock('original-fs/promises', async (orig) => ({
  ...(await orig<typeof import('original-fs/promises')>()),
  readFile: async (file: string) => {
    if (state.failProject && file.includes(state.failProject)) throw Object.assign(new Error('project.json unreadable'), { code: 'EBUSY' })
    // A project's file as a test writes it (HR2 on s47): missing, or any text.
    for (const [name, text] of Object.entries(state.files)) if (file.includes(name)) {
      if (text === null) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
      return text
    }
    return JSON.stringify({ agents: file.includes('demo') ? state.agents : [] })
  }
}))

const { agentChangeCheck, changeConnection, launchImpact, setConnectionLaunch, ownRunOverride } = await import('../src/main/connectionLaunch')

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
  state.rev = 0
  state.duringCardRead = null
  state.valuesSaved = []
  state.failCards = false
  state.failLanes = false
  state.failProject = ''
  state.files = {}
  state.projects = [{ name: 'demo', path: 'C:/ws/demo' }]
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

describe('HR1 on s44: what a change affects is one snapshot, checked at the write', () => {
  it('reads it again when a card is given meanwhile, so a confirmation of the set before never approves the card given during the save', async () => {
    const before = (await launchImpact('c-1', { tools: false }))!
    // While the save reads HR1's cards (after HB1's), HB1 is given DE-8.
    let once = true
    state.duringCardRead = (agent) => {
      if (agent === 'r1' && once) {
        once = false
        give({ number: 8, key: 'DE-8', agent: 'b1', column: 'doing' })
      }
    }
    await expect(setConnectionLaunch('c-1', { tools: false }, before.fingerprint)).rejects.toThrow(/changed since you were asked.*HB1 \(lane-1, DE-7 doing, DE-8 doing\)/)
    expect(state.connections[0].launch).toBeUndefined()
  })

  it("asks the caller's checks at the write itself, after the read: one that no longer holds then changes nothing", async () => {
    state.lanes = []
    state.cards = []
    let allowed = true
    // Change settings turned off, or the Assistant's session ended, while the save reads the board.
    state.duringCardRead = () => void (allowed = false)
    const atWrite = (): void => {
      if (!allowed) throw new Error('Change settings is off')
    }
    await expect(changeConnection('c-1', { launch: { tools: false }, atWrite })).rejects.toThrow(/Change settings is off/)
    expect(state.connections[0].launch).toBeUndefined()
  })

  it('refuses a change of values and launch settings whole: a missing confirmation leaves the model as it was; confirmed, both are saved', async () => {
    await expect(changeConnection('c-1', { values: { model: 'opus' }, launch: { tools: false } })).rejects.toThrow(/confirm/)
    expect(state.valuesSaved).toEqual([])
    expect(state.connections[0]).toEqual({ id: 'c-1', account: 'acc', name: 'Claude' })
    // Values that don't check out: neither part saved.
    const fp = (await launchImpact('c-1', { tools: false }))!.fingerprint
    await expect(changeConnection('c-1', { values: { model: 'bad' }, launch: { tools: false }, confirmed: fp })).rejects.toThrow(/no such model/)
    expect(state.connections[0].launch).toBeUndefined()
    const saved = await changeConnection('c-1', { values: { model: 'opus' }, launch: { tools: false }, confirmed: fp })
    expect(saved).toMatchObject({ model: 'opus', launch: { tools: false } })
  })

  it('refuses when its launch settings were changed meanwhile', async () => {
    state.lanes = []
    state.cards = []
    state.duringCardRead = () => {
      state.connections = [{ ...state.connections[0], launch: { guidance: false } }]
    }
    await expect(changeConnection('c-1', { launch: { tools: false } })).rejects.toThrow(/changed meanwhile/)
    expect(state.connections[0].launch).toEqual({ guidance: false })
  })
})

describe("HR1 on s44: an agent made Independent is checked again under its project's lock", () => {
  const hb1 = { id: 'b1', name: 'HB1', workflowRole: 'builder' as const, connection: 'c-1' }
  const ws = { path: 'C:/ws', info: () => ({ projects: [] }), projectConfigWrites: () => 0 } as never
  const fingerprint = async (): Promise<string> => /confirm: ([0-9a-f]+)/.exec(String(await agentChangeCheck(ws, 'C:/ws/demo', 'demo', hb1, { workflowRole: 'independent' }, null).catch((e: Error) => e.message)))![1]

  it('needs the fingerprint of its lanes and cards, at once and again at the write', async () => {
    await expect(agentChangeCheck(ws, 'C:/ws/demo', 'demo', hb1, { workflowRole: 'independent' }, null)).rejects.toThrow(/HB1 \(lane-1, DE-7 doing\).*confirm: [0-9a-f]+/)
    const check = (await agentChangeCheck(ws, 'C:/ws/demo', 'demo', hb1, { workflowRole: 'independent' }, await fingerprint()))!
    expect(() => check(hb1)).not.toThrow()
  })

  it('refuses at the write when a card was given to it after the read, or its role or connection changed meanwhile', async () => {
    const check = (await agentChangeCheck(ws, 'C:/ws/demo', 'demo', hb1, { workflowRole: 'independent' }, await fingerprint()))!
    give({ number: 9, key: 'DE-9', agent: 'b1', column: 'review' })
    // Read again by its caller (updateAgent tries a few times): never saved on the old read.
    expect(() => check(hb1)).toThrow(/written to since it was read/)
    state.rev = 0
    expect(() => check({ ...hb1, connection: 'c-2' })).toThrow(/changed meanwhile/)
    // An agent holding nothing: no confirmation, and still refused when the board moved before the write.
    state.lanes = []
    state.cards = []
    const free = (await agentChangeCheck(ws, 'C:/ws/demo', 'demo', hb1, { workflowRole: 'independent' }, null))!
    expect(() => free(hb1)).not.toThrow()
    give({ number: 10, key: 'DE-10', agent: 'b1', column: 'doing' })
    expect(() => free(hb1)).toThrow(/written to since it was read/)
    // A change that makes nobody Independent needs no confirmation, but is still checked against the agent as saved.
    const plain = await agentChangeCheck(ws, 'C:/ws/demo', 'demo', hb1, { workflowRole: 'reviewer' }, null)
    expect(() => plain(hb1)).not.toThrow()
    expect(() => plain({ ...hb1, workflowRole: 'either' })).toThrow(/changed meanwhile/)
  })
})

describe('HR3 on s45: an affected set that can\'t be read never lets the change through', () => {
  for (const [what, fail] of [
    ['the cards', () => void (state.failCards = true)],
    ['the lanes', () => void (state.failLanes = true)],
    ["one of two projects' files", () => {
      state.projects = [{ name: 'demo', path: 'C:/ws/demo' }, { name: 'other', path: 'C:/ws/other' }]
      state.failProject = 'other'
    }]
  ] as const) {
    it(`refuses turning tools off when ${what} can't be read, changing nothing`, async () => {
      fail()
      await expect(launchImpact('c-1', { tools: false })).rejects.toThrow(/couldn't read which agents, lanes and cards/)
      await expect(changeConnection('c-1', { values: { model: 'opus' }, launch: { tools: false } })).rejects.toThrow(/couldn't read which agents, lanes and cards/)
      expect(state.connections[0]).toEqual({ id: 'c-1', account: 'acc', name: 'Claude' })
      expect(state.valuesSaved).toEqual([])
    })
  }

  it("refuses an agent's change to Independent when its cards can't be read", async () => {
    state.failCards = true
    const hb1 = { id: 'b1', name: 'HB1', workflowRole: 'builder' as const, connection: 'c-1' }
    await expect(agentChangeCheck({ path: 'C:/ws', info: () => ({ projects: [] }), projectConfigWrites: () => 0 } as never, 'C:/ws/demo', 'demo', hb1, { workflowRole: 'independent' }, null)).rejects.toThrow(/couldn't read/)
  })
})

describe("HR2 on s47: a project's agents count only as its project.json says, read as the file is", () => {
  const two = (): void => void (state.projects = [{ name: 'demo', path: 'C:/ws/demo' }, { name: 'other', path: 'C:/ws/other' }])

  for (const [what, text] of [
    ['missing', null],
    ["doesn't parse", '{'],
    ['is not an object', '[]'],
    ['has agents that are not a list', JSON.stringify({ agents: { b1: {} } })],
    ['has an agent without an id', JSON.stringify({ agents: [{ name: 'Nameless', connection: 'c-1' }] })],
    ['has an agent whose connection is not text', JSON.stringify({ agents: [{ id: 'z1', connection: 7 }] })]
  ] as const) {
    it(`refuses when another open project's project.json ${what}, changing nothing`, async () => {
      two()
      state.files = { other: text }
      await expect(changeConnection('c-1', { values: { model: 'opus' }, launch: { tools: false } })).rejects.toThrow(/couldn't read which agents, lanes and cards.*other's project\.json/)
      expect(state.connections[0]).toEqual({ id: 'c-1', account: 'acc', name: 'Claude' })
      expect(state.valuesSaved).toEqual([])
    })
  }

  it('takes a valid empty list, or no agents saved, as none there: only the builder on it is named', async () => {
    two()
    state.files = { other: JSON.stringify({ version: 2, agents: [] }) }
    expect((await launchImpact('c-1', { tools: false }))!.agents.map((a) => a.agent)).toEqual(['HB1'])
    state.files = { other: JSON.stringify({ version: 2 }) }
    expect((await launchImpact('c-1', { tools: false }))!.agents.map((a) => a.agent)).toEqual(['HB1'])
  })

  it("refuses while a workspace's projects aren't read yet", async () => {
    state.projects = null as never
    await expect(launchImpact('c-1', { tools: false })).rejects.toThrow(/aren't read yet/)
  })
})
