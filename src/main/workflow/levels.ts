// Workflow defaults at Combwork's and the workspace's level (#1422, SPEC §16.6.6): the options each level sets per platform,
// edited with the Workflow section's editor in a level mode (Settings → Workflow defaults, Settings → Workspace). A level
// is resolved on its own (Combwork's over the platform's all-off, the workspace's over Combwork's) and checked as a project's
// save is; a save also lists the projects that inherit what changed (Combwork's level: every open workspace's), with their
// running lanes and cards in flight, and is refused when it would make an inheriting project's options contradict each
// other, naming the project (§16.6.6's all-off fall-back stays for files edited by hand). A form read before another
// change is refused, never written over (#1418's base).

import { basename } from 'path'
import { CombworkError } from '../combworkError'
import { listLanes } from '../lanes'
import { createLogger } from '../logger'
import { config } from '../config'
import { PRESETS, preset, type WorkflowOptions } from '../../shared/workflow/options'
import type { PlatformId } from '../../shared/platform/descriptors'
import type { OwnWorkflowProblem, WorkflowChange, WorkflowDefaults, WorkflowForm, WorkflowLevel, WorkflowLevelCheck, WorkflowProblem } from '../../shared/types'
import { openWorkspaces, type WorkspaceService } from '../workspace'
import { checkOptions, resolveOptions, workflowChanged, type OptionLevels } from './rulesets'
import { workflowEnforced } from './service'
import { cardsInFlight, keptNames, problemEnglish, WorkflowRefused, WorkflowStale } from './optionsForm'
import { workflowWrite } from './writes'
import { hasRepository, withFolderRepoLocks } from '../platform/repoPorts'

const log = createLogger('workflow')

const PLATFORMS: readonly PlatformId[] = ['git', 'none']

/** Checks a level and a platform from the window or the API. */
function levelArgs(level: unknown, platform: unknown): { level: WorkflowLevel; platform: PlatformId } {
  if ((level !== 'global' && level !== 'workspace') || !PLATFORMS.includes(platform as PlatformId)) throw new CombworkError({ lines: ['A workflow level is global or workspace, for git or none'] }, { kind: 'invalid' }) // i18n-ignore: a mistake in a caller, never the window's
  return { level, platform: platform as PlatformId }
}

/** What each level sets now: Combwork's (config) and the workspace's (workspace.json), per platform. */
const defaultsOf = (ws: WorkspaceService, level: WorkflowLevel): WorkflowDefaults | undefined => (level === 'global' ? config.settings.workflow : ws.config.workflow)

/** The options a level sets itself for a platform. */
export const levelOwn = (ws: WorkspaceService, level: WorkflowLevel, platform: PlatformId): Partial<WorkflowOptions> => ({ ...defaultsOf(ws, level)?.[platform] })

/** The levels a level's options resolve over, with `own` as the level's (in the project's slot, so they count as its own). */
const levelsWith = (ws: WorkspaceService, level: WorkflowLevel, own: Partial<WorkflowOptions> | null): OptionLevels => (level === 'global' ? { global: null, workspace: null, project: own } : { global: config.settings.workflow, workspace: null, project: own })

/** A level's options as the editor shows them: what it sets, what it inherits from the level below, the presets. */
export function levelForm(ws: WorkspaceService, rawLevel: unknown, rawPlatform: unknown): WorkflowForm {
  const { level, platform } = levelArgs(rawLevel, rawPlatform)
  const own = levelOwn(ws, level, platform)
  const below = resolveOptions(platform, levelsWith(ws, level, null))
  const now = checkOptions(platform, levelsWith(ws, level, own))
  const shown = now.problems.length ? resolveOptions(platform, levelsWith(ws, level, null)) : now.resolved
  // A level's origins name it as the project's slot does: shown as the level.
  const origins = Object.fromEntries(Object.entries(shown.origins).map(([k, o]) => [k, o === 'project' ? level : o])) as WorkflowForm['origins']
  return {
    platform,
    level,
    preset: null,
    own,
    options: shown.options,
    origins,
    invalid: now.problems.length ? now.problems.map(problemEnglish).join(' ') : null,
    inherited: below.options,
    inheritedOrigins: below.origins,
    // A level has no project to suggest checks from: the presets fill in what they set without them.
    presets: PRESETS[platform].map((p) => ({ ...p, options: preset(platform, p.id) })),
    identity: null,
    enforced: workflowEnforced()
  }
}

/** The workspaces a level reaches: Combwork's, every open one; the workspace's, its own. */
const reached = (ws: WorkspaceService, level: WorkflowLevel): WorkspaceService[] => (level === 'global' ? openWorkspaces() : [ws])

/**
 * The projects that inherit an option the change would change, on that platform, in the workspaces the level reaches:
 * what changes for each (the options it doesn't set itself), and the problems its options would then have.
 */
type Heir = { w: WorkspaceService; path: string; name: string; changed: (keyof WorkflowOptions)[]; problems: OwnWorkflowProblem[] }
async function inheritors(ws: WorkspaceService, level: WorkflowLevel, platform: PlatformId, own: Partial<WorkflowOptions>): Promise<Heir[]> {
  const out: Heir[] = []
  for (const w of reached(ws, level)) {
    for (const p of w.info()?.projects ?? []) {
      if (p.platform?.id !== platform) continue
      const cfg = await w.projectConfig(p.path).catch(() => null)
      if (!cfg) continue
      const projectOwn = cfg.workflow?.platform === platform ? cfg.workflow.options : {}
      const levels = (g: WorkflowDefaults | undefined, s: WorkflowDefaults | undefined): OptionLevels => ({ global: g, workspace: s, project: projectOwn })
      const g = config.settings.workflow
      const s = w.config.workflow
      const before = resolveOptions(platform, levels(g, s)).options
      const after = checkOptions(platform, level === 'global' ? levels({ ...g, [platform]: own }, s) : levels(g, { ...s, [platform]: own }))
      // Every option either side has: an optional one (the stage names) taken back to inherit is a change too (HR5's round 1).
      const keys = [...new Set([...Object.keys(after.resolved.options), ...Object.keys(before)])] as (keyof WorkflowOptions)[]
      const changed = keys.filter((k) => k !== 'platform' && !(k in projectOwn) && JSON.stringify(after.resolved.options[k]) !== JSON.stringify(before[k]))
      if (changed.length) out.push({ w, path: p.path, name: p.name, changed, problems: after.problems })
    }
  }
  return out
}

/** Checks a change's shape: options (a level has no preset to keep), and its base. */
function shapeOf(raw: unknown): WorkflowChange {
  const c = raw as Partial<WorkflowChange> | null
  const isOptions = (v: unknown): v is Partial<WorkflowOptions> => !!v && typeof v === 'object' && !Array.isArray(v)
  if (!c || typeof c !== 'object' || !isOptions(c.options) || (c.base !== undefined && (!c.base || !isOptions(c.base.options)))) throw new CombworkError({ lines: ['A workflow change is { preset, options, base? }'] }, { kind: 'invalid' }) // i18n-ignore: a mistake in a caller, never the window's
  const options = Object.fromEntries(Object.entries(keptNames(c.options)).filter(([k, v]) => k !== 'platform' && v !== undefined)) as Partial<WorkflowOptions>
  return { preset: null, options, ...(c.base ? { base: { preset: null, options: c.base.options } } : {}) }
}

/** The changed options and the problems of a level's change, the inheriting projects it reaches and what keeps old rules. */
export async function checkLevelChange(ws: WorkspaceService, rawLevel: unknown, rawPlatform: unknown, raw: unknown): Promise<WorkflowLevelCheck> {
  const { level, platform } = levelArgs(rawLevel, rawPlatform)
  const change = shapeOf(raw)
  const before = checkOptions(platform, levelsWith(ws, level, levelOwn(ws, level, platform)))
  const after = checkOptions(platform, levelsWith(ws, level, change.options))
  const was = before.problems.length ? resolveOptions(platform, levelsWith(ws, level, null)).options : before.resolved.options
  const keys = [...new Set([...Object.keys(after.resolved.options), ...Object.keys(was)])] as (keyof WorkflowOptions)[]
  const changed = keys.filter((k) => k !== 'platform' && JSON.stringify(after.resolved.options[k]) !== JSON.stringify(was[k]))
  const heirs = after.problems.length ? [] : await inheritors(ws, level, platform, change.options)
  const projects = []
  for (const h of heirs) {
    const lanes = (await listLanes(h.w, { project: h.name })).filter((l) => l.state === 'active' || l.state === 'paused')
    projects.push({ name: h.name, path: h.path, workspace: { path: h.w.path ?? '', name: basename(h.w.path ?? '') }, changed: h.changed, lanes: lanes.map((l) => ({ id: l.id, name: l.name, builder: l.builder.name })), inFlight: await cardsInFlight(h.w, { path: h.path, name: h.name }) })
  }
  const refused: WorkflowProblem[] = heirs.flatMap((h) => h.problems.map((problem) => ({ kind: 'inheritor' as const, project: h.name, problem })))
  return { problems: [...after.problems, ...refused], changed, appliesNow: false, lanes: [], inFlight: [], projects }
}

/**
 * Saves a level's options for a platform: refused with its reasons (its own, and an inheriting project's that would
 * contradict), or as changed meanwhile when the form's base is no longer the level's. Combwork's in config, the workspace's
 * in workspace.json (written in turn, kept with a backup). The inheriting projects' views read again. Returns the form.
 */
export function setLevelOptions(ws: WorkspaceService, rawLevel: unknown, rawPlatform: unknown, raw: unknown): Promise<WorkflowForm> {
  // The level and every project it reaches checked as they are now, and written in the same turn of workflow writes:
  // no project or level changes between the check and the write (HR5's round 1).
  // Every repository the level reaches locked first (#1642 round 5): a level's target is each inheriting Git project's.
  return withFolderRepoLocks(levelRepos(ws, rawLevel), () => workflowWrite(() => saveLevelOptions(ws, rawLevel, rawPlatform, raw)), { quiet: true })
}

/** The repository projects (Git's) a level's options reach: the workspace's for its own level, every open workspace's for Combwork's. */
function levelRepos(ws: WorkspaceService, rawLevel: unknown): string[] {
  const of = (w: WorkspaceService): string[] => (w.info()?.projects ?? []).filter((p) => !!p.platform && hasRepository(p.platform.id)).map((p) => p.path)
  return rawLevel === 'workspace' ? of(ws) : openWorkspaces().flatMap(of)
}

async function saveLevelOptions(ws: WorkspaceService, rawLevel: unknown, rawPlatform: unknown, raw: unknown): Promise<WorkflowForm> {
  const { level, platform } = levelArgs(rawLevel, rawPlatform)
  const change = shapeOf(raw)
  const sameAsBase = (): boolean => !change.base || JSON.stringify(sortedOf(change.base.options)) === JSON.stringify(sortedOf(levelOwn(ws, level, platform)))
  if (!sameAsBase()) throw new WorkflowStale()
  const check = await checkLevelChange(ws, level, platform, change)
  if (check.problems.length) throw new WorkflowRefused(check.problems)
  if (level === 'global') {
    // Combwork's config is this process's: checked and written with nothing awaited in between.
    if (!sameAsBase()) throw new WorkflowStale()
    config.setWorkflowDefaults(platform, change.options)
  } else {
    await ws.saveWorkspaceConfigWith((c) => {
      if (change.base && JSON.stringify(sortedOf(change.base.options)) !== JSON.stringify(sortedOf({ ...c.workflow?.[platform] }))) throw new WorkflowStale()
      return { workflow: { ...c.workflow, [platform]: change.options } }
    })
    // The windows' copy of the workspace's config follows (HI-2058: their Add Agent reads its Maximum agents from it).
    void ws.refresh().catch((e: unknown) => log.warn('reading the workspace again after its workflow defaults changed', e))
  }
  log.info(`the ${level} workflow defaults for ${platform} changed: ${check.changed.join(', ') || 'none'}`)
  for (const p of check.projects ?? []) workflowChanged(reached(ws, level).find((w) => w.info()?.projects.some((x) => x.path === p.path)) ?? ws, p.path)
  return levelForm(ws, level, platform)
}

const sortedOf = (o: object): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).sort(([x], [y]) => x.localeCompare(y)))

/** The settings tool's write of one option at a level (null inherits), checked as the editor's save is. */
export async function setLevelOption(ws: WorkspaceService, level: WorkflowLevel, platform: PlatformId, key: keyof WorkflowOptions, value: unknown): Promise<void> {
  const own: Record<string, unknown> = { ...levelOwn(ws, level, platform) }
  if (value === null) delete own[key]
  else own[key] = value
  await setLevelOptions(ws, level, platform, { preset: null, options: own })
}
