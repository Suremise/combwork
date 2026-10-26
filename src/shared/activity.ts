// The Activity tab (#1254): a project's live work as a tree, card → agent → session → turn → tool call, with subagents
// and processes, from what Hive already has: the board, the session records, the agents' live state, a session's
// transcript parse (its turns, read when it is opened in the tree) and the processes Stop's tracking lists.
import type { AgentProcess } from './agentProcesses'
import type { BackgroundTaskType, SessionListItem, SessionStatus, TranscriptItem } from './types'
import { maskText } from './redact'

/** How far back the tab shows sessions that no longer run: older work is the Sessions tab's. */
export const ACTIVITY_HOURS = 24
/** A session's turns read for the tree: its latest ones. */
export const ACTIVITY_TURNS = 50
/** Sessions shown under one agent (or card) before "n more". */
export const ACTIVITY_SESSIONS = 8
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
 * A node of the tree. `gone`: drawn before and missing from the newest tree (a process that ended, a session out of the
 * range): kept in its row, dimmed, until a refresh (HI-1677).
 */
export type ActivityNode = (
  | { kind: 'card'; key: string; number: number; label: string; title: string; column: string; children: ActivityNode[] }
  | { kind: 'agent'; key: string; agentId: string; name: string; state: ActivityState; status: SessionStatus | null; line: string; children: ActivityNode[] }
  | { kind: 'session'; key: string; agentId: string | null; session: SessionListItem; live: boolean; state: ActivityState; turnsLoaded: boolean; turnCount: number; children: ActivityNode[] }
  | { kind: 'more'; key: string; count: number; children: ActivityNode[] }
  | { kind: 'turn'; key: string; sessionId: string; turn: ActivityTurn; state: ActivityState; children: ActivityNode[] }
  | { kind: 'tool'; key: string; sessionId: string; tool: ActivityTool; state: ActivityState; children: ActivityNode[] }
  | { kind: 'task'; key: string; task: ActivityTask; children: ActivityNode[] }
  | { kind: 'process'; key: string; agentId: string; process: ActivityProcess; cli: boolean; children: ActivityNode[] }
) & { gone?: boolean }

/** The time range the tree shows (HI-1677): running work only, or what was active within it, up to the data's 24 hours. */
export const ACTIVITY_RANGES = ['live', '15m', '1h', '6h', '24h'] as const
export type ActivityRange = (typeof ACTIVITY_RANGES)[number]
const RANGE_MINUTES: Record<ActivityRange, number> = { live: 0, '15m': 15, '1h': 60, '6h': 360, '24h': ACTIVITY_HOURS * 60 }

/** What the tree is narrowed to (HI-1677): agents and cards (none: all), the range, and only running work. */
export interface ActivityFilter {
  agents?: string[]
  cards?: number[]
  range?: ActivityRange
  hideFinished?: boolean
}

/** An agent as the tree needs it: its id, name and live state (none: not running). */
export interface ActivityAgent {
  id: string
  name: string
  live: { sessionId: string; sessionName?: string; startedAt?: string; status: SessionStatus; text: string; working: boolean; waiting: boolean; failed: boolean } | null
}

/** A card as the tree needs it. */
export interface ActivityCard {
  number: number
  label: string
  title: string
  column: string
  /** Its builder's and reviewer's agent ids, in this project. */
  agents: string[]
}

export interface ActivityInput {
  agents: ActivityAgent[]
  cards: ActivityCard[]
  /** The project's sessions (session:list). */
  sessions: readonly SessionListItem[]
  /** Turns read so far, by session id. */
  turns: ReadonlyMap<string, ActivityTurns>
  now: ActivityNow
  /** Unix ms: now, for open tool calls. */
  at: number
  /** Unix ms: when the range is measured from (the last refresh, so nothing ages out while it is looked at); default `at`. */
  rangeFrom?: number
  filter?: ActivityFilter
  /** Groups showing all their sessions (the "n more" opened), by key. */
  showAll?: ReadonlySet<string>
}

/** A session in the range: running, or (not hiding finished work) active within its minutes before `at`. */
function inRange(s: SessionListItem, live: ReadonlySet<string>, at: number, f: ActivityFilter): boolean {
  if (live.has(s.id)) return true
  const minutes = RANGE_MINUTES[f.range ?? '24h']
  if (f.hideFinished || !minutes || s.archived || s.deleted) return false
  const last = Date.parse(s.lastActivity ?? s.lastActiveAt ?? '')
  return Number.isFinite(last) && at - last <= minutes * 60_000
}

/** The card a session is filed under: the last it worked on that is listed, else none. */
const cardOf = (s: SessionListItem, cards: ReadonlyMap<number, ActivityCard>): number | null => [...(s.cards ?? [])].reverse().find((c) => cards.has(c.number))?.number ?? null

/** The tree (#1254): cards with their agents and sessions, then agents' sessions on no card; filtered as asked. */
export function buildActivityTree(input: ActivityInput): ActivityNode[] {
  const { at } = input
  const f = input.filter ?? {}
  const wantAgent = (id: string): boolean => !f.agents?.length || f.agents.includes(id)
  const wantCard = (n: number): boolean => !f.cards?.length || f.cards.includes(n)
  const liveIds = new Set(input.agents.flatMap((a) => (a.live ? [a.live.sessionId] : [])))
  const agents = new Map(input.agents.map((a) => [a.id, a]))
  const cards = new Map(input.cards.map((c) => [c.number, c]))
  const subs = new Map<string, SessionListItem[]>()
  const tops: SessionListItem[] = []
  // A running agent's session the list doesn't have yet (just started; the list is read again later): drawn from its live state.
  const listed = new Set(input.sessions.map((s) => s.id))
  const started = input.agents.flatMap((a): SessionListItem[] =>
    a.live && !listed.has(a.live.sessionId) ? [{ id: a.live.sessionId, agentId: a.id, agentName: a.name, name: a.live.sessionName ?? a.name, source: 'hive', lastActivity: a.live.startedAt ?? new Date(at).toISOString(), hasTranscript: true, hasBackup: false, title: null, usage: null, recache: null } as SessionListItem] : []
  )
  for (const s of [...input.sessions, ...started]) {
    if (!inRange(s, liveIds, input.rangeFrom ?? at, f)) continue
    if (s.sub?.parentId) subs.set(s.sub.parentId, [...(subs.get(s.sub.parentId) ?? []), s])
    else tops.push(s)
  }
  // Oldest first, the newest last (HI-1677): new work comes at the end, as the tab draws it.
  const oldest = (a: SessionListItem, b: SessionListItem): number => (a.lastActivity ?? a.lastActiveAt ?? '').localeCompare(b.lastActivity ?? b.lastActiveAt ?? '')
  tops.sort(oldest)
  const launches = new Map<string, ActivityLaunch[]>()
  for (const l of input.now.launches) launches.set(l.agentId, [...(launches.get(l.agentId) ?? []), l])

  const sessionNode = (s: SessionListItem, depth = 0): ActivityNode => {
    const agent = s.agentId ? agents.get(s.agentId) : undefined
    const live = !!agent?.live && agent.live.sessionId === s.id
    const turns = input.turns.get(s.id)
    const children: ActivityNode[] = []
    const procs = live ? (launches.get(s.agentId!) ?? []) : []
    const cli = new Set(procs.flatMap((l) => l.cli))
    const all = procs.flatMap((l) => l.processes)
    const placed = placeProcesses(
      all.filter((p) => !cli.has(p.pid)),
      turns?.turns ?? [],
      at
    )
    const lastTurn = turns?.turns.at(-1)
    for (const t of turns?.turns ?? []) {
      const working = live && agent!.live!.working && t === lastTurn
      const tools = t.tools.map((tool): ActivityNode => {
        const state: ActivityState = tool.failed ? 'failed' : !tool.done && working ? 'working' : 'done'
        const ps = (placed.byTool.get(tool.itemId) ?? []).map((p): ActivityNode => ({ kind: 'process', key: `p:${p.pid}:${p.created ?? ''}`, agentId: s.agentId!, process: p, cli: false, children: [] }))
        return { kind: 'tool', key: `tool:${s.id}:${tool.itemId}`, sessionId: s.id, tool, state, children: ps }
      })
      const state: ActivityState = working ? 'working' : t.tools.some((x) => x.failed) ? 'failed' : 'done'
      children.push({ kind: 'turn', key: `turn:${s.id}:${t.itemId}`, sessionId: s.id, turn: t, state, children: tools })
    }
    if (live) {
      for (const task of input.now.tasks.filter((x) => x.sessionId === s.id)) children.push({ kind: 'task', key: `task:${s.id}:${task.id}`, task, children: [] })
      const cliProcs = all.filter((p) => cli.has(p.pid))
      for (const p of [...cliProcs, ...placed.rest]) children.push({ kind: 'process', key: `p:${p.pid}:${p.created ?? ''}`, agentId: s.agentId!, process: p, cli: cli.has(p.pid), children: [] })
    }
    if (depth < 4) for (const sub of (subs.get(s.id) ?? []).sort(oldest)) children.push(sessionNode(sub, depth + 1))
    const state: ActivityState = live ? stateOf(agent!) : 'done'
    return { kind: 'session', key: `s:${s.id}`, agentId: s.agentId ?? null, session: s, live, state, turnsLoaded: !!turns, turnCount: turns?.total ?? 0, children }
  }

  /** Sessions of a group, oldest first: the newest ACTIVITY_SESSIONS, the older ones behind "n more" before them (running ones always shown). */
  const group = (key: string, list: SessionListItem[]): ActivityNode[] => {
    const shown = input.showAll?.has(key) ? list : list.filter((s, i) => i >= list.length - ACTIVITY_SESSIONS || liveIds.has(s.id))
    const hidden = list.length - shown.length
    return [...(hidden > 0 ? [{ kind: 'more' as const, key: `more:${key}`, count: hidden, children: [] }] : []), ...shown.map((s) => sessionNode(s))]
  }

  const agentNode = (id: string, key: string, list: SessionListItem[]): ActivityNode => {
    const a = agents.get(id)
    return { kind: 'agent', key, agentId: id, name: a?.name ?? list.find((s) => s.agentName)?.agentName ?? id, state: a ? stateOf(a) : 'idle', status: a?.live?.status ?? null, line: a?.live?.text ?? '', children: group(key, list) }
  }

  const out: ActivityNode[] = []
  const underCards = new Set<string>()
  const filed = new Map<number, SessionListItem[]>()
  const loose: SessionListItem[] = []
  for (const s of tops) {
    const c = cardOf(s, cards)
    if (c === null) loose.push(s)
    else filed.set(c, [...(filed.get(c) ?? []), s])
  }
  for (const c of input.cards) {
    if (!wantCard(c.number)) continue
    const list = filed.get(c.number) ?? []
    // Its agents: those with sessions on it here, and its builder and reviewer while they run.
    const ids = [...new Set([...list.map((s) => s.agentId ?? ''), ...c.agents.filter((id) => agents.get(id)?.live)])].filter(Boolean)
    const children = ids.filter(wantAgent).map((id) => agentNode(id, `c:${c.number}:a:${id}`, list.filter((s) => s.agentId === id)))
    if (!children.length) continue
    for (const id of ids) underCards.add(id)
    out.push({ kind: 'card', key: `c:${c.number}`, number: c.number, label: c.label, title: c.title, column: c.column, children })
  }
  if (!f.cards?.length) {
    const byAgent = new Map<string, SessionListItem[]>()
    for (const s of loose) byAgent.set(s.agentId ?? '', [...(byAgent.get(s.agentId ?? '') ?? []), s])
    // A running agent shown nowhere else (no session in the window yet) still has its node.
    for (const a of input.agents) if (a.live && !byAgent.has(a.id) && !underCards.has(a.id)) byAgent.set(a.id, [])
    for (const [id, list] of byAgent) {
      if (!id || !wantAgent(id)) continue
      // Hiding finished work, an agent with nothing running isn't shown.
      if (f.hideFinished && !list.length) continue
      out.push(agentNode(id, `a:${id}`, list))
    }
  }
  return out
}

/**
 * The newest tree, reconciled with what was drawn before (HI-1677), so nothing drawn moves until a refresh (`prev`
 * empty draws it afresh). Across the whole tree, each key is one node:
 * - one drawn before and now under another parent (a process found to be a tool call's, a session filed under a card
 *   since) stays under the parent it was drawn under;
 * - one missing now (a process that ended, a session out of the range, an "n more" whose sessions left) stays where it
 *   was, marked `gone`, with what it held.
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

/** An agent's state, for its nodes' colour. */
function stateOf(a: ActivityAgent): ActivityState {
  if (!a.live) return 'idle'
  if (a.live.failed) return 'failed'
  if (a.live.waiting) return 'waiting'
  return a.live.working ? 'working' : 'idle'
}

/** The levels the tree folds at once (HI-1678), by what a node is: sub-sessions and background tasks are subagents. */
export const ACTIVITY_LEVELS = ['agent', 'session', 'subagent', 'turn', 'tool', 'process'] as const
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number]

/** A node's level for Levels ▾; cards and "n more" have none (they don't fold by level). */
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
