// A project's card loop and file lock preferences (HI-1766: workflow options, not rules), as they are now: Hive's
// defaults, then its workspace's, then its own options for the platform in force (shared/workflow/preferences.ts).
// Every reader takes them from here (wakes, lanes, design checks, stalls, file locks), so they agree.
import { config } from '../config'
import type { ProjectConfig } from '../../shared/types'
import type { PlatformId } from '../../shared/platform/descriptors'
import { AGENTS_PER_PROJECT, preferencesOf, projectOwnPreferences, withOldDefaults, type Preferences } from '../../shared/workflow/preferences'
import { takesOption } from '../../shared/workflow/options'
import { advanced } from '../advanced'
import { createLogger } from '../logger'
import type { WorkspaceService } from '../workspace'

type PreferenceWorkspace = Pick<WorkspaceService, 'config' | 'info'>

const log = createLogger('workflow')

/**
 * Hive's own Agents per project from before HI-2001 (advanced.json, kept there for this), moved into its workflow
 * defaults' Maximum agents for None and Git where they don't set it, then dropped from advanced.json. Once, at startup
 * after both files are read; the window's Workflow defaults show it from then on. The old value goes only once
 * config.json holds the new one on disk (HR3's round 1): a failed save keeps it, and the next start moves it again.
 */
export async function migrateAgentsPerProject(): Promise<void> {
  const old = advanced.legacy(AGENTS_PER_PROJECT)
  if (old === undefined) return
  if (takesOption('maxAgents', old)) {
    const levels = config.settings.workflow
    const next = withOldDefaults(levels, { maxAgents: old as number })
    if (JSON.stringify(next) !== JSON.stringify(levels ?? {})) {
      config.update((c) => void (c.settings.workflow = next))
      if (!(await config.saveNow())) return log.warn("Agents per project stays in advanced.json: Combwork's settings couldn't be saved with it as Maximum agents")
      log.info(`Agents per project (${String(old)}) is Maximum agents in Combwork's workflow defaults now`)
    }
  }
  await advanced.dropLegacy(AGENTS_PER_PROJECT).catch((e) => log.warn("Couldn't drop Agents per project from advanced.json", e))
}

/**
 * A project's preferences, from its config as read (`cfg`), else as the workspace last read it. Its platform is the one
 * detected for it, else the one its options name, else None.
 */
export function projectPreferences(ws: PreferenceWorkspace, projectPath: string, cfg?: Pick<ProjectConfig, 'workflow' | 'platform'> | null): Preferences {
  const p = ws.info()?.projects.find((x) => x.path.toLowerCase() === projectPath.toLowerCase())
  const own = cfg === undefined ? (p?.config ?? null) : cfg
  const platform: PlatformId = p?.platform?.id ?? own?.platform ?? own?.workflow?.platform ?? 'none'
  return preferencesOf(platform, { global: config.settings.workflow, workspace: ws.config.workflow, project: projectOwnPreferences(platform, own) }).values
}
