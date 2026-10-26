// Cards whose board column and workflow stage disagree (HI-1674): brought into line each time a workspace opens. A card
// from before 1.0 kept its mark (`pre_workflow`) when an intent started it, so the user's and the Assistant's moves of it
// took P3's path: Done in the column, Active in the stage, its questions still For you (HI-1151, HI-1153 on rc.1). The
// cause is fixed where stages are written (factStore's setStage clears the mark); this repairs what it left.

import { basename, join } from 'path'
import { boardRead, boardWaits, boardWrite, boardWriteOp } from '../boardStore'
import { createLogger, userText } from '../logger'
import { HISTORY, storedText } from '../../shared/taskHistory'
import type { WorkspaceService } from '../workspace'
import type { Write } from './runtime'

const log = createLogger('workflow')

/** What the repair found and did: marks cleared, stages brought to Done, and cards it couldn't (left for the next open). */
export interface StageRepair {
  unmarked: number
  repaired: number[]
  failed: number
}

/** For tests: runs before each card's repair (outside its change), and in its change before its history line. */
export const stageRepairTestHooks: { beforeRepair: ((n: number) => Promise<void>) | null; beforeNote: ((n: number) => Promise<void>) | null } = { beforeRepair: null, beforeNote: null }

/**
 * Clears the 1.0 mark of every card with workflow facts (started since, so a 1.0 card), then brings each card the board
 * has in Done while its stage isn't into line through its project's runtime: a `Moved` to done as a repair, its asked
 * questions closed (closeSettled), a line in its history, all in one change of the board. Only while the workspace it
 * began on stays open: a close or a switch stops it (the next open goes on). Never throws: a card it can't repair is
 * logged and left.
 */
export async function repairStages(ws: WorkspaceService): Promise<StageRepair> {
  const out: StageRepair = { unmarked: 0, repaired: [], failed: 0 }
  const path = ws.path
  if (!path) return out
  // A board waiting for its upgrade to 1.0 is read-only: left alone, quietly, and repaired once it is upgraded, when the
  // opening's steps run again (HI-1714: it warned "This board is from Hive 0.9" at each open).
  if (boardWaits(ws)) return out
  const life = ws.lifetime
  const alive = (): boolean => !life.aborted && ws.lifetime === life && ws.path === path
  try {
    out.unmarked = await boardWrite(
      ws,
      async () => boardWriteOp(ws, (db) => Number(db.prepare('UPDATE cards SET pre_workflow = 0 WHERE pre_workflow = 1 AND EXISTS (SELECT 1 FROM card_facts f WHERE f.card = cards.number)').run().changes)), // i18n-ignore: SQL
      { alive }
    )
    if (!alive()) return out
    const off = boardRead(ws, (db) => db.prepare("SELECT number, project FROM cards WHERE col = 'done' AND stage IS NOT NULL AND stage <> 'done' AND project IS NOT NULL AND project <> '' AND EXISTS (SELECT 1 FROM card_facts f WHERE f.card = cards.number)").all() as { number: number; project: string }[]) // i18n-ignore: SQL
    if (!off.length) {
      if (out.unmarked) log.info(`${out.unmarked} started card(s) in ${userText(basename(path))} no longer marked as from before 1.0`)
      return out
    }
    // Imported when needed: the service reaches the board's notices, which reach back here.
    const { workflowFor } = await import('./service')
    const { alongside } = await import('./runtime')
    const { noteOnCard } = await import('../tasks')
    for (const c of off) {
      try {
        await stageRepairTestHooks.beforeRepair?.(c.number)
        if (!alive()) break
        const wf = await workflowFor(ws, join(path, c.project))
        if (!wf) continue
        // The history line in the repair's own change (its runtime's lock, the board's change): if it fails, so does the
        // repair, left whole for the next open. The stage it names is the one the write found.
        const note = async (w: Write): Promise<void> => {
          if (w.card.id !== c.number) return
          await stageRepairTestHooks.beforeNote?.(c.number)
          await noteOnCard(c.number, storedText(HISTORY.stageRepaired, { stage: w.was }), ws)
        }
        if (await alongside({ written: note }, () => wf.repairToDone(c.number))) out.repaired.push(c.number)
      } catch (e) {
        out.failed++
        log.warn(`bringing card ${c.number}'s stage into line with its column`, e)
      }
    }
    log.info(`Stages repaired in ${userText(basename(path))}: ${out.unmarked} mark(s) cleared, ${out.repaired.length} card(s) brought to Done${out.failed ? `, ${out.failed} left for the next open` : ''}`)
  } catch (e) {
    log.warn(`repairing the stages of ${userText(basename(path))}'s cards (tried again at the next open)`, e)
  }
  return out
}
