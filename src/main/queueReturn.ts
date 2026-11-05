import type { WorkspaceService } from './workspace'
import { queueStateOf, resubmittedText, returnedWake } from './workflow/queueState'
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

/**
 * HI-2143: a card the merge queue returned that its builder (`builder`, its board name) has submitted again since, for
 * its reviewer, as its facts say: in Review, its queue's last entry failed, a submission after that failure and no verdict
 * since it. The reviewer's wake leads with it (resubmittedText). Null when it isn't one, or unreadable.
 */
export function resubmittedIn(wf: Workflow, n: number, builder: string): string | null {
  try {
    const card = wf.store.card(n)
    const s = wf.state(card)
    const last = s.entries.at(-1)
    if (s.stage !== 'review' || last?.state !== 'failed' || !last.failure || !s.latest) return null
    if (wf.rulesetOf(card, s).options.finish !== 'combworkMerges') return null
    const failed = wf.store.facts(n).findLast((f) => f.kind === 'IntegrationFailed')
    if (!failed || s.latest.id < failed.seq || s.verdicts.some((v) => v.seq > failed.seq)) return null
    return resubmittedText(card.key, last.failure, builder)
  } catch {
    return null
  }
}

/** resubmittedIn for a card of a project in a workspace. */
export async function resubmittedOf(ws: WorkspaceService, projectPath: string, n: number, builder: string): Promise<string | null> {
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  return wf ? resubmittedIn(wf, n, builder) : null
}

/** A card approved with a stale pass (HI-1763): since when (its `Stale` fact), what was passed and where its line is. */
export interface StaleApproval {
  since: string
  approved: string | null
  current: string | null
}

/** A card in Approved whose pass is stale, as its facts say; null when it isn't one, or unreadable. */
export function staleIn(wf: Workflow, n: number): StaleApproval | null {
  try {
    const s = wf.state(wf.store.card(n))
    return s.stage === 'approved' && s.stale && s.staleSince ? { since: s.staleSince, approved: s.stale.approved, current: s.stale.current } : null
  } catch {
    return null
  }
}

/** staleIn for a card of a project in a workspace. */
export async function staleApprovalOf(ws: WorkspaceService, projectPath: string, n: number): Promise<StaleApproval | null> {
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  return wf ? staleIn(wf, n) : null
}

/** returnIn for a card of a project in a workspace (its workflow, null when it has none). */
export async function queueReturnOf(ws: WorkspaceService, projectPath: string, n: number): Promise<QueueReturn | null> {
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  return wf ? returnIn(wf, n) : null
}
