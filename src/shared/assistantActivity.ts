import { agentMsg, inDefaultDialect, say, type AgentMsg } from './agentText'
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
  /** A setting's id in the settings catalog (cw_list_settings), never its value. */
  settingId?: string
  /** A connection's id (HI-2108: cw_connection), never its values. */
  connection?: string
}

/**
 * What a refusal's or failure's public `error` says (#763): Hive's own words for the kind of refusal, from the status it
 * answered with, never the error's text, which can quote what the Assistant sent (a setting's value, a prompt). Its
 * panel keeps the whole message.
 */
export function publicReason(status: number | undefined): string {
  const m = status === 400 ? REASON.invalid : status === 403 ? REASON.forbidden : status === 404 ? REASON.notFound : status === 409 ? REASON.conflict : REASON.failed
  // Stored with the action and read by any viewer of the event stream: the Default's words (dialects, HI-2065).
  return inDefaultDialect(() => say(m))
}

/** publicReason's words, by the status a refusal answered with. */
const REASON = {
  invalid: agentMsg({ id: 'activity.reason.invalid', text: 'The request was invalid', note: "An Assistant action refused with 400, as its public error (#763): never the error's own text." }),
  forbidden: agentMsg({ id: 'activity.reason.forbidden', text: 'Not allowed', note: 'An Assistant action refused with 403, as its public error (#763).' }),
  notFound: agentMsg({ id: 'activity.reason.notFound', text: 'Not found', note: 'An Assistant action refused with 404, as its public error (#763).' }),
  conflict: agentMsg({ id: 'activity.reason.conflict', text: 'Not possible now', note: 'An Assistant action refused with 409, as its public error (#763).' }),
  failed: agentMsg({ id: 'activity.reason.failed', text: 'Failed', note: 'An Assistant action that failed otherwise, as its public error (#763).' })
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
 * change keeps the English it was recorded with and the window reads its codes back with finalWhys. Agent messages
 * (dialects, HI-2065), by code; UNDO_FINAL is their Default's English, which is what a change stores.
 */
export const UNDO_FINAL_MSG = {
  prompt: agentMsg({ id: 'activity.undo.prompt', text: "A prompt that was sent can't be taken back.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  message: agentMsg({ id: 'activity.undo.message', text: "A message that was sent can't be taken back.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  comment: agentMsg({ id: 'activity.undo.comment', text: "A comment stays: undo doesn't take back what was said.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  handOver: agentMsg({ id: 'activity.undo.handOver', text: "A hand-over can't be undone: the work went to the other agent.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  projectMade: agentMsg({ id: 'activity.undo.projectMade', text: "A project it made stays: remove it from Combwork if it isn't wanted.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  projectOpened: agentMsg({ id: 'activity.undo.projectOpened', text: "A project it opened stays open: close it if it isn't wanted.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  projectClosed: agentMsg({ id: 'activity.undo.projectClosed', text: 'A project it closed stays closed: open it again if it is wanted.', note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  agentAdded: agentMsg({ id: 'activity.undo.agentAdded', text: "An agent it added stays: remove it in the project's agents if it isn't wanted.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  agentStopped: agentMsg({ id: 'activity.undo.agentStopped', text: "An agent it stopped isn't started again by undo: start it if it should run.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  cardsOrder: agentMsg({ id: 'activity.undo.cardsOrder', text: "The cards' order isn't put back.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  withdrawn: agentMsg({ id: 'activity.undo.withdrawn', text: "Messages it withdrew aren't sent again.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  laneEnded: agentMsg({ id: 'activity.undo.laneEnded', text: 'A lane that ended stays ended: start it again if it should go on.', note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  laneReorderNow: agentMsg({ id: 'activity.undo.laneReorderNow', text: "A card a lane reorder applied now put back stays in Todo: undo puts back only the lane's order.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  decision: agentMsg({ id: 'activity.undo.decision', text: 'A decision it recorded stays: only the user changes or removes decisions.', note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  cardPlace: agentMsg({ id: 'activity.undo.cardPlace', text: "The card's place in its column isn't put back.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  context: agentMsg({ id: 'activity.undo.context', text: 'The doc sections to read first stay as set.', note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  nothing: agentMsg({ id: 'activity.undo.nothing', text: 'It changed nothing undo puts back.', note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  start: agentMsg({ id: 'activity.undo.start', text: "Its start stays in the card's work: undo moves the card back, it doesn't unstart it.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  putBack: agentMsg({ id: 'activity.undo.putBack', text: 'Its reason stays as a comment.', note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  submit: agentMsg({ id: 'activity.undo.submit', text: "Its submission stays in the card's work.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  declarePaths: agentMsg({ id: 'activity.undo.declarePaths', text: 'The paths it declared stay with the card.', note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  startReview: agentMsg({ id: 'activity.undo.startReview', text: "The review it started stays in the card's work.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  verdict: agentMsg({ id: 'activity.undo.verdict', text: "Its verdict stays in the card's work, and its round with it.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  reportMerge: agentMsg({ id: 'activity.undo.reportMerge', text: "The merge it reported stays in the card's work.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  ask: agentMsg({ id: 'activity.undo.ask', text: 'Its question stays under For you: answer or dismiss it there.', note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  cannot: agentMsg({ id: 'activity.undo.cannot', text: 'Its request stays under For you: answer or dismiss it there.', note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  request: agentMsg({ id: 'activity.undo.request', text: 'Its request to the builder stays as a comment.', note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  removedFromQueue: agentMsg({ id: 'activity.undo.removedFromQueue', text: "Taking it out of the merge queue stays in the card's work: it is queued again only by Retry merge or a new approval.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  retriedMerge: agentMsg({ id: 'activity.undo.retriedMerge', text: "Its Retry merge stays in the card's work.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  queuePaused: agentMsg({ id: 'activity.undo.queuePaused', text: "A merge queue it paused stays paused: resume it if it should run.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  queueResumed: agentMsg({ id: 'activity.undo.queueResumed', text: "A merge queue it resumed isn't paused again: pause it if it shouldn't run.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  teamPaused: agentMsg({ id: 'activity.undo.teamPaused', text: 'A team it paused stays paused: resume it if it should go on.', note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  teamResumed: agentMsg({ id: 'activity.undo.teamResumed', text: "A team it resumed isn't paused again: pause it if it should wait.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  freshRetried: agentMsg({ id: 'activity.undo.freshRetried', text: "A lane agent's new conversation tried again isn't stopped by undo: end the lane if it isn't wanted.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  slotReleased: agentMsg({ id: 'activity.undo.slotReleased', text: "A slot it released isn't kept or held again: the next work that needs a slot may take it.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  connectionMade: agentMsg({ id: 'activity.undo.connectionMade', text: "A connection it made stays: remove it in Settings → Accounts & Connections if it isn't wanted.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  connectionChanged: agentMsg({ id: 'activity.undo.connectionChanged', text: "A connection it changed isn't changed back: edit it in Settings → Accounts & Connections.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." }),
  templateCards: agentMsg({ id: 'activity.undo.templateCards', text: "The cards and lanes of the agents a template replaced stay as the load left them (cards put back, lanes ended): undo doesn't give them back.", note: "Why undo leaves this (#1282). Stored with the change in the Default's English, which finalWhys reads its code back from: keep ICU syntax out of it." })
} satisfies Record<string, AgentMsg>

/**
 * Each code's why in the Default's English, as a change stores it (the stored text is the record; a reader's dialect
 * applies once stored records are said as they are read, 5b/6b). Read at module scope (servers.ts's tables), so it is
 * the descriptors' text, which has no ICU syntax: what say() gives in the Default (a unit test checks).
 */
export const UNDO_FINAL =Object.fromEntries(Object.entries(UNDO_FINAL_MSG).map(([why, m]) => [why, m.text])) as { readonly [K in keyof typeof UNDO_FINAL_MSG]: string }

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
