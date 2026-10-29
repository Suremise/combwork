// The one finish path (HI-2014, SPEC §16.4.7): every move into Done, whatever made it (the merge queue, a builder's merge
// report, an override, a no-code card's acceptance, a plain board move), records one `Finished` fact and one durable
// `finish` action in the transaction of the move, and everything that follows a card's Done hangs off that action
// (finishPath.ts): its slot, its line, its dependents, its lane, its requests. A route can't skip it: the runtime's
// writes and the recorder's both end in `recordFinish`.

import { foldCard, type Actor, type Fact, type FactData, type FinishHow } from '../../shared/workflow/facts'
import type { Tx } from './factStore'

/** What a route knows of its Done that the facts it wrote don't say: a builder's unchecked merge report's result. */
export interface FinishFacts {
  claimed?: string | null
  /** A move the board recorded (rules off, no workflow): a board move whoever made it, never an unchecked report. */
  board?: boolean
}

/**
 * The `Finished` fact of a move into Done and its `finish` action, from what the write recorded with it: an `Integrated`
 * (the queue's, or a checked report: the merge commit, verified), an `Accepted`, an `Override` (by whom, why), a claim
 * nothing checked, else a board move. The action's payload is what the finish was for (its card's cycle, lease, line and
 * target as they were): its steps act on that, never on the card or slot as they are by then.
 */
export function recordFinish(tx: Tx, card: number, actor: Actor, ruleset: string | null, written: readonly Fact[], o: FinishFacts = {}): Fact<'Finished'> {
  // The cycle's merge and acceptance, recorded by this write or an earlier one (a hand merge seen while the rules were
  // off, Done once they are on); the override is this move's own.
  const cycle = foldCard(tx.facts(card))
  const integrated = cycle.integrated ?? undefined
  const override = written.findLast((f): f is Fact<'Override'> => f.kind === 'Override')?.data
  const accepted = !!cycle.accepted
  const moved = written.findLast((f): f is Fact<'Moved'> => f.kind === 'Moved' && (f.data as FactData['Moved']).to === 'done')?.data
  const how: FinishHow = integrated ? (integrated.by === 'hive' && integrated.method !== 'committed' ? 'queue' : 'reported') : accepted ? 'accepted' : override ? 'override' : !o.board && (o.claimed || moved?.cause === 'intent') ? 'unchecked' : 'board'
  const data: FactData['Finished'] = {
    how,
    verified: integrated?.result ?? null,
    ...(o.claimed && !integrated ? { claimed: o.claimed } : {}),
    ...(override ? { by: override.by, reason: override.reason } : {})
  }
  const f = tx.append(card, { kind: 'Finished', actor, source: 'recorded', ...(ruleset ? { ruleset } : {}), data }) // i18n-ignore: a fact's kind and codes, not text
  tx.action(card, 'finish', { finish: f.seq }, f.seq)
  return f
}

/** Whether a finish counts as accepted for the cards that depend on it (Darren's option A): an override's is. */
export function finishAccepts(f: FactData['Finished'] | null | undefined): boolean {
  return !!f && (f.how === 'accepted' || f.how === 'override')
}
