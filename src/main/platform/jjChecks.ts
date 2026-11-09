// A check run's bracket on jj (SPEC §16.3.6 port 3 and §16.13, HI-2796's J3): what the run is credited for, decided by a
// pure function (`jjCredit`) from what was captured around it, in this order:
//  1. the start boundary B1 (jjBoundary.ts: a snapshot, its owner checked): anything it recorded means the files on disk
//     weren't the workspace's @, so the run is `dirty`;
//  2. what was tested: B1's @ is the revision, or an empty @ whose one parent is (jj's state after `jj commit`), so the
//     files on disk are the revision's tree; anything else, or a divergent or conflicted revision, is `notContained`.
//     Equal change ids count for nothing (R3.1);
//  3. the start evidence E1, all at B1's operation H1: the revision's files (jj's list at H1), their stat snapshot (and
//     their folders', off main's thread), and the moment (heads, checkout record, colocated Git state) still B1's;
//  4. t0, after the write record has settled; the command runs; t1, once the record has settled again;
//  5. the write record for [t0, t1] (an edit and its undo show), and where it isn't complete, the stat snapshot again;
//  6. the moment before the end boundary: still H1, the same checkout record and Git state (a plain Git commit or
//     checkout jj hasn't imported shows there), else `moved`;
//  7. the end boundary B2, strict (`expect: H1`): an operation by anyone since H1 is `moved`; anything it records is
//     `changed` (a raw write, an add, a delete or a rename the watcher missed);
//  8. the final moment, after B2, still B2's: the same head, checkout record and Git state as E1. Nothing is awaited
//     between this read and the decision.
// Unknown anywhere fails closed: the run doesn't count.

import { stat } from 'original-fs/promises'
import { join } from 'path'
import type { CheckRanData } from '../../shared/workflow/facts'
import type { FolderChanges, WriteLog } from './history'
import { jjBoundary, isRefused, type Boundary, type BoundaryOptions, type BoundaryRefused, type Owner, type StoreLock } from './jjBoundary'
import { jjRunner, type JjRunner } from './jjRunner'
import { isJjUnknown, JjReads, type JjCommit } from './jjReads'
import { snapshotLine } from './snapshotLine'
import { viewNow, type ViewNow, type ViewOf } from './jjView'
import { isUnknown, type Maybe } from './types'

/** What a jj check run is for. */
export interface JjCheckFor {
  view: ViewOf
  /** The folder the run is in (the workspace's root or below it). */
  folder: string
  /** The card's revision, a full commit id (never a change id). */
  revision: string
  owner: Owner
  /** The store's repository lock the boundaries take. */
  lock: StoreLock
}

/** What the start captured. */
export interface JjCheckStart {
  t0: number
  b1: Boundary | BoundaryRefused
  /** The revision read at H1 (its divergence and conflicts), when B1 was taken. */
  rev: JjCommit | null
  files: string[] | null
  stats: string | null
  e1: ViewNow | null
}

/** Everything a run's credit is decided from. */
export interface JjCheckRecord {
  revision: string
  start: JjCheckStart
  t1: number
  seen: Maybe<FolderChanges>
  /** The stat snapshot at the end, read only where the write record wasn't complete. */
  statsEnd: string | null | undefined
  beforeB2: ViewNow | null
  b2: Boundary | BoundaryRefused | null
  final: ViewNow | null
}

/** What a jj run is credited with: CheckBracket's fields. */
export interface JjCredit {
  revision: string
  tested: string
  whyNot?: CheckRanData['whyNot']
  /** The step that decided it, for the log and the tests (a protocol code). */
  why?: string
  changes?: string[]
}

/** Seams for the tests: the runner, barriers, the clock. */
export interface JjCheckSeams {
  runner?: JjRunner
  boundary?: Pick<BoundaryOptions, 'signal' | 'timeout'> & { startHooks?: BoundaryOptions['hooks']; endHooks?: BoundaryOptions['hooks'] }
  now?: () => number
  /** After E1 and before t0; after t1 and before the write record is asked. */
  hooks?: { started?: () => Promise<void> | void; beforeEnd?: () => Promise<void> | void; beforeFinal?: () => Promise<void> | void }
}

/** Files stat'ed at once (checks.ts' snapshot's bound). */
const STATS_AT_ONCE = 8

/** jj's and Git's own folders: never part of what a run's write record or snapshot counts. */
const internal = (p: string): boolean => /^(\.jj|\.git)([\\/]|$)/.test(p)

/** What counts in a jj workspace's write record: every path but jj's and Git's own folders (`:edit` and `:reflog` too). */
export const jjCounts = (paths: string[]): string[] => paths.filter((p) => !internal(p))

/**
 * The stat snapshot of a revision's files under the workspace's root, and of their folders (a file made beside them
 * shows), off main's thread; each line `snapshotLine`'s. Null when the list is null.
 */
export async function jjStats(root: string, files: string[] | null): Promise<string | null> {
  if (!files) return null
  const dirs = new Set<string>(['.'])
  for (const f of files) {
    const i = f.lastIndexOf('/')
    if (i > 0) for (let d = f.slice(0, i); d; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') dirs.add(d)
  }
  const all = [...files, ...[...dirs].sort()]
  const out: string[] = Array.from({ length: all.length }, () => '')
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < all.length) {
      const i = next++
      out[i] = await stat(join(root, all[i])).then(
        (s) => snapshotLine(all[i], s),
        () => snapshotLine(all[i], null)
      )
    }
  }
  await Promise.all(Array.from({ length: Math.min(STATS_AT_ONCE, all.length) }, worker))
  return out.join('\n')
}

/** The run's start (steps 1–4). */
export async function jjCheckStart(r: JjCheckFor, log: WriteLog, s: JjCheckSeams = {}): Promise<JjCheckStart> {
  const runner = s.runner ?? jjRunner
  const now = s.now ?? Date.now
  await log.settled(r.folder)
  const w = { ...r.view, folder: r.folder }
  const b1 = await jjBoundary(w, r.owner, { ...s.boundary, lock: r.lock, hooks: s.boundary?.startHooks }, runner)
  const none = { rev: null, files: null, stats: null, e1: null }
  if (isRefused(b1) || b1.recorded) return { t0: now(), b1, ...none }
  const reads = new JjReads({ folder: r.folder, jjRepo: r.view.jjRepo }, runner, { signal: s.boundary?.signal, timeout: s.boundary?.timeout })
  const rev = await reads.commitAt(b1.op, r.revision)
  const files = await reads.filesAt(b1.op, r.revision)
  const listed = isJjUnknown(files) ? null : files
  const stats = await jjStats(r.view.root, listed)
  const e1 = viewNow(r.view)
  await s.hooks?.started?.()
  // The boundary's own writes are in the record before t0: they never count against the run.
  await log.settled(r.folder)
  return { t0: now(), b1, rev: isJjUnknown(rev) ? null : rev, files: listed, stats, e1 }
}

/** The run's end (steps 5–8): everything jjCredit decides from. */
export async function jjCheckEnd(r: JjCheckFor, start: JjCheckStart, log: WriteLog, s: JjCheckSeams = {}): Promise<JjCheckRecord> {
  const runner = s.runner ?? jjRunner
  const now = s.now ?? Date.now
  if (isRefused(start.b1) || start.b1.recorded || !start.e1) return { revision: r.revision, start, t1: now(), seen: { changed: false, paths: [] }, statsEnd: undefined, beforeB2: null, b2: null, final: null }
  await s.hooks?.beforeEnd?.()
  // The run's writes reach the record after they happen: it settles first, and the window ends after that (nothing of
  // Combwork's writes in between: the end boundary comes after), so a write just before the command ended is in it.
  await log.settled(r.folder)
  const t1 = now()
  const base = { revision: r.revision, start, t1 }
  const seen = await log.changedBetween(r.folder, start.t0, t1, jjCounts)
  const statsEnd = isUnknown(seen) ? await jjStats(r.view.root, start.files) : undefined
  const beforeB2 = viewNow(r.view)
  const b2 = await jjBoundary({ ...r.view, folder: r.folder }, r.owner, { ...s.boundary, lock: r.lock, hooks: s.boundary?.endHooks, expect: start.b1.op }, runner)
  await s.hooks?.beforeFinal?.()
  const final = viewNow(r.view)
  return { ...base, seen, statsEnd, beforeB2, b2, final }
}

/** The same moment, field by field: head, checkout record, Git state. */
const sameMoment = (a: ViewNow | null, b: ViewNow | null): boolean => !!a && !!b && a.head === b.head && a.checkout.op === b.checkout.op && a.checkout.workspace === b.checkout.workspace && a.git === b.git

/**
 * What tested the revision: B1's @ is it, or an empty @ whose one parent is it (the files on disk are its tree). Null
 * otherwise, or where @ or the revision is divergent or stores conflicts.
 */
export function testedFor(revision: string, at: JjCommit, rev: JjCommit | null): string | null {
  if (!rev || rev.commit !== revision || rev.divergent || rev.conflict || at.divergent || at.conflict) return null
  if (at.commit === revision) return revision
  if (at.empty && at.parents.length === 1 && at.parents[0] === revision) return revision
  return null
}

/** Decides a run's credit from its record (pure; see the module's comment for the order). */
export function jjCredit(rec: JjCheckRecord): JjCredit {
  const { start } = rec
  const no = (whyNot: NonNullable<CheckRanData['whyNot']>, why: string, tested = '', changes?: string[]): JjCredit => ({ revision: rec.revision, tested, whyNot, why, ...(changes?.length ? { changes: [...new Set(changes)].slice(0, 5) } : {}) })
  const b1 = start.b1
  if (isRefused(b1)) return no(b1.refused === 'moved' || b1.refused === 'stale' ? 'moved' : 'changed', `start:${b1.refused}`)
  if (b1.recorded) return no('dirty', 'start:recorded', b1.at.commit)
  const tested = testedFor(rec.revision, b1.at, start.rev)
  if (!tested) return no('notContained', 'tested', b1.at.commit)
  const H1 = b1.op
  if (!start.files || start.stats === null || !sameMoment(b1.view, start.e1)) return no('changed', 'start:evidence', tested)
  if (!sameMoment(start.e1, rec.beforeB2)) return no('moved', 'end:beforeBoundary', tested)
  const b2 = rec.b2
  if (!b2) return no('changed', 'end:noBoundary', tested)
  if (isRefused(b2)) return no(b2.refused === 'moved' || b2.refused === 'stale' ? 'moved' : 'changed', `end:${b2.refused}`, tested)
  if (b2.before !== H1) return no('moved', 'end:before', tested)
  if (b2.recorded) return no('changed', 'end:recorded', tested)
  if (b2.op !== H1) return no('moved', 'end:op', tested)
  if (b2.at.commit !== b1.at.commit) return no('changed', 'end:at', tested)
  if (!sameMoment(start.e1, b2.view) || !sameMoment(b2.view, rec.final)) return no('moved', 'end:final', tested)
  if (isUnknown(rec.seen)) {
    if (rec.statsEnd === undefined || rec.statsEnd === null || rec.statsEnd !== start.stats) return no('changed', 'end:stats', tested)
  } else if (rec.seen.changed) return no('changed', 'end:written', tested, rec.seen.paths)
  return { revision: rec.revision, tested }
}

/**
 * Whether a pass on one revision carries to another (R3.1, R3.2): the same commit id, or the same change by content
 * (`sameChange`: Git's replay on the Git-backed store, §16.3.2), and never because the change ids are equal. A divergent
 * or conflicted revision on either side never carries.
 */
export async function jjSameRevision(a: { base: string; commit: JjCommit }, b: { base: string; commit: JjCommit }, sameChange: (a: { base: string; revision: string }, b: { base: string; revision: string }) => Promise<boolean>): Promise<boolean> {
  if (a.commit.commit === b.commit.commit) return true
  if (a.commit.divergent || b.commit.divergent || a.commit.conflict || b.commit.conflict) return false
  return sameChange({ base: a.base, revision: a.commit.commit }, { base: b.base, revision: b.commit.commit })
}
