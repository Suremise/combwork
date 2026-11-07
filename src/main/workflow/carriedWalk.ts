// Which merge brought a card's change into its target (HI-2709, SPEC §16.4.4): a card in Review whose submitted change
// is in its target was taken as merged by hand and closed, outside the rules. But the merge queue may have carried it
// there inside another card's merge (HI-2684 carried HI-2682's commits before HI-2682's review passed): then its review
// must still decide, and the card stays in Review with a mark. The walk proves one or the other, or defers:
//
// - It goes over the queue's recorded merges into the target, newest first (`Integrated` by Combwork, with its
//   `IntegrationStarted`), and asks of each whether the change was in the target just before it (`expected`) and just
//   after it (`result`), with the same containment reconcile uses (merge, squash, fast-forward, same tree, key):
//   in before, an older merge or a hand merge brought it, so it goes on; absent before and in after, that merge carried
//   it; absent both, it arrived after that merge, outside the queue: a hand merge. Run out of merges with it in before
//   every one: a hand merge before them all.
// - A merge whose result is no longer in the target's history (a reset) is passed over; any read that can't be made, a
//   merge in flight (begun, no outcome: its recovery too) or a merge without its start defers: nothing is written.
// - Bounded per pass (PAGE merges, an indexed page of the store): not settled within it, the walk keeps where it got to
//   and defers, for the next pass, so a carrier is never missed for not being looked at. Kept with the target's head and
//   the newest merge into it as the walk began: either changed, it starts again from the newest.
// - Its outcome is written only if, in the write, the card is in the same cycle on the same submission and target, and
//   the target's merges and head are those the walk read.

import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import type { CardState, FactData } from '../../shared/workflow/facts'
import type { CardRecord } from './factStore'
import type { Workflow, Write } from './runtime'

/** Merges read per pass, at most (each up to three git reads). */
export const CARRIED_PAGE = 10

/** What the walk proved: a merge of the queue carried the change, it arrived outside the queue, or nothing yet. */
export type Provenance =
  | { kind: 'carried'; by: string; entry: string; snap: Snapshot }
  | { kind: 'outside'; snap: Snapshot }
  | { kind: 'defer'; why: 'more' | 'unknown' | 'busy' }
  | { kind: 'notContained' }

/** Deferred, and why (codes, never shown). */
const DEFER_UNKNOWN: Provenance = { kind: 'defer', why: 'unknown' } // i18n-ignore: a code
const DEFER_BUSY: Provenance = { kind: 'defer', why: 'busy' } // i18n-ignore: a code
const DEFER_MORE: Provenance = { kind: 'defer', why: 'more' } // i18n-ignore: a code

/** The history a walk is bound to: the target's head and its newest merge's row when it began. */
export interface Snapshot {
  head: string
  watermark: number
}

interface Cursor {
  snap: Snapshot
  /** The next page is of merges below this row. */
  below: number
}

/** Walks part way, by (project, card, cycle, submission, target): only for as long as that history holds. */
const cursors = new Map<string, Cursor>()

/** For tests: the walks kept part way, forgotten (a restart). */
export function forgetCarriedWalks(): void {
  cursors.clear()
}

/** The newest merge into a target, by its row (0: none). */
const watermarkOf = (wf: Workflow, target: string): number => wf.store.integratedOn(target, Infinity, 1)[0]?.row ?? 0

/** Whether a queue merge into the target has begun and has no outcome yet (in flight, or waiting for its recovery). */
export function mergeInFlight(wf: Workflow, target: string): boolean {
  for (const f of wf.store.factsOfKind('IntegrationRequested')) {
    const d = f.data as FactData['IntegrationRequested']
    if (d.target !== target) continue
    if (wf.state(f.card).entries.some((e) => e.id === d.entry && e.state === 'started')) return true
  }
  return false
}

/**
 * Where the change of a card in Review came from: its latest submission (`revision` from `base`, its key) in its target.
 * `notContained`: it isn't in the target now (nothing to decide).
 */
export async function carriedProvenance(wf: Workflow, card: CardRecord, s: CardState): Promise<Provenance> {
  const project = wf.cfg.project
  const sub = s.latest
  const target = s.started?.target ?? ''
  if (!sub?.revision || !sub.base || !target) return DEFER_UNKNOWN
  const change = { base: sub.base, revision: sub.revision, key: sub.key }
  const head = await G.lineHead(project, target)
  if (isUnknown(head) || !head) return DEFER_UNKNOWN
  const now = await G.contains(project, target, change, head)
  if (isUnknown(now)) return DEFER_UNKNOWN
  if (!now) return { kind: 'notContained' }
  if (mergeInFlight(wf, target)) return DEFER_BUSY
  // The exact submission (its fact), not only its revision: a resubmission of the same code is another walk.
  const key = `${project.toLowerCase()}|${card.id}|${s.cycle}|${sub.id}|${sub.revision}|${sub.base}|${target}`
  const watermark = watermarkOf(wf, target)
  let cur = cursors.get(key)
  if (!cur || cur.snap.head !== head || cur.snap.watermark !== watermark) cur = { snap: { head, watermark }, below: Infinity }
  cursors.set(key, cur)
  const page = wf.store.integratedOn(target, cur.below, CARRIED_PAGE)
  for (const { row, fact } of page) {
    const d = fact.data
    // A merge is passed only once settled for it (HR1's round 1 finding 1): a deferral, or a read that throws, leaves
    // the cursor above it, so the next pass asks about it again rather than skip a carrier it couldn't read.
    const passed = (): void => void (cur.below = row)
    // Not a queue merge (an observed or reported one), nor the card's own: no `expected` to ask before.
    if (d.by !== 'combwork' || fact.card === card.id || !d.entry) {
      passed()
      continue
    }
    const started = wf.store.facts(fact.card).findLast((f) => f.kind === 'IntegrationStarted' && (f.data as FactData['IntegrationStarted']).entry === d.entry)?.data as FactData['IntegrationStarted'] | undefined
    if (!started) return DEFER_UNKNOWN
    const kept = await G.isAncestor(project, d.result, head)
    if (isUnknown(kept)) return DEFER_UNKNOWN
    if (!kept) {
      passed()
      continue
    }
    const before = await G.contains(project, target, change, started.expected)
    if (isUnknown(before)) return DEFER_UNKNOWN
    if (before) {
      passed()
      continue
    }
    const after = await G.contains(project, target, change, d.result)
    if (isUnknown(after)) return DEFER_UNKNOWN
    cursors.delete(key)
    if (after) return { kind: 'carried', by: wf.store.card(fact.card).key, entry: d.entry, snap: cur.snap }
    return { kind: 'outside', snap: cur.snap }
  }
  if (page.length === CARRIED_PAGE) return DEFER_MORE
  cursors.delete(key)
  return { kind: 'outside', snap: cur.snap }
}

/**
 * In the outcome's write: the card still on the exact submission (its fact, HR1's round 1 finding 3: a resubmission of
 * the same revision is another) and target the walk read, in its cycle, and the target's merges as they were (no newer
 * one, none in flight). The target's head is the caller's to check, read after its last await (reconcile).
 */
export function walkStillHolds(wf: Workflow, w: Write, s: CardState, snap: Snapshot): boolean {
  const now = w.state()
  const target = s.started?.target ?? ''
  return now.cycle === s.cycle && now.stage === 'review' && now.latest?.id === s.latest?.id && now.latest?.revision === s.latest?.revision && now.latest?.base === s.latest?.base && (now.started?.target ?? '') === target && watermarkOf(wf, target) === snap.watermark && !mergeInFlight(wf, target)
}
