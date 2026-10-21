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
  if (status === 429) return 'Over the limit of changes for one message'
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
    ...(isSetting(a.settingId) ? { settingId: a.settingId } : {})
  }
}
