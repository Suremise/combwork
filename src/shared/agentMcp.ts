/**
 * Which of a project's MCP servers an agent gets (#537): all of them (the default, `mcpServers` absent), or only those
 * its settings name (`mcpServers`, saved by templates). Only servers on in the project reach anyone (mcpOnInProject);
 * a name chosen here that isn't one of them reaches nobody. The built-in hive server isn't one of them: every session
 * gets it, whatever this says.
 */
import { isReservedServerName, TOOLS_SERVER } from './assistantTools'
import { agentMsg, say } from './agentText'
import type { AgentDef, McpServerInfo, ProjectConfig, WorkspaceConfig } from './types'

/** The names in a list from a config file (a hand-edited file may hold anything). */
export const mcpNames = (list: unknown): string[] => (Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [])
const listed = mcpNames

/** project.json's and workspace.json's MCP lists once they mean "added" (HI-2059): `mcp.model` and `mcp.assistantModel`. */
export const MCP_ADDED_MODEL = 3

/**
 * The workspace servers added to a project (HI-2059): the ones that run there. A project converted to HI-2059's model
 * (`mcp.model` 3) has its list as it is; one not yet converted (a write that failed, a hidden project that couldn't be
 * read) keeps #1093's meaning, its own choices that the workspace has on (`legacy`, workspace.json's `mcp.enabled`,
 * frozen at the upgrade). A list Hive can't read adds nothing: never more than ran.
 */
export function mcpAdded(project: Partial<ProjectConfig['mcp']> | null | undefined, legacy: unknown): string[] {
  const own = listed(project?.enabled)
  if (project?.model === MCP_ADDED_MODEL) return own
  const on = listed(legacy)
  return own.filter((n) => on.includes(n))
}

/** The servers added for the Hive Assistant (HI-2059), as a project's (mcpAdded): before its conversion, #1093's meaning. */
export function assistantMcpAdded(wsMcp: Partial<WorkspaceConfig['mcp']> | null | undefined): string[] {
  return mcpAdded({ enabled: wsMcp?.assistant, model: wsMcp?.assistantModel }, wsMcp?.enabled)
}

/** Whether a workspace MCP server is added to a project (mcpAdded), so it runs there. */
export function mcpOnInProject(name: string, project: Partial<ProjectConfig['mcp']> | null | undefined, legacy: unknown): boolean {
  return mcpAdded(project, legacy).includes(name)
}

/**
 * A project's choices moved to #1093's model, so what ran before still runs and nothing else starts: before, a server
 * was on in a project when the project turned it on, or the workspace had it on for all projects (`allProjects`), unless
 * the project turned it off (`disabled`, which won). Now it is on in the project wherever it ran there.
 */
export function migratedProjectMcp(allProjects: readonly string[], project: Partial<ProjectConfig['mcp']> | null | undefined): string[] {
  const off = listed(project?.disabled)
  return [...new Set([...listed(project?.enabled), ...listed(allProjects)])].filter((n) => !off.includes(n)).sort()
}

/** The workspace's switches moved to #1093's model: on for every server that ran anywhere (on for all projects, or turned on in a project). */
export function migratedWorkspaceMcp(allProjects: readonly string[], projects: readonly (Partial<ProjectConfig['mcp']> | null | undefined)[]): string[] {
  const on = new Set(listed(allProjects))
  for (const p of projects) for (const n of listed(p?.enabled)) if (!listed(p?.disabled).includes(n)) on.add(n)
  return [...on].sort()
}

/** A listed server (mcp:list, listMcp) that runs in a project: a valid definition, added there (mcpOnInProject). */
export const serverOnIn = (m: Pick<McpServerInfo, 'name' | 'def'>, project: Partial<ProjectConfig['mcp']> | null | undefined, legacy: unknown): boolean => !!m.def && mcpOnInProject(m.name, project, legacy)

/** A listed server added to the project at `projectPath` (McpServerInfo.projects, worked out by main): the window's test. */
export const serverAddedIn = (m: Pick<McpServerInfo, 'def' | 'projects'>, projectPath: string): boolean => !!m.def && m.projects.some((p) => p.toLowerCase() === projectPath.toLowerCase())

/** The most servers an agent's choice names. */
export const AGENT_MCP_MAX = 50

/** A workspace MCP server's name (its .combwork/mcp/<name>.json); `combwork` is Combwork's own. */
/** Why an agent's list of MCP servers was refused (HI-2463: its reserved name said as Combwork's). */
const NOT_A_SERVER = agentMsg({ id: 'api.agentMcp.notAServer', text: "\"{name}\" isn't an MCP server's name{reserved, select, yes { (the built-in {server} server is always given)} other {}}.", note: "A refusal of an agent's MCP servers: name is what was given; reserved: yes when it is Combwork's own server's name; server: that name (combwork)." })

export const isMcpServerName = (name: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) && !isReservedServerName(name)

/**
 * An agent's choice as saved: undefined for all of the project's servers, else the names (trimmed, each once, in the
 * order given; empty: none of them). Throws with what is wrong.
 */
export function cleanMcpServers(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error("MCP servers is a list of the project's server names.")
  const out: string[] = []
  for (const v of raw) {
    const name = typeof v === 'string' ? v.trim() : ''
    if (!isMcpServerName(name)) throw new Error(say(NOT_A_SERVER, { name: String(v).slice(0, 70), reserved: isReservedServerName(name) ? 'yes' : 'no', server: TOOLS_SERVER }))
    if (!out.includes(name)) out.push(name)
  }
  if (out.length > AGENT_MCP_MAX) throw new Error(`An agent can be given at most ${AGENT_MCP_MAX} MCP servers.`)
  return out
}

/**
 * Whether an agent gets the project's server `name`. A choice Hive can't read (a hand-edited project.json) gives none:
 * never more than was asked for.
 */
export function agentGetsMcp(agent: Pick<AgentDef, 'mcpServers'> | null | undefined, name: string): boolean {
  const only: unknown = agent?.mcpServers
  if (only === undefined || only === null) return true
  return Array.isArray(only) && only.includes(name)
}

/** Whether the agent has a choice of its own (only some servers), not all of the project's. */
export const agentChoosesMcp = (agent: Pick<AgentDef, 'mcpServers'> | null | undefined): boolean => agent?.mcpServers !== undefined && agent?.mcpServers !== null

/**
 * The agent's choice in words: "all of the project's", "only github, notes" or "none of the project's". `on`: the
 * project's servers that are on, to say which chosen ones aren't ("only notes (not on here)").
 */
export function agentMcpText(agent: Pick<AgentDef, 'mcpServers'> | null | undefined, on?: readonly string[]): string {
  if (!agentChoosesMcp(agent)) return "all of the project's"
  const names = Array.isArray(agent!.mcpServers) ? agent!.mcpServers.filter((n) => typeof n === 'string') : []
  if (!names.length) return "none of the project's"
  return `only ${names.map((n) => (on && !on.includes(n) ? `${n} (not on here)` : n)).join(', ')}`
}

/** The MCP view's and the Add server picker's filters (HI-2059): every server, those added somewhere or nowhere, broken ones. */
export type McpFilter = 'all' | 'added' | 'nowhere' | 'errors'

/**
 * Whether a listed server is shown for a search and a filter (HI-2059): every word of `query` in its name, description
 * or tags (any case), and `filter` by where it is added.
 */
export function mcpServerShown(m: Pick<McpServerInfo, 'name' | 'def' | 'projects' | 'assistant' | 'error'>, query: string, filter: McpFilter): boolean {
  const added = m.projects.length > 0 || m.assistant
  if (filter === 'added' && !added) return false
  if (filter === 'nowhere' && added) return false
  if (filter === 'errors' && !m.error) return false
  const tags = Array.isArray(m.def?.tags) ? m.def.tags.filter((t) => typeof t === 'string') : []
  const text = [m.name, typeof m.def?.description === 'string' ? m.def.description : '', ...tags].join('\n').toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => text.includes(w))
}
