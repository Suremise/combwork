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

export type ActivityNode =
  | { kind: 'card'; key: string; number: number; label: string; title: string; column: string; children: ActivityNode[] }
  | { kind: 'agent'; key: string; agentId: string; name: string; state: ActivityState; status: SessionStatus | null; line: string; children: ActivityNode[] }
  | { kind: 'session'; key: string; agentId: string | null; session: SessionListItem; live: boolean; state: ActivityState; turnsLoaded: boolean; turnCount: number; children: ActivityNode[] }
  | { kind: 'more'; key: string; count: number; children: ActivityNode[] }
  | { kind: 'turn'; key: string; sessionId: string; turn: ActivityTurn; state: ActivityState; children: ActivityNode[] }
  | { kind: 'tool'; key: string; sessionId: string; tool: ActivityTool; state: ActivityState; children: ActivityNode[] }
  | { kind: 'task'; key: string; task: ActivityTask; children: ActivityNode[] }
  | { kind: 'process'; key: string; agentId: string; process: ActivityProcess; cli: boolean; children: ActivityNode[] }

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
  /** Unix ms, for the 24 hours and open tool calls. */
  at: number
  /** Only this agent's, or this card's. */
  filter?: { agentId?: string; card?: number }
  /** Groups showing all their sessions (the "n more" opened), by key. */
  showAll?: ReadonlySet<string>
}

/** A session in the tab's window: running, or active within ACTIVITY_HOURS. */
function recent(s: SessionListItem, live: ReadonlySet<string>, at: number): boolean {
  if (live.has(s.id)) return true
  if (s.archived || s.deleted) return false
  const last = Date.parse(s.lastActivity ?? s.lastActiveAt ?? '')
  return Number.isFinite(last) && at - last <= ACTIVITY_HOURS * 3600_000
}

/** The card a session is filed under: the last it worked on that is listed, else none. */
const cardOf = (s: SessionListItem, cards: ReadonlyMap<number, ActivityCard>): number | null => [...(s.cards ?? [])].reverse().find((c) => cards.has(c.number))?.number ?? null

/** The tree (#1254): cards with their agents and sessions, then agents' sessions on no card; filtered as asked. */
export function buildActivityTree(input: ActivityInput): ActivityNode[] {
  const { at } = input
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
    if (!recent(s, liveIds, at)) continue
    if (s.sub?.parentId) subs.set(s.sub.parentId, [...(subs.get(s.sub.parentId) ?? []), s])
    else tops.push(s)
  }
  // Newest first within a group.
  const newest = (a: SessionListItem, b: SessionListItem): number => (b.lastActivity ?? b.lastActiveAt ?? '').localeCompare(a.lastActivity ?? a.lastActiveAt ?? '')
  tops.sort(newest)
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
    if (depth < 4) for (const sub of (subs.get(s.id) ?? []).sort(newest)) children.push(sessionNode(sub, depth + 1))
    const state: ActivityState = live ? stateOf(agent!) : 'done'
    return { kind: 'session', key: `s:${s.id}`, agentId: s.agentId ?? null, session: s, live, state, turnsLoaded: !!turns, turnCount: turns?.total ?? 0, children }
  }

  /** Sessions of a group, the newest ACTIVITY_SESSIONS first and the rest behind "n more" (running ones always shown). */
  const group = (key: string, list: SessionListItem[]): ActivityNode[] => {
    const shown = input.showAll?.has(key) ? list : list.filter((s, i) => i < ACTIVITY_SESSIONS || liveIds.has(s.id))
    const nodes = shown.map((s) => sessionNode(s))
    const hidden = list.length - shown.length
    if (hidden > 0) nodes.push({ kind: 'more', key: `more:${key}`, count: hidden, children: [] })
    return nodes
  }

  const agentNode = (id: string, key: string, list: SessionListItem[]): ActivityNode => {
    const a = agents.get(id)
    return { kind: 'agent', key, agentId: id, name: a?.name ?? list.find((s) => s.agentName)?.agentName ?? id, state: a ? stateOf(a) : 'idle', status: a?.live?.status ?? null, line: a?.live?.text ?? '', children: group(key, list) }
  }

  const f = input.filter ?? {}
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
    if (f.card !== undefined && c.number !== f.card) continue
    const list = filed.get(c.number) ?? []
    // Its agents: those with sessions on it here, and its builder and reviewer while they run.
    const ids = [...new Set([...list.map((s) => s.agentId ?? ''), ...c.agents.filter((id) => agents.get(id)?.live)])].filter(Boolean)
    const children = ids.filter((id) => !f.agentId || id === f.agentId).map((id) => agentNode(id, `c:${c.number}:a:${id}`, list.filter((s) => s.agentId === id)))
    if (!children.length) continue
    for (const id of ids) underCards.add(id)
    out.push({ kind: 'card', key: `c:${c.number}`, number: c.number, label: c.label, title: c.title, column: c.column, children })
  }
  if (f.card === undefined) {
    const byAgent = new Map<string, SessionListItem[]>()
    for (const s of loose) byAgent.set(s.agentId ?? '', [...(byAgent.get(s.agentId ?? '') ?? []), s])
    // A running agent shown nowhere else (no session in the window yet) still has its node.
    for (const a of input.agents) if (a.live && !byAgent.has(a.id) && !underCards.has(a.id)) byAgent.set(a.id, [])
    for (const [id, list] of byAgent) {
      if (!id || (f.agentId && id !== f.agentId)) continue
      out.push(agentNode(id, `a:${id}`, list))
    }
  }
  // What runs now first (a card or an agent with a running session), then the rest as they were.
  const running = (n: ActivityNode): boolean => (n.kind === 'session' && n.live) || n.children.some(running)
  const first = out.filter(running)
  return [...first, ...out.filter((n) => !first.includes(n))]
}

/** An agent's state, for its nodes' colour. */
function stateOf(a: ActivityAgent): ActivityState {
  if (!a.live) return 'idle'
  if (a.live.failed) return 'failed'
  if (a.live.waiting) return 'waiting'
  return a.live.working ? 'working' : 'idle'
}
