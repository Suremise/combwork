// Agent templates (#126): a project's agents and layout saved under a name, to load into any project (replacing its
// agents) or to add one agent from. What a template holds and what it leaves out (sessions, folders and branches, setup
// state, the Assistant's mode: those belong to the project), checked as untrusted input when read. #127 adds the places
// to manage them (the Templates view, a project's Templates tab) and sharing them as files (export, import). #1436: the
// format's version 2 (no worktrees, each agent's role in the workflow, a suggested preset and pairs) and Hive's own.
import { AGENT_LIMIT_MAX, ROLE_MAX, SESSION_LAYOUTS, projectAgents } from './defaults'
import { isKnownProvider } from './providers'
import { cleanMcpServers } from './agentMcp'
import type { AgentDef, EffortLevel, PageLayout, PermissionMode, ProviderId } from './types'
import { msg } from './i18n/msg'
import { shownText, withValues, type Text } from './advanced'
import { agentWorkflowRole, buildsWork, isWorkflowRole, reviewsWork, type ReviewerMode, type WorkflowRole } from './workflow/roles'
import { normalKey } from './projectKeys'

/** The format's version: a template made by a newer Hive (a higher one) is refused rather than half read; 0.9's (1) too (#1436). */
export const TEMPLATE_VERSION = 2
/** A template's name is at most this long. */
export const TEMPLATE_NAME_MAX = 60
/**
 * Where a template is kept: Hive's own (#1436, read-only: shipped with Hive, copied to the workspace or a project to
 * change), for every project of the workspace, or for one project (its .hive, private to it).
 */
export type TemplateScope = 'hive' | 'workspace' | 'project'
/** The places templates are written to (Hive's own are never changed). */
export const TEMPLATE_SCOPES: readonly TemplateScope[] = ['workspace', 'project']
/** The preset a template suggests for the project it is loaded into (#1436: offered, never applied silently). */
export type SuggestedPreset = 'solo' | 'pair' | 'team'
export const SUGGESTED_PRESETS: readonly SuggestedPreset[] = ['solo', 'pair', 'team']
/** A builder and the reviewer that reviews its lanes (#1436, for G17's one reviewer per lane), by their names in the template. */
export interface TemplatePair {
  builder: string
  reviewer: string
}
/** An exported template's file name ends so ("Build and review.hive-template.json"). */
export const TEMPLATE_EXPORT_SUFFIX = '.hive-template.json'
/** A file to import is at most this big (a template of 24 agents is a few KB). */
export const TEMPLATE_IMPORT_MAX = 256 * 1024
/** A template's description (#271, optional) is at most this long. */
export const TEMPLATE_DESCRIPTION_MAX = 500

/** Where templates are kept: the workspace's, or a project's (its path). */
export interface TemplateDest {
  scope: TemplateScope
  /** The project, for a project's templates. */
  project?: string
}

/** One template: where it is kept and its file there. */
export interface TemplateRef extends TemplateDest {
  file: string
}

/**
 * One agent of a template: its role in the workflow (#1430), its note and its settings; never where it works (#1436:
 * agents aren't pinned to folders). Its provider may be one this Hive doesn't know (a template from a newer Hive,
 * imported): it is kept and shown, and blocks loading it.
 */
export interface TemplateAgent {
  /** Its name, or a pattern of the project's key (`{key}-B1`: Hive's own templates, #1123 names). */
  name: string
  role: WorkflowRole
  /** What it is for, in the user's words (the agent's note, `AgentDef.role`). */
  note?: string
  provider: ProviderId
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  use200kContext?: boolean
  /** Only these of the project's MCP servers (#537); absent: all of them. */
  mcpServers?: string[]
}

export interface AgentTemplate {
  version: number
  name: string
  /** When it was saved (ISO). */
  savedAt: string
  /** The project's one layout (#134). */
  layout: PageLayout
  /** What it is for, in a few words (#271; optional). */
  description?: string
  agents: TemplateAgent[]
  /** The preset it suggests for the project (#1436; optional): loading offers it, never applies it. */
  suggestedPreset?: SuggestedPreset
  /** G17's choice it suggests (#1436; optional): one reviewer per lane, or a shared pool. Never written into the options. */
  reviewerMode?: ReviewerMode
  /** Builders and their reviewers (#1436; optional), kept as the agents' pairing when it is loaded. */
  pairs?: TemplatePair[]
}

/** A template as listed: where it is kept and what it holds, or why it can't be used. */
export interface TemplateEntry {
  scope: TemplateScope
  /** The project whose template it is (project scope). */
  project?: string
  /** Its file's name in that scope's folder (how it is named in calls). */
  file: string
  name: string
  savedAt: string | null
  layout: PageLayout
  description?: string
  agents: TemplateAgent[]
  suggestedPreset?: SuggestedPreset
  reviewerMode?: ReviewerMode
  pairs?: TemplatePair[]
  /** It can't be used (damaged, made by a newer Hive…): why, in English (the log, a refusal's message). */
  problem?: string
  /** Why, as text for the window to show in its language (#870), following a change of language. */
  problemText?: Text
}

/**
 * A template of a project's agents and layout. `provider` gives each agent's provider as it runs now (stored on the
 * agent since 0.2, else the project's or the app's default), so a template is the same wherever it is loaded.
 */
export function templateFrom(name: string, agents: AgentDef[], layout: PageLayout, provider: (a: AgentDef) => ProviderId, now = new Date(), suggestedPreset?: SuggestedPreset): AgentTemplate {
  const list = projectAgents({ agents })
  const pairs = templatePairs(list.map((a) => ({ name: a.name, role: agentWorkflowRole(a), pairedWith: a.pairedWith })))
  return {
    version: TEMPLATE_VERSION,
    name: name.trim(),
    savedAt: now.toISOString(),
    layout,
    agents: list.map((a) => ({
      name: a.name,
      // Its role as it reads now (the guess, for an agent from before 1.0: #1430).
      role: agentWorkflowRole(a),
      ...(a.role ? { note: a.role } : {}),
      provider: a.provider || provider(a),
      ...(a.model ? { model: a.model } : {}),
      ...(a.effort ? { effort: a.effort } : {}),
      ...(a.permissionMode ? { permissionMode: a.permissionMode } : {}),
      ...(typeof a.use200kContext === 'boolean' ? { use200kContext: a.use200kContext } : {}),
      ...(Array.isArray(a.mcpServers) ? { mcpServers: [...a.mcpServers] } : {})
    })),
    ...(suggestedPreset ? { suggestedPreset } : {}),
    ...(pairs.length ? { pairs } : {})
  }
}

/**
 * The pairs among agents (#1436): a builder whose `pairedWith` names a reviewer of them, each agent in one pair at most
 * (the first named), in the agents' order.
 */
export function templatePairs(agents: readonly { name: string; role: WorkflowRole; pairedWith?: string }[]): TemplatePair[] {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
  const out: TemplatePair[] = []
  const taken = (n: string): boolean => out.some((p) => same(p.builder, n) || same(p.reviewer, n))
  for (const b of agents) {
    if (!b.pairedWith || !buildsWork(b.role) || taken(b.name)) continue
    const r = agents.find((x) => same(x.name, b.pairedWith!) && !same(x.name, b.name) && reviewsWork(x.role))
    if (r && !taken(r.name)) out.push({ builder: b.name, reviewer: r.name })
  }
  return out
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
/** A model, effort or mode as a CLI names it: short, no spaces or control characters. */
const setting = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:/[\]-]{1,100}$/.test(v)

// Why a template file can't be used: shown in the Templates view and the dialogs that read one (window text).
const M = {
  tooMany: msg({ id: 'assistant.template.tooManyHere', defaultMessage: 'It has {count} agents, and this project can have up to {limit} (Settings → Advanced → Agents per project).', description: "Why a template can't be loaded into this project: it has more agents than the project allows. Keep the setting's path as Settings shows it." }),
  notTemplate: msg({ id: 'assistant.template.notTemplate', defaultMessage: "It isn't a Hive agent template.", description: "Why a template file can't be used: it isn't one." }),
  noVersion: msg({ id: 'assistant.template.noVersion', defaultMessage: "It isn't a Hive agent template (no version).", description: "Why a template file can't be used: it has no format version." }),
  newer: msg({ id: 'assistant.template.newer', defaultMessage: 'It was made by a newer version of Hive: update Hive to use it.', description: "Why a template file can't be used: a newer Hive made it." }),
  from09: msg({ id: 'assistant.template.from09', defaultMessage: "This template is from Hive 0.9 and can't be loaded in 1.0. Recreate it from your agents with Save as Template.", description: "Why a template file can't be used: Hive 0.9 made it (its agents had worktrees of their own; 1.0's don't). Save as Template is a command: as Hive names it." }),
  badName: msg({ id: 'assistant.template.badName', defaultMessage: 'Its name is missing or longer than {max} characters.', description: "Why a template file can't be used: the template's name." }),
  noAgents: msg({ id: 'assistant.template.noAgents', defaultMessage: 'It has no agents.', description: "Why a template file can't be used: it holds no agents." }),
  tooManyAny: msg({ id: 'assistant.template.tooMany', defaultMessage: 'It has {count} agents; a project can have up to {max}.', description: "Why a template file can't be used: more agents than any project can have." }),
  agentNoName: msg({ id: 'assistant.template.agentNoName', defaultMessage: 'Agent {n} has no name (or one over 60 characters).', description: "Why a template file can't be used: its agent number {n} (1, 2…) has no usable name." }),
  sameName: msg({ id: 'assistant.template.sameName', defaultMessage: 'Two agents are called "{name}".', description: "Why a template file can't be used: two agents share a name." }),
  badProvider: msg({ id: 'assistant.template.badProvider', defaultMessage: "{name}'s coding agent isn't one Hive can use ({given, select, yes {{provider}} other {none}}).", description: "Why a template file can't be used: an agent's coding agent (Claude Code, Codex…) is no id Hive could know. {name} is the agent; {provider} what the file says; none when it says nothing." }),
  badRole: msg({ id: 'assistant.template.badRole', defaultMessage: "{name}'s role in the workflow isn't builder, reviewer or either.", description: "Why a template file can't be used: an agent's role in the workflow (glossary: builder, reviewer, either) is none of the three. Keep builder, reviewer and either as they are (the file's values)." }),
  longNote: msg({ id: 'assistant.template.longNote', defaultMessage: "{name}'s note is over {max} characters.", description: "Why a template file can't be used: an agent's note (what it is for, in the user's words) is too long." }),
  badPairs: msg({ id: 'assistant.template.badPairs', defaultMessage: 'Its pairs of builders and reviewers name agents it doesn’t have, or an agent twice.', description: "Why a template file can't be used: its list of builders paired with reviewers (glossary: builder, reviewer) doesn't match its agents." }),
  badSetting: msg({ id: 'assistant.template.badSetting', defaultMessage: "{name}'s {setting, select, model {model} effort {effort} other {permissionMode}} isn't one Hive can use.", description: "Why a template file can't be used: an agent's model, effort or permission mode is no value a coding agent takes. Keep permissionMode as it is (the file's field)." }),
  badContext: msg({ id: 'assistant.template.badContext', defaultMessage: "{name}'s context setting isn't one Hive can use.", description: "Why a template file can't be used: an agent's 200K context setting isn't on or off." }),
  badMcp: msg({ id: 'assistant.template.badMcp', defaultMessage: "{name}'s MCP servers aren't a list Hive can use.", description: "Why a template file can't be used: an agent's list of MCP servers." })
}

/** Why a template of `count` agents can't be loaded into a project that can have `limit` (#562), as text (#870). */
export const templateLimitText = (count: number, limit: number): Text => withValues(M.tooMany, { count, limit })

/** Why a listed template can't be used, in the language Hive shows now (call it when rendering); undefined when it can be. */
export const shownProblem = (t: Pick<TemplateEntry, 'problem' | 'problemText'>): string | undefined => (t.problemText ? shownText(t.problemText) : t.problem)

/** Whether readTemplate read a template, rather than why it can't be used. */
export const isAgentTemplate = (t: AgentTemplate | Text): t is AgentTemplate => typeof t === 'object' && 'agents' in t

/**
 * A template read from a file (untrusted): the template, or why it can't be used as text (#870): the window shows it in
 * its language (`shownText`), the log and a refusal's message read its English.
 */
export function readTemplate(raw: unknown): AgentTemplate | Text {
  if (!isObj(raw)) return M.notTemplate
  const version = raw.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return M.noVersion
  if (version > TEMPLATE_VERSION) return M.newer
  // 0.9's pinned agents to worktrees (#1436, Darren's 19 Oct decision on #1123: wiped, never read): made again instead.
  if (version < TEMPLATE_VERSION) return M.from09
  if (!text(raw.name, TEMPLATE_NAME_MAX)) return withValues(M.badName, { max: TEMPLATE_NAME_MAX })
  if (!Array.isArray(raw.agents) || !raw.agents.length) return M.noAgents
  // Any template Hive could have saved (#562): whether it fits a project is its load's to say (templateLimitText).
  if (raw.agents.length > AGENT_LIMIT_MAX) return withValues(M.tooManyAny, { count: raw.agents.length, max: AGENT_LIMIT_MAX })
  const agents: TemplateAgent[] = []
  for (const [i, a] of raw.agents.entries()) {
    if (!isObj(a) || !text(a.name, 60)) return withValues(M.agentNoName, { n: i + 1 })
    const name = a.name.trim()
    if (agents.some((x) => x.name.toLowerCase() === name.toLowerCase())) return withValues(M.sameName, { name })
    // One this Hive doesn't know is kept (flagged where it is shown; loading it is refused), as long as it looks like one.
    if (!isProviderId(a.provider)) return withValues(M.badProvider, { name, given: typeof a.provider === 'string' ? 'yes' : 'no', provider: typeof a.provider === 'string' ? a.provider.slice(0, 40) : '' })
    if (a.role !== undefined && !isWorkflowRole(a.role)) return withValues(M.badRole, { name })
    if (a.note !== undefined && (typeof a.note !== 'string' || a.note.length > ROLE_MAX)) return withValues(M.longNote, { name, max: ROLE_MAX })
    for (const k of ['model', 'effort', 'permissionMode'] as const) if (a[k] !== undefined && !setting(a[k])) return withValues(M.badSetting, { name, setting: k })
    if (a.use200kContext !== undefined && typeof a.use200kContext !== 'boolean') return withValues(M.badContext, { name })
    let mcpServers: string[] | undefined
    try {
      mcpServers = cleanMcpServers(a.mcpServers)
    } catch {
      return withValues(M.badMcp, { name })
    }
    const note = typeof a.note === 'string' ? a.note.replace(/\s+/g, ' ').trim() : ''
    agents.push({
      name,
      // None given: read as an agent of that name and note would be (#1430's guess).
      role: isWorkflowRole(a.role) ? a.role : agentWorkflowRole({ name, ...(note ? { role: note } : {}) }),
      ...(note ? { note } : {}),
      provider: a.provider as ProviderId,
      ...(a.model ? { model: a.model as string } : {}),
      ...(a.effort ? { effort: a.effort as string } : {}),
      ...(a.permissionMode ? { permissionMode: a.permissionMode as string } : {}),
      ...(typeof a.use200kContext === 'boolean' ? { use200kContext: a.use200kContext } : {}),
      ...(mcpServers ? { mcpServers } : {})
    })
  }
  const pairs = readPairs(raw.pairs, agents)
  if (pairs === null) return M.badPairs
  const layout: PageLayout = raw.layout === 'auto' || SESSION_LAYOUTS.some((l) => l.value === raw.layout) ? (raw.layout as PageLayout) : 'auto'
  const savedAt = typeof raw.savedAt === 'string' && Number.isFinite(Date.parse(raw.savedAt)) ? raw.savedAt : ''
  // A description that isn't one (not text, or too long) is left out rather than refusing the template; so are a
  // suggestion and a reviewer mode Hive doesn't know (from a newer Hive): only suggestions.
  const description = typeof raw.description === 'string' && raw.description.length <= TEMPLATE_DESCRIPTION_MAX ? raw.description.trim() : ''
  const suggestedPreset = SUGGESTED_PRESETS.find((p) => p === raw.suggestedPreset)
  const reviewerMode = raw.reviewerMode === 'lane' || raw.reviewerMode === 'pool' ? raw.reviewerMode : undefined
  return { version, name: raw.name.trim(), savedAt, layout, ...(description ? { description } : {}), agents, ...(suggestedPreset ? { suggestedPreset } : {}), ...(reviewerMode ? { reviewerMode } : {}), ...(pairs.length ? { pairs } : {}) }
}

/**
 * A template's pairs as read (untrusted): each a builder and a reviewer among its agents (by name, any case, given as the
 * agents have them), the builder building and the reviewer reviewing, no agent in two pairs; null when they aren't.
 */
function readPairs(raw: unknown, agents: readonly TemplateAgent[]): TemplatePair[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > agents.length) return null
  const of = (n: unknown): TemplateAgent | undefined => (typeof n === 'string' ? agents.find((a) => a.name.toLowerCase() === n.trim().toLowerCase()) : undefined)
  const out: TemplatePair[] = []
  const used = new Set<string>()
  for (const p of raw) {
    const b = isObj(p) ? of(p.builder) : undefined
    const r = isObj(p) ? of(p.reviewer) : undefined
    if (!b || !r || b === r || !buildsWork(b.role) || !reviewsWork(r.role)) return null
    if (used.has(b.name.toLowerCase()) || used.has(r.name.toLowerCase())) return null
    used.add(b.name.toLowerCase())
    used.add(r.name.toLowerCase())
    out.push({ builder: b.name, reviewer: r.name })
  }
  return out
}

/** A provider's id as Hive writes one: known to this Hive or not. */
const isProviderId = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v)

/** The providers of a template's agents that this Hive doesn't know (each once). */
export function unknownProviders(agents: readonly TemplateAgent[]): string[] {
  return [...new Set(agents.map((a) => a.provider).filter((p) => !isKnownProvider(p)))]
}

/**
 * What an exported file holds: the template as Hive reads it, nothing else (no paths, session ids or user names: none
 * are in a template, and anything else a file had is dropped when it is read).
 */
export function exportable(t: AgentTemplate): AgentTemplate {
  return {
    version: TEMPLATE_VERSION,
    name: t.name,
    savedAt: t.savedAt,
    layout: t.layout,
    ...(t.description ? { description: t.description } : {}),
    agents: t.agents.map((a) => ({ ...a })),
    ...(t.suggestedPreset ? { suggestedPreset: t.suggestedPreset } : {}),
    ...(t.reviewerMode ? { reviewerMode: t.reviewerMode } : {}),
    ...(t.pairs?.length ? { pairs: t.pairs.map((p) => ({ ...p })) } : {})
  }
}

/** The tokens a template's agent names may hold (#1123 names): the project's key, and the agent's number among its role. */
const NAME_TOKENS = /\{(key|n)\}/g

/**
 * The key a template's agent names are made with in a project (#1123 names): its key (#704), or, before it has one, its
 * name's first two letters in upper case.
 */
export const namesKey = (key: string | null | undefined, projectName: string): string => key || normalKey(projectName.replace(/[^A-Za-z]/g, '')).slice(0, 2) || 'AG'

/**
 * A template's agent names for a project (#1123 names): `{key}` becomes the project's key (`HI-B1` in hive) and `{n}`
 * the agent's number among the agents of its role, from 1. A name without tokens is itself. #1440 builds the names
 * table on these; until then the load dialog shows them expanded.
 */
export function templateAgentNames(agents: readonly Pick<TemplateAgent, 'name' | 'role'>[], key: string): string[] {
  const count: Partial<Record<WorkflowRole, number>> = {}
  return agents.map((a) => {
    const n = (count[a.role] = (count[a.role] ?? 0) + 1)
    return a.name.replace(NAME_TOKENS, (_m, t: string) => (t === 'key' ? key : String(n)))
  })
}

/** A template's export file name: its name, made safe for a file name ("Build and review.hive-template.json"). */
export function exportFileName(name: string): string {
  return `${name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 60) || 'template'}${TEMPLATE_EXPORT_SUFFIX}`
}

/** A template name not yet taken in a place (case aside): itself, else "Pair (2)", "Pair (3)"… within the length limit. */
export function uniqueTemplateName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()))
  if (!used.has(name.toLowerCase())) return name
  for (let n = 2; ; n++) {
    const end = ` (${n})`
    const candidate = `${name.slice(0, TEMPLATE_NAME_MAX - end.length).trimEnd()}${end}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

/** A template's file name, from its name: lower case, safe on every file system ("Build and review.json" → "build-and-review.json"). */
export function templateFile(name: string, n = 1): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'template'
  return `${base}${n > 1 ? `-${n}` : ''}.json`
}

/** A file name Hive could have made: what calls may name (never a path). */
export const isTemplateFile = (file: unknown): file is string => typeof file === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*\.json$/.test(file) && file.length <= 64

/** A name not yet taken (case aside): itself, else "Builder 2", "Builder 3"… */
export function uniqueName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()))
  if (!used.has(name.toLowerCase())) return name
  for (let n = 2; ; n++) if (!used.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`
}
