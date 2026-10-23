// G15 saved before P7 (#1445, SPEC §16.6.6): until P7 a build could store "Slots are brought up to date before each card"
// (`slotsUpToDate`) only as its forced Off, never as a user's choice: the presets wrote it whole, as Off, and the form
// didn't offer it. P7's Pair and Team set it On. A one-time step of the 1.0 upgrade settles each project's stored value,
// so Pair and Team projects don't turn Custom and get On from their next card:
// - a project whose options started from a preset takes that preset's value (On for Pair and Team, Off for Solo);
// - one with no preset (set one by one, or the upgrade's own options) drops it, and inherits;
// - the same for the options a project keeps for another platform (`kept`, #1419);
// - **never a change that adds a problem** (HR5's round 1): a project started from Pair and customised to the project
//   folder would contradict G15 On (`upToDateNeedsSlots`), and contradictory options work as all-off. So each change is
//   checked against the options' problems before it: one that adds any falls back to Off, and if Off adds one too, the
//   project is left as it is.
// It writes through `writeWorkflow` (#1417), keeping every other field. G1b's `reviewers` is never touched.
//
// Once, durably, whatever runs it (HR5's rounds 1 and 2): each project is settled at most once, recorded in project.json's
// `stepsDone` in the same write as its change (one locked, atomic write: never a change published without its record),
// and checked under that lock with the step's `board_meta` mark (set once every project is done). So a second Hive
// running it meanwhile, or a run again after one that failed or stopped anywhere, never touches a project already
// settled, nor a choice the user made since. Only dev and test workspaces have such values: no release has P5 or P6.

import { basename } from 'path'
import type { ProjectWorkflow } from '../../shared/types'
import type { PlatformId } from '../../shared/platform/descriptors'
import { preset, type PresetId, type WorkflowOptions } from '../../shared/workflow/options'
import { writeWorkflow } from '../../shared/workflow/projectWorkflow'
import { boardValue, boardWrite, setBoardValue, upgradeWaiting } from '../boardStore'
import { config } from '../config'
import { createLogger, userText } from '../logger'
import type { WorkspaceService } from '../workspace'
import { checkOptions } from './rulesets'

const log = createLogger('workflow')

/** The `board_meta` mark the step leaves once it has run over every project. */
export const SLOTS_UP_TO_DATE_STEP = 'workflow.slotsUpToDateFromBeforeP7'

/** The problems a platform's options would have (contradictions, a value it can't read), as ids, for the step's check. */
export type ProblemsOf = (platform: PlatformId, options: Partial<WorkflowOptions>) => string[]

/** Problems in `after` that `before` didn't have. */
const added = (before: string[], after: string[]): string[] => after.filter((p) => !before.includes(p))

/**
 * One platform's stored options with G15 settled: its preset's value (or dropped, with no preset), else Off when that
 * adds a problem; null when there's nothing to settle or every choice would add a problem.
 */
function settleOptions(platform: PlatformId, presetId: PresetId | null, options: Partial<WorkflowOptions>, problemsOf: ProblemsOf): Partial<WorkflowOptions> | null {
  if (!Object.hasOwn(options, 'slotsUpToDate')) return null
  const { slotsUpToDate: stored, ...rest } = options
  const before = problemsOf(platform, options)
  const value = presetId ? preset(platform, presetId).slotsUpToDate : undefined
  const candidates: Partial<WorkflowOptions>[] = [value === undefined ? rest : { ...rest, slotsUpToDate: value }, { ...rest, slotsUpToDate: false }]
  for (const c of candidates) {
    if (added(before, problemsOf(platform, c)).length) continue
    return c.slotsUpToDate === stored && Object.hasOwn(c, 'slotsUpToDate') ? null : c
  }
  return null
}

/** A project's `workflow` with G15 settled in its options and its kept ones; null when nothing changes. */
export function settledSlotsUpToDate(wf: ProjectWorkflow | null | undefined, problemsOf: ProblemsOf): ProjectWorkflow | null {
  if (!wf) return null
  const own = settleOptions(wf.platform, wf.preset, wf.options ?? {}, problemsOf)
  let kept = wf.kept
  let keptChanged = false
  for (const [p, k] of Object.entries(wf.kept ?? {}) as [PlatformId, NonNullable<ProjectWorkflow['kept']>[PlatformId]][]) {
    if (!k) continue
    const next = settleOptions(p, k.preset, k.options ?? {}, problemsOf)
    if (!next) continue
    kept = { ...kept, [p]: { ...k, options: next } }
    keptChanged = true
  }
  if (!own && !keptChanged) return null
  const written = writeWorkflow(wf, { platform: wf.platform, preset: wf.preset, options: own ?? wf.options })
  return keptChanged ? { ...written, kept } : written
}

/** The options' problems as a save checks them, at this workspace's levels (Hive's and the workspace's defaults). */
const problemsIn =
  (ws: WorkspaceService, folder: string): ProblemsOf =>
  (platform, options) =>
    checkOptions(platform, { global: config.settings.workflow, workspace: ws.config.workflow, project: options, folder }).problems.map((p) => (p.kind === 'contradiction' ? p.id : p.kind))

/** For tests: awaited before each project is looked at and after its write (a second Hive, or a failure, part way through). */
export interface StepHooks {
  beforeProject?: (folder: string) => Promise<void> | void
  afterProject?: (folder: string) => Promise<void> | void
}

/**
 * The step over a workspace's projects (hidden ones too), once: each project settled under its lock (its `stepsDone` and
 * the step's mark checked there first) with its record in the same write, then once every project is done the step's. Not before the 1.0
 * upgrade (its board isn't 1.0's yet), nor after the step's mark, nor once the workspace has closed. How many it changed;
 * a failure leaves the rest for the next open.
 */
export async function settleSlotsUpToDate(ws: WorkspaceService, hooks: StepHooks = {}): Promise<number> {
  const path = ws.path
  if (!path || upgradeWaiting(path) || boardValue(ws, SLOTS_UP_TO_DATE_STEP) !== null) return 0
  const life = ws.lifetime
  const alive = (): boolean => !life.aborted && ws.lifetime === life && ws.path === path
  let changed = 0
  try {
    const folders = new Set([...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))])
    for (const folder of folders) {
      await hooks.beforeProject?.(folder)
      if (!alive()) return changed
      let did = false
      await ws.mutateProjectConfig(folder, (c) => {
        // Under the project's lock, from the file as it is now: settled by any run of the step already, it is left alone.
        if (boardValue(ws, SLOTS_UP_TO_DATE_STEP) !== null || c.stepsDone?.includes(SLOTS_UP_TO_DATE_STEP)) return {}
        const next = settledSlotsUpToDate(c.workflow, problemsIn(ws, folder))
        did = !!next
        return { ...(next ? { workflow: next } : {}), stepsDone: [...(c.stepsDone ?? []), SLOTS_UP_TO_DATE_STEP] }
      })
      await hooks.afterProject?.(folder)
      if (did) {
        changed++
        log.info(`G15 from before P7 settled in ${userText(basename(folder))}`)
      }
    }
    if (alive()) await boardWrite(ws, async () => setBoardValue(ws, SLOTS_UP_TO_DATE_STEP, JSON.stringify({ at: new Date().toISOString(), changed })), { alive })
  } catch (e) {
    log.warn(`settling G15 from before P7 in ${userText(path)} (the rest at the next open)`, e)
  }
  return changed
}
