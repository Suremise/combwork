// The Activity tab's model (#1254, HI-1743, shared/activity.ts): a transcript's turns and tool calls, masked and cut
// short, with what came last; a tab per agent, filtered, Hide finished on by default; and each tab's content, what runs
// now: its card in progress with the work of the card's builder and reviewer on it, else the agent's; the turn now and
// what it does (the tool call under way, thinking or writing), its subagents (read again while they can run) and
// background tasks, its processes without its own plumbing; what ended kept in place to fade; a command as given.
import { describe, expect, it } from 'vitest'
import { activityTabs, activityTurns, buildActivityView, cardWorker, commandText, currentCard, keepGoneList, type ActivityInput, type ActivityNode, type ActivityTurns } from '../src/shared/activity'
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
    // What came last in each (HI-1743): a reply in the first (writing), a tool call in the second.
    expect(turns.map((t) => t.lastKind)).toEqual(['reply', 'tool'])
    expect(activityTurns([user(1, 0, 'go')]).turns[0].lastKind).toBeNull()
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
    input.now = { launches: [{ agentId: 'hr1', runId: 'r', cli: [10], processes: [proc(10, 0), { ...proc(12, 1, 10), command: 'electron.exe C:\\hive\\out\\main\\hive-mcp.js' }], more: 0 }], tasks: [{ agentId: 'hb2', sessionId: 'z', id: 't', at: T0 }] }
    // Its CLI (and Combwork's tool server for it) isn't something running; HB2 isn't running at all, whatever is listed for it.
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

  it("a card's Activity opens on its builder while it runs on it, else its reviewer, else either", () => {
    const runs = (ids: string[]) => (id: string) => ids.includes(id)
    const seven = card(7, 'review', 'hb1', 'hr1')
    expect(cardWorker(seven, [seven], runs(['hb1', 'hr1']))).toBe('hb1')
    expect(cardWorker(seven, [seven], runs(['hr1']))).toBe('hr1')
    expect(cardWorker(seven, [seven], runs([]))).toBe('hb1')
    expect(cardWorker(card(9, 'doing', null, 'hr1'), [], runs([]))).toBe('hr1')
    expect(cardWorker(card(9, 'doing', null, null), [], runs([]))).toBeNull()
    // HR6's round 1: its builder gone on to its next card while it is reviewed: the reviewer is the one on it.
    const next = card(8, 'doing', 'hb1')
    expect(cardWorker(seven, [seven, next], runs(['hb1', 'hr1']))).toBe('hr1')
  })
})


const session = (id: string, agentId: string, s: number, more: Partial<SessionListItem> = {}): SessionListItem => ({ id, provider: 'claude-code', source: 'hive', agentId, name: id, lastActivity: iso(s), lastActiveAt: iso(s), hasTranscript: true, hasBackup: false, usage: null, recache: null, title: null, ...more }) as SessionListItem
const keys = (nodes: readonly (ActivityNode | null)[]): (string | null)[] => nodes.map((n) => n?.key ?? null)
const withCommand = (p: AgentProcess, command: string): AgentProcess & { command: string } => ({ ...p, command })

describe("a tab's content: what runs now (HI-1743)", () => {
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
    sessions: [session('s1', 'hb1', 0, { cards: [{ number: 7, title: 'Seven' }] }), session('old', 'hb1', -3600, { cards: [{ number: 3, title: 'Three' }] }), session('sub1', 'hb1', 15, { sub: { parentId: 's1', kind: 'sub-agent' } }), session('sub0', 'hb1', -30, { sub: { parentId: 's1', kind: 'sub-agent' } })],
    turns: new Map(),
    now: { launches: [{ agentId: 'hb1', runId: 'run1', cli: [10, 11], processes: [proc(10, -100), proc(11, -99, 10), withCommand(proc(12, -98, 10), 'electron.exe C:\\hive\\out\\main\\hive-mcp.js'), withCommand(proc(20, 15, 11), 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npm test"')], more: 0 }], tasks: [{ agentId: 'hb1', sessionId: 's1', id: 'bg1', type: 'subagent', description: 'Explore', at: T0 }] },
    at: T0 + 60_000
  })
  const turnsOf = (sid: string, items: TranscriptItem[]): [string, ActivityTurns] => [sid, { sessionId: sid, version: String(items.length), ...activityTurns(items) }]
  const withTurns = (input: ActivityInput, items = [user(1, -50, 'first'), tool(2, -40, 'Read'), user(3, 0, 'go'), tool(4, 10, 'Bash', { result: null })]): ActivityInput => ({ ...input, turns: new Map([turnsOf('s1', items)]) })

  it("a builder's tab: its card as the header, its work: the turn now and the tool call under way, its subagents and tasks, its processes; never a past card or session", () => {
    const v = buildActivityView(withTurns(base()), 'hb1')
    expect(v.card?.number).toBe(7)
    expect(v.parts.map((p) => [p.agentId, p.role])).toEqual([['hb1', 'builder']])
    const [hb1] = v.parts
    expect(hb1.turn?.key).toBe('turn:s1:3')
    expect(hb1.doing).toMatchObject({ kind: 'tool', tool: { key: 'tool:s1:4', state: 'working' } })
    // sub0 ran before this turn's prompt: past work, left out.
    expect(keys(hb1.subagents)).toEqual(['s:sub1', 'task:s1:bg1'])
    expect(JSON.stringify(v)).not.toContain('old')
  })

  it("its own plumbing (its CLI, its terminal, hive-mcp.js) is left out unless asked for; what it started stays", () => {
    const [hb1] = buildActivityView(base(), 'hb1').parts
    expect(keys(hb1.processes)).toEqual(['p:20:' + ft(15)])
    expect(hb1.ownHidden).toBe(3)
    const shown = buildActivityView(base(), 'hb1', { showOwn: true }).parts[0]
    expect(shown.processes.map((n) => (n.kind === 'process' ? [n.process.pid, n.own] : null))).toEqual([
      [10, true],
      [11, true],
      [12, true],
      [20, false]
    ])
    expect(shown.ownHidden).toBe(0)
  })

  it('what it does with no tool call under way: thinking, writing after a reply; nothing while it is not working', () => {
    const doing = (items: TranscriptItem[], working = true): unknown => {
      const input = withTurns(base(), items)
      input.agents[0].live = { ...input.agents[0].live!, working }
      return buildActivityView(input, 'hb1').parts[0].doing
    }
    expect(doing([user(1, 0, 'go')])).toEqual({ kind: 'thinking' })
    expect(doing([user(1, 0, 'go'), tool(2, 1, 'Read'), reply(3, 2, 'So far')])).toEqual({ kind: 'writing' })
    expect(doing([user(1, 0, 'go'), tool(2, 1, 'Read')])).toEqual({ kind: 'thinking' })
    expect(doing([user(1, 0, 'go'), tool(2, 1, 'Bash', { result: null })], false)).toBeNull()
  })

  it("HR6's round 1: a counterpart's work shows only while it is on this card (a builder gone on to its next card isn't)", () => {
    const input = base()
    input.cards[0].column = 'review'
    input.cards.push({ number: 8, label: 'HI-8', title: 'Eight', column: 'doing', builder: 'hb1', reviewer: null })
    input.agents[1].live = { sessionId: 'r1', status: 'working', text: '', working: true, waiting: false, failed: false }
    // HR1 reviews HI-7 while HB1 builds HI-8: HR1's tab is HI-7 with HR1's work alone; HB1's is HI-8.
    expect(buildActivityView(input, 'hr1')).toMatchObject({ card: { number: 7 }, parts: [{ agentId: 'hr1', role: 'reviewer' }] })
    expect(buildActivityView(input, 'hr1').parts.length).toBe(1)
    expect(buildActivityView(input, 'hb1')).toMatchObject({ card: { number: 8 }, parts: [{ agentId: 'hb1' }] })
    // Both on HI-7 (HB1 waiting for its review): HR1's tab shows both, its own first.
    input.cards.pop()
    expect(buildActivityView(input, 'hr1').parts.map((p) => [p.agentId, p.role])).toEqual([
      ['hr1', 'reviewer'],
      ['hb1', 'builder']
    ])
  })

  it("HR6's round 1: a subagent is live (read again) while the agent works or a background subagent of its runs; its open tool call shows, never made done", () => {
    const input = withTurns(base())
    input.turns = new Map([...input.turns, turnsOf('sub1', [user(1, 15, 'look'), tool(2, 16, 'Grep', { result: null })])])
    const sub = (i: ActivityInput) => buildActivityView(i, 'hb1').parts[0].subagents.find((n) => n.key === 's:sub1') as Extract<ActivityNode, { kind: 'session' }>
    expect(sub(input)).toMatchObject({ live: true, state: 'working', turnsLoaded: true })
    expect(sub(input).last?.tools.at(-1)).toMatchObject({ name: 'Grep', done: false })
    // Its transcript read again with another tool call: the newest shows.
    input.turns = new Map([...input.turns, turnsOf('sub1', [user(1, 15, 'look'), tool(2, 16, 'Grep'), tool(3, 17, 'Read', { result: null })])])
    expect(sub(input).last?.tools.map((t) => [t.name, t.done])).toEqual([
      ['Grep', true],
      ['Read', false]
    ])
    // The agent idle, a background subagent still running: still live.
    input.agents[0].live = { ...input.agents[0].live!, working: false }
    expect(sub(input).live).toBe(true)
    // Nothing of its runs any more: done, no longer read.
    input.now = { ...input.now, tasks: [] }
    expect(sub(input)).toMatchObject({ live: false, state: 'done' })
  })

  it("HR6's round 2: each subagent's state is its own: one that replied is done while its parent and another child go on", () => {
    const input = withTurns(base())
    input.sessions = [...input.sessions, session('sub2', 'hb1', 20, { sub: { parentId: 's1', kind: 'sub-agent' } })]
    input.turns = new Map([...input.turns, turnsOf('sub1', [user(1, 15, 'look'), tool(2, 16, 'Grep'), reply(3, 17, 'Found it in race.ts')]), turnsOf('sub2', [user(1, 20, 'test'), tool(2, 21, 'Bash', { result: null })])])
    const subs = (): Extract<ActivityNode, { kind: 'session' }>[] => buildActivityView(input, 'hb1').parts[0].subagents.filter((n): n is Extract<ActivityNode, { kind: 'session' }> => n.kind === 'session')
    // The parent works and a background subagent runs: both are read again, but sub1, which replied, is done.
    expect(subs().map((n) => [n.key, n.live, n.state])).toEqual([
      ['s:sub1', true, 'done'],
      ['s:sub2', true, 'working']
    ])
    // Between sub2's tool calls (its result in, nothing since): still working, thinking.
    input.turns = new Map([...input.turns, turnsOf('sub2', [user(1, 20, 'test'), tool(2, 21, 'Bash')])])
    expect(subs().find((n) => n.key === 's:sub2')?.state).toBe('working')
    // Not read yet: nothing claimed.
    input.turns = new Map([...input.turns].filter(([id]) => id !== 'sub2'))
    expect(subs().find((n) => n.key === 's:sub2')?.state).toBe('idle')
  })

  it('an agent with no card: its work alone, no header card (a solo agent, most users); one not running: nothing under it; one not in the project: nothing', () => {
    expect(buildActivityView(base(), 'solo')).toMatchObject({ card: null, parts: [{ agentId: 'solo', role: null, doing: null }] })
    const input = base()
    input.cards = []
    expect(buildActivityView(input, 'hr1').parts[0]).toMatchObject({ agentId: 'hr1', session: null, turn: null, processes: [] })
    expect(buildActivityView(base(), 'nobody')).toEqual({ card: null, parts: [] })
  })

  it("a running session the list doesn't have yet is drawn from its live state", () => {
    const input = base()
    input.agents[0].live = { ...input.agents[0].live!, sessionId: 'new', sessionName: 'Fresh' }
    const [hb1] = buildActivityView(input, 'hb1').parts
    expect(hb1.session).toMatchObject({ key: 's:new', live: true, session: { name: 'Fresh' } })
  })
})

describe('live, what ended fades out where it was, then leaves (HI-1743)', () => {
  const p = (pid: number): ActivityNode => ({ kind: 'process', key: `p:${pid}`, agentId: 'a', process: { pid, name: 'n', label: 'l' }, own: false })
  it('each item shown before stays in its place (gone when it ended); new ones come at the end', () => {
    expect(keepGoneList([p(1), p(2), p(3)], [p(3), p(1), p(4)]).map((n) => `${n.key}${n.gone ? ' gone' : ''}`)).toEqual(['p:1', 'p:2 gone', 'p:3', 'p:4'])
    // Drawn afresh (a new snapshot): nothing kept.
    expect(keepGoneList([], [p(2)]).map((n) => n.key)).toEqual(['p:2'])
  })
})

describe('a command as given (HI-1743)', () => {
  it('a cmd /c wrapper shows what it runs, as given; anything else by its label', () => {
    expect(commandText({ command: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "node -e setTimeout(()=>{},15000)"', label: 'cmd d s c' })).toBe('node -e setTimeout(()=>{},15000)')
    expect(commandText({ command: 'cmd /c npm run serve', label: 'x' })).toBe('npm run serve')
    expect(commandText({ command: '"C:\\Program Files\\nodejs\\node.exe" serve.js --port 5173', label: 'node serve.js --port 5173' })).toBe('node serve.js --port 5173')
    expect(commandText({ label: 'node serve.js' })).toBe('node serve.js')
  })
})
