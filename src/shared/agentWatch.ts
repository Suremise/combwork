/**
 * Waiting on agents (#416): an agent watch (hive_wait_for_agents with wake) follows agents, not cards, through the same
 * watches as card watches (main/watches.ts). It fires when a watched agent's turn ends, it waits for the user, or it
 * stops; its line names every agent that did. Pure, so the watches, the Agent API and tests share it.
 */
import { AGENT_LIMIT_MAX } from './defaults'
import { msg } from './i18n/msg'
import { columnName, type Tr } from './tasks'
import type { SessionStatus, TaskWatchInfo } from './types'
import { DEFAULT_USER_NAME, WAKE_MAX_BYTES } from './watch'
import { isProjectId } from './projectIds'
import { cardRef } from './projectKeys'

/** An agent a watch follows: where it is, and its name and project's for the line (as they were when the watch began). */
export interface WatchedAgent {
  projectPath: string
  agentId: string
  name: string
  project: string
  /** Its project's stable id (#508): the watch follows the project to a new folder by it. Absent in watches from before. */
  projectId?: string
  /** Its project is gone, and another project has its folder (#508): it reads as stopped, never as that project's agent. */
  gone?: true
}

/** What an agent watch waits for: its agents, and whether background tasks the agent started still count as working. */
export interface AgentWatchCondition {
  agents: WatchedAgent[]
  /** True: the end of its turn is enough, also with background tasks still running (hive_wait_for_agents' ignoreBackground). */
  ignoreBackground: boolean
}

/** At most this many agents in one watch: a whole project's at the most (#562), and more, as the Assistant can watch several projects'. */
export const AGENT_WATCH_MAX_AGENTS = AGENT_LIMIT_MAX + 8

/** An agent as a watch reads it now (null runId: not running). */
export interface AgentNow {
  status: SessionStatus
  runId: string | null
  /** Prompts its CLI has taken in this launch. */
  prompts: number
  /** It was given a prompt its CLI hasn't taken yet (typed by Hive, or its launch's task, #712): it counts as working. */
  pending: boolean
  statusMessage?: string | null
  backgroundTasks?: number
  /** The start of its latest reply (its last turn's end). */
  reply?: string | null
  /** A watching agent's own watch ("Waiting for #12 → Review"). */
  watch?: string | null
}

/**
 * An agent as the watch began: what "it didn't take the prompt" is measured from, and `seq`, the latest of its events
 * (main/watches.ts) the watcher already knows: one after it is news.
 */
export interface AgentMark {
  runId: string | null
  prompts: number
  pending: boolean
  seq: number
}

export const agentMarkOf = (now: AgentNow, seq: number): AgentMark => ({ runId: now.runId, prompts: now.prompts, pending: now.pending, seq })

/** What happened to a watched agent: its turn ended, it waits for the user, it stopped, or it is in error. */
export type AgentEvent = 'finished' | 'untaken' | 'waiting' | 'stopped' | 'error'

/** Whether an agent counts as working: a watch waits on it (as hive_wait_for_agents does without wake). */
export function agentBusy(now: AgentNow, ignoreBackground: boolean): boolean {
  return now.pending || now.status === 'working' || now.status === 'starting' || (now.status === 'background' && !ignoreBackground)
}

/** What an agent no longer working did (null: still working). */
export function agentEvent(now: AgentNow, mark: AgentMark | undefined, ignoreBackground: boolean): AgentEvent | null {
  if (agentBusy(now, ignoreBackground)) return null
  switch (now.status) {
    case 'stopped':
      return 'stopped'
    case 'error':
      return 'error'
    case 'waiting':
    case 'signin':
      return 'waiting'
    default:
      // Idle without having taken the prompt it was given when the watch began (its CLI dropped it).
      return mark?.pending && mark.runId === now.runId && now.prompts <= mark.prompts ? 'untaken' : 'finished'
  }
}

/** A saved condition, checked (null: not one Hive would have made). */
export function readSavedAgentCondition(v: unknown): AgentWatchCondition | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (!Array.isArray(r.agents) || !r.agents.length || r.agents.length > AGENT_WATCH_MAX_AGENTS || typeof r.ignoreBackground !== 'boolean') return null
  const text = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max
  const agents: WatchedAgent[] = []
  for (const a of r.agents as Record<string, unknown>[]) {
    if (!a || typeof a !== 'object' || !text(a.projectPath, 1024) || !text(a.agentId, 128) || !text(a.name, 300) || !text(a.project, 300)) return null
    if (agents.some((x) => x.projectPath.toLowerCase() === (a.projectPath as string).toLowerCase() && x.agentId === a.agentId)) return null
    agents.push({ projectPath: a.projectPath, agentId: a.agentId, name: a.name, project: a.project, ...(isProjectId(a.projectId) ? { projectId: a.projectId } : {}), ...(a.gone === true ? { gone: true as const } : {}) })
  }
  return { agents, ignoreBackground: r.ignoreBackground }
}

export function readSavedAgentMark(v: unknown): AgentMark | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const m = v as Record<string, unknown>
  const count = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0
  if (!(m.runId === null || (typeof m.runId === 'string' && m.runId.length <= 128)) || !count(m.prompts) || typeof m.pending !== 'boolean' || !count(m.seq)) return null
  return { runId: m.runId, prompts: m.prompts, pending: m.pending, seq: m.seq }
}

const names = (agents: Pick<WatchedAgent, 'name'>[]): string => agents.map((a) => a.name).join(', ')

/** What a watching agent shows: "Waiting for B6 to finish". */
export const agentWatchLabel = (cond: AgentWatchCondition): string => `Waiting for ${names(cond.agents)} to finish` // i18n-ignore: agent-facing: what a watching agent reads (its wake line, hive_agent_activity)

/**
 * A watch as the window shows it (#799), in the user's language, from its fields: "Waiting for B6 to finish", "Waiting
 * for #12 → Review", "Waiting on lane l-1 and #4". Its `label` is the English agents and the Agent API read.
 */
export function watchText(w: Pick<TaskWatchInfo, 'cards' | 'column' | 'agents' | 'lanes'>, tr: Tr, list: (items: string[]) => string, form: 'line' | 'cell' = 'line'): string {
  const cards = w.cards.map((n) => `${cardRef(n)}`).join(', ')
  // A lane watch's cards and agents beside its lanes (HI-1987) go in its {cards}, as they are listed after the lanes.
  // A lane watch's cell says it whole ("Waiting on all running lanes"), as its English label does.
  if (form === 'cell' && !w.lanes?.length) return watchCell(w, cards, tr, list)
  if (w.agents?.length && !w.lanes?.length) return tr(msg({ id: 'panes.watch.agents', defaultMessage: 'Waiting for {agents} to finish', description: "A watching agent's status (its pane): it waits for these agents ({agents}: their names, listed) to finish their turns." }), { agents: list(w.agents) })
  if (w.lanes?.length) {
    const lanes = w.lanes[0] === 'all' ? 'all' : w.lanes.length === 1 ? 'one' : 'some'
    return tr(msg({ id: 'panes.watch.lanes', defaultMessage: 'Waiting on {lanes, select, all {all running lanes} one {lane {lane}} other {{n, plural, one {# lane} other {# lanes}}}}{cards, select, none {} other { and {cards}}}', description: "A watching agent's status (its pane): it waits on card loops (lanes): all of them, one ({lane}: its id) or {n}; then any cards it also watches ({cards}: \"#4, #5\"; none: leave that branch empty)." }), { lanes, lane: w.lanes[0], n: w.lanes.length, cards: [cards, ...(w.agents ?? [])].filter(Boolean).join(', ') || 'none' })
  }
  if (w.column) return tr(msg({ id: 'panes.watch.cardsInto', defaultMessage: 'Waiting for {cards} → {column}', description: "A watching agent's status (its pane): it waits for cards ({cards}: \"#12, #13\") to move into a board column ({column})." }), { cards, column: columnName(w.column, tr) })
  return tr(msg({ id: 'panes.watch.cards', defaultMessage: 'Waiting for {cards}', description: "A watching agent's status (its pane): it waits for these cards ({cards}: \"#12, #13\") to change." }), { cards })
}

/** A card or agent watch in an agents table's "Waiting for" cell: what watchText says, after its "Waiting for". */
function watchCell(w: Pick<TaskWatchInfo, 'cards' | 'column' | 'agents' | 'lanes'>, cards: string, tr: Tr, list: (items: string[]) => string): string {
  if (w.agents?.length) return tr(msg({ id: 'panes.watchCell.agents', defaultMessage: '{agents} to finish', description: "An agents table's Waiting for column: the agents a watching agent waits for ({agents}: their names, listed) to finish their turns." }), { agents: list(w.agents) })
  if (w.column) return tr(msg({ id: 'panes.watchCell.cardsInto', defaultMessage: '{cards} → {column}', description: "An agents table's Waiting for column: the cards a watching agent waits for ({cards}: \"#12, #13\") to move into a board column ({column})." }), { cards, column: columnName(w.column, tr) })
  return cards
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const clipChars = (text: string, max: number): string => {
  const chars = [...oneLine(text)]
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : chars.join('')
}
const jsonBytes = (s: string): number => new TextEncoder().encode(JSON.stringify(s)).length

/**
 * One agent and what it did, its latest reply (or what it asks) cut to `max` characters (0: left out). `already`: its
 * state now, for an answer at once; `again`: it did so, and is working again since.
 */
export function agentPart(a: Pick<WatchedAgent, 'name' | 'project'>, ev: AgentEvent, now: AgentNow, max = 200, already = false, again = false): string {
  return again ? `${partOf(a, ev, now, max, already)} (working again now)` : partOf(a, ev, now, max, already) // i18n-ignore: agent-facing: what a watching agent reads (its wake line, hive_agent_activity)
}

function partOf(a: Pick<WatchedAgent, 'name' | 'project'>, ev: AgentEvent, now: AgentNow, max: number, already: boolean): string {
  const who = `${a.name} (${a.project})`
  const quote = (t: string | null | undefined): string => (t && max > 0 ? `: "${clipChars(t, max)}"` : '')
  switch (ev) {
    case 'stopped':
      return `${who} ${already ? 'is stopped' : 'stopped'}` // i18n-ignore: agent-facing: what a watching agent reads (its wake line, hive_agent_activity)
    case 'error':
      return `${who} is in error${quote(now.statusMessage)}` // i18n-ignore: agent-facing: what a watching agent reads (its wake line, hive_agent_activity)
    case 'waiting':
      return now.status === 'signin' ? `${who} is waiting for the user to sign in to its CLI again` : `${who} is waiting for the user${quote(now.statusMessage)}` // i18n-ignore: agent-facing: what a watching agent reads (its wake line, hive_agent_activity)
    case 'untaken':
      return `${who} is idle: its CLI hasn't taken the prompt it was given` // i18n-ignore: agent-facing: what a watching agent reads (its wake line, hive_agent_activity)
    case 'finished': {
      const n = now.backgroundTasks ?? 0
      const also = now.watch ? ` (${now.watch.replace(/^Waiting/, 'now waiting')})` : n ? ` (${n} background task${n === 1 ? '' : 's'} still running)` : '' // i18n-ignore: agent-facing: what a watching agent reads (its wake line, hive_agent_activity)
      return `${who} ${already ? 'is idle' : 'finished'}${also}${quote(now.reply)}` // i18n-ignore: agent-facing: what a watching agent reads (its wake line, hive_agent_activity)
    }
  }
}

/** The first line of what the user sent an agent from its pane (#418), as watches keep it. */
export const REPLY_CHARS = 120
export const replyFirstLine = (text: string): string => clipChars(text.split('\n').map((l) => l.trim()).find(Boolean) ?? '', REPLY_CHARS)

/** The user's reply to an agent, for a wake line (#418): "User replied to B1 on #399: "C, the hive cell"", by its name (#426). */
export function replyPart(agentName: string, where: string, text: string, max = REPLY_CHARS, user = DEFAULT_USER_NAME): string {
  return `${user} replied to ${agentName}${where ? ` ${where}` : ''}${max > 0 ? `: "${clipChars(text, max)}"` : ''}` // i18n-ignore: agent-facing: what a watching agent reads (its wake line, hive_agent_activity)
}

/**
 * The one line Hive types to wake a watcher (#416): each agent that changed and what it did, with the start of its
 * latest reply, then what to do; and what the user sent it from its pane since, for the Assistant (#418). One line within
 * WAKE_MAX_BYTES: replies give way first, then they are left out. `user`: the user's name (userNameOf, #426).
 */
export function agentWakeLine(changes: { agent: WatchedAgent; event: AgentEvent | null; now: AgentNow; again?: boolean; reply?: string }[], user = DEFAULT_USER_NAME): string {
  const tail = '. Your agent watch has ended: carry on (hive_agent_activity for more).'
  const one = (c: (typeof changes)[number], max: number): string =>
    [c.reply !== undefined ? replyPart(c.agent.name, `(${c.agent.project})`, c.reply, Math.min(max, REPLY_CHARS), user) : '', c.event ? agentPart(c.agent, c.event, c.now, max, false, c.again) : ''].filter(Boolean).join('; ')
  const full = (max: number): string => `[Hive] ${changes.map((c) => one(c, max)).join('; ')}${tail}`
  for (const max of [300, 160, 80, 40, 0]) if (jsonBytes(full(max)) <= WAKE_MAX_BYTES) return full(max)
  // Too many for that: who replied to whom and who changed, by name, else by count; the user's replies stay replies.
  const replied = changes.filter((c) => c.reply !== undefined).map((c) => c.agent)
  const changed = changes.filter((c) => c.event).map((c) => c.agent)
  const counted = (agents: WatchedAgent[]): string => `${agents.length} watched agent${agents.length === 1 ? '' : 's'}` // i18n-ignore: agent-facing: what a watching agent reads (its wake line, hive_agent_activity)
  const brief = (who: (agents: WatchedAgent[]) => string): string => `[Hive] ${[replied.length ? `${user} replied to ${who(replied)}` : '', changed.length ? `${who(changed)} changed` : ''].filter(Boolean).join('; ')}${tail}`
  const short = brief(names)
  return jsonBytes(short) <= WAKE_MAX_BYTES ? short : brief(counted)
}

/** The line Hive types when an agent watch's limit passes with every agent still working. */
export function agentLimitLine(cond: AgentWatchCondition, minutes: number): string {
  const one = cond.agents.length === 1
  const dur = minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10} h` : `${minutes} min`
  return `[Hive] ${names(cond.agents)} ${one ? 'is' : 'are'} still working after ${dur}: your agent watch has ended. Check on ${one ? 'it' : 'them'} (hive_agent_activity) and watch again, or tell the user (hive_notify) if ${one ? 'it seems' : 'one seems'} stuck.` // i18n-ignore: agent-facing: what a watching agent reads (its wake line, hive_agent_activity)
}
