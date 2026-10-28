import { basename } from 'path'
import type { AgentDef, PageLayout, TemplateLoadPlan, WorkflowChange, WorkflowForm } from '../shared/types'
import type { TemplateAgent, TemplateEntry, TemplateScope } from '../shared/templates'
import type { PlatformId } from '../shared/platform/descriptors'
import { overlayTemplateWorkflow, TEMPLATE_PLATFORMS, type TemplateWorkflowOverlay } from '../shared/workflow/templateOptions'
import { nameTaken, suggestTemplateAgentName } from '../shared/agentNames'
import { workspaceAgents } from './agentNames'
import { noteChange } from './assistantChanges'
import { HiveError } from './hiveError'
import { projectKeyOf } from './projectKeys'
import { listAllTemplates, listTemplates, loadTemplateWith, templatePlanEnglish } from './templates'
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
  ...(e.problem ? { problem: e.problem } : {})
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
  if (e.problem) throw refused(`"${e.name}" can't be used: ${e.problem}`, 'conflict')
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
  const overlay = wf.section ? overlayTemplateWorkflow(wf.section, { platform: form.platform, options: form.options, own: form.own, identity: form.identity }) : null
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
  create: { name: string; template: string; role: string; provider: string; pairedWith?: string }[]
  /** Names another project's agent has, each with a free one to give in names. */
  taken: { name: string; project: string; suggestion: string }[]
  /** Agents whose own connection can't be used here: they get the workspace's default. */
  connections: string[]
  /** Why it can't be loaded now. */
  blocked: string[]
  workflow: WorkflowShown | null
}

/** Each taken name with a free one to try (`suggestTemplateAgentName`): the workspace's names and the template's others aren't. */
async function suggestions(projectPath: string, plan: TemplateLoadPlan): Promise<TemplatePlanReply['taken']> {
  if (!plan.taken.length) return []
  const project = basename(projectPath)
  const key = await projectKeyOf(workspaceOf(projectPath), projectPath).catch(() => null)
  const others = (await workspaceAgents(projectPath)).filter((a) => a.project.toLowerCase() !== project.toLowerCase())
  const used = [...others.map((a) => a.name), ...plan.create.map((a) => a.name)]
  const out: TemplatePlanReply['taken'] = []
  for (const t of plan.taken) {
    const suggestion = suggestTemplateAgentName(t.name, project, key, [...used, ...out.map((o) => o.suggestion)])
    out.push({ ...t, suggestion })
  }
  return out
}

/** The plan with the names given (`names`), its workflow checked, as the Agent API reports it; nothing is changed. */
export async function planReply(projectPath: string, e: TemplateEntry, names: unknown, applyWorkflow: boolean): Promise<{ reply: TemplatePlanReply; plan: TemplateLoadPlan }> {
  const from = e.scope === 'project' ? e.project : undefined
  const first = await templatePlanEnglish(projectPath, e.scope, e.file, from)
  const chosen = namesFromKeys(e.agents.map((a: TemplateAgent) => a.name), first.plan.templateNames, names)
  const { plan, why } = chosen ? await templatePlanEnglish(projectPath, e.scope, e.file, from, chosen) : first
  const wf = await workflowOf(projectPath, plan)
  const name = (i: number): string | undefined => plan.create[i]?.name
  const reply: TemplatePlanReply = {
    project: basename(projectPath),
    template: { scope: plan.scope, file: plan.file, name: plan.name },
    remove: plan.remove.map((a) => a.name),
    create: plan.create.map((a, i) => {
      const pair = plan.pairs.find((p) => p.builder === i || p.reviewer === i)
      const partner = pair ? name(pair.builder === i ? pair.reviewer : pair.builder) : undefined
      return { name: a.name, template: plan.templateNames[i], role: a.role, provider: a.provider, ...(partner ? { pairedWith: partner } : {}) }
    }),
    taken: await suggestions(projectPath, plan),
    connections: plan.connections.map((c) => plan.create[c.index]?.name ?? String(c.index)),
    blocked: [...why, ...(applyWorkflow && wf?.shown.needsGit ? [NEEDS_GIT] : []), ...(applyWorkflow ? (wf?.shown.problems ?? []) : [])],
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
  /** Agents whose own connection can't be used here: they got the workspace's default. */
  connections: string[]
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
 * project's as read then (changed meanwhile: not saved, said). Each is recorded for undo.
 */
export async function loadForAssistant(projectPath: string, e: TemplateEntry, names: unknown, applyWorkflow: boolean): Promise<TemplateLoadReply> {
  const ws = workspaceOf(projectPath)
  const from = e.scope === 'project' ? e.project : undefined
  const { reply: planned, plan: shown } = await planReply(projectPath, e, names, applyWorkflow)
  if (planned.taken.length) throw refused(`${planned.taken.map((t) => `"${t.name}" is ${t.project}'s agent: try "${t.suggestion}"`).join('; ')}. Agent names are unique across the workspace: give each a free name in names.`, 'conflict')
  if (planned.blocked.length) throw refused(`The template can't be loaded yet: ${planned.blocked.join(' ')}`, 'conflict')
  const chosen = namesFromKeys(e.agents.map((a: TemplateAgent) => a.name), shown.templateNames, names)
  let wf: Awaited<ReturnType<typeof workflowOf>> = null
  const loaded = await loadTemplateWith(projectPath, e.scope, e.file, shown.remove.map((a) => a.id), {
    from,
    names: chosen,
    // The connections the plan flags take the workspace's default, as the window's dialog does unless changed.
    connections: Object.fromEntries(shown.connections.map((c) => [c.index, null])),
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
      const saved = await setWorkflowOptions(ws, projectPath, w.change)
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
    connections: loaded.plan.connections.map((c) => loaded.created[c.index] ?? String(c.index)),
    workflow
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
