import { basename } from 'path'
import { agentMsg, say } from '../shared/agentText'
import type { AgentDef, PageLayout, TemplateLoadPlan, WorkflowChange, WorkflowForm } from '../shared/types'
import type { TemplateAgent, TemplateEntry, TemplateScope } from '../shared/templates'
import type { PlatformId } from '../shared/platform/descriptors'
import { overlayTemplateWorkflow, TEMPLATE_PLATFORMS, type TemplateOptions, type TemplateWorkflowOverlay } from '../shared/workflow/templateOptions'
import { nameTaken, suggestTemplateAgentName } from '../shared/agentNames'
import { workspaceAgents } from './agentNames'
import { noteChange } from './assistantChanges'
import { CombworkError } from './combworkError'
import { agentField } from '../shared/advanced'
import { projectKeyOf } from './projectKeys'
import { applyConnections, connectionsPlan, listAllTemplates, listTemplates, loadTemplateWith, templatePlanEnglish } from './templates'
import { answerFor, loadFallback, optionNamed, type ConnectionAnswers, type ConnectionOption } from '../shared/templateConnections'
import { noteConnection } from './assistantChanges'
import { WORKFLOW_ROLES, type WorkflowRole } from '../shared/workflow/roles'
import { checkWorkflowChange, setWorkflowOptions, workflowForm, WorkflowRefused, WorkflowStale } from './workflow/optionsForm'
import { workspaceOf } from './workspace'

/**
 * The Combwork Assistant's template load through the Agent API (HI-1502, SPEC §16.10.6): its templates listed, a load
 * planned, and loaded with the window's load (templates.ts `loadTemplateWith`: its plan, checks, lock and fence), names
 * given for some of its agents, and its workflow (HI-1910) saved as the project's options, never Git set up. What it
 * changes is recorded for undo (assistantUndo.ts' `undoLoaded`). Its replies and refusals are English: agents read them.
 */

/** A refusal of the Agent API's, in English: its text said where it is made, in the caller's scope. */
const refused = (text: string, kind: 'invalid' | 'notFound' | 'conflict'): CombworkError => new CombworkError({ lines: [text] }, { kind })

/** The template routes' agent text (dialects, HI-2447): refusals and what a load or Choose Connections couldn't do. */
const T = {
  required: agentMsg({ id: 'template.find.required', text: 'template is required: its file or name, as list gives them', note: 'A template call named none.' }),
  scope: agentMsg({ id: 'template.find.scope', text: 'scope is combwork, workspace or project', note: "A template call's scope isn't one of the three. They are the argument's values." }),
  from: agentMsg({ id: 'template.find.from', text: 'from is a project name', note: "A template call's from isn't text." }),
  none: agentMsg({ id: 'template.find.none', text: 'No template "{template}"{scoped, select, yes { in the {scope} scope} other {}}{fromProject, select, yes { kept in {from}} other {}}: list gives them.', note: 'No template has that file or name, in the scope or project named, if any.' }),
  several: agentMsg({ id: 'template.find.several', text: 'Several templates are called "{template}": name one by scope and file ({choices}).', note: 'More than one template has that name: never one picked for the caller. {choices} lists each as "scope: file".' }),
  unusable: agentMsg({ id: 'template.find.unusable', text: "\"{name}\" can't be used: {problem}", note: "The template named can't be read or used. {problem} is why." }),
  namesObject: agentMsg({ id: 'template.names.notObject', text: "names is an object: an agent's place or name → its new name. Its agents: {keys}.", note: 'A load\'s names isn\'t an object. {keys} lists its agents as "place (name)".' }),
  namesText: agentMsg({ id: 'template.names.notText', text: "names.{key} is not text: give each agent's new name as a string.", note: "A new name in a load's names isn't text." }),
  namesRange: agentMsg({ id: 'template.names.range', text: 'names: {key} is out of range: the template has {count} agents ({keys}).', note: "A place in a load's names is beyond the template's agents. {count} is digits." }),
  namesNone: agentMsg({ id: 'template.names.none', text: 'names: no agent "{key}" in the template. Its agents: {keys}.', note: "A key in a load's names names no agent." }),
  namesSeveral: agentMsg({ id: 'template.names.several', text: 'names: "{key}" is {count} of its agents: name each by its place or name ({choices}).', note: "A key in a load's names is several agents' name. {count} is digits." }),
  namesBoth: agentMsg({ id: 'template.names.both', text: 'names: "{first}" and "{key}" both name agent {place} ({agent}): give it one name.', note: "Two keys in a load's names name the same agent." }),
  takenOne: agentMsg({ id: 'template.taken.one', text: "\"{name}\" is {project}'s agent: try \"{suggestion}\"", note: "A name a load would give is another project's agent's, with a free one to give instead. Joined by \"; \" into template.taken.refused." }),
  taken: agentMsg({ id: 'template.taken.refused', text: '{taken}. Agent names are unique across the workspace: give each a free name in names. Nothing was changed.', note: 'A load refused for names taken in other projects. {taken} is template.taken.one for each.' }),
  connObject: agentMsg({ id: 'template.connections.notObject', text: "connections is an object: \"*\", a role ({roles}), or an agent's place (\"1\") or name → a connection's id or name.", note: "A load's or Choose Connections' connections isn't an object (HI-2109). {roles} lists the roles." }),
  connText: agentMsg({ id: 'template.connections.notText', text: "connections.{key} is not a connection's id or name.", note: "An answer in connections isn't text." }),
  connRange: agentMsg({ id: 'template.connections.range', text: 'connections: {key} is out of range: there are {count} agents ({agents}).', note: 'A place in connections is beyond the agents. {count} is digits.' }),
  connSeveral: agentMsg({ id: 'template.connections.several', text: 'connections: "{key}" is {count} of its agents: name each by its place ({choices}).', note: "A key in connections is several agents' name. {count} is digits." }),
  connBoth: agentMsg({ id: 'template.connections.both', text: 'connections: "{first}" and "{key}" both name agent {place} ({agent}): give it one connection.', note: 'Two keys in connections name the same agent.' }),
  connBad: agentMsg({ id: 'template.connections.bad', text: 'connections: {keys} {count, plural, =1 {is} other {are}} not "*", a role ({roles}) or one of its agents: {agents}.', note: 'Keys in connections that are none of what it takes. {count} is how many, choosing the verb.' }),
  connRequired: agentMsg({ id: 'template.connections.required', text: "connections is required: \"*\", a role ({roles}), or an agent's place (\"1\") or name → a connection's id or name. Its agents: {agents}. Usable here: {usable}.", note: 'Choose Connections was given no answer. {usable} lists the connections it can use, or template.connections.none.' }),
  connAmbiguous: agentMsg({ id: 'template.connections.ambiguous', text: 'connections: several are called "{ref}": name one by its id ({ids}).', note: 'An answer in connections names several connections usable here. {ids} lists their ids.' }),
  connUnknown: agentMsg({ id: 'template.connections.unknown', text: 'connections: no connection "{ref}" can be used here (options lists those that can).', note: 'An answer in connections names no connection usable here.' }),
  connNone: agentMsg({ id: 'template.connections.none', text: 'none', note: 'No connection is usable here: the end of template.connections.required.' }),
  needsGit: agentMsg({ id: 'template.load.needsGit', text: "Its workflow is for Git and this project has no version control: set up Git in the project's Version Control first (that is the user's choice), or load with workflow: false for its agents alone.", note: "Why a template's workflow can't be loaded (HI-1910): Combwork never sets up Git for the Assistant." }),
  notYet: agentMsg({ id: 'template.load.notYet', text: "The template can't be loaded yet: {blocked}", note: 'A load refused: {blocked} is each reason, joined by spaces.' }),
  workflowCant: agentMsg({ id: 'template.load.workflowCant', text: "Its workflow can't be saved here: {problems}", note: "A load refused: the template's workflow doesn't fit this project. {problems} is each reason." }),
  optionsChanged: agentMsg({ id: 'template.load.optionsChanged', text: "its options changed meanwhile, so they weren't saved: set them in the project's Version Control", note: "Why a loaded template's workflow wasn't saved: the project's options changed while it loaded." }),
  skippedRunning: agentMsg({ id: 'template.apply.running', text: "it runs, and that connection is another CLI's: stop it first", note: "Why Choose Connections skipped an agent: a connection of another CLI can't apply while it runs." }),
  skippedGone: agentMsg({ id: 'template.apply.gone', text: 'it was removed meanwhile', note: 'Why Choose Connections skipped an agent: it was removed meanwhile.' })
}

/** A template as the Agent API lists it: where it is kept, its file and name, how many agents, its workflow's sections. */
export interface TemplateRow {
  scope: TemplateScope
  /** The project a project's template is kept in. */
  from?: string
  file: string
  name: string
  agents: number
  workflow: PlatformId[]
  /** Why it can't be used. */
  problem?: string
}

const rowOf = (e: TemplateEntry): TemplateRow => ({
  scope: e.scope,
  ...(e.scope === 'project' && e.project ? { from: basename(e.project) } : {}),
  file: e.file,
  name: e.name,
  agents: e.agents.length,
  workflow: TEMPLATE_PLATFORMS.filter((p) => !!e.workflow?.[p]),
  ...(e.problem ? { problem: agentField(e.problem, e.problemText) } : {})
})

/** The templates a project can use (Combwork's own, the workspace's and its own), as rows. */
export async function templateRows(projectPath: string): Promise<TemplateRow[]> {
  return (await listTemplates(projectPath)).map(rowOf)
}

/**
 * The template a call names: `template` is its file, else its name (any case), among the templates the project can use,
 * or those kept in the project `from`; `scope` narrows it. None is refused (404), several are refused naming each (409):
 * never one picked for the caller.
 */
export async function findTemplate(projectPath: string, a: { template?: unknown; scope?: unknown; from?: unknown }): Promise<TemplateEntry> {
  const template = typeof a.template === 'string' ? a.template.trim() : ''
  if (!template) throw refused(say(T.required), 'invalid')
  if (a.scope !== undefined && a.scope !== 'combwork' && a.scope !== 'workspace' && a.scope !== 'project') throw refused(say(T.scope), 'invalid')
  if (a.from !== undefined && typeof a.from !== 'string') throw refused(say(T.from), 'invalid')
  const from = typeof a.from === 'string' && a.from.trim() ? a.from.trim().toLowerCase() : null
  const all = from ? (await listAllTemplates()).filter((e) => e.scope === 'project' && !!e.project && basename(e.project).toLowerCase() === from) : await listTemplates(projectPath)
  const scoped = a.scope ? all.filter((e) => e.scope === a.scope) : all
  const byFile = scoped.filter((e) => e.file === template || e.file === `${template}.json`)
  const found = byFile.length ? byFile : scoped.filter((e) => e.name.toLowerCase() === template.toLowerCase())
  if (!found.length) throw refused(say(T.none, { template, scoped: a.scope ? 'yes' : 'no', scope: a.scope ? String(a.scope) : '', fromProject: from ? 'yes' : 'no', from: from ? (a.from as string) : '' }), 'notFound')
  if (found.length > 1) throw refused(say(T.several, { template, choices: found.map((e) => `${e.scope}${e.scope === 'project' && e.project ? ` ${basename(e.project)}` : ''}: ${e.file}`).join('; ') }), 'conflict')
  const e = found[0]
  if (e.problem) throw refused(say(T.unusable, { name: e.name, problem: agentField(e.problem, e.problemText) }), 'conflict')
  return e
}

/**
 * The names a call gives for some of a template's agents (`names`: key → name), as the full list the load takes (its
 * others keep the template's). A key is an agent's place (1 to how many it has), its name as made for this project
 * (`expanded`: AL-B2) or its name in the template (`raw`: {key}-B2) when only one agent has it. A key that names none,
 * several or one another key named too, a place out of range and a name that isn't text are refused, listing the keys
 * there are; the names themselves are checked by the load (empty, too long, used twice). None given: undefined.
 */
export function namesFromKeys(raw: readonly string[], expanded: readonly string[], given: unknown): string[] | undefined {
  if (given === undefined || given === null) return undefined
  const keys = (): string => expanded.map((n, i) => `${i + 1} (${n})`).join(', ')
  if (typeof given !== 'object' || Array.isArray(given)) throw refused(say(T.namesObject, { keys: keys() }), 'invalid')
  const out = [...expanded]
  const named = new Map<number, string>()
  for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
    if (typeof value !== 'string') throw refused(say(T.namesText, { key }), 'invalid')
    let at: number[]
    if (/^\d+$/.test(key)) {
      const n = Number(key)
      if (n < 1 || n > expanded.length) throw refused(say(T.namesRange, { key, count: String(expanded.length), keys: keys() }), 'invalid')
      at = [n - 1]
    } else {
      const k = key.trim().toLowerCase()
      const byName = expanded.flatMap((n, i) => (n.toLowerCase() === k ? [i] : []))
      at = byName.length ? byName : raw.flatMap((n, i) => (n.toLowerCase() === k ? [i] : []))
    }
    if (!at.length) throw refused(say(T.namesNone, { key, keys: keys() }), 'invalid')
    if (at.length > 1) throw refused(say(T.namesSeveral, { key, count: String(at.length), choices: at.map((i) => `${i + 1} (${expanded[i]})`).join(', ') }), 'invalid')
    const i = at[0]
    if (named.has(i)) throw refused(say(T.namesBoth, { first: String(named.get(i)), key, place: String(i + 1), agent: expanded[i] }), 'invalid')
    named.set(i, key)
    out[i] = value
  }
  return out
}

/** A project's options for its version control as the workflow's undo records them (HI-1502). */
export interface WorkflowOwn {
  platform: PlatformId
  preset: WorkflowForm['preset']
  options: WorkflowForm['own']
}
const ownOf = (f: WorkflowForm): WorkflowOwn => ({ platform: f.platform, preset: f.preset, options: f.own })

/** A template's workflow as a plan or a load reports it. */
export interface WorkflowShown {
  platform: PlatformId
  /** It has a section for this version control. */
  applies: boolean
  /** It has only Git's and the project has no version control (refused while workflow is true). */
  needsGit: boolean
  /** Its sections that can't be used (said). */
  dropped: PlatformId[]
  changes: TemplateWorkflowOverlay['changes']
  missingCommands: string[]
  identityOff: boolean
  /** Why its options can't be saved here. */
  problems: string[]
}

/** The workflow a plan would apply, laid over the project's options as they are now, and checked. */
async function workflowOf(projectPath: string, plan: TemplateLoadPlan): Promise<{ shown: WorkflowShown; change: WorkflowChange | null; before: WorkflowOwn } | null> {
  const wf = plan.workflow
  if (!wf) return null
  const ws = workspaceOf(projectPath)
  const form = await workflowForm(ws, projectPath)
  // Maximum agents is the user's team size (HI-2001): the Assistant's load never changes it, whatever the template's says.
  const section = wf.section ? { ...wf.section, options: Object.fromEntries(Object.entries(wf.section.options).filter(([k]) => k !== 'maxAgents')) as TemplateOptions } : null
  const overlay = section ? overlayTemplateWorkflow(section, { platform: form.platform, options: form.options, own: form.own, identity: form.identity }) : null
  const change: WorkflowChange | null = overlay ? { preset: overlay.preset, options: overlay.own, base: { preset: form.preset, options: form.own } } : null
  const problems = change ? (await checkWorkflowChange(ws, projectPath, change)).problems : []
  const shown: WorkflowShown = {
    platform: form.platform,
    applies: !!overlay,
    needsGit: wf.needsGit,
    dropped: wf.dropped,
    changes: overlay?.changes ?? [],
    missingCommands: overlay?.missingCommands ?? [],
    identityOff: overlay?.identityOff ?? false,
    problems: problems.length ? new WorkflowRefused(problems).message.split('\n') : []
  }
  return { shown, change, before: ownOf(form) }
}

/** A plan as the Agent API reports it (HI-1502). */
export interface TemplatePlanReply {
  project: string
  template: { scope: TemplateScope; file: string; name: string }
  remove: string[]
  /** Each agent's connection (HI-2109): `connections`' answer for it, else its role's preselected one; null: none usable. */
  create: { name: string; template: string; role: string; connection: string | null; pairedWith?: string }[]
  /** Names another project's agent has, each with a free one to give in names. */
  taken: { name: string; project: string; suggestion: string }[]
  /** The connections usable here, in the order: what `connections` may name. */
  options: ConnectionRow[]
  /** Why it can't be loaded now. */
  blocked: string[]
  workflow: WorkflowShown | null
}

/**
 * Each taken name with a free one to try (`suggestTemplateAgentName`), from the workspace's agents as they are now: their
 * names and the template's others (`chosen`) aren't.
 */
async function suggestions(projectPath: string, taken: readonly { name: string; project: string }[], chosen: readonly string[]): Promise<TemplatePlanReply['taken']> {
  if (!taken.length) return []
  const project = basename(projectPath)
  const key = await projectKeyOf(workspaceOf(projectPath), projectPath).catch(() => null)
  const others = (await workspaceAgents(projectPath)).filter((a) => a.project.toLowerCase() !== project.toLowerCase())
  const used = [...others.map((a) => a.name), ...chosen]
  const out: TemplatePlanReply['taken'] = []
  for (const t of taken) {
    const suggestion = suggestTemplateAgentName(t.name, project, key, [...used, ...out.map((o) => o.suggestion)])
    out.push({ ...t, suggestion })
  }
  return out
}

/** A load refused for names another project's agent has: each with a free one to give in names. */
async function takenRefusal(projectPath: string, taken: readonly { name: string; project: string }[], chosen: readonly string[]): Promise<CombworkError> {
  const free = await suggestions(projectPath, taken, chosen)
  return refused(say(T.taken, { taken: free.map((t) => say(T.takenOne, { name: t.name, project: t.project, suggestion: t.suggestion })).join('; ') }), 'conflict')
}

/** A connection usable here, as a reply lists it. */
export interface ConnectionRow {
  id: string
  name: string
  cli: string
  account: string
}

const optionRows = (options: readonly ConnectionOption[]): ConnectionRow[] => options.map((o) => ({ id: o.id, name: o.name, cli: o.cli, account: o.accountName }))

const ROLE_KEYS: readonly string[] = WORKFLOW_ROLES

/**
 * A call's `connections` (HI-2109), `{ key: connection }`, as the load and Choose Connections take them (all, roles and
 * agents apart: HR3's round 1, an agent called Builder never the builders'). A key is, in turn: `*`; a role, exactly as
 * the API names them (`builder`, lower case); an agent's place (`"1"`, as `names` takes it); else an agent's name, any
 * case, as made for this project or (`also`) in the template, made with the key (`AL-B2`) or as the template has it
 * (`{key}-B{n}`). A name several agents share, two keys for one agent, a
 * place out of range and a key that is none of them are said (English); an agent named exactly as a role is named by its
 * place.
 */
function answersOf(connections: unknown, agents: readonly { key: string; name: string; also?: readonly string[] }[]): { answers: ConnectionAnswers; problems: string[] } {
  if (connections === undefined || connections === null) return { answers: {}, problems: [] }
  if (typeof connections !== 'object' || Array.isArray(connections)) return { answers: {}, problems: [say(T.connObject, { roles: ROLE_KEYS.join(', ') })] }
  const listed = (): string => agents.map((a, i) => `${i + 1} (${a.name})`).join(', ')
  const roles: NonNullable<ConnectionAnswers['roles']> = {}
  const own: Record<string, string> = {}
  const by = new Map<number, string>()
  let all: string | undefined
  const problems: string[] = []
  const bad: string[] = []
  for (const [k, v] of Object.entries(connections as Record<string, unknown>)) {
    if (typeof v !== 'string' || !v.trim()) {
      problems.push(say(T.connText, { key: k }))
      continue
    }
    if (k === '*') all = v
    else if (ROLE_KEYS.includes(k)) roles[k as WorkflowRole] = v
    else {
      let at: number[]
      if (/^\d+$/.test(k)) {
        const n = Number(k)
        if (n < 1 || n > agents.length) {
          problems.push(say(T.connRange, { key: k, count: String(agents.length), agents: listed() }))
          continue
        }
        at = [n - 1]
      } else {
        const name = k.trim().toLowerCase()
        const byName = agents.flatMap((a, i) => (a.name.toLowerCase() === name ? [i] : []))
        at = byName.length ? byName : agents.flatMap((a, i) => (a.also?.some((n) => n.toLowerCase() === name) ? [i] : []))
      }
      if (!at.length) bad.push(k)
      else if (at.length > 1) problems.push(say(T.connSeveral, { key: k, count: String(at.length), choices: at.map((i) => `${i + 1} (${agents[i].name})`).join(', ') }))
      else if (by.has(at[0])) problems.push(say(T.connBoth, { first: String(by.get(at[0])), key: k, place: String(at[0] + 1), agent: agents[at[0]].name }))
      else {
        by.set(at[0], k)
        own[agents[at[0]].key] = v
      }
    }
  }
  if (bad.length) problems.push(say(T.connBad, { keys: bad.join(', '), count: bad.length, roles: ROLE_KEYS.join(', '), agents: listed() }))
  const answers: ConnectionAnswers = { ...(all ? { all } : {}), ...(Object.keys(roles).length ? { roles } : {}), ...(Object.keys(own).length ? { agents: own } : {}) }
  return { answers, problems }
}

/** Each agent's connection by the answers, by name; what can't be used here said (English). */
function namedConnections(refs: readonly (string | undefined)[], options: readonly ConnectionOption[]): { names: (string | null)[]; problems: string[] } {
  const problems = new Set<string>()
  const names = refs.map((ref) => {
    if (ref === undefined) return null
    const found = optionNamed(options, ref)
    if (found.ok) return found.option.name
    problems.add(found.why === 'ambiguous' ? say(T.connAmbiguous, { ref, ids: (found.ids ?? []).join(', ') }) : say(T.connUnknown, { ref }))
    return null
  })
  return { names, problems: [...problems] }
}

/** The plan with the names given (`names`), its workflow checked, as the Agent API reports it; nothing is changed. */
export async function planReply(projectPath: string, e: TemplateEntry, names: unknown, applyWorkflow: boolean, connections?: unknown): Promise<{ reply: TemplatePlanReply; plan: TemplateLoadPlan }> {
  const from = e.scope === 'project' ? e.project : undefined
  const first = await templatePlanEnglish(projectPath, e.scope, e.file, from)
  const chosen = namesFromKeys(e.agents.map((a: TemplateAgent) => a.name), first.plan.templateNames, names)
  const { plan, why } = chosen ? await templatePlanEnglish(projectPath, e.scope, e.file, from, chosen) : first
  const wf = await workflowOf(projectPath, plan)
  // Each agent's connection (HI-2109): as the load would give it.
  // Each by its name in the template as made for the project (`templateNames`): what the load binds its own choice to.
  const agents = plan.create.map((a, i) => ({ key: plan.templateNames[i], name: a.name, role: a.role, provider: a.provider, also: [plan.templateNames[i], e.agents[i]?.name ?? ''] }))
  const asked = answersOf(connections, agents)
  const conn = namedConnections(answerFor(agents, asked.answers, loadFallback(agents, plan.options)), plan.options)
  const name = (i: number): string | undefined => plan.create[i]?.name
  const reply: TemplatePlanReply = {
    project: basename(projectPath),
    template: { scope: plan.scope, file: plan.file, name: plan.name },
    remove: plan.remove.map((a) => a.name),
    create: plan.create.map((a, i) => {
      const pair = plan.pairs.find((p) => p.builder === i || p.reviewer === i)
      const partner = pair ? name(pair.builder === i ? pair.reviewer : pair.builder) : undefined
      return { name: a.name, template: plan.templateNames[i], role: a.role, connection: conn.names[i], ...(partner ? { pairedWith: partner } : {}) }
    }),
    taken: await suggestions(projectPath, plan.taken, plan.create.map((a) => a.name)),
    options: optionRows(plan.options),
    blocked: [...why, ...asked.problems, ...conn.problems, ...(applyWorkflow && wf?.shown.needsGit ? [say(T.needsGit)] : []), ...(applyWorkflow ? (wf?.shown.problems ?? []) : [])],
    workflow: wf?.shown ?? null
  }
  return { reply, plan }
}


/** A load as the Agent API reports it (HI-1502). */
export interface TemplateLoadReply {
  project: string
  template: { scope: TemplateScope; file: string; name: string }
  removed: string[]
  created: string[]
  /** Created agents named by `names`: their template names and the names they got. */
  renamed: { template: string; name: string }[]
  /** Each created agent's connection (HI-2109), by name. */
  connections: { name: string; connection: string }[]
  /** Its workflow: saved (with what changed), or why not; null when it has none for this project or workflow was false. */
  workflow: (WorkflowShown & { saved: boolean; notSaved?: string }) | null
}

/** What the load recorded for undo: the agents and layout, and the workflow when it was saved. */
interface Recorded {
  agents: { before: { agents: AgentDef[]; layout: PageLayout }; after: { agents: AgentDef[]; layout: PageLayout } }
  workflow?: { before: WorkflowOwn; after: WorkflowOwn }
}

/** A value as undo keeps it: what JSON says (no undefined members). */
const kept = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/**
 * Loads a template into the project as the Combwork Assistant asked (the route's assistantChange holds it): refused first
 * with a free name for each taken one, and, with `applyWorkflow`, when its workflow needs Git or can't be saved here.
 * The load itself checks its workflow again inside its guard (`check`), on the plan it stages, so the agents and the
 * options saved are one read of the template; the options are saved once the agents are published, against the
 * project's as read then (changed meanwhile: not saved, said). `guard` (the Assistant's control and launch) is checked at
 * each write, under its lock: refused before the agents are published, nothing changes; after, the options aren't saved
 * and the reply says why. Each is recorded for undo.
 */
export async function loadForAssistant(projectPath: string, e: TemplateEntry, names: unknown, applyWorkflow: boolean, guard?: () => void, connections?: unknown): Promise<TemplateLoadReply> {
  const ws = workspaceOf(projectPath)
  const from = e.scope === 'project' ? e.project : undefined
  const { reply: planned, plan: shown } = await planReply(projectPath, e, names, applyWorkflow, connections)
  const chosenNames = shown.create.map((a) => a.name)
  if (planned.taken.length) throw await takenRefusal(projectPath, planned.taken, chosenNames)
  if (planned.blocked.length) throw refused(say(T.notYet, { blocked: planned.blocked.join(' ') }), 'conflict')
  const chosen = namesFromKeys(e.agents.map((a: TemplateAgent) => a.name), shown.templateNames, names)
  let wf: Awaited<ReturnType<typeof workflowOf>> = null
  const loaded = await loadTemplateWith(projectPath, e.scope, e.file, shown.remove.map((a) => a.id), {
    from,
    names: chosen,
    // The answers for its agents (HI-2109), by the names they get; none for one: its role's preselected connection, as
    // the window's dialog starts with.
    connections: answersOf(connections, shown.create.map((a, i) => ({ key: shown.templateNames[i], name: a.name, also: [shown.templateNames[i], e.agents[i]?.name ?? ''] }))).answers,
    // The Assistant's guard at the publish itself, and every name taken since this plan refused with a free one too.
    guard,
    taken: (clash) => takenRefusal(projectPath, clash, chosenNames),
    check: async (plan) => {
      wf = applyWorkflow ? await workflowOf(projectPath, plan) : null
      if (wf?.shown.needsGit) throw refused(say(T.needsGit), 'conflict')
      if (wf?.shown.problems.length) throw refused(say(T.workflowCant, { problems: wf.shown.problems.join(' ') }), 'conflict')
    }
  })
  const recorded: Recorded = { agents: { before: kept(loaded.before), after: kept(loaded.after) } }
  await noteChange(ws, { kind: 'agent', project: basename(projectPath), fields: [{ field: 'agents', old: recorded.agents.before.agents, new: recorded.agents.after.agents }, { field: 'layout', old: recorded.agents.before.layout, new: recorded.agents.after.layout }] })
  // Its options, as the load's own plan read them (never read again), over the project's as they were then.
  const w = wf as Awaited<ReturnType<typeof workflowOf>>
  let workflow: TemplateLoadReply['workflow'] = null
  if (w?.change) {
    try {
      const saved = await setWorkflowOptions(ws, projectPath, w.change, { ...(guard ? { check: guard } : {}) })
      recorded.workflow = { before: kept(w.before), after: kept(ownOf(saved)) }
      await noteChange(ws, { kind: 'agent', project: basename(projectPath), fields: [{ field: 'workflow', old: recorded.workflow.before, new: recorded.workflow.after }] })
      workflow = { ...w.shown, saved: true }
    } catch (err) {
      workflow = { ...w.shown, saved: false, notSaved: err instanceof WorkflowStale ? say(T.optionsChanged) : (err as Error).message }
    }
  } else if (w) workflow = { ...w.shown, saved: false }
  const template = loaded.plan.templateNames
  return {
    project: basename(projectPath),
    template: { scope: loaded.plan.scope, file: loaded.plan.file, name: loaded.plan.name },
    removed: loaded.removed,
    created: loaded.created,
    renamed: loaded.created.flatMap((n, i) => (n !== template[i] ? [{ template: template[i], name: n }] : [])),
    connections: loaded.after.agents.map((a) => ({ name: a.name, connection: loaded.plan.options.find((o) => o.id === a.connection)?.name ?? a.connection ?? '' })),
    workflow
  }
}

/** Choose Connections… as the Agent API reports it (HI-2109): the agents changed, those to restart, those skipped and why. */
export interface ConnectionsApplyReply {
  project: string
  changed: { name: string; connection: string }[]
  restart: string[]
  skipped: { name: string; why: string }[]
}

const SKIPPED = { running: T.skippedRunning, gone: T.skippedGone } as const

/**
 * Choose Connections… for the Combwork Assistant (HI-2109): the project's existing agents given connections by `connections`
 * (`*`, a role or an agent's name → a connection's id or name), nothing loaded or replaced, each change recorded for undo
 * (as Agent Settings' are) and the guard checked in each agent's write. Every answer is checked first; none given lists
 * the agents and options without changing anything.
 */
export async function applyForAssistant(projectPath: string, connections: unknown, guard?: () => void): Promise<ConnectionsApplyReply> {
  const ws = workspaceOf(projectPath)
  const plan = await connectionsPlan(projectPath)
  // Each agent by its id, and the apply bound to these agents (`expected`): one added, removed or moved since refuses it.
  const agents = plan.agents.map((a) => ({ ...a, key: a.id }))
  const asked = answersOf(connections, agents)
  // agent-text: answersOf
  if (asked.problems.length) throw refused(asked.problems.join(' '), 'invalid')
  if (!asked.answers.all && !Object.keys(asked.answers.roles ?? {}).length && !Object.keys(asked.answers.agents ?? {}).length) throw refused(say(T.connRequired, { roles: ROLE_KEYS.join(', '), agents: plan.agents.map((a) => `${a.name} (${a.role})`).join(', '), usable: plan.options.map((o) => `${o.name} (${o.id})`).join(', ') || say(T.connNone) }), 'invalid')
  const named = namedConnections(answerFor(agents, asked.answers, () => undefined), plan.options)
  // agent-text: namedConnections
  if (named.problems.length) throw refused(named.problems.join(' '), 'conflict')
  const done = await applyConnections(projectPath, asked.answers, { expected: plan.agents.map((a) => a.id), check: () => guard?.(), changed: (was, now) => noteConnection(ws, basename(projectPath), was, now) })
  const byName = new Map(plan.agents.map((a, i) => [a.name, named.names[i]]))
  return {
    project: basename(projectPath),
    changed: done.changed.map((n) => ({ name: n, connection: byName.get(n) ?? '' })),
    restart: done.restart.map((r) => r.name),
    skipped: done.skipped.map((s) => ({ name: s.name, why: say(SKIPPED[s.why]) }))
  }
}

/** Whether a name is another project's agent's now (undo's check, HI-1502). */
export async function takenElsewhere(projectPath: string, names: readonly string[]): Promise<{ name: string; project: string }[]> {
  const others = (await workspaceAgents(projectPath)).filter((a) => a.project.toLowerCase() !== basename(projectPath).toLowerCase())
  return names.flatMap((n) => {
    const owner = nameTaken(n, others)
    return owner ? [{ name: n, project: owner.project }] : []
  })
}
