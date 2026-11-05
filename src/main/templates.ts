import { existsSync } from 'original-fs'
import { mkdir, readFile, readdir, stat } from 'original-fs/promises'
import { basename, join, resolve } from 'path'
import { AGENT_LIMIT_MAX, CW_DIR, agentLimitText, projectAgents } from '../shared/defaults'
import { agentProvider, isKnownProvider, isProviderEnabled, PROVIDERS } from '../shared/providers'
import {
  exportable,
  exportFileName,
  isAgentTemplate,
  isTemplateFile,
  readTemplate,
  TEMPLATE_VERSION,
  templateAgentNames,
  templatePairs,
  pairIndex,
  pairNames,
  usesKey,
  templateFile,
  templateFrom,
  uniqueName,
  uniqueTemplateName,
  unknownProviders,
  TEMPLATE_IMPORT_MAX,
  TEMPLATE_NAME_MAX,
  templateLimitText,
  type AgentTemplate,
  type SuggestedPreset,
  type TemplateDest,
  type TemplateEntry,
  type TemplateRef,
  type TemplateAgent,
  type TemplateScope
} from '../shared/templates'
import { CW_TEMPLATES, hiveTemplate, type HiveTemplate } from '../shared/templateDefaults'
import type { AgentBranchStatus, AgentDef, PageLayout, ProjectConfig, ProviderId, TemplateLoadPlan, TemplateLoadWorkflow } from '../shared/types'
import { answerFor, badAnswers, loadFallback, optionNamed, optionOf, type ConnectionAnswers, type ConnectionOption, type ConnectionsApplied, type ConnectionsPlan, type PickedAgent } from '../shared/templateConnections'
import { accountOnIn, connectionsOn } from '../shared/accounts'
import { agentWorkflowRole } from '../shared/workflow/roles'
import { hasWorkflow, loadedMaxAgents, overlayTemplateWorkflow, readTemplateWorkflow, templateWorkflowOf, TEMPLATE_PLATFORMS, type TemplateWorkflow, type TemplateWorkflows } from '../shared/workflow/templateOptions'
import type { PlatformId } from '../shared/platform/descriptors'
import { ownPreferenceChange, workflowForm } from './workflow/optionsForm'
import { workflowChanged } from './workflow/rulesets'
import { config } from './config'
import { placeKey, readKeptJson, withFileLock, writeKeptJson, writeTextAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { addAgent, agentMax, agentsGone, prepareAgent, updateAgent, type AddedBy } from './projectAgents'
import { accountHere, allAccounts, allConnections, assertConnectionHere, firstAccountHere, getConnection } from './accounts'
import { ensureMigrated } from './connectionMoves'
import { projectKeyOf } from './projectKeys'
import { providerService } from './providerService'
import { sessions } from './sessions'
import { workspace, workspaceOf } from './workspace'
import * as wt from './worktrees'
import { legacySetupPending, legacyWorktree } from '../shared/agentFolders'
import { agentText, englishText, listOf, shownText, withValues, type Text, type TextPart, type TextValues } from '../shared/advanced'
import { msg, tr, type Msg } from '../shared/i18n'
import { errorText, HiveError } from './hiveError'
import { trash } from './trash'
import { withAgentNames, workspaceAgents } from './agentNames'
import { AGENT_NAME_MAX, agentNameProblem, nameTaken, sameAgentName } from '../shared/agentNames'

/**
 * Agent templates (#126): a project's agents and layout saved under a name, in the workspace (`<workspace>/.combwork/
 * templates`, for every project) or the project (`<project>/.combwork/templates`, private: the project's .combwork is kept out
 * of git). One kept JSON file each (a damaged one is recovered from its copy). Loading one replaces the project's agents
 * — only when it is safe (none running, no uncommitted work in their worktrees, every provider on and installed), and
 * all or nothing; adding one agent from a template leaves the others alone. #127: listing every scope, rename,
 * duplicate, delete (to the Recycle Bin), and export and import as files, read as untrusted. #1436: Hive's own templates
 * (the Hive scope, read-only, `shared/templateDefaults.ts`), and agents created in the project folder with their role
 * in the workflow, note and pairing. HI-1910: its workflow, a section per version control (the rules of the project's
 * options, never its own facts: workflow/templateOptions.ts), saved with the agents when asked, shown and laid over a
 * project's options when it is loaded, to save in its Workflow form.
 */

const log = createLogger('templates')

/** A template that isn't there, or can't be used: the caller says so as it is, in the window's language (#849). */
export class TemplateError extends HiveError {}

/** A refusal from a message and its values. */
const refusal = (m: Msg, values?: TextValues, kind?: 'invalid' | 'notFound' | 'conflict'): TemplateError => new TemplateError(values ? withValues(m, values) : m, kind ? { kind } : undefined)

/** Templates' refusals and the load plan's reasons, which only the window reads (#849): IPC shows them in its language. */
const M = {
  loading: msg({ id: 'content.templates.loading', defaultMessage: 'A template is already being loaded into this project.', description: 'An error loading a template while another load into the same project is under way.' }),
  fenced: msg({ id: 'content.templates.fenced', defaultMessage: 'A template is being loaded into this project', description: "Why an agent can't start (followed by \", so its agents can't start now.\"): a template is replacing the project's agents. A sentence without its full stop." }),
  restoring: msg({ id: 'content.templates.restoring', defaultMessage: "Undo is putting this project's agents back as they were before a template was loaded", description: "Why an agent can't start (followed by \", so its agents can't start now.\"): the Hive Assistant's undo is putting back the agents a template's load replaced (HI-1502). A sentence without its full stop." }),
  gone: msg({ id: 'content.templates.gone', defaultMessage: 'That template is no longer there.', description: 'An error: the template was deleted or renamed meanwhile.' }),
  nameTaken: msg({ id: 'content.templates.nameTaken', defaultMessage: 'There is already a template called "{name}" there.', description: 'An error renaming or editing a template: another template where it is kept (the workspace or a project) is called {name}.' }),
  connectionUnknown: msg({ id: 'content.templates.connectionUnknown', defaultMessage: 'No connection "{ref}" can be used in this workspace now: choose another.', description: "An error loading a template or choosing connections (HI-2109): the connection chosen ({ref}, its name or id) was removed, or its account turned off here, since it was offered." }),
  connectionAmbiguous: msg({ id: 'content.templates.connectionAmbiguous', defaultMessage: 'Several connections are called "{ref}": name one by its id ({ids}).', description: "An error loading a template or choosing connections (HI-2109): the name given ({ref}) is several connections' names; {ids} lists their ids." }),
  agentsChanged: msg({ id: 'content.templates.agentsChangedChoose', defaultMessage: "The project's agents changed since you chose their connections: nothing was changed. Choose them again.", description: "An error choosing connections for a project's agents (HI-2109): an agent was added, removed or moved after the dialog showed them, so nothing changed." }),
  connectionKeys: msg({ id: 'content.templates.connectionChoices', defaultMessage: "These connection choices don't fit its agents: {keys}. Open it again.", description: "An error loading a template or choosing connections (HI-2109): choices sent for a role it doesn't know or an agent it doesn't have (another window's, or the template changed meanwhile). {keys} lists them as given ('role boss', 'agent 7'): keep role and agent in English." }),
  taken: msg({ id: 'content.templates.taken', defaultMessage: '{names} {count, plural, one {is already an agent} other {are already agents}} in {projects}: agent names are unique across the workspace, so rename {count, plural, one {it} other {them}}.', description: "Why a template can't be loaded: agents of other projects ({projects}) have its agents' names {names} ({count} of them). {names} and {projects} are lists, in the language's way (\"B1 and R1\")." }),
  takenNothing: msg({ id: 'content.templates.takenNothing', defaultMessage: '{names} {count, plural, one {is already an agent} other {are already agents}} in {projects}: agent names are unique across the workspace, so rename {count, plural, one {it} other {them}}. Nothing was changed.', description: "An error loading a template: agents of other projects ({projects}) took its agents' names {names} ({count} of them) while it loaded, so nothing changed. {names} and {projects} are lists, in the language's way (\"B1 and R1\")." }),
  overMax: msg({ id: 'content.templates.overMax', defaultMessage: 'It has {count, number} agents, and this project’s workflow allows {max, plural, one {# agent} other {# agents}}: raise Maximum agents in Version Control → Workflow first, or load it with its workflow. Nothing was changed.', description: "An error loading a template (HI-2058): its agents ({count}) are more than the project's workflow option Maximum agents ({max}), and its workflow, which would raise it, isn't applied. Maximum agents, Version Control and Workflow are names in the window: as translated there." }),
  nothing: msg({ id: 'content.templates.nothing', defaultMessage: '{problem} Nothing was changed.', description: "An error loading a template, nothing changed: {problem} is why, a sentence of its own (how many agents a project can have)." }),
  noKey: msg({ id: 'content.templates.noKey', defaultMessage: "Combwork couldn't read {project}'s key, and this template's agent names are made from it. Try again, or check the key in Project Settings → General.", description: "An error loading a template, or adding one of its agents, whose names hold the project's key (HI-B1 in a project whose key is HI): the key of the project ({project}, its name) couldn't be read. Project Settings → Agents is where the key is changed: use its translation." }),
  noKeySave: msg({ id: 'content.templates.noKeySave', defaultMessage: "Combwork couldn't read {project}'s key, so the names can't be saved with it. Try again, or save without Use the project key in names.", description: "An error saving a project's agents as a template with \"Use the project key in names\" ticked: the key of the project ({project}, its name) couldn't be read. \"Use the project key in names\" is the tick box's label: use its translation." }),
  hiveOnly: msg({ id: 'content.templates.hiveOnly', defaultMessage: "Combwork's own templates can't be changed: duplicate one into the workspace or a project to change it.", description: "An error: saving, renaming, editing, importing into or deleting one of Hive's own templates (the Hive scope, read-only). Duplicate is a button: as Hive names it." })
}

const checkScope = (scope: unknown): TemplateScope => {
  if (scope !== 'workspace' && scope !== 'project' && scope !== 'hive') throw refusal(msg({ id: 'content.templates.scope', defaultMessage: 'Unknown scope "{scope}": hive, workspace or project.', description: 'An error: where a template is kept must be hive, workspace or project (keep those three words: they are the values to use).' }), { scope: String(scope) }, 'invalid')
  return scope
}

/**
 * Where a scope's templates are kept. A project's: that project's folder (one of the workspace's). The workspace's:
 * the workspace of `project` when one is given (the project a template is used in), else this call's workspace. Hive's
 * own have no folder (#1436): whatever would write there is refused.
 */
function folder(d: TemplateDest): string {
  const scope = checkScope(d.scope)
  if (scope === 'hive') throw refusal(M.hiveOnly, undefined, 'invalid')
  if (scope === 'project') return join(workspace.assertProject(String(d.project ?? '')), CW_DIR, 'templates')
  const ws = d.project ? workspaceOf(d.project).path : workspace.path
  if (!ws) throw refusal(msg({ id: 'content.templates.noWorkspace', defaultMessage: 'Open a workspace first.', description: "An error: the workspace's templates need a workspace open." }))
  return join(ws, CW_DIR, 'templates')
}

/** The place a template is kept, as listed (a project's path only for a project's templates). */
const place = (d: TemplateDest): TemplateDest => (d.scope === 'project' ? { scope: 'project', project: workspace.assertProject(String(d.project ?? '')) } : { scope: d.scope === 'hive' ? 'hive' : 'workspace' })

/** What a template suggests and pairs, and its workflow (HI-1910), as an entry carries it (#1436). */
const extras = (t: Pick<AgentTemplate, 'suggestedPreset' | 'reviewerMode' | 'pairs' | 'workflow' | 'workflowDropped'>): Pick<TemplateEntry, 'suggestedPreset' | 'reviewerMode' | 'pairs' | 'workflow' | 'workflowDropped'> => ({
  ...(t.suggestedPreset ? { suggestedPreset: t.suggestedPreset } : {}),
  ...(t.reviewerMode ? { reviewerMode: t.reviewerMode } : {}),
  ...(t.pairs?.length ? { pairs: t.pairs } : {}),
  ...(hasWorkflow(t.workflow) ? { workflow: t.workflow } : {}),
  ...(t.workflowDropped?.length ? { workflowDropped: t.workflowDropped } : {})
})

/** Whether a template file's content is Hive 0.9's: a version under 1.0's (#1436). */
const isV09 = (raw: unknown): boolean => {
  const v = raw && typeof raw === 'object' ? (raw as { version?: unknown }).version : undefined
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v < TEMPLATE_VERSION
}

/** One of Hive's own templates as listed (#1436): its name and description in the language Hive shows now. */
function hiveEntry(h: HiveTemplate): TemplateEntry {
  const t = h.template
  return { scope: 'hive', file: h.file, name: tr(h.name), savedAt: null, layout: t.layout, description: tr(h.description), agents: t.agents, ...extras(t) }
}

/**
 * One template as listed, or null for a file of Hive 0.9's (#1436: 1.0 doesn't use them; the upgrade keeps a copy
 * with the 0.9 backup, and the file stays as it is, never listed, loaded, changed or deleted here).
 */
async function readOne(d: TemplateDest, file: string): Promise<TemplateEntry | null> {
  if (d.scope === 'hive') {
    const h = hiveTemplate(file)
    if (!h) throw refusal(M.gone, undefined, 'notFound')
    return hiveEntry(h)
  }
  const where = place(d)
  const raw = await readKeptJson<unknown>(join(folder(d), file), null)
  if (isV09(raw)) return null
  const t = raw === null ? msg({ id: 'content.templates.unreadable', defaultMessage: "It couldn't be read.", description: "Why a template can't be used: its file couldn't be read." }) : readTemplate(raw)
  if (!isAgentTemplate(t)) {
    const name = raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string' ? String((raw as { name: string }).name).slice(0, TEMPLATE_NAME_MAX) : file.replace(/\.json$/, '')
    // Why, in English for the log and a refusal's message, and as text the window shows in its language (#870).
    // agent-stored: agentField says it for each agent where the template is listed (templateApi.ts rowOf)
    return { ...where, file, name, savedAt: null, layout: 'auto', agents: [], problem: englishText(t), problemText: t } // agent-text: readTemplate
  }
  return { ...where, file, name: t.name, savedAt: t.savedAt || null, layout: t.layout, ...(t.description ? { description: t.description } : {}), agents: t.agents, ...extras(t) }
}

/** The templates kept in one place, by file name (Hive's own in their order). */
async function listIn(d: TemplateDest): Promise<TemplateEntry[]> {
  if (d.scope === 'hive') return CW_TEMPLATES.map(hiveEntry)
  const files = (await readdir(folder(d)).catch(() => [] as string[])).filter(isTemplateFile).sort()
  const out: TemplateEntry[] = []
  for (const f of files) {
    const e = await readOne(d, f)
    if (e) out.push(e)
  }
  return out
}

const byName = (a: TemplateEntry, b: TemplateEntry): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.scope === 'workspace' ? -1 : 1)

/**
 * The templates a project can use: Hive's own (#1436, in their order), then the workspace's and its own, each by name
 * (a name in both scopes is listed twice), each with its agents' names in this project (`agentNames`, HI-1948).
 */
export async function listTemplates(projectPath: string): Promise<TemplateEntry[]> {
  projectPath = workspace.assertProject(projectPath)
  const out = [...(await listIn({ scope: 'workspace', project: projectPath })), ...(await listIn({ scope: 'project', project: projectPath }))]
  // Each usable one's agents named for this project (HI-1948), as its plan names them: the window's menu shows these,
  // never a key of its own that may not be read yet. No key yet: `{key}` stays.
  const key = (await keyFor(projectPath)) ?? '{key}'
  return [...(await listIn({ scope: 'hive' })), ...out.sort(byName)].map((e) => (e.problem ? e : { ...e, agentNames: templateAgentNames(e.agents, key) }))
}

/** Every template of the workspace (the Templates view): Hive's own, the workspace's, then each project's, each by name. */
export async function listAllTemplates(): Promise<TemplateEntry[]> {
  if (!workspace.path) return []
  const out = [...(await listIn({ scope: 'hive' })), ...(await listIn({ scope: 'workspace' })).sort(byName)]
  for (const p of await workspace.listProjectPaths()) out.push(...(await listIn({ scope: 'project', project: p })).sort(byName))
  return out
}

/** One template's file, after checking it is one Hive could have made (never a path) and is there. */
function fileOf(ref: TemplateRef): string {
  if (!isTemplateFile(ref.file)) throw refusal(M.gone, undefined, 'notFound')
  if (ref.scope === 'hive') {
    if (!hiveTemplate(ref.file)) throw refusal(M.gone, undefined, 'notFound')
    return ref.file
  }
  const f = join(folder(ref), ref.file)
  if (!existsSync(f)) throw refusal(M.gone, undefined, 'notFound')
  return f
}

/** One template to use (refused, saying why, if it is missing or can't be used). */
async function usable(ref: TemplateRef): Promise<TemplateEntry & { template: AgentTemplate }> {
  fileOf(ref)
  const e = await readOne(ref, ref.file)
  if (!e) throw refusal(M.gone, undefined, 'notFound')
  if (e.problem) throw refusal(msg({ id: 'content.templates.cantUse', defaultMessage: '"{name}" can\'t be used: {problem}', description: "An error: the template {name} can't be used; {problem} says why (a sentence)." }), { name: e.name, problem: e.problemText ?? e.problem })
  return { ...e, template: { version: TEMPLATE_VERSION, name: e.name, savedAt: e.savedAt ?? '', layout: e.layout, ...(e.description ? { description: e.description } : {}), agents: e.agents, ...extras(e) } }
}

/** A template name as saved: one line, trimmed, refused (saying why) if empty or too long. */
function cleanName(name: unknown): string {
  const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
  if (!clean) throw refusal(msg({ id: 'content.templates.enterName', defaultMessage: 'Enter a name for the template.', description: "An error saving or renaming a template with no name." }), undefined, 'invalid')
  if (clean.length > TEMPLATE_NAME_MAX) throw refusal(msg({ id: 'content.templates.nameTooLong', defaultMessage: "A template's name is at most {max} characters.", description: "An error saving or renaming a template whose name is longer than {max} characters." }), { max: TEMPLATE_NAME_MAX }, 'invalid')
  return clean
}

/** A new file for a template in a place: from its name, numbered when that file is taken. */
async function newFile(d: TemplateDest, name: string): Promise<string> {
  const taken = await readdir(folder(d)).catch(() => [] as string[])
  for (let n = 1; ; n++) if (!taken.includes(templateFile(name, n))) return templateFile(name, n)
}

/**
 * Runs a change to a place's templates with that place locked against every other change to it (save, import,
 * duplicate, rename, delete), from any project or window: what it reads, checks (a name taken), chooses (a new file) and
 * writes is one step, so two changes at once never pick the same file or miss each other's name. Readers need no lock
 * (each file is written whole). Never nested for one place.
 */
function changing<T>(d: TemplateDest, fn: () => Promise<T>): Promise<T> {
  return withTemplatesLock(folder(d), fn)
}

/** The lock of one folder of templates (`changing`'s). */
function withTemplatesLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(`${resolve(dir)}|templates`, fn)
}

/** Writes a template into a place (its file there: a new one, or the one it replaces). */
async function write(d: TemplateDest, file: string, t: AgentTemplate): Promise<TemplateEntry> {
  await mkdir(folder(d), { recursive: true })
  await writeKeptJson(join(folder(d), file), exportable(t))
  return (await readOne(d, file))!
}

/** What a save did with the template's workflow (HI-1910): the section saved, and the ones kept from the template it replaced. */
export interface SavedWorkflow {
  saved: PlatformId | null
  kept: PlatformId[]
}

/**
 * Saves the project's agents and layout as a template in `scope`. A template of that name already there (case aside) is
 * replaced only with `overwrite`; otherwise the answer says it exists, so the user can be asked. `includeWorkflow`
 * (HI-1910, Save as Template's tick box, on by default): the project's options in force, as a section for its version
 * control. Replacing a template keeps its other sections (and, unticked, all of them), and says which.
 */
export async function saveTemplate(projectPath: string, scope: TemplateScope, name: string, overwrite = false, usePatterns = false, includeWorkflow = true): Promise<{ saved: TemplateEntry; workflow: SavedWorkflow } | { exists: string }> {
  projectPath = workspace.assertProject(projectPath)
  const d: TemplateDest = { scope: checkScope(scope), project: projectPath }
  const clean = cleanName(name)
  const cfg = await workspace.projectConfig(projectPath)
  const agents = projectAgents(cfg)
  if (!agents.length) throw refusal(msg({ id: 'content.templates.noAgents', defaultMessage: 'This project has no agents to save.', description: "An error saving a project's agents as a template: it has none." }))
  // The project's key in its names kept as a pattern (#1440), when asked: HI-B1 as {key}-B{n}; refused when the key
  // can't be read, never saved with fixed names unasked.
  const key = usePatterns ? await keyFor(projectPath) : null
  if (usePatterns && !key) throw refusal(M.noKeySave, { project: basename(projectPath) })
  // The project's workflow as a section (HI-1910): its options in force, never options that fell back to all off.
  const own = includeWorkflow ? await projectSection(projectPath) : null
  const t = templateFrom(clean, agents, cfg.layout, (a) => agentProvider(a, config.settings), new Date(), presetOf(cfg), key ?? undefined)
  // What is saved must load: read as a file is.
  const checked = readTemplate(JSON.parse(JSON.stringify({ ...t, ...(own ? { workflow: { [own.platform]: own.section } } : {}) })))
  // agent-text: readTemplate
  if (!isAgentTemplate(checked)) throw new TemplateError(checked, { kind: 'invalid' })
  return changing(d, async () => {
    // The same name: its file (replaced when asked). Another name whose file name would be the same: a file of its own.
    const same = (await listIn(d)).find((e) => e.name.toLowerCase() === clean.toLowerCase())
    if (same && !overwrite) return { exists: same.file }
    // The sections of the template it replaces stay, but for the one saved now.
    const kept = TEMPLATE_PLATFORMS.filter((p) => !!same?.workflow?.[p] && p !== own?.platform)
    const workflow: TemplateWorkflows = { ...Object.fromEntries(kept.map((p) => [p, same!.workflow![p]])), ...(own ? { [own.platform]: own.section } : {}) }
    // A section it had that couldn't be used stays said, unless one is saved for it now (HR5's round 1).
    const dropped = (same?.workflowDropped ?? []).filter((p) => p !== own?.platform)
    const saved = await write(d, same?.file ?? (await newFile(d, clean)), { ...checked, ...(hasWorkflow(workflow) ? { workflow } : {}), ...(dropped.length ? { workflowDropped: dropped } : {}) })
    log.info(`Saved template ${userText(clean)} (${scope}, ${t.agents.length} agents${own ? `, ${own.platform}'s workflow` : ''}${kept.length ? `, kept ${kept.join(' and ')}'s` : ''})`)
    return { saved, workflow: { saved: own?.platform ?? null, kept } }
  })
}

/** A project's workflow as a template's section (HI-1910): its options in force and preset, or null when they fell back to all off. */
async function projectSection(projectPath: string): Promise<{ platform: PlatformId; section: TemplateWorkflow } | null> {
  const form = await workflowForm(workspaceOf(projectPath), projectPath)
  if (form.invalid) return null
  return { platform: form.platform, section: templateWorkflowOf(form.options, form.preset) }
}

/** The preset a project's options started from, as a template suggests it (#1436): P4's Pair (the agent merges) as Pair. */
function presetOf(cfg: ProjectConfig): SuggestedPreset | undefined {
  const p = cfg.workflow?.preset
  return p === 'pairAgent' ? 'pair' : p === 'solo' || p === 'pair' || p === 'team' ? p : undefined
}

/** Renames a template where it is kept; another of that name there (case aside) refuses it. */
export async function renameTemplate(ref: TemplateRef, name: string): Promise<TemplateEntry> {
  const clean = cleanName(name)
  return changing(ref, async () => {
    const t = await usable(ref)
    if ((await listIn(ref)).some((e) => e.file !== ref.file && e.name.toLowerCase() === clean.toLowerCase())) throw refusal(M.nameTaken, { name: clean }, 'conflict')
    const renamed = await write(ref, ref.file, { ...t.template, name: clean })
    log.info(`Renamed template ${userText(t.name)} to ${userText(clean)}`)
    return renamed
  })
}

/**
 * Saves a template edited in the Templates view (#271): its name, description, layout and agents, in the file it is
 * kept in (its place stays: Duplicate… moves it). The edit is checked as untrusted (as an import is: 1–24 agents with
 * unique names, providers' ids, settings as CLIs name them) and refused, saying why, if another template there has its
 * name or the template changed since it was opened (`savedAt`, as it was then): nothing is half saved, and a change
 * made meanwhile (a re-save from a project, another window's edit) is never overwritten unasked.
 */
export async function updateTemplate(ref: TemplateRef, edited: unknown, savedAt: string | null): Promise<TemplateEntry> {
  const clean = cleanName(edited && typeof edited === 'object' ? (edited as { name?: unknown }).name : '')
  // Its pairs are checked one by one below, never refusing the edit.
  const { pairs: sent, ...rest } = (edited && typeof edited === 'object' ? edited : {}) as { pairs?: unknown }
  const base = { ...rest, version: TEMPLATE_VERSION, name: clean, savedAt: new Date().toISOString() }
  const checked = readTemplate(base)
  // agent-text: readTemplate
  if (!isAgentTemplate(checked)) throw new TemplateError(checked, { kind: 'invalid' })
  return changing(ref, async () => {
    const now = await usable(ref)
    // What the editor doesn't change (#1436) stays: the preset and reviewer mode it suggests. Its pairs: as the editor
    // sends them (#1440: it follows them by place through moves and renumbering), else the ones it had; either way each
    // only while it fits the agents as edited (an agent removed or given a role on the other side drops its own pair
    // only: templatePairs keeps the others, each agent in one pair).
    const kept = { ...(now.suggestedPreset ? { suggestedPreset: now.suggestedPreset } : {}), ...(now.reviewerMode ? { reviewerMode: now.reviewerMode } : {}) }
    // Its workflow (HI-1910): as the editor sends it (read through the whitelist), else the one it had.
    const workflow = 'workflow' in rest ? checked.workflow : now.workflow
    // Its sections that couldn't be used stay said where the edit sets none (HR5's round 1); a rejected one sent is said too.
    const workflowDropped = TEMPLATE_PLATFORMS.filter((p) => !workflow?.[p] && (!!now.workflowDropped?.includes(p) || !!checked.workflowDropped?.includes(p)))
    const given = Array.isArray(sent) ? sent.filter((p): p is { builder: string; reviewer: string } => !!p && typeof p === 'object' && typeof (p as { builder?: unknown }).builder === 'string' && typeof (p as { reviewer?: unknown }).reviewer === 'string') : (now.pairs ?? [])
    const numbered = pairNames(checked.agents)
    const pairs = templatePairs(given.flatMap((p) => {
      const b = pairIndex(checked.agents, p.builder)
      const r = pairIndex(checked.agents, p.reviewer)
      return b >= 0 && r >= 0 ? [{ name: numbered[b], role: checked.agents[b].role, pairedWith: numbered[r] }, { name: numbered[r], role: checked.agents[r].role }] : []
    }))
    const { workflow: _sent, workflowDropped: _dropped, ...edit } = checked
    const t = { ...edit, ...kept, ...(pairs.length ? { pairs } : {}), ...(hasWorkflow(workflow) ? { workflow } : {}), ...(workflowDropped.length ? { workflowDropped } : {}) }
    if ((now.savedAt ?? null) !== (savedAt ?? null)) throw refusal(msg({ id: 'content.templates.editedMeanwhile', defaultMessage: '"{name}" changed since you started editing it (saved again meanwhile): nothing was saved. Close the editor to see it as it is now.', description: 'An error saving an edited template: it was saved again elsewhere after the editor opened it.' }), { name: now.name }, 'conflict')
    if ((await listIn(ref)).some((e) => e.file !== ref.file && e.name.toLowerCase() === clean.toLowerCase())) throw refusal(M.nameTaken, { name: clean }, 'conflict')
    const saved = await write(ref, ref.file, t)
    log.info(`Edited template ${userText(clean)} (${ref.scope}, ${t.agents.length} agents)`)
    return saved
  })
}

/** Copies a template into a place (the same or another); a name taken there gets a number ("Pair (2)"). */
export async function duplicateTemplate(ref: TemplateRef, to: TemplateDest): Promise<TemplateEntry> {
  // Read first (unlocked: the source may be in the same place), then the copy's name and file chosen and written there.
  const t = await usable(ref)
  return changing(to, async () => {
    const name = uniqueTemplateName(t.name, (await listIn(to)).map((e) => e.name))
    // One of Hive's own has no time it was saved: the copy's is now.
    const copy = await write(to, await newFile(to, name), { ...t.template, name, savedAt: t.template.savedAt || new Date().toISOString() })
    log.info(`Duplicated template ${userText(t.name)} into ${to.scope} as ${userText(name)}`)
    return copy
  })
}

/** Deletes a template: its file (and the copy kept beside it) go to the Recycle Bin. Hive's own and 0.9's can't be (#1436). */
export async function deleteTemplate(ref: TemplateRef): Promise<void> {
  await changing(ref, async () => {
    const f = fileOf(ref)
    if (!(await readOne(ref, ref.file))) throw refusal(M.gone, undefined, 'notFound')
    await trash(f)
    if (existsSync(`${f}.bak`)) await trash(`${f}.bak`).catch((e) => log.warn('Could not remove the copy of a deleted template', e))
    log.info(`Deleted template ${userText(ref.file)} (${ref.scope})`)
  })
}

/** The file name an export of a template suggests ("Build and review.combwork-template.json"); refused if it can't be used. */
export async function exportName(ref: TemplateRef): Promise<string> {
  return exportFileName((await usable(ref)).name)
}

/** Exports a template to a file the user chose: what it holds, nothing else (exportable). */
export async function exportTemplate(ref: TemplateRef, dest: string, mask: <T>(v: T) => T = (v) => v): Promise<void> {
  const t = await usable(ref)
  // `mask`: each value masked before it is written (HI-1772: no server connection's key in an export).
  await writeTextAtomic(dest, JSON.stringify(mask(exportable(t.template)), null, 2) + '\n')
  log.info(`Exported template ${userText(t.name)} to ${userText(dest)}`)
}

/** A file to import, read and checked (untrusted): the template, or refused saying why. Nothing is written. */
export async function readImport(path: string): Promise<AgentTemplate> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw refusal(msg({ id: 'content.templates.noFile', defaultMessage: "That file isn't there.", description: 'An error importing a template: the file chosen is gone.' }), undefined, 'notFound')
  if (info.size > TEMPLATE_IMPORT_MAX) throw refusal(msg({ id: 'content.templates.importTooLarge', defaultMessage: "It isn't a Combwork agent template (over {kb} KB).", description: 'An error importing a template: the file is larger than {kb} KB, more than any template.' }), { kb: TEMPLATE_IMPORT_MAX / 1024 })
  let raw: unknown
  try {
    raw = JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''))
  } catch {
    throw refusal(msg({ id: 'content.templates.importNotJson', defaultMessage: "It isn't a Combwork agent template (not JSON).", description: "An error importing a template: the file isn't JSON." }))
  }
  const t = readTemplate(raw)
  // agent-text: readTemplate
  if (!isAgentTemplate(t)) throw new TemplateError(t)
  return t
}

/** What an import would bring in: its name, agents, and the providers among them this Hive doesn't know (flagged). */
export async function inspectImport(path: string): Promise<{ path: string; name: string; agents: number; unknown: string[] }> {
  const t = await readImport(path)
  return { path, name: t.name, agents: t.agents.length, unknown: unknownProviders(t.agents) }
}

/**
 * Imports a template file into a place, all or nothing (the file is checked first, and written in one go). A template of
 * that name already there is a clash: the answer says so unless `onClash` says what to do — replace it, or keep both
 * (the new one numbered, "Pair (2)").
 */
export async function importTemplate(path: string, to: TemplateDest, onClash?: 'replace' | 'keep'): Promise<{ imported: TemplateEntry } | { clash: string }> {
  const t = await readImport(path)
  return changing(to, async () => {
    const here = await listIn(to)
    const same = here.find((e) => e.name.toLowerCase() === t.name.toLowerCase())
    if (same && onClash !== 'replace' && onClash !== 'keep') return { clash: same.name }
    const name = same && onClash === 'keep' ? uniqueTemplateName(t.name, here.map((e) => e.name)) : t.name
    const file = same && onClash === 'replace' ? same.file : await newFile(to, name)
    const imported = await write(to, file, { ...t, name })
    log.info(`Imported template ${userText(name)} into ${to.scope} (${t.agents.length} agents)`)
    return { imported }
  })
}

/** Whether a CLI can run here: known to this Hive, on and installed. */
const cliUsable = (id: ProviderId): boolean => isKnownProvider(id) && isProviderEnabled(config.settings, id) && !!providerService.info(id).found

/**
 * The connections a project's agents can be given (HI-2109): each account's, in the order, where the account is usable in
 * the project's workspace (on there, or the CLI's own home) and its CLI is on and installed. A test copy's CLI test home
 * (the seam, connectionSeam.ts) gets its account the first time, as an agent's start would.
 */
export function connectionOptions(projectPath: string): ConnectionOption[] {
  const ws = workspaceOf(projectPath)
  const cfg = ws.path ? ws.config : null
  for (const p of PROVIDERS) if (cliUsable(p.id) && !accountHere(p.id, cfg)) firstAccountHere(p.id, cfg)
  const accounts = allAccounts()
  const connections = allConnections()
  return accounts.filter((a) => cliUsable(a.provider) && accountOnIn(cfg, a, accounts)).flatMap((a) => connectionsOn(a.id, connections).map((c) => optionOf(c, a)))
}

/** A template used in a project: a project's is looked up in `from` (another project's, from the Templates view), else in that project. */
const refFor = (projectPath: string, scope: TemplateScope, file: string, from?: string): TemplateRef => ({ scope: checkScope(scope), project: scope === 'project' && from ? from : projectPath, file })

/** A worktree's `branchStatus`, as one plan reads it (#732: once each, though the plan looks at one twice). */
type StatusOf = (w: wt.WorktreeRef) => Promise<AgentBranchStatus>

/** `branchStatus` read once per worktree and branch for one operation (#732), with its reads of the repository. */
function statusReads(projectPath: string, reads: wt.RepoReads): StatusOf {
  const kept = new Map<string, Promise<AgentBranchStatus>>()
  return (w) => {
    const key = `${placeKey(w.path)}|${w.branch}`
    let p = kept.get(key)
    if (!p) kept.set(key, (p = wt.branchStatus(projectPath, w, reads)))
    return p
  }
}

/** A project's key (#704), as a template's names are made with it (#1123 names); null when it can't be read. */
async function keyFor(projectPath: string): Promise<string | null> {
  return projectKeyOf(workspaceOf(projectPath), projectPath).catch(() => null)
}

/**
 * A template's agents' names in a project (#1123 names, #1440): its patterns made with the project's key, refused when
 * they hold `{key}` and the key can't be read (never a guessed one).
 */
async function namesIn(projectPath: string, agents: readonly TemplateAgent[]): Promise<string[]> {
  const key = await keyFor(projectPath)
  if (!key && usesKey(agents)) throw refusal(M.noKey, { project: basename(projectPath) })
  return templateAgentNames(agents, key ?? '')
}

/** Names another project's agents have, in a refusal: "B1, R1 are already agents in ambrosia: … rename them" (and nothing changed, at the load's end). */
function takenText(taken: { name: string; project: string }[], nothingChanged = false): Text {
  const where = listOf([...new Set(taken.map((t) => t.project))])
  return withValues(nothingChanged ? M.takenNothing : M.taken, { names: listOf(taken.map((t) => t.name)), count: taken.length, projects: where })
}

/** Whether an agent is running or starting (a start reserved, not yet live): either way, not safe to remove. */
const busy = (projectPath: string, agentId: string): boolean => !!sessions.liveFor(projectPath, agentId) || sessions.startingFor(projectPath, agentId)

/**
 * What loading a template into a project would do: the agents removed and created, the layout, the connections they can
 * be given (HI-2109), and what stops it now — an agent running or starting, a removed worktree agent's uncommitted work
 * (or a worktree whose state git can't tell: then it isn't known to be safe), no connection usable here. Nothing is
 * changed. The repository is read once for the whole plan, not once per agent (#732). The created agents work in the
 * project folder (#1436).
 */
export async function templatePlan(projectPath: string, scope: TemplateScope, file: string, from?: string, names?: string[], reads?: wt.RepoReads): Promise<TemplateLoadPlan> {
  return (await planFor(projectPath, scope, file, from, names, reads, 'user')).plan
}

/**
 * The plan with what stops it in English (HI-1502: the Agent API's, the Assistant's), where `blocked` says it in the
 * window's language. Its agents keep to the project's Maximum agents (HI-2001).
 */
export async function templatePlanEnglish(projectPath: string, scope: TemplateScope, file: string, from?: string, names?: string[]): Promise<{ plan: TemplateLoadPlan; why: string[] }> {
  const { plan, why } = await planFor(projectPath, scope, file, from, names, undefined, 'agent')
  return { plan, why: why.map((w) => agentText(w)) }
}

/**
 * The plan, with what stops it as text (`why`, which `blocked` says in the window's language): a load refuses with it.
 * `by` (HI-2001): the user's load goes past the project's Maximum agents (the plan says so, for its dialog to offer to
 * raise it); an agent's is refused there.
 */
async function planFor(projectPath: string, scope: TemplateScope, file: string, from: string | undefined, names: string[] | undefined, reads: wt.RepoReads | undefined, by: AddedBy): Promise<{ plan: TemplateLoadPlan; why: TextPart[] }> {
  projectPath = workspace.assertProject(projectPath)
  const repo = reads ?? new wt.RepoReads(projectPath)
  const status = statusReads(projectPath, repo)
  const original = await usable(refFor(projectPath, scope, file, from))
  // Its patterns as this project's names (#1123 names), then the names chosen in the dialog.
  const expanded = await namesIn(projectPath, original.agents)
  const t = { ...original, agents: withNames(original.agents.map((a, i) => ({ ...a, name: expanded[i] })), names) }
  const cfg = await workspace.projectConfig(projectPath)
  const current = projectAgents(cfg)
  const remove: TemplateLoadPlan['remove'] = []
  const blocked: TextPart[] = []
  for (const a of current) {
    const running = busy(projectPath, a.id)
    let dirty = 0
    // Its 0.9 worktree (#1452: through legacyWorktree), checked before the load replaces it.
    const tree = legacyWorktree(a)
    if (tree && existsSync(tree.path)) {
      // As Remove Agent checks before a worktree goes: strictly, so a git that fails never reads as "nothing to lose".
      try {
        dirty = (await status(tree)).dirty
      } catch (e) {
        blocked.push(withValues(msg({ id: 'content.templates.checkFailed', defaultMessage: "Combwork couldn't check {agent}'s worktree ({folder}): {error}", description: "Why a template can't be loaded: git couldn't tell whether the worktree {folder} of the agent {agent} it would remove has uncommitted work; {error} is why (often git's own words)." }), { agent: a.name, folder: tree.path, error: firstLine(e) }))
      }
    }
    remove.push({ id: a.id, name: a.name, running, dirty, ...(tree ? { worktree: { path: tree.path, branch: tree.branch } } : {}) })
    if (running) blocked.push(withValues(msg({ id: 'content.templates.running', defaultMessage: '{agent} is running or starting: stop it first.', description: "Why a template can't be loaded: the agent {agent} it would replace is running." }), { agent: a.name }))
    if (dirty) blocked.push(withValues(msg({ id: 'content.templates.uncommitted', defaultMessage: '{agent} has uncommitted work in its worktree ({folder}): commit or discard it first.', description: "Why a template can't be loaded: the worktree {folder} of the agent {agent} it would replace has work not committed." }), { agent: a.name, folder: tree!.path }))
  }
  // Its agents' connections are chosen in the dialog (HI-2109) from those usable here; the CLI each suggests only
  // preselects one, so a CLI that's off or not installed no longer stops it. None usable: they are made on the CLI they
  // suggest, as Add Agent makes one, and get a connection once an account is (HI-2106's placeUnplaced).
  const create: TemplateAgent[] = t.agents
  const options = connectionOptions(projectPath)
  // It replaces the project's agents: an agent's load keeps to Maximum agents (HI-2001); the user's goes past it, offered
  // to raise it. A template never has more than any project can (`readTemplate`).
  const max = agentMax(projectPath, cfg)
  const maxAgents = create.length > max ? { now: max, needs: create.length } : null
  if (maxAgents && by === 'agent') blocked.push(templateLimitText(create.length, max))
  // Names another project's agent has (#702): this project's own don't count, as the load replaces them.
  const others = (await workspaceAgents(projectPath)).filter((a) => a.project.toLowerCase() !== basename(projectPath).toLowerCase())
  const takenNames = create.flatMap((a) => {
    const owner = nameTaken(a.name, others)
    return owner ? [{ name: a.name, project: owner.project }] : []
  })
  // Its pairs by place, from the template's own names, so they follow the names chosen in the dialog.
  const at = (n: string): number => pairIndex(original.agents, n)
  const pairs = (original.pairs ?? []).map((p) => ({ builder: at(p.builder), reviewer: at(p.reviewer) })).filter((p) => p.builder >= 0 && p.reviewer >= 0)
  // A suggestion the project's options already follow isn't one.
  const suggestedPreset = original.suggestedPreset && original.suggestedPreset !== presetOf(cfg) ? original.suggestedPreset : null
  const workflow = await planWorkflow(projectPath, original)
  const plan: TemplateLoadPlan = { scope: t.scope, file: t.file, name: t.name, layout: t.layout, remove, create, templateNames: expanded, taken: takenNames, pairs, suggestedPreset, reviewerMode: original.reviewerMode ?? null, options, blocked: blocked.map(shownText), workflow, maxAgents }
  return { plan, why: blocked }
}

/**
 * A template's workflow as it meets a project (HI-1910): the section for its version control laid over its options as
 * they are now, or why none applies (a Git-only template in a None project needs Git first). Hive's own carry their
 * preset's, made here as the project's form offers it (its suggested checks, its identity), with their reviewer mode.
 */
async function planWorkflow(projectPath: string, t: Pick<TemplateEntry, 'scope' | 'workflow' | 'workflowDropped' | 'suggestedPreset' | 'reviewerMode' | 'agents'>): Promise<TemplateLoadWorkflow | null> {
  if (!hasWorkflow(t.workflow) && !t.workflowDropped?.length) return null
  const form = await workflowForm(workspaceOf(projectPath), projectPath)
  const sections = TEMPLATE_PLATFORMS.filter((p) => !!t.workflow?.[p])
  let section = t.workflow?.[form.platform] ?? null
  if (section && t.scope === 'hive' && t.suggestedPreset) {
    const offered = form.presets.find((p) => p.id === t.suggestedPreset)?.options
    // Read again as any section is: what Hive makes goes through the same whitelist.
    // Their size as their Maximum agents (HI-2001): the team the template is.
    if (offered) section = readTemplateWorkflow(templateWorkflowOf({ ...offered, ...(form.platform === 'git' && t.reviewerMode ? { reviewerMode: t.reviewerMode } : {}), maxAgents: t.agents.length }, t.suggestedPreset), form.platform) ?? section
  }
  return {
    platform: form.platform,
    sections,
    dropped: t.workflowDropped ?? [],
    section,
    // Its Maximum agents isn't one of the changes it fills in: the user's load saves it with the agents (HI-2058).
    overlay: section ? overlayTemplateWorkflow({ ...section, options: Object.fromEntries(Object.entries(section.options).filter(([k]) => k !== 'maxAgents')) as TemplateWorkflow['options'] }, form) : null,
    needsGit: form.platform === 'none' && !section && sections.includes('git'),
    alsoGit: form.platform === 'none' && !!section && sections.includes('git')
  }
}

/** An error's first line as text (git's message can run on), its descriptor when it is Hive's and one line. */
function firstLine(e: unknown): TextPart {
  const text = errorText(e)
  return typeof text === 'string' || shownText(text).includes('\n') ? shownText(text).split('\n')[0] : text
}

/**
 * A template's agents with the names chosen for them in the Load template dialog (#702), by order: as many as it has,
 * each a name an agent can have, no two the same. None given: its own names.
 */
function withNames(agents: TemplateAgent[], names: unknown): TemplateAgent[] {
  if (names === undefined || names === null) return agents
  if (!Array.isArray(names) || names.length !== agents.length || names.some((n) => typeof n !== 'string')) throw refusal(msg({ id: 'content.templates.namesChanged', defaultMessage: 'The names given for its agents no longer match the template: open it again.', description: 'An error loading a template: the names chosen for its agents in the Load template dialog no longer fit it (it was edited meanwhile).' }), undefined, 'conflict')
  const clean = (names as string[]).map((n) => n.replace(/\s+/g, ' ').trim())
  for (const n of clean) {
    if (!agentNameProblem(n)) continue
    if (!n) throw refusal(msg({ id: 'content.templates.nameEach', defaultMessage: 'Enter a name for each of its agents.', description: "An error loading a template: a name given for one of its agents is empty." }), undefined, 'invalid')
    throw refusal(msg({ id: 'content.templates.nameEachTooLong', defaultMessage: 'A name is at most {max} characters for each of its agents.', description: "An error loading a template: a name given for one of its agents is longer than {max} characters." }), { max: AGENT_NAME_MAX }, 'invalid')
  }
  const twice = clean.find((n, i) => clean.findIndex((m) => sameAgentName(m, n)) !== i)
  if (twice) throw refusal(msg({ id: 'content.templates.twice', defaultMessage: 'Two of its agents would be called "{name}".', description: 'An error loading a template: the names given for its agents call two of them {name}.' }), { name: twice }, 'invalid')
  return agents.map((a, i) => ({ ...a, name: clean[i] }))
}

/** Seams for unit tests: called after each of a load's agents is staged (its name), before the load is published. */
export const testHooks: {
  staged?: (name: string) => Promise<void>
  /** Choose Connections… about to read the project's agents again (HR3's round 2: a change between plan and apply). */
  applying?: () => Promise<void>
} = {}

/** Loads under way, by project: one at a time each. */
const loading = new Set<string>()

/** Names another project's agent has, worded as the caller refuses them (HI-1502: the Agent API's with a free name for each). */
type Taken = (clash: { name: string; project: string }[]) => Error | Promise<Error>

/** A load's result as the Agent API reports it and undo records it (HI-1502): the agents and layout before and after. */
export interface TemplateLoaded {
  created: string[]
  removed: string[]
  workflow: TemplateWorkflow | null
  plan: TemplateLoadPlan
  /** What it replaced, and the Maximum agents it saved with them (HI-2058), when it did. */
  before: { agents: AgentDef[]; layout: PageLayout; maxAgents?: number }
  after: { agents: AgentDef[]; layout: PageLayout }
}

/**
 * Replaces the project's agents with a template's, and its layout (#126). `expected` is the agents the user was shown
 * (their ids, in order). `from`: the project a project's template is kept in, when it isn't this one (#127: the Templates
 * view loads any template into any project).
 *
 * - The project's agents can't start for the whole load (a fence on its starts, lifted however the load ends), and one
 *   running or starting refuses it, as do the other checks of the plan.
 * - **Staged, then published at once:** the new agents are made without touching project.json, each in the project
 *   folder with its role in the workflow, note and pairing (#1436); then one write under the project file's lock swaps
 *   in the new agents and layout (`replaceProjectAgents`) — only if the agents are still exactly those shown and none
 *   runs or is starting. Anything else (an agent added or removed meanwhile) refuses the load: no change made meanwhile
 *   is lost, and nothing half loaded is ever seen.
 * - The removed agents' worktrees and branches stay (to merge or reuse), their conversations stay in the Sessions tab,
 *   their open cards go back (nobody has them; Doing ones to Todo), and their lanes are abandoned (`agentsGone`).
 * - The template's suggested preset is only offered (the window opens the Workflow section with it), never applied here;
 *   so is its workflow (HI-1910): returned as this load read it, for the window to fill in the Workflow form with.
 */
export async function loadTemplate(projectPath: string, scope: TemplateScope, file: string, expected: string[], from?: string, names?: string[], connections?: ConnectionAnswers, applyWorkflow = false): Promise<{ created: string[]; removed: string[]; workflow: TemplateWorkflow | null; maxAgents?: number }> {
  const r = await loadTemplateWith(projectPath, scope, file, expected, { from, names, connections, by: 'user', applyWorkflow })
  // The Maximum agents it saved with its agents (HI-2058), for the Workflow form's note to say so (HI-2083).
  return { created: r.created, removed: r.removed, workflow: r.workflow, ...(r.before.maxAgents !== undefined ? { maxAgents: r.before.maxAgents } : {}) }
}

/**
 * The load (loadTemplate), with what the Agent API needs (HI-1502): `check` runs with the plan about to be staged, inside
 * the load's guard and fence, before anything is made (its refusal refuses the load), so what the caller does with the
 * plan's workflow is the same read of the template as the agents it loads; `guard` runs at the publish itself, under the
 * project file's lock (its throw publishes nothing); `taken` words a refusal for names another project's agent has, in the
 * plan or at the names lock (the window's words without it); the result has the agents and layout before and after, for
 * undo. `applyWorkflow` (the user's, its workflow ticked): its Maximum agents is saved with its agents (HI-2058).
 * `connections` (HI-2109): the picker's answers (all, a role, an agent by its name), each agent's role's preselected
 * connection where none answers for it.
 */
export async function loadTemplateWith(projectPath: string, scope: TemplateScope, file: string, expected: string[], o: { from?: string; names?: string[]; connections?: ConnectionAnswers; check?: (plan: TemplateLoadPlan) => Promise<void>; guard?: () => void; taken?: Taken; by?: AddedBy; applyWorkflow?: boolean } = {}): Promise<TemplateLoaded> {
  const by = o.by ?? 'agent'
  projectPath = workspace.assertProject(projectPath)
  return whileReplacing(projectPath, M.fenced, async () => {
    // The plan's reads of the repository, which staging goes on using (#732).
    const reads = new wt.RepoReads(projectPath)
    const { plan, why } = await planFor(projectPath, scope, file, o.from, o.names, reads, by)
    // agent-text: planFor
    if (why.length) throw new TemplateError({ lines: [msg({ id: 'content.templates.cantLoad', defaultMessage: "The template can't be loaded yet:", description: "An error loading a template, above the list of what stops it (each line a reason)." }), ...why.map((item) => withValues(msg({ id: 'content.templates.bullet', defaultMessage: '• {item}', description: 'A line of a list of reasons: a bullet, then the reason {item}.' }), { item }))] })
    const changed = (ids: string[]): boolean => !Array.isArray(expected) || ids.length !== expected.length || ids.some((id, i) => id !== expected[i])
    if (changed(plan.remove.map((a) => a.id))) throw refusal(msg({ id: 'content.templates.changedSince', defaultMessage: "The project's agents changed since you looked: open the template again.", description: "An error loading a template: the project's agents changed after the Load template dialog showed them." }), undefined, 'conflict')
    if (plan.taken.length) throw o.taken ? await o.taken(plan.taken) : new TemplateError(takenText(plan.taken), { kind: 'conflict' })
    const connectionAt = connectionsFor(plan, o.connections)
    await o.check?.(plan)
    const cfg = await workspace.projectConfig(projectPath)
    const staged: { def: AgentDef; discard: () => Promise<void> }[] = []
    // What the caller's guard threw or its names refusal made: the caller's refusals, passed on unwrapped.
    const fromCaller = new WeakSet<object>()
    const callers = <T>(e: T): T => {
      if (e && typeof e === 'object') fromCaller.add(e)
      return e
    }
    let before: { agents: AgentDef[]; layout: PageLayout; maxAgents?: number }
    try {
      for (const [i, a] of plan.create.entries()) {
        const opts = { name: a.name, role: a.note, workflowRole: a.role, mcpServers: a.mcpServers, ...onConnection(a, connectionAt[i]), location: 'project' as const }
        staged.push(await prepareAgent(projectPath, cfg, opts, a.name, staged.map((s) => s.def), reads))
        await testHooks.staged?.(a.name)
      }
      // Each pair as the agents' pairing, both ways (#1436): Start Lane fills in a builder's reviewer from it (#1443).
      for (const p of plan.pairs) {
        const b = staged[p.builder]?.def
        const r = staged[p.reviewer]?.def
        if (!b || !r) continue
        b.pairedWith = r.name
        r.pairedWith = b.name
      }
      // Its workflow applied by the user (HI-2058): the section's Maximum agents, saved with the agents in the same write.
      const section = by === 'user' && o.applyWorkflow ? (plan.workflow?.section ?? null) : null
      before = await replaceProjectAgents(projectPath, {
        next: staged.map((s) => s.def),
        layout: plan.layout,
        by,
        ...(section && plan.workflow ? { loadedMax: { m: section.options.maxAgents, platform: plan.workflow.platform } } : {}),
        check: (list) => {
          // The caller's guard (the Assistant's control and launch, HI-1502) at the write itself, under the lock.
          try {
            o.guard?.()
          } catch (e) {
            throw callers(e)
          }
          if (changed(list.map((a) => a.id))) throw refusal(msg({ id: 'content.templates.changedWhile', defaultMessage: "The project's agents changed while the template was loading: nothing was changed. Open the template again.", description: "An error loading a template: the project's agents changed while it loaded, so nothing changed." }), undefined, 'conflict')
        },
        taken: o.taken ? async (clash) => callers(await o.taken!(clash)) : (clash) => new TemplateError(takenText(clash, true), { kind: 'conflict' })
      })
    } catch (e) {
      for (const s of staged) await s.discard()
      // A refusal (Hive's, or the caller's guard's or names' own, HI-1502) goes on as it is, its kind and status kept; a
      // failure making the agents is said as one.
      throw e instanceof HiveError || fromCaller.has(e as object) ? e : refusal(msg({ id: 'content.templates.failed', defaultMessage: 'Nothing was changed: {error}', description: "An error loading a template: making its agents failed, so nothing changed; {error} is why (often git's own words)." }), { error: errorText(e) })
    }
    log.info(`Loaded template ${userText(plan.name)} into ${userText(projectPath)}: ${before.agents.length} agents removed, ${staged.length} created${before.maxAgents !== undefined ? `, Maximum agents ${before.maxAgents}` : ''}`)
    if (before.maxAgents !== undefined) workflowChanged(workspaceOf(projectPath), projectPath)
    await agentsGone(projectPath, before.agents.map((a) => a.id))
    // The workflow section of the template as this load read it (HR5's HI-1910 round 1): the window applies it only if it
    // is the one it showed, never one read before the template changed.
    const after = { agents: staged.map((s) => s.def), layout: plan.layout }
    return { created: after.agents.map((a) => a.name), removed: before.agents.map((a) => a.name), workflow: plan.workflow?.section ?? null, plan, before, after }
  })
}

/**
 * Runs a replacement of the project's agents (a load, undo putting them back): one per project at a time (another is
 * refused), the project's agents unable to start for the whole of it (a fence, `fenceWhy`), lifted however it ends.
 */
async function whileReplacing<T>(projectPath: string, fenceWhy: Msg, fn: () => Promise<T>): Promise<T> {
  const key = projectPath.toLowerCase()
  if (loading.has(key)) throw refusal(M.loading, undefined, 'conflict')
  loading.add(key)
  const unfence = sessions.fenceStarts(projectPath, fenceWhy)
  try {
    return await fn()
  } finally {
    unfence()
    loading.delete(key)
  }
}

/**
 * Publishes a new list of the project's agents and its layout at once (a template's load, undo of one: HI-1502): their
 * names checked against the other projects' agents holding the workspace's names lock (#702: another project may have
 * taken one meanwhile; `taken` words the refusal, never a name made up), then one write under the project file's lock,
 * only if `check` passes on the agents as they are now (the caller's: those it expects), none of them runs or is
 * starting, the new list fits Maximum agents as it is now (HI-2001; the user's too, HI-2058, or as the load saves it with
 * `loadedMax`, its workflow applied; `anyMax`, undo putting agents back, only the most any project has) and each one's
 * connection can be used here (HI-1769). A removed agent's worktree whose setup never ran is remembered for the next agent
 * given it (#289). Returns the agents and layout it replaced, and the Maximum agents it saved; what follows a removal
 * (`agentsGone`) is the caller's, once it is published.
 */
async function replaceProjectAgents(projectPath: string, r: { next: AgentDef[]; layout: PageLayout; by: AddedBy; loadedMax?: { m: unknown; platform: PlatformId }; anyMax?: boolean; check: (list: AgentDef[], now: ProjectConfig) => void; taken: Taken }): Promise<{ agents: AgentDef[]; layout: PageLayout; maxAgents?: number }> {
  let before: { agents: AgentDef[]; layout: PageLayout; maxAgents?: number } | null = null
  await withAgentNames(projectPath, async () => {
    const others = (await workspaceAgents(projectPath)).filter((a) => a.project.toLowerCase() !== basename(projectPath).toLowerCase())
    const clash = r.next.flatMap((d) => {
      const owner = nameTaken(d.name, others)
      return owner ? [{ name: d.name, project: owner.project }] : []
    })
    if (clash.length) throw await r.taken(clash)
    await workspace.mutateProjectConfig(projectPath, (now) => {
      const list = projectAgents(now)
      r.check(list, now)
      if (list.some((a) => busy(projectPath, a.id))) throw refusal(msg({ id: 'content.templates.started', defaultMessage: 'An agent started meanwhile: nothing was changed. Stop it first.', description: "An error loading a template: one of the project's agents started while it loaded, so nothing changed." }), undefined, 'conflict')
      // Maximum agents as it is now (HI-2001), the final list against it: the workflow may have lowered it, or an agent been
      // added, since the plan. The user's load with its workflow saves the template's (HI-2058) and is checked against that.
      const n = r.next.length
      if (n > AGENT_LIMIT_MAX) throw refusal(M.nothing, { problem: agentLimitText(tr) })
      const max = agentMax(projectPath, now)
      const saves = r.loadedMax ? loadedMaxAgents(r.loadedMax.m, n, max) : null
      const limit = saves ?? max
      if (!r.anyMax && n > limit) throw r.by === 'agent' ? refusal(M.nothing, { problem: templateLimitText(n, limit) }) : refusal(M.overMax, { count: n, max: limit })
      // Each one's connection as it is now (HI-1769): one turned off or removed while they were prepared stops it.
      for (const def of r.next) if (def.connection) assertConnectionHere(getConnection(def.connection)?.account ?? def.connection, def.provider!, projectPath, def.name)
      // The layout as kept (auto when none was chosen), so undo puts back exactly what was there. The template's own maximum
      // is saved even when it equals the one inherited now, so a later change to the defaults doesn't move this team's.
      const saved = saves !== null && r.loadedMax ? saves : undefined
      before = { agents: list, layout: now.layout ?? 'auto', ...(saved !== undefined ? { maxAgents: saved } : {}) }
      const pending = [...(Array.isArray(now.setupPending) ? now.setupPending.filter((p) => typeof p === 'string') : []), ...list.filter((a) => legacySetupPending(a)).map((a) => legacyWorktree(a)!.path)]
      return { agents: r.next, layout: r.layout, setupPending: [...new Map(pending.map((p) => [placeKey(p), p])).values()].slice(-50), ...(saved !== undefined && r.loadedMax ? ownPreferenceChange(now, r.loadedMax.platform, 'maxAgents', saved) : {}) }
    })
  })
  return before!
}

/**
 * Puts a project's agents and layout back as they were before a template's load (the Assistant's undo, HI-1502): as a
 * load publishes (`replaceProjectAgents`, one replacement at a time, the project's starts fenced for the whole of it),
 * only if `check` passes on the agents as they are now; the agents it removes (those the load made) go as any removed
 * agent does (`agentsGone`). The restored agents keep their ids, so their conversations are theirs again.
 */
export async function restoreProjectAgents(projectPath: string, back: { agents: AgentDef[]; layout: PageLayout }, check: (list: AgentDef[], now: ProjectConfig) => void, taken: Taken): Promise<void> {
  projectPath = workspace.assertProject(projectPath)
  await whileReplacing(projectPath, M.restoring, async () => {
    // What was there before: put back whatever Maximum agents is now (HI-2001), as the user's own agents were.
    const was = await replaceProjectAgents(projectPath, { next: back.agents, layout: back.layout, by: 'user', anyMax: true, check, taken })
    const kept = new Set(back.agents.map((a) => a.id))
    await agentsGone(projectPath, was.agents.filter((a) => !kept.has(a.id)).map((a) => a.id))
  })
}

/**
 * The connection each agent to create gets (HI-2109), by `create`'s index: the picker's answer for it (its name, the
 * template's name for it, its role, all), else its role's preselected one (the first on the CLI its role suggests, else
 * the first usable). An answer is a connection's id or name among those usable here now: one removed or turned off since
 * it was offered, a name several have, or a key that is no role or agent is refused, nothing loaded. Each is checked
 * again as the agent is prepared and with the write.
 */
function connectionsFor(plan: TemplateLoadPlan, answers: ConnectionAnswers | undefined): string[] {
  // Each agent's own choice by its name in the template, as made for the project: one edited since (renamed, removed,
  // another in its place) has none of the choices made for another, which are refused (HR3's round 2).
  const agents: PickedAgent[] = plan.create.map((a, i) => ({ key: plan.templateNames[i], name: a.name, role: a.role, provider: a.provider }))
  return resolveAnswers(agents, plan.options, answers, loadFallback(agents, plan.options)).map((id) => id ?? '')
}

/**
 * What a template's agent is made on: its connection (its CLI follows: prepareAgent), never the CLI it suggests; with
 * none usable here, that CLI when this Hive knows it (else the first usable, as Add Agent's), placed once an account is.
 */
const onConnection = (a: TemplateAgent, connection: string | undefined): { connection: string } | { provider?: ProviderId } => (connection ? { connection } : a.provider && isKnownProvider(a.provider) ? { provider: a.provider } : {})

/** Each agent's connection id from answers (`answerFor`), the refs checked against `options`; none answered: undefined. */
function resolveAnswers(agents: readonly PickedAgent[], options: readonly ConnectionOption[], answers: ConnectionAnswers | undefined, fallback: (a: PickedAgent) => string | undefined): (string | undefined)[] {
  // Untrusted (a window's, the Agent API's once read): a role or an agent (by its key) it doesn't have is refused, said.
  const bad = badAnswers(agents.map((a) => a.key), answers)
  if (bad.length) throw refusal(M.connectionKeys, { keys: listOf(bad) }, 'invalid')
  return answerFor(agents, answers, fallback).map((ref) => {
    if (ref === undefined) return undefined
    const found = optionNamed(options, ref)
    if (found.ok) return found.option.id
    throw found.why === 'ambiguous' ? refusal(M.connectionAmbiguous, { ref, ids: listOf(found.ids ?? []) }, 'conflict') : refusal(M.connectionUnknown, { ref }, 'conflict')
  })
}

/** The agents Choose Connections… works on (HI-2109): the project's, by their roles, with their CLIs and connections. */
export async function connectionsPlan(projectPath: string): Promise<ConnectionsPlan> {
  projectPath = workspace.assertProject(projectPath)
  // Each agent's connection is a connection's id once its project is migrated (HI-2106).
  await ensureMigrated(projectPath)
  const cfg = await workspace.projectConfig(projectPath)
  const agents = projectAgents(cfg).map((a) => ({ id: a.id, name: a.name, role: agentWorkflowRole(a), provider: agentProvider(a, config.settings), ...(a.connection ? { connection: a.connection } : {}), running: busy(projectPath, a.id) }))
  return { project: basename(projectPath), agents, options: connectionOptions(projectPath) }
}

/**
 * Choose Connections… (HI-2109): the project's existing agents given connections by the picker's answers (all, a role,
 * an agent by name), nothing else changed, nothing loaded or replaced; an agent no answer names keeps its own. Each
 * through Agent Settings' save (`updateAgent`: checked under the project's lock, its CLI with it), one by one. An agent
 * that runs keeps running on its old connection until it restarts (`restart`); one whose answer is another CLI's can't
 * change while it runs (its conversations stay with its CLI), and one removed meanwhile is skipped: both said
 * (`skipped`), the others changed. Every answer is checked before anything changes. `check` (the Assistant's guard and
 * undo's record) runs in each agent's write. `expected` (HR3's round 2): the agents' ids as the choices were made for
 * them, in order; the project's agents otherwise now (one added, removed or moved) refuse it all, nothing changed, and
 * each agent's own choice is bound to its id.
 */
export async function applyConnections(projectPath: string, answers: ConnectionAnswers | undefined, o: { expected?: readonly string[]; check?: (current: AgentDef) => void; changed?: (was: AgentDef, now: AgentDef) => Promise<void> } = {}): Promise<ConnectionsApplied> {
  await testHooks.applying?.()
  const plan = await connectionsPlan(projectPath)
  projectPath = workspace.assertProject(projectPath)
  const shownNow = plan.agents.map((a) => a.id)
  if (o.expected && (o.expected.length !== shownNow.length || o.expected.some((id, i) => id !== shownNow[i]))) throw refusal(M.agentsChanged, undefined, 'conflict')
  const ids = resolveAnswers(plan.agents.map((a) => ({ ...a, key: a.id })), plan.options, answers, () => undefined)
  const out: ConnectionsApplied = { changed: [], restart: [], skipped: [] }
  for (const [i, a] of plan.agents.entries()) {
    const id = ids[i]
    if (!id || id === a.connection) continue
    const cli = plan.options.find((x) => x.id === id)!.cli
    if (cli !== a.provider && busy(projectPath, a.id)) {
      out.skipped.push({ name: a.name, why: 'running' }) // i18n-ignore: a reason's code, not text
      continue
    }
    let was: AgentDef | undefined
    try {
      const now = await updateAgent(projectPath, a.id, { connection: id, ...(cli !== a.provider ? { provider: cli } : {}) }, {
        check: (current) => {
          o.check?.(current)
          was = structuredClone(current)
        }
      })
      out.changed.push(now.name)
      if (sessions.liveFor(projectPath, a.id)) out.restart.push({ id: a.id, name: now.name })
      if (was) await o.changed?.(was, now)
    } catch (e) {
      // Removed meanwhile: the others still change. Anything else (a guard, a check) stops it, said as it is.
      if (!projectAgents(await workspace.projectConfig(projectPath)).some((x) => x.id === a.id)) out.skipped.push({ name: a.name, why: 'gone' }) // i18n-ignore: a reason's code, not text
      else throw e
    }
  }
  log.info(`Chose connections in ${userText(projectPath)}: ${out.changed.length} changed${out.skipped.length ? `, ${out.skipped.length} skipped` : ''}`)
  return out
}

/**
 * Adds one agent of a template to the project, the others left alone, in the project folder with its role in the
 * workflow and note (#1436): named `name` when given (the dialog's, #1440: refused, with a free one to try, when another
 * agent of the workspace has it), else its pattern made with the project's key, a name already taken numbered
 * ("Builder 2"). Its connection (HI-2109): `connection` (an id or name usable here), else its role's preselected one
 * (the first on the CLI it suggests, else the first usable).
 */
export async function addAgentFromTemplate(projectPath: string, scope: TemplateScope, file: string, index: number, from?: string, chosen?: string, by: AddedBy = 'agent', connection?: string): Promise<AgentDef> {
  projectPath = workspace.assertProject(projectPath)
  const t = await usable(refFor(projectPath, scope, file, from))
  const a = Number.isInteger(index) ? t.agents[index] : undefined
  if (!a) throw refusal(msg({ id: 'content.templates.agentGone', defaultMessage: 'That agent is no longer in the template.', description: 'An error adding one agent from a template: the template no longer has it (edited meanwhile).' }), undefined, 'notFound')
  // Unique across the workspace (#702): a name any agent of it has gets a number ("Builder 2"), never a prefix.
  const own = (await namesIn(projectPath, t.agents))[index]
  const name = typeof chosen === 'string' && chosen.trim() ? withNames([{ ...a, name: own }], [chosen])[0].name : uniqueName(own, (await workspaceAgents(projectPath)).map((x) => x.name))
  const options = connectionOptions(projectPath)
  const picked = { key: name, name, role: a.role, provider: a.provider }
  const [id] = resolveAnswers([picked], options, typeof connection === 'string' && connection.trim() ? { agents: { [name]: connection } } : undefined, loadFallback([picked], options))
  return addAgent(projectPath, { name, role: a.note, workflowRole: a.role, mcpServers: a.mcpServers, ...onConnection(a, id), location: 'project' }, by)
}
