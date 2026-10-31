// HI-2245: a builder's own cards in Review whose line has commits past their submission, said in its card watch's reply
// and hive_lane next's (agent-facing, shared/unsubmitted.ts's text): the column alone read as handed over.

import type { WorkspaceService } from './workspace'
import type { UnsubmittedCard } from '../shared/unsubmitted'

/** The most cards one reply reads (each a few git reads): a watch names few. */
const MAX_CARDS = 10

/** Of `cards`, those of the agent's project in Review that it builds with commits past their submission; [] when none. */
export async function unsubmittedOf(ws: WorkspaceService, projectPath: string, agentId: string, cards: readonly number[]): Promise<UnsubmittedCard[]> {
  // Imported when first needed, as tasks.ts does: the service reaches back here through the board's notices.
  const { workflowFor } = await import('./workflow/service')
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  if (!wf) return []
  const out: UnsubmittedCard[] = []
  for (const n of cards.slice(0, MAX_CARDS)) {
    let card
    try {
      card = wf.store.card(n)
    } catch {
      continue
    }
    const r = await wf.unsubmitted(card, agentId).catch(() => null)
    if (r) out.push({ card: n, ...r })
  }
  return out
}
