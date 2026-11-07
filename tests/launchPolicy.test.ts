import { afterEach, describe, expect, it } from 'vitest'
import { CW_GUIDANCE, overrideId } from '../src/shared/advanced'
import { cleanLaunch, copyAppSwitches, launchesWithoutTools, launchPolicy, MCP_ISOLATION, overrideKeys, plainness, policySummary, terminalPreset } from '../src/shared/launchPolicy'
import { laneView } from '../src/shared/lanes'
import type { LaneRecord } from '../src/shared/lanes'
import type { Connection, TaskCard } from '../src/shared/types'
import { agentWorkflowRole, buildsWork, inWorkflow, readToolsOffWith, reviewsWork, takesCards } from '../src/shared/workflow/roles'

// A connection's launch settings (HI-2670): what of Combwork's its sessions get, and the Independent role they give.

const conn = (launch?: Connection['launch']): Connection => ({ id: 'c-1', account: 'acc', name: 'Plain', ...(launch ? { launch } : {}) })

describe('launchPolicy', () => {
  it("is everything, as before, for a connection with none of its own, and each CLI's overrides by their keys", () => {
    for (const cli of ['claude-code', 'codex', 'copilot'] as const) {
      const p = launchPolicy(conn(), cli)
      expect(p).toMatchObject({ guidance: true, tools: true, typing: true })
      expect(Object.keys(p.overrides).sort()).toEqual(overrideKeys(cli).map((k) => overrideId(cli, k)).sort())
      expect(Object.values(p.overrides).every((v) => v)).toBe(true)
      expect(plainness(conn(), cli)).toBeNull()
    }
    // The real descriptor keys, each CLI its own.
    expect(overrideKeys('claude-code').sort()).toEqual(['mcpIsolation', 'preApproveCombworkTools', 'promptSnapshotOff', 'statusLine'])
    expect(overrideKeys('codex').sort()).toEqual(['mcpIsolation', 'preApproveCombworkTools', 'terminalTitle'])
    expect(overrideKeys('copilot').sort()).toEqual(['allMcpInstructions', 'mcpIsolation', 'noAutoUpdate', 'preApproveCombworkTools', 'stripGitHubTokens'])
  })

  it('"Launch as from a terminal" turns everything off, and is full plainness', () => {
    for (const cli of ['claude-code', 'codex', 'copilot'] as const) {
      const c = conn(terminalPreset(cli))
      const p = launchPolicy(c, cli)
      expect([p.guidance, p.tools, p.typing, ...Object.values(p.overrides)].every((v) => !v)).toBe(true)
      expect(plainness(c, cli)).toBe('full')
      expect(launchesWithoutTools(c)).toBe(true)
      expect(policySummary(c, cli)).toMatch(/^plain/)
    }
  })

  it('takes each switch on its own: guidance alone off keeps tools and typing, and every role', () => {
    const c = conn({ guidance: false })
    expect(launchPolicy(c, 'claude-code')).toMatchObject({ guidance: false, tools: true, typing: true })
    expect(plainness(c, 'claude-code')).toBe('partial')
    expect(launchesWithoutTools(c)).toBe(false)
    expect(policySummary(c, 'claude-code')).toBe('partly plain: guidance off')
  })

  it('keeps the overrides apart: all off but MCP isolation, and the reverse, are separate choices', () => {
    const allButIsolation = conn({ overrides: Object.fromEntries(overrideKeys('claude-code').filter((k) => k !== MCP_ISOLATION).map((k) => [k, false])) })
    const p = launchPolicy(allButIsolation, 'claude-code')
    expect(p.overrides[overrideId('claude-code', MCP_ISOLATION)]).toBe(true)
    expect(p.overrides[overrideId('claude-code', 'statusLine')]).toBe(false)
    const onlyIsolation = launchPolicy(conn({ overrides: { mcpIsolation: false } }), 'claude-code')
    expect(onlyIsolation.overrides[overrideId('claude-code', MCP_ISOLATION)]).toBe(false)
    expect(onlyIsolation.overrides[overrideId('claude-code', 'statusLine')]).toBe(true)
    expect(onlyIsolation).toMatchObject({ guidance: true, tools: true, typing: true })
  })

  it("gives the Assistant its guidance, tools and typing whatever its connection says; its overrides follow the connection", () => {
    const p = launchPolicy(conn(terminalPreset('claude-code')), 'claude-code', { assistant: true })
    expect(p).toMatchObject({ guidance: true, tools: true, typing: true })
    expect(Object.values(p.overrides).every((v) => !v)).toBe(true)
  })
})

describe('cleanLaunch', () => {
  it('keeps only switches turned off and overrides not at their default, of its own CLI', () => {
    expect(cleanLaunch({ guidance: true, tools: false, typing: 'no', overrides: { statusLine: false, mcpIsolation: true, terminalTitle: false, made: false } }, 'claude-code')).toEqual({ tools: false, overrides: { statusLine: false } })
    expect(cleanLaunch({}, 'codex')).toBeUndefined()
    expect(cleanLaunch(null, 'codex')).toBeUndefined()
    expect(cleanLaunch({ guidance: true }, 'codex')).toBeUndefined()
  })
})

describe('copyAppSwitches: the one-time copy of the app-wide switches onto every connection', () => {
  const cliOf = (id: string) => ({ 'a-claude': 'claude-code', 'a-codex': 'codex', 'a-copilot': 'copilot' } as const)[id]
  const connections: Connection[] = [
    { id: 'c-claude', account: 'a-claude', name: 'Claude' },
    { id: 'c-claude-2', account: 'a-claude', name: 'Claude · High', effort: 'high' },
    { id: 'c-codex', account: 'a-codex', name: 'Codex' },
    { id: 'c-copilot', account: 'a-copilot', name: 'Copilot' },
    { id: 'c-gone', account: 'a-gone', name: 'Gone' }
  ]

  it('copies a mix of values, each as it was, onto its own CLI\'s connections, and guidance onto all', () => {
    const r = copyAppSwitches(connections, cliOf, { [CW_GUIDANCE]: false, [overrideId('claude-code', 'statusLine')]: false, [overrideId('claude-code', 'promptSnapshotOff')]: true, [overrideId('codex', 'terminalTitle')]: false, 'cw.other': 5 })
    const by = new Map(r.connections.map((c) => [c.id, c]))
    expect(by.get('c-claude')!.launch).toEqual({ guidance: false, overrides: { statusLine: false } })
    expect(by.get('c-claude-2')).toMatchObject({ effort: 'high', launch: { guidance: false, overrides: { statusLine: false } } })
    // promptSnapshotOff on is its default: nothing to keep.
    expect(launchPolicy(by.get('c-claude'), 'claude-code').overrides[overrideId('claude-code', 'promptSnapshotOff')]).toBe(true)
    expect(by.get('c-codex')!.launch).toEqual({ guidance: false, overrides: { terminalTitle: false } })
    expect(by.get('c-copilot')!.launch).toEqual({ guidance: false })
    // An account no longer known: left as it is.
    expect(by.get('c-gone')!.launch).toBeUndefined()
    expect(r.copied).toEqual([overrideId('claude-code', 'promptSnapshotOff'), overrideId('claude-code', 'statusLine'), overrideId('codex', 'terminalTitle'), CW_GUIDANCE].sort())
  })

  it('changes nothing with nothing set', () => {
    const r = copyAppSwitches(connections, cliOf, {})
    expect(r.connections).toEqual(connections)
    expect(r.copied).toEqual([])
  })
})

describe('the Independent role', () => {
  afterEach(() => readToolsOffWith(() => false))

  it('takes no part in the workflow: never a builder, reviewer, card taker, nor involved at all', () => {
    expect(buildsWork('independent')).toBe(false)
    expect(reviewsWork('independent')).toBe(false)
    expect(takesCards('independent')).toBe(false)
    expect(inWorkflow('independent')).toBe(false)
    for (const r of ['builder', 'reviewer', 'either', 'generalist'] as const) expect(inWorkflow(r)).toBe(true)
  })

  it("is an agent's role while its connection launches without Combwork's tools, its own kept for their return", () => {
    const a = { name: 'HB1', workflowRole: 'builder' as const, toolsOff: true }
    expect(agentWorkflowRole(a)).toBe('builder')
    readToolsOffWith((x) => (x as { toolsOff?: boolean }).toolsOff === true)
    expect(agentWorkflowRole(a)).toBe('independent')
    const off = { ...a, toolsOff: false }
    expect(agentWorkflowRole(off)).toBe('builder')
    expect(a.workflowRole).toBe('builder')
  })

  it('pauses a running lane whose builder or reviewer is Independent now, saying who', () => {
    const rec = { id: 'lane-1', project: 'demo', builder: { id: 'b1', name: 'HB1' }, reviewer: { id: 'r1', name: 'HR1' }, cards: [7], state: 'active', startedAt: '2026-11-07T00:00:00.000Z' } as unknown as LaneRecord
    const cards = new Map<number, TaskCard | null>([[7, { number: 7, title: 'A card', project: 'demo', column: 'doing', agent: 'b1', blocked: null, history: [] } as unknown as TaskCard]])
    const view = laneView(rec, cards, undefined, null, undefined, null, undefined, undefined, null, null, undefined, null, false, null, new Set(['r1']))
    expect(view.state).toBe('paused')
    expect(view.status).toMatchObject({ reason: 'independent', agent: 'HR1' })
    expect(laneView(rec, cards, undefined, null, undefined, null, undefined, undefined, null, null, undefined, null, false, null, new Set()).status?.reason).not.toBe('independent')
  })
})
