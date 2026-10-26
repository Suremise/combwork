// The Activity tab's model (#1254, HI-1743, shared/activity.ts): a transcript's turns and tool calls, masked and cut
// short; each process under the one tool call open when it started, else under its session; a tab per agent, filtered,
// Hide finished on by default; and each agent's tree of what runs now: its card in progress with the card's builder and
// reviewer, else its session, the latest turn, tool calls, background tasks, subagents and processes. Nothing past.
import { describe, expect, it } from 'vitest'
import { ACTIVITY_LEVELS, activityLevel, activityTabs, activityTurns, buildActivityTree, cardWorker, currentCard, goneKeys, keysAtLevel, filetimeMs, keepGone, newOrder, placeProcesses, pruneGone, stableRows, type ActivityInput, type ActivityNode, type ActivityOrder, type ActivityTurns } from '../src/shared/activity'
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

describe('the tabs (HI-1743)', () => {
  const card = (number: number, column: string, builder: string | null, reviewer: string | null = null) => ({ number, label: `HI-${number}`, title: `${number}`, column, builder, reviewer })
  const live = (sessionId: string, more: Partial<NonNullable<ActivityInput['agents'][number]['live']>> = {}) => ({ sessionId, status: 'working' as const, text: '', working: true, waiting: false, failed: false, ...more })
  const base = (): ActivityInput => ({
    agents: [
      { id: 'hb1', name: 'HB1', live: live('s1') },
      { id: 'hr1', name: 'HR1', live: live('r1', { working: false, status: 'ready' }) },
      { id: 'hb2', name: 'HB2', live: null },
      { id: 'solo', name: 'Agent 1', live: live('x1', { working: false, waiting: true, status: 'waiting' }) }
    ],
    cards: [card(7, 'doing', 'hb1', 'hr1'), card(3, 'done', 'hb1', 'hr1'), card(8, 'review', 'hb2', 'hr1')],
    sessions: [],
    turns: new Map(),
    now: { launches: [], tasks: [] },
    at: T0
  })

  it("a card in progress is an agent's current work: one it builds in Doing, else one it reviews, else one of its in Review; never a finished one", () => {
    const { cards } = base()
    expect(currentCard('hb1', cards)?.number).toBe(7)
    expect(currentCard('hr1', cards)?.number).toBe(8)
    expect(currentCard('hb2', cards)?.number).toBe(8)
    expect(currentCard('solo', cards)).toBeNull()
    expect(currentCard('hb1', [card(3, 'done', 'hb1')])).toBeNull()
  })

  it('one per agent in pane order, each with its state and card; Hide finished (on by default) leaves out agents with nothing running', () => {
    const tabs = activityTabs(base())
    expect(tabs.map((t) => [t.agentId, t.state, t.card?.label ?? null])).toEqual([
      ['hb1', 'working', 'HI-7'],
      ['solo', 'waiting', null]
    ])
    // Shown, the finished ones: HR1 idle with nothing running, HB2 not running.
    expect(activityTabs(base(), { hideFinished: false }).map((t) => [t.agentId, t.finished])).toEqual([
      ['hb1', false],
      ['hr1', true],
      ['hb2', true],
      ['solo', false]
    ])
    // Idle, but a process of its own runs (a dev server), or a background task: not finished.
    const input = base()
    input.now = { launches: [{ agentId: 'hr1', runId: 'r', cli: [10], processes: [proc(10, 0), proc(11, 1, 10)], more: 0 }], tasks: [] }
    expect(activityTabs(input).map((t) => t.agentId)).toEqual(['hb1', 'hr1', 'solo'])
    input.now = { launches: [{ agentId: 'hr1', runId: 'r', cli: [10], processes: [proc(10, 0)], more: 0 }], tasks: [{ agentId: 'hb2', sessionId: 'z', id: 't', at: T0 }] }
    // Its CLI alone isn't something running; HB2 isn't running at all, whatever is listed for it.
    expect(activityTabs(input).map((t) => t.agentId)).toEqual(['hb1', 'solo'])
  })

  it('filtered to agents, or to cards (an agent by its current card); the tab shown keeps its tab when finished', () => {
    expect(activityTabs(base(), { agents: ['solo'] }).map((t) => t.agentId)).toEqual(['solo'])
    expect(activityTabs(base(), { cards: [8], hideFinished: false }).map((t) => t.agentId)).toEqual(['hr1', 'hb2'])
    expect(activityTabs(base(), { cards: [7] }).map((t) => t.agentId)).toEqual(['hb1'])
    // Opened for HR1, idle: its tab shows, Hide finished or not; another filter still leaves it out.
    expect(activityTabs(base(), { agents: ['hr1'] }, 'hr1').map((t) => t.agentId)).toEqual(['hr1'])
    expect(activityTabs(base(), {}, 'hr1').map((t) => t.agentId)).toEqual(['hb1', 'hr1', 'solo'])
    expect(activityTabs(base(), { agents: ['solo'] }, 'hr1').map((t) => t.agentId)).toEqual(['solo'])
  })

  it("a card's Activity opens on its builder while it runs, else its reviewer, else either", () => {
    const runs = (ids: string[]) => (id: string) => ids.includes(id)
    expect(cardWorker({ builder: 'hb1', reviewer: 'hr1' }, runs(['hb1', 'hr1']))).toBe('hb1')
    expect(cardWorker({ builder: 'hb1', reviewer: 'hr1' }, runs(['hr1']))).toBe('hr1')
    expect(cardWorker({ builder: 'hb1', reviewer: 'hr1' }, runs([]))).toBe('hb1')
    expect(cardWorker({ builder: null, reviewer: 'hr1' }, runs([]))).toBe('hr1')
    expect(cardWorker({ builder: null, reviewer: null }, runs([]))).toBeNull()
  })
})


describe("an agent's tree: what runs now (HI-1743)", () => {
  const base = (): ActivityInput => ({
    agents: [
      { id: 'hb1', name: 'HB1', live: { sessionId: 's1', status: 'working', text: 'Running tests', working: true, waiting: false, failed: false } },
      { id: 'hr1', name: 'HR1', live: null },
      { id: 'solo', name: 'Agent 1', live: { sessionId: 'x1', status: 'ready', text: '', working: false, waiting: false, failed: false } }
    ],
    cards: [
      { number: 7, label: 'HI-7', title: 'Seven', column: 'doing', builder: 'hb1', reviewer: 'hr1' },
      { number: 3, label: 'HI-3', title: 'Three', column: 'done', builder: 'hb1', reviewer: 'hr1' }
    ],
    sessions: [session('s1', 'hb1', 0, { cards: [{ number: 7, title: 'Seven' }] }), session('old', 'hb1', -3600, { cards: [{ number: 3, title: 'Three' }] }), session('r1', 'hr1', -60), session('sub1', 'hb1', 15, { sub: { parentId: 's1', kind: 'sub-agent' } }), session('sub0', 'hb1', -30, { sub: { parentId: 's1', kind: 'sub-agent' } })],
    turns: new Map(),
    now: { launches: [{ agentId: 'hb1', runId: 'run1', cli: [10, 11], processes: [proc(10, -100), proc(11, -99, 10), proc(20, 15, 11)], more: 0 }], tasks: [{ agentId: 'hb1', sessionId: 's1', id: 'bg1', type: 'subagent', description: 'Explore', at: T0 }] },
    at: T0 + 60_000
  })
  const withTurns = (input: ActivityInput): ActivityInput => ({ ...input, turns: new Map([['s1', { sessionId: 's1', version: 'v', ...activityTurns([user(1, -50, 'first'), tool(2, -40, 'Read'), user(3, 0, 'go'), tool(4, 10, 'Bash', { result: null })]) } satisfies ActivityTurns]]) })

  it("a builder's tab: its card in progress, the builder's running session with what runs in it; the reviewer only while it runs; never a past card or session", () => {
    expect(keys(buildActivityTree(base(), 'hb1'))).toEqual([['c:7', [['a:hb1', [['s:s1', ['task:s1:bg1', 'p:10:' + ft(-100), 'p:11:' + ft(-99), 'p:20:' + ft(15), 's:sub1', 's:sub0']]]]]]])
    const input = base()
    input.agents[1].live = { sessionId: 'r1', status: 'ready', text: '', working: false, waiting: false, failed: false }
    expect(buildActivityTree(input, 'hb1')[0].children.map((n) => n.key)).toEqual(['a:hb1', 'a:hr1'])
    // In Review, the reviewer's own tab shows the card they share, the builder first, the reviewer itself even before it runs.
    const review = base()
    review.cards[0].column = 'review'
    expect(keys(buildActivityTree(review, 'hr1')).map((k) => (k as unknown[])[0])).toEqual(['c:7'])
    expect(buildActivityTree(review, 'hr1')[0].children.map((n) => n.key)).toEqual(['a:hb1', 'a:hr1'])
    // In Doing, the card isn't the reviewer's work yet: its tab has the agent alone.
    expect(keys(buildActivityTree(base(), 'hr1'))).toEqual(['a:hr1'])
  })

  it('only the latest turn, its tool call working and the processes it started under it; the CLI\'s and the rest at the session; subagents of that turn', () => {
    const s1 = buildActivityTree(withTurns(base()), 'hb1')[0].children[0].children[0] as Extract<ActivityNode, { kind: 'session' }>
    expect(s1).toMatchObject({ live: true, state: 'working', turnsLoaded: true, turnCount: 2 })
    // sub0 ran before this turn's prompt: past work, left out.
    expect(keys(s1.children)).toEqual([['turn:s1:3', [['tool:s1:4', ['p:20:' + ft(15)]]]], 'task:s1:bg1', 'p:10:' + ft(-100), 'p:11:' + ft(-99), 's:sub1'])
    const turn = s1.children[0] as Extract<ActivityNode, { kind: 'turn' }>
    expect(turn.state).toBe('working')
    expect((turn.children[0] as Extract<ActivityNode, { kind: 'tool' }>).state).toBe('working')
  })

  it('an agent with no card: its session alone (a solo agent, most users); one not running: the agent alone; one not in the project: nothing', () => {
    expect(keys(buildActivityTree(base(), 'solo'))).toEqual([['a:solo', ['s:x1']]])
    const input = base()
    input.cards = []
    expect(keys(buildActivityTree(input, 'hr1'))).toEqual(['a:hr1'])
    expect(buildActivityTree(base(), 'nobody')).toEqual([])
  })

  it("a running session the list doesn't have yet is drawn from its live state", () => {
    const input = base()
    input.agents[0].live = { ...input.agents[0].live!, sessionId: 'new', sessionName: 'Fresh' }
    input.now = { ...input.now, tasks: [] }
    const fresh = buildActivityTree(input, 'hb1')[0].children[0].children[0] as Extract<ActivityNode, { kind: 'session' }>
    expect(fresh).toMatchObject({ key: 's:new', live: true })
    expect(fresh.session.name).toBe('Fresh')
    expect(fresh.children.filter((n) => n.kind === 'process').length).toBe(3)
  })

  it('each node has a level for Levels ▾ (HI-1678): sub-sessions and background tasks are subagents; cards fold on their own', () => {
    const tree = buildActivityTree(withTurns(base()), 'hb1')
    const levels: Record<string, string | null> = {}
    const walk = (ns: ActivityNode[]): void => ns.forEach((n) => ((levels[n.key] = activityLevel(n)), walk(n.children)))
    walk(tree)
    expect(levels).toMatchObject({ 'c:7': null, 'a:hb1': 'agent', 's:s1': 'session', 's:sub1': 'subagent', 'task:s1:bg1': 'subagent', 'turn:s1:3': 'turn', 'tool:s1:4': 'tool', ['p:20:' + ft(15)]: 'process' })
    expect([...keysAtLevel(tree, 'subagent')].sort()).toEqual(['s:sub1', 'task:s1:bg1'])
    expect(ACTIVITY_LEVELS).toEqual(['agent', 'session', 'subagent', 'turn', 'tool', 'process'])
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

  it('what ended stays in its row, dimmed (gone), with what it held, until a refresh', () => {
    const before = [card(1, [agent('a1', [proc1(1), proc1(2)])])]
    const after = [card(1, [agent('a1', [proc1(2)])])]
    const kept = keepGone(before, after)
    expect(kept[0].children[0].children.map((n) => [n.key, !!n.gone])).toEqual([
      ['p:2', false],
      ['p:1', true]
    ])
    const order = newOrder()
    expect(rows(before, order)).toEqual(['c:1', 'a1', 'p:1', 'p:2'])
    expect(rows(kept, order)).toEqual(['c:1', 'a1', 'p:1', 'p:2'])
    // A refresh draws it afresh: what ended is gone.
    expect(keepGone([], after)[0].children[0].children.map((n) => n.key)).toEqual(['p:2'])
    // A whole branch that left keeps its children, all gone.
    const left = keepGone([card(9, [agent('a9', [proc1(9)])])], [])
    expect(left[0]).toMatchObject({ key: 'c:9', gone: true })
    expect(left[0].children[0].children[0]).toMatchObject({ key: 'p:9', gone: true })
  })

  it('a node that changes parent stays one node, where it was drawn, until a refresh (HR6 round 1: a process found to be a tool call\'s)', () => {
    const sessionNode = (kids: ActivityNode[]): ActivityNode => ({ kind: 'agent', key: 's:1', agentId: 's', name: 's', state: 'working', status: null, line: '', children: kids })
    const toolNode = (kids: ActivityNode[]): ActivityNode => ({ kind: 'agent', key: 'tool:1', agentId: 't', name: 't', state: 'working', status: null, line: '', children: kids })
    // Drawn under the session; the turns read since put it under its tool call.
    const before = [sessionNode([proc1(42)])]
    const after = [sessionNode([toolNode([proc1(42)])])]
    const kept = keepGone(before, after)
    const all: string[] = []
    const walk = (ns: ActivityNode[]): void => ns.forEach((n) => (all.push(`${n.key}${n.gone ? '(gone)' : ''}`), walk(n.children)))
    walk(kept)
    expect(all.filter((k) => k.startsWith('p:42'))).toEqual(['p:42'])
    expect(kept[0].children.map((n) => n.key)).toEqual(['tool:1', 'p:42'])
    const order = newOrder()
    rows(before, order)
    const r = stableRows(kept, open, order)
    expect(r.map((x) => x.node.key)).toEqual(['s:1', 'p:42', 'tool:1'])
    expect(new Set(r.map((x) => x.node.key)).size).toBe(r.length)
    expect(r[1].parent).toBe(0)
    // Refreshed, it goes under its tool call.
    expect(keepGone([], after)[0].children[0].children.map((n) => n.key)).toEqual(['p:42'])
  })

  it('a session filed under a card since stays under the agent it was drawn under, until a refresh', () => {
    const sess: ActivityNode = { kind: 'agent', key: 's:9', agentId: 's9', name: 's9', state: 'idle', status: null, line: '', children: [] }
    const before = [agent('a:x', [sess])]
    const after = [card(7, [agent('c:7:a:x', [sess])])]
    const kept = keepGone(before, after)
    const order = newOrder()
    rows(before, order)
    const r = stableRows(kept, open, order).map((x) => `${x.node.key}${x.node.gone ? '(gone)' : ''}`)
    expect(r).toEqual(['a:x(gone)', 's:9', 'c:7', 'c:7:a:x'])
  })

  it('a refresh draws the tree compact again: a fresh order puts children back under their parents', () => {
    const order = newOrder()
    const first = [card(1, [agent('a1', [proc1(1)])]), card(2, [agent('a2', [])])]
    rows(first, order)
    const later = [card(1, [agent('a1', [proc1(1), proc1(3)])]), card(2, [agent('a2', [])])]
    expect(rows(later, order)).toEqual(['c:1', 'a1', 'p:1', 'c:2', 'a2', 'p:3'])
    expect(rows(later, newOrder())).toEqual(['c:1', 'a1', 'p:1', 'p:3', 'c:2', 'a2'])
  })
})

describe('live, what ended fades out, then leaves (HI-1743)', () => {
  const agent = (key: string, kids: ActivityNode[]): ActivityNode => ({ kind: 'agent', key, agentId: key, name: key, state: 'working', status: null, line: '', children: kids })
  const proc1 = (pid: number): ActivityNode => ({ kind: 'process', key: `p:${pid}`, agentId: 'a', process: { pid, name: 'n', label: 'l' }, cli: false, children: [] })

  it('a process that ended stays, gone, while it fades; once let go it leaves, and what still runs stays', () => {
    const kept = keepGone([agent('a', [proc1(1), proc1(2)])], [agent('a', [proc1(2)])])
    expect(goneKeys(kept)).toEqual(['p:1'])
    expect(keys(pruneGone(kept, () => true))).toEqual([['a', ['p:2', 'p:1']]])
    expect(keys(pruneGone(kept, () => false))).toEqual([['a', ['p:2']]])
    // Never what still runs, whatever is let go.
    expect(keys(pruneGone([agent('a', [proc1(2)])], () => false))).toEqual([['a', ['p:2']]])
  })
})
