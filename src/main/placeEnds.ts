// A place's generation ending (HI-3614): a slot's lease, a review copy's lease (its review), or a project leaving its
// workspace. The pools and the project's removal tell; the Preview stops what ran there. A module of its own, so neither
// side loads the other.

export type PlaceEnd = { kind: 'generation'; id: string } | { kind: 'project'; path: string }

const listeners = new Set<(e: PlaceEnd) => void>()

/** Calls fn with each place's end; returns its removal. */
export function onPlaceEnded(fn: (e: PlaceEnd) => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** A lease ended (a slot's, a review copy's), or a project left its workspace. */
export function placeEnded(e: PlaceEnd): void {
  for (const fn of listeners) {
    try {
      fn(e)
    } catch {
      // A listener's failure is its own.
    }
  }
}
