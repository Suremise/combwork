// Card loops and file locks as workflow options (HI-1766): how agents work together, not rules (options.ts
// PREFERENCE_OPTIONS). Each resolves on its own, Hive's then the workspace's then the project's, so a level's other options
// that can't be used (a contradiction falls the rules back to All off) never take a project's loop settings with them.
// Main reads them with workflow/preferences.ts; the window from the levels it has.

import { LOOP_ROUNDS, LOOP_STEP_WAIT_MINUTES, LOOP_WAIT_HOURS } from '../loopLimits'
import { AGENT_LIMIT_DEFAULT } from '../agentLimits'
import type { PlatformId } from '../platform/descriptors'
import type { ProjectConfig, WorkflowDefaults, WorkflowOptionOrigin } from '../types'
import { PREFERENCE_OPTIONS, takesOption, type PreferenceKey, type WorkflowOptions } from './options'

export type Preferences = Required<Pick<WorkflowOptions, PreferenceKey>>

/** Each preference when no level sets it: as before 1.0's settings (wakes on, 10 rounds, 6 h, 30 min, Block, 12 agents). */
export const PREFERENCE_DEFAULTS: Preferences = { loopWakes: true, loopRounds: LOOP_ROUNDS, loopWaitHours: LOOP_WAIT_HOURS, loopStepWaitMinutes: LOOP_STEP_WAIT_MINUTES, fileLocks: 'block', maxAgents: AGENT_LIMIT_DEFAULT }

/** The levels a project's preferences come from: Hive's and the workspace's defaults, and its own options. */
export interface PreferenceLevels {
  global?: WorkflowDefaults | null
  workspace?: WorkflowDefaults | null
  project?: Partial<WorkflowOptions> | null
}

/**
 * A project's preferences on a platform, and where each comes from: the last level that sets it with a value it takes (one
 * it doesn't take is passed over, as if unset), else the default.
 */
export function preferencesOf(platform: PlatformId, levels: PreferenceLevels): { values: Preferences; origins: Record<PreferenceKey, WorkflowOptionOrigin> } {
  const values = { ...PREFERENCE_DEFAULTS } as Record<PreferenceKey, unknown>
  const origins = Object.fromEntries(PREFERENCE_OPTIONS.map((k) => [k, 'platform'])) as Record<PreferenceKey, WorkflowOptionOrigin>
  const steps: [WorkflowOptionOrigin, Partial<WorkflowOptions> | null | undefined][] = [
    ['global', levels.global?.[platform]],
    ['workspace', levels.workspace?.[platform]],
    ['project', levels.project]
  ]
  for (const [origin, set] of steps) {
    if (!set || typeof set !== 'object') continue
    for (const k of PREFERENCE_OPTIONS) {
      const v = (set as Record<string, unknown>)[k]
      if (v === undefined || !takesOption(k, v)) continue
      values[k] = v
      origins[k] = origin
    }
  }
  return { values: values as Preferences, origins }
}

/**
 * A project's preferences as the window knows it (its info: the platform detected, else the one its options name, else
 * None), over Hive's and the workspace's defaults.
 */
export function projectInfoPreferences(project: { config: Pick<ProjectConfig, 'workflow' | 'platform'>; platform?: { id: PlatformId } | null }, global: WorkflowDefaults | null | undefined, workspace: WorkflowDefaults | null | undefined): Preferences {
  const platform = project.platform?.id ?? project.config.platform ?? project.config.workflow?.platform ?? 'none'
  return preferencesOf(platform, { global, workspace, project: projectOwnPreferences(platform, project.config) }).values
}

/** A project's own options for its platform, as project.json keeps them (another platform's don't apply). */
export function ownOptionsOn(platform: PlatformId, workflow: { platform: PlatformId; options: Partial<WorkflowOptions> } | null | undefined): Partial<WorkflowOptions> | null {
  return workflow && workflow.platform === platform ? workflow.options : null
}

// ---------------------------------------------------------------------------
// From before HI-1766: Project Settings → Card loops (`loopWakes`, `loopRounds`, `loopWaitHours`,
// `loopStepWaitMinutes`) and → Agents → File locks (`fileLocks`) in project.json; Settings → Workspace's card loop
// rounds and wait (`loops`) in workspace.json; Settings → Agents → File locks (`agents.fileLocks`) in config.json.
// Each becomes its level's workflow option. A value the new place already has wins, a default saved into every file
// (wakes on, nothing set, Inherit, Block) is no choice and isn't carried, and an old key goes only where its value has a
// place in the same file (written with it, never before it).
// ---------------------------------------------------------------------------

/** The old project keys. */
const LEGACY_PROJECT_KEYS = ['loopWakes', 'loopRounds', 'loopWaitHours', 'loopStepWaitMinutes', 'fileLocks'] as const

/** A project.json's own preferences from before HI-1766 (an object as read), as workflow options: only the ones chosen. */
export function legacyPreferences(raw: unknown): Partial<WorkflowOptions> {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (r.loopWakes === false) out.loopWakes = false
  for (const k of ['loopRounds', 'loopWaitHours', 'loopStepWaitMinutes'] as const) if (r[k] != null && takesOption(k, r[k])) out[k] = r[k]
  if (r.fileLocks !== 'inherit' && takesOption('fileLocks', r.fileLocks)) out.fileLocks = r.fileLocks
  return out as Partial<WorkflowOptions>
}

/**
 * A project.json patch that consumes the old keys (HR5's HI-1766 round 1): for a write whose workflow options already
 * hold what they had, as the form and the settings tool show them (`legacyPreferences`), so one removed there (Inherit)
 * stays inherited rather than moving in again.
 */
export const LEGACY_CONSUMED: Partial<Pick<ProjectConfig, 'loopWakes' | 'loopRounds' | 'loopWaitHours' | 'loopStepWaitMinutes' | 'fileLocks'>> = { loopWakes: undefined, loopRounds: undefined, loopWaitHours: undefined, loopStepWaitMinutes: undefined, fileLocks: undefined }

/** A project's own options as the form and the settings tool show them: its workflow's, else its old keys (none yet). */
export const ownOrLegacy = (cfg: Pick<ProjectConfig, 'workflow'> & Record<string, unknown>): Partial<WorkflowOptions> => (cfg.workflow ? { ...cfg.workflow.options } : legacyPreferences(cfg))

/** Options with the old values each lacks (key presence: a value set there, false or not, wins). */
const withMissing = (options: unknown, old: Partial<WorkflowOptions>): Partial<WorkflowOptions> => {
  const o = options && typeof options === 'object' && !Array.isArray(options) ? (options as Record<string, unknown>) : {}
  return { ...old, ...o } as Partial<WorkflowOptions>
}

/**
 * A project.json as read, its old preferences moved into its workflow options: those in force and each kept platform's
 * (#1419), so switching platform keeps them. A project with no workflow options yet keeps its old keys (giving it options
 * would choose a workflow for it, and the 1.0 upgrade and "How do you work?" go by whether it has any): they're read as
 * its own (`projectOwnPreferences`) until it has. Pure; the file changes when it is next saved.
 */
export function migrateProjectPreferences<T extends Record<string, any>>(raw: T): T {
  if (!raw || typeof raw !== 'object' || !LEGACY_PROJECT_KEYS.some((k) => k in raw)) return raw
  const old = legacyPreferences(raw)
  const wf = raw.workflow
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
    // No place yet: the chosen values stay, the defaults saved into every file go.
    const kept = Object.fromEntries(Object.entries(raw).filter(([k]) => !(LEGACY_PROJECT_KEYS as readonly string[]).includes(k)))
    return { ...kept, ...old } as unknown as T
  }
  const out = Object.fromEntries(Object.entries(raw).filter(([k]) => !(LEGACY_PROJECT_KEYS as readonly string[]).includes(k))) as Record<string, any>
  const kept = wf.kept && typeof wf.kept === 'object' && !Array.isArray(wf.kept) ? Object.fromEntries(Object.entries(wf.kept as Record<string, any>).map(([p, k]) => [p, k && typeof k === 'object' ? { ...k, options: withMissing(k.options, old) } : k])) : undefined
  out.workflow = { ...wf, options: withMissing(wf.options, old), ...(kept ? { kept } : {}) }
  return out as T
}

/**
 * A project's own preferences for a platform: its workflow options', over the old keys it keeps while it has no workflow
 * options (`migrateProjectPreferences`).
 */
export function projectOwnPreferences(platform: PlatformId, cfg: Pick<ProjectConfig, 'workflow'> | null | undefined): Partial<WorkflowOptions> | null {
  const own = ownOptionsOn(platform, cfg?.workflow)
  const old = cfg && !cfg.workflow ? legacyPreferences(cfg) : {}
  return own || Object.keys(old).length ? { ...old, ...own } : null
}

/**
 * Settings → Advanced → Agents per project (`hive.agents.perProject`, #562) before HI-2001: Hive's (advanced.json, kept
 * there as LEGACY_ADVANCED until main moves it) and a workspace's own (workspace.json's `advanced`). Each becomes its
 * level's Maximum agents, for None and Git.
 */
export const AGENTS_PER_PROJECT = 'hive.agents.perProject'

/**
 * Workflow defaults (Hive's or a workspace's) with old values each platform's lacks: a value a level already sets wins.
 * Pure: the caller writes it where it belongs.
 */
export function withOldDefaults(levels: WorkflowDefaults | null | undefined, old: Partial<WorkflowOptions>): WorkflowDefaults {
  const out: WorkflowDefaults = { ...levels }
  for (const p of ['none', 'git'] as const) out[p] = withMissing(levels?.[p], old)
  return out
}

/**
 * A workspace.json as read, its card loop rounds and wait (`loops`) and its own Agents per project (HI-2001) moved into
 * its workflow defaults for None and Git, each where that level doesn't set it already. Pure; the file changes when it
 * is next saved.
 */
export function migrateWorkspacePreferences<T extends Record<string, any>>(raw: T): T {
  const ownAdvanced = raw && typeof raw === 'object' && raw.advanced && typeof raw.advanced === 'object' && !Array.isArray(raw.advanced) ? (raw.advanced as Record<string, unknown>) : null
  const perProject = !!ownAdvanced && AGENTS_PER_PROJECT in ownAdvanced
  if (!raw || typeof raw !== 'object' || (!('loops' in raw) && !perProject)) return raw
  const { loops, ...rest } = raw as Record<string, any>
  const old: Partial<WorkflowOptions> = {}
  if (loops && typeof loops === 'object') {
    if (takesOption('loopRounds', loops.rounds)) old.loopRounds = loops.rounds
    if (takesOption('loopWaitHours', loops.waitHours)) old.loopWaitHours = loops.waitHours
  }
  // Its own Agents per project (Settings → Advanced, This workspace), Maximum agents since HI-2001.
  if (perProject) {
    const { [AGENTS_PER_PROJECT]: n, ...others } = ownAdvanced!
    if (takesOption('maxAgents', n)) old.maxAgents = n as number
    rest.advanced = others
  }
  if (!Object.keys(old).length) return rest as T
  const levels = rest.workflow && typeof rest.workflow === 'object' && !Array.isArray(rest.workflow) ? (rest.workflow as WorkflowDefaults) : {}
  const workflow: WorkflowDefaults = { ...levels }
  for (const p of ['none', 'git'] as const) workflow[p] = withMissing(levels[p], old)
  return { ...rest, workflow } as unknown as T
}

/**
 * Hive's settings as read, Settings → Agents → File locks (`agents.fileLocks`) moved into Hive's workflow defaults for
 * None and Git where they don't set it. Block, the default saved into every config, is no choice: the default stands.
 */
export function migrateGlobalFileLocks(settings: { agents?: unknown; workflow?: WorkflowDefaults }): void {
  const agents = settings.agents as Record<string, unknown> | undefined
  if (!agents || !('fileLocks' in agents)) return
  const old = agents.fileLocks
  delete agents.fileLocks
  if (old === 'block' || !takesOption('fileLocks', old)) return
  const levels = settings.workflow ?? {}
  const workflow: WorkflowDefaults = { ...levels }
  for (const p of ['none', 'git'] as const) workflow[p] = withMissing(levels[p], { fileLocks: old as Preferences['fileLocks'] })
  settings.workflow = workflow
}
