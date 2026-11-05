// HI-2186: a scenario's measures for its subject (the Assistant, or the agent under test) apart from the other agents
// (a lane's builder and reviewer, agents it or Combwork started). The harness (tests/scenarios/benchmark.cjs) measures each
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
/** The two metrics snapshots' requests: the measured window is between them. */
const snapshots = { before: { start: '2026-10-31T01:00:00.050Z', end: '2026-10-31T01:00:00.100Z' }, after: { start: '2026-10-31T01:01:00.000Z', end: '2026-10-31T01:01:00.050Z' } }
/** When a report reached Combwork: between the snapshots (the default), before the first, or after the last. */
const IN = { sentAt: '2026-10-31T01:00:10.000Z', doneAt: '2026-10-31T01:00:10.010Z' }
const EARLY = { sentAt: '2026-10-31T00:59:59.500Z', doneAt: '2026-10-31T00:59:59.510Z' }
let seq = 0
type Who = { agent?: string; assistant?: boolean }
/** A call line of the hive servers' test log, with its id; `sized`: with its reply's size (mode, chars, bytes). */
const call = (who: Who, at = LATER, sized = true, extra: object = {}) => ({ at, id: `9.${++seq}`, tool: 'cw_inbox', role: who.assistant ? 'assistant' : 'agent', project: who.assistant ? '' : 'alpha', agent: who.agent ?? null, ok: true, args: '{}', ...(sized ? { mode: 'compact', chars: 10, bytes: 12 } : {}), ...extra })
const list = (who: Who, at = LATER) => ({ at, id: `9.${++seq}`, kind: 'list', role: who.assistant ? 'assistant' : 'agent', project: 'alpha', agent: who.agent ?? null, tools: 40, bytes: 27000, chars: 26900 })
/** The `reported` line for these lines' report. */
const reported = (lines: { id?: string }[], when = IN) => ({ kind: 'reported', ids: lines.map((l) => l.id), ...when })
/** A log: these calls and lists, each reported between the snapshots unless `reports` says otherwise. */
const log = (calls: any[], lists: any[] = [], reports?: object[]) => ({ combworkCalls: [], allCombworkCalls: calls, mcpLists: lists, mcpReports: reports ?? [reported([...calls.filter((c) => !c.direct), ...lists])] })
/** Each agent's call and tool list (one a call), reported between the snapshots: what `report` counts. */
const logOf = (...who: Who[]) => log(who.map((w) => call(w)), who.map((w) => list(w)))
const assistantSubject = (extra: object = {}) => ({ kind: 'assistant', agentId: 'assistant', snapshots, complete: true, roster, lanes, ...extra })
const coderSubject = (extra: object = {}) => ({ kind: 'agent', agentId: 'a-coder', snapshots, complete: true, roster, lanes, ...extra })
/** A report with Combwork's own start-view record of the Assistant (a tool call in the metrics, in no server's log). */
const withStartView = (r: any) => ({ ...r, workspace: { ...r.workspace, mcp: [...r.workspace.mcp, { role: 'assistant', tool: 'session start view', mode: 'compact', outcome: 'ok', count: 1, chars: 900, bytes: 900, totalMs: 1 }] } })
/** Project agents' report with `n` calls of `chars` in all, and `lists` tool lists. */
const agentsReport = (n: number, chars: number, lists = 0) => {
  const r: any = report(0, n)
  r.projects.alpha.mcp[0] = { ...r.projects.alpha.mcp[0], chars, bytes: chars }
  r.projects.alpha.catalog[0] = { ...r.projects.alpha.catalog[0], starts: lists, charStarts: lists }
  return r
}
const A = { assistant: true }
const CODER = { agent: 'a-coder' }
const IMPL = { agent: 'a-impl' }

describe('the harness measures the subject apart from the other agents (benchmark.cjs)', () => {
  it('the Assistant as subject: every measure by caller role, and the parts add up to the total where coverage is whole', () => {
    const observed = logOf(A, A, CODER, IMPL, IMPL)
    const m = measuresOf(report(0, 0), withStartView(report(2, 3)), observed, null, assistantSubject())
    // Combwork's start view is the Assistant's tool call in the metrics (and its reply its context), in no server's log.
    expect(m.subject).toMatchObject({ apiRequests: 2, toolCalls: 3, toolChars: 910, launches: 1, coreBytes: 200, toolListStarts: 2, toolListBytes: 100, toolListChars: 98 })
    expect(m.others).toMatchObject({ apiRequests: 3, toolCalls: 3, toolChars: 15, launches: 1, toolListStarts: 3 })
    expect(m).not.toHaveProperty('split')
    // The parts, each its own series, add up to the total (the harness's own requests in neither); the skill service is
    // shared, in neither part.
    for (const k of Object.keys(m.subject)) expect(m.subject[k] + m.others[k]).toBe(m[k])
    expect(m.subject).not.toHaveProperty('skillScans')
    expect(m.others).not.toHaveProperty('dropped')
    // The total's meaning is unchanged: what it was without a split.
    expect(measuresOf(report(0, 0), withStartView(report(2, 3)), observed, null)).toEqual(Object.fromEntries(Object.entries(m).filter(([k]) => !['subject', 'others', 'agents', 'split'].includes(k))))
    expect(metricsTotals(report(2, 3)).apiRequests).toBe(5)
    expect(m.agents.map((r: any) => [r.agent, r.combworkCalls, r.toolListStarts])).toEqual([
      ['Assistant', 2, 2],
      ['Coder', 1, 1],
      ['Implementer', 2, 2]
    ])
  })

  it('incomplete coverage leaves both parts out (unknown), never a part guessed from the other', () => {
    const m = measuresOf(report(0, 0), report(1, 0), logOf(A), null, assistantSubject({ complete: false }))
    expect(m).not.toHaveProperty('subject')
    expect(m).not.toHaveProperty('others')
    expect(m.split).toBe('partial')
    expect(m.agents).toEqual([{ agent: 'Assistant', role: 'assistant', side: 'subject', combworkCalls: 1, toolListStarts: 1 }])
  })

  it('an agent as subject: its tool calls and lists from the log by agent; its API and launches unknown', () => {
    const own = log([call(CODER), call(CODER, LATER, true, { ok: false, mode: 'detail' })], [list(CODER), list(CODER)])
    const a = measuresOf(report(0, 0), report(0, 2), own, null, coderSubject())
    expect(a.subject).toEqual({ toolCalls: 2, toolErrors: 1, toolDetailCalls: 1, toolChars: 20, toolBytes: 24, toolListStarts: 2, toolListBytes: 54000, toolListChars: 53800 })
    expect(a.others).toEqual({ toolCalls: 0, toolErrors: 0, toolDetailCalls: 0, toolChars: 0, toolBytes: 0, toolListStarts: 0, toolListBytes: 0, toolListChars: 0 })
    const shared = measuresOf(report(0, 0), report(0, 3), logOf(CODER, CODER, IMPL), null, coderSubject())
    expect(shared.subject).toMatchObject({ toolCalls: 2, toolListStarts: 2 })
    expect(shared.others).toMatchObject({ toolCalls: 1, toolChars: 10, toolListStarts: 1 })
    for (const part of [shared.subject, shared.others]) for (const k of ['apiRequests', 'launches', 'coreBytes']) expect(part).not.toHaveProperty(k)
  })

  it('another agent that launched and listed its tools but made no call: none of its launch or list is the subject’s', () => {
    // Coder runs on and calls twice; Implementer is launched (guidance) and lists the tools, calling nothing.
    const after = report(0, 2)
    after.projects.alpha.guidance[0].launches = 1
    after.projects.alpha.catalog[0].starts = 3
    after.projects.alpha.catalog[0].charStarts = 3
    const m = measuresOf(report(0, 0), after, log([call(CODER), call(CODER)], [list(CODER), list(CODER), list(IMPL)]), null, coderSubject())
    expect(m.subject).toMatchObject({ toolCalls: 2, toolListStarts: 2 })
    for (const k of ['launches', 'coreBytes', 'apiRequests']) expect(m.subject).not.toHaveProperty(k)
    expect(m.others).toMatchObject({ toolCalls: 0, toolListStarts: 1 })
    expect(m.agents.find((r: any) => r.agent === 'Implementer')).toEqual({ agent: 'Implementer', role: 'reviewer', side: 'other', combworkCalls: 0, toolListStarts: 1 })
  })

  it('a fake’s board move straight to the API ran no server: a hive call of the window, never a tool call or a tool list', () => {
    const m = measuresOf(report(0, 0), report(0, 1), log([call(CODER), call(CODER, LATER, true, { direct: true })], [list(CODER)]), null, coderSubject())
    expect(m.subject).toMatchObject({ toolCalls: 1, toolListStarts: 1 })
    expect(m.agents[0]).toEqual({ agent: 'Coder', role: 'builder', side: 'subject', combworkCalls: 2, toolListStarts: 1 })
  })

  it('agents by their fixture identity, the subject first, whatever order their calls came in', () => {
    const who = [{ agent: 'a-b2' }, CODER, { agent: 'a-b2' }, A, { agent: 'a-stranger' }]
    const rows = (ws: Who[]) => measuresOf(report(0, 0), report(1, 4), logOf(...ws), null, assistantSubject()).agents
    const one = rows(who)
    expect(one).toEqual([
      { agent: 'Assistant', role: 'assistant', side: 'subject', combworkCalls: 1, toolListStarts: 1 },
      { agent: 'Builder2', role: 'builder', side: 'other', combworkCalls: 2, toolListStarts: 2 },
      { agent: 'Coder', role: 'builder', side: 'other', combworkCalls: 1, toolListStarts: 1 },
      { agent: 'unattributed', role: 'agent', side: 'other', combworkCalls: 1, toolListStarts: 1 }
    ])
    expect(rows([...who].reverse())).toEqual(one)
  })

  describe('the window holds the very calls the metrics counted between the snapshots, by each one’s report (HR3 rounds 1 and 2)', () => {
    it('crossings that cancel out: the call Combwork took between the snapshots is the one counted, whatever was logged when', () => {
      // HR3's probe: Implementer's 100-character call was logged before the first snapshot but reported after it; Coder's
      // 10-character call was logged after the first snapshot was asked for, yet Combwork already had it then. One call each
      // side, but not the same call: the window is Implementer's.
      const other = call(IMPL, '2026-10-31T00:59:59.000Z', true, { chars: 100, bytes: 100 })
      const subj = call(CODER, '2026-10-31T01:00:00.001Z')
      const before = agentsReport(1, 10)
      const after = agentsReport(2, 110)
      const m = measuresOf(before, after, log([other, subj], [], [reported([subj], { sentAt: '2026-10-31T01:00:00.005Z', doneAt: '2026-10-31T01:00:00.020Z' }), reported([other])]), null, coderSubject())
      expect([m.toolCalls, m.toolChars]).toEqual([1, 100])
      expect(m.subject).toMatchObject({ toolCalls: 0, toolChars: 0 })
      expect(m.others).toMatchObject({ toolCalls: 1, toolChars: 100 })
      expect(m.agents.map((r: any) => [r.agent, r.combworkCalls])).toEqual([
        ['Coder', 0],
        ['Implementer', 1]
      ])
      expect(m).not.toHaveProperty('split')
    })

    it('a call that can’t be placed leaves the log unused: a report that overlapped a snapshot, none on record, a line without an id', () => {
      const c = call(CODER)
      const overlapping = measuresOf(report(0, 0), report(0, 1), log([c], [], [reported([c], { sentAt: '2026-10-31T01:00:00.060Z', doneAt: '2026-10-31T01:00:00.200Z' })]), null, coderSubject())
      expect(overlapping).not.toHaveProperty('subject')
      expect(overlapping).not.toHaveProperty('agents')
      expect(overlapping.split).toBe('partial')
      const unreported = measuresOf(report(0, 0), report(0, 1), log([call(CODER)], [], []), null, coderSubject())
      expect(unreported).not.toHaveProperty('subject')
      expect(unreported.split).toBe('partial')
      // Two calls alike but for whose they are, one without an id (a log from before HI-2186): which one Combwork counted
      // can't be proved, so neither part is said.
      const a = call(CODER)
      const b = { ...call(IMPL), id: undefined }
      const unproved = measuresOf(agentsReport(0, 0), agentsReport(1, 10), log([a, b], [], [reported([a])]), null, coderSubject())
      expect(unproved).not.toHaveProperty('subject')
      expect(unproved.split).toBe('partial')
      // The Assistant's parts are the metrics' own, so they stand; only the log's rows go.
      const asst = measuresOf(report(0, 0), report(1, 0), log([call(A)], [list(A)], []), null, assistantSubject())
      expect(asst.subject).toMatchObject({ toolCalls: 1 })
      expect(asst).not.toHaveProperty('agents')
      expect(asst.split).toBe('partial')
    })

    it('calls Combwork took before the first snapshot or after the last are no part of the window', () => {
      const setup = call(IMPL, '2026-10-31T00:59:00.000Z')
      const own = call(CODER)
      const late = call(CODER, '2026-10-31T01:01:00.060Z')
      const unreportedLate = call(IMPL, '2026-10-31T01:01:00.070Z')
      const m = measuresOf(agentsReport(1, 10), agentsReport(2, 20), log([setup, own, late, unreportedLate], [], [reported([setup], EARLY), reported([own]), reported([late], { sentAt: '2026-10-31T01:01:00.080Z', doneAt: '2026-10-31T01:01:00.090Z' })]), null, coderSubject())
      expect(m.subject).toMatchObject({ toolCalls: 1 })
      expect(m.others).toMatchObject({ toolCalls: 0 })
      expect(m.agents.map((r: any) => [r.agent, r.combworkCalls])).toEqual([['Coder', 1]])
    })

    it('placed, but counts that still differ from the metrics’: the log unused', () => {
      const m = measuresOf(report(0, 0), report(0, 0), logOf(CODER), null, coderSubject())
      expect(m.toolCalls).toBe(0)
      expect(m).not.toHaveProperty('subject')
      expect(m.split).toBe('partial')
    })
  })

  it('at most 10 rows, an overflow row among them: the subject kept, no call lost', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `a-${i}`, name: `Agent${String(i).padStart(2, '0')}`, workflowRole: null }))
    const who = [{ agent: 'a-13' }, ...many.flatMap((a, i) => Array.from({ length: i + 1 }, () => ({ agent: a.id })))]
    const m = measuresOf(report(0, 0), report(0, who.length), logOf(...who), null, coderSubject({ agentId: 'a-13', roster: many, lanes: [] }))
    expect(m.agents.length).toBe(10)
    expect(m.agents[0]).toMatchObject({ agent: 'Agent13', side: 'subject', combworkCalls: 15 })
    expect(m.agents[9]).toMatchObject({ agent: 'overflow', side: 'other', agents: 5 })
    expect(m.agents.reduce((n: number, r: any) => n + r.combworkCalls, 0)).toBe(who.length)
    // The subject's row is there even when it made no call.
    expect(measuresOf(report(0, 0), report(0, 1), logOf(IMPL), null, coderSubject()).agents[0]).toEqual({ agent: 'Coder', role: 'builder', side: 'subject', combworkCalls: 0, toolListStarts: 0 })
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
      { agent: 'Assistant', role: 'assistant', side: 'subject', combworkCalls: subjectCalls },
      { agent: 'Coder', role: 'builder', side: 'other', combworkCalls: otherCalls, toolListStarts: otherCalls }
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
    expect(c.split!.subject.some((d) => ['combworkCalls', 'skillScans', 'seconds'].includes(d.key))).toBe(false)
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
    kept.scenarios[0].samples[0].agents.push({ agent: 'x', role: 'boss', side: 'other', combworkCalls: 1 }, { agent: 'y', role: 'agent', side: 'other', combworkCalls: -1 })
    const back = readKept(kept)!
    const s = back.scenarios!.find((x) => x.id === 'work-on-card')!.samples[0]
    expect(s.split!.subject).toMatchObject({ toolCalls: 2, toolChars: 20, apiRequests: 4 })
    expect(s.agents!.map((x) => x.agent)).toEqual(['Assistant', 'Coder'])
    expect(wo(compareArtifacts(back, a)).split).not.toBeNull()
  })

  it('a run on the fake Claude Code or fake Codex says its API requests and tool lists count per hive call; fake-copilot’s doesn’t', () => {
    const perCall = (x: Artifact, y: Artifact) => compareArtifacts(x, y).notes.some((n) => /per call, not per session/.test(n))
    expect(perCall(withSplit(1, 1), withSplit(1, 1))).toBe(true)
    const on = (provider: string): Artifact => {
      const x = withSplit(1, 1)
      return { ...x, run: { ...x.run!, provider } }
    }
    expect(perCall(on('fake-codex'), on('fake-codex'))).toBe(true)
    // fake-copilot runs the real Copilot CLI offline: one hive server a session, as a real CLI.
    expect(perCall(on('fake-copilot'), on('fake-copilot'))).toBe(false)
  })
})
