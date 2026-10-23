import { existsSync } from 'original-fs'
import { mkdir, readFile, readdir, stat } from 'original-fs/promises'
import { basename, join, resolve } from 'path'
import { HIVE_DIR, projectAgents } from '../shared/defaults'
import { agentProvider, isKnownProvider, isProviderEnabled, providerDescriptor, PROVIDERS } from '../shared/providers'
import {
  exportable,
  exportFileName,
  isAgentTemplate,
  isTemplateFile,
  readTemplate,
  TEMPLATE_VERSION,
  templateAgentNames,
  templatePairs,
  namesKey,
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
import { HIVE_TEMPLATES, hiveTemplate, type HiveTemplate } from '../shared/templateDefaults'
import type { AgentBranchStatus, AgentDef, AgentWorktree, ProjectConfig, ProviderId, TemplateLoadPlan } from '../shared/types'
import { config } from './config'
import { placeKey, readKeptJson, withFileLock, writeKeptJson, writeTextAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { addAgent, agentLimit, prepareAgent } from './projectAgents'
import { projectKeyOf } from './projectKeys'
import { providerService } from './providerService'
import { sessions } from './sessions'
import { endReviews, releaseAgentCards } from './tasks'
import { workspace, workspaceOf } from './workspace'
import * as wt from './worktrees'
import { englishText, listOf, shownText, withValues, type Text, type TextPart, type TextValues } from '../shared/advanced'
import { msg, tr, type Msg } from '../shared/i18n'
import { errorText, HiveError } from './hiveError'
import { trash } from './trash'
import { withAgentNames, workspaceAgents } from './agentNames'
import { AGENT_NAME_MAX, agentNameProblem, nameTaken, sameAgentName } from '../shared/agentNames'

/**
 * Agent templates (#126): a project's agents and layout saved under a name, in the workspace (`<workspace>/.hive/
 * templates`, for every project) or the project (`<project>/.hive/templates`, private: the project's .hive is kept out
 * of git). One kept JSON file each (a damaged one is recovered from its copy). Loading one replaces the project's agents
 * — only when it is safe (none running, no uncommitted work in their worktrees, every provider on and installed), and
 * all or nothing; adding one agent from a template leaves the others alone. #127: listing every scope, rename,
 * duplicate, delete (to the Recycle Bin), and export and import as files, read as untrusted. #1436: Hive's own templates
 * (the Hive scope, read-only, `shared/templateDefaults.ts`), and agents created in the project folder with their role
 * in the workflow, note and pairing.
 */

const log = createLogger('templates')

/** A template that isn't there, or can't be used: the caller says so as it is, in the window's language (#849). */
export class TemplateError extends HiveError {}

/** A refusal from a message and its values. */
const refusal = (m: Msg, values?: TextValues, kind?: 'invalid' | 'notFound' | 'conflict'): TemplateError => new TemplateError(values ? withValues(m, values) : m, kind ? { kind } : undefined)

/** Templates' refusals and the load plan's reasons, which only the window reads (#849): IPC shows them in its language. */
const M = {
  gone: msg({ id: 'content.templates.gone', defaultMessage: 'That template is no longer there.', description: 'An error: the template was deleted or renamed meanwhile.' }),
  nameTaken: msg({ id: 'content.templates.nameTaken', defaultMessage: 'There is already a template called "{name}" there.', description: 'An error renaming or editing a template: another template where it is kept (the workspace or a project) is called {name}.' }),
  provider: msg({ id: 'content.templates.provider', defaultMessage: '{problem, select, unknown {This Hive doesn\'t know the coding agent "{provider}" (update Hive)} off {{provider} is turned off (Settings → Providers)} other {{provider} isn\'t installed (Agent Setup)}}', description: "Why a template can't be loaded: a coding agent CLI it needs. {problem} is why: unknown ({provider} is the id the template gives, which this version of Hive doesn't know), off (turned off in Settings → Providers), or not installed (Agent Setup is a Help window). {provider} is otherwise its name (\"Codex\")." }),
  neededBy: msg({ id: 'content.templates.neededBy', defaultMessage: '{problem, select, unknown {This Hive doesn\'t know the coding agent "{provider}" (update Hive), needed by {agents}.} off {{provider} is turned off (Settings → Providers), needed by {agents}.} other {{provider} isn\'t installed (Agent Setup), needed by {agents}.}}', description: "Why a template can't be loaded: a coding agent CLI its agents {agents} (their names, listed in the language's way: \"Builder and Reviewer\") need. {problem} and {provider} as in the reason without the agents." }),
  needsIt: msg({ id: 'content.templates.needsIt', defaultMessage: '{problem, select, unknown {This Hive doesn\'t know the coding agent "{provider}" (update Hive): {agent} needs it.} off {{provider} is turned off (Settings → Providers): {agent} needs it.} other {{provider} isn\'t installed (Agent Setup): {agent} needs it.}}', description: "An error adding one agent from a template: the coding agent CLI it needs. {agent} is its name; {problem} and {provider} as in the reason a template can't be loaded." }),
  taken: msg({ id: 'content.templates.taken', defaultMessage: '{names} {count, plural, one {is already an agent} other {are already agents}} in {projects}: agent names are unique across the workspace, so rename {count, plural, one {it} other {them}}.', description: "Why a template can't be loaded: agents of other projects ({projects}) have its agents' names {names} ({count} of them). {names} and {projects} are lists, in the language's way (\"B1 and R1\")." }),
  takenNothing: msg({ id: 'content.templates.takenNothing', defaultMessage: '{names} {count, plural, one {is already an agent} other {are already agents}} in {projects}: agent names are unique across the workspace, so rename {count, plural, one {it} other {them}}. Nothing was changed.', description: "An error loading a template: agents of other projects ({projects}) took its agents' names {names} ({count} of them) while it loaded, so nothing changed. {names} and {projects} are lists, in the language's way (\"B1 and R1\")." }),
  nothing: msg({ id: 'content.templates.nothing', defaultMessage: '{problem} Nothing was changed.', description: "An error loading a template, nothing changed: {problem} is why, a sentence of its own (how many agents a project can have)." }),
  hiveOnly: msg({ id: 'content.templates.hiveOnly', defaultMessage: "Hive's own templates can't be changed: duplicate one into the workspace or a project to change it.", description: "An error: saving, renaming, editing, importing into or deleting one of Hive's own templates (the Hive scope, read-only). Duplicate is a button: as Hive names it." })
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
  if (scope === 'project') return join(workspace.assertProject(String(d.project ?? '')), HIVE_DIR, 'templates')
  const ws = d.project ? workspaceOf(d.project).path : workspace.path
  if (!ws) throw refusal(msg({ id: 'content.templates.noWorkspace', defaultMessage: 'Open a workspace first.', description: "An error: the workspace's templates need a workspace open." }))
  return join(ws, HIVE_DIR, 'templates')
}

/** The place a template is kept, as listed (a project's path only for a project's templates). */
const place = (d: TemplateDest): TemplateDest => (d.scope === 'project' ? { scope: 'project', project: workspace.assertProject(String(d.project ?? '')) } : { scope: d.scope === 'hive' ? 'hive' : 'workspace' })

/** What a template suggests and pairs, as an entry carries it (#1436). */
const extras = (t: Pick<AgentTemplate, 'suggestedPreset' | 'reviewerMode' | 'pairs'>): Pick<TemplateEntry, 'suggestedPreset' | 'reviewerMode' | 'pairs'> => ({ ...(t.suggestedPreset ? { suggestedPreset: t.suggestedPreset } : {}), ...(t.reviewerMode ? { reviewerMode: t.reviewerMode } : {}), ...(t.pairs?.length ? { pairs: t.pairs } : {}) })

/** One of Hive's own templates as listed (#1436): its name and description in the language Hive shows now. */
function hiveEntry(h: HiveTemplate): TemplateEntry {
  const t = h.template
  return { scope: 'hive', file: h.file, name: tr(h.name), savedAt: null, layout: t.layout, description: tr(h.description), agents: t.agents, ...extras(t) }
}

async function readOne(d: TemplateDest, file: string): Promise<TemplateEntry> {
  if (d.scope === 'hive') {
    const h = hiveTemplate(file)
    if (!h) throw refusal(M.gone, undefined, 'notFound')
    return hiveEntry(h)
  }
  const where = place(d)
  const raw = await readKeptJson<unknown>(join(folder(d), file), null)
  const t = raw === null ? msg({ id: 'content.templates.unreadable', defaultMessage: "It couldn't be read.", description: "Why a template can't be used: its file couldn't be read." }) : readTemplate(raw)
  if (!isAgentTemplate(t)) {
    const name = raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string' ? String((raw as { name: string }).name).slice(0, TEMPLATE_NAME_MAX) : file.replace(/\.json$/, '')
    // Why, in English for the log and a refusal's message, and as text the window shows in its language (#870).
    return { ...where, file, name, savedAt: null, layout: 'auto', agents: [], problem: englishText(t), problemText: t }
  }
  return { ...where, file, name: t.name, savedAt: t.savedAt || null, layout: t.layout, ...(t.description ? { description: t.description } : {}), agents: t.agents, ...extras(t) }
}

/** The templates kept in one place, by file name (Hive's own in their order). */
async function listIn(d: TemplateDest): Promise<TemplateEntry[]> {
  if (d.scope === 'hive') return HIVE_TEMPLATES.map(hiveEntry)
  const files = (await readdir(folder(d)).catch(() => [] as string[])).filter(isTemplateFile).sort()
  const out: TemplateEntry[] = []
  for (const f of files) out.push(await readOne(d, f))
  return out
}

const byName = (a: TemplateEntry, b: TemplateEntry): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.scope === 'workspace' ? -1 : 1)

/**
 * The templates a project can use: Hive's own (#1436, in their order), then the workspace's and its own, each by name
 * (a name in both scopes is listed twice).
 */
export async function listTemplates(projectPath: string): Promise<TemplateEntry[]> {
  projectPath = workspace.assertProject(projectPath)
  const out = [...(await listIn({ scope: 'workspace', project: projectPath })), ...(await listIn({ scope: 'project', project: projectPath }))]
  return [...(await listIn({ scope: 'hive' })), ...out.sort(byName)]
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

/** The lock of one folder of templates (`changing`'s), for what else changes its files: 0.9's set aside and put back (#1436). */
export function withTemplatesLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(`${resolve(dir)}|templates`, fn)
}

/** Writes a template into a place (its file there: a new one, or the one it replaces). */
async function write(d: TemplateDest, file: string, t: AgentTemplate): Promise<TemplateEntry> {
  await mkdir(folder(d), { recursive: true })
  await writeKeptJson(join(folder(d), file), exportable(t))
  return readOne(d, file)
}

/**
 * Saves the project's agents and layout as a template in `scope`. A template of that name already there (case aside) is
 * replaced only with `overwrite`; otherwise the answer says it exists, so the user can be asked.
 */
export async function saveTemplate(projectPath: string, scope: TemplateScope, name: string, overwrite = false): Promise<{ saved: TemplateEntry } | { exists: string }> {
  projectPath = workspace.assertProject(projectPath)
  const d: TemplateDest = { scope: checkScope(scope), project: projectPath }
  const clean = cleanName(name)
  const cfg = await workspace.projectConfig(projectPath)
  const agents = projectAgents(cfg)
  if (!agents.length) throw refusal(msg({ id: 'content.templates.noAgents', defaultMessage: 'This project has no agents to save.', description: "An error saving a project's agents as a template: it has none." }))
  const t = templateFrom(clean, agents, cfg.layout, (a) => agentProvider(a, cfg, config.settings), new Date(), presetOf(cfg))
  return changing(d, async () => {
    // The same name: its file (replaced when asked). Another name whose file name would be the same: a file of its own.
    const same = (await listIn(d)).find((e) => e.name.toLowerCase() === clean.toLowerCase())
    if (same && !overwrite) return { exists: same.file }
    const saved = await write(d, same?.file ?? (await newFile(d, clean)), t)
    log.info(`Saved template ${userText(clean)} (${scope}, ${t.agents.length} agents)`)
    return { saved }
  })
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
  const base = { ...(edited as object), version: TEMPLATE_VERSION, name: clean, savedAt: new Date().toISOString() }
  const checked = readTemplate(base)
  if (!isAgentTemplate(checked)) throw new TemplateError(checked, { kind: 'invalid' })
  return changing(ref, async () => {
    const now = await usable(ref)
    // What the editor doesn't change (#1436) stays: the preset and reviewer mode it suggests, and each of its pairs while
    // it still fits the agents as edited (an agent renamed, removed or given a role on the other side drops its own pair
    // only: templatePairs keeps the others, each agent in one pair).
    const kept = { ...(now.suggestedPreset ? { suggestedPreset: now.suggestedPreset } : {}), ...(now.reviewerMode ? { reviewerMode: now.reviewerMode } : {}) }
    const agent = (n: string): TemplateAgent | undefined => checked.agents.find((a) => sameAgentName(a.name, n))
    const pairs = templatePairs((now.pairs ?? []).flatMap((p) => {
      const b = agent(p.builder)
      const r = agent(p.reviewer)
      return b && r ? [{ name: b.name, role: b.role, pairedWith: r.name }, { name: r.name, role: r.role }] : []
    }))
    const t = { ...checked, ...kept, ...(pairs.length ? { pairs } : {}) }
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

/** Deletes a template: its file (and the copy kept beside it) go to the Recycle Bin. Hive's own can't be (#1436). */
export async function deleteTemplate(ref: TemplateRef): Promise<void> {
  await changing(ref, async () => {
    const f = fileOf(ref)
    await trash(f)
    if (existsSync(`${f}.bak`)) await trash(`${f}.bak`).catch((e) => log.warn('Could not remove the copy of a deleted template', e))
    log.info(`Deleted template ${userText(ref.file)} (${ref.scope})`)
  })
}

/** The file name an export of a template suggests ("Build and review.hive-template.json"); refused if it can't be used. */
export async function exportName(ref: TemplateRef): Promise<string> {
  return exportFileName((await usable(ref)).name)
}

/** Exports a template to a file the user chose: what it holds, nothing else (exportable). */
export async function exportTemplate(ref: TemplateRef, dest: string): Promise<void> {
  const t = await usable(ref)
  await writeTextAtomic(dest, JSON.stringify(exportable(t.template), null, 2) + '\n')
  log.info(`Exported template ${userText(t.name)} to ${userText(dest)}`)
}

/** A file to import, read and checked (untrusted): the template, or refused saying why. Nothing is written. */
export async function readImport(path: string): Promise<AgentTemplate> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw refusal(msg({ id: 'content.templates.noFile', defaultMessage: "That file isn't there.", description: 'An error importing a template: the file chosen is gone.' }), undefined, 'notFound')
  if (info.size > TEMPLATE_IMPORT_MAX) throw refusal(msg({ id: 'content.templates.importTooLarge', defaultMessage: "It isn't a Hive agent template (over {kb} KB).", description: 'An error importing a template: the file is larger than {kb} KB, more than any template.' }), { kb: TEMPLATE_IMPORT_MAX / 1024 })
  let raw: unknown
  try {
    raw = JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''))
  } catch {
    throw refusal(msg({ id: 'content.templates.importNotJson', defaultMessage: "It isn't a Hive agent template (not JSON).", description: "An error importing a template: the file isn't JSON." }))
  }
  const t = readTemplate(raw)
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

/** Why a provider can't run here (unknown to this Hive, off, or not installed), with the name it goes by (its id when unknown), or null. */
function providerProblem(id: ProviderId): { problem: NonNullable<TemplateLoadPlan['missing'][number]['problem']>; provider: string } | null {
  if (!isKnownProvider(id)) return { problem: 'unknown', provider: id }
  const name = providerDescriptor(id).name
  if (!isProviderEnabled(config.settings, id)) return { problem: 'off', provider: name }
  if (!providerService.info(id).found) return { problem: 'notInstalled', provider: name }
  return null
}

/** A template used in a project: a project's is looked up in `from` (another project's, from the Templates view), else in that project. */
const refFor = (projectPath: string, scope: TemplateScope, file: string, from?: string): TemplateRef => ({ scope: checkScope(scope), project: scope === 'project' && from ? from : projectPath, file })

/** A worktree's `branchStatus`, as one plan reads it (#732: once each, though the plan looks at one twice). */
type StatusOf = (w: AgentWorktree) => Promise<AgentBranchStatus>

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

/** The key a template's names are expanded with in a project (`namesKey`, #1123 names). */
async function keyFor(projectPath: string): Promise<string> {
  return namesKey(await projectKeyOf(workspaceOf(projectPath), projectPath).catch(() => null), basename(projectPath))
}

/**
 * The provider one of Hive's own templates' agents runs instead of one that can't run here (#1436): the first provider,
 * in Hive's order (Claude Code first), that is on and installed; null when none is.
 */
function standIn(): ProviderId | null {
  return PROVIDERS.map((d) => d.id).find((id) => !providerProblem(id)) ?? null
}

/** Names another project's agents have, in a refusal: "B1, R1 are already agents in amberlight: … rename them" (and nothing changed, at the load's end). */
function takenText(taken: { name: string; project: string }[], nothingChanged = false): Text {
  const where = listOf([...new Set(taken.map((t) => t.project))])
  return withValues(nothingChanged ? M.takenNothing : M.taken, { names: listOf(taken.map((t) => t.name)), count: taken.length, projects: where })
}

/** Whether an agent is running or starting (a start reserved, not yet live): either way, not safe to remove. */
const busy = (projectPath: string, agentId: string): boolean => !!sessions.liveFor(projectPath, agentId) || sessions.startingFor(projectPath, agentId)

/**
 * What loading a template into a project would do: the agents removed and created, the layout, and what stops it now —
 * an agent running or starting, a removed worktree agent's uncommitted work (or a worktree whose state git can't tell:
 * then it isn't known to be safe), a provider that is off or not installed. Nothing is changed. The repository is read
 * once for the whole plan, not once per agent (#732). The created agents work in the project folder (#1436); one of
 * Hive's own templates' agents whose provider can't run here runs one that can (`swaps`), said on its row.
 */
export async function templatePlan(projectPath: string, scope: TemplateScope, file: string, from?: string, names?: string[], reads?: wt.RepoReads): Promise<TemplateLoadPlan> {
  return (await planFor(projectPath, scope, file, from, names, reads)).plan
}

/** The plan, with what stops it as text (`why`, which `blocked` says in the window's language): a load refuses with it. */
async function planFor(projectPath: string, scope: TemplateScope, file: string, from?: string, names?: string[], reads?: wt.RepoReads): Promise<{ plan: TemplateLoadPlan; why: TextPart[] }> {
  projectPath = workspace.assertProject(projectPath)
  const repo = reads ?? new wt.RepoReads(projectPath)
  const status = statusReads(projectPath, repo)
  const original = await usable(refFor(projectPath, scope, file, from))
  // Its patterns as this project's names (#1123 names), then the names chosen in the dialog.
  const expanded = templateAgentNames(original.agents, await keyFor(projectPath))
  const t = { ...original, agents: withNames(original.agents.map((a, i) => ({ ...a, name: expanded[i] })), names) }
  const cfg = await workspace.projectConfig(projectPath)
  const current = projectAgents(cfg)
  const remove: TemplateLoadPlan['remove'] = []
  const blocked: TextPart[] = []
  for (const a of current) {
    const running = busy(projectPath, a.id)
    let dirty = 0
    if (a.worktree && existsSync(a.worktree.path)) {
      // As Remove Agent checks before a worktree goes: strictly, so a git that fails never reads as "nothing to lose".
      try {
        dirty = (await status(a.worktree)).dirty
      } catch (e) {
        blocked.push(withValues(msg({ id: 'content.templates.checkFailed', defaultMessage: "Hive couldn't check {agent}'s worktree ({folder}): {error}", description: "Why a template can't be loaded: git couldn't tell whether the worktree {folder} of the agent {agent} it would remove has uncommitted work; {error} is why (often git's own words)." }), { agent: a.name, folder: a.worktree.path, error: firstLine(e) }))
      }
    }
    remove.push({ id: a.id, name: a.name, running, dirty, ...(a.worktree ? { worktree: { path: a.worktree.path, branch: a.worktree.branch } } : {}) })
    if (running) blocked.push(withValues(msg({ id: 'content.templates.running', defaultMessage: '{agent} is running or starting: stop it first.', description: "Why a template can't be loaded: the agent {agent} it would replace is running." }), { agent: a.name }))
    if (dirty) blocked.push(withValues(msg({ id: 'content.templates.uncommitted', defaultMessage: '{agent} has uncommitted work in its worktree ({folder}): commit or discard it first.', description: "Why a template can't be loaded: the worktree {folder} of the agent {agent} it would replace has work not committed." }), { agent: a.name, folder: a.worktree!.path }))
  }
  // Hive's own: an agent whose provider can't run here runs one that can (#1436: never a silent failure, said on its
  // row). A template the user made stays as it is: refused, saying what to turn on or install.
  const swaps: TemplateLoadPlan['swaps'] = []
  const sub = scope === 'hive' ? standIn() : null
  const create: TemplateAgent[] = t.agents.map((a, index) => {
    const why = sub && a.provider !== sub ? providerProblem(a.provider) : null
    if (!why || why.problem === 'unknown') return a
    swaps.push({ index, from: a.provider, to: sub!, problem: why.problem })
    // Its effort and mode are the other provider's to name: the stand-in's defaults instead.
    const { model: _m, effort: _e, permissionMode: _p, ...rest } = a
    return { ...rest, provider: sub! }
  })
  const missing: TemplateLoadPlan['missing'] = []
  for (const id of [...new Set(create.map((a) => a.provider))]) {
    const why = providerProblem(id)
    if (why) {
      const agents = create.filter((a) => a.provider === id).map((a) => a.name)
      missing.push({ provider: id, reason: tr(M.provider, why), agents, problem: why.problem })
      blocked.push(withValues(M.neededBy, { ...why, agents: listOf(agents) }))
    }
  }
  // It replaces the project's agents: all of them have to fit (#562).
  const limit = agentLimit(projectPath)
  if (create.length > limit) blocked.push(templateLimitText(create.length, limit))
  // Names another project's agent has (#702): this project's own don't count, as the load replaces them.
  const others = (await workspaceAgents(projectPath)).filter((a) => a.project.toLowerCase() !== basename(projectPath).toLowerCase())
  const takenNames = create.flatMap((a) => {
    const owner = nameTaken(a.name, others)
    return owner ? [{ name: a.name, project: owner.project }] : []
  })
  // Its pairs by place, from the template's own names, so they follow the names chosen in the dialog.
  const at = (n: string): number => original.agents.findIndex((a) => a.name.toLowerCase() === n.toLowerCase())
  const pairs = (original.pairs ?? []).map((p) => ({ builder: at(p.builder), reviewer: at(p.reviewer) })).filter((p) => p.builder >= 0 && p.reviewer >= 0)
  // A suggestion the project's options already follow isn't one.
  const suggestedPreset = original.suggestedPreset && original.suggestedPreset !== presetOf(cfg) ? original.suggestedPreset : null
  const plan: TemplateLoadPlan = { scope: t.scope, file: t.file, name: t.name, layout: t.layout, remove, create, templateNames: expanded, taken: takenNames, pairs, swaps, suggestedPreset, reviewerMode: original.reviewerMode ?? null, missing, blocked: blocked.map(shownText) }
  return { plan, why: blocked }
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
} = {}

/** Loads under way, by project: one at a time each. */
const loading = new Set<string>()

/**
 * Replaces the project's agents with a template's, and its layout (#126). `expected` is the agents the user was shown
 * (their ids, in order). `from`: the project a project's template is kept in, when it isn't this one (#127: the Templates
 * view loads any template into any project).
 *
 * - The project's agents can't start for the whole load (a fence on its starts, lifted however the load ends), and one
 *   running or starting refuses it, as do the other checks of the plan.
 * - **Staged, then published at once:** the new agents are made without touching project.json, each in the project
 *   folder with its role in the workflow, note and pairing (#1436); then one write under the project file's lock swaps
 *   in the new agents and layout — only if the agents are still exactly those shown and none runs or is starting.
 *   Anything else (an agent added or removed meanwhile) refuses the load: no change made meanwhile is lost, and nothing
 *   half loaded is ever seen.
 * - The removed agents' worktrees and branches stay (to merge or reuse), their conversations stay in the Sessions tab,
 *   and their open cards go back (nobody has them; Doing ones to Todo).
 * - The template's suggested preset is only offered (the window opens the Workflow section with it), never applied here.
 */
export async function loadTemplate(projectPath: string, scope: TemplateScope, file: string, expected: string[], from?: string, names?: string[]): Promise<{ created: string[]; removed: string[] }> {
  projectPath = workspace.assertProject(projectPath)
  const key = projectPath.toLowerCase()
  if (loading.has(key)) throw refusal(msg({ id: 'content.templates.loading', defaultMessage: 'A template is already being loaded into this project.', description: 'An error loading a template while another load into the same project is under way.' }), undefined, 'conflict')
  loading.add(key)
  const unfence = sessions.fenceStarts(projectPath, msg({ id: 'content.templates.fenced', defaultMessage: 'A template is being loaded into this project', description: "Why an agent can't start (followed by \", so its agents can't start now.\"): a template is replacing the project's agents. A sentence without its full stop." }))
  try {
    // The plan's reads of the repository, which staging goes on using (#732).
    const reads = new wt.RepoReads(projectPath)
    const { plan, why } = await planFor(projectPath, scope, file, from, names, reads)
    if (why.length) throw new TemplateError({ lines: [msg({ id: 'content.templates.cantLoad', defaultMessage: "The template can't be loaded yet:", description: "An error loading a template, above the list of what stops it (each line a reason)." }), ...why.map((item) => withValues(msg({ id: 'content.templates.bullet', defaultMessage: '• {item}', description: 'A line of a list of reasons: a bullet, then the reason {item}.' }), { item }))] })
    const changed = (ids: string[]): boolean => !Array.isArray(expected) || ids.length !== expected.length || ids.some((id, i) => id !== expected[i])
    if (changed(plan.remove.map((a) => a.id))) throw refusal(msg({ id: 'content.templates.changedSince', defaultMessage: "The project's agents changed since you looked: open the template again.", description: "An error loading a template: the project's agents changed after the Load template dialog showed them." }), undefined, 'conflict')
    if (plan.taken.length) throw new TemplateError(takenText(plan.taken), { kind: 'conflict' })
    const cfg = await workspace.projectConfig(projectPath)
    const staged: { def: AgentDef; discard: () => Promise<void> }[] = []
    let old: AgentDef[] = []
    try {
      for (const a of plan.create) {
        const opts = { name: a.name, role: a.note, workflowRole: a.role, provider: a.provider, model: a.model, effort: a.effort, permissionMode: a.permissionMode, use200kContext: a.use200kContext, mcpServers: a.mcpServers, location: 'project' as const }
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
      // Published at once, under the lock, on the agents as they are now; their names checked with it, holding the
      // workspace's names lock (#702): another project may have taken one meanwhile.
      await withAgentNames(projectPath, async () => {
        const others = (await workspaceAgents(projectPath)).filter((a) => a.project.toLowerCase() !== basename(projectPath).toLowerCase())
        const clash = staged.flatMap((s) => {
          const owner = nameTaken(s.def.name, others)
          return owner ? [{ name: s.def.name, project: owner.project }] : []
        })
        if (clash.length) throw new TemplateError(takenText(clash, true), { kind: 'conflict' })
        await workspace.mutateProjectConfig(projectPath, (now) => {
          const list = projectAgents(now)
          if (changed(list.map((a) => a.id))) throw refusal(msg({ id: 'content.templates.changedWhile', defaultMessage: "The project's agents changed while the template was loading: nothing was changed. Open the template again.", description: "An error loading a template: the project's agents changed while it loaded, so nothing changed." }), undefined, 'conflict')
          if (list.some((a) => busy(projectPath, a.id))) throw refusal(msg({ id: 'content.templates.started', defaultMessage: 'An agent started meanwhile: nothing was changed. Stop it first.', description: "An error loading a template: one of the project's agents started while it loaded, so nothing changed." }), undefined, 'conflict')
          // The limit as it is now: Settings may have lowered it since the plan.
          const limit = agentLimit(projectPath)
          if (staged.length > limit) throw refusal(M.nothing, { problem: templateLimitText(staged.length, limit) })
          old = list
          // A removed agent's worktree whose setup never ran is remembered for the next agent given it (#289).
          const pending = [...(Array.isArray(now.setupPending) ? now.setupPending.filter((p) => typeof p === 'string') : []), ...list.filter((a) => a.worktree && a.needsSetup).map((a) => a.worktree!.path)]
          return { agents: staged.map((s) => s.def), layout: plan.layout, setupPending: [...new Map(pending.map((p) => [placeKey(p), p])).values()].slice(-50) }
        })
      })
    } catch (e) {
      for (const s of staged) await s.discard()
      throw e instanceof TemplateError ? e : refusal(msg({ id: 'content.templates.failed', defaultMessage: 'Nothing was changed: {error}', description: "An error loading a template: making its agents failed, so nothing changed; {error} is why (often git's own words)." }), { error: errorText(e) })
    }
    const project = basename(projectPath)
    for (const a of old) {
      await releaseAgentCards(project, a.id, { kind: 'user' }).catch((err) => log.warn('Could not take back the cards of a removed agent', err))
      await endReviews(project, a.id, 'the agent was removed', workspaceOf(projectPath)).catch(() => undefined) // i18n-ignore: a ReviewEnd key (tasks.ts words it)
    }
    log.info(`Loaded template ${userText(plan.name)} into ${userText(projectPath)}: ${old.length} agents removed, ${staged.length} created${plan.swaps.length ? `, ${plan.swaps.length} on another provider` : ''}`)
    await workspaceOf(projectPath).refresh()
    return { created: staged.map((s) => s.def.name), removed: old.map((a) => a.name) }
  } finally {
    unfence()
    loading.delete(key)
  }
}


/**
 * Adds one agent of a template to the project, the others left alone, in the project folder with its role in the
 * workflow and note (#1436): its name a pattern expanded with the project's key, and a name already taken gets a number
 * ("Builder 2").
 */
export async function addAgentFromTemplate(projectPath: string, scope: TemplateScope, file: string, index: number, from?: string): Promise<AgentDef> {
  projectPath = workspace.assertProject(projectPath)
  const t = await usable(refFor(projectPath, scope, file, from))
  const a = Number.isInteger(index) ? t.agents[index] : undefined
  if (!a) throw refusal(msg({ id: 'content.templates.agentGone', defaultMessage: 'That agent is no longer in the template.', description: 'An error adding one agent from a template: the template no longer has it (edited meanwhile).' }), undefined, 'notFound')
  const why = providerProblem(a.provider)
  if (why) throw refusal(M.needsIt, { ...why, agent: a.name })
  // Unique across the workspace (#702): a name any agent of it has gets a number ("Builder 2"), never a prefix.
  const own = templateAgentNames(t.agents, await keyFor(projectPath))[index]
  const name = uniqueName(own, (await workspaceAgents(projectPath)).map((x) => x.name))
  return addAgent(projectPath, { name, role: a.note, workflowRole: a.role, provider: a.provider, model: a.model, effort: a.effort, permissionMode: a.permissionMode, use200kContext: a.use200kContext, mcpServers: a.mcpServers, location: 'project' })
}
