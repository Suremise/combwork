// The Activity tab (#1254, HI-1743): what runs now in a project, a tab per running agent, each its current work (its
// card in progress with the card's builder and reviewer, else its session) → the latest turn → tool call, with the
// background tasks, subagents and processes running. Nothing past: "the card is the history". From what Hive already has:
// the board, the session records, the agents' live state, a session's transcript parse and Stop's tracking's processes.
import type { AgentProcess } from './agentProcesses'
import type { BackgroundTaskType, SessionListItem, SessionStatus, TranscriptItem } from './types'
import { maskText } from './redact'

/** How far back the session list is read: a running session and its subagents' are within it. */
export const ACTIVITY_HOURS = 24
/** A session's turns read for the tree: its latest ones (the tree shows the last). */
export const ACTIVITY_TURNS = 50
/** A prompt or reply shown in a node, cut to this many characters (the details show more). */
const LINE = 160
/** A prompt, input or reply shown in the details, cut to this many characters. */
export const DETAIL = 4000

/** A tool call of a turn, from the transcript. */
export interface ActivityTool {
  /** Its item in the transcript (transcript:tool gives it whole). */
  itemId: number
  name: string
  summary: string
  /** When it was called, and when the next thing in the transcript came (null: nothing yet, it may still run). */
  at: string | null
  until: string | null
  failed: boolean
  /** Its result is in the transcript. */
  done: boolean
}

/** A turn: a prompt and what followed it, up to the next prompt. */
export interface ActivityTurn {
  /** The prompt's item. */
  itemId: number
  at: string | null
  /** The prompt, masked like the log and cut short. */
  prompt: string
  tools: ActivityTool[]
  /** Its last reply, masked and cut short. */
  reply: string
}

/** A session's turns, as the tree shows them; `version` is the transcript's (null back: unchanged). */
export interface ActivityTurns {
  sessionId: string
  version: string
  /** How many turns the session has; `turns` holds the latest ACTIVITY_TURNS. */
  total: number
  turns: ActivityTurn[]
}

/** A background task running in an agent's launch (a subagent, a command, a monitor), as its CLI described it. */
export interface ActivityTask {
  agentId: string
  sessionId: string
  id: string
  type?: BackgroundTaskType
  description?: string
  at: number
}

/** A process as the tab lists it: Stop's tracking's, with its whole command line, masked like the log. */
export type ActivityProcess = AgentProcess & { command?: string }

/** A running launch's processes (Stop's tracking): its agent, the agent's CLI among them, and the rest. */
export interface ActivityLaunch {
  agentId: string
  runId: string
  /** The agent's CLI and its terminal: never ended from the tab (Stop does). */
  cli: number[]
  processes: ActivityProcess[]
  more: number
}

/** An item's whole input as written (line breaks kept, nothing cut), masked like the log: a prompt, or a tool call's input and result. */
export interface ActivityDetail {
  input: string
  result: string | null
}

/** What runs now in a project's agents' launches: polled while the tab is shown. */
export interface ActivityNow {
  launches: ActivityLaunch[]
  tasks: ActivityTask[]
}

/** What ending a process from the tab did: `notOwn`, the agent's launch no longer has it (ended, or never its). */
export type EndProcessResult = 'ended' | 'notOwn' | 'cli' | 'failed'

const cut = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/**
 * A transcript's turns (its latest `max`): each prompt and the tool calls and reply that followed it. Text is masked
 * like the log (secrets and sign-in codes) and cut short; the details read a tool call whole.
 */
export function activityTurns(items: readonly TranscriptItem[], max = ACTIVITY_TURNS): { total: number; turns: ActivityTurn[] } {
  // Linear, and only the tail is built (#1254 round 2): it runs on main whenever a running session's transcript grows.
  let total = 0
  let from = items.length
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind !== 'user') continue
    total++
    if (total <= max) from = i
  }
  const turns: ActivityTurn[] = []
  let turn: ActivityTurn | null = null
  // When the next item with a time came after each one: read from the end, so each tool call's `until` costs nothing.
  const nextAt: (string | null)[] = Array.from({ length: items.length - from }, () => null)
  let seen: string | null = null
  for (let i = items.length - 1; i >= from; i--) {
    nextAt[i - from] = seen
    if (items[i].timestamp) seen = items[i].timestamp
  }
  for (let i = from; i < items.length; i++) {
    const item = items[i]
    if (item.kind === 'user') {
      turn = { itemId: item.id, at: item.timestamp, prompt: cut(maskText(item.text), LINE), tools: [], reply: '' }
      turns.push(turn)
      continue
    }
    if (!turn) continue
    if (item.kind === 'tool') turn.tools.push({ itemId: item.id, name: item.tool.name, summary: cut(maskText(item.tool.summary), LINE), at: item.timestamp, until: nextAt[i - from], failed: item.tool.isError, done: item.tool.result !== null })
    else if (item.kind === 'assistant' && item.text.trim()) turn.reply = cut(maskText(item.text), LINE)
  }
  return { total, turns }
}

/** A Windows FILETIME (100 ns since 1601, as text) as Unix ms; null when it isn't one. */
export function filetimeMs(created: string | undefined): number | null {
  if (!created || !/^\d+$/.test(created)) return null
  return Number((BigInt(created) - 116444736000000000n) / 10000n)
}

/**
 * Where each process goes (#1254): under the one tool call of the session that was open when it started (from its call
 * to the next thing in the transcript, or still open), else under the session. Returns tool item id → processes, and
 * those left for the session.
 */
export function placeProcesses(processes: readonly AgentProcess[], turns: readonly ActivityTurn[], now: number): { byTool: Map<number, AgentProcess[]>; rest: AgentProcess[] } {
  const tools = turns.flatMap((t) => t.tools).filter((t) => t.at)
  const byTool = new Map<number, AgentProcess[]>()
  const rest: AgentProcess[] = []
  for (const p of processes) {
    const started = filetimeMs(p.created)
    const open = started === null ? [] : tools.filter((t) => Date.parse(t.at!) <= started + 50 && started <= (t.until ? Date.parse(t.until) : now) + 50)
    if (open.length === 1) byTool.set(open[0].itemId, [...(byTool.get(open[0].itemId) ?? []), p])
    else rest.push(p)
  }
  return { byTool, rest }
}

/** A node's state, as the tree colours it. */
export type ActivityState = 'working' | 'waiting' | 'failed' | 'done' | 'idle'

/**
 * A node of the tree. `gone`: drawn before and missing from the newest tree (a process that ended): live, it fades out
 * where it is and then leaves (HI-1743).
 */
export type ActivityNode = (
  | { kind: 'card'; key: string; number: number; label: string; title: string; column: string; children: ActivityNode[] }
  | { kind: 'agent'; key: string; agentId: string; name: string; state: ActivityState; status: SessionStatus | null; line: string; children: ActivityNode[] }
  | { kind: 'session'; key: string; agentId: string | null; session: SessionListItem; live: boolean; state: ActivityState; turnsLoaded: boolean; turnCount: number; children: ActivityNode[] }
  | { kind: 'turn'; key: string; sessionId: string; turn: ActivityTurn; state: ActivityState; children: ActivityNode[] }
  | { kind: 'tool'; key: string; sessionId: string; tool: ActivityTool; state: ActivityState; children: ActivityNode[] }
  | { kind: 'task'; key: string; task: ActivityTask; children: ActivityNode[] }
  | { kind: 'process'; key: string; agentId: string; process: ActivityProcess; cli: boolean; children: ActivityNode[] }
) & { gone?: boolean }

/** Which tabs show (HI-1743): agents and cards (none: all), and Hide finished (on unless turned off). */
export interface ActivityFilter {
  agents?: string[]
  cards?: number[]
  hideFinished?: boolean
}

/** An agent as the tab needs it: its id, name and live state (none: not running). */
export interface ActivityAgent {
  id: string
  name: string
  live: { sessionId: string; sessionName?: string; startedAt?: string; status: SessionStatus; text: string; working: boolean; waiting: boolean; failed: boolean } | null
}

/** A card as the tab needs it: its builder's and reviewer's agent ids, in this project. */
export interface ActivityCard {
  number: number
  label: string
  title: string
  column: string
  builder: string | null
  reviewer: string | null
}

export interface ActivityInput {
  /** The project's agents, in pane order. */
  agents: ActivityAgent[]
  cards: ActivityCard[]
  /** The project's sessions (session:list), for a running session's name and its subagents. */
  sessions: readonly SessionListItem[]
  /** Turns read so far, by session id. */
  turns: ReadonlyMap<string, ActivityTurns>
  now: ActivityNow
  /** Unix ms: now, for open tool calls. */
  at: number
}

/** A tab (HI-1743): a project agent, its state, and the card it works on now (none: its session is its work). */
export interface ActivityTabInfo {
  agentId: string
  name: string
  state: ActivityState
  card: ActivityCard | null
  /** Nothing running: not running, or idle with no process or background task of its own (Hide finished hides it). */
  finished: boolean
}

/** A card in progress as an agent's current work: one it builds in Doing, else one it reviews, else one of its in Review. */
export function currentCard(agentId: string, cards: readonly ActivityCard[]): ActivityCard | null {
  return cards.find((c) => c.builder === agentId && c.column === 'doing') ?? cards.find((c) => c.reviewer === agentId && c.column === 'review') ?? cards.find((c) => c.builder === agentId && c.column === 'review') ?? null
}

/** The agent working on a card now, for the card's Activity: its builder while it runs, else its reviewer, else either. */
export function cardWorker(card: Pick<ActivityCard, 'builder' | 'reviewer'>, runs: (id: string) => boolean): string | null {
  return [card.builder, card.reviewer].find((id) => !!id && runs(id)) ?? card.builder ?? card.reviewer ?? null
}

/** An agent's state, for its tab's dot and its nodes' colour. */
function stateOf(a: ActivityAgent): ActivityState {
  if (!a.live) return 'idle'
  if (a.live.failed) return 'failed'
  if (a.live.waiting) return 'waiting'
  return a.live.working ? 'working' : 'idle'
}

/** Whether something of the agent's own runs: a process of its launch besides its CLI, or a background task. */
function running(id: string, now: ActivityNow): boolean {
  return now.tasks.some((t) => t.agentId === id) || now.launches.some((l) => l.agentId === id && l.processes.some((p) => !l.cli.includes(p.pid)))
}

/**
 * The tabs (HI-1743): the project's agents in pane order, narrowed to the agents and cards asked for (an agent by its
 * current card); Hide finished, on by default, leaves out those with nothing running, except `keep` (the tab shown:
 * opened for that agent, or chosen).
 */
export function activityTabs(input: ActivityInput, filter: ActivityFilter = {}, keep?: string | null): ActivityTabInfo[] {
  const hide = filter.hideFinished !== false
  return input.agents.flatMap((a): ActivityTabInfo[] => {
    const card = currentCard(a.id, input.cards)
    const state = stateOf(a)
    const finished = !a.live || (state === 'idle' && !running(a.id, input.now))
    const tab = { agentId: a.id, name: a.name, state, card, finished }
    if (filter.agents?.length && !filter.agents.includes(a.id)) return []
    if (filter.cards?.length && !(card && filter.cards.includes(card.number))) return []
    return hide && finished && a.id !== keep ? [] : [tab]
  })
}

/**
 * One agent's tree (HI-1743): its current card, with the card's builder and reviewer under it (the agent itself always,
 * the other while it runs), else the agent alone. Under each agent its running session: the latest turn with its tool
 * calls and the processes they started, the background tasks, the processes, and the subagents of that turn.
 */
export function buildActivityTree(input: ActivityInput, agentId: string): ActivityNode[] {
  const { at } = input
  const agents = new Map(input.agents.map((a) => [a.id, a]))
  const me = agents.get(agentId)
  if (!me) return []
  const listed = new Map(input.sessions.map((s) => [s.id, s]))
  const subs = new Map<string, SessionListItem[]>()
  for (const s of input.sessions) if (s.sub?.parentId) subs.set(s.sub.parentId, [...(subs.get(s.sub.parentId) ?? []), s])
  const launches = new Map<string, ActivityLaunch[]>()
  for (const l of input.now.launches) launches.set(l.agentId, [...(launches.get(l.agentId) ?? []), l])

  const turnNode = (sessionId: string, agent: string | null, t: ActivityTurn, working: boolean, placed: Map<number, AgentProcess[]>): ActivityNode => {
    const tools = t.tools.map((tool): ActivityNode => {
      const state: ActivityState = tool.failed ? 'failed' : !tool.done && working ? 'working' : 'done'
      const ps = (placed.get(tool.itemId) ?? []).map((p): ActivityNode => ({ kind: 'process', key: `p:${p.pid}:${p.created ?? ''}`, agentId: agent!, process: p, cli: false, children: [] }))
      return { kind: 'tool', key: `tool:${sessionId}:${tool.itemId}`, sessionId, tool, state, children: ps }
    })
    const state: ActivityState = working ? 'working' : t.tools.some((x) => x.failed) ? 'failed' : 'done'
    return { kind: 'turn', key: `turn:${sessionId}:${t.itemId}`, sessionId, turn: t, state, children: tools }
  }

  /** A subagent's session: its latest turn, once read. */
  const subNode = (s: SessionListItem): ActivityNode => {
    const turns = input.turns.get(s.id)
    const last = turns?.turns.at(-1)
    return { kind: 'session', key: `s:${s.id}`, agentId: s.agentId ?? null, session: s, live: false, state: 'done', turnsLoaded: !!turns, turnCount: turns?.total ?? 0, children: last ? [turnNode(s.id, s.agentId ?? null, last, false, new Map())] : [] }
  }

  /** A running agent's session, with what runs in it now. */
  const sessionNode = (a: ActivityAgent): ActivityNode => {
    const live = a.live!
    // Its session the list doesn't have yet (just started; the list is read again later): drawn from its live state.
    const s = listed.get(live.sessionId) ?? ({ id: live.sessionId, agentId: a.id, agentName: a.name, name: live.sessionName ?? a.name, source: 'hive', lastActivity: live.startedAt ?? new Date(at).toISOString(), hasTranscript: true, hasBackup: false, title: null, usage: null, recache: null } as SessionListItem)
    const turns = input.turns.get(s.id)
    const last = turns?.turns.at(-1)
    const procs = launches.get(a.id) ?? []
    const cli = new Set(procs.flatMap((l) => l.cli))
    const all = procs.flatMap((l) => l.processes)
    const placed = placeProcesses(
      all.filter((p) => !cli.has(p.pid)),
      last ? [last] : [],
      at
    )
    const children: ActivityNode[] = []
    if (last) children.push(turnNode(s.id, a.id, last, live.working, placed.byTool))
    for (const task of input.now.tasks.filter((x) => x.sessionId === s.id)) children.push({ kind: 'task', key: `task:${s.id}:${task.id}`, task, children: [] })
    for (const p of [...all.filter((x) => cli.has(x.pid)), ...placed.rest]) children.push({ kind: 'process', key: `p:${p.pid}:${p.created ?? ''}`, agentId: a.id, process: p, cli: cli.has(p.pid), children: [] })
    // Its subagents in this turn (since its prompt; all of them before its turns are read).
    const since = last?.at ? Date.parse(last.at) : -Infinity
    for (const sub of subs.get(s.id) ?? []) if (Date.parse(sub.lastActivity ?? sub.lastActiveAt ?? '') >= since) children.push(subNode(sub))
    return { kind: 'session', key: `s:${s.id}`, agentId: a.id, session: s, live: true, state: stateOf(a), turnsLoaded: !!turns, turnCount: turns?.total ?? 0, children }
  }

  const agentNode = (a: ActivityAgent): ActivityNode => ({ kind: 'agent', key: `a:${a.id}`, agentId: a.id, name: a.name, state: stateOf(a), status: a.live?.status ?? null, line: a.live?.text ?? '', children: a.live ? [sessionNode(a)] : [] })

  const card = currentCard(agentId, input.cards)
  if (!card) return [agentNode(me)]
  const pair = [card.builder, card.reviewer].flatMap((id) => {
    const a = id ? agents.get(id) : undefined
    return a && (a.id === agentId || a.live) ? [a] : []
  })
  return [{ kind: 'card', key: `c:${card.number}`, number: card.number, label: card.label, title: card.title, column: card.column, children: [...new Set(pair)].map(agentNode) }]
}

/** The tree without the gone nodes `keep` lets go (HI-1743: live, an ended process fades out, then leaves). */
export function pruneGone(tree: readonly ActivityNode[], keep: (n: ActivityNode) => boolean): ActivityNode[] {
  return tree.flatMap((n) => (n.gone && !keep(n) ? [] : [{ ...n, children: pruneGone(n.children, keep) }]))
}

/** The keys of the gone nodes anywhere in the tree. */
export function goneKeys(tree: readonly ActivityNode[]): string[] {
  return tree.flatMap((n) => [...(n.gone ? [n.key] : []), ...goneKeys(n.children)])
}

/**
 * The newest tree, reconciled with what was drawn before (HI-1677), so nothing drawn moves until a refresh (`prev`
 * empty draws it afresh). Across the whole tree, each key is one node:
 * - one drawn before and now under another parent (a process found to be a tool call's) stays under the parent it was
 *   drawn under;
 * - one missing now (a process that ended, a session that stopped) stays where it was, marked `gone`, with what it held.
 */
export function keepGone(prev: readonly ActivityNode[], next: readonly ActivityNode[]): ActivityNode[] {
  if (!prev.length) return [...next]
  // The newest tree copied, each node's children its own array, with each key's node and parent.
  const top: ActivityNode[] = []
  const at = new Map<string, { node: ActivityNode; parent: string | null }>()
  const copy = (nodes: readonly ActivityNode[], parent: string | null, into: ActivityNode[]): void => {
    for (const n of nodes) {
      if (at.has(n.key)) continue
      const c: ActivityNode = { ...n, children: [] }
      at.set(n.key, { node: c, parent })
      into.push(c)
      copy(n.children, n.key, c.children)
    }
  }
  copy(next, null, top)
  const childrenOf = (parent: string | null): ActivityNode[] => (parent === null ? top : at.get(parent)!.node.children)
  // What was drawn, parents first: each node goes back under the parent it was drawn under, or stays as gone there.
  const walk = (nodes: readonly ActivityNode[], parent: string | null): void => {
    for (const n of nodes) {
      const now = at.get(n.key)
      if (!now) {
        const g: ActivityNode = { ...n, gone: true, children: [] }
        at.set(n.key, { node: g, parent })
        childrenOf(parent).push(g)
      } else if (now.parent !== parent) {
        const from = childrenOf(now.parent)
        from.splice(from.indexOf(now.node), 1)
        childrenOf(parent).push(now.node)
        now.parent = parent
      }
      walk(n.children, n.key)
    }
  }
  walk(prev, null)
  return top
}

/** Rows of the tree as drawn: each node shown, its depth, and its parent's row (-1 at the top). */
export interface ActivityRow {
  node: ActivityNode
  depth: number
  parent: number
}

/** When each node was first drawn (HI-1677), by key: the rows' order. Kept for as long as the tab shows the project. */
export interface ActivityOrder {
  seq: Map<string, number>
  next: number
}

export const newOrder = (): ActivityOrder => ({ seq: new Map(), next: 0 })

/**
 * The rows the tree shows (HI-1677: nothing that was drawn moves as work comes and goes). A node is numbered the first
 * time it is seen (the first tree in its own order), and the rows go by those numbers: new work comes after everything
 * already drawn, whatever its parent, and a node stays where it was as others are added, finish or end. A node always
 * comes after its parent (a session filed under a card made since takes the card's place). Opening or closing a node
 * changes only what is shown below it.
 */
export function stableRows(tree: readonly ActivityNode[], isOpen: (n: ActivityNode) => boolean, order: ActivityOrder): ActivityRow[] {
  const shown: { node: ActivityNode; depth: number; parentKey: string | null; rank: number; dfs: number }[] = []
  const walk = (nodes: readonly ActivityNode[], depth: number, parent: { key: string; rank: number } | null, visible: boolean): void => {
    for (const n of nodes) {
      let seq = order.seq.get(n.key)
      if (seq === undefined) order.seq.set(n.key, (seq = order.next++))
      const rank = Math.max(seq, parent?.rank ?? -1)
      if (visible) shown.push({ node: n, depth, parentKey: parent?.key ?? null, rank, dfs: shown.length })
      walk(n.children, depth + 1, { key: n.key, rank }, visible && isOpen(n))
    }
  }
  walk(tree, 0, null, true)
  shown.sort((a, b) => a.rank - b.rank || a.dfs - b.dfs)
  const at = new Map(shown.map((r, i) => [r.node.key, i]))
  return shown.map((r) => ({ node: r.node, depth: r.depth, parent: r.parentKey === null ? -1 : (at.get(r.parentKey) ?? -1) }))
}

/** The levels the tree folds at once (HI-1678), by what a node is: sub-sessions and background tasks are subagents. */
export const ACTIVITY_LEVELS = ['agent', 'session', 'subagent', 'turn', 'tool', 'process'] as const
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number]

/** A node's level for Levels ▾; cards have none (they don't fold by level). */
export function activityLevel(n: ActivityNode): ActivityLevel | null {
  switch (n.kind) {
    case 'agent':
      return 'agent'
    case 'session':
      return n.session.sub ? 'subagent' : 'session'
    case 'task':
      return 'subagent'
    case 'turn':
      return 'turn'
    case 'tool':
      return 'tool'
    case 'process':
      return 'process'
    default:
      return null
  }
}

/** The keys of every node at a level, anywhere in the tree. */
export function keysAtLevel(tree: readonly ActivityNode[], level: ActivityLevel): Set<string> {
  const out = new Set<string>()
  const walk = (nodes: readonly ActivityNode[]): void => {
    for (const n of nodes) {
      if (activityLevel(n) === level) out.add(n.key)
      walk(n.children)
    }
  }
  walk(tree)
  return out
}
