// A place's generation ending (HI-3614): a slot's lease, a review copy's lease (its review), or a project leaving its
// workspace. The pools and the project's removal tell, and wait (HI-3614 round 1: the slot or copy isn't settled or lent
// again while a preview's server still runs in it); the Preview stops what ran there. A module of its own, so neither
// side loads the other.

export type PlaceEnd = { kind: 'generation'; id: string } | { kind: 'project'; path: string }

/** What a listener answers: the jobs whose processes it couldn't prove ended there (HI-3614 round 2), the place to stay held for. */
export type PlaceEndAnswer = { held: string[] } | void

const listeners = new Set<(e: PlaceEnd) => PlaceEndAnswer | Promise<PlaceEndAnswer>>()

/** Calls fn with each place's end (awaited by whoever told it); returns its removal. */
export function onPlaceEnded(fn: (e: PlaceEnd) => PlaceEndAnswer | Promise<PlaceEndAnswer>): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/**
 * A lease ended (a slot's, a review copy's), or a project left its workspace: settles once every listener's work has, with
 * the jobs still held there (a pool keeps the slot or copy out of use until they are settled; an empty list: none).
 */
export async function placeEnded(e: PlaceEnd): Promise<string[]> {
  const work: Promise<PlaceEndAnswer>[] = []
  for (const fn of listeners) {
    try {
      work.push(Promise.resolve(fn(e)))
    } catch {
      // A listener's failure is its own.
    }
  }
  const held: string[] = []
  for (const r of await Promise.allSettled(work)) if (r.status === 'fulfilled' && r.value) held.push(...r.value.held)
  return held
}
