// A project's card loop and file lock preferences (HI-1766: workflow options, not rules), as they are now: Hive's
// defaults, then its workspace's, then its own options for the platform in force (shared/workflow/preferences.ts).
// Every reader takes them from here (wakes, lanes, design checks, stalls, file locks), so they agree.
import { config } from '../config'
import type { ProjectConfig } from '../../shared/types'
import type { PlatformId } from '../../shared/platform/descriptors'
import { preferencesOf, projectOwnPreferences, type Preferences } from '../../shared/workflow/preferences'
import type { WorkspaceService } from '../workspace'

type PreferenceWorkspace = Pick<WorkspaceService, 'config' | 'info'>

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
