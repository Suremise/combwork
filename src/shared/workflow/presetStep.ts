// "How do you work? Solo / Pair / Team" (#1423, SPEC §16.3.5): the preset step for a project added since 1.0, per
// platform. A project asks while the platform in force has no preset, no options of its own and no answer: a project
// from before 1.0 has the options its upgrade wrote, and one switched to a platform it never had asks for that one
// (#1419: nothing in `kept`). The answer (`chosen` or `notNow`) is the platform's: it goes into `kept` with its options
// when the project switches away, and comes back with them. Nothing is applied until the user chooses.

import type { PlatformId } from '../platform/descriptors'
import type { ProjectConfig } from '../types'
import { PREFERENCE_OPTIONS, type PresetId } from './options'
import { agentWorkflowRole, reviewsWork, type WorkflowRole } from './roles'

/**
 * Whether a project asks "How do you work?" for the platform in force. A project with no platform recorded is from
 * before 1.0 (Combwork records it as it makes a project.json): its upgrade gives it options, so it never asks, also while
 * that upgrade is still to run.
 */
export function asksPreset(cfg: Pick<ProjectConfig, 'workflow' | 'platform'>, platform: PlatformId): boolean {
  if (cfg.platform === undefined) return false
  const wf = cfg.workflow
  if (!wf || wf.platform !== platform) return true
  // Card loops and file locks (HI-1766) aren't a way of working: a project with only those has chosen none.
  return !wf.preset && !Object.keys(wf.options ?? {}).some((k) => !(PREFERENCE_OPTIONS as readonly string[]).includes(k)) && !wf.presetAsked
}

/**
 * The preset suggested from the project's agents: Solo for one or none, Pair for a builder and a reviewer, Team for more.
 * Pair is Combwork merging for Git (`pair`), as the Pair preset is.
 */
export function suggestPreset(agents: readonly { name: string; role?: string; workflowRole?: WorkflowRole }[]): PresetId {
  if (agents.length <= 1) return 'solo'
  const reviewers = agents.filter((a) => reviewsWork(agentWorkflowRole(a))).length
  return agents.length === 2 && reviewers === 1 ? 'pair' : 'team'
}

/** The presets the step offers: Solo, Pair and Team (for Git, Pair is Combwork merging). */
export const STEP_PRESETS: readonly PresetId[] = ['solo', 'pair', 'team']

