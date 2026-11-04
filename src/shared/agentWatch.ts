/**
 * Waiting on agents (#416): an agent watch (cw_wait_for_agents with wake) follows agents, not cards, through the same
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
import { agentMsg, say } from './agentText'
import { NOTICE_PREFIX } from './doorbell'
import { laneTitleArgs } from './laneWatch'

const T = {
  label: agentMsg({ id: 'wake.agent.label', text: 'Waiting for {agents} to finish', note: 'An agent watch\'s label (#416): a watching agent\'s status, what cw_agent_activity and the Agent API read. agents: the names, ", " between.' }),
  again: agentMsg({ id: 'wake.agent.again', text: '{what} (working again now)', note: 'An agent watch wake: a watched agent did something (what: that part), and is working again since.' }),
  stopped: agentMsg({ id: 'wake.agent.stopped', text: '{name} ({project}) {already, select, yes {is stopped} other {stopped}}', note: 'An agent watch wake: a watched agent stopped. already: yes when it was stopped as the watch began (an answer at once).' }),
  error: agentMsg({ id: 'wake.agent.error', text: '{name} ({project}) is in error{quote}', note: 'An agent watch wake: a watched agent is in error. quote: its status message, quoted after a colon, or nothing.' }),
  signin: agentMsg({ id: 'wake.agent.signin', text: '{name} ({project}) is waiting for the user to sign in to its CLI again', note: "An agent watch wake: a watched agent's CLI waits for the user to sign in again." }),
  waiting: agentMsg({ id: 'wake.agent.waiting', text: '{name} ({project}) is waiting for the user{quote}', note: 'An agent watch wake: a watched agent waits for the user. quote: what it asks, quoted after a colon, or nothing.' }),
  untaken: agentMsg({ id: 'wake.agent.untaken', text: "{name} ({project}) is idle: its CLI hasn't taken the prompt it was given", note: 'An agent watch wake (#712): a watched agent is idle without having taken the prompt it was given (its CLI dropped it).' }),
  finished: agentMsg({
    id: 'wake.agent.idle',
    text: '{name} ({project}) {already, select, yes {is idle} other {finished}}{also, select, watch { ({watch})} background { ({n, plural, one {{n} background task} other {{n} background tasks}} still running)} other {}}{quote}',
    note: 'An agent watch wake: a watched agent\'s turn ended. already: yes when it was idle as the watch began; also: watch (it now watches: watch is its watch\'s label, "now waiting for HI-12 → Review"), background (n background tasks still run) or none; quote: the start of its reply, quoted after a colon, or nothing.'
  }),
  nowWaiting: agentMsg({ id: 'wake.agent.nowWaiting', text: 'now waiting', note: 'Put in place of the "Waiting" a watching agent\'s watch label starts with, in an agent watch wake: "B6 (alpha) finished (now waiting for HI-12 → Review)".' }),
  replied: agentMsg({ id: 'wake.agent.replied', text: '{user} replied to {agent}{where}{quote}', note: 'A wake (#418): what the user sent an agent from its pane. user: the user\'s name (#426); agent: its name; where: " (alpha)", its project, or nothing; quote: the reply\'s start, quoted after a colon, or nothing.' }),
  line: agentMsg({ id: 'wake.agent.line', text: '{changes}. Your agent watch has ended: carry on (cw_agent_activity for more).', note: 'An agent watch wake (#416): what each watched agent did ("; " between), then what to do.' }),
  repliedTo: agentMsg({ id: 'wake.agent.repliedTo', text: '{user} replied to {agents}', note: 'An agent watch wake too long to tell in full: the user (user: their name) replied to these agents (by name, else counted).' }),
  changed: agentMsg({ id: 'wake.agent.changed', text: '{agents} changed', note: 'An agent watch wake too long to tell in full: these agents changed (by name, else counted).' }),
  counted: agentMsg({ id: 'wake.agent.counted', text: '{n, plural, one {{n} watched agent} other {{n} watched agents}}', note: 'An agent watch wake too long to name the agents: how many.' }),
  limit: agentMsg({
    id: 'wake.agent.limit',
    text: '{agents} {n, plural, one {is} other {are}} still working after {hours, select, yes {{time} h} other {{time} min}}: your agent watch has ended. Check on {n, plural, one {it} other {them}} (cw_agent_activity) and watch again, or tell the user (cw_notify) if {n, plural, one {it seems} other {one seems}} stuck.',
    note: 'Typed when an agent watch\'s limit passes with every agent still working. agents: their names, ", " between; n: how many; hours: yes when time is in hours ("1.5"), else minutes.'
  })
}

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
  /** True: the end of its turn is enough, also with background tasks still running (cw_wait_for_agents' ignoreBackground). */
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

/** Whether an agent counts as working: a watch waits on it (as cw_wait_for_agents does without wake). */
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
export const agentWatchLabel = (cond: AgentWatchCondition): string => say(T.label, { agents: names(cond.agents) })

/**
 * A watch as the window shows it (#799), in the user's language, from its fields: "Waiting for B6 to finish", "Waiting
 * for #12 → Review", "Waiting on lane l-1 and #4". Its `label` is the English agents and the Agent API read.
 */
export function watchText(w: Pick<TaskWatchInfo, 'cards' | 'column' | 'agents' | 'lanes' | 'laneTitles'>, tr: Tr, list: (items: string[]) => string, form: 'line' | 'cell' = 'line'): string {
  const cards = w.cards.map((n) => `${cardRef(n)}`).join(', ')
  // A lane watch's cards and agents beside its lanes (HI-1987) go in its {cards}, as they are listed after the lanes.
  // A lane watch's cell says it whole ("Waiting on all running lanes"), as its English label does.
  if (form === 'cell' && !w.lanes?.length) return watchCell(w, cards, tr, list)
  if (w.agents?.length && !w.lanes?.length) return tr(msg({ id: 'panes.watch.agents', defaultMessage: 'Waiting for {agents} to finish', description: "A watching agent's status (its pane): it waits for these agents ({agents}: their names, listed) to finish their turns." }), { agents: list(w.agents) })
  if (w.lanes?.length) {
    const lanes = w.lanes[0] === 'all' ? 'all' : w.lanes.length === 1 ? 'one' : 'some'
    // HI-2522: one lane by its name ("lane combwork screenshots"), never its lane-… id, which read as a commit id.
    const lane = lanes === 'one' ? tr(msg({ id: 'panes.watch.oneLane', defaultMessage: "{kind, select, named {lane {name}} both {{builder}'s lane {name}} builder {{builder}'s lane} other {a lane}}", description: "One card loop (lane) a watching agent waits on, in its status (panes.watch.lanes's {lane}). kind: named ({name}: the lane's name), both (another lane has that name, so its builder's name {builder} is said too), builder (the lane has no name: {builder}'s lane), other (a lane no longer known, from an older version: just \"a lane\")." }), laneTitleArgs(w.lanes[0], w.laneTitles?.[w.lanes[0]])) : ''
    return tr(msg({ id: 'panes.watch.lanes', defaultMessage: 'Waiting on {lanes, select, all {all running lanes} one {{lane}} other {{n, plural, one {# lane} other {# lanes}}}}{cards, select, none {} other { and {cards}}}', description: "A watching agent's status (its pane): it waits on card loops (lanes): all of them, one ({lane}: the lane as panes.watch.oneLane names it, \"lane combwork screenshots\") or {n}; then any cards it also watches ({cards}: \"#4, #5\"; none: leave that branch empty)." }), { lanes, lane, n: w.lanes.length, cards: [cards, ...(w.agents ?? [])].filter(Boolean).join(', ') || 'none' })
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
  return again ? say(T.again, { what: partOf(a, ev, now, max, already) }) : partOf(a, ev, now, max, already)
}

function partOf(a: Pick<WatchedAgent, 'name' | 'project'>, ev: AgentEvent, now: AgentNow, max: number, already: boolean): string {
  const who = { name: a.name, project: a.project }
  const quote = (t: string | null | undefined): string => (t && max > 0 ? `: "${clipChars(t, max)}"` : '')
  switch (ev) {
    case 'stopped':
      return say(T.stopped, { ...who, already: already ? 'yes' : 'no' })
    case 'error':
      return say(T.error, { ...who, quote: quote(now.statusMessage) })
    case 'waiting':
      return now.status === 'signin' ? say(T.signin, who) : say(T.waiting, { ...who, quote: quote(now.statusMessage) })
    case 'untaken':
      return say(T.untaken, who)
    case 'finished': {
      const n = now.backgroundTasks ?? 0
      // A watching agent's own watch label, which starts "Waiting" (wake.lane.label, wake.agent.label, a card watch's).
      const watch = now.watch ? now.watch.replace(/^Waiting/, () => say(T.nowWaiting)) : ''
      return say(T.finished, { ...who, already: already ? 'yes' : 'no', also: now.watch ? 'watch' : n ? 'background' : 'none', watch, n, quote: quote(now.reply) })
    }
  }
}

/** The first line of what the user sent an agent from its pane (#418), as watches keep it. */
export const REPLY_CHARS = 120
export const replyFirstLine = (text: string): string => clipChars(text.split('\n').map((l) => l.trim()).find(Boolean) ?? '', REPLY_CHARS)

/** The user's reply to an agent, for a wake line (#418): "User replied to B1 on #399: "C, the hive cell"", by its name (#426). */
export function replyPart(agentName: string, where: string, text: string, max = REPLY_CHARS, user = DEFAULT_USER_NAME): string {
  return say(T.replied, { user, agent: agentName, where: where ? ` ${where}` : '', quote: max > 0 ? `: "${clipChars(text, max)}"` : '' })
}

/**
 * The one line Hive types to wake a watcher (#416): each agent that changed and what it did, with the start of its
 * latest reply, then what to do; and what the user sent it from its pane since, for the Assistant (#418). One line within
 * WAKE_MAX_BYTES: replies give way first, then they are left out. `user`: the user's name (userNameOf, #426).
 */
export function agentWakeLine(changes: { agent: WatchedAgent; event: AgentEvent | null; now: AgentNow; again?: boolean; reply?: string }[], user = DEFAULT_USER_NAME): string {
  const one = (c: (typeof changes)[number], max: number): string =>
    [c.reply !== undefined ? replyPart(c.agent.name, `(${c.agent.project})`, c.reply, Math.min(max, REPLY_CHARS), user) : '', c.event ? agentPart(c.agent, c.event, c.now, max, false, c.again) : ''].filter(Boolean).join('; ')
  const full = (max: number): string => NOTICE_PREFIX + say(T.line, { changes: changes.map((c) => one(c, max)).join('; ') })
  for (const max of [300, 160, 80, 40, 0]) if (jsonBytes(full(max)) <= WAKE_MAX_BYTES) return full(max)
  // Too many for that: who replied to whom and who changed, by name, else by count; the user's replies stay replies.
  const replied = changes.filter((c) => c.reply !== undefined).map((c) => c.agent)
  const changed = changes.filter((c) => c.event).map((c) => c.agent)
  const counted = (agents: WatchedAgent[]): string => say(T.counted, { n: agents.length })
  const brief = (who: (agents: WatchedAgent[]) => string): string => NOTICE_PREFIX + say(T.line, { changes: [replied.length ? say(T.repliedTo, { user, agents: who(replied) }) : '', changed.length ? say(T.changed, { agents: who(changed) }) : ''].filter(Boolean).join('; ') })
  const short = brief(names)
  return jsonBytes(short) <= WAKE_MAX_BYTES ? short : brief(counted)
}

/** The line Hive types when an agent watch's limit passes with every agent still working. */
export function agentLimitLine(cond: AgentWatchCondition, minutes: number): string {
  const hours = minutes >= 60
  return NOTICE_PREFIX + say(T.limit, { agents: names(cond.agents), n: cond.agents.length, hours: hours ? 'yes' : 'no', time: String(hours ? Math.round((minutes / 60) * 10) / 10 : minutes) })
}
