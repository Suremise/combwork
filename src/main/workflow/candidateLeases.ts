// The check copy leases a jj candidate's merge checks hold (HI-2938, HR1's round 1 finding 1): a candidate attempt keeps
// its lease for the whole run, its install and every check, not only while one Progress run is open. The pool asks
// whether a check lease is over (`checkLeaseOver`, copiesApp.ts' leaseOver) at every refresh; a lease this Combwork's
// runner holds is never over until the runner gives it back. After a crash nothing is held here, so a lease whose
// Combwork is gone is over by its run or its link's age, as any isolated check's, and goes through the pool's barrier.

/** The leases this Combwork's candidate checks hold now, by id. */
const held = new Set<string>()

export const holdCandidateLease = (id: string): void => void held.add(id)
export const releaseCandidateLease = (id: string): void => void held.delete(id)
export const candidateLeaseHeld = (id: string): boolean => held.has(id)

/**
 * Whether a check lease is over, as this Combwork knows (the pool's `leaseOver` for a check lease): never while a
 * candidate's checks hold it; else when the run its ref names has ended (`runOpen`: whether that run is open, undefined
 * when there is no such run), or, with no such run, once its link's life (`ttlMs`) has passed. Null for another kind.
 */
export function checkLeaseOver(l: { id: string; kind: string; ref: string | null; from: string }, runOpen: (ref: string) => boolean | undefined, ttlMs: number, now: number = Date.now()): boolean | null {
  if (l.kind !== 'check') return null
  if (held.has(l.id)) return false
  const open = l.ref ? runOpen(l.ref) : undefined
  if (open !== undefined) return !open
  return now - Date.parse(l.from) > ttlMs
}
