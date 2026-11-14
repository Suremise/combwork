// HI-3082: what counts as a card's change being in its target, by the card. A forward merge (HI-2885) and a forward's
// resolution (HI-2959) are there only when their commit is in the target's history (merged or fast-forwarded): never by a
// squash or the same tree. A resolution keeping the destination's side has the destination's tree, but the source isn't
// in its history until it merges, which is the whole point of it.
import type { CardState } from '../../shared/workflow/facts'
import { isUnknown, type Containment, type Maybe } from '../platform/types'

/** Whether a card's change counts as in its target only through the target's history (a forward or its resolution). */
export const byAncestryOnly = (s: Pick<CardState, 'forward' | 'resolves'>): boolean => !!(s.forward || s.resolves)

/** `c`, a containment read of `s`'s change, as that card counts it: a squash or same tree is no answer for a forward or its resolution. */
export function asCardCounts(s: Pick<CardState, 'forward' | 'resolves'>, c: Maybe<Containment | null>): Maybe<Containment | null> {
  if (!byAncestryOnly(s) || isUnknown(c) || !c) return c
  return c.method === 'merge' || c.method === 'fastForward' ? c : null
}
