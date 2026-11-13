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
//     either way, what jj ignores doesn't count (HI-3158, jjIgnoredEntries.ts);
//  6. the moment before the end boundary: still H1, the same checkout record and Git state (a plain Git commit or
//     checkout jj hasn't imported shows there), else `moved`;
//  7. the end boundary B2, strict (`expect: H1`): an operation by anyone since H1 is `moved`; anything it records is
//     `changed` (a raw write, an add, a delete or a rename the watcher missed);
//  8. the final moment, after B2, still B2's: the same head, checkout record and Git state as E1. Nothing is awaited
//     between this read and the decision.
// Unknown anywhere fails closed: the run doesn't count.
//
// A run in a check copy of its own (HI-2991: a candidate's merge checks, `scope: 'workspace'`) is credited by that
// copy's state, not the whole repository's operation head: another workspace's operation during the run (another lane's
// `jj commit`, the user's own jj) leaves it counted. Steps 3, 6, 7 and 8 then compare this workspace's checkout record
// (no jj command updated its working copy during the run) instead of the heads and Git's state; B2 takes no `expect`
// (it may find a newer head), and must record nothing, find the workspace not stale and its @ B1's. What an operation
// elsewhere could do to the copy shows there: jj rewriting its @ (the candidate or an ancestor rewritten) makes it stale
// or another @, and a write to its files is in the record or the snapshot. The revision is a commit id: what was tested
// can't change.

import { lstat, stat } from 'original-fs/promises'
import { join } from 'path'
import type { CheckRanData } from '../../shared/workflow/facts'
import type { FolderChanges, WriteLog } from './history'
import { jjBoundary, isRefused, type Boundary, type BoundaryOptions, type BoundaryRefused, type Owner, type StoreLock } from './jjBoundary'
import { jjRunner, type JjRunner } from './jjRunner'
import { isJjUnknown, JjReads, type JjCommit } from './jjReads'
import { snapshotLine } from './snapshotLine'
import { isAbsent, viewNow, type ViewNow, type ViewOf } from './jjView'
import { isUnknown, type Maybe } from './types'
import { foldersOf, ignoredByKind, ignoredOnly, jjEntries, RunWatch, type EntriesOf, type Kind, type WatchedNames } from './jjIgnoredEntries'

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
  /** HI-2991: `workspace`, a run in a copy of its own credited by that copy's state (the module's comment); else the repository's. */
  scope?: 'repository' | 'workspace'
}

/** What the start captured. */
export interface JjCheckStart {
  t0: number
  b1: Boundary | BoundaryRefused
  /** The revision read at H1 (its divergence and conflicts), when B1 was taken. */
  rev: JjCommit | null
  files: string[] | null
  stats: string | null
  /** HI-3158: the entries of the snapshot's folders, so a folder's line that moved only for entries jj ignores doesn't count. */
  entries?: EntriesOf | null
  /** HI-3158: the run's watches on those folders (what came and went during it); jjCheckEnd closes them. */
  watch?: RunWatch | null
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
  /** HI-3158: the snapshot's folders whose line moved only for entries jj ignores (jjIgnoredEntries.ts); they don't count. */
  ignoredOnly?: string[]
  beforeB2: ViewNow | null
  b2: Boundary | BoundaryRefused | null
  final: ViewNow | null
  /** The run's scope (absent: the repository's). */
  scope?: 'repository' | 'workspace'
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
 * shows), off main's thread; each line `snapshotLine`'s. A path that isn't there (deleted) is a "gone" line; one that
 * couldn't be stat'ed (access, I/O) makes the whole snapshot null, so it never equals another. Null when the list is.
 */
export async function jjStats(root: string, files: string[] | null): Promise<string | null> {
  if (!files) return null
  const all = [...files, ...foldersOf(files)]
  const out: string[] = Array.from({ length: all.length }, () => '')
  let next = 0
  let unreadable = false
  const worker = async (): Promise<void> => {
    while (next < all.length && !unreadable) {
      const i = next++
      const line = await stat(join(root, all[i])).then(
        (s) => snapshotLine(all[i], s),
        (e: unknown) => (isAbsent(e) ? snapshotLine(all[i], null) : null)
      )
      if (line === null) unreadable = true
      else out[i] = line
    }
  }
  await Promise.all(Array.from({ length: Math.min(STATS_AT_ONCE, all.length) }, worker))
  return unreadable ? null : out.join('\n')
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
  // HI-3158: the snapshot's folders watched from before the snapshot until the end (jjIgnoredEntries.ts).
  const watch = listed ? RunWatch.start(r.view.root, foldersOf(listed)) : null
  try {
    const stats = await jjStats(r.view.root, listed)
    const entries = listed && stats !== null ? await jjEntries(r.view.root, foldersOf(listed)) : null
    const e1 = viewNow(r.view)
    await s.hooks?.started?.()
    // The boundary's own writes are in the record before t0: they never count against the run.
    await log.settled(r.folder)
    await watch?.armed()
    return { t0: now(), b1, rev: isJjUnknown(rev) ? null : rev, files: listed, stats, entries, watch, e1 }
  } catch (e) {
    watch?.close()
    throw e
  }
}

/** The run's end (steps 5–8): everything jjCredit decides from. */
export async function jjCheckEnd(r: JjCheckFor, start: JjCheckStart, log: WriteLog, s: JjCheckSeams = {}): Promise<JjCheckRecord> {
  const runner = s.runner ?? jjRunner
  const now = s.now ?? Date.now
  const scope = r.scope === 'workspace' ? { scope: 'workspace' as const } : {}
  if (isRefused(start.b1) || start.b1.recorded || !start.e1) {
    start.watch?.close()
    return { revision: r.revision, start, t1: now(), seen: { changed: false, paths: [] }, statsEnd: undefined, beforeB2: null, b2: null, final: null, ...scope }
  }
  let explained: string[] | null = null
  let seen: Maybe<FolderChanges>
  let statsEnd: string | null | undefined
  let t1: number
  try {
    await s.hooks?.beforeEnd?.()
    // The run's writes reach the record after they happen: it settles first, and the window ends after that (nothing of
    // Combwork's writes in between: the end boundary comes after), so a write just before the command ended is in it.
    await log.settled(r.folder)
    t1 = now()
    // The run's watches settle before the end boundary, whose own writes (in `.jj`) they'd otherwise see; only when a
    // filter below asks (a settle waits for quiet).
    let settled: Promise<WatchedNames | null> | undefined
    const watched = (): Promise<WatchedNames | null> => (settled ??= start.watch ? start.watch.settle() : Promise.resolve(null))
    seen = await withoutIgnored(r.view.root, start.files, start.entries ?? null, await log.changedBetween(r.folder, start.t0, t1, jjCounts), watched)
    statsEnd = isUnknown(seen) ? await jjStats(r.view.root, start.files) : undefined
    const moved = statsEnd && start.files ? movedFolders(start, statsEnd) : []
    if (moved.length && start.files) explained = await ignoredOnly(r.view.root, moved, { files: start.files, before: start.entries ?? null, watched: await watched() })
  } finally {
    start.watch?.close()
  }
  const base = { revision: r.revision, start, t1, ...scope }
  const beforeB2 = viewNow(r.view)
  // A copy's run takes B2 at whatever head there is now (HI-2991); the repository's only at H1.
  const b2 = await jjBoundary({ ...r.view, folder: r.folder }, r.owner, { ...s.boundary, lock: r.lock, hooks: s.boundary?.endHooks, ...(r.scope === 'workspace' ? {} : { expect: start.b1.op }) }, runner)
  await s.hooks?.beforeFinal?.()
  const final = viewNow(r.view)
  return { ...base, seen, statsEnd, ...(explained ? { ignoredOnly: explained } : {}), beforeB2, b2, final }
}

const slashes = (p: string): string => p.replace(/\\/g, '/')

/**
 * HI-3158: a write record's paths less those jj ignores (Git's own record filters with check-ignore; jj's is narrowed by
 * jjCounts alone), the record's paths being the workspace's (a colocated slot's record is its own folder's, HI-3160).
 * Where Git can't say, the record stands as it is. The revision's own files are never asked: they count.
 *
 * A path is ignored only as every kind it may have had during the run, asked by kind (ignoredByKind), never by what is
 * on disk now: a folder-only rule (`out/`) mustn't cover a file `out` the run read and replaced with a folder (HR2's
 * round 2 on HI-3158). Its kinds: those the run's watch saw in its folder and the start's listing of it had (as
 * ignoredOnly reads them); a folder where the record has paths under it (a deleted `__pycache__/`); what it is on disk
 * now; and a file too where its folder wasn't both listed and watched, or none of those says. Unreadable: it counts.
 */
async function withoutIgnored(root: string, tracked: string[] | null, before: EntriesOf | null, seen: Maybe<FolderChanges>, settled: () => Promise<WatchedNames | null>): Promise<Maybe<FolderChanges>> {
  if (isUnknown(seen) || !seen.changed || !tracked) return seen
  // The revision's own files always count, whatever a rule says (a tracked file under an ignored folder).
  const mine = new Set(tracked)
  const rels = new Set(seen.paths.filter((p) => !p.startsWith(':') && !mine.has(slashes(p))).map(slashes))
  if (!rels.size) return seen
  const watched = await settled()
  const parents = new Set<string>()
  for (const p of rels) for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) parents.add(p.slice(0, i))
  const forms = new Map<string, string[]>()
  for (const p of rels) {
    const i = p.lastIndexOf('/')
    const folder = i < 0 ? '.' : p.slice(0, i)
    const name = p.slice(i + 1)
    const inFolder = watched?.get(folder)
    const listed = before?.get(folder)
    const kinds = new Set<Kind>(inFolder?.get(name) ?? [])
    const was = listed?.get(name)
    if (was) kinds.add(was === '?' ? '?' : was.startsWith('d:') ? 'd' : 'f')
    if (parents.has(p)) kinds.add('d')
    const onDisk = await kindOnDisk(join(root, p))
    if (onDisk) kinds.add(onDisk)
    if (!inFolder || !listed || !kinds.size) kinds.add('f')
    if (kinds.has('?')) continue
    forms.set(p, [...(kinds.has('d') ? [`${p}/`] : []), ...(kinds.has('f') ? [p] : [])])
  }
  const ignored = await ignoredByKind(root, [...forms.values()].flat())
  if (!ignored) return seen
  const isIgnored = (p: string): boolean => forms.get(p)?.every((f) => ignored.has(f)) ?? false
  const paths = seen.paths.filter((p) => !rels.has(slashes(p)) || !isIgnored(slashes(p)))
  return { changed: paths.length > 0, paths }
}

/** What is at a path now: a folder, something else, nothing (null), or '?' when that can't be told. */
async function kindOnDisk(path: string): Promise<Kind | null> {
  try {
    return (await lstat(path)).isDirectory() ? 'd' : 'f'
  } catch (e) {
    return isAbsent(e) ? null : '?'
  }
}

/** The snapshot's lines, the revision's files' first, then their folders' (jjStats' order), each with its path and kind. */
const linesOf = (files: string[]): { path: string; folder: boolean }[] => [...files.map((path) => ({ path, folder: false })), ...foldersOf(files).map((path) => ({ path, folder: true }))]

/** The lines that differ between the start's snapshot and the end's; null when they can't be lined up. */
function movedLines(start: JjCheckStart, statsEnd: string): { path: string; folder: boolean }[] | null {
  if (!start.files || start.stats === null) return null
  const a = start.stats.split('\n')
  const b = statsEnd.split('\n')
  const lines = linesOf(start.files)
  if (a.length !== lines.length || b.length !== lines.length) return null
  return lines.filter((l, i) => a[i] !== b[i])
}

/** The folders whose line moved, where only folders' lines did (a file's line moving leaves nothing to explain). */
function movedFolders(start: JjCheckStart, statsEnd: string): string[] {
  const moved = movedLines(start, statsEnd)
  return !moved || moved.some((l) => !l.folder) ? [] : moved.map((l) => l.path)
}

/** The snapshots are the same but for the folders' lines jjCheckEnd found moved only by entries jj ignores. */
function sameStats(rec: JjCheckRecord): boolean {
  const { start, statsEnd } = rec
  if (statsEnd === undefined || statsEnd === null || start.stats === null) return false
  if (statsEnd === start.stats) return true
  const ok = new Set(rec.ignoredOnly ?? [])
  const moved = movedLines(start, statsEnd)
  return !!moved && moved.every((l) => l.folder && ok.has(l.path))
}

/** The same moment, field by field: head, checkout record, Git state. */
const sameMoment = (a: ViewNow | null, b: ViewNow | null): boolean => !!a && !!b && a.head === b.head && a.checkout.op === b.checkout.op && a.checkout.workspace === b.checkout.workspace && a.git === b.git

/** HI-2991, a copy's run: the same checkout record of this workspace (its op and name), whatever the heads did. */
const sameCheckout = (a: ViewNow | null, b: ViewNow | null): boolean => !!a && !!b && a.checkout.op === b.checkout.op && a.checkout.workspace === b.checkout.workspace

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
  // A new file jj left out for its size (HI-2973): on disk beside the revision's tree, so the run is `dirty`.
  if (isRefused(b1) && b1.refused === 'tooLarge') return no('dirty', 'start:tooLarge', '', b1.files)
  if (isRefused(b1)) return no(b1.refused === 'moved' || b1.refused === 'stale' ? 'moved' : 'changed', `start:${b1.refused}`)
  if (b1.recorded) return no('dirty', 'start:recorded', b1.at.commit)
  const tested = testedFor(rec.revision, b1.at, start.rev)
  if (!tested) return no('notContained', 'tested', b1.at.commit)
  const H1 = b1.op
  // The copy's own state (HI-2991), or the repository's moment.
  const local = rec.scope === 'workspace'
  const same = local ? sameCheckout : sameMoment
  if (!start.files || start.stats === null || !same(b1.view, start.e1)) return no('changed', 'start:evidence', tested)
  if (!same(start.e1, rec.beforeB2)) return no('moved', 'end:beforeBoundary', tested)
  const b2 = rec.b2
  if (!b2) return no('changed', 'end:noBoundary', tested)
  if (isRefused(b2)) return no(b2.refused === 'moved' || b2.refused === 'stale' ? 'moved' : 'changed', `end:${b2.refused}`, tested, b2.files)
  if (!local && b2.before !== H1) return no('moved', 'end:before', tested)
  if (b2.recorded) return no('changed', 'end:recorded', tested)
  if (!local && b2.op !== H1) return no('moved', 'end:op', tested)
  if (b2.at.commit !== b1.at.commit) return no('changed', 'end:at', tested)
  // A copy's B2 brings its checkout record to the head it found (an empty snapshot does): the same workspace, and the
  // record unchanged from B2's to the final read.
  if (local ? b2.checkout.workspace !== b1.checkout.workspace || !sameCheckout(b2.view, rec.final) : !sameMoment(start.e1, b2.view) || !sameMoment(b2.view, rec.final)) return no('moved', 'end:final', tested)
  if (isUnknown(rec.seen)) {
    if (!sameStats(rec)) return no('changed', 'end:stats', tested)
  } else if (rec.seen.changed) return no('changed', 'end:written', tested, rec.seen.paths)
  return { revision: rec.revision, tested }
}

/**
 * Whether a pass on one revision carries to another (R3.1, R3.2): the same commit id, or the same change by content
 * (`sameChange`: Git's replay on the Git-backed store, §16.3.2), and never because the change ids are equal. A divergent
 * or conflicted revision on either side never carries.
 */
export async function jjSameRevision(a: { base: string; commit: JjCommit }, b: { base: string; commit: JjCommit }, sameChange: (a: { base: string; revision: string }, b: { base: string; revision: string }) => Promise<boolean>): Promise<boolean> {
  // The flags first: a reviewed commit can become one variant of a divergent change keeping its exact id (or be read now
  // storing conflicts), and then even the same id carries nothing.
  if (a.commit.divergent || b.commit.divergent || a.commit.conflict || b.commit.conflict) return false
  if (a.commit.commit === b.commit.commit) return true
  return sameChange({ base: a.base, revision: a.commit.commit }, { base: b.base, revision: b.commit.commit })
}
