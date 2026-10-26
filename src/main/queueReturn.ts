import type { WorkspaceService } from './workspace'
import { queueStateOf, returnedWake } from './workflow/queueState'
import type { Workflow } from './workflow/runtime'
import { workflowFor } from './workflow/service'

/** What queueReturnOf finds of a card the merge queue returned: when, its wake's text, and its cycle's builder. */
export interface QueueReturn {
  at: string
  text: string
  builder: string | null
}

/**
 * A card the merge queue returned to its builder and that waits for it now (HI-1721), as its facts say: queueStateOf's
 * `returned` (the last entry failed, the card back in Doing or Todo, not submitted since). `at`: when it came back;
 * `text`: the return's wake (what came back and what to do next); `builder`: the agent its cycle started with. Null when
 * it isn't one (merged, queued, never queued, a project whose cards Hive doesn't merge, or not readable).
 */
export function returnIn(wf: Workflow, n: number): QueueReturn | null {
  try {
    const card = wf.store.card(n)
    const s = wf.state(card)
    const q = queueStateOf(wf, card, s)
    if (q?.state !== 'returned') return null
    const failed = wf.store.facts(n).filter((f) => f.kind === 'IntegrationFailed').at(-1)
    return { at: failed?.at ?? '', text: returnedWake(card.key, q.failure), builder: s.started?.builder ?? null }
  } catch {
    // A card not on this board (gone, another project's) or a board from before 1.0.
    return null
  }
}

/** returnIn for a card of a project in a workspace (its workflow, null when it has none). */
export async function queueReturnOf(ws: WorkspaceService, projectPath: string, n: number): Promise<QueueReturn | null> {
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  return wf ? returnIn(wf, n) : null
}
