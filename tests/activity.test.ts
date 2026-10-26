// The Activity tab's model (#1254, shared/activity.ts): a transcript's turns and tool calls, masked and cut short; each
// process under the one tool call open when it started, else under its session; and the tree, card → agent → session →
// turn → tool call, with subagents and processes, filtered to an agent or a card, recent sessions only.
import { describe, expect, it } from 'vitest'
import { activityTurns, buildActivityTree, filetimeMs, keepGone, newOrder, placeProcesses, stableRows, ACTIVITY_SESSIONS, type ActivityFilter, type ActivityInput, type ActivityNode, type ActivityOrder, type ActivityTurns } from '../src/shared/activity'
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

describe('turns from a long transcript (#1254 round 2: one pass over the tail)', () => {
  it('counts every turn and builds only the latest, each tool call timed to the next item', () => {
    const items: TranscriptItem[] = []
    for (let i = 0; i < 20000; i++) items.push(i % 5 === 0 ? user(i, i, `Prompt ${i}`) : i % 5 === 4 ? reply(i, i, `Reply ${i}`) : tool(i, i, 'Bash'))
    const { total, turns } = activityTurns(items)
    expect(total).toBe(4000)
    expect(turns.map((t) => t.itemId)).toEqual(Array.from({ length: 50 }, (_, k) => 19750 + k * 5))
    expect(turns.at(-1)!.tools.map((t) => [t.itemId, t.until])).toEqual([
      [19996, iso(19997)],
      [19997, iso(19998)],
      [19998, iso(19999)]
    ])
    expect(turns.at(-1)!.reply).toBe('Reply 19999')
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
      ['c:7', [['c:7:a:hr1', ['s:r1']], ['c:7:a:hb1', [['s:s1', ['task:s1:bg1', 'p:10:' + ft(-100), 'p:11:' + ft(-99), 'p:20:' + ft(15), 's:sub1']]]]]],
      ['a:hr1', ['s:loose']]
    ])
  })

  it("puts a running session's turns, tool calls and the processes they started in place, the CLI's at the session", () => {
    const input = base()
    const t: ActivityTurns = { sessionId: 's1', version: 'v', ...activityTurns([user(1, 0, 'go'), tool(2, 10, 'Bash', { result: null })]) }
    input.turns = new Map([['s1', t]])
    const s1 = buildActivityTree(input)[0].children.find((n) => n.key === 'c:7:a:hb1')!.children[0] as Extract<ActivityNode, { kind: 'session' }>
    expect(s1).toMatchObject({ live: true, state: 'working', turnsLoaded: true, turnCount: 1 })
    expect(keys(s1.children)).toEqual([['turn:s1:1', [['tool:s1:2', ['p:20:' + ft(15)]]]], 'task:s1:bg1', 'p:10:' + ft(-100), 'p:11:' + ft(-99), 's:sub1'])
    const turn = s1.children[0] as Extract<ActivityNode, { kind: 'turn' }>
    expect(turn.state).toBe('working')
    expect((turn.children[0] as Extract<ActivityNode, { kind: 'tool' }>).state).toBe('working')
    const cli = s1.children.filter((n) => n.kind === 'process' && n.cli).map((n) => n.key)
    expect(cli).toEqual(['p:10:' + ft(-100), 'p:11:' + ft(-99)])
  })

  it("draws a running agent's session the list doesn't have yet, with its processes, in the tree's own order (no re-sorting by what runs, HI-1677)", () => {
    const input = base()
    // HB1 started a new session since the list was read: on no card yet, so its agent's node holds it.
    input.agents[0].live = { ...input.agents[0].live!, sessionId: 'new', sessionName: 'Fresh' }
    input.now = { ...input.now, tasks: [] }
    const tree = buildActivityTree(input)
    const hb1 = tree.find((n) => n.key === 'a:hb1')!
    const fresh = hb1.children[0] as Extract<ActivityNode, { kind: 'session' }>
    expect(fresh).toMatchObject({ key: 's:new', live: true })
    expect(fresh.session.name).toBe('Fresh')
    expect(fresh.children.filter((n) => n.kind === 'process').length).toBe(3)
    // Cards first, then agents' loose work, the newest last: running work isn't moved to the top.
    expect(tree.map((n) => n.key)).toEqual(['c:7', 'a:hr1', 'a:hb1'])
  })

  it("filtered to agents shows only their work; to cards, only theirs; both combine (HI-1677)", () => {
    expect(keys(buildActivityTree({ ...base(), filter: { agents: ['hr1'] } }))).toEqual([['c:7', [['c:7:a:hr1', ['s:r1']]]], ['a:hr1', ['s:loose']]])
    expect(keys(buildActivityTree({ ...base(), filter: { cards: [7] } })).map((k) => (k as unknown[])[0])).toEqual(['c:7'])
    expect(keys(buildActivityTree({ ...base(), filter: { cards: [7], agents: ['hb1'] } })).map((k) => (k as unknown[])[0])).toEqual(['c:7'])
    expect(buildActivityTree({ ...base(), filter: { cards: [7], agents: ['hb1'] } })[0].children.map((n) => n.key)).toEqual(['c:7:a:hb1'])
    expect(buildActivityTree({ ...base(), filter: { agents: ['hb1', 'hr1'] } }).length).toBe(2)
  })

  it(`shows an agent's ${ACTIVITY_SESSIONS} newest sessions, oldest first, with "n more" for the older ones before them; all once opened`, () => {
    const input = base()
    input.sessions = Array.from({ length: ACTIVITY_SESSIONS + 3 }, (_, i) => session(`x${i}`, 'hr1', -i * 60))
    const agent = buildActivityTree(input).find((n) => n.key === 'a:hr1')!
    expect(agent.children.length).toBe(ACTIVITY_SESSIONS + 1)
    expect(agent.children[0]).toMatchObject({ kind: 'more', count: 3 })
    // The newest last.
    expect(agent.children.at(-1)!.key).toBe('s:x0')
    expect(agent.children[1].key).toBe(`s:x${ACTIVITY_SESSIONS - 1}`)
    const all = buildActivityTree({ ...input, showAll: new Set(['a:hr1']) }).find((n) => n.key === 'a:hr1')!
    expect(all.children.length).toBe(ACTIVITY_SESSIONS + 3)
  })

  it('a range keeps what was active within it before the last refresh (Live: running work only); Hide finished keeps only running work (HI-1677)', () => {
    const input = base()
    const min = 60
    input.sessions = [session('s1', 'hb1', 0, { cards: [{ number: 7, title: 'Seven' }] }), session('m10', 'hr1', -10 * min), session('m50', 'hr1', -50 * min), session('h3', 'hr1', -3 * 3600), session('h20', 'hr1', -20 * 3600)]
    const ids = (range?: ActivityFilter['range'], hideFinished?: boolean): string[] => {
      const out: string[] = []
      const walk = (ns: ActivityNode[]): void => ns.forEach((n) => (n.kind === 'session' ? out.push(n.session.id) : walk(n.children)))
      walk(buildActivityTree({ ...input, filter: { range, hideFinished } }))
      return out.sort()
    }
    expect(ids('live')).toEqual(['s1'])
    expect(ids('15m')).toEqual(['m10', 's1'])
    expect(ids('1h')).toEqual(['m10', 'm50', 's1'])
    expect(ids('6h')).toEqual(['h3', 'm10', 'm50', 's1'])
    expect(ids('24h')).toEqual(['h20', 'h3', 'm10', 'm50', 's1'])
    expect(ids(undefined)).toEqual(['h20', 'h3', 'm10', 'm50', 's1'])
    expect(ids('24h', true)).toEqual(['s1'])
    // Measured from the tree's time (the last refresh), not the clock: a session doesn't age out while it is looked at.
    expect(buildActivityTree({ ...input, at: input.at + 10 * min * 1000, filter: { range: '15m' } }).some((n) => JSON.stringify(n.key) && n.children.some((c) => c.children.some((s) => s.key === 's:m10')))).toBe(false)
  })
})

describe('a layout that stays put (HI-1677)', () => {
  const card = (n: number, kids: ActivityNode[]): ActivityNode => ({ kind: 'card', key: `c:${n}`, number: n, label: `HI-${n}`, title: `${n}`, column: 'doing', children: kids })
  const agent = (key: string, kids: ActivityNode[]): ActivityNode => ({ kind: 'agent', key, agentId: key, name: key, state: 'idle', status: null, line: '', children: kids })
  const proc1 = (pid: number): ActivityNode => ({ kind: 'process', key: `p:${pid}`, agentId: 'a', process: { pid, name: 'n', label: 'l' }, cli: false, children: [] })
  const open = (): boolean => true
  const rows = (tree: ActivityNode[], order: ActivityOrder): string[] => stableRows(tree, open, order).map((r) => r.node.key)

  it('new work comes after everything already drawn, whatever its parent; nothing drawn moves', () => {
    const order = newOrder()
    const first = [card(1, [agent('a1', [proc1(1)])]), card(2, [agent('a2', [proc1(2)])])]
    expect(rows(first, order)).toEqual(['c:1', 'a1', 'p:1', 'c:2', 'a2', 'p:2'])
    // A process starts under card 1's agent, which is above card 2: it comes last, joined to its parent above.
    const second = [card(1, [agent('a1', [proc1(1), proc1(3)])]), card(2, [agent('a2', [proc1(2)])])]
    const r = stableRows(second, open, order)
    expect(r.map((x) => x.node.key)).toEqual(['c:1', 'a1', 'p:1', 'c:2', 'a2', 'p:2', 'p:3'])
    expect(r[6].parent).toBe(1)
    expect(r[6].depth).toBe(2)
    // A new card with its agent: after it all, the agent after its card.
    const third = [card(3, [agent('a3', [])]), ...second]
    expect(rows(third, order)).toEqual(['c:1', 'a1', 'p:1', 'c:2', 'a2', 'p:2', 'p:3', 'c:3', 'a3'])
  })

  it('a closed node hides its children; opened again they are where they were', () => {
    const order = newOrder()
    const tree = [card(1, [agent('a1', [proc1(1)])]), card(2, [])]
    expect(rows(tree, order)).toEqual(['c:1', 'a1', 'p:1', 'c:2'])
    expect(stableRows(tree, (n) => n.key !== 'c:1', order).map((x) => x.node.key)).toEqual(['c:1', 'c:2'])
    expect(rows(tree, order)).toEqual(['c:1', 'a1', 'p:1', 'c:2'])
  })

  it('what ended stays in its row, dimmed (gone), until a refresh; "n more" is never kept', () => {
    const before = [card(1, [agent('a1', [proc1(1), proc1(2)]), { kind: 'more', key: 'more:x', count: 2, children: [] }])]
    const after = [card(1, [agent('a1', [proc1(2)])])]
    const kept = keepGone(before, after)
    const a1 = kept[0].children[0]
    expect(a1.children.map((n) => [n.key, !!n.gone])).toEqual([
      ['p:2', false],
      ['p:1', true]
    ])
    expect(kept[0].children.some((n) => n.kind === 'more')).toBe(false)
    const order = newOrder()
    expect(rows(before, order)).toEqual(['c:1', 'a1', 'p:1', 'p:2', 'more:x'])
    expect(rows(kept, order)).toEqual(['c:1', 'a1', 'p:1', 'p:2'])
    // A refresh draws it afresh: what ended is gone.
    expect(keepGone([], after)[0].children[0].children.map((n) => n.key)).toEqual(['p:2'])
    // A whole branch that left keeps its children, all gone.
    const left = keepGone([card(9, [agent('a9', [proc1(9)])])], [])
    expect(left[0]).toMatchObject({ key: 'c:9', gone: true })
    expect(left[0].children[0].children[0]).toMatchObject({ key: 'p:9', gone: true })
  })
})
