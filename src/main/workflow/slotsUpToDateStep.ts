// G15 saved before P7 (#1445, SPEC §16.6.6): until P7 a build could store "Slots are brought up to date before each card"
// (`slotsUpToDate`) only as its forced Off, never as a user's choice: the presets wrote it whole, as Off, and the form
// didn't offer it. P7's Pair and Team set it On. A one-time step of the 1.0 upgrade (a `board_meta` mark, safe to repeat)
// settles each project's stored value, so Pair and Team projects don't turn Custom and get On from their next card:
// - a project whose options started from a preset takes that preset's value (On for Pair and Team, Off for Solo);
// - one with no preset (set one by one, or the upgrade's own options) drops it, and inherits;
// - the same for the options a project keeps for another platform (`kept`, #1419).
// It writes through `writeWorkflow` (#1417), keeping every other field. After the mark, a stored value is the user's and
// is kept. G1b's `reviewers` is never touched. Only dev and test workspaces have such values: no release has P5 or P6.

import { basename } from 'path'
import type { ProjectWorkflow } from '../../shared/types'
import type { PlatformId } from '../../shared/platform/descriptors'
import { preset, type PresetId, type WorkflowOptions } from '../../shared/workflow/options'
import { writeWorkflow } from '../../shared/workflow/projectWorkflow'
import { boardValue, boardWrite, setBoardValue, upgradeWaiting } from '../boardStore'
import { createLogger, userText } from '../logger'
import type { WorkspaceService } from '../workspace'

const log = createLogger('workflow')

/** The `board_meta` mark the step leaves once it has run over every project. */
export const SLOTS_UP_TO_DATE_STEP = 'workflow.slotsUpToDateFromBeforeP7'

/** One platform's stored options with G15 settled: its preset's value, or none (inherit). Null when there's nothing to settle. */
function settleOptions(platform: PlatformId, presetId: PresetId | null, options: Partial<WorkflowOptions>): Partial<WorkflowOptions> | null {
  if (!Object.hasOwn(options, 'slotsUpToDate')) return null
  const { slotsUpToDate: stored, ...rest } = options
  const value = presetId ? preset(platform, presetId).slotsUpToDate : undefined
  if (value === undefined) return rest
  return value === stored ? null : { ...rest, slotsUpToDate: value }
}

/** A project's `workflow` with G15 settled in its options and its kept ones; null when nothing changes. */
export function settledSlotsUpToDate(wf: ProjectWorkflow | null | undefined): ProjectWorkflow | null {
  if (!wf) return null
  const own = settleOptions(wf.platform, wf.preset, wf.options ?? {})
  let kept = wf.kept
  let keptChanged = false
  for (const [p, k] of Object.entries(wf.kept ?? {}) as [PlatformId, NonNullable<ProjectWorkflow['kept']>[PlatformId]][]) {
    if (!k) continue
    const next = settleOptions(p, k.preset, k.options ?? {})
    if (!next) continue
    kept = { ...kept, [p]: { ...k, options: next } }
    keptChanged = true
  }
  if (!own && !keptChanged) return null
  const written = writeWorkflow(wf, { platform: wf.platform, preset: wf.preset, options: own ?? wf.options })
  return keptChanged ? { ...written, kept } : written
}

/**
 * The step over a workspace's projects (hidden ones too), once: each project's `workflow` settled under its lock, then
 * the mark. Not before the 1.0 upgrade (its board isn't 1.0's yet), nor again after the mark. How many it changed; a
 * failure leaves the mark unset, so it runs again at the next open.
 */
export async function settleSlotsUpToDate(ws: WorkspaceService): Promise<number> {
  const path = ws.path
  if (!path || upgradeWaiting(path) || boardValue(ws, SLOTS_UP_TO_DATE_STEP) !== null) return 0
  let changed = 0
  try {
    const folders = new Set([...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))])
    for (const folder of folders) {
      let did = false
      await ws.mutateProjectConfig(folder, (c) => {
        // Under the lock, from the file as it is now.
        const next = settledSlotsUpToDate(c.workflow)
        if (!next) return {}
        did = true
        return { workflow: next }
      })
      if (did) {
        changed++
        log.info(`G15 from before P7 settled in ${userText(basename(folder))}`)
      }
    }
    await boardWrite(ws, async () => setBoardValue(ws, SLOTS_UP_TO_DATE_STEP, JSON.stringify({ at: new Date().toISOString(), changed })))
  } catch (e) {
    log.warn(`settling G15 from before P7 in ${userText(path)} (tried again at the next open)`, e)
  }
  return changed
}
