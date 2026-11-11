/**
 * A card's start task as Combwork gives it (HI-2854): the prompt (shared/tasks.ts' taskStartPrompt), with the whole card
 * when it fits, and what its delivery records: that it is the task this card was started with in this work cycle (so the
 * builder's start or submit of the card acks it), and, when it carries the whole card, the decision and comment
 * generations it was made at (received with it once cw_inbox gives it: deliveries.ts' onCardTaskReceived).
 */
import { WHOLE_CARD_MAX } from '../shared/advanced'
import { taskStartPrompt, workStartedAt, type StartPromptOpts } from '../shared/tasks'
import type { TaskCard } from '../shared/types'
import { advanced } from './advanced'
import { cardSnapshot } from './tasks'
import type { WorkspaceService } from './workspace'

export type StartTaskMeta = Record<string, number | boolean>

export async function cardStartPrompt(ws: WorkspaceService, card: TaskCard, agentId: string, withTools: boolean, opts: Omit<StartPromptOpts, 'yours' | 'wholeMax' | 'archivedComments'>): Promise<{ text: string; meta: StartTaskMeta }> {
  // The card and its generations in one snapshot: what the task gives is what its receipt records. Not read: the card as
  // the caller has it, never whole.
  const snap = await cardSnapshot(ws, card.number).catch(() => null)
  const now = snap?.card ?? card
  const max = snap ? Number(advanced.get<number>(WHOLE_CARD_MAX)) || 0 : 0
  const r = taskStartPrompt(now, withTools, { ...opts, yours: now.column === 'doing' && now.agent === agentId, wholeMax: max, archivedComments: snap?.archived ?? 0 })
  const cycle = workStartedAt(now)
  return {
    text: r.text,
    meta: { cardTask: true, ...(cycle ? { cycle } : {}), ...(r.whole && snap ? { seenDecisions: snap.generation, seenComments: snap.comments, seenAt: snap.at } : {}) }
  }
}
