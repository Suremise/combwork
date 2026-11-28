// A place's generation ending (HI-3614): a slot's lease, a review copy's lease (its review), or a project leaving its
// workspace. The pools and the project's removal tell, and wait (HI-3614 round 1: the slot or copy isn't settled or lent
// again while a preview's server still runs in it); the Preview stops what ran there. A module of its own, so neither
// side loads the other.

export type PlaceEnd = { kind: 'generation'; id: string } | { kind: 'project'; path: string }

const listeners = new Set<(e: PlaceEnd) => void | Promise<unknown>>()

/** Calls fn with each place's end (awaited by whoever told it); returns its removal. */
export function onPlaceEnded(fn: (e: PlaceEnd) => void | Promise<unknown>): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** A lease ended (a slot's, a review copy's), or a project left its workspace: settles once every listener's work has. */
export async function placeEnded(e: PlaceEnd): Promise<void> {
  const work: Promise<unknown>[] = []
  for (const fn of listeners) {
    try {
      const r = fn(e)
      if (r) work.push(r)
    } catch {
      // A listener's failure is its own.
    }
  }
  await Promise.allSettled(work)
}
