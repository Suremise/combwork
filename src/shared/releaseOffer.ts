// HI-3155: what a release offer changes, the same for the window's Move… and Remove… and for the Assistant's answer. Work
// merges into goes to the next version when there is one to go to; the released release then joins Other branches work
// can merge into (as Start the next version does, so work still on it finishes there), and the released Other branches
// nothing uses come off.

import type { ReleaseOffer } from './types'

/** The options the offer proposes: Work merges into (only when it moves) and Other branches work can merge into. */
export function offerOptions(o: ReleaseOffer): { target?: string; otherTargets: string[] } {
  const drop = new Set((o.cleanup?.drop ?? []).map((d) => d.branch))
  const moveTo = o.move?.moveTo ?? null
  const others = o.basis.otherTargets.filter((b) => !drop.has(b) && b !== moveTo)
  if (moveTo && !others.includes(o.basis.target)) others.push(o.basis.target)
  return moveTo ? { target: moveTo, otherTargets: others } : { otherTargets: others }
}

/** Whether the offer has anything to apply (a move, or something to take off); else it only informs (Not now). */
export const offerApplies = (o: ReleaseOffer): boolean => !!o.move?.moveTo || !!o.cleanup?.drop.length

/** Whether the options as they are now are still the ones the offer was made on (its actions are refused otherwise). */
export function sameBasis(o: ReleaseOffer, now: { target: string; otherTargets: readonly string[] }): boolean {
  const a = [...o.basis.otherTargets].sort()
  const b = [...now.otherTargets].sort()
  return o.basis.target === now.target && a.length === b.length && a.every((x, i) => x === b[i])
}
