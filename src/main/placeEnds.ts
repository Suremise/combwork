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

/** A job a preview holds a place for (its server's job, or its own id when it has none): HI-3614/HI-3615. */
export const isPreviewHold = (job: string): boolean => /^(preview|pv)-[0-9a-f]+$/.test(job)

let previewHeld: ((job: string) => Promise<boolean>) | null = null

/** The Preview's check of a hold (HI-3615 round 2): whether everything of that preview is proved gone, its page's guard too. */
export function setPreviewHoldCheck(fn: ((job: string) => Promise<boolean>) | null): void {
  previewHeld = fn
}

/**
 * A pool's settle of a job it keeps on a slot or copy (HI-3615 round 2): its processes proved ended (`settle`), and, for a
 * preview's hold, the preview's own proof too: its server's job ending doesn't prove its page's proxy (a process of its
 * own) gone. True only with both.
 */
export async function settleHeld(job: string, settle: (job: string) => Promise<boolean>): Promise<boolean> {
  if (!(await settle(job))) return false
  if (!isPreviewHold(job) || !previewHeld) return true
  return previewHeld(job).catch(() => false)
}
