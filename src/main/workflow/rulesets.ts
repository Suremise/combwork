// A project's workflow options, resolved (SPEC §16.6.6): the platform's defaults (every check and balance off), then the
// global defaults (config), the workspace's (workspace.json) and the project's own (project.json's `workflow.options`),
// each level setting only what it names and inheriting the rest, with where each option came from. Read-only here: the
// Version Control tab (#1278) edits them. Checked as they are read: an unknown option, a value it doesn't take (its type,
// or one of its choices) or a contradiction (options.ts) falls back to the platform's all-off and is logged, never a throw at a move.

import { createLogger, userText } from '../logger'
import { compile } from '../../shared/workflow/compile'
import { allOff, BRANCH_OPTIONS, contradictions, CONTRADICTIONS, NAME_OPTIONS, ownsTarget, PREFERENCE_OPTIONS, takesOption, type Contradiction, type WorkflowOptions } from '../../shared/workflow/options'
import { PREFERENCE_DEFAULTS } from '../../shared/workflow/preferences'
import { detect } from '../platform/registry'
import { stageNameProblems, stageNameProblemText, type StageNameProblem } from '../../shared/workflow/stages'
import { agentText, type Text } from '../../shared/advanced'
import { tr } from '../../shared/i18n'
import { needsRepository, type PlatformId } from '../../shared/platform/descriptors'
import type { ProjectConfig, WorkflowDefaults } from '../../shared/types'
import { config } from '../config'
import type { WorkspaceService } from '../workspace'

const log = createLogger('workflow')

/** Where an option's value came from: the platform's all-off, or the level that set it. */
export type OptionOrigin = 'platform' | 'global' | 'workspace' | 'project'

/** The options each level sets: the global and workspace defaults per platform, the project's for its own. */
export interface OptionLevels {
  global?: WorkflowDefaults | null
  workspace?: WorkflowDefaults | null
  project?: Partial<WorkflowOptions> | null
  /** The project's folder, when a save is checked: inside a larger repository, its merges need its own target (OP-29). */
  folder?: string | null
}

export interface ResolvedOptions {
  options: WorkflowOptions
  origins: Record<keyof WorkflowOptions, OptionOrigin>
  /** Why the levels couldn't be used, when they fell back to all-off (English, for the log and agents). */
  invalid: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Whether a value is one its option takes. */
const fits = (key: keyof WorkflowOptions, v: unknown): boolean => takesOption(key, v)

/** Every option a level may set: the platform's (all-off's keys), and the names (N5) and preferences (HI-1766), which all-off leaves unset. */
const optionKeys = (base: WorkflowOptions): string[] => [...new Set([...Object.keys(base).filter((k) => k !== 'platform'), ...NAME_OPTIONS, ...BRANCH_OPTIONS, ...PREFERENCE_OPTIONS])]

/** The options a level sets for a platform, or why they can't be read. */
function levelOf(raw: unknown, platform: PlatformId, known: Set<string>): { set: Partial<WorkflowOptions> } | { bad: string } {
  if (raw === undefined || raw === null) return { set: {} }
  if (!isRecord(raw)) return { bad: 'not an object' } // i18n-ignore: a log line's reason (resolveLogged)
  const set: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue
    if (k === 'platform') {
      // A project's options name their platform: another one's don't apply here.
      if (v !== platform) return { bad: `options for ${String(v)}, not ${platform}` } // i18n-ignore: a log line's reason (resolveLogged)
      continue
    }
    if (!known.has(k)) return { bad: `unknown option ${k}` } // i18n-ignore: a log line's reason (resolveLogged)
    if (!fits(k as keyof WorkflowOptions, v)) return { bad: `${k} has a value it doesn't take` } // i18n-ignore: a log line's reason (resolveLogged)
    set[k] = v
  }
  return { set: set as Partial<WorkflowOptions> }
}

/**
 * The options for a project on a platform: each level over the one before it, with each option's origin. A level that
 * can't be read, or options that contradict each other, fall back to the platform's all-off (`invalid` says why).
 */
export function resolveOptions(platform: PlatformId, levels: OptionLevels): ResolvedOptions {
  // The preferences' defaults under every level (HI-1766): all-off and the presets leave them unset.
  const base: WorkflowOptions = { ...PREFERENCE_DEFAULTS, ...allOff(platform) }
  const known = new Set(optionKeys(base))
  const allPlatform = (): Record<keyof WorkflowOptions, OptionOrigin> => Object.fromEntries(['platform', ...known].map((k) => [k, 'platform'])) as Record<keyof WorkflowOptions, OptionOrigin>
  const origins = allPlatform()
  const options: WorkflowOptions = { ...base }
  const fallBack = (why: string): ResolvedOptions => ({ options: base, origins: allPlatform(), invalid: why })
  const steps: [Exclude<OptionOrigin, 'platform'>, unknown][] = [
    ['global', levels.global?.[platform]],
    ['workspace', levels.workspace?.[platform]],
    ['project', levels.project]
  ]
  for (const [origin, raw] of steps) {
    const l = levelOf(raw, platform, known)
    if ('bad' in l) return fallBack(`${origin} options: ${l.bad}`)
    for (const [k, v] of Object.entries(l.set)) {
      ;(options as unknown as Record<string, unknown>)[k] = v
      origins[k as keyof WorkflowOptions] = origin
    }
  }
  // Who named the target (OP-29, #1419): part of the ruleset, so a card or lane started now keeps it.
  if (ownsTarget(options, origins.target)) options.targetOwn = true
  let compiled: ReturnType<typeof compile>
  try {
    compiled = compile(options)
  } catch (e) {
    return fallBack(`options that don't compile (${e instanceof Error ? e.message : String(e)})`) // i18n-ignore: a log line's reason (resolveLogged)
  }
  if (!compiled.ok) return fallBack(`options that contradict each other (${compiled.contradictions.join(', ')})`) // i18n-ignore: a log line's reason (resolveLogged)
  return { options, origins, invalid: null }
}

/**
 * Why options can't be saved (#1278): a level that can't be read, a contradiction, or a stage's name (N5, #1417). Every
 * option is offered since P7 (#1445: G15 was the last).
 */
export type OptionsProblem = { kind: 'bad'; why: string } | { kind: 'contradiction'; id: Contradiction } | ({ kind: 'stageName' } & StageNameProblem)

/**
 * Options as a save would leave them (the Workflow section, the Assistant's settings tool): resolved, and every reason
 * they can't be saved, which a read would only log and fall back from.
 */
export function checkOptions(platform: PlatformId, levels: OptionLevels): { resolved: ResolvedOptions; problems: OptionsProblem[] } {
  const resolved = resolveOptions(platform, { ...levels, project: null })
  const known = new Set(optionKeys(allOff(platform)))
  const own = levelOf(levels.project, platform, known)
  if ('bad' in own) return { resolved, problems: [{ kind: 'bad', why: `project options: ${own.bad}` }] } // i18n-ignore: an English reason for the Assistant and the log
  if (resolved.invalid) return { resolved, problems: [{ kind: 'bad', why: resolved.invalid }] }
  const options = { ...resolved.options, ...own.set }
  const origins = { ...resolved.origins }
  for (const k of Object.keys(own.set)) origins[k as keyof WorkflowOptions] = 'project'
  delete options.targetOwn
  if (ownsTarget(options, origins.target)) options.targetOwn = true
  // A project inside a larger repository (OP-29, #1419): Combwork's or the agent's merges only into a branch it names itself.
  const subfolder = !!levels.folder && needsRepository(options.platform) && !!detect(levels.folder).subfolder
  const problems: OptionsProblem[] = [
    ...contradictions(options, { subfolder }).map((id) => ({ kind: 'contradiction' as const, id })),
    // Each stage's name (N5) against every other's, in English and in the language Combwork shows.
    ...stageNameProblems(options.stageNames, tr).map((p) => ({ kind: 'stageName' as const, ...p }))
  ]
  return { resolved: { options, origins, invalid: null }, problems }
}

/** A problem as text for the window (its message, in the user's language), or its English reason. */
export function problemShownOf(p: OptionsProblem): Text {
  if (p.kind === 'bad') return { shown: p.why, agent: p.why }
  return p.kind === 'contradiction' ? CONTRADICTIONS[p.id] : stageNameProblemText(p)
}

/** A problem in English, for the Assistant's tools and the log. */
// agent-text: problemShownOf
export const problemText = (p: OptionsProblem): string => (p.kind === 'bad' ? p.why : agentText(problemShownOf(p)))

/** Tells the workspace's windows that a project's workflow was written (#1417): its stages and their names may have changed. */
export function workflowChanged(ws: Pick<WorkspaceService, 'path' | 'emit'>, projectPath: string): void {
  if (ws.path) ws.emit({ type: 'workflow-changed', workspacePath: ws.path, projectPath })
}

/** resolveOptions(), logging a fall-back once per project and reason (each read would log it again otherwise). */
const logged = new Map<string, string>()
export function resolveLogged(project: string, platform: PlatformId, levels: OptionLevels): ResolvedOptions {
  const r = resolveOptions(platform, levels)
  const key = project.toLowerCase()
  if (r.invalid && logged.get(key) !== r.invalid) log.warn(`the workflow options of ${userText(project)} can't be used, so every rule is off for it: ${r.invalid}`)
  if (r.invalid) logged.set(key, r.invalid)
  else logged.delete(key)
  return r
}

/**
 * A project's options from its config as read (the runtime, the recorder's start, the adoption: #1278 lets a project set
 * only some options), over the workspace's and Combwork's; a project's options for another platform don't apply.
 */
export function resolvedOf(ws: Pick<WorkspaceService, 'config'>, projectPath: string, platform: PlatformId, cfg: Pick<ProjectConfig, 'workflow'>): ResolvedOptions {
  return resolveLogged(projectPath, platform, { global: config.settings.workflow, workspace: ws.config.workflow, project: cfg.workflow?.options })
}

/**
 * HI-3142: a project's ruleset now with its Merges into (G7) set to `target`: the id a ruleset recorded on that target
 * has when no rule has changed since (a lane left on the release by Start the next version keeps its own G7, HI-2807,
 * which alone isn't old rules). Null: no such project, its version control not recorded, or not readable.
 */
export async function rulesetNowAt(ws: Pick<WorkspaceService, 'config' | 'info' | 'projectConfig'>, project: string, target: string): Promise<string | null> {
  const p = (ws.info()?.projects ?? []).find((x) => x.name.toLowerCase() === project.toLowerCase())
  if (!p?.platform) return null
  try {
    return idOf(ws, p.path, p.platform.id, await ws.projectConfig(p.path), target)
  } catch (e) {
    log.warn(`the ruleset now of ${userText(p.name)} on ${userText(target)}`, e)
    return null
  }
}

/** What the old rules marks compare with: each project's ruleset now (`rulesetsNow`) and, by target, `rulesetNowAt`'s. */
export interface RulesNow {
  ids: Map<string, string>
  /** A project's (its folder name) ruleset now on `target`, read with `ids`; null where it has none. */
  at: (project: string, target: string) => string | null
}

/**
 * Each project's ruleset now (its id, from its options in force, not stored: a read), by its folder name in lower case:
 * what a card's or a lane's own ruleset is compared with for its old rules mark (#1421). A project whose version control
 * isn't recorded, or whose config can't be read, has none (no mark). `at` (HI-3161): the same on another Merges into,
 * for a card whose ruleset recorded G7 as it was, unmarked, as HI-3142 compares a lane.
 */
export async function rulesNow(ws: Pick<WorkspaceService, 'config' | 'info' | 'projectConfig'>): Promise<RulesNow> {
  const ids = new Map<string, string>()
  const read = new Map<string, { path: string; platform: PlatformId; cfg: Pick<ProjectConfig, 'workflow'> }>()
  for (const p of ws.info()?.projects ?? []) {
    if (!p.platform) continue
    try {
      const cfg = await ws.projectConfig(p.path)
      const id = idOf(ws, p.path, p.platform.id, cfg)
      read.set(p.name.toLowerCase(), { path: p.path, platform: p.platform.id, cfg })
      if (id) ids.set(p.name.toLowerCase(), id)
    } catch (e) {
      log.warn(`the ruleset now of ${userText(p.name)}`, e)
    }
  }
  const at = (project: string, target: string): string | null => {
    const r = read.get(project.toLowerCase())
    return r ? idOf(ws, r.path, r.platform, r.cfg, target) : null
  }
  return { ids, at }
}

export async function rulesetsNow(ws: Pick<WorkspaceService, 'config' | 'info' | 'projectConfig'>): Promise<Map<string, string>> {
  return (await rulesNow(ws)).ids
}

/**
 * A project's ruleset id now, on its own Merges into or on `target` (null: its options don't compile). Kept by what it
 * is made from (HI-1780: every board change asks, and options resolved and compiled again cost about 2 ms a project):
 * the platform, the three levels of options and the target asked.
 */
function idOf(ws: Pick<WorkspaceService, 'config'>, path: string, platform: PlatformId, cfg: Pick<ProjectConfig, 'workflow'>, target?: string): string | null {
  const key = JSON.stringify([platform, config.settings.workflow ?? null, ws.config.workflow ?? null, cfg.workflow?.options ?? null, target ?? null])
  const at = JSON.stringify([path.toLowerCase(), target ?? null])
  const was = rulesetIds.get(at)
  if (was?.key === key) return was.id
  const options = resolvedOf(ws, path, platform, cfg).options
  const c = compile(target ? { ...options, target } : options)
  const id = c.ok ? c.ruleset.id : null
  // A project's own and a few targets each; options changed leave old keys, so the whole map is let go past a bound.
  if (rulesetIds.size >= RULESET_IDS_MAX) rulesetIds.clear()
  rulesetIds.set(at, { key, id })
  return id
}

/** Each project's ruleset id now (null: its options don't compile), by its path and target asked, with what it was made from. */
const rulesetIds = new Map<string, { key: string; id: string | null }>()
const RULESET_IDS_MAX = 512
