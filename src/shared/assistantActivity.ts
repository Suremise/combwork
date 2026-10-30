import { TASK_COLUMNS } from './tasks'

/**
 * What each Hive Assistant action is about, as fields (#763): its kind, from a fixed set, and its targets (project,
 * agent, card or cards, lane, column, setting), so a viewer such as Apiary follows the Assistant without reading its
 * English line, which is for people and will be translated. Never what it quotes: no prompt or message text, no
 * setting's values. The Agent API's assistant-activity event carries them through activityFields' allow-list.
 */

/** Every kind an action can have, in the order AGENT_API.md lists them. A refusal is ok: false with the kind it tried. */
export const ACTIVITY_KINDS = [
  'start-task',
  'prompt-agent',
  'message-agent',
  'cancel-messages',
  'start-agent',
  'stop-agent',
  'add-agent',
  'update-agent',
  'hand-over',
  'create-task',
  'update-task',
  'update-tasks',
  'reorder-tasks',
  'comment-task',
  'lane-start',
  'lane-join',
  'lane-end',
  'lane-fresh-start',
  'queue-pause',
  'queue-resume',
  'team-pause',
  'team-resume',
  'release-slot',
  'load-template',
  'add-connection',
  'update-connection',
  'create-project',
  'activate-project',
  'deactivate-project',
  'setting',
  'revert-setting',
  'undo'
] as const

export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

/** An agent an action is about: its id and name. */
export interface ActivityAgent {
  id: string
  name: string
}

/** An action's kind and targets: each target only where it applies. */
export interface ActivityTarget {
  kind: ActivityKind
  /** The project, by name. */
  project?: string
  /** The agent it acts on (a hand-over's from). */
  agent?: ActivityAgent
  /** A hand-over's to. */
  toAgent?: ActivityAgent
  /** One card, by number. */
  card?: number
  /** A batch's or a lane's cards, or the cards put in order, by number. */
  cards?: number[]
  /** A lane's id. */
  lane?: string
  /** The column a card moved to, or the cards were put in order in. */
  column?: string
  /** A setting's id in the settings catalog (hive_list_settings), never its value. */
  settingId?: string
  /** A connection's id (HI-2108: hive_connection), never its values. */
  connection?: string
}

/**
 * What a refusal's or failure's public `error` says (#763): Hive's own words for the kind of refusal, from the status it
 * answered with, never the error's text, which can quote what the Assistant sent (a setting's value, a prompt). Its
 * panel keeps the whole message.
 */
export function publicReason(status: number | undefined): string {
  if (status === 400) return 'The request was invalid'
  if (status === 403) return 'Not allowed'
  if (status === 404) return 'Not found'
  if (status === 409) return 'Not possible now'
  return 'Failed'
}

const isAgent = (v: unknown): v is ActivityAgent => !!v && typeof v === 'object' && typeof (v as ActivityAgent).id === 'string' && typeof (v as ActivityAgent).name === 'string'
const isCard = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0
/** A project's name as a folder can have it: what the Assistant asked for (a project to create) only if it is one. */
const isProject = (v: unknown): v is string => typeof v === 'string' && /^[^\\/:*?"<>|\x00-\x1f]{1,100}$/.test(v) && v !== '.' && v !== '..'
const isLane = (v: unknown): v is string => typeof v === 'string' && /^[\w.-]{1,64}$/.test(v)
const isColumn = (v: unknown): v is string => typeof v === 'string' && TASK_COLUMNS.some((c) => c.id === v)
const isSetting = (v: unknown): v is string => typeof v === 'string' && /^[\w.:-]{1,120}$/.test(v)

/** An action's fields as the event stream sends them: only these, each only when well formed (never free text). */
export function activityFields(a: Partial<ActivityTarget>): Partial<ActivityTarget> {
  if (!a.kind || !(ACTIVITY_KINDS as readonly string[]).includes(a.kind)) return {}
  return {
    kind: a.kind,
    ...(isProject(a.project) ? { project: a.project } : {}),
    ...(isAgent(a.agent) ? { agent: { id: a.agent.id, name: a.agent.name } } : {}),
    ...(isAgent(a.toAgent) ? { toAgent: { id: a.toAgent.id, name: a.toAgent.name } } : {}),
    ...(isCard(a.card) ? { card: a.card } : {}),
    ...(Array.isArray(a.cards) && a.cards.every(isCard) ? { cards: [...a.cards] } : {}),
    ...(isLane(a.lane) ? { lane: a.lane } : {}),
    ...(isColumn(a.column) ? { column: a.column } : {}),
    ...(isSetting(a.settingId) ? { settingId: a.settingId } : {}),
    ...(isSetting(a.connection) ? { connection: a.connection } : {})
  }
}

/**
 * Why a change of the Assistant's can't be undone, or what of it stays (#1282, SPEC §16.14): each reason's code and its
 * English, as the undo tool and the Agent API say it. The window says it in its language from the code (#1283), so a
 * change keeps the English it was recorded with and the window reads its codes back with finalWhys.
 */
export const UNDO_FINAL = {
  prompt: "A prompt that was sent can't be taken back.",
  message: "A message that was sent can't be taken back.",
  comment: "A comment stays: undo doesn't take back what was said.",
  handOver: "A hand-over can't be undone: the work went to the other agent.",
  projectMade: "A project it made stays: remove it from Hive if it isn't wanted.",
  projectOpened: "A project it opened stays open: close it if it isn't wanted.",
  projectClosed: 'A project it closed stays closed: open it again if it is wanted.',
  agentAdded: "An agent it added stays: remove it in the project's agents if it isn't wanted.",
  agentStopped: "An agent it stopped isn't started again by undo: start it if it should run.",
  cardsOrder: "The cards' order isn't put back.",
  withdrawn: "Messages it withdrew aren't sent again.",
  laneEnded: 'A lane that ended stays ended: start it again if it should go on.',
  laneReorderNow: "A card a lane reorder applied now put back stays in Todo: undo puts back only the lane's order.",
  decision: 'A decision it recorded stays: only the user changes or removes decisions.',
  cardPlace: "The card's place in its column isn't put back.",
  context: 'The doc sections to read first stay as set.',
  nothing: 'It changed nothing undo puts back.',
  start: "Its start stays in the card's work: undo moves the card back, it doesn't unstart it.",
  putBack: 'Its reason stays as a comment.',
  submit: "Its submission stays in the card's work.",
  declarePaths: 'The paths it declared stay with the card.',
  startReview: "The review it started stays in the card's work.",
  verdict: "Its verdict stays in the card's work, and its round with it.",
  reportMerge: "The merge it reported stays in the card's work.",
  ask: 'Its question stays under For you: answer or dismiss it there.',
  cannot: 'Its request stays under For you: answer or dismiss it there.',
  request: 'Its request to the builder stays as a comment.',
  removedFromQueue: "Taking it out of the merge queue stays in the card's work: it is queued again only by Retry merge or a new approval.",
  retriedMerge: "Its Retry merge stays in the card's work.",
  queuePaused: "A merge queue it paused stays paused: resume it if it should run.",
  queueResumed: "A merge queue it resumed isn't paused again: pause it if it shouldn't run.",
  teamPaused: 'A team it paused stays paused: resume it if it should go on.',
  teamResumed: "A team it resumed isn't paused again: pause it if it should wait.",
  freshRetried: "A lane agent's new conversation tried again isn't stopped by undo: end the lane if it isn't wanted.",
  slotReleased: "A slot it released isn't kept or held again: the next work that needs a slot may take it.",
  connectionMade: "A connection it made stays: remove it in Settings → Accounts & Connections if it isn't wanted.",
  connectionChanged: "A connection it changed isn't changed back: edit it in Settings → Accounts & Connections.",
  templateCards: "The cards and lanes of the agents a template replaced stay as the load left them (cards put back, lanes ended): undo doesn't give them back."
} as const

/** A reason a change of the Assistant's, or part of it, can't be undone (UNDO_FINAL's codes). */
export type UndoFinalWhy = keyof typeof UNDO_FINAL

/**
 * The reasons a change's recorded why gives (its sentences, joined), in their order: the codes the window words them by.
 */
export function finalWhys(text: string): UndoFinalWhy[] {
  const found: { at: number; why: UndoFinalWhy }[] = []
  for (const [why, english] of Object.entries(UNDO_FINAL) as [UndoFinalWhy, string][]) {
    const at = text.indexOf(english)
    if (at >= 0) found.push({ at, why })
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.why)
}
