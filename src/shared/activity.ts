// The Activity tab (#1254, HI-1743): what runs now in a project, a tab per running agent, each its current work as a
// list: its card in progress (a header) or its session, the turn now (its prompt, the tool call under way, or thinking
// or writing), the subagents and background tasks, and the processes it started. Nothing past: "the card is the
// history". From what Combwork already has: the board, the session records, the agents' live state, a session's transcript
// parse and Stop's tracking's processes.
import type { AgentProcess } from './agentProcesses'
import type { BackgroundTaskType, ModelSwitch, ProviderId, SessionListItem, SessionStatus, TranscriptItem, TranscriptTool } from './types'
import { maskText } from './redact'
import type { ActivityHookBlock } from './hooks'

/** How far back the session list is read: a running session and its subagents' are within it. */
export const ACTIVITY_HOURS = 24
/** A session's turns read for the tree: its latest ones (the tree shows the last). */
export const ACTIVITY_TURNS = 50
/** A prompt or reply shown in a node, cut to this many characters (the details show more). */
const LINE = 160
/** A prompt, input or reply shown in the details, cut to this many characters. */
export const DETAIL = 4000

/**
 * The calls a tool call stands for (HI-2240): a Codex script's, when its Codex recorded them (they are what it did: an
 * agent's activity lists them), else the call itself.
 */
export const callsMade = (tool: TranscriptTool): TranscriptTool[] => (tool.calls?.length ? tool.calls : [tool])

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
  /** A script's calls, by name only (HI-2240's `calls`; the Activity map's stations, HI-2903): absent for any other call. */
  calls?: string[]
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
  /** What came last in it: a tool call, or a reply (the agent writing); null, nothing yet (thinking). */
  lastKind: 'tool' | 'reply' | null
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
export type ActivityProcess = AgentProcess & {
  command?: string
  /** Left running by the agent's command (HI-2111): its parent has exited, and it has run past ten minutes; its CPU time in ms. */
  orphan?: { cpuMs: number }
}

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
  /** Lock blocks standing now (HI-982): an agent's edit Combwork's file lock blocked, while that decision stands. */
  blocks?: ActivityHookBlock[]
}

/** What ending a process from the tab did: `notOwn`, the agent's launch no longer has it (ended, or never its). */
/** An agent working on a card now (HI-1664): its session host's path, its id there, and the session it runs. */
export interface ActivityCardAgent {
  path: string
  agentId: string
  sessionId: string
}

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
      turn = { itemId: item.id, at: item.timestamp, prompt: cut(maskText(item.text), LINE), tools: [], reply: '', lastKind: null }
      turns.push(turn)
      continue
    }
    if (!turn) continue
    if (item.kind === 'tool') {
      turn.tools.push({ itemId: item.id, name: item.tool.name, summary: cut(maskText(item.tool.summary), LINE), at: item.timestamp, until: nextAt[i - from], failed: item.tool.isError, done: item.tool.result !== null, ...(item.tool.calls?.length ? { calls: item.tool.calls.map((c) => c.name) } : {}) })
      turn.lastKind = 'tool'
    } else if (item.kind === 'assistant' && item.text.trim()) {
      turn.reply = cut(maskText(item.text), LINE)
      turn.lastKind = 'reply'
    }
  }
  return { total, turns }
}

/** A Windows FILETIME (100 ns since 1601, as text) as Unix ms; null when it isn't one. */
export function filetimeMs(created: string | undefined): number | null {
  if (!created || !/^\d+$/.test(created)) return null
  return Number((BigInt(created) - 116444736000000000n) / 10000n)
}

/** A node's state, as the tab colours it. */
export type ActivityState = 'working' | 'waiting' | 'failed' | 'done' | 'idle'

/**
 * An item of an agent's work, as a row: a turn, a tool call, a subagent's session, a background task, a process.
 * `gone`: shown before and missing now (a process that ended): live, it fades out where it was, then leaves (HI-1743).
 */
export type ActivityNode = (
  | { kind: 'session'; key: string; agentId: string | null; session: SessionListItem; live: boolean; state: ActivityState; turnsLoaded: boolean; turnCount: number; last: ActivityTurn | null }
  | { kind: 'turn'; key: string; sessionId: string; turn: ActivityTurn; state: ActivityState }
  | { kind: 'tool'; key: string; sessionId: string; tool: ActivityTool; state: ActivityState }
  | { kind: 'task'; key: string; task: ActivityTask }
  | { kind: 'process'; key: string; agentId: string; process: ActivityProcess; own: boolean }
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
  live: { sessionId: string; sessionName?: string; startedAt?: string; status: SessionStatus; text: string; working: boolean; waiting: boolean; failed: boolean; /** It runs another model than it was launched with (HI-2609), and its CLI. */ modelSwitch?: ModelSwitch & { provider: ProviderId } } | null
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
  /** Unix ms: now. */
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

/**
 * The agent working on a card now, for the card's Activity: its builder while it runs on this card, else its reviewer
 * while it does, else either (HR6's round 1: a builder gone on to its next card isn't working on this one).
 */
export function cardWorker(card: ActivityCard, cards: readonly ActivityCard[], runs: (id: string) => boolean): string | null {
  const onIt = (id: string | null): id is string => !!id && runs(id) && currentCard(id, cards)?.number === card.number
  return [card.builder, card.reviewer].find(onIt) ?? card.builder ?? card.reviewer ?? null
}

/** An agent's state, for its tab's dot and its rows' colour. */
function stateOf(a: ActivityAgent): ActivityState {
  if (!a.live) return 'idle'
  if (a.live.failed) return 'failed'
  if (a.live.waiting) return 'waiting'
  return a.live.working ? 'working' : 'idle'
}

/**
 * Whether a process is the agent's own plumbing, not something it runs (HI-1743): its CLI and the terminal hosting it
 * (Stop's tracking marks them), and Combwork's tool server for it (cw-mcp.js), always there and saying nothing.
 */
export const ownProcess = (p: ActivityProcess, cli: ReadonlySet<number>): boolean => cli.has(p.pid) || /\bcw-mcp\.js\b/i.test(p.command ?? p.label)

/** Whether something the agent started runs: a process of its launch that isn't its own plumbing, or a background task. */
function running(id: string, now: ActivityNow): boolean {
  return now.tasks.some((t) => t.agentId === id) || now.launches.some((l) => l.agentId === id && l.processes.some((p) => !ownProcess(p, new Set(l.cli))))
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

/** What an agent is doing in its turn now: the tool call under way, else writing or thinking; null when it isn't working. */
export type ActivityDoing = { kind: 'tool'; tool: Extract<ActivityNode, { kind: 'tool' }> } | { kind: 'thinking' | 'writing' } | null

/** One agent's work in a tab (HI-1743): its turn now, its subagents and background tasks, its processes. */
export interface ActivityPart {
  agentId: string
  name: string
  /** Its role on the card shown: its builder or its reviewer (none: no card). */
  role: 'builder' | 'reviewer' | null
  state: ActivityState
  /** Its live status line (none: not running). */
  line: string
  session: Extract<ActivityNode, { kind: 'session' }> | null
  turn: Extract<ActivityNode, { kind: 'turn' }> | null
  doing: ActivityDoing
  subagents: ActivityNode[]
  processes: ActivityNode[]
  /** Its edit Combwork's file lock blocks now (HI-982), while that decision stands: none, or its latest. */
  blocks: ActivityHookBlock[]
  /** It runs another model than it was launched with (HI-2609): the launched and the running model's IDs; null when not. */
  modelSwitch: (ModelSwitch & { provider: ProviderId }) | null
  /** Its own processes left out (the CLI, its terminal, cw-mcp.js): shown with `showOwn`. */
  ownHidden: number
}

/** A tab's content (HI-1743): its card in progress (a header), and the work of each agent on it, the tab's agent first. */
export interface ActivityView {
  card: ActivityCard | null
  parts: ActivityPart[]
}

/** The tool call under way in a turn, else what the agent does (writing after a reply, thinking otherwise); null if not working. */
function doingOf(turn: ActivityTurn | null, sessionId: string, working: boolean): ActivityDoing {
  if (!working) return null
  const open = turn?.tools.at(-1)
  if (open && !open.done && turn?.lastKind === 'tool') return { kind: 'tool', tool: { kind: 'tool', key: `tool:${sessionId}:${open.itemId}`, sessionId, tool: open, state: 'working' } }
  return { kind: turn?.lastKind === 'reply' ? 'writing' : 'thinking' }
}

/**
 * A tab's content (HI-1743): the agent's current card, with the work of the card's builder and reviewer (the agent's
 * own always, the other's only while it runs on this card: HR6's round 1), else the agent's alone. Each agent's part:
 * its running session's latest turn and what it does in it, its subagents of that turn (each live while the agent
 * works or a background subagent of its runs, so its transcript is read again) and its background tasks, and the
 * processes of its launch (its own plumbing only with `showOwn`).
 */
export function buildActivityView(input: ActivityInput, agentId: string, opts: { showOwn?: boolean } = {}): ActivityView {
  const agents = new Map(input.agents.map((a) => [a.id, a]))
  const me = agents.get(agentId)
  if (!me) return { card: null, parts: [] }
  const listed = new Map(input.sessions.map((s) => [s.id, s]))
  const subs = new Map<string, SessionListItem[]>()
  for (const s of input.sessions) if (s.sub?.parentId) subs.set(s.sub.parentId, [...(subs.get(s.sub.parentId) ?? []), s])

  const part = (a: ActivityAgent, role: ActivityPart['role']): ActivityPart => {
    const base: ActivityPart = { agentId: a.id, name: a.name, role, state: stateOf(a), line: a.live?.text ?? '', session: null, turn: null, doing: null, subagents: [], processes: [], blocks: (input.now.blocks ?? []).filter((b) => b.agentId === a.id), modelSwitch: a.live?.modelSwitch ? { launched: a.live.modelSwitch.launched, running: a.live.modelSwitch.running, provider: a.live.modelSwitch.provider } : null, ownHidden: 0 }
    const live = a.live
    if (!live) return base
    // Its session the list doesn't have yet (just started; the list is read again later): drawn from its live state.
    const s = listed.get(live.sessionId) ?? ({ id: live.sessionId, agentId: a.id, agentName: a.name, name: live.sessionName ?? a.name, source: 'combwork', lastActivity: live.startedAt ?? new Date(input.at).toISOString(), hasTranscript: true, hasBackup: false, title: null, usage: null, recache: null } as SessionListItem)
    const turns = input.turns.get(s.id)
    const last = turns?.turns.at(-1) ?? null
    const tasks = input.now.tasks.filter((x) => x.sessionId === s.id)
    const session: ActivityPart['session'] = { kind: 'session', key: `s:${s.id}`, agentId: a.id, session: s, live: true, state: stateOf(a), turnsLoaded: !!turns, turnCount: turns?.total ?? 0, last }
    const turn: ActivityPart['turn'] = last ? { kind: 'turn', key: `turn:${s.id}:${last.itemId}`, sessionId: s.id, turn: last, state: live.working ? 'working' : last.tools.some((x) => x.failed) ? 'failed' : 'done' } : null
    // Its subagents in this turn (since its prompt; all of them before its turns are read), live while they can run.
    const since = last?.at ? Date.parse(last.at) : -Infinity
    const subActive = live.working || tasks.some((t) => t.type === 'subagent')
    const subagents: ActivityNode[] = (subs.get(s.id) ?? [])
      .filter((sub) => Date.parse(sub.lastActivity ?? sub.lastActiveAt ?? '') >= since)
      .map((sub) => {
        const t = input.turns.get(sub.id)
        // Working on its own evidence (HR6's round 2), never its parent's: a tool call of its open, or nothing written since
        // its prompt or its last tool call; its reply is its end. Read again while it can run.
        const subLast = t?.turns.at(-1) ?? null
        const busy = subActive && !!t && subLast?.lastKind !== 'reply'
        return { kind: 'session', key: `s:${sub.id}`, agentId: sub.agentId ?? null, session: sub, live: subActive, state: busy ? 'working' : t ? 'done' : 'idle', turnsLoaded: !!t, turnCount: t?.total ?? 0, last: subLast }
      })
    for (const task of tasks) subagents.push({ kind: 'task', key: `task:${s.id}:${task.id}`, task })
    const launches = input.now.launches.filter((l) => l.agentId === a.id)
    const cli = new Set(launches.flatMap((l) => l.cli))
    const all = launches.flatMap((l) => l.processes).map((p): ActivityNode => ({ kind: 'process', key: `p:${p.pid}:${p.created ?? ''}`, agentId: a.id, process: p, own: ownProcess(p, cli) }))
    const processes = opts.showOwn ? all : all.filter((n) => n.kind === 'process' && !n.own)
    return { ...base, session, turn, doing: doingOf(last, s.id, live.working), subagents, processes, ownHidden: all.length - processes.length }
  }

  const card = currentCard(agentId, input.cards)
  if (!card) return { card: null, parts: [part(me, null)] }
  const roleOf = (id: string): ActivityPart['role'] => (id === card.builder ? 'builder' : id === card.reviewer ? 'reviewer' : null)
  const other = [card.builder, card.reviewer].find((id): id is string => !!id && id !== agentId)
  const o = other ? agents.get(other) : undefined
  const pair = o?.live && currentCard(o.id, input.cards)?.number === card.number ? [o] : []
  return { card, parts: [part(me, roleOf(me.id)), ...pair.map((x) => part(x, roleOf(x.id)))] }
}

/**
 * A list as shown, with what left it kept in place, marked `gone` (HI-1743: live, nothing shown moves; what ended fades
 * out where it was): each item shown before where it was (its newest form, or gone), then the new ones at the end.
 */
export function keepGoneList(prev: readonly ActivityNode[], next: readonly ActivityNode[]): ActivityNode[] {
  const now = new Map(next.map((n) => [n.key, n]))
  const seen = new Set<string>()
  const out: ActivityNode[] = []
  for (const n of prev) {
    if (seen.has(n.key)) continue
    seen.add(n.key)
    const fresh = now.get(n.key)
    out.push(fresh ?? { ...n, gone: true })
  }
  for (const n of next) if (!seen.has(n.key)) out.push(n)
  return out
}

/**
 * What a process runs, as the tab names it (HI-1743): a `cmd /d /s /c "<x>"` wrapper as `<x>`, as given; anything else
 * by its label (its executable and arguments, paths cut to their last part, switches kept). Its details have the whole line.
 */
export function commandText(p: Pick<ActivityProcess, 'command' | 'label'>): string {
  const line = (p.command ?? '').trim()
  if (!line) return p.label
  const cmd = /^"?(?:[^"\s]*[\\/])?cmd(?:\.exe)?"?((?:\s+\/[a-z](?::\S*)?)*)\s+\/[ck]\s+(.+)$/i.exec(line)
  if (!cmd) return p.label
  const inner = cmd[2].trim()
  return inner.startsWith('"') && inner.endsWith('"') && inner.length > 1 ? inner.slice(1, -1) : inner
}
