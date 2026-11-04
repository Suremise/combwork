/**
 * Pausing the team before an update (HI-2081, SPEC §16.10.9): a workspace's hold on Hive's own automation (lane starts,
 * loop and watch wakes, the reviewer pool's hand-outs, the new conversations Hive starts by itself, the merge queue's
 * next entry), and what still runs before it is safe to install. hive-mcp.js and the window read it too: it imports only
 * the agent text module and the notices' prefix, which need no Node module.
 */
import { agentMsg, say } from './agentText'
import { NOTICE_PREFIX } from './doorbell'

/** A workspace's pause, held in memory by the running Hive (HI-2156): its epoch, since when, and who paused it. */
export interface TeamPause {
  pauseId: string
  since: string
  by: 'user' | 'assistant'
}

/** What still keeps an agent from being parked: busy (named), or can't be checked (named, never taken as parked). */
export type ParkedState = 'parked' | 'busy' | 'unknown'

/** One thing still running in a paused workspace, as the parked check names it. */
export interface ParkedItem {
  /** The project's folder name; '' for the Assistant. */
  project: string
  /** The agent's name, or 'Assistant'. */
  agent: string
  agentId: string
  state: Exclude<ParkedState, 'parked'>
  /** What it is, in English (agent-facing and logged): "working", "npm run e2e (Progress run, 4 min)". */
  what: string
  /** For the window: the user's own words it names (a run's title, a process's command, a slot's name), never Hive's. */
  label?: string
  /** What the window shows it as: a code and its values, worded there. */
  kind: 'working' | 'starting' | 'background' | 'run' | 'process' | 'writer' | 'merge' | 'copy' | 'status' | 'scan'
  /** A process the user may end (End it): its pid and its recorded start (a Windows FILETIME, as text), with its name. */
  process?: { pid: number; created: string; name: string }
  /** A Progress run the user may end: its id. */
  run?: string
  /** For a run or process: since when, ISO. */
  since?: string
}

/** A workspace's pause as the window and the tools see it: whether paused, and what still runs. */
export interface TeamPauseView {
  workspacePath: string
  pause: TeamPause | null
  /** Every agent parked, every scan read: safe to install as far as this workspace goes. */
  parked: boolean
  items: ParkedItem[]
  /** When the scan was made (ISO). */
  at: string
}

/** The app's view: each open workspace's, for the user (Install now needs every one paused and parked). */
export interface TeamPauseState {
  workspaces: TeamPauseView[]
  /** The user's pause of every open workspace: its id, while it lasts (a workspace opened meanwhile is held by it). */
  appPause: TeamPause | null
  /** Every open workspace paused and parked. */
  allParked: boolean
}

/** A lane held by its workspace's pause shows this (its LaneWaitReason). */
export const TEAM_PAUSE_REASON = 'teamPause' as const

const T = {
  pausing: agentMsg({
    id: 'notice.team.paused',
    text: 'The team is pausing for an update. Finish this turn, end the runs you started (tests, builds, dev servers, test copies of Combwork), commit your work, then end your turn. Until the team resumes Combwork starts no card and sends you no card events or watch wakes; a message or an answer can still reach you.',
    note: "HI-2081: the notice each running agent is given once per team pause, true to what the hold does (HR1's s8 check): no card starts or events, while a message or an answer still comes."
  })
}

/**
 * The line each running agent is given once per pause (its delivery's source `team-pause`, ref the pause's id): Hive's own
 * words, true to what the hold does (HR1's s8 check): no card starts or events, while a message or an answer still comes.
 * Said per agent, in its dialect (main/teamPause.ts sets the scope).
 */
export const teamPauseLine = (): string => NOTICE_PREFIX + say(T.pausing)

/** The delivery sources a pause holds (Hive's own wakes and hand-outs); the rest (messages, decisions, notices) still go. */
export const PAUSE_HELD_SOURCES: readonly string[] = ['loop', 'watch', 'pool-review']

/**
 * Whether a pause holds a delivery (HI-2081): one of Hive's own wakes or hand-outs, but never the user's answer to an
 * agent's question (a `loop` delivery of kind `answer`: their own act, which may be what the agent needs to park).
 */
export const pauseHolds = (r: { source?: string | null; kind: string }): boolean => !!r.source && PAUSE_HELD_SOURCES.includes(r.source) && !(r.source === 'loop' && r.kind === 'answer')
