/**
 * HI-2854: what a builder hasn't seen of its card when its submit is refused for it (`submit.decisionsReceived`): the
 * user's decisions and comments newer than its receipts, each in full, given with the refusal and received with it, so
 * the next submit goes on unless more came meanwhile. The card, its facts and its archived comments are read in one
 * snapshot (tasks.cardWithFacts, HR2's rounds 1 and 2), and a receipt moves only as far as what was given: a decision is
 * shown in the words of its newest fact, and a comment of the user's from the card or, archived (HI-2641), from the whole
 * archive, searched for it, so nothing omitted or written later is counted as received.
 */
import type { TaskComment } from '../shared/types'
import type { Fact, FactData } from '../shared/workflow/facts'
import { foldCard } from '../shared/workflow/facts'
import { agentMsg, say } from '../shared/agentText'
import { cardWithFacts } from './tasks'
import { recordDecisionsReceived } from './workflow/recorder'
import type { WorkspaceService } from './workspace'

const T = {
  decision: agentMsg({ id: 'freshness.unread.decision', text: 'Decision ({date}, recorded by {by}): {text}', note: "HI-2854: a refused submit's unseen decision, on a line of its own below the refusal. date: YYYY-MM-DD; by: who recorded it; text: the decision in full." }),
  comment: agentMsg({ id: 'freshness.unread.comment', text: 'Comment from the user ({date}): {text}', note: "HI-2854: a refused submit's unseen comment the user wrote, on a line of its own below the refusal. date: YYYY-MM-DD; text: the comment in full." }),
  missing: agentMsg({ id: 'freshness.unread.missing', text: "A comment of the user's on this card can't be found, on the card or in its archive: ask the user what it said if you need it.", note: "HI-2854: a refused submit's line for a comment of the user's it hasn't seen that is neither on the card nor in its archive (HI-2641), which can't be given (not expected: every such comment is on one or the other); it counts as received, so the refusal doesn't repeat for ever." })
}

/** What a card's snapshot gives an agent: the lines, and the generations a receipt of exactly those reaches. */
export interface Unseen {
  lines: string[]
  generation: number
  comments: number
}

/**
 * The unseen decisions and comments of the user's for `agentId` in one snapshot of the card (its facts, the card, its
 * newest archived comments). Pure: what it lists is what the receipt it returns covers. A removed decision counts
 * towards the generation but isn't listed (nothing is left of it to follow).
 */
export function unseenIn(snap: { card: { decisions?: { id: string; at: string; editedAt?: string; recordedBy: string }[]; comments: TaskComment[] }; facts: readonly Fact[]; archived: readonly TaskComment[] }, agentId: string): Unseen {
  const s = foldCard(snap.facts)
  const seenDecisions = s.received[agentId] ?? 0
  const seenComments = s.receivedComments[agentId] ?? 0
  let generation = seenDecisions
  // Each decision's newest change past the receipt, in that fact's own words.
  const decided = new Map<string, FactData['Decision']>()
  const written: FactData['UserComment'][] = []
  for (const f of snap.facts) {
    if (f.kind === 'Decision') {
      const d = f.data as FactData['Decision']
      if (d.generation <= seenDecisions) continue
      generation = Math.max(generation, d.generation)
      decided.set(d.decision, d)
    } else if (f.kind === 'UserComment') {
      const c = f.data as FactData['UserComment']
      if (c.generation > seenComments) written.push(c)
    }
  }
  const lines: string[] = []
  for (const [id, d] of decided) {
    if (d.removed) continue
    const now = snap.card.decisions?.find((x) => x.id === id)
    lines.push(say(T.decision, { date: (now?.editedAt ?? now?.at ?? '').slice(0, 10), by: now?.recordedBy ?? '', text: d.text }))
  }
  // In generation order.
  let comments = seenComments
  for (const c of written.sort((a, b) => a.generation - b.generation)) {
    const found = snap.card.comments.find((x) => x.id === c.comment) ?? snap.archived.find((x) => x.id === c.comment)
    // Neither on the card nor anywhere in its archive (not expected): said so, and received, so it doesn't refuse for ever.
    lines.push(found ? say(T.comment, { date: found.at.slice(0, 10), text: found.text }) : say(T.missing))
    comments = c.generation
  }
  return { lines, generation, comments }
}

/** The ids of the user's comments `agentId` hasn't received that aren't on the card: what the archive is searched for. */
export function unseenOffCard(facts: readonly Fact[], onCard: ReadonlySet<string>, agentId: string): Set<string> {
  const seen = foldCard(facts).receivedComments[agentId] ?? 0
  return new Set(facts.flatMap((f) => (f.kind === 'UserComment' && (f.data as FactData['UserComment']).generation > seen && !onCard.has((f.data as FactData['UserComment']).comment) ? [(f.data as FactData['UserComment']).comment] : [])))
}

/**
 * unseenIn on the card as it is now, received: the receipt written before this returns, so the agent's next submit sees
 * it. Nothing when the card is no longer in the agent's `project` (moved since its intent was checked).
 */
export async function giveUnseen(ws: WorkspaceService, agentId: string, n: number, project: string): Promise<string[]> {
  const snap = await cardWithFacts(ws, n, { project, want: (facts, onCard) => unseenOffCard(facts, onCard, agentId) })
  if (!snap) return []
  const u = unseenIn(snap, agentId)
  await recordDecisionsReceived(ws, agentId, n, u.generation, snap.card.project, u.comments)
  return u.lines
}
