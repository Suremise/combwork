// The connections a template's agents get when it is loaded, and Choose Connections… on a project's existing agents
// (HI-2109, HI-2105's design, decision G): a template keeps no connection, only a suggested CLI per agent; the picker
// chooses one connection for all, one per role, or one per agent (over its role's). What the window and the Agent API
// both work it out with, from the connections usable where the agents run.
import type { Connection, EffortLevel, PermissionMode, ProviderId } from './types'
import { WORKFLOW_ROLES, type WorkflowRole } from './workflow/roles'

/** A connection a picker offers: usable where the agents run (its account on there, its CLI on and installed), in the order. */
export interface ConnectionOption {
  id: string
  name: string
  account: string
  accountName: string
  cli: ProviderId
  /** A server account's (HI-1772): no effort or context. */
  server?: true
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  use200kContext?: boolean
}

/**
 * Choose Connections… on a project's agents (HI-2109): each agent with its role, the CLI it runs, its connection (by id,
 * the agent's own as saved) and whether it runs now; and the connections usable here. Nothing is replaced or loaded.
 */
export interface ConnectionsPlan {
  project: string
  agents: { id: string; name: string; role: WorkflowRole; provider: ProviderId; connection?: string; running: boolean }[]
  options: ConnectionOption[]
}

/**
 * What Choose Connections… did: the agents given another connection (`restart`: those of them running, still on the old
 * one until they restart), and those it couldn't change, with why: `running`, a running agent asked to take another
 * CLI's connection; `gone`, removed meanwhile.
 */
export interface ConnectionsApplied {
  changed: string[]
  restart: { id: string; name: string }[]
  skipped: { name: string; why: 'running' | 'gone' }[]
}

/** A connection as the picker shows it (its values as a ConnectionOption carries them). */
export const optionOf = (c: Connection, account: { name: string; provider: ProviderId; kind?: 'signIn' | 'server' }): ConnectionOption => ({
  id: c.id,
  name: c.name,
  account: c.account,
  accountName: account.name,
  cli: account.provider,
  ...(account.kind === 'server' ? { server: true as const } : {}),
  ...(c.model ? { model: c.model } : {}),
  ...(c.effort ? { effort: c.effort } : {}),
  ...(c.permissionMode ? { permissionMode: c.permissionMode } : {}),
  ...(c.use200kContext ? { use200kContext: true } : {})
})

/**
 * What a picker answers (the dialogs', and `hive_template` `connections` once read: templateApi.ts): one connection for
 * every agent (`all`), one per role, and one per agent by its **key** (over its role's, over all's): an existing agent's
 * id, a template's agent's name in the template as made for the project (`templateNames`). Kept apart, so an agent called
 * Builder never stands for the builders (HR3's round 1), and bound to the agent it was chosen for, never to a place a
 * list that changed meanwhile gives another (HR3's round 2). Each value a connection's id or name.
 */
export interface ConnectionAnswers {
  all?: string
  roles?: Partial<Record<WorkflowRole, string>>
  agents?: Record<string, string>
}

/** The answer's keys for all and the roles, in the order the picker shows them. */
export const ALL_KEY = '*'

/**
 * An agent as the picker reads it: its key (an existing agent's id, a template's agent's name in the template), name, role
 * in the workflow and the CLI it suggests (a template's) or runs (an existing one's).
 */
export interface PickedAgent {
  key: string
  name: string
  role: WorkflowRole
  provider?: string
}

/** The roles among the agents, in the workflow's order (builders, reviewers, either, generalists). */
export const rolesOf = (agents: readonly Pick<PickedAgent, 'role'>[]): WorkflowRole[] => WORKFLOW_ROLES.filter((r) => agents.some((a) => a.role === r))

/** The CLI a role's agents suggest: the first of them that names one. */
export const suggestedCli = (agents: readonly Pick<PickedAgent, 'role' | 'provider'>[], role: WorkflowRole | typeof ALL_KEY): string | undefined => agents.find((a) => (role === ALL_KEY || a.role === role) && a.provider)?.provider

/** What a picker preselects for a CLI suggested (HI-2105's wireframe): the first connection on it, else the first there is. */
export const preselected = (options: readonly ConnectionOption[], cli: string | undefined): string | undefined => (options.find((o) => o.cli === cli) ?? options[0])?.id

/**
 * Each agent's answer, by the agents' order: its own (by its key), else its role's, else all's, else `fallback(agent)`
 * (a load: its role's preselected connection; Choose Connections…: none, it keeps its own). Values as answered (an id or a
 * name: the caller finds the connection).
 */
export function answerFor(agents: readonly PickedAgent[], answers: ConnectionAnswers | undefined, fallback: (a: PickedAgent) => string | undefined): (string | undefined)[] {
  const given = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  return agents.map((a) => given(answers?.agents?.[a.key]) ?? given(answers?.roles?.[a.role]) ?? given(answers?.all) ?? fallback(a))
}

/** A load's fallback: the connection its role's picker preselects (the first on the CLI its role's agents suggest). */
export const loadFallback = (agents: readonly Pick<PickedAgent, 'role' | 'provider'>[], options: readonly ConnectionOption[]) => (a: Pick<PickedAgent, 'role'>): string | undefined => preselected(options, suggestedCli(agents, a.role))

/**
 * What of answers (untrusted: a window's or main's caller's) isn't one: a role that isn't one, an agent whose key isn't
 * among `keys` (the agents now: one removed or renamed since it was chosen for), a value that isn't text. Each named as
 * it was given ("role boss", "agent a-3f9c"); none: [].
 */
export function badAnswers(keys: readonly string[], answers: unknown): string[] {
  if (answers === undefined || answers === null) return []
  if (typeof answers !== 'object' || Array.isArray(answers)) return [String(answers)]
  const a = answers as Record<string, unknown>
  const bad = Object.keys(a).filter((k) => k !== 'all' && k !== 'roles' && k !== 'agents')
  const text = (v: unknown): boolean => v === undefined || typeof v === 'string'
  if (!text(a.all)) bad.push('all')
  const map = (k: 'roles' | 'agents'): Record<string, unknown> => (a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? (a[k] as Record<string, unknown>) : {})
  if (a.roles !== undefined && (typeof a.roles !== 'object' || Array.isArray(a.roles))) bad.push('roles')
  if (a.agents !== undefined && (typeof a.agents !== 'object' || Array.isArray(a.agents))) bad.push('agents')
  // agent-protocol: what was given, named by its field (roles or agents) and its key, not wording
  for (const [k, v] of Object.entries(map('roles'))) if (!(WORKFLOW_ROLES as readonly string[]).includes(k) || !text(v)) bad.push(`role ${k}`) // i18n-ignore: what was given, named as it was (role or agent and its key), not prose
  // agent-protocol: as above
  for (const [k, v] of Object.entries(map('agents'))) if (!keys.includes(k) || !text(v)) bad.push(`agent ${k}`) // i18n-ignore: what was given, named as it was (role or agent and its key), not prose
  return bad
}

/**
 * The option an answer names: its id, else its name (any case); `ambiguous` when several have that name (the ids then
 * say which), `unknown` when none.
 */
export function optionNamed(options: readonly ConnectionOption[], ref: string): { ok: true; option: ConnectionOption } | { ok: false; why: 'unknown' | 'ambiguous'; ids?: string[] } {
  const byId = options.find((o) => o.id === ref)
  if (byId) return { ok: true, option: byId }
  const named = options.filter((o) => o.name.toLowerCase() === ref.trim().toLowerCase())
  if (named.length === 1) return { ok: true, option: named[0] }
  return named.length ? { ok: false, why: 'ambiguous', ids: named.map((o) => o.id) } : { ok: false, why: 'unknown' } // i18n-ignore: a reason's code, not text
}

/**
 * A picker's state as the dialogs keep it: one connection for all (`same`), else one per role, with any agent's own over
 * its role's (by the agent's place). '' for "keep each one's" (Choose Connections… only).
 */
export interface PickerState {
  same: boolean
  all: string
  roles: Partial<Record<WorkflowRole, string>>
  agents: Record<number, string>
}

/** A picker's first state: Same for all unticked, each role's preselected, no agent's own. */
export function initialPicker(agents: readonly Pick<PickedAgent, 'role' | 'provider'>[], options: readonly ConnectionOption[], keep?: (role: WorkflowRole | typeof ALL_KEY) => string): PickerState {
  const pre = (role: WorkflowRole | typeof ALL_KEY): string => (keep ? keep(role) : (preselected(options, suggestedCli(agents, role)) ?? ''))
  return { same: false, all: pre(ALL_KEY), roles: Object.fromEntries(rolesOf(agents).map((r) => [r, pre(r)])), agents: {} }
}

/**
 * A picker's state as answers: all's alone when Same for all is ticked, else each role's and each agent's own, by the key
 * of the agent at that place in the list the dialog showed (`agents`); '' left out.
 */
export function pickerAnswers(state: PickerState, shown: readonly Pick<PickedAgent, 'key'>[]): ConnectionAnswers {
  if (state.same) return state.all ? { all: state.all } : {}
  const roles = Object.fromEntries(Object.entries(state.roles).filter(([, id]) => !!id)) as ConnectionAnswers['roles']
  const agents = Object.fromEntries(Object.entries(state.agents).flatMap(([i, id]) => (id && shown[Number(i)] ? [[shown[Number(i)].key, id] as const] : [])))
  return { ...(Object.keys(roles ?? {}).length ? { roles } : {}), ...(Object.keys(agents).length ? { agents } : {}) }
}
