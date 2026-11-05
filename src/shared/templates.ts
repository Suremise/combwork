// Agent templates (#126): a project's agents and layout saved under a name, to load into any project (replacing its
// agents) or to add one agent from. What a template holds and what it leaves out (sessions, folders and branches, setup
// state, the Assistant's mode: those belong to the project), checked as untrusted input when read. #127 adds the places
// to manage them (the Templates view, a project's Templates tab) and sharing them as files (export, import). #1436: the
// format's version 2 (no worktrees, each agent's role in the workflow, a suggested preset and pairs) and Hive's own.
// HI-1910: its workflow, a section per version control (workflow/templateOptions.ts), read through its whitelist.
import { AGENT_LIMIT_MAX, ROLE_MAX, SESSION_LAYOUTS, projectAgents } from './defaults'
import { isKnownProvider } from './providers'
import { cleanMcpServers } from './agentMcp'
import type { AgentDef, PageLayout, ProviderId } from './types'
import { msg } from './i18n/msg'
import { agentMsg, say } from './agentText'
import { shownText, withValues, type Text } from './advanced'
import { agentWorkflowRole, buildsWork, isWorkflowRole, reviewsWork, type ReviewerMode, type WorkflowRole } from './workflow/roles'
import { hasWorkflow, readTemplateWorkflows, TEMPLATE_PLATFORMS, type TemplateWorkflows } from './workflow/templateOptions'
import type { PlatformId } from './platform/descriptors'

/** The format's version: a template made by a newer Hive (a higher one) is refused rather than half read; 0.9's (1) too (#1436). */
export const TEMPLATE_VERSION = 2
/** A template's name is at most this long. */
export const TEMPLATE_NAME_MAX = 60
/**
 * Where a template is kept: Hive's own (#1436, read-only: shipped with Hive, copied to the workspace or a project to
 * change), for every project of the workspace, or for one project (its .combwork, private to it).
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
/** An exported template's file name ends so ("Build and review.combwork-template.json"). */
export const TEMPLATE_EXPORT_SUFFIX = '.combwork-template.json'
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
 * One agent of a template: its role in the workflow (#1430), its note, its MCP servers and the CLI it suggests; never
 * where it works (#1436: agents aren't pinned to folders) nor what it runs on (HI-2109, decision G: no connection, model,
 * effort, mode or context; those are the connection's, chosen when it is loaded). Its provider may be one this Hive
 * doesn't know (a template from a newer Hive, imported): kept and shown, never used.
 */
export interface TemplateAgent {
  /** Its name, or a pattern of the project's key (`{key}-B1`: Hive's own templates, #1123 names). */
  name: string
  role: WorkflowRole
  /** What it is for, in the user's words (the agent's note, `AgentDef.role`). */
  note?: string
  /** The CLI it suggests (HI-2109): it only preselects a connection on that CLI in the picker. Absent: none. */
  provider?: ProviderId
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
  /** Its workflow (HI-1910; optional): a section per version control, the rules a project's options set. */
  workflow?: TemplateWorkflows
  /**
   * The sections it had that can't be used (HR5's HI-1910 round 1): said where it is shown, and kept when it is written
   * (an import, a copy), as platforms only, never what they held, so a rejected section is never taken for none (and
   * the preset it suggests never offered in its place).
   */
  workflowDropped?: PlatformId[]
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
  workflow?: TemplateWorkflows
  workflowDropped?: PlatformId[]
  /** It can't be used (damaged, made by a newer Hive…): why, in English (the log, a refusal's message). */
  problem?: string
  /** Why, as text for the window to show in its language (#870), following a change of language. */
  problemText?: Text
  /**
   * Its agents' names in the project it is listed for (HI-1948: `listTemplates`), its patterns made with that project's
   * key as main reads it; `{key}` kept while the project has none. Derived for display, never saved or loaded.
   */
  agentNames?: string[]
}

/**
 * A template of a project's agents and layout. `provider` gives each agent's CLI as it runs now (stored on the agent
 * since 0.2), kept as the CLI it suggests (HI-2109); its connection, and so its model, effort and mode, never.
 */
export function templateFrom(name: string, agents: AgentDef[], layout: PageLayout, provider: (a: AgentDef) => ProviderId, now = new Date(), suggestedPreset?: SuggestedPreset, patternKey?: string): AgentTemplate {
  const list = projectAgents({ agents })
  const roles = list.map((a) => ({ name: a.name, role: agentWorkflowRole(a) }))
  // The project's key in its names kept as a pattern (#1440), when asked: HI-B1 as {key}-B{n}.
  const names = patternKey ? namePatterns(roles, patternKey) : list.map((a) => a.name)
  // Pairs by the names as kept, numbered (`{key}-B1`).
  const byPair = pairNames(names.map((n, i) => ({ name: n, role: roles[i].role })))
  const pairs = templatePairs(list.map((a, i) => ({ ...roles[i], pairedWith: a.pairedWith }))).map((p) => ({ builder: byPair[roles.findIndex((r) => r.name === p.builder)], reviewer: byPair[roles.findIndex((r) => r.name === p.reviewer)] }))
  return {
    version: TEMPLATE_VERSION,
    name: name.trim(),
    savedAt: now.toISOString(),
    layout,
    agents: list.map((a, i) => ({
      name: names[i],
      // Its role as it reads now (the guess, for an agent from before 1.0: #1430).
      role: agentWorkflowRole(a),
      ...(a.role ? { note: a.role } : {}),
      provider: a.provider || provider(a),
      // Never its connection, model, effort, mode or context (HI-2109, decision G): chosen when it is loaded.
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
// Why a template file can't be used: shown in the Templates view and the dialogs that read one (window text).
const M = {
  notTemplate: msg({ id: 'assistant.template.notTemplate', defaultMessage: "It isn't a Combwork agent template.", description: "Why a template file can't be used: it isn't one." }),
  noVersion: msg({ id: 'assistant.template.noVersion', defaultMessage: "It isn't a Combwork agent template (no version).", description: "Why a template file can't be used: it has no format version." }),
  newer: msg({ id: 'assistant.template.newer', defaultMessage: 'It was made by a newer version of Combwork: update Combwork to use it.', description: "Why a template file can't be used: a newer Hive made it." }),
  from09: msg({ id: 'assistant.template.from09', defaultMessage: "This template is from Combwork 0.9 and can't be loaded in 1.0. Recreate it from your agents with Save as Template.", description: "Why a template file can't be used: Hive 0.9 made it (its agents had worktrees of their own; 1.0's don't). Save as Template is a command: as Hive names it." }),
  badName: msg({ id: 'assistant.template.badName', defaultMessage: 'Its name is missing or longer than {max} characters.', description: "Why a template file can't be used: the template's name." }),
  noAgents: msg({ id: 'assistant.template.noAgents', defaultMessage: 'It has no agents.', description: "Why a template file can't be used: it holds no agents." }),
  tooManyAny: msg({ id: 'assistant.template.tooMany', defaultMessage: 'It has {count} agents; a project can have up to {max}.', description: "Why a template file can't be used: more agents than any project can have." }),
  agentNoName: msg({ id: 'assistant.template.agentNoName', defaultMessage: 'Agent {n} has no name (or one over 60 characters).', description: "Why a template file can't be used: its agent number {n} (1, 2…) has no usable name." }),
  sameName: msg({ id: 'assistant.template.sameName', defaultMessage: 'Two agents are called "{name}".', description: "Why a template file can't be used: two agents share a name." }),
  badRole: msg({ id: 'assistant.template.badRole', defaultMessage: "{name}'s role in the workflow isn't builder, reviewer, either or generalist.", description: "Why a template file can't be used: an agent's role in the workflow (glossary: builder, reviewer, either) is none of the three. Keep builder, reviewer and either as they are (the file's values)." }),
  longNote: msg({ id: 'assistant.template.longNote', defaultMessage: 'The note of agent {name} is over {max, number} characters.', description: "Why a template file can't be used: an agent's note (what it is for, in the user's words) is too long. {max} is the limit, a number. A noun before the name (glossary §1 rule 4)." }),
  badToken: msg({ id: 'assistant.template.badToken', defaultMessage: "{name} uses {token}: an agent’s name may only hold '{key}' (the project’s key) and '{n}' (its number among the agents with that name).", description: "Why a template file can't be used: an agent's name pattern ({name}) holds {token}, a token Hive doesn't know. The quoted '{key}' and '{n}' are shown as {key} and {n}: keep them, with their straight quotes, as they are." }),
  badPairs: msg({ id: 'assistant.template.badPairs', defaultMessage: 'Its pairs of builders and reviewers name agents it doesn’t have, or an agent twice.', description: "Why a template file can't be used: its list of builders paired with reviewers (glossary: builder, reviewer) doesn't match its agents." }),
  badMcp: msg({ id: 'assistant.template.badMcp', defaultMessage: "{name}'s MCP servers aren't a list Combwork can use.", description: "Why a template file can't be used: an agent's list of MCP servers." })
}

/** Why a template of `count` agents can't be loaded into a project that can have `limit` (#562), as text (#870). */
/**
 * Why the Assistant can't load a template into a project (HI-2001): more agents than its Maximum agents. Only the
 * Assistant's loads keep to it (the user's go past it), so it stays English.
 */
export const templateLimitText = (count: number, max: number): string => say(TOO_MANY, { count: String(count), max: String(max) })
const TOO_MANY = agentMsg({
  id: 'template.load.tooMany',
  text: "It has {count} agents, and this project's workflow allows {max} (Maximum agents, the user's team size, in Version Control → Workflow). The user can load it themselves, or raise Maximum agents first.",
  note: "Why the Assistant can't load a template (HI-2001): more agents than the project's Maximum agents, which only the Assistant's loads keep to. {count} and {max} are digits."
})

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
    // A pattern (#1440): only {key} and {n} (what they make is never longer than the pattern: a key's 4 letters at most,
    // a number's 2 digits).
    const token = /\{[^}]*\}/.exec(name.replace(NAME_TOKENS, ''))?.[0]
    if (token) return withValues(M.badToken, { name, token })
    // The CLI it suggests (HI-2109): one this Hive doesn't know is kept (flagged where it is shown) as long as it looks
    // like one; anything else is no suggestion, never a refusal.
    const provider = isProviderId(a.provider) ? a.provider : undefined
    if (a.role !== undefined && !isWorkflowRole(a.role)) return withValues(M.badRole, { name })
    if (a.note !== undefined && (typeof a.note !== 'string' || a.note.length > ROLE_MAX)) return withValues(M.longNote, { name, max: ROLE_MAX })
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
      ...(provider ? { provider } : {}),
      // Its model, effort, mode, context, connection and connection's name (from before HI-2109) are dropped as it is
      // read, whatever they hold: never a refusal (decision G: connections are this machine's, chosen when it is loaded).
      ...(mcpServers ? { mcpServers } : {})
    })
  }
  // Two agents named alike once their patterns are made (`{key}-B{n}` twice is HI-B1 and HI-B2: different).
  const made = templateAgentNames(agents, 'KEY')
  const twice = made.findIndex((n, i) => made.findIndex((m) => m.toLowerCase() === n.toLowerCase()) !== i)
  if (twice >= 0) return withValues(M.sameName, { name: agents[twice].name })
  const pairs = readPairs(raw.pairs, agents)
  if (pairs === null) return M.badPairs
  const layout: PageLayout = raw.layout === 'auto' || SESSION_LAYOUTS.some((l) => l.value === raw.layout) ? (raw.layout as PageLayout) : 'auto'
  const savedAt = typeof raw.savedAt === 'string' && Number.isFinite(Date.parse(raw.savedAt)) ? raw.savedAt : ''
  // A description that isn't one (not text, or too long) is left out rather than refusing the template; so are a
  // suggestion and a reviewer mode Hive doesn't know (from a newer Hive): only suggestions.
  const description = typeof raw.description === 'string' && raw.description.length <= TEMPLATE_DESCRIPTION_MAX ? raw.description.trim() : ''
  const suggestedPreset = SUGGESTED_PRESETS.find((p) => p === raw.suggestedPreset)
  const reviewerMode = raw.reviewerMode === 'lane' || raw.reviewerMode === 'pool' ? raw.reviewerMode : undefined
  // Its workflow (HI-1910) through the whitelist: a section that can't be used is left out and said (`workflowDropped`),
  // never refusing the template nor its other section.
  // A workflow that isn't one at all rejects both; one written as rejected (`workflowDropped`, by a copy or an import)
  // stays so where it has no usable section now.
  const read = raw.workflow === undefined ? { workflow: {}, dropped: [] as PlatformId[] } : isObj(raw.workflow) ? readTemplateWorkflows(raw.workflow) : { workflow: {}, dropped: [...TEMPLATE_PLATFORMS] }
  const workflow: TemplateWorkflows = read.workflow
  const marked = Array.isArray(raw.workflowDropped) ? TEMPLATE_PLATFORMS.filter((p) => (raw.workflowDropped as unknown[]).includes(p)) : []
  const dropped = TEMPLATE_PLATFORMS.filter((p) => !workflow[p] && (read.dropped.includes(p) || marked.includes(p)))
  return { version, name: raw.name.trim(), savedAt, layout, ...(description ? { description } : {}), agents, ...(suggestedPreset ? { suggestedPreset } : {}), ...(reviewerMode ? { reviewerMode } : {}), ...(pairs.length ? { pairs } : {}), ...(hasWorkflow(workflow) ? { workflow } : {}), ...(dropped.length ? { workflowDropped: dropped } : {}) }
}

/**
 * A template's pairs as read (untrusted): each a builder and a reviewer among its agents, by their numbered names
 * (`pairName`: `{key}-B1` for the first `{key}-B{n}`; a fixed name as it is; any case), the builder building and the
 * reviewer reviewing, no agent in two pairs; null when they aren't.
 */
function readPairs(raw: unknown, agents: readonly TemplateAgent[]): TemplatePair[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > agents.length) return null
  const names = pairNames(agents)
  const at = (n: unknown): number => (typeof n === 'string' ? names.findIndex((x) => x.toLowerCase() === n.trim().toLowerCase()) : -1)
  const out: TemplatePair[] = []
  const used = new Set<number>()
  for (const p of raw) {
    const b = isObj(p) ? at(p.builder) : -1
    const r = isObj(p) ? at(p.reviewer) : -1
    if (b < 0 || r < 0 || b === r || !buildsWork(agents[b].role) || !reviewsWork(agents[r].role)) return null
    if (used.has(b) || used.has(r)) return null
    used.add(b)
    used.add(r)
    out.push({ builder: names[b], reviewer: names[r] })
  }
  return out
}

/** The names a template's pairs give its agents by (#1440): each name with `{n}` made, `{key}` kept (`{key}-B1`). */
export const pairNames = (agents: readonly Pick<TemplateAgent, 'name' | 'role'>[]): string[] => templateAgentNames(agents, '{key}')

/** Where a pair's agent is among a template's agents (by its numbered name, any case), or -1. */
export const pairIndex = (agents: readonly Pick<TemplateAgent, 'name' | 'role'>[], name: string): number => pairNames(agents).findIndex((n) => n.toLowerCase() === name.toLowerCase())

/** A provider's id as Hive writes one: known to this Hive or not. */
const isProviderId = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v)

/** The CLIs a template's agents suggest that this Hive doesn't know (each once). */
export function unknownProviders(agents: readonly TemplateAgent[]): string[] {
  return [...new Set(agents.map((a) => a.provider).filter((p): p is string => !!p && !isKnownProvider(p)))]
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
    ...(t.pairs?.length ? { pairs: t.pairs.map((p) => ({ ...p })) } : {}),
    // Its sections as read (HI-1910): whitelisted again, whatever the object holds.
    ...exportedWorkflow(t.workflow, t.workflowDropped)
  }
}

/**
 * A template's sections as written (HI-1910): whitelisted again, whatever the object holds; none, nothing. Those it had
 * that can't be used (or that this whitelist rejects now) are written as rejected, by platform alone.
 */
function exportedWorkflow(w: TemplateWorkflows | undefined, had: readonly PlatformId[] | undefined): { workflow?: TemplateWorkflows; workflowDropped?: PlatformId[] } {
  const read = hasWorkflow(w) ? readTemplateWorkflows(JSON.parse(JSON.stringify(w))) : { workflow: {} as TemplateWorkflows, dropped: [] as PlatformId[] }
  const dropped = TEMPLATE_PLATFORMS.filter((p) => !read.workflow[p] && (read.dropped.includes(p) || !!had?.includes(p)))
  return { ...(hasWorkflow(read.workflow) ? { workflow: read.workflow } : {}), ...(dropped.length ? { workflowDropped: dropped } : {}) }
}

/** A template's sections in their order (HI-1910), for whatever lists them. */
export const workflowPlatforms = (w: TemplateWorkflows | undefined): PlatformId[] => TEMPLATE_PLATFORMS.filter((p) => !!w?.[p])

/** The tokens a template's agent names may hold (#1123 names): the project's key, and the agent's number among its role. */
const NAME_TOKENS = /\{(key|n)\}/g

/** Whether a template's agent names hold the project's key (#1440): made only with a project's key, never a guess. */
export const usesKey = (agents: readonly Pick<TemplateAgent, 'name'>[]): boolean => agents.some((a) => a.name.includes('{key}'))

/** A name pattern made for a project (#1440): `{key}` its key, `{n}` the agent's number among those of that pattern. */
export const expandName = (pattern: string, key: string, n: number): string => pattern.replace(NAME_TOKENS, (_m, t: string) => (t === 'key' ? key : String(n)))

/**
 * A template's agent names for a project (#1123 names, #1440): each pattern made with the project's key (`HI-B1` in hive)
 * and the agent's number among the agents of the same pattern, from 1 (in Hive's own, `{key}-B{n}` is every builder:
 * its number among its role), so agents of one pattern never share a name. A name without tokens is itself.
 */
export function templateAgentNames(agents: readonly Pick<TemplateAgent, 'name' | 'role'>[], key: string): string[] {
  const count = new Map<string, number>()
  return agents.map((a) => {
    const n = (count.get(a.name.toLowerCase()) ?? 0) + 1
    count.set(a.name.toLowerCase(), n)
    return expandName(a.name, key, n)
  })
}

/**
 * A project's agent names as a template keeps them (#1440, Save Template's "Use the project key in names"): names
 * `<KEY>-<letters><number>` (HI-B1, HI-B2…) as `{key}-B{n}` when those of the letters are numbered 1, 2, 3… in the
 * agents' order, so loading makes them again; else each keeps its number (`{key}-B2`), as a `{n}` among fixed numbers
 * could make one of them twice. Any other name (Darren's HB1, "Docs") as it is.
 */
export function namePatterns(agents: readonly Pick<TemplateAgent, 'name' | 'role'>[], key: string): string[] {
  const shape = new RegExp(`^${key.replace(/[^A-Za-z]/g, '')}-([A-Za-z]+)(\\d+)$`, 'i')
  const found = agents.map((a) => shape.exec(a.name))
  const numbers = new Map<string, number[]>()
  for (const m of found) if (m) numbers.set(m[1].toLowerCase(), [...(numbers.get(m[1].toLowerCase()) ?? []), Number(m[2])])
  const counted = new Set([...numbers].filter(([, ns]) => ns.every((n, i) => n === i + 1)).map(([letters]) => letters))
  return agents.map((a, i) => {
    const m = found[i]
    return m ? `{key}-${m[1]}${counted.has(m[1].toLowerCase()) ? '{n}' : m[2]}` : a.name
  })
}

/** Whether a project's agent names follow its key (#1440: HI-B1…), so Save Template offers to keep them as patterns. */
export const namesFollowKey = (names: readonly string[], key: string | null | undefined): boolean => !!key && names.some((n) => new RegExp(`^${key.replace(/[^A-Za-z]/g, '')}-[A-Za-z]+\\d+$`, 'i').test(n))

/** A template's export file name: its name, made safe for a file name ("Build and review.combwork-template.json"). */
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
