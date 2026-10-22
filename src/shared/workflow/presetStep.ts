// "How do you work? Solo / Pair / Team" (#1423, SPEC §16.3.5): the preset step for a project added since 1.0, per
// platform. A project asks while the platform in force has no preset, no options of its own and no answer: a project
// from before 1.0 has the options its upgrade wrote, and one switched to a platform it never had asks for that one
// (#1419: nothing in `kept`). The answer (`chosen` or `notNow`) is the platform's: it goes into `kept` with its options
// when the project switches away, and comes back with them. Nothing is applied until the user chooses.

import type { PlatformId } from '../platform/descriptors'
import type { ProjectConfig } from '../types'
import type { PresetId } from './options'

/** Whether a project asks "How do you work?" for the platform in force. */
export function asksPreset(cfg: Pick<ProjectConfig, 'workflow'>, platform: PlatformId): boolean {
  const wf = cfg.workflow
  if (!wf || wf.platform !== platform) return true
  return !wf.preset && !Object.keys(wf.options ?? {}).length && !wf.presetAsked
}

/** Whether an agent is a reviewer: its role or, without one, its name says so ("Reviewer", "HR1 (reviewer)"), as the upgrade counts one. */
export const isReviewer = (a: { name: string; role?: string }): boolean => /review/i.test(a.role || a.name)

/**
 * The preset suggested from the project's agents: Solo for one or none, Pair for a builder and a reviewer, Team for more.
 * Pair is Hive merging for Git (`pair`), as the Pair preset is.
 */
export function suggestPreset(agents: readonly { name: string; role?: string }[]): PresetId {
  if (agents.length <= 1) return 'solo'
  const reviewers = agents.filter(isReviewer).length
  return agents.length === 2 && reviewers === 1 ? 'pair' : 'team'
}

/** The presets the step offers: Solo, Pair and Team (for Git, Pair is Hive merging). */
export const STEP_PRESETS: readonly PresetId[] = ['solo', 'pair', 'team']

