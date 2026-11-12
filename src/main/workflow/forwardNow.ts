// HI-2892, HI-3040, HI-3049, HI-3085: whether a forward merge (or a forward's resolution, HI-2998) may go now, by the
// release path's direction: one rule for the merge queue and for the window's and the Assistant's Retry merge and
// Resolve on a builder, so a control never refuses for good what the queue would only pause on.
import { forwardDirection, forwardPermitted, type ForwardDirection, type ForwardOverride } from '../../shared/workflow/forwardOrder'
import { UNREADABLE } from '../../shared/workflow/texts'
import type { HistoryPort } from '../platform/history'
import { isUnknown, unknown, type Unknown } from '../platform/types'

/** What a forward's direction reads as now. */
export type ForwardNow =
  /** It may go: its direction is the release path's, or its request recorded the user's override. */
  | { ok: true }
  /** Against the release path's direction (or one that can't be ordered): it never goes without an override. */
  | { ok: false; why: 'direction'; d: ForwardDirection }
  /**
   * HI-3049: no main or master, so the default branch git names is only the project folder's checked-out branch, another
   * than `was`, recorded when its direction was checked and still there: the folder switched, not the release path.
   */
  | { ok: false; why: 'switched'; now: string; was: string }
  /** HI-3040: the default branch couldn't be read or named (git failed, a detached folder with no main or master). */
  | { ok: false; why: 'unknown'; u: Unknown }

/** A forward's branches, its request's override and the default branch recorded when its direction was checked. */
export interface ForwardPair {
  from: string
  to: string
  override?: ForwardOverride
  defaultBranch?: string
}

/** Whether forward `f` may go now in `project`, read through its platform's history port `H`. */
export async function forwardNow(H: HistoryPort, project: string, f: ForwardPair): Promise<ForwardNow> {
  if (f.override) return { ok: true }
  // Decided by the names alone (two versions, or the same one): the default branch isn't read.
  const alone = forwardDirection(f.from, f.to, null)
  if (alone.dir !== 'unknown' || alone.why !== 'unordered') return forwardPermitted(alone, f.override) ? { ok: true } : { ok: false, why: 'direction', d: alone }
  const none = (): ForwardNow => ({ ok: false, why: 'unknown', u: unknown(UNREADABLE.defaultBranch, { folder: project }) })
  const d = await H.defaultTarget(project).catch(() => null)
  if (!d) return none()
  if (isUnknown(d)) return { ok: false, why: 'unknown', u: d }
  const there = await H.lineHead(project, d).catch(() => null)
  if (there && isUnknown(there)) return { ok: false, why: 'unknown', u: there }
  if (!there) return none()
  const dir = forwardDirection(f.from, f.to, d)
  if (forwardPermitted(dir, f.override)) return { ok: true }
  const refused: ForwardNow = { ok: false, why: 'direction', d: dir }
  // HI-3049: a default that is only the folder's other branch, the recorded one still there and no main or master: no
  // answer. A main or master made since, or the recorded one gone, is a real change.
  const was = f.defaultBranch
  if (!was || was === d) return refused
  const main = await H.mainLine(project).catch(() => unknown(UNREADABLE.defaultBranch, { folder: project }))
  if (isUnknown(main)) return { ok: false, why: 'unknown', u: main }
  if (main !== null) return refused
  const kept = await H.lineHead(project, was).catch(() => unknown(UNREADABLE.line, { branch: was }))
  if (isUnknown(kept)) return { ok: false, why: 'unknown', u: kept }
  if (!kept) return refused
  return { ok: false, why: 'switched', now: d, was }
}
