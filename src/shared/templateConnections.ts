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
 * What a picker answers (`hive_template` `connections`, the dialogs'): `*` for every agent, a role for its agents, an
 * agent's name for it alone (over its role's, over `*`). Each value a connection's id or name.
 */
export type ConnectionAnswers = Record<string, string>

/** The answer's keys for all and the roles, in the order the picker shows them. */
export const ALL_KEY = '*'

/** An agent as the picker reads it: its name, role in the workflow and the CLI it suggests (a template's) or runs (an existing one's). */
export interface PickedAgent {
  name: string
  role: WorkflowRole
  provider?: string
}

/** The roles among the agents, in the workflow's order (builders, reviewers, either, generalists). */
export const rolesOf = (agents: readonly Pick<PickedAgent, 'role'>[]): WorkflowRole[] => WORKFLOW_ROLES.filter((r) => agents.some((a) => a.role === r))

/** The CLI a role's agents suggest: the first of them that names one. */
export const suggestedCli = (agents: readonly PickedAgent[], role: WorkflowRole | typeof ALL_KEY): string | undefined => agents.find((a) => (role === ALL_KEY || a.role === role) && a.provider)?.provider

/** What a picker preselects for a CLI suggested (HI-2105's wireframe): the first connection on it, else the first there is. */
export const preselected = (options: readonly ConnectionOption[], cli: string | undefined): string | undefined => (options.find((o) => o.cli === cli) ?? options[0])?.id

/**
 * Each agent's answer, by the agents' order: its name's (any case), else its role's, else all's, else `fallback(agent)`
 * (a load: its role's preselected connection; Choose Connections…: none, it keeps its own). Values as answered (an id or a
 * name: the caller finds the connection).
 */
export function answerFor(agents: readonly PickedAgent[], answers: ConnectionAnswers | undefined, fallback: (a: PickedAgent) => string | undefined): (string | undefined)[] {
  const byName = new Map(Object.entries(answers ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v]))
  const given = (k: string): string | undefined => {
    const v = byName.get(k.toLowerCase())
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }
  return agents.map((a) => given(a.name) ?? given(a.role) ?? given(ALL_KEY) ?? fallback(a))
}

/** A load's fallback: the connection its role's picker preselects (the first on the CLI its role's agents suggest). */
export const loadFallback = (agents: readonly PickedAgent[], options: readonly ConnectionOption[]) => (a: PickedAgent): string | undefined => preselected(options, suggestedCli(agents, a.role))

/** The answer's keys that are neither all, a role nor one of the agents' names: refused, so a typo never goes unseen. */
export function unknownKeys(agents: readonly Pick<PickedAgent, 'name'>[], answers: ConnectionAnswers | undefined): string[] {
  const names = new Set(agents.map((a) => a.name.toLowerCase()))
  return Object.keys(answers ?? {}).filter((k) => k !== ALL_KEY && !(WORKFLOW_ROLES as readonly string[]).includes(k) && !names.has(k.trim().toLowerCase()))
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
export function initialPicker(agents: readonly PickedAgent[], options: readonly ConnectionOption[], keep?: (role: WorkflowRole | typeof ALL_KEY) => string): PickerState {
  const pre = (role: WorkflowRole | typeof ALL_KEY): string => (keep ? keep(role) : (preselected(options, suggestedCli(agents, role)) ?? ''))
  return { same: false, all: pre(ALL_KEY), roles: Object.fromEntries(rolesOf(agents).map((r) => [r, pre(r)])), agents: {} }
}

/** A picker's state as answers, by the agents' names now (the names chosen in the dialog): only what is chosen, '' left out. */
export function pickerAnswers(state: PickerState, agents: readonly PickedAgent[]): ConnectionAnswers {
  const out: ConnectionAnswers = {}
  if (state.same) {
    if (state.all) out[ALL_KEY] = state.all
  } else for (const [r, id] of Object.entries(state.roles)) if (id) out[r] = id
  if (!state.same) for (const [i, id] of Object.entries(state.agents)) if (id && agents[Number(i)]) out[agents[Number(i)].name] = id
  return out
}
