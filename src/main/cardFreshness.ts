/**
 * HI-2854: what a builder hasn't seen of its card when its submit is refused for it (`submit.decisionsReceived`): the
 * user's decisions and comments newer than its receipts, each in full, given with the refusal and received with it, so
 * the next submit goes on unless more came meanwhile. A receipt moves only as far as what was given: a decision or
 * comment written after the card's facts were read here is neither listed nor counted as received.
 */
import type { TaskCard } from '../shared/types'
import type { FactData } from '../shared/workflow/facts'
import { foldCard } from '../shared/workflow/facts'
import { agentMsg, say } from '../shared/agentText'
import { cardFacts, recordDecisionsReceived } from './workflow/recorder'
import type { WorkspaceService } from './workspace'

const T = {
  decision: agentMsg({ id: 'freshness.unread.decision', text: 'Decision ({date}, recorded by {by}): {text}', note: "HI-2854: a refused submit's unseen decision, on a line of its own below the refusal. date: YYYY-MM-DD; by: who recorded it; text: the decision in full." }),
  comment: agentMsg({ id: 'freshness.unread.comment', text: 'Comment from the user ({date}): {text}', note: "HI-2854: a refused submit's unseen comment the user wrote, on a line of its own below the refusal. date: YYYY-MM-DD; text: the comment in full." })
}

/**
 * The card's unseen decisions and comments of the user's for `agentId` (each a line), and the generations a receipt of
 * them reaches. Removed decisions count towards the generation but aren't listed. Empty when nothing is unseen.
 */
export function unseenOnCard(ws: WorkspaceService, agentId: string, card: TaskCard): { lines: string[]; generation: number; comments: number } {
  const facts = cardFacts(ws, card.number)
  const s = foldCard(facts)
  const seenDecisions = s.received[agentId] ?? 0
  const seenComments = s.receivedComments[agentId] ?? 0
  let generation = seenDecisions
  let comments = seenComments
  // Each decision's newest change past the receipt: its latest words, from the card as it is (a fact keeps its id).
  const decided = new Map<string, FactData['Decision']>()
  const written: string[] = []
  for (const f of facts) {
    if (f.kind === 'Decision') {
      const d = f.data as FactData['Decision']
      if (d.generation <= seenDecisions) continue
      generation = Math.max(generation, d.generation)
      decided.set(d.decision, d)
    } else if (f.kind === 'UserComment') {
      const c = f.data as FactData['UserComment']
      if (c.generation <= seenComments) continue
      comments = Math.max(comments, c.generation)
      written.push(c.comment)
    }
  }
  const lines: string[] = []
  for (const [id, d] of decided) {
    if (d.removed) continue
    const now = card.decisions?.find((x) => x.id === id)
    lines.push(say(T.decision, { date: (now?.editedAt ?? now?.at ?? '').slice(0, 10), by: now?.recordedBy ?? '', text: now?.text ?? d.text }))
  }
  for (const id of written) {
    const c = card.comments.find((x) => x.id === id)
    // One archived since (past the comments a card keeps) is old by then: what it said is in the card's archive.
    if (c) lines.push(say(T.comment, { date: c.at.slice(0, 10), text: c.text }))
  }
  return { lines, generation, comments }
}

/** unseenOnCard, received: the receipt written before this returns, so the agent's next submit sees it. */
export async function giveUnseen(ws: WorkspaceService, agentId: string, card: TaskCard): Promise<string[]> {
  const u = unseenOnCard(ws, agentId, card)
  await recordDecisionsReceived(ws, agentId, card.number, u.generation, card.project, u.comments)
  return u.lines
}
