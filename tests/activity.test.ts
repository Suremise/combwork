// The Activity tab's model (#1254, shared/activity.ts): a transcript's turns and tool calls, masked and cut short; each
// process under the one tool call open when it started, else under its session; and the tree, card → agent → session →
// turn → tool call, with subagents and processes, filtered to an agent or a card, recent sessions only.
import { describe, expect, it } from 'vitest'
import { activityTurns, buildActivityTree, filetimeMs, placeProcesses, ACTIVITY_SESSIONS, type ActivityInput, type ActivityNode, type ActivityTurns } from '../src/shared/activity'
import type { AgentProcess } from '../src/shared/agentProcesses'
import type { SessionListItem, TranscriptItem } from '../src/shared/types'

const T0 = Date.parse('2026-10-26T01:00:00.000Z')
const iso = (s: number): string => new Date(T0 + s * 1000).toISOString()
/** A Windows FILETIME for T0 + s seconds. */
const ft = (s: number): string => String(BigInt(T0 + s * 1000) * 10000n + 116444736000000000n)
const tool = (id: number, s: number, name: string, opts: { result?: string | null; isError?: boolean; summary?: string } = {}): TranscriptItem => ({
  id,
  timestamp: iso(s),
  kind: 'tool',
  tool: { toolUseId: `t${id}`, name, summary: opts.summary ?? name, input: '{}', result: opts.result === undefined ? 'ok' : opts.result, isError: !!opts.isError, images: [] }
})
const user = (id: number, s: number, text: string): TranscriptItem => ({ id, timestamp: iso(s), kind: 'user', text, images: [] })
const reply = (id: number, s: number, text: string): TranscriptItem => ({ id, timestamp: iso(s), kind: 'assistant', text })
const proc = (pid: number, s: number, parent?: number): AgentProcess => ({ pid, name: 'node.exe', label: `node ${pid}`, created: ft(s), ...(parent ? { parent } : {}) })

describe('turns from a transcript', () => {
  it('groups tool calls and the last reply under each prompt, masks secrets and cuts long text; keeps the latest turns', () => {
    const items = [reply(0, 0, 'before any prompt'), user(1, 1, 'Fix it with key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'), tool(2, 2, 'Bash'), reply(3, 3, 'first'), reply(4, 4, 'Done: ' + 'x'.repeat(400)), user(5, 10, 'Next'), tool(6, 11, 'Read', { result: null })]
    const { total, turns } = activityTurns(items)
    expect(total).toBe(2)
    expect(turns[0].prompt).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(turns[0].tools.map((t) => [t.itemId, t.name, t.at, t.until, t.done])).toEqual([[2, 'Bash', iso(2), iso(3), true]])
    expect(turns[0].reply.startsWith('Done: ')).toBe(true)
    expect(turns[0].reply.length).toBeLessThanOrEqual(160)
    // The last call has nothing after it yet: it may still run.
    expect(turns[1].tools[0]).toMatchObject({ itemId: 6, until: null, done: false })
    expect(activityTurns(items, 1).turns.map((t) => t.itemId)).toEqual([5])
  })
})

describe('where a process goes', () => {
  const { turns } = activityTurns([user(1, 0, 'go'), tool(2, 10, 'Bash'), reply(3, 20, 'ok'), tool(4, 30, 'Bash', { result: null })])
  it('under the one tool call open when it started; else under the session', () => {
    const { byTool, rest } = placeProcesses([proc(100, 15), proc(101, 35), proc(102, 25), { pid: 103, name: 'x.exe', label: 'x' }], turns, T0 + 60_000)
    expect(byTool.get(2)?.map((p) => p.pid)).toEqual([100])
    expect(byTool.get(4)?.map((p) => p.pid)).toEqual([101])
    // Between calls, or with no start time: the session's.
    expect(rest.map((p) => p.pid)).toEqual([102, 103])
  })
  it('a FILETIME reads as Unix ms', () => {
    expect(filetimeMs(ft(5))).toBe(T0 + 5000)
    expect(filetimeMs('nope')).toBeNull()
  })
})

const session = (id: string, agentId: string, s: number, more: Partial<SessionListItem> = {}): SessionListItem => ({ id, provider: 'claude-code', source: 'hive', agentId, name: id, lastActivity: iso(s), lastActiveAt: iso(s), hasTranscript: true, hasBackup: false, usage: null, recache: null, title: null, ...more }) as SessionListItem
const keys = (nodes: ActivityNode[]): unknown[] => nodes.map((n) => (n.children.length ? [n.key, keys(n.children)] : n.key))

describe('the tree', () => {
  const base = (): ActivityInput => ({
    agents: [
      { id: 'hb1', name: 'HB1', live: { sessionId: 's1', status: 'working', text: 'Running tests', working: true, waiting: false, failed: false } },
      { id: 'hr1', name: 'HR1', live: null }
    ],
    cards: [{ number: 7, label: 'HI-7', title: 'Seven', column: 'doing', agents: ['hb1', 'hr1'] }],
    sessions: [session('s1', 'hb1', 0, { cards: [{ number: 7, title: 'Seven' }] }), session('r1', 'hr1', -60, { cards: [{ number: 7, title: 'Seven', review: true }] }), session('old', 'hr1', -25 * 3600), session('loose', 'hr1', -120), session('sub1', 'hb1', -5, { sub: { parentId: 's1', kind: 'sub-agent' } })],
    turns: new Map(),
    now: { launches: [{ agentId: 'hb1', runId: 'run1', cli: [10, 11], processes: [proc(10, -100), proc(11, -99, 10), proc(20, 15, 11)], more: 0 }], tasks: [{ agentId: 'hb1', sessionId: 's1', id: 'bg1', type: 'subagent', description: 'Explore', at: T0 }] },
    at: T0 + 60_000
  })

  it('files sessions under their card and agent, sub-sessions under their parent; loose ones under the agent; older than 24 h left out', () => {
    expect(keys(buildActivityTree(base()))).toEqual([
      ['c:7', [['c:7:a:hb1', [['s:s1', ['task:s1:bg1', 'p:10:' + ft(-100), 'p:11:' + ft(-99), 'p:20:' + ft(15), 's:sub1']]]], ['c:7:a:hr1', ['s:r1']]]],
      ['a:hr1', ['s:loose']]
    ])
  })

  it("puts a running session's turns, tool calls and the processes they started in place, the CLI's at the session", () => {
    const input = base()
    const t: ActivityTurns = { sessionId: 's1', version: 'v', ...activityTurns([user(1, 0, 'go'), tool(2, 10, 'Bash', { result: null })]) }
    input.turns = new Map([['s1', t]])
    const s1 = (buildActivityTree(input)[0].children[0].children[0]) as Extract<ActivityNode, { kind: 'session' }>
    expect(s1).toMatchObject({ live: true, state: 'working', turnsLoaded: true, turnCount: 1 })
    expect(keys(s1.children)).toEqual([['turn:s1:1', [['tool:s1:2', ['p:20:' + ft(15)]]]], 'task:s1:bg1', 'p:10:' + ft(-100), 'p:11:' + ft(-99), 's:sub1'])
    const turn = s1.children[0] as Extract<ActivityNode, { kind: 'turn' }>
    expect(turn.state).toBe('working')
    expect((turn.children[0] as Extract<ActivityNode, { kind: 'tool' }>).state).toBe('working')
    const cli = s1.children.filter((n) => n.kind === 'process' && n.cli).map((n) => n.key)
    expect(cli).toEqual(['p:10:' + ft(-100), 'p:11:' + ft(-99)])
  })

  it("draws a running agent's session the list doesn't have yet, with its processes, and puts what runs now first", () => {
    const input = base()
    // HB1 started a new session since the list was read: on no card yet, so its agent's node holds it.
    input.agents[0].live = { ...input.agents[0].live!, sessionId: 'new', sessionName: 'Fresh' }
    input.now = { ...input.now, tasks: [] }
    const tree = buildActivityTree(input)
    expect(tree[0].key).toBe('a:hb1')
    const fresh = tree[0].children[0] as Extract<ActivityNode, { kind: 'session' }>
    expect(fresh).toMatchObject({ key: 's:new', live: true })
    expect(fresh.session.name).toBe('Fresh')
    expect(fresh.children.filter((n) => n.kind === 'process').length).toBe(3)
    // The card it worked on before comes after, its old session no longer running.
    expect(tree.map((n) => n.key)).toEqual(['a:hb1', 'c:7', 'a:hr1'])
  })

  it("filtered to an agent shows only that agent's work; to a card, only that card's", () => {
    expect(keys(buildActivityTree({ ...base(), filter: { agentId: 'hr1' } }))).toEqual([['c:7', [['c:7:a:hr1', ['s:r1']]]], ['a:hr1', ['s:loose']]])
    expect(keys(buildActivityTree({ ...base(), filter: { card: 7 } })).map((k) => (k as unknown[])[0])).toEqual(['c:7'])
  })

  it(`shows an agent's ${ACTIVITY_SESSIONS} newest sessions and "n more" for the rest, all once opened; running ones always`, () => {
    const input = base()
    input.sessions = Array.from({ length: ACTIVITY_SESSIONS + 3 }, (_, i) => session(`x${i}`, 'hr1', -i * 60))
    const agent = buildActivityTree(input).find((n) => n.key === 'a:hr1')!
    expect(agent.children.length).toBe(ACTIVITY_SESSIONS + 1)
    expect(agent.children.at(-1)).toMatchObject({ kind: 'more', count: 3 })
    const all = buildActivityTree({ ...input, showAll: new Set(['a:hr1']) }).find((n) => n.key === 'a:hr1')!
    expect(all.children.length).toBe(ACTIVITY_SESSIONS + 3)
  })
})
