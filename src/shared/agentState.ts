import { asksYou } from './inbox'
import { msg, tr, type Msg } from './i18n'
import type { AgentInfo, LiveSessionState, ProjectInfo, TaskCard } from './types'

/**
 * An agent's state as the session page marks it (#973, 0.9.0): four states, each drawn with its own shape as well
 * as its colour (StateMark), so they read apart without colour. Projected from what Combwork already knows (the status
 * word, a question, a stall, a card blocked on the user); it detects nothing of its own.
 * - waiting: waiting for you (a permission prompt, a question, a sign-in, a card blocked on you): a diamond;
 * - stalled: nothing will move it on (its CLI failed, or failed to start, its turn has been silent with its state
 *   unknown, its hooks aren't arriving, or it left the cards it loops on unwatched): a square;
 * - working: a turn, its start, a compaction or background tasks running: a pulsing dot;
 * - idle: ready, finished, watching cards, stopped or no session: a ring.
 */
export type AgentState = 'waiting' | 'stalled' | 'working' | 'idle'

/** Most urgent first: how marks are sorted, and which one stands for several (a summary). */
export const AGENT_STATES: readonly AgentState[] = ['waiting', 'stalled', 'working', 'idle']

/** What the board knows of the agent's cards, where the caller has them. */
export interface AgentStateExtras {
  /** A card it holds is blocked on the user. */
  blocked?: boolean
  /** A card it holds or reviews is stalled (the board's stalledReason). */
  stalled?: boolean
  /** Its last launch failed to start and it hasn't started since (the window's start failures, #975). */
  failedToStart?: boolean
}

type StateFields = Pick<LiveSessionState, 'status' | 'question' | 'turn' | 'notWatching'> & Partial<Pick<LiveSessionState, 'hooksMissing'>>

/** The state an agent's mark shows; no session at all is idle. */
export function agentState(live: StateFields | null | undefined, extras: AgentStateExtras = {}): AgentState {
  if (asksYou(live) || extras.blocked) return 'waiting'
  if (extras.stalled || (extras.failedToStart && !live)) return 'stalled'
  if (!live) return 'idle'
  if (live.status === 'error' || live.turn?.state === 'unknown' || live.hooksMissing || (live.notWatching?.length ?? 0) > 0) return 'stalled'
  if (live.status === 'working' || live.status === 'starting' || live.status === 'background') return 'working'
  return 'idle'
}

/**
 * What the board says of an agent: a card it has in Doing or Review blocked on the user, or one in Doing while it isn't
 * running (the board's stalledReason for an agent still there): one whose start is under way isn't (HI-1977).
 */
export function boardExtras(projectName: string, agent: Pick<AgentInfo, 'id' | 'live' | 'start'>, cards: readonly Pick<TaskCard, 'project' | 'agent' | 'column' | 'blocked' | 'archived'>[]): AgentStateExtras {
  const name = projectName.toLowerCase()
  const mine = cards.filter((c) => !c.archived && c.agent === agent.id && c.project.toLowerCase() === name && (c.column === 'doing' || c.column === 'review'))
  return { blocked: mine.some((c) => !!c.blocked), stalled: !agent.live && !(agent.start && 'starting' in agent.start) && mine.some((c) => c.column === 'doing') }
}

/**
 * Each of a project's agents' states, in the project's order, with what the board says of them and, where the caller
 * knows (the window does), whether its last launch failed to start.
 */
export function projectAgentStates(project: Pick<ProjectInfo, 'name' | 'agents'>, cards: readonly Pick<TaskCard, 'project' | 'agent' | 'column' | 'blocked' | 'archived'>[], failedToStart: (agentId: string) => boolean = () => false): AgentState[] {
  return project.agents.map((a) => agentState(a.live, { ...boardExtras(project.name, a, cards), failedToStart: failedToStart(a.id) }))
}

/** Each state's name, one for every place a mark is shown (its accessible name, a legend, a summary's tooltip). */
export const AGENT_STATE_LABEL: Record<AgentState, Msg> = {
  waiting: msg({ id: 'session.state.waiting', defaultMessage: 'Waiting for you', description: "An agent's state, shown as a diamond: it asks you something (a permission, a question, a sign-in) or a card it has is blocked on you." }),
  stalled: msg({ id: 'session.state.stalled', defaultMessage: 'Stalled', description: "An agent's state, shown as a square: nothing will move it on by itself (its coding agent failed, it has gone silent, or it stopped watching its cards)." }),
  working: msg({ id: 'session.state.working', defaultMessage: 'Working', description: "An agent's state, shown as a pulsing dot: it is working (a turn, starting, or background tasks)." }),
  idle: msg({ id: 'session.state.idle', defaultMessage: 'Idle', description: "An agent's state, shown as a ring: ready, finished, waiting on cards, or stopped." })
}

/** How many agents are in each state. */
export function stateCounts(states: Iterable<AgentState>): Record<AgentState, number> {
  const n: Record<AgentState, number> = { waiting: 0, stalled: 0, working: 0, idle: 0 }
  for (const s of states) n[s]++
  return n
}

/** The most urgent of several states (a summary's mark); idle when there are none. */
export function mostUrgent(states: Iterable<AgentState>): AgentState {
  const n = stateCounts(states)
  return AGENT_STATES.find((s) => n[s] > 0) ?? 'idle'
}

/** A count of agents in a state, for a summary ("2 working"). */
const STATE_COUNT: Record<AgentState, Msg> = {
  waiting: msg({ id: 'session.state.countWaiting', defaultMessage: '{n, plural, other {# waiting}}', description: 'How many agents wait for you, in a summary of the agents of a project ("1 waiting · 2 working"). {n} is how many.' }),
  stalled: msg({ id: 'session.state.countStalled', defaultMessage: '{n, plural, other {# stalled}}', description: 'How many agents are stalled, in a summary of the agents of a project ("1 stalled · 2 working"). {n} is how many.' }),
  working: msg({ id: 'session.state.countWorking', defaultMessage: '{n, plural, other {# working}}', description: 'How many agents are working, in a summary of the agents of a project ("1 waiting · 2 working"). {n} is how many.' }),
  idle: msg({ id: 'session.state.countIdle', defaultMessage: '{n, plural, other {# idle}}', description: 'How many agents are idle, in a summary of the agents of a project ("2 working · 3 idle"). {n} is how many.' })
}

/** How many agents have no session running, in the project header's summary. */
const STOPPED_COUNT = msg({ id: 'session.state.countStopped', defaultMessage: '{n, plural, other {# stopped}}', description: "How many agents have no session running, last in the project header's summary of its agents (\"3 working · 7 idle · 2 stopped\"). {n} is how many." })

/**
 * Agents' states in one line, most urgent first: "1 waiting · 2 working". Idle agents are left out unless `idle` is
 * set or every agent is idle; '' for none.
 */
export function stateSummary(states: Iterable<AgentState>, idle = false): string {
  const n = stateCounts(states)
  const busy = n.waiting + n.stalled + n.working > 0
  return AGENT_STATES.filter((s) => n[s] > 0 && (s !== 'idle' || idle || !busy))
    .map((s) => tr(STATE_COUNT[s], { n: n[s] }))
    .join(' · ')
}

/**
 * The project header's summary of its agents (#1035): as the session toolbar's chip, but the idle agents with no session
 * running are counted apart, last ("3 working · 7 idle · 2 stopped"), so the working and idle ones are those Stop
 * counts. `states` are the agents' states, in the same order.
 */
export function projectStateSummary(agents: readonly Pick<AgentInfo, 'live'>[], states: readonly AgentState[]): string {
  const stopped = (s: AgentState, i: number): boolean => s === 'idle' && !agents[i]?.live
  const n = states.filter(stopped).length
  return [stateSummary(states.filter((s, i) => !stopped(s, i)), true), n ? tr(STOPPED_COUNT, { n }) : ''].filter(Boolean).join(' · ')
}

/**
 * Whether every agent shown is stopped (idle, with no session running; HI-1908): its summary's mark is then the stopped
 * one, grey, as its pane's and tile's marks are (HI-1881). Presentation only: the states stay as they are.
 */
export function allStopped(agents: readonly Pick<AgentInfo, 'live'>[], states: readonly AgentState[]): boolean {
  return states.length > 0 && states.every((s, i) => s === 'idle' && !agents[i]?.live)
}

/**
 * The project header's summary at its narrowest (#1051): only its most urgent count ("1 waiting"; "2 stopped" when no
 * agent runs), the rest in its tooltip.
 */
export function projectStateShort(agents: readonly Pick<AgentInfo, 'live'>[], states: readonly AgentState[]): string {
  const stopped = (s: AgentState, i: number): boolean => s === 'idle' && !agents[i]?.live
  const running = states.filter((s, i) => !stopped(s, i))
  if (!running.length) return states.length ? tr(STOPPED_COUNT, { n: states.length }) : ''
  const top = mostUrgent(running)
  return tr(STATE_COUNT[top], { n: running.filter((s) => s === top).length })
}
