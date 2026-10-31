// HI-2186: a scenario's measures for its subject (the Assistant, or the agent under test) apart from the other agents
// (a lane's builder and reviewer, agents it or Hive started). The harness (tests/scenarios/benchmark.cjs) measures each
// part from its own series or log lines, never one as the total less the other, and leaves unknown what it can't say;
// Compare (src/shared/benchmark.ts) shows them only when both sides have them, and says when it shows totals instead.
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { compareArtifacts, parseArtifact, readKept, type Artifact, type CompareScope, type ParseResult } from '../src/shared/benchmark'

const require_ = createRequire(import.meta.url)
const { measuresOf, metricsTotals } = require_('./scenarios/benchmark.cjs')

/** Series of one caller role, `n` of each thing. */
const series = (role: 'agent' | 'assistant', n: number) => ({
  api: [{ role, outcome: 'ok', count: n, requestBytes: n, responseBytes: n * 10, totalMs: n }],
  mcp: [{ role, mode: 'compact', outcome: 'ok', count: n, chars: n * 5, bytes: n * 6, totalMs: 1 }],
  guidance: [{ role, workflow: 'none', launches: n ? 1 : 0, guidanceBytes: n * 100, guidanceChars: n * 90, customBytes: 0, customChars: 0, roleBytes: n, roleChars: n, modeBytes: 0, modeChars: 0, skillCatalogBytes: n * 20, skillBytes: n * 1000, skills: 8, skillsNotDelivered: 0, skillsUnmeasured: 0 }],
  catalog: [{ role, workflow: 'none', starts: n, toolsBytes: n * 50, toolsChars: n * 49, charStarts: n }]
})
/** A metrics report: the Assistant's work in the workspace part, project agents' in alpha, the harness's own beside them. */
const report = (assistant: number, agents: number) => {
  const a = series('assistant', assistant)
  const p = series('agent', agents)
  return {
    projects: { alpha: { ...p, api: [...p.api, { role: 'api', outcome: 'ok', count: 100, requestBytes: 1, responseBytes: 1, totalMs: 1 }] } },
    workspace: a,
    skills: { scans: { count: assistant + agents }, hits: 3, misses: 0, invalidations: 0, bytes: 0, tooLarge: 0 },
    dropped: 0,
    recording: true
  }
}

const AT = '2026-10-31T01:00:00.000Z'
const LATER = '2026-10-31T01:00:05.000Z'
const roster = [
  { id: 'a-coder', name: 'Coder', workflowRole: 'either' },
  { id: 'a-impl', name: 'Implementer', workflowRole: 'reviewer' },
  { id: 'a-b2', name: 'Builder2', workflowRole: 'either' }
]
const lanes = [
  { builder: { id: 'a-coder' }, reviewer: { id: 'a-impl' } },
  { builder: { id: 'a-b2' }, reviewer: null }
]
/** A call line of the hive servers' test log; `sized`: as a server from HI-2186 on writes it (mode, chars, bytes). */
const call = (who: { agent?: string; assistant?: boolean }, at = LATER, sized = true, extra: object = {}) => ({ at, tool: 'hive_inbox', role: who.assistant ? 'assistant' : 'agent', project: who.assistant ? '' : 'alpha', agent: who.agent ?? null, ok: true, args: '{}', ...(sized ? { mode: 'compact', chars: 10, bytes: 12 } : {}), ...extra })
const list = (who: { agent?: string; assistant?: boolean }, at = LATER) => ({ at, kind: 'list', role: who.assistant ? 'assistant' : 'agent', project: 'alpha', agent: who.agent ?? null, tools: 40, bytes: 27000, chars: 26900 })
const assistantSubject = (extra: object = {}) => ({ kind: 'assistant', agentId: 'assistant', since: AT, complete: true, fakeCli: true, roster, lanes, ...extra })
const coderSubject = (extra: object = {}) => ({ kind: 'agent', agentId: 'a-coder', since: AT, complete: true, fakeCli: true, roster, lanes, ...extra })

describe('the harness measures the subject apart from the other agents (benchmark.cjs)', () => {
  it('the Assistant as subject: every measure by caller role, and the parts add up to the total where coverage is whole', () => {
    const observed = { hiveCalls: [], allHiveCalls: [call({ assistant: true }), call({ agent: 'a-coder' }), call({ agent: 'a-impl' })], mcpLists: [] }
    const m = measuresOf(report(0, 0), report(2, 3), observed, null, assistantSubject())
    expect(m.subject).toMatchObject({ apiRequests: 2, toolCalls: 2, toolChars: 10, launches: 1, coreBytes: 200, toolListStarts: 2, toolListBytes: 100, toolListChars: 98 })
    expect(m.others).toMatchObject({ apiRequests: 3, toolCalls: 3, toolChars: 15, launches: 1, toolListStarts: 3 })
    // The parts, each its own series, add up to the total (the harness's own requests in neither); the skill service is
    // shared, in neither part.
    for (const k of Object.keys(m.subject)) expect(m.subject[k] + m.others[k]).toBe(m[k])
    expect(m.subject).not.toHaveProperty('skillScans')
    expect(m.others).not.toHaveProperty('dropped')
    // The total's meaning is unchanged: what it was without a split.
    expect(measuresOf(report(0, 0), report(2, 3), observed, null)).toEqual(Object.fromEntries(Object.entries(m).filter(([k]) => !['subject', 'others', 'agents', 'split'].includes(k))))
    expect(metricsTotals(report(2, 3)).apiRequests).toBe(5)
  })

  it('incomplete coverage leaves both parts out (unknown), never a part guessed from the other', () => {
    const m = measuresOf(report(0, 0), report(2, 3), { allHiveCalls: [call({ assistant: true })] }, null, assistantSubject({ complete: false }))
    expect(m).not.toHaveProperty('subject')
    expect(m).not.toHaveProperty('others')
    expect(m.split).toBe('partial')
    expect(m.agents).toEqual([{ agent: 'Assistant', role: 'assistant', side: 'subject', hiveCalls: 1, toolListStarts: 0 }])
  })

  it('an agent as subject: its tool calls and lists from the log by agent; API and launches only when no other agent worked', () => {
    const alone = { allHiveCalls: [call({ agent: 'a-coder' }), call({ agent: 'a-coder' }, LATER, true, { ok: false, mode: 'detail' })], mcpLists: [list({ agent: 'a-coder' }), list({ agent: 'a-coder' })] }
    const a = measuresOf(report(0, 0), report(0, 2), alone, null, coderSubject())
    expect(a.subject).toMatchObject({ toolCalls: 2, toolErrors: 1, toolDetailCalls: 1, toolChars: 20, toolBytes: 24, toolListStarts: 2, toolListBytes: 54000, toolListChars: 53800, apiRequests: 2, launches: 1, coreBytes: 200 })
    expect(a.others).toEqual({ toolCalls: 0, toolErrors: 0, toolDetailCalls: 0, toolChars: 0, toolBytes: 0, toolListStarts: 0, toolListBytes: 0, toolListChars: 0 })
    // Implementer called too: the agent role's API and launches aren't Coder's alone, so unknown for it.
    const shared = { allHiveCalls: [...alone.allHiveCalls, call({ agent: 'a-impl' })], mcpLists: [...alone.mcpLists, list({ agent: 'a-impl' })] }
    const s = measuresOf(report(0, 0), report(0, 3), shared, null, coderSubject())
    expect(s.subject).toMatchObject({ toolCalls: 2, toolListStarts: 2 })
    expect(s.subject).not.toHaveProperty('apiRequests')
    expect(s.subject).not.toHaveProperty('launches')
    expect(s.others).toMatchObject({ toolCalls: 1, toolChars: 10, toolListStarts: 1 })
    expect(s.others).not.toHaveProperty('apiRequests')
  })

  it("a log from before HI-2186: counts known, sizes unknown; tool lists one a call for a fake CLI only, else unknown", () => {
    const old = { allHiveCalls: [call({ agent: 'a-coder' }, LATER, false), call({ agent: 'a-impl' }, LATER, false), call({ agent: 'a-coder' }, LATER, false, { direct: true })] }
    const fake = measuresOf(report(0, 0), report(0, 2), old, null, coderSubject())
    expect(fake.subject).toMatchObject({ toolCalls: 1, toolErrors: 0, toolListStarts: 1 })
    for (const k of ['toolChars', 'toolBytes', 'toolDetailCalls', 'toolListBytes', 'toolListChars']) expect(fake.subject).not.toHaveProperty(k)
    // A fake's board move straight to the API ran no server: a hive call, never a tool call or a tool list.
    expect(fake.agents.find((r: any) => r.agent === 'Coder')).toEqual({ agent: 'Coder', role: 'builder', side: 'subject', hiveCalls: 2, toolListStarts: 1 })
    const real = measuresOf(report(0, 0), report(0, 2), old, null, coderSubject({ fakeCli: false }))
    expect(real.subject).not.toHaveProperty('toolListStarts')
    expect(real.agents.every((r: any) => !('toolListStarts' in r))).toBe(true)
  })

  it('agents by their fixture identity, the subject first, whatever order their calls came in', () => {
    const calls = [call({ agent: 'a-b2' }), call({ agent: 'a-coder' }), call({ agent: 'a-b2' }), call({ assistant: true }), call({ agent: 'a-stranger' })]
    const rows = (xs: object[]) => measuresOf(report(0, 0), report(1, 4), { allHiveCalls: xs, mcpLists: [] }, null, assistantSubject()).agents
    const one = rows(calls)
    expect(one).toEqual([
      { agent: 'Assistant', role: 'assistant', side: 'subject', hiveCalls: 1, toolListStarts: 0 },
      { agent: 'Builder2', role: 'builder', side: 'other', hiveCalls: 2, toolListStarts: 0 },
      { agent: 'Coder', role: 'builder', side: 'other', hiveCalls: 1, toolListStarts: 0 },
      { agent: 'unattributed', role: 'agent', side: 'other', hiveCalls: 1, toolListStarts: 0 }
    ])
    expect(rows([...calls].reverse())).toEqual(one)
    // Calls before the measured window (a setup's) are no agent's part of it.
    expect(rows([call({ agent: 'a-impl' }, '2026-10-31T00:59:00.000Z'), ...calls]).some((r: any) => r.agent === 'Implementer')).toBe(false)
  })

  it('at most 10 rows, an overflow row among them: the subject kept, no call lost', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `a-${i}`, name: `Agent${String(i).padStart(2, '0')}`, workflowRole: null }))
    const calls = [call({ agent: 'a-13' }), ...many.flatMap((a, i) => Array.from({ length: i + 1 }, () => call({ agent: a.id })))]
    const m = measuresOf(report(0, 0), report(0, 1), { allHiveCalls: calls, mcpLists: [] }, null, coderSubject({ agentId: 'a-13', roster: many, lanes: [] }))
    expect(m.agents.length).toBe(10)
    expect(m.agents[0]).toMatchObject({ agent: 'Agent13', side: 'subject', hiveCalls: 15 })
    const overflow = m.agents[9]
    expect(overflow).toMatchObject({ agent: 'overflow', side: 'other', agents: 5 })
    expect(m.agents.reduce((n: number, r: any) => n + r.hiveCalls, 0)).toBe(calls.length)
    // The subject's row is there even when it made no call.
    expect(measuresOf(report(0, 0), report(0, 1), { allHiveCalls: [call({ agent: 'a-impl' })] }, null, coderSubject()).agents[0]).toEqual({ agent: 'Coder', role: 'builder', side: 'subject', hiveCalls: 0, toolListStarts: 0 })
  })
})

const WS: CompareScope = { kind: 'workspace' }
const art = (r: ParseResult): Artifact => {
  if (!('artifact' in r)) throw new Error(JSON.stringify(r))
  return r.artifact
}
const fixture = (): any => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'benchmarks', 'baseline.json'), 'utf8'))
/** The baseline fixture with work-on-card as the Assistant's, split (or not) and with its agents' calls. */
const withSplit = (subjectCalls: number, otherCalls: number, split = true): Artifact => {
  const b = fixture()
  const sc = b.scenarios.find((s: any) => s.id === 'work-on-card')
  sc.role = 'assistant'
  const m = sc.samples[0].measures
  if (split) {
    m.subject = { toolCalls: subjectCalls, toolChars: subjectCalls * 10, apiRequests: subjectCalls * 2 }
    m.others = { toolCalls: otherCalls, toolChars: otherCalls * 10, apiRequests: otherCalls * 2 }
    m.agents = [
      { agent: 'Assistant', role: 'assistant', side: 'subject', hiveCalls: subjectCalls },
      { agent: 'Coder', role: 'builder', side: 'other', hiveCalls: otherCalls, toolListStarts: otherCalls }
    ]
  }
  return art(parseArtifact(JSON.stringify(b), WS))
}
const wo = (c: ReturnType<typeof compareArtifacts>) => c.scenarios!.find((s) => s.id === 'work-on-card')!

describe('Compare shows the subject apart from the other agents (shared/benchmark.ts)', () => {
  it('both sides split: the subject’s and the others’ changes, and each agent’s calls; the result still judges the totals', () => {
    const c = wo(compareArtifacts(withSplit(1, 1), withSplit(1, 4)))
    expect(c.subject).toBe('assistant')
    expect(c.split!.subject.find((d) => d.key === 'toolCalls')).toMatchObject({ delta: 0 })
    expect(c.split!.others.find((d) => d.key === 'toolCalls')).toMatchObject({ delta: 3 })
    // Unknown in a part (not measured there) stays unknown, never 0.
    expect(c.split!.subject.find((d) => d.key === 'toolBytes')).toMatchObject({ base: null, run: null, incomplete: true })
    expect(c.split!.subject.some((d) => ['hiveCalls', 'skillScans', 'seconds'].includes(d.key))).toBe(false)
    expect(c.agents).toEqual([
      { agent: 'Assistant', role: 'assistant', side: 'subject', base: 1, run: 1 },
      { agent: 'Coder', role: 'builder', side: 'other', base: 1, run: 4 }
    ])
    expect(c.notes.some((n) => /per-agent/.test(n))).toBe(false)
    // The status is the totals' (unchanged here), whatever a part did.
    expect(c.status).toBe('same')
  })

  it('a baseline without per-agent figures (every one before HI-2186): totals only, and said so', () => {
    const old = wo(compareArtifacts(withSplit(0, 0, false), withSplit(1, 4)))
    expect(old.split).toBeNull()
    expect(old.agents).toBeNull()
    expect(old.notes).toContain('The baseline has no per-agent figures: totals of all agents shown.')
    expect(old.status).toBe('same')
    expect(wo(compareArtifacts(withSplit(1, 4), withSplit(0, 0, false))).notes).toContain('The run has no per-agent figures: totals of all agents shown.')
    expect(wo(compareArtifacts(withSplit(0, 0, false), withSplit(0, 0, false))).notes).toContain('Neither side has per-agent figures: totals of all agents shown.')
  })

  it('kept and read back, the split and the agents are kept; bad agent rows are left out', () => {
    const a = withSplit(2, 3)
    const kept = JSON.parse(JSON.stringify(a))
    kept.scenarios[0].samples[0].agents.push({ agent: 'x', role: 'boss', side: 'other', hiveCalls: 1 }, { agent: 'y', role: 'agent', side: 'other', hiveCalls: -1 })
    const back = readKept(kept)!
    const s = back.scenarios!.find((x) => x.id === 'work-on-card')!.samples[0]
    expect(s.split!.subject).toMatchObject({ toolCalls: 2, toolChars: 20, apiRequests: 4 })
    expect(s.agents!.map((x) => x.agent)).toEqual(['Assistant', 'Coder'])
    expect(wo(compareArtifacts(back, a)).split).not.toBeNull()
  })

  it('a fake run says its API requests and tool lists count per hive call', () => {
    expect(compareArtifacts(withSplit(1, 1), withSplit(1, 1)).notes.some((n) => /per call, not per session/.test(n))).toBe(true)
  })
})
