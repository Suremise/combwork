import { basename } from 'path'
import type { AgentDef, PageLayout, TemplateLoadPlan, WorkflowChange, WorkflowForm } from '../shared/types'
import type { TemplateAgent, TemplateEntry, TemplateScope } from '../shared/templates'
import type { PlatformId } from '../shared/platform/descriptors'
import { overlayTemplateWorkflow, TEMPLATE_PLATFORMS, type TemplateOptions, type TemplateWorkflowOverlay } from '../shared/workflow/templateOptions'
import { nameTaken, suggestTemplateAgentName } from '../shared/agentNames'
import { workspaceAgents } from './agentNames'
import { noteChange } from './assistantChanges'
import { HiveError } from './hiveError'
import { agentField } from '../shared/advanced'
import { projectKeyOf } from './projectKeys'
import { applyConnections, connectionsPlan, listAllTemplates, listTemplates, loadTemplateWith, templatePlanEnglish } from './templates'
import { answerFor, loadFallback, optionNamed, type ConnectionAnswers, type ConnectionOption } from '../shared/templateConnections'
import { noteConnection } from './assistantChanges'
import { WORKFLOW_ROLES, type WorkflowRole } from '../shared/workflow/roles'
import { checkWorkflowChange, setWorkflowOptions, workflowForm, WorkflowRefused, WorkflowStale } from './workflow/optionsForm'
import { workspaceOf } from './workspace'

/**
 * The Hive Assistant's template load through the Agent API (HI-1502, SPEC §16.10.6): its templates listed, a load
 * planned, and loaded with the window's load (templates.ts `loadTemplateWith`: its plan, checks, lock and fence), names
 * given for some of its agents, and its workflow (HI-1910) saved as the project's options, never Git set up. What it
 * changes is recorded for undo (assistantUndo.ts' `undoLoaded`). Its replies and refusals are English: agents read them.
 */

/** A refusal of the Agent API's, in English. */
const refused = (text: string, kind: 'invalid' | 'notFound' | 'conflict'): HiveError => new HiveError({ lines: [text] }, { kind })

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

/** The templates a project can use (Hive's own, the workspace's and its own), as rows. */
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
  if (!template) throw refused('template is required: its file or name, as list gives them', 'invalid')
  if (a.scope !== undefined && a.scope !== 'hive' && a.scope !== 'workspace' && a.scope !== 'project') throw refused('scope is hive, workspace or project', 'invalid')
  if (a.from !== undefined && typeof a.from !== 'string') throw refused('from is a project name', 'invalid')
  const from = typeof a.from === 'string' && a.from.trim() ? a.from.trim().toLowerCase() : null
  const all = from ? (await listAllTemplates()).filter((e) => e.scope === 'project' && !!e.project && basename(e.project).toLowerCase() === from) : await listTemplates(projectPath)
  const scoped = a.scope ? all.filter((e) => e.scope === a.scope) : all
  const byFile = scoped.filter((e) => e.file === template || e.file === `${template}.json`)
  const found = byFile.length ? byFile : scoped.filter((e) => e.name.toLowerCase() === template.toLowerCase())
  if (!found.length) throw refused(`No template "${template}"${a.scope ? ` in the ${String(a.scope)} scope` : ''}${from ? ` kept in ${a.from as string}` : ''}: list gives them.`, 'notFound')
  if (found.length > 1) throw refused(`Several templates are called "${template}": name one by scope and file (${found.map((e) => `${e.scope}${e.scope === 'project' && e.project ? ` ${basename(e.project)}` : ''}: ${e.file}`).join('; ')}).`, 'conflict')
  const e = found[0]
  if (e.problem) throw refused(`"${e.name}" can't be used: ${agentField(e.problem, e.problemText)}`, 'conflict')
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
  if (typeof given !== 'object' || Array.isArray(given)) throw refused(`names is an object: an agent's place or name → its new name. Its agents: ${keys()}.`, 'invalid')
  const out = [...expanded]
  const named = new Map<number, string>()
  for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
    if (typeof value !== 'string') throw refused(`names.${key} is not text: give each agent's new name as a string.`, 'invalid')
    let at: number[]
    if (/^\d+$/.test(key)) {
      const n = Number(key)
      if (n < 1 || n > expanded.length) throw refused(`names: ${key} is out of range: the template has ${expanded.length} agents (${keys()}).`, 'invalid')
      at = [n - 1]
    } else {
      const k = key.trim().toLowerCase()
      const byName = expanded.flatMap((n, i) => (n.toLowerCase() === k ? [i] : []))
      at = byName.length ? byName : raw.flatMap((n, i) => (n.toLowerCase() === k ? [i] : []))
    }
    if (!at.length) throw refused(`names: no agent "${key}" in the template. Its agents: ${keys()}.`, 'invalid')
    if (at.length > 1) throw refused(`names: "${key}" is ${at.length} of its agents: name each by its place or name (${at.map((i) => `${i + 1} (${expanded[i]})`).join(', ')}).`, 'invalid')
    const i = at[0]
    if (named.has(i)) throw refused(`names: "${named.get(i)}" and "${key}" both name agent ${i + 1} (${expanded[i]}): give it one name.`, 'invalid')
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
async function takenRefusal(projectPath: string, taken: readonly { name: string; project: string }[], chosen: readonly string[]): Promise<HiveError> {
  const free = await suggestions(projectPath, taken, chosen)
  return refused(`${free.map((t) => `"${t.name}" is ${t.project}'s agent: try "${t.suggestion}"`).join('; ')}. Agent names are unique across the workspace: give each a free name in names. Nothing was changed.`, 'conflict')
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
  if (typeof connections !== 'object' || Array.isArray(connections)) return { answers: {}, problems: [`connections is an object: "*", a role (${ROLE_KEYS.join(', ')}), or an agent's place ("1") or name → a connection's id or name.`] }
  const listed = (): string => agents.map((a, i) => `${i + 1} (${a.name})`).join(', ')
  const roles: NonNullable<ConnectionAnswers['roles']> = {}
  const own: Record<string, string> = {}
  const by = new Map<number, string>()
  let all: string | undefined
  const problems: string[] = []
  const bad: string[] = []
  for (const [k, v] of Object.entries(connections as Record<string, unknown>)) {
    if (typeof v !== 'string' || !v.trim()) {
      problems.push(`connections.${k} is not a connection's id or name.`)
      continue
    }
    if (k === '*') all = v
    else if (ROLE_KEYS.includes(k)) roles[k as WorkflowRole] = v
    else {
      let at: number[]
      if (/^\d+$/.test(k)) {
        const n = Number(k)
        if (n < 1 || n > agents.length) {
          problems.push(`connections: ${k} is out of range: there are ${agents.length} agents (${listed()}).`)
          continue
        }
        at = [n - 1]
      } else {
        const name = k.trim().toLowerCase()
        const byName = agents.flatMap((a, i) => (a.name.toLowerCase() === name ? [i] : []))
        at = byName.length ? byName : agents.flatMap((a, i) => (a.also?.some((n) => n.toLowerCase() === name) ? [i] : []))
      }
      if (!at.length) bad.push(k)
      else if (at.length > 1) problems.push(`connections: "${k}" is ${at.length} of its agents: name each by its place (${at.map((i) => `${i + 1} (${agents[i].name})`).join(', ')}).`)
      else if (by.has(at[0])) problems.push(`connections: "${by.get(at[0])}" and "${k}" both name agent ${at[0] + 1} (${agents[at[0]].name}): give it one connection.`)
      else {
        by.set(at[0], k)
        own[agents[at[0]].key] = v
      }
    }
  }
  if (bad.length) problems.push(`connections: ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not "*", a role (${ROLE_KEYS.join(', ')}) or one of its agents: ${listed()}.`)
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
    problems.add(found.why === 'ambiguous' ? `connections: several are called "${ref}": name one by its id (${(found.ids ?? []).join(', ')}).` : `connections: no connection "${ref}" can be used here (options lists those that can).`)
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
    blocked: [...why, ...asked.problems, ...conn.problems, ...(applyWorkflow && wf?.shown.needsGit ? [NEEDS_GIT] : []), ...(applyWorkflow ? (wf?.shown.problems ?? []) : [])],
    workflow: wf?.shown ?? null
  }
  return { reply, plan }
}

const NEEDS_GIT = "Its workflow is for Git and this project has no version control: set up Git in the project's Version Control first (that is the user's choice), or load with workflow: false for its agents alone."

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
 * Loads a template into the project as the Hive Assistant asked (the route's assistantChange holds it): refused first
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
  if (planned.blocked.length) throw refused(`The template can't be loaded yet: ${planned.blocked.join(' ')}`, 'conflict')
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
      if (wf?.shown.needsGit) throw refused(NEEDS_GIT, 'conflict')
      if (wf?.shown.problems.length) throw refused(`Its workflow can't be saved here: ${wf.shown.problems.join(' ')}`, 'conflict')
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
      workflow = { ...w.shown, saved: false, notSaved: err instanceof WorkflowStale ? "its options changed meanwhile, so they weren't saved: set them in the project's Version Control" : (err as Error).message }
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

const SKIPPED: Record<'running' | 'gone', string> = { running: "it runs, and that connection is another CLI's: stop it first", gone: 'it was removed meanwhile' }

/**
 * Choose Connections… for the Hive Assistant (HI-2109): the project's existing agents given connections by `connections`
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
  if (!asked.answers.all && !Object.keys(asked.answers.roles ?? {}).length && !Object.keys(asked.answers.agents ?? {}).length) throw refused(`connections is required: "*", a role (${ROLE_KEYS.join(', ')}), or an agent's place ("1") or name → a connection's id or name. Its agents: ${plan.agents.map((a) => `${a.name} (${a.role})`).join(', ')}. Usable here: ${plan.options.map((o) => `${o.name} (${o.id})`).join(', ') || 'none'}.`, 'invalid')
  const named = namedConnections(answerFor(agents, asked.answers, () => undefined), plan.options)
  // agent-text: namedConnections
  if (named.problems.length) throw refused(named.problems.join(' '), 'conflict')
  const done = await applyConnections(projectPath, asked.answers, { expected: plan.agents.map((a) => a.id), check: () => guard?.(), changed: (was, now) => noteConnection(ws, basename(projectPath), was, now) })
  const byName = new Map(plan.agents.map((a, i) => [a.name, named.names[i]]))
  return {
    project: basename(projectPath),
    changed: done.changed.map((n) => ({ name: n, connection: byName.get(n) ?? '' })),
    restart: done.restart.map((r) => r.name),
    skipped: done.skipped.map((s) => ({ name: s.name, why: SKIPPED[s.why] }))
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
