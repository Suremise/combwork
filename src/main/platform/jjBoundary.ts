// jj's snapshot boundary (SPEC §16.3.6 port 3, HI-2796's J3): the one place Combwork records a jj working copy, as an
// operation of its own that its caller authorises, never something an observer, a reader or a credit decision does. jj
// records the working copy as a commit on almost every command; Combwork's reads never do (jjReads.ts pins them), so
// what is on disk becomes history only here, at a defined point: a check's start and end, a submission.
//
// The boundary runs holding the store's repository lock (R1.1: a colocated pair and its workspaces are one store), and
// checks its owner (the lease that lends the workspace to the card) before the snapshot and again after every await. jj
// itself doesn't take Combwork's lock, so what it read is checked again before it answers: the heads, the checkout
// record and Git's state (colocated) must be the moment the snapshot left. With `expect` (a check's end) the heads must
// be exactly that operation before the snapshot, and nothing retries onto a newer one: an operation by anyone since is
// `moved`, never erased by reading again.

import type { JjRunner } from './jjRunner'
import { jjRunner } from './jjRunner'
import { isJjUnknown, JjReads, type JjCommit, type JjReadUnknown } from './jjReads'
import { sameView, singleHead, viewNow, type Checkout, type ViewNow, type ViewOf } from './jjView'

/** Runs `fn` holding the store's repository lock (port 1's `withRepoLock` for the workspace's context). */
export type StoreLock = <T>(fn: () => Promise<T>) => Promise<T>

/** Whether the workspace is still the caller's: its lease current for this card and this workspace. */
export interface Owner {
  still(): boolean
}

/**
 * Why a boundary refused: the owner lost the workspace (`owner`), the heads not one (`heads`), the heads not the expected
 * operation or moving under it (`moved`), a stale workspace (`stale`), cancelled (`cancelled`), jj not tracking every new
 * file (`autoTrack`: an untracked file would escape the snapshot), or anything else it couldn't read (`unknown`).
 */
export type BoundaryWhy = 'owner' | 'heads' | 'moved' | 'stale' | 'cancelled' | 'autoTrack' | 'unknown'

export interface BoundaryRefused {
  refused: BoundaryWhy
  detail?: string
}

/** A boundary taken: the head before the snapshot, the head after it, and the workspace's checkout and @ at that head. */
export interface Boundary {
  before: string
  op: string
  /** The snapshot recorded something (the heads moved across it): what was on disk wasn't the workspace's @. */
  recorded: boolean
  checkout: Checkout
  /** The workspace's working-copy commit at `op`. */
  at: JjCommit
  /** The moment the boundary answers for: `op`'s head, checkout and Git state. */
  view: ViewNow
}

export const isRefused = (b: Boundary | BoundaryRefused): b is BoundaryRefused => 'refused' in b

/** Barriers a test pauses at (each awaited where it says), so a race can be put exactly there. */
export interface BoundaryHooks {
  /** Inside the lock, after the owner's first check, before the snapshot. */
  beforeSnapshot?: () => Promise<void> | void
  /** After the snapshot, before anything is read of it. */
  afterSnapshot?: () => Promise<void> | void
  /** After the workspace's @ was read, before the moment is read again. */
  beforeRecheck?: () => Promise<void> | void
}

export interface BoundaryOptions {
  /** A check's end: the heads must be exactly this before the snapshot, and nothing retries. */
  expect?: string
  signal?: AbortSignal
  timeout?: number
  /** The store's repository lock, from the repository context port (J6 composes it; R1.1: one store, one lock). */
  lock: StoreLock
  hooks?: BoundaryHooks
}

/** What a boundary needs of the workspace: the view's paths and a folder of it to run jj in. */
export type BoundaryOf = ViewOf & { folder: string }

const refused = (why: BoundaryWhy, detail?: string): BoundaryRefused => ({ refused: why, ...(detail ? { detail: detail.slice(0, 2000) } : {}) })
const fromRead = (u: JjReadUnknown): BoundaryRefused => refused(u.jjUnknown === 'moved' || u.jjUnknown === 'heads' ? 'moved' : 'unknown', u.detail ?? u.jjUnknown)

/** Takes a boundary (see the module's comment). Its owner's loss, at any await, refuses it. */
export async function jjBoundary(w: BoundaryOf, owner: Owner, o: BoundaryOptions, runner: JjRunner = jjRunner): Promise<Boundary | BoundaryRefused> {
  const lock = o.lock
  const reads = new JjReads({ folder: w.folder, jjRepo: w.jjRepo }, runner, { signal: o.signal, timeout: o.timeout })
  return lock(async () => {
    if (!owner.still()) return refused('owner')
    await o.hooks?.beforeSnapshot?.()
    if (!owner.still()) return refused('owner')
    const before = singleHead(w.jjRepo)
    if (!before) return refused('heads')
    if (o.expect !== undefined && before !== o.expect) return refused('moved', 'beforeSnapshot')
    // Only the pinned jj writes (an untested one's command line or files may differ).
    const tool = await reads.supported()
    if (!owner.still()) return refused('owner')
    if (isJjUnknown(tool)) return refused('unknown', tool.detail ?? tool.jjUnknown)
    if (singleHead(w.jjRepo) !== before) return refused('moved', 'beforeSnapshot')
    // The snapshot: written, and a stale workspace is never brought up to date by it (stale recovery is J2's, explicit).
    // Its owner and the head again under the file gate's admission, right before jj starts (HI-2918).
    const recheck = (): string | null => (!owner.still() ? 'owner' : singleHead(w.jjRepo) !== before ? 'moved' : null)
    const r = await runner.run(w.folder, ['util', 'snapshot', '--config=snapshot.auto-update-stale=false'], { write: true, signal: o.signal, timeout: o.timeout, recheck })
    if (r.refused === 'moved') return refused('moved', 'beforeSnapshot')
    if (!owner.still() || r.refused) return refused('owner')
    if (r.cancelled) return refused('cancelled')
    if (!r.ok) return refused(/stale/i.test(r.err) ? 'stale' : 'unknown', r.err)
    await o.hooks?.afterSnapshot?.()
    if (!owner.still()) return refused('owner')
    const view = viewNow(w)
    if (!view) return refused(singleHead(w.jjRepo) ? 'unknown' : 'heads')
    // The workspace was brought to the head the snapshot left (an empty snapshot moves its record to the head too).
    if (view.checkout.op !== view.head) return refused('stale', 'checkoutBehind')
    const at = await reads.commitAt(view.head, `${view.checkout.workspace}@`)
    if (!owner.still()) return refused('owner')
    if (isJjUnknown(at)) return fromRead(at)
    const track = await reads.configAt(view.head, 'snapshot.auto-track')
    if (!owner.still()) return refused('owner')
    if (isJjUnknown(track)) return fromRead(track)
    if (track !== 'all()') return refused('autoTrack', track)
    await o.hooks?.beforeRecheck?.()
    if (!owner.still()) return refused('owner')
    // jj doesn't take Combwork's lock: the moment read must still be the moment now, or the answer mixes two.
    if (!sameView(view, viewNow(w))) return refused('moved', 'afterSnapshot')
    return { before, op: view.head, recorded: view.head !== before, checkout: view.checkout, at, view }
  })
}
