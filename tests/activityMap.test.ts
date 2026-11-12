// The Activity map's model (HI-2903): stations from each provider's recorded tool names, names-only labels, counts,
// heat, partial and unknown states, the pulses' baseline, and the context number the pane footer shows.
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { SCRIPT_CALLS, activityTurns, type ActivityTurns } from '../src/shared/activity'
import { MAP_AGENTS, MAP_CALLS, MAX_PULSES, boundAgents, buildMapModel, contextLevel, diffPulses, hostLabel, liveIn, mapContextEntries, mapContextKey, mapLabel, mapMode, mcpParts, pathLabel, stationOf, stationTitle, type MapAgentInput, type MapCall, type MapStation } from '../src/shared/activityMap'
import { contextShown } from '../src/shared/defaults'
import { setLanguage } from '../src/shared/i18n'
import type { TranscriptItem } from '../src/shared/types'
import { ConversationParser } from '../src/main/providers/claude/conversation'
import { CodexConversationParser } from '../src/main/providers/codex/rollout'
import { CopilotConversationParser } from '../src/main/providers/copilot/events'
import { OpencodeConversationParser, buildMirror } from '../src/main/providers/opencode/mirror'
void electron
const { AntigravityConversationParser } = await import('../src/main/providers/antigravity/transcript')

const F = join(__dirname, 'fixtures')
const read = (...p: string[]): string => readFileSync(join(F, ...p), 'utf8')
const items = (p: { feed(b: Buffer): number; items: TranscriptItem[] }, text: string): TranscriptItem[] => {
  p.feed(Buffer.from(text))
  return p.items
}
/** A fixture's calls as the map counts them: through activityTurns (the Activity tab's read), each with its station. */
const stations = (list: TranscriptItem[]): [string, MapStation][] =>
  activityTurns(list).turns.flatMap((t) => t.tools.flatMap((tool) => (tool.calls?.length ? tool.calls : [tool.name]).map((n): [string, MapStation] => [n, stationOf(n).station])))

const opencode = (file: string): TranscriptItem[] => {
  const oc = join(F, 'opencode', 'real-2.2.6')
  const info = JSON.parse(readFileSync(join(oc, 'wire', 'session-after-turn.json'), 'utf8')).body.data
  const msgs = [...JSON.parse(readFileSync(join(oc, 'messages', file), 'utf8')).body.data].reverse()
  return items(new OpencodeConversationParser(null), buildMirror({ w: 1, epoch: 1, source: 'api' }, info, msgs))
}

describe("each provider's recorded tool names go to their stations", () => {
  it('Claude Code', () => {
    const got = new Map(stations(items(new ConversationParser('C:\\work'), read('turns', 'claude-2.1.306.jsonl'))))
    expect(got.get('Bash')).toBe('shell')
    expect(got.get('Read')).toBe('read')
    expect(got.get('Edit')).toBe('edit')
    expect(got.get('Write')).toBe('edit')
    // Combwork's tools under their old server name: an MCP tool (Tools), never another station.
    expect(got.get('hive · hive_inbox')).toBe('tools') // old-name: the recorded fixture (Claude Code 2.1.306) names Combwork's server as it was then
  })

  it("Codex: a code-mode script counts where its calls went, not as one Script", () => {
    // Cut down to the turn's calls (no prompt): a prompt put before them, as Activity's turns start at one.
    const prompt = { kind: 'user', id: -1, text: 'go', timestamp: null } as unknown as TranscriptItem
    const got = stations([prompt, ...items(new CodexConversationParser('C:\\work\\alpha'), read('codex-0.166.0-code-mode.jsonl'))])
    expect(got).toEqual([['Shell', 'shell'], ['Edit', 'edit'], ['probe · echo', 'tools']])
    expect(stationOf('probe · echo').group).toBe('mcp')
  })

  it('Copilot', () => {
    const all = readdirSync(join(F, 'copilot', 'session-state')).flatMap((id) => stations(items(new CopilotConversationParser(null as never), read('copilot', 'session-state', id, 'events.jsonl'))))
    const got = new Map(all)
    expect(got.get('PowerShell')).toBe('shell')
    expect(got.get('Question')).toBe('you')
    expect(got.get('Write')).toBe('edit')
  })

  it('Antigravity', () => {
    const all = readdirSync(join(F, 'antigravity'))
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => stations(items(new (AntigravityConversationParser as unknown as new (x: null) => ConversationParser)(null), read('antigravity', f))))
    const got = new Map(all)
    expect(got.get('read_file')).toBe('read')
    expect(got.get('edit_file')).toBe('edit')
    expect(got.get('run_command')).toBe('shell')
    expect(got.get('invoke_subagent')).toBe('agents')
    expect(got.get('manage_subagents')).toBe('agents')
    expect(got.get('"probe-A" · "probe_whoami"')).toBe('tools')
  })

  it("OpenCode: its own names, and an execute script's calls", () => {
    const got = new Map([...stations(opencode('read-image.json')), ...stations(opencode('shell-permission-once.json')), ...stations(opencode('subagent-parent.json')), ...stations(opencode('mcp-through-execute.json'))])
    expect(got.get('read')).toBe('read')
    expect(got.get('shell')).toBe('shell')
    expect(got.get('subagent')).toBe('agents')
    expect(got.get('combwork.ping_combwork')).toBe('tools')
    expect(stationOf('combwork.ping_combwork').group).toBe('combwork')
    expect(got.has('execute')).toBe(false)
  })

  it('groups the Tools station: web, skills, Combwork, other MCP, the rest', () => {
    expect(stationOf('WebFetch')).toEqual({ station: 'tools', group: 'web' })
    expect(stationOf('WebSearch')).toEqual({ station: 'tools', group: 'web' })
    expect(stationOf('Skill')).toEqual({ station: 'tools', group: 'skill' })
    expect(stationOf('mcp__combwork__cw_inbox')).toEqual({ station: 'tools', group: 'combwork' })
    expect(stationOf('combwork · cw_inbox')).toEqual({ station: 'tools', group: 'combwork' })
    expect(stationOf('mcp__github__get_issue')).toEqual({ station: 'tools', group: 'mcp' })
    expect(stationOf('ToolSearch')).toEqual({ station: 'tools', group: 'other' })
    expect(mcpParts('Bash')).toBeNull()
  })
})

describe('names only, fail-closed (HR2, s11 gap 3)', () => {
  it("shows a path tool's path as its last two segments", () => {
    expect(mapLabel({ name: 'Read', summary: 'src/shared/activity.ts' })).toBe('shared/activity.ts')
    expect(mapLabel({ name: 'edit_file', summary: 'C:\\work\\notes.txt' })).toBe('work/notes.txt')
    expect(mapLabel({ name: 'Write', summary: 'notes.txt' })).toBe('notes.txt')
    // Codex's patch: several paths, the first and how many more.
    expect(mapLabel({ name: 'Edit', summary: 'a/b.ts, c/d.ts, e.ts' })).toBe('a/b.ts +2')
  })

  it("never shows anything else a summary holds: prose, a query, a pattern, a script, quoted shell", () => {
    expect(mapLabel({ name: 'Read', summary: 'my secret notes.txt' })).toBe('Read')
    expect(mapLabel({ name: 'Edit', summary: 'a/b.ts, not a path' })).toBe('Edit')
    expect(mapLabel({ name: 'Grep', summary: 'password.txt in src' })).toBe('Grep')
    expect(mapLabel({ name: 'Glob', summary: 'src/**/*.ts' })).toBe('Glob')
    expect(mapLabel({ name: 'Bash', summary: 'npm run lint' })).toBe('Bash')
    expect(mapLabel({ name: 'Bash', summary: '"C:\\tools\\deploy.exe" --token abc' })).toBe('Bash')
    expect(mapLabel({ name: 'PowerShell', summary: 'Get-Content $env:USERPROFILE\\secret.txt | Out-File x' })).toBe('PowerShell')
    expect(mapLabel({ name: 'run_command', summary: 'Read first line of notes.txt' })).toBe('run_command')
    expect(mapLabel({ name: 'WebSearch', summary: 'how to rotate leaked api keys' })).toBe('WebSearch')
    expect(mapLabel({ name: 'Script', summary: 'const r = await tools.exec_command({cmd:"x"})' })).toBe('Script')
    expect(mapLabel({ name: 'Agent', summary: 'Find every secret in the repo' })).toBe('Agent')
    expect(mapLabel({ name: 'mcp__combwork__cw_inbox', summary: 'ack m12' })).toBe('cw_inbox')
    expect(mapLabel({ name: 'combwork · cw_read_task', summary: 'HI-12' })).toBe('cw_read_task')
  })

  it("shows a fetched URL's host only: no userinfo, port, path or query", () => {
    expect(mapLabel({ name: 'WebFetch', summary: 'https://user:pw@docs.example.com:8443/private/a?token=x#y' })).toBe('docs.example.com')
    expect(mapLabel({ name: 'WebFetch', summary: 'file:///C:/secret.txt' })).toBe('WebFetch')
    expect(mapLabel({ name: 'WebFetch', summary: 'fetch the docs page' })).toBe('WebFetch')
    expect(hostLabel('http://localhost:3000/x')).toBe('localhost')
  })

  it('takes a path only when the whole text is one', () => {
    expect(pathLabel('contextPercent')).toBeNull()
    expect(pathLabel('a b/c.ts')).toBeNull()
    expect(pathLabel('src/a.ts; rm -rf x')).toBeNull()
    expect(pathLabel('$(whoami)/x.ts')).toBeNull()
    expect(pathLabel('/one/two/three.md')).toBe('two/three.md')
  })
})

const turnsOf = (sessionId: string, tools: { name: string; summary?: string; at?: string | null; failed?: boolean; done?: boolean; calls?: string[] }[][], from = 1): ActivityTurns => {
  let id = from
  return {
    sessionId,
    version: 'v',
    total: tools.length,
    turns: tools.map((list) => ({ itemId: id++, at: null, prompt: '', reply: '', lastKind: 'tool' as const, tools: list.map((t) => ({ itemId: id++, name: t.name, summary: t.summary ?? '', at: t.at ?? null, until: null, failed: !!t.failed, done: t.done ?? true, ...(t.calls ? { calls: t.calls } : {}) })) }))
  }
}
const agent = (key: string, over: Partial<MapAgentInput> = {}): MapAgentInput => ({ key, name: key, state: 'working', waiting: false, doing: 'tool', card: null, context: null, sessionKey: `${key}-s`, turns: undefined, subagents: 0, tasks: [], processes: [], blocks: 0, ...over })

describe("the map's model", () => {
  const AT = Date.parse('2026-11-10T12:00:00Z')
  const ago = (min: number): string => new Date(AT - min * 60_000).toISOString()

  it('counts this turn, heat from the last ten minutes of the turns read, the last label and a failure', () => {
    const turns = turnsOf('s', [[{ name: 'Read', summary: 'a/old.ts', at: ago(30) }], [{ name: 'Read', summary: 'src/a.ts', at: ago(2) }, { name: 'Bash', at: ago(1), failed: true }, { name: 'Edit', summary: 'src/b.ts', at: ago(0.5), done: false }]])
    const m = buildMapModel([agent('A', { turns })], AT)
    expect(m.stations.read).toMatchObject({ status: 'ok', count: 1, heat: 1, last: 'src/a.ts', failed: false })
    expect(m.stations.shell).toMatchObject({ count: 1, failed: true, last: 'Bash' })
    expect(m.stations.edit).toMatchObject({ count: 1, here: ['A'], last: 'src/b.ts' })
    expect(m.stations.agents).toMatchObject({ status: 'ok', count: 0 })
    expect(m.feed.filter((c) => c.kind !== 'prompt').map((c) => c.label)).toEqual(['src/b.ts', 'Bash', 'src/a.ts', 'a/old.ts'])
    expect(m.agents[0].load).toBe('loaded')
  })

  it("tells loading, not reported and an observed zero apart", () => {
    expect(buildMapModel([agent('A')], 0).stations.read.status).toBe('loading')
    const zero = buildMapModel([agent('A', { turns: turnsOf('s', [[]]) })], 0)
    expect(zero.stations.read).toMatchObject({ status: 'ok', count: 0 })
    const unsupported = buildMapModel([agent('A', { turns: turnsOf('s', [[]]), reported: ['you', 'read', 'edit', 'shell', 'tools'] })], 0)
    expect(unsupported.stations.agents.status).toBe('notReported')
    // Reported by one shown agent's provider: the station is reported.
    const mixed = buildMapModel([agent('A', { turns: turnsOf('s', [[]]), reported: ['you'] }), agent('B', { turns: turnsOf('t', [[]]) })], 0)
    expect(mixed.stations.agents.status).toBe('ok')
  })

  it("counts Agents from subagent sessions, background tasks and agent calls alike", () => {
    const m = buildMapModel([agent('A', { turns: turnsOf('s', [[{ name: 'Agent' }]]), subagents: 1, tasks: [{ type: 'command' }] })], 0)
    expect(m.stations.agents.count).toBe(3)
  })

  it("marks You for an agent waiting, Edit for a lock block, and Shell's last as a running process's name", () => {
    const m = buildMapModel([agent('A', { turns: turnsOf('s', [[{ name: 'Bash' }]]), waiting: true, blocks: 1, processes: ['node.exe'] })], 0)
    expect(m.stations.you.here).toEqual(['A'])
    expect(m.stations.edit.failed).toBe(true)
    expect(m.stations.shell.last).toBe('node.exe')
  })

  it('counts a Codex or OpenCode script by its calls', () => {
    const m = buildMapModel([agent('A', { turns: turnsOf('s', [[{ name: 'Script', summary: 'const x = 1', calls: ['Shell', 'Edit'] }]]) })], 0)
    expect(m.stations.shell.count).toBe(1)
    expect(m.stations.edit.count).toBe(1)
    expect(m.stations.edit.last).toBe('Edit')
    expect(m.stations.tools.count).toBe(0)
  })

  it("counts a turn's prompt at You, by the word for one (never its text), and sends it as a pulse once new", () => {
    const m = buildMapModel([agent('A', { turns: turnsOf('s', [[]]) })], 0)
    expect(m.stations.you).toMatchObject({ count: 1, lastKind: 'prompt', last: '' })
    expect(m.feed.map((c) => [c.station, c.kind, c.label])).toEqual([['you', 'prompt', '']])
    const next = (() => {
      let n = 0
      return () => `p${++n}`
    })()
    const before = diffPulses(null, [], next, undefined, ['A-s'])
    const r = diffPulses(before.seen, m.calls, next, before.sessions, m.sessions)
    expect(r.pulses.map((p) => [p.station, p.back])).toEqual([['you', false], ['you', true]])
  })

  it('reads no more of a huge turn or a huge script than its budget: the latest calls, nothing earlier visited (HR2, round 1)', () => {
    // Each summary and each script call counted as it is read: the walk stops at the budget.
    let visited = 0
    const tools = Array.from({ length: 10_000 }, (_, i) => ({
      itemId: i + 2,
      name: 'Read',
      get summary(): string {
        visited++
        return `src/f${i}.ts`
      },
      at: null,
      until: null,
      failed: false,
      done: true
    }))
    const huge: ActivityTurns = { sessionId: 's', version: 'v', total: 1, turns: [{ itemId: 1, at: null, prompt: '', reply: '', lastKind: 'tool', tools }] }
    const m = buildMapModel([agent('A', { turns: huge })], 0)
    expect(m.calls).toHaveLength(MAP_CALLS)
    expect(visited).toBeLessThanOrEqual(MAP_CALLS)
    expect(m.calls.at(-1)?.label).toBe('src/f9999.ts')
    expect(m.agents[0].capped).toBe(true)
    let indexed = 0
    const calls = new Proxy(Array.from({ length: 10_000 }, () => 'Bash'), {
      get(t, k, r) {
        if (typeof k === 'string' && /^\d+$/.test(k)) indexed++
        return Reflect.get(t, k, r)
      }
    })
    const script: ActivityTurns = { sessionId: 's', version: 'v', total: 1, turns: [{ itemId: 1, at: null, prompt: '', reply: '', lastKind: 'tool', tools: [{ itemId: 2, name: 'Script', summary: '', at: null, until: null, failed: false, done: true, calls }] }] }
    const ms = buildMapModel([agent('A', { turns: script })], 0)
    expect(ms.stations.shell.count).toBe(MAP_CALLS)
    expect(indexed).toBeLessThanOrEqual(MAP_CALLS)
    expect(ms.stations.shell.partial).toBe(true)
  })

  it("keeps a script's latest SCRIPT_CALLS call names on main, and how many earlier ones there were", () => {
    const tool = (n: number) => ({ id: 2, kind: 'tool', timestamp: null, tool: { toolUseId: 't', name: 'Script', summary: '', input: '', result: 'ok', isError: false, images: [], calls: Array.from({ length: n }, (_, i) => ({ toolUseId: `c${i}`, name: i % 2 ? 'Shell' : 'Edit', summary: 'secret', input: '', result: '', isError: false, images: [] })) } })
    const prompt = { id: 1, kind: 'user', text: 'go', timestamp: null }
    const big = activityTurns([prompt, tool(SCRIPT_CALLS + 600)] as unknown as TranscriptItem[]).turns[0].tools[0]
    expect(big.calls).toHaveLength(SCRIPT_CALLS)
    expect(big.callsMore).toBe(600)
    const small = activityTurns([prompt, tool(3)] as unknown as TranscriptItem[]).turns[0].tools[0]
    expect(small).toMatchObject({ calls: ['Edit', 'Shell', 'Edit'] })
    expect(small.callsMore).toBeUndefined()
    expect(buildMapModel([agent('A', { turns: { sessionId: 's', version: 'v', total: 1, turns: [{ itemId: 1, at: null, prompt: '', reply: '', lastKind: 'tool', tools: [big] }] } })], 0).agents[0].capped).toBe(true)
  })

  it("keys a long script's kept calls by their place in the whole script: a call added past the cut pulses once, the rest keep their keys (HR2, round 2)", () => {
    const script = (calls: string[], callsMore: number): ActivityTurns => ({ sessionId: 's', version: 'v', total: 1, turns: [{ itemId: 1, at: null, prompt: '', reply: '', lastKind: 'tool', tools: [{ itemId: 2, name: 'Script', summary: '', at: null, until: null, failed: false, done: false, calls, callsMore }] }] })
    const before = buildMapModel([agent('A', { turns: script(Array.from({ length: SCRIPT_CALLS }, () => 'Read'), 100) })], 0)
    // One more call: the kept tail moves on by one, its first call left out.
    const after = buildMapModel([agent('A', { turns: script([...Array.from({ length: SCRIPT_CALLS - 1 }, () => 'Read'), 'Edit'], 101) })], 0)
    const keys = (m: typeof before) => m.calls.filter((c) => c.kind !== 'prompt').map((c) => c.key)
    expect(keys(before).at(-1)).toBe('A-s\n2.499')
    expect(keys(after).at(-1)).toBe('A-s\n2.500')
    expect(keys(after).slice(0, -1)).toEqual(keys(before).slice(1))
    const next = (() => {
      let n = 0
      return () => `p${++n}`
    })()
    const base = diffPulses(null, before.calls, next, undefined, before.sessions)
    const r = diffPulses(base.seen, after.calls, next, base.sessions, after.sessions)
    expect(r.pulses.map((p) => [p.station, p.back])).toEqual([['edit', false]])
  })

  it('caps one huge turn at MAP_CALLS calls, the latest, and says the counts are partial', () => {
    const huge = Array.from({ length: MAP_CALLS + 250 }, (_, i) => ({ name: i % 2 ? 'Read' : 'Bash' }))
    const m = buildMapModel([agent('A', { turns: turnsOf('s', [huge]) })], 0)
    expect(m.calls).toHaveLength(MAP_CALLS)
    expect(m.agents[0].capped).toBe(true)
    expect(m.stations.read.partial).toBe(true)
    expect(m.stations.read.count + m.stations.shell.count).toBe(MAP_CALLS)
  })

  it("keeps two hosts' agents and sessions apart when their ids are the same (the workspace level)", () => {
    const a = agent('C:/one\na-1', { sessionKey: 'c:/one\ns-1', turns: turnsOf('s-1', [[{ name: 'Read' }]]) })
    const b = agent('C:/two\na-1', { sessionKey: 'c:/two\ns-1', turns: turnsOf('s-1', [[{ name: 'Read' }]]) })
    const m = buildMapModel([a, b], 0)
    expect(new Set(m.calls.filter((c) => c.kind !== 'prompt').map((c) => c.key)).size).toBe(2)
    expect(m.stations.read.count).toBe(2)
    expect(m.stations.you.count).toBe(2)
    expect(new Set(m.calls.map((c) => c.agentKey))).toEqual(new Set([a.key, b.key]))
  })

  it("bounds the shared map at MAP_AGENTS agents read; the rest are shown as not loaded, and the counts as partial", () => {
    const many = boundAgents(Array.from({ length: MAP_AGENTS + 2 }, (_, i) => agent(`A${i}`, { turns: turnsOf(`s${i}`, [[{ name: 'Read' }]]) })))
    const m = buildMapModel(many, 0)
    expect(m.agents.filter((a) => a.load === 'notLoaded')).toHaveLength(2)
    expect(m.stations.read.count).toBe(MAP_AGENTS)
    expect(m.stations.read.partial).toBe(true)
  })

  it('shows one agent with exactly one in the filter, else the shared map', () => {
    expect(mapMode(['a'])).toBe('single')
    expect(mapMode([])).toBe('shared')
    expect(mapMode(undefined)).toBe('shared')
    expect(mapMode(['a', 'b'])).toBe('shared')
  })
})

describe('pulses (HR2, s11 gap 2)', () => {
  const call = (key: string, done: boolean, station: MapStation = 'read', sessionKey = 's'): MapCall => ({ key, sessionKey, agentKey: 'A', station, label: 'x', at: null, failed: false, done })
  const ids = (): (() => string) => {
    let n = 0
    return () => `p${++n}`
  }

  it("a new scope's baseline sends nothing, however many calls it holds", () => {
    const { pulses, seen } = diffPulses(null, [call('1', true), call('2', false)], ids())
    expect(pulses).toEqual([])
    expect([...seen.keys()]).toEqual(['1', '2'])
  })

  it('a new call goes out; its result coming back sends one return, once', () => {
    const next = ids()
    let r = diffPulses(null, [call('1', true)], next)
    r = diffPulses(r.seen, [call('1', true), call('2', false, 'shell')], next, r.sessions)
    expect(r.pulses.map((p) => [p.callKey, p.back, p.station])).toEqual([['2', false, 'shell']])
    r = diffPulses(r.seen, [call('1', true), call('2', true, 'shell')], next, r.sessions)
    expect(r.pulses.map((p) => [p.callKey, p.back])).toEqual([['2', true]])
    r = diffPulses(r.seen, [call('1', true), call('2', true, 'shell')], next, r.sessions)
    expect(r.pulses).toEqual([])
  })

  it('a call that started and ended between two reads goes out and comes back', () => {
    const r = diffPulses(new Map([['1', true]]), [call('1', true), call('9', true)], ids(), new Set(['s']))
    expect(r.pulses.map((p) => [p.callKey, p.back])).toEqual([['9', false], ['9', true]])
  })

  it("a session's turns read late, after the scope began (a stale answer, a restart's new session), are a baseline of their own", () => {
    const next = ids()
    const first = diffPulses(null, [call('1', true)], next)
    const late = diffPulses(first.seen, [call('1', true), ...Array.from({ length: 30 }, (_, i) => call(`b${i}`, true, 'edit', 'other'))], next, first.sessions)
    expect(late.pulses).toEqual([])
    const after = diffPulses(late.seen, [...late.seen.keys()].map((k) => call(k, true, 'edit', k.startsWith('b') ? 'other' : 's')).concat(call('b99', false, 'edit', 'other')), next, late.sessions)
    expect(after.pulses.map((p) => p.callKey)).toEqual(['b99'])
  })

  it("a session read with no calls yet is known: its first call pulses (the map's model names the sessions read)", () => {
    const next = ids()
    const first = diffPulses(null, [], next, undefined, ['s'])
    const r = diffPulses(first.seen, [call('1', false)], next, first.sessions, ['s'])
    expect(r.pulses.map((p) => p.callKey)).toEqual(['1'])
    const m = buildMapModel([agent('A', { turns: turnsOf('s', [[]]) }), agent('B')], 0)
    expect(m.sessions).toEqual(['A-s'])
  })

  it("holds only the calls of the latest read, and at most MAX_PULSES pulses", () => {
    const r = diffPulses(new Map([['old', true]]), Array.from({ length: 100 }, (_, i) => call(String(i), false)), ids(), new Set(['s']))
    expect(r.seen.has('old')).toBe(false)
    expect(r.pulses).toHaveLength(MAX_PULSES)
  })
})

describe("the context number, as the pane footer shows it", () => {
  const limits = { model: 'qwen3.6:35b-a3b', connection: 'Local', applied: true, context: { value: 32768, from: null }, output: { value: 8192, from: null } }

  it('the reported window, else a local launch\'s declared one; unknown usage is not a zero', () => {
    expect(contextShown({ contextTokens: 50_000, contextWindow: 200_000 }, null)).toEqual({ tokens: 50_000, window: 200_000, pct: 25 })
    expect(contextShown({ contextTokens: 16_384, contextWindow: null }, { localLimits: limits, modelId: 'qwen3.6:35b-a3b' })).toEqual({ tokens: 16_384, window: 32768, pct: 50 })
    expect(contextShown({ contextTokens: 0, contextWindow: 200_000 }, null)).toEqual({ tokens: 0, window: 200_000, pct: 0 })
    expect(contextShown(null, null)).toEqual({ tokens: null, window: null, pct: null })
    expect(contextShown({ contextTokens: 10, contextWindow: null }, null).pct).toBeNull()
  })

  it('turns amber at 70 % and red at 90 %', () => {
    expect([null, 0, 69, 70, 89, 90, 100].map(contextLevel)).toEqual(['none', 'ok', 'ok', 'amber', 'amber', 'red', 'red'])
  })
})

describe('the context reads follow the live state under the same session (HI-2929)', () => {
  const limits = { model: 'qwen3', connection: 'local', applied: true, context: { value: 32768, from: null } }
  type Live = { sessionId: string; settingUp?: boolean; modelId?: string; localLimits?: typeof limits } | null
  const entry = (live: Live): { key: string; live: Live } => ({ key: 'a1', live })

  it('reads again when a setup ends', () => {
    const setting = mapContextEntries([entry({ sessionId: 's1', settingUp: true })], (e) => e.live)
    const set = mapContextEntries(setting.entries, (): Live => ({ sessionId: 's1' }))
    expect(set.key).not.toBe(setting.key)
    expect(set.entries[0].live).toEqual({ sessionId: 's1' })
  })

  it('reads again when local limits or the model arrive after the launch', () => {
    const at = mapContextKey({ sessionId: 's1' })
    expect(mapContextKey({ sessionId: 's1', localLimits: limits })).not.toBe(at)
    expect(mapContextKey({ sessionId: 's1', modelId: 'qwen3' })).not.toBe(at)
    // The window it then shows is the launch-declared one, as the footer has it.
    expect(contextShown({ contextTokens: 8192 }, { localLimits: limits }).pct).toBe(25)
  })

  it('keeps the same key, and the same entries, while nothing it depends on changes', () => {
    const e = entry({ sessionId: 's1', localLimits: limits })
    const one = mapContextEntries([e], (x) => x.live)
    const two = mapContextEntries([e], (): Live => ({ sessionId: 's1', localLimits: { ...limits } }))
    expect(two.key).toBe(one.key)
    expect(one.entries[0]).toBe(e)
    expect(mapContextKey(null)).toBe('')
  })

  it("the workspace view's entries, taken in before limits or a model came, read them from the hosts now (HR1's round 1)", () => {
    type HostLive = { sessionId: string; status: string; modelId?: string; localLimits?: typeof limits }
    const before: HostLive = { sessionId: 's1', status: 'ready' }
    // Its entries as shownHosts took them in (a status or session change); the hosts replaced since, same session and status.
    const stale = [{ key: 'C:\\WS\\Alpha\na1', path: 'C:\\WS\\Alpha', agentId: 'a1', live: before }]
    const hostsThen = [{ path: 'c:\\ws\\alpha', agents: [{ id: 'a1', live: before }] }]
    const hostsNow = [{ path: 'c:\\ws\\alpha', agents: [{ id: 'a1', live: { ...before, localLimits: limits } }] }]
    const modelNow = [{ path: 'c:\\ws\\alpha', agents: [{ id: 'a1', live: { ...before, modelId: 'qwen3' } }] }]
    const then = mapContextEntries(stale, (e) => liveIn(hostsThen, e.path, e.agentId))
    const now = mapContextEntries(stale, (e) => liveIn(hostsNow, e.path, e.agentId))
    expect(mapContextEntries(stale, (e) => e.live).key).toBe(then.key)
    expect(now.key).not.toBe(then.key)
    expect(now.entries[0].live?.localLimits).toEqual(limits)
    expect(mapContextEntries(stale, (e) => liveIn(modelNow, e.path, e.agentId)).key).not.toBe(then.key)
    // Gone from the hosts: no live state, nothing to read.
    expect(mapContextEntries(stale, (e) => liveIn<HostLive>([], e.path, e.agentId)).entries[0].live).toBeNull()
  })
})

describe("a station's hover: whole messages in every language (HI-2930)", () => {
  const catalogue = (code: string): Record<string, string> => JSON.parse(readFileSync(join(__dirname, '..', 'locales', code, 'activity.json'), 'utf8'))
  afterEach(() => setLanguage('en', {}))

  it('says none as a case of the message, and a call named "none" stays its name', () => {
    expect(stationTitle({ status: 'ok', count: 2, heat: 3 }, 'Read', '')).toBe('Read: 2 calls this turn, 3 calls in the last ten minutes of the turns read. Last: none')
    setLanguage('fr', catalogue('fr'))
    expect(stationTitle({ status: 'ok', count: 1, heat: 1 }, 'Lecture', '')).toMatch(/Dernier : aucun$/)
    expect(stationTitle({ status: 'ok', count: 1, heat: 1 }, 'Lecture', 'none')).toMatch(/Dernier : none$/)
  })

  it('a station not counted yet: its status in the message, with the language\'s own punctuation', () => {
    expect(stationTitle({ status: 'notReported', count: 0, heat: 0 }, 'Read', '')).toBe('Read: not reported')
    expect(stationTitle({ status: 'loading', count: 0, heat: 0 }, 'Read', '')).toBe('Read: loading…')
    setLanguage('fr', catalogue('fr'))
    expect(stationTitle({ status: 'notReported', count: 0, heat: 0 }, 'Lecture', '')).toBe('Lecture : non signalé')
    setLanguage('ja', catalogue('ja'))
    expect(stationTitle({ status: 'loading', count: 0, heat: 0 }, '読み取り', '')).toBe('読み取り：読み込み中…')
  })

  it('every locale has both messages, with the select keys kept', () => {
    for (const code of ['de', 'es', 'fr', 'ja', 'pl', 'pt-BR', 'zh-CN']) {
      const c = catalogue(code)
      expect(c['activity.map.stationTip'], code).toMatch(/\{hasLast, select, yes \{\{last\}\} other \{[^{}]+\}\}$/)
      expect(c['activity.map.stationTipPending'], code).toMatch(/\{status, select, notReported \{[^{}]+\} other \{[^{}]+\}\}$/)
    }
  })
})
