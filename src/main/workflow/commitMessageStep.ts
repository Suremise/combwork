// G19's default switched to the branch's own message (HI-1997, Darren's decisions of 29 Oct): every preset and All off now
// merge with the branch's own commit messages, not Hive's (the card's key and trailers), since card titles name people
// and details a public history shouldn't keep. Until then the presets filled Hive's into every level they were chosen at,
// so a stored 'combwork' can't tell a choice from a fill. A one-time step switches the fills:
// - a project's own Git options (in force, or kept for another platform, #1419) drop a stored 'combwork', and so inherit the
//   new default, unless something proves the user chose it: its `commitMessageChosen` mark (projectWorkflow.ts, set by a
//   write that changes it to Hive's), or its merge-choice record (HI-1697) saying Hive's. Darren's decision (09:31): an
//   ambiguous saved 'combwork' is the old default, and switches;
// - the workspace's and Hive's own Git defaults drop a stored 'combwork' likewise (nothing records a choice there);
// - a stored 'branch' is never touched.
//
// Once, durably, like the G15 step (slotsUpToDateStep.ts): each project settled under its lock with its `stepsDone`
// record in the same write, the workspace's defaults with theirs in workspace.json's, Hive's with theirs in its settings
// (the save confirmed), and the board's mark only once all of a workspace's are written. A run again after a failure
// anywhere settles only what wasn't, so a choice made since is never undone, and what it keeps it only reads.

import { basename } from 'path'
import type { ProjectWorkflow, WorkflowDefaults } from '../../shared/types'
import type { WorkflowOptions } from '../../shared/workflow/options'
import { writeWorkflow } from '../../shared/workflow/projectWorkflow'
import { boardValue, boardWrite, setBoardValue, upgradeWaiting } from '../boardStore'
import { config } from '../config'
import { createLogger, userText } from '../logger'
import type { WorkspaceService } from '../workspace'
import { mergeChoiceOf } from './optionsForm'
import type { StepHooks } from './slotsUpToDateStep'

const log = createLogger('workflow')

/** The step's record: the board's mark, and each project's, workspace's and Hive's `stepsDone`. */
export const COMMIT_MESSAGE_STEP = 'workflow.commitMessageDefault'

/** Git options without a stored Hive's commit message; null when they have none. */
function withoutHive(options: Partial<WorkflowOptions> | undefined): Partial<WorkflowOptions> | null {
  if (!options || options.commitMessage !== 'combwork') return null
  const { commitMessage: _hive, ...rest } = options
  return rest
}

/**
 * A project's `workflow` with a stored Hive's commit message switched (dropped, to inherit the new default) in its Git
 * options in force and kept; null when nothing changes, or when `chosen` (the user's choice, proven) keeps it.
 */
export function settledCommitMessage(wf: ProjectWorkflow | null | undefined, chosen: boolean): ProjectWorkflow | null {
  if (!wf || chosen || wf.commitMessageChosen) return null
  const own = wf.platform === 'git' ? withoutHive(wf.options) : null
  const keptGit = wf.kept?.git
  const kept = keptGit ? withoutHive(keptGit.options) : null
  if (!own && !kept) return null
  const written = own ? writeWorkflow(wf, { platform: wf.platform, preset: wf.preset, options: own }) : wf
  return kept ? { ...written, kept: { ...written.kept, git: { ...keptGit!, options: kept } } } : written
}

/**
 * A project whose Hive's was answered (its board's merge choice) but only inherited, with Hive's written into its own Git
 * options, in force or kept for another platform (HR3's round 1), and marked chosen; null when they already set one.
 */
export function keptAnswered(wf: ProjectWorkflow | null | undefined): ProjectWorkflow | null {
  if (!wf) return null
  if (wf.platform === 'git') return wf.options?.commitMessage === undefined ? writeWorkflow(wf, { platform: 'git', preset: wf.preset, options: { ...wf.options, commitMessage: 'combwork' } }) : null
  const git = wf.kept?.git
  if (!git || git.options?.commitMessage !== undefined) return null
  return { ...wf, commitMessageChosen: true, kept: { ...wf.kept, git: { ...git, options: { ...git.options, commitMessage: 'combwork' } } } }
}

/** Workflow defaults (Hive's or a workspace's) without a stored Hive's commit message for Git; null when they have none. */
export function settledDefaults(levels: WorkflowDefaults | null | undefined): WorkflowDefaults | null {
  const git = withoutHive(levels?.git)
  return git ? { ...levels, git } : null
}

/**
 * Hive's own defaults, once (at startup): a stored Hive's commit message dropped and the step recorded in the same save,
 * which must reach the disk (`saveNow`); a failed save is tried again at the next start.
 */
export async function settleGlobalCommitMessage(): Promise<void> {
  const s = config.settings
  if (s.stepsDone?.includes(COMMIT_MESSAGE_STEP)) return
  const next = settledDefaults(s.workflow)
  config.update((c) => {
    if (next) c.settings.workflow = next
    c.settings.stepsDone = [...(c.settings.stepsDone ?? []), COMMIT_MESSAGE_STEP]
  })
  if (!(await config.saveNow())) {
    // Not recorded on disk: the next start runs it again (dropping a 'combwork' again is the same change).
    return log.warn("Combwork's workflow defaults couldn't be saved with the branch's own commit messages: tried again at the next start")
  }
  if (next) log.info("Combwork's workflow defaults now merge with the branch's own commit messages (HI-1997)")
}

/**
 * The step over a workspace's projects (hidden ones too) and its own defaults, once: each project under its lock (its
 * `stepsDone` and the board's mark checked there first) with its record in the same write; then the workspace's defaults
 * with theirs; then the board's mark. Not before the 1.0 upgrade (its board isn't 1.0's yet), nor after the mark, nor once
 * the workspace has closed. How many it changed; a failure leaves the rest, the mark unset, for the next open.
 */
export async function settleCommitMessageDefault(ws: WorkspaceService, hooks: StepHooks = {}): Promise<number> {
  const path = ws.path
  if (!path || upgradeWaiting(path) || boardValue(ws, COMMIT_MESSAGE_STEP) !== null) return 0
  const life = ws.lifetime
  const alive = (): boolean => !life.aborted && ws.lifetime === life && ws.path === path
  let changed = 0
  try {
    const folders = new Set([...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))])
    for (const folder of folders) {
      await hooks.beforeProject?.(folder)
      if (!alive()) return changed
      // The board's record of the user's answer (HI-1697): Hive's chosen there is kept.
      const answered = mergeChoiceOf(ws, basename(folder))?.commitMessage === 'combwork'
      let did = false
      await ws.mutateProjectConfig(folder, (c) => {
        if (boardValue(ws, COMMIT_MESSAGE_STEP) !== null || c.stepsDone?.includes(COMMIT_MESSAGE_STEP)) return {}
        // Answered Hive's but inheriting it (HR3's note on s26): written into its own Git options, in the same write, before
        // the workspace's or Hive's default it inherits from is dropped, so the choice keeps its effect.
        const wf = c.workflow
        const kept = answered ? keptAnswered(wf) : null
        if (kept) {
          did = true
          return { workflow: kept, stepsDone: [...(c.stepsDone ?? []), COMMIT_MESSAGE_STEP] }
        }
        const next = settledCommitMessage(wf, answered)
        did = !!next
        return { ...(next ? { workflow: next } : {}), stepsDone: [...(c.stepsDone ?? []), COMMIT_MESSAGE_STEP] }
      })
      await hooks.afterProject?.(folder)
      if (did) {
        changed++
        log.info(`${userText(basename(folder))} now merges with the branch's own commit messages (HI-1997)`)
      }
    }
    if (!alive()) return changed
    if (!ws.config.stepsDone?.includes(COMMIT_MESSAGE_STEP)) {
      const own = settledDefaults(ws.config.workflow)
      await ws.saveWorkspaceConfigWith((c) => (c.stepsDone?.includes(COMMIT_MESSAGE_STEP) ? {} : { ...(own ? { workflow: settledDefaults(c.workflow) ?? c.workflow } : {}), stepsDone: [...(c.stepsDone ?? []), COMMIT_MESSAGE_STEP] }))
      if (own) log.info(`the workspace's workflow defaults now merge with the branch's own commit messages (HI-1997)`)
    }
    if (alive()) await boardWrite(ws, async () => setBoardValue(ws, COMMIT_MESSAGE_STEP, JSON.stringify({ at: new Date().toISOString(), changed })), { alive })
  } catch (e) {
    log.warn(`switching stored commit messages to the branch's own in ${userText(path)} (the rest at the next open)`, e)
  }
  return changed
}
