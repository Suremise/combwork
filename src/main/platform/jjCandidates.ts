// jj's merge-queue candidates (SPEC §16.3.6 port 4, HI-2797's J4; its design HI-2797/s11, s14 and s17). Under decision A
// (HI-2794, Darren 9 Nov) Combwork never advances a jj target: the user integrates. What this builds is the candidate the
// user integrates: the reviewed change rebased, squashed or merged onto the target's head as private new commits, its
// conflict state read (never taken from an exit code: a conflicted `jj duplicate` or `jj new` exits 0, probed on
// 0.47.1), its evidence kept, and the builder's change, workspace and bookmarks untouched. Unregistered, like J2's and
// J3's modules: jj has no `integration` capability and no queue reaches this yet; the composition that offers a candidate
// to the user (J5's containment record, J6's view) injects what it needs.
//
// How each guarantee is kept:
// - Private: rebase duplicates the reviewed suffix (`jj duplicate --onto`: new change ids, so a later amend by the builder
//   never rebases the candidate), squash builds a scratch merge and restores its tree into a fresh child of the target,
//   merge is a fresh merge commit (the reviewed commit only a parent). Nothing rewrites a commit the attempt didn't make.
// - Every jj write runs from a folder whose working copy it never touches (`--ignore-working-copy`; J2's control
//   workspace), under the store's lock, the owner checked just before it, carrying the attempt's marker
//   (`combwork.txn`, J1's), and is validated after it: one head, whose one parent is the head read just before; the
//   marker in its args; its view the parent's but for this attempt's commits (added, or abandoned); bookmarks, tags and
//   every workspace's @ unchanged; Git's refs unchanged but for jj's own keep refs of exactly the commits it added or
//   abandoned. Anything else is `raced`, and nothing more is written.
// - Phases are journalled before the step they name (planned, writing, written, pinning, pinned, abandoning, abandoned,
//   done). Every commit the attempt made is pinned (a Git ref in the backing store, create-only, read back) before any of
//   them is abandoned, so evidence is never unreachable. A pin is owned only when the journal records its own create
//   succeeding; a ref found there first is a collision, never owned, never touched.
// - Abandoning is guarded by its revset, evaluated by jj at the operation the command loads: a commit with a descendant
//   outside the attempt's set, or a bookmark, tag or working copy on it or above it, is kept with its ancestors in the set,
//   so no surviving commit is rebased. Kept ones stay pinned and the outcome is `interrupted`.
// - Residual (written in SPEC): an operation started from the same base operation as one of ours. jj 0.47.1 has no
//   conditional operation (J1's finding (a)); it shows as `raced` (two heads, or a parent other than the head read),
//   is reported, and nothing more is written.

import { CONFLICT_LIMITS, parseConflicts, type ConflictFile, type ConflictsRecord } from '../../shared/workflow/conflicts'
import { say } from '../../shared/agentText'
import { CANDIDATE_TEXT, UPDATE_NOT_SAME } from './candidateText'
import type { CandidateFail, CandidateTestFail } from './integration'
import type { Owner, StoreLock } from './jjBoundary'
import { jjSameRevision } from './jjChecks'
import { isJjUnknown, JjReads, jjUnknown, parseCommitLine, type JjCommit, type JjMaybe, type JjReadUnknown } from './jjReads'
import type { JjRunner } from './jjRunner'
import { COMMIT_ID, readOpHeads, type ViewOf } from './jjView'
import type { RunResult } from './repoContext'

export type JjCandidateStyle = 'rebase' | 'squash' | 'merge'

/** The phases of an attempt, each journalled before the step it names. */
export type JjAttemptPhase = 'planned' | 'writing' | 'written' | 'pinning' | 'pinned' | 'abandoning' | 'abandoned' | 'done' | 'dropped'

/**
 * One pin's journal entry: the ref and the commit it is meant to hold, and what came of its create. `created` only when
 * the attempt's own create-only `update-ref` succeeded and the ref read back exactly `oid`; `collision` when the ref was
 * there first (`found`: what it held), never owned; `intent` with no outcome yet (a crash between the create and the
 * journal: ambiguous to recovery, never owned); `dropped` once its exact-old delete succeeded.
 */
export interface JjPin {
  ref: string
  oid: string
  state: 'intent' | 'created' | 'collision' | 'dropped'
  found?: string
}

/** An attempt's durable record (its caller keeps it, as J2's journals: board_meta in Combwork, memory in tests). */
export interface JjAttemptRecord {
  attempt: string
  card: string
  style: JjCandidateStyle
  revision: string
  base: string
  expected: string
  phase: JjAttemptPhase
  /** The single operation head when the attempt was planned: recovery's walk must reach it. */
  baseOp: string
  /** This attempt's validated operations, in order. */
  ops: string[]
  /** Every commit this attempt's validated operations added, in order (owned: the only commits it may pin or abandon). */
  commits: string[]
  /** The candidate's commit (the duplicates' head, the squash, the merge). */
  result?: string
  /**
   * How a finished attempt ended, written with its `done`: a candidate, an update (strict's, HI-2853), or the failure
   * that returns the card. Only a `candidate` record can credit containment (J5, HI-2798/s14 §2′); a done record without
   * it is never one.
   */
  outcome?: 'candidate' | 'updated' | 'conflict' | 'notUpToDate' | 'notSame'
  /** A candidate (absent: one, as every record before HI-2853) or strict's update; an update never credits by itself. */
  kind?: 'candidate' | 'update'
  /** An update's way: the target merged into the reviewed revision, or the revision rebased onto it. */
  how?: 'merge' | 'rebase'
  /**
   * A merge or squash candidate built on an update (HI-2853/s10): the update attempt and its result. Only candidates
   * carry it (an update is a leaf); a rebase candidate ignores an update and never records one.
   */
  updated?: { attempt: string; result: string }
  pins: JjPin[]
  abandoned?: string[]
  kept?: string[]
  /**
   * The write under way, journalled before its command runs: its name, the head it was started from, and what it may make.
   * Recovery validates a marked operation against it before taking its commits as the attempt's.
   */
  step?: { name: string; parent: string; shape: JjStep }
  /**
   * Commits a marked operation added that recovery couldn't validate as this attempt's own step (another parent, a side
   * effect, another shape: e.g. an outside descendant jj rebased). Never owned, never pinned or abandoned by the attempt;
   * while any are recorded, drop refuses.
   */
  uncertain?: string[]
  /**
   * HI-2992: steps recovery gave up (interrupted mid-write, the base operation past its walk): whatever such a write made
   * isn't the attempt's, never owned or touched; the rest of the attempt is recovered and dropped as ever.
   */
  givenUp?: string[]
}

/** What one write may make: its shape, checked against the operation's delta (shapeProblem). */
export type JjStep =
  | { kind: 'duplicate'; n: number; onto: string }
  | { kind: 'new'; parents: string[] }
  | { kind: 'restore'; into: string; change: string; parent: string }
  | { kind: 'abandon'; will: string[] }

/** Why a delta isn't the shape its step may make (null: it is). Pure: the caller read the delta at the operation. */
export function shapeProblem(step: JjStep, d: { added: readonly JjCommit[]; removed: readonly string[] }): string | null {
  switch (step.kind) {
    case 'duplicate': {
      if (d.removed.length || d.added.length !== step.n) return 'shape'
      const ids = new Set(d.added.map((c) => c.commit))
      const roots = d.added.filter((c) => !c.parents.some((x) => ids.has(x)))
      const named = new Set(d.added.flatMap((c) => c.parents))
      const heads = d.added.filter((c) => !named.has(c.commit))
      return roots.length === 1 && heads.length === 1 && roots[0].parents.join() === step.onto ? null : 'shape'
    }
    case 'new':
      return !d.removed.length && d.added.length === 1 && d.added[0].parents.join() === step.parents.join() ? null : 'shape'
    case 'restore':
      return d.removed.join() === step.into && d.added.length === 1 && d.added[0].parents.join() === step.parent && d.added[0].change === step.change ? null : 'shape'
    case 'abandon':
      return !d.added.length && sameSet(d.removed, step.will) ? null : 'shape'
  }
}

/** Why an attempt stopped short: never a candidate, a retained-evidence failure, or anything to act on but recovery. */
export type JjInterruptWhy = 'owner' | 'cancelled' | 'raced' | 'heads' | 'failed' | 'malformed' | 'pin' | 'kept' | 'tool' | 'gone' | 'uncertain'

export interface JjInterrupted {
  interrupted: { attempt: string; phase: JjAttemptPhase; why: JjInterruptWhy; detail?: string; commits: string[]; refs: string[]; kept?: string[] }
  record: JjAttemptRecord
}

/** A candidate: its commit, every commit the attempt made that stays, and its owned pins. */
export interface JjCandidate {
  candidate: { result: string; commits: string[]; change: string; op: string; refs: string[] }
  record: JjAttemptRecord
}

/** A candidate that returns the card: a conflict (its files and hunks), not on top, a merge commit, or not the same change. */
export type JjCandidateFail = CandidateTestFail & { evidence: string[]; refs: string[]; record: JjAttemptRecord }

export type JjCandidateOutcome = JjCandidate | JjCandidateFail | { pause: 'signing'; message: string } | JjInterrupted | JjReadUnknown

export const isInterrupted = (o: unknown): o is JjInterrupted => !!o && typeof o === 'object' && 'interrupted' in o
export const isCandidate = (o: unknown): o is JjCandidate => !!o && typeof o === 'object' && 'candidate' in o

/** Where a test pauses an attempt, with its record as it stands. */
export type JjCandidatePoint =
  | 'planned'
  | `beforeWrite:${string}`
  | `run:${string}`
  | `afterWrite:${string}`
  | 'written'
  | `beforePin:${string}`
  | `afterPin:${string}`
  | 'pinned'
  | `beforeAbandon:${string}`
  | 'abandoned'
  | `beforeDelete:${string}`

/** What an attempt needs: jj and Git on the store, the folder its writes run from, the lock, the owner and the journal. */
export interface JjCandidateDeps {
  runner: JjRunner
  view: Pick<ViewOf, 'jjRepo' | 'store'>
  /** Where jj runs (J2's control workspace): every write ignores its working copy. */
  folder: string
  /** `git --git-dir <store>`, writes included (only the attempt's own pins). */
  git: (args: readonly string[]) => Promise<RunResult>
  lock: StoreLock
  owner: Owner
  /** Durable before the step the record's phase names. */
  journal: (r: JjAttemptRecord) => Promise<void> | void
  /** §16.3.2's replay on the Git-backed store (Git's `sameChange`): the rebase's sameness. */
  sameChange: (a: { base: string; revision: string }, b: { base: string; revision: string }) => Promise<boolean>
  /** The identity the attempt's commits are made with (the project's); jj's own config when absent. */
  identity?: { name: string; email: string } | null
  signal?: AbortSignal
  timeout?: number
  hook?: (point: JjCandidatePoint, r: JjAttemptRecord) => Promise<void> | void
  /** How many operations recovery's walk reads at most (default OPS_WALK_MAX, HI-2992): past it, a step under way is given up. */
  opsLimit?: number
  /** How many operations the walk reads a page (default OPS_PAGE; the tests' seam). */
  opsPage?: number
}

export interface JjCandidateRequest {
  card: string
  /** A fresh token per attempt ([a-z0-9], 6–40): its pins' prefix and its operations' marker. */
  attempt: string
  revision: string
  base: string
  /** The target's head the candidate is built on (as tested). */
  expected: string
  style: JjCandidateStyle
  /** A squash's or a merge's description. */
  message: string
  /**
   * Strict's update this candidate is built on (merge and squash; a rebase ignores it): the update's record from the
   * card's journal, validated before anything is written (`validUpdate`); invalid, the candidate is refused unwritten.
   */
  updated?: JjAttemptRecord
}

/** Strict's update (G8, HI-2853): the reviewed revision brought up to date with the target's head as private commits. */
export interface JjUpdateRequest {
  card: string
  attempt: string
  revision: string
  base: string
  /** The target's head it is brought up to date with. */
  expected: string
  how: 'merge' | 'rebase'
  /** A merge's description. */
  message: string
}

/** An update that returns the card: a conflict, or not the same change, with its evidence. */
export type JjUpdateFail = CandidateFail & { evidence: string[]; refs: string[]; record: JjAttemptRecord }

export type JjUpdateOutcome = { updated: string; record: JjAttemptRecord } | { updated: null } | JjUpdateFail | { pause: 'signing'; message: string } | JjInterrupted | JjReadUnknown

/** What an update must be to be built on or credited (HI-2853/s10 §2): its reviewed input, target, attempt and result. */
export interface UpdateWanted {
  card: string
  revision: string
  base: string
  expected: string
  attempt: string
  result?: string
}

/**
 * Whether a record is a finished update for exactly this input (HI-2853/s10 §2), its result pin read now: true, or why
 * not (a code), or unknown when the pin can't be read. Run before a candidate is built on it and again when J5 credits
 * the chain. An update is a leaf; a record of no kind is a candidate and never an update.
 */
export async function validUpdate(git: (args: readonly string[]) => Promise<RunResult>, u: JjAttemptRecord | undefined, want: UpdateWanted): Promise<true | string | JjReadUnknown> {
  if (!u) return 'missing'
  if (u.kind !== 'update' || u.phase !== 'done' || u.outcome !== 'updated') return 'notUpdated'
  if (u.step || u.uncertain?.length || u.updated) return 'unsettled'
  if (u.card !== want.card || u.attempt !== want.attempt) return 'foreign'
  if (u.revision !== want.revision || u.base !== want.base) return 'input'
  if (u.expected !== want.expected) return 'expected'
  if (!u.result || !COMMIT_ID.test(u.result) || (want.result !== undefined && u.result !== want.result)) return 'result'
  const pin = u.pins.find((p) => p.state === 'created' && p.ref === `${pinPrefix(u.card, u.attempt)}candidate`)
  if (!pin || pin.oid !== u.result) return 'unpinned'
  const r = await git(['for-each-ref', '--format=%(objectname) %(refname)', pin.ref])
  if (!r.ok) return jjUnknown('failed', r.err)
  const m = parseRefs(r.out)
  if (!m) return jjUnknown('malformed', r.out)
  return m.get(pin.ref) === u.result ? true : 'pinMoved'
}

const SEP = '\u001f'
const ZERO = '0'.repeat(40)
const ATTEMPT = /^[a-z0-9]{6,40}$/

/** A commit only while it is visible (HI-3100): read so, a commit the user hid since (rewrote it) reads as none. */
const visibleRev = (commit: string): string => `${commit} & ::visible_heads()`

/**
 * A write's parent named only while it is visible, and exactly once (HI-3100): jj resolves it at the operation it loads,
 * so a commit the user hid since (`jj describe`, a rebase) makes the write fail having made nothing ("fewer than the
 * expected 1 revisions", probed on 0.47.1), never brought back as a parent. Without `exactly`, `jj new` unions its
 * arguments and drops an empty one: a commit on the target alone.
 */
const visibleOne = (commit: string): string => `exactly(${visibleRev(commit)}, 1)`
const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.length > 0)
const toml = (s: string): string => JSON.stringify(s)
const marker = (attempt: string): string => `--config=combwork.txn=${toml(attempt)}`
const markerIn = (args: string, attempt: string): boolean => args.includes(`combwork.txn="${attempt}"`) || args.includes(`combwork.txn=\\"${attempt}\\"`)
const refSafe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '-')
const set = (ids: readonly string[]): string => (ids.length ? `(${ids.join(' | ')})` : 'none()')
/**
 * Of `ids`, the visible ones. Never `all()`: on 0.47.1 a revset that names a hidden commit makes it part of `all()` there
 * (probed: an abandoned commit named by its id is `& all()`), so visibility is `::visible_heads()`, the view's own heads.
 */
const visibleOf = (ids: readonly string[]): string => `${set(ids)} & ::visible_heads()`
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join() === [...b].sort().join()

/** HI-3150: how many commits one visibility read names. */
export const VISIBLE_CHUNK = 256

/**
 * HI-3150: which of `ids` jj shows now (visible at the single operation head), read in chunks of VISIBLE_CHUNK; null when
 * it can't be told (several heads, a read jj couldn't make, cancelled, `still` false between chunks): never "none".
 */
export async function visibleCommits(deps: Pick<JjCandidateDeps, 'runner' | 'view' | 'folder' | 'signal' | 'timeout'>, ids: readonly string[], still: () => boolean = () => true, chunkSize = VISIBLE_CHUNK): Promise<Set<string> | null> {
  const out = new Set<string>()
  if (!ids.length) return out
  const h = readOpHeads(deps.view.jjRepo)
  if (!h || h.length !== 1) return null
  const reads = new JjReads({ folder: deps.folder, jjRepo: deps.view.jjRepo }, deps.runner, { signal: deps.signal, timeout: deps.timeout })
  for (let i = 0; i < ids.length; i += chunkSize) {
    if (deps.signal?.aborted || !still()) return null
    const chunk = ids.slice(i, i + chunkSize)
    const r = await reads.run(h[0], ['log', '--no-graph', '-r', visibleOf(chunk), '-n', String(chunk.length + 1), '-T', COMMIT_T])
    if (isJjUnknown(r)) return null
    for (const l of lines(r)) {
      const c = parseCommitLine(l)
      if (!c) return null
      out.add(c.commit)
    }
  }
  return out
}

/** The prefix an attempt's pins live under: a namespace, never proof of who wrote a ref there. */
export const pinPrefix = (card: string, attempt: string): string => `refs/cw/jj/${refSafe(card)}/${attempt}/`

/**
 * The guarded abandon's revset (s17 §2): of `S`, every commit with no descendant outside `S` and no bookmark, remote
 * bookmark, tag or working copy on it or a descendant in `S`. So what it names is closed under descendants, and
 * abandoning it rebases nothing that survives.
 */
export const guardedSet = (ids: readonly string[]): string => {
  const s = set(ids)
  return `${s} ~ ::((children(${s}) ~ ${s}) | (${s} & (bookmarks() | remote_bookmarks() | tags() | working_copies())))`
}

const COMMIT_T = 'commit_id ++ "\\t" ++ change_id ++ "\\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\t" ++ empty ++ "\\t" ++ divergent ++ "\\t" ++ conflict ++ "\\n"'
const OP_T = `id ++ "${SEP}" ++ parents.map(|p| p.id()).join(",") ++ "${SEP}" ++ attributes ++ "\\n"`
const BOOKMARK_T = `name ++ "${SEP}" ++ if(remote, remote, "") ++ "${SEP}" ++ conflict ++ "${SEP}" ++ if(normal_target, normal_target.commit_id(), "") ++ "${SEP}" ++ added_targets.map(|c| c.commit_id()).join(",") ++ "${SEP}" ++ removed_targets.map(|c| c.commit_id()).join(",") ++ "\\n"`
const TAG_T = `name ++ "${SEP}" ++ if(normal_target, normal_target.commit_id(), "") ++ "\\n"`
const WORKSPACE_T = `name ++ "${SEP}" ++ target.commit_id() ++ "\\n"`
/** A commit's description and author (HI-2990: what jj's own rebase keeps), compared as read. */
const META_T = `description ++ "${SEP}" ++ author.name() ++ "${SEP}" ++ author.email() ++ "${SEP}" ++ author.timestamp() ++ "\\n"`
const CONFLICT_T =`if(conflict, path ++ "${SEP}" ++ conflict_side_count ++ "\\n")`

/** An operation as its log shows it: its id, parents and attributes (its args among them). */
export interface JjOpEntry {
  id: string
  parents: string[]
  args: string
}

export function parseOpLine(l: string): JjOpEntry | null {
  const f = l.split(SEP)
  if (f.length !== 3 || !/^[0-9a-f]{128}$/.test(f[0])) return null
  const parents = f[1] ? f[1].split(',') : []
  if (!parents.every((p) => /^[0-9a-f]{128}$/.test(p))) return null
  return { id: f[0], parents, args: f[2] }
}

/** What an operation changed, as far as an attempt is allowed to change anything. */
export interface JjOpDelta {
  op: string
  parent: string
  added: JjCommit[]
  removed: string[]
}

/** Why a delta isn't this attempt's alone (null: it is). Pure: the caller read both sides. */
export function deltaProblem(d: {
  entry: JjOpEntry
  parent: string
  attempt: string
  before: { bookmarks: string[]; tags: string[]; workspaces: string[]; refs: Map<string, string> }
  after: { bookmarks: string[]; tags: string[]; workspaces: string[]; refs: Map<string, string> }
  added: readonly string[]
  removed: readonly string[]
}): string | null {
  if (d.entry.parents.length !== 1 || d.entry.parents[0] !== d.parent) return 'parent'
  if (!markerIn(d.entry.args, d.attempt)) return 'marker'
  if (d.before.bookmarks.join('\n') !== d.after.bookmarks.join('\n')) return 'bookmarks'
  if (d.before.tags.join('\n') !== d.after.tags.join('\n')) return 'tags'
  if (d.before.workspaces.join('\n') !== d.after.workspaces.join('\n')) return 'workspaces'
  // Git's refs: only jj's own keep refs of exactly the commits this operation added or abandoned may differ.
  const touched = new Set([...d.added, ...d.removed])
  const names = new Set([...d.before.refs.keys(), ...d.after.refs.keys()])
  for (const n of names) {
    const was = d.before.refs.get(n)
    const now = d.after.refs.get(n)
    if (was === now) continue
    const keep = /^refs\/jj\/keep\/([0-9a-f]{40})$/.exec(n)
    if (keep && touched.has(keep[1]) && (now === undefined || now === keep[1]) && (was === undefined || was === keep[1])) continue
    return `ref:${n}`
  }
  return null
}

/** Git refs as `git for-each-ref` lists them (every ref), or null when unreadable. */
export function parseRefs(out: string): Map<string, string> | null {
  const m = new Map<string, string>()
  for (const l of lines(out)) {
    const [oid, name, ...rest] = l.split(' ')
    if (rest.length || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid ?? '')) return null
    if (!name) return null
    m.set(name, oid)
  }
  return m
}

/** A conflicted file as jj lists it: its path and how many sides (two or more). */
export function parseConflicted(out: string): { path: string; sides: number }[] | null {
  const found: { path: string; sides: number }[] = []
  for (const l of lines(out)) {
    const f = l.split(SEP)
    const n = Number(f[1])
    if (f.length !== 2 || !f[0] || !Number.isInteger(n) || n < 2) return null
    found.push({ path: f[0], sides: n })
  }
  return found
}

/** A file named exactly, from the workspace's root, as a jj fileset. */
export const rootFile = (path: string): string => `root-file:"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

class Stop extends Error {
  constructor(
    readonly why: JjInterruptWhy,
    readonly detail?: string
  ) {
    super(why)
  }
}

/** One attempt's session: its record, its reads and its guarded steps. */
class Attempt {
  readonly reads: JjReads
  constructor(
    readonly deps: JjCandidateDeps,
    readonly rec: JjAttemptRecord
  ) {
    this.reads = new JjReads({ folder: deps.folder, jjRepo: deps.view.jjRepo }, deps.runner, { signal: deps.signal, timeout: deps.timeout })
  }

  check(): void {
    if (this.deps.signal?.aborted) throw new Stop('cancelled')
    if (!this.deps.owner.still()) throw new Stop('owner')
  }

  async phase(p: JjAttemptPhase): Promise<void> {
    this.rec.phase = p
    await this.deps.journal(structuredClone(this.rec))
  }

  async hook(p: JjCandidatePoint): Promise<void> {
    await this.deps.hook?.(p, structuredClone(this.rec))
    this.check()
  }

  head(): string {
    const h = readOpHeads(this.deps.view.jjRepo)
    if (!h || h.length !== 1) throw new Stop('heads', h ? `${h.length} heads` : 'unreadable')
    return h[0]
  }

  async read(op: string, args: readonly string[]): Promise<string> {
    const out = await this.reads.run(op, args)
    if (isJjUnknown(out)) throw new Stop(out.jjUnknown === 'tool' ? 'tool' : 'failed', out.detail ?? out.jjUnknown)
    return out
  }

  async commits(op: string, revset: string, max = 1000): Promise<JjCommit[]> {
    const out = await this.read(op, ['log', '--no-graph', '-r', revset, '-n', String(max + 1), '-T', COMMIT_T])
    const ls = lines(out)
    if (ls.length > max) throw new Stop('malformed', 'tooManyCommits')
    const found: JjCommit[] = []
    for (const l of ls) {
      const c = parseCommitLine(l)
      if (!c) throw new Stop('malformed', l)
      found.push(c)
    }
    return found
  }

  /** The operations from `op` back to (not including) `parent`, newest first; null when `parent` isn't met within 50. */
  async opsSince(op: string, parent: string): Promise<JjOpEntry[] | null> {
    const out: JjOpEntry[] = []
    for (const l of lines(await this.read(op, ['op', 'log', '--no-graph', '--limit', '50', '-T', OP_T]))) {
      const e = parseOpLine(l)
      if (!e) return null
      if (e.id === parent) return out
      out.push(e)
    }
    return null
  }

  async opEntry(op: string): Promise<JjOpEntry> {
    const [l, ...more] = lines(await this.read(op, ['op', 'log', '--no-graph', '--limit', '1', '-T', OP_T]))
    const e = l ? parseOpLine(l) : null
    if (!e || more.length || e.id !== op) throw new Stop('malformed', l)
    return e
  }

  async refs(): Promise<Map<string, string>> {
    const r = await this.deps.git(['for-each-ref', '--format=%(objectname) %(refname)'])
    const m = r.ok ? parseRefs(r.out) : null
    if (!m) throw new Stop('failed', r.err || 'refs')
    return m
  }

  async sides(op: string): Promise<{ bookmarks: string[]; tags: string[]; workspaces: string[] }> {
    const sorted = async (args: string[]): Promise<string[]> => lines(await this.read(op, args)).sort()
    return {
      bookmarks: await sorted(['bookmark', 'list', '--all-remotes', '-T', BOOKMARK_T]),
      tags: await sorted(['tag', 'list', '-T', TAG_T]),
      workspaces: await sorted(['workspace', 'list', '-T', WORKSPACE_T])
    }
  }

  /**
   * One jj write: the owner checked, the head read, the write run from the folder (its working copy ignored, the marker,
   * the identity), then validated (deltaProblem) and its added commits read at the new head, which must be the shape
   * its step may make (shapeProblem). The step is journalled before the command runs, for recovery.
   */
  async write(name: string, args: readonly string[], shape: JjStep): Promise<JjOpDelta> {
    return this.deps.lock(async () => {
      this.check()
      const parent = this.head()
      const before = { ...(await this.sides(parent)), refs: await this.refs() }
      await this.hook(`beforeWrite:${name}`)
      if (this.head() !== parent) throw new Stop('raced', `beforeWrite:${name}`)
      this.check()
      this.rec.step = { name, parent, shape }
      await this.deps.journal(structuredClone(this.rec))
      await this.hook(`run:${name}`)
      const who = this.deps.identity ? [`--config=user.name=${toml(this.deps.identity.name)}`, `--config=user.email=${toml(this.deps.identity.email)}`] : []
      // Its owner again under the file gate's admission, right before jj starts (HI-2918). A head moved meanwhile is
      // left to the race detection after the write, as before (what that operation made is recovered as uncertain).
      const recheck = (): string | null => (this.deps.owner.still() ? null : 'owner')
      const r = await this.deps.runner.run(this.deps.folder, ['--ignore-working-copy', '--config=snapshot.auto-update-stale=false', marker(this.rec.attempt), ...who, ...args], { write: true, signal: this.deps.signal, timeout: this.deps.timeout, recheck })
      // HI-2990: a step that provably made nothing (jj refused before it started, or it ended with the head where it was,
      // still under the lock) is no longer under way: its journalled step cleared, so recovery and drop never take it for
      // an uncertain one and keep the attempt's commits for good (a squash's restore with nothing to restore, say).
      const nothing = async (): Promise<void> => {
        this.rec.step = undefined
        await this.deps.journal(structuredClone(this.rec))
      }
      if (r.refused) {
        await nothing()
        throw new Stop('owner', name)
      }
      if (r.cancelled) throw new Stop('cancelled', name)
      const heads = readOpHeads(this.deps.view.jjRepo)
      if (!heads || heads.length !== 1) throw new Stop('raced', `heads after ${name}`) // i18n-ignore: a protocol detail for logs and tests, never shown
      const op = heads[0]
      if (op === parent) {
        await nothing()
        throw new Stop('failed', r.err || `${name}: no operation`) // i18n-ignore: a protocol detail for logs and tests, never shown
      }
      // HI-3100: jj refused (a parent of ours hidden meanwhile, say) while another's operation moved the head: ours made
      // nothing when no operation between `parent` and the head carries this attempt's marker (read in full, else as
      // before: uncertain), so it is no longer under way either.
      if (!r.ok) {
        const since = await this.opsSince(op, parent)
        if (since && !since.some((e) => markerIn(e.args, this.rec.attempt))) {
          await nothing()
          throw new Stop('raced', `${name}: refused, nothing made`) // i18n-ignore: a protocol detail for logs and tests, never shown
        }
      }
      const entry = await this.opEntry(op)
      const added = await this.commits(op, `::visible_heads() ~ ::at_operation(${parent}, visible_heads())`)
      const removed = (await this.commits(op, `at_operation(${parent}, ::visible_heads()) ~ ::visible_heads()`)).map((c) => c.commit)
      const after = { ...(await this.sides(op)), refs: await this.refs() }
      const why = deltaProblem({ entry, parent, attempt: this.rec.attempt, before, after, added: added.map((c) => c.commit), removed })
      if (why) throw new Stop('raced', `${name}: ${why}`)
      if (this.head() !== op) throw new Stop('raced', `after ${name}`) // i18n-ignore: a protocol detail for logs and tests, never shown
      const d: JjOpDelta = { op, parent, added, removed }
      const bad = shapeProblem(shape, d)
      if (bad) throw new Stop('raced', `${name}: ${bad}`)
      // Only now are its commits the attempt's: an operation validated as its own.
      this.rec.ops.push(op)
      for (const c of added) if (!this.rec.commits.includes(c.commit)) this.rec.commits.push(c.commit)
      this.rec.step = undefined
      await this.deps.journal(structuredClone(this.rec))
      await this.hook(`afterWrite:${name}`)
      return d
    })
  }

  /** The ref's value now (null: absent), or a Stop when unreadable. */
  async refNow(ref: string): Promise<string | null> {
    // for-each-ref matches a prefix too: only the exact name counts, so it is listed with its name.
    const named = await this.deps.git(['for-each-ref', '--format=%(objectname) %(refname)', ref])
    if (!named.ok) throw new Stop('failed', named.err)
    const m = parseRefs(named.out)
    if (!m) throw new Stop('malformed', named.out)
    return m.get(ref) ?? null
  }

  /**
   * Pins `oid` at `ref`: the intent journalled, the owner checked, a create-only update (the ref must not exist), read
   * back. Owned (`created`) only then; a ref there first is a collision (journalled, never touched again).
   */
  async pin(ref: string, oid: string): Promise<void> {
    if (!this.rec.commits.includes(oid)) throw new Stop('pin', `not the attempt's commit: ${oid}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    const entry: JjPin = { ref, oid, state: 'intent' }
    this.rec.pins.push(entry)
    await this.deps.journal(structuredClone(this.rec))
    await this.deps.lock(async () => {
      await this.hook(`beforePin:${ref}`)
      const r = await this.deps.git(['update-ref', ref, oid, ZERO])
      const now = await this.refNow(ref)
      if (r.ok && now === oid) entry.state = 'created'
      else if (now !== null) {
        entry.state = 'collision'
        entry.found = now
      }
      await this.deps.journal(structuredClone(this.rec))
      if (entry.state === 'collision') throw new Stop('raced', `collision:${ref}`)
      if (entry.state !== 'created') throw new Stop('pin', r.err || ref)
    })
    await this.hook(`afterPin:${ref}`)
  }

  /** Every commit of the attempt pinned (`c<n>`), the candidate too when there is one. */
  async pinAll(): Promise<void> {
    await this.phase('pinning')
    const pinned = new Set(this.rec.pins.filter((p) => p.state === 'created').map((p) => p.oid))
    const prefix = pinPrefix(this.rec.card, this.rec.attempt)
    let n = this.rec.pins.length
    for (const c of this.rec.commits) if (!pinned.has(c)) await this.pin(`${prefix}c${n++}`, c)
    if (this.rec.result && !this.rec.pins.some((p) => p.ref === `${prefix}candidate`)) await this.pin(`${prefix}candidate`, this.rec.result) // i18n-ignore: a protocol detail for logs and tests, never shown
    await this.phase('pinned')
    await this.hook('pinned')
  }

  /**
   * The guarded abandon of `ids` (owned, pinned): what jj will abandon read first at the head, then the command with the
   * same revset, validated to have abandoned exactly that and added nothing. Returns what was kept back.
   */
  async abandon(ids: readonly string[]): Promise<string[]> {
    const owned = ids.filter((c) => this.rec.commits.includes(c))
    await this.phase('abandoning')
    await this.hook(`beforeAbandon:${owned.length}`)
    // The pins as they are now, at the boundary (never the journal's word alone): every owned pin still at its commit,
    // and every commit to abandon held by one (or by a journalled intent whose ref holds it: recovery's ambiguous, never
    // owned or deleted, but it keeps the commit reachable all the same).
    const held = await this.held()
    if (owned.some((c) => !held.has(c))) throw new Stop('pin', 'abandon before pin') // i18n-ignore: a protocol detail for logs and tests, never shown
    const op = this.head()
    const visible = new Set((await this.commits(op, visibleOf(owned))).map((c) => c.commit))
    const live = owned.filter((c) => visible.has(c))
    const guard = guardedSet(live)
    const will = live.length ? (await this.commits(op, guard)).map((c) => c.commit) : []
    const kept = live.filter((c) => !will.includes(c))
    if (will.length) {
      await this.write('abandon', ['abandon', '-r', guard], { kind: 'abandon', will })
    }
    this.rec.abandoned = [...(this.rec.abandoned ?? []), ...will]
    this.rec.kept = kept
    await this.phase('abandoned')
    await this.hook('abandoned')
    // The evidence still held after the abandon: a pin lost meanwhile is never reported as retained.
    await this.held()
    return kept
  }

  /**
   * The commits the attempt's pins hold now: each owned pin read and required at its commit (moved or gone: `pin`, never
   * taken from the journal), and each journalled intent whose ref holds exactly its commit.
   */
  async held(): Promise<Set<string>> {
    const held = new Set<string>()
    for (const p of this.rec.pins) {
      if (p.state !== 'created' && p.state !== 'intent') continue
      const now = await this.refNow(p.ref)
      if (now === p.oid) held.add(p.oid)
      else if (p.state === 'created') throw new Stop('pin', `lost:${p.ref}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    }
    return held
  }

  /** The attempt's owned refs (its own creates, not dropped). */
  owned(): string[] {
    return this.rec.pins.filter((p) => p.state === 'created').map((p) => p.ref)
  }

  interrupted(s: Stop): JjInterrupted {
    return {
      interrupted: { attempt: this.rec.attempt, phase: this.rec.phase, why: s.why, ...(s.detail ? { detail: s.detail.slice(0, 2000) } : {}), commits: [...this.rec.commits], refs: this.owned(), ...(this.rec.kept?.length ? { kept: [...this.rec.kept] } : {}) },
      record: structuredClone(this.rec)
    }
  }
}

/**
 * The conflicts of an attempt's commits, read at `op` (s11 §4): every conflicted commit, its files (each from the first
 * conflicted commit naming it) and their hunks in git's marker style, bounded by CONFLICT_LIMITS. A conflict of more than
 * two sides can't be written in git's style: listed, its text not read (`notText`).
 */
async function conflictsOf(a: Attempt, op: string, commits: readonly JjCommit[], oursIs: ConflictsRecord['oursIs'] = 'target'): Promise<{ files: string[]; record: ConflictsRecord; evidence: string[] } | null> {
  const conflicted = commits.filter((c) => c.conflict)
  if (!conflicted.length) return null
  const seen = new Map<string, { commit: string; sides: number }>()
  for (const c of conflicted) {
    const out = await a.read(op, ['file', 'list', '-r', c.commit, '-T', CONFLICT_T])
    const fs = parseConflicted(out)
    if (!fs) throw new Stop('malformed', out)
    for (const f of fs) if (!seen.has(f.path)) seen.set(f.path, { commit: c.commit, sides: f.sides })
  }
  const files = [...seen.keys()]
  const room = { chars: CONFLICT_LIMITS.chars }
  let left = CONFLICT_LIMITS.totalBytes
  const read: ConflictFile[] = []
  for (const file of files.slice(0, CONFLICT_LIMITS.files)) {
    const at = seen.get(file)!
    if (at.sides > 2) {
      read.push({ file, notRead: 'notText', hunks: [] })
      continue
    }
    if (left <= 0) {
      read.push({ file, notRead: 'budget', hunks: [] })
      continue
    }
    const cap = Math.min(CONFLICT_LIMITS.fileBytes, left)
    const r = await a.deps.runner.run(a.deps.folder, ['--at-op', op, 'file', 'show', '-r', at.commit, '--config=ui.conflict-marker-style=git', rootFile(file)], { signal: a.deps.signal, timeout: a.deps.timeout, maxOutput: cap })
    if (r.cancelled) throw new Stop('cancelled')
    if (!r.ok) {
      read.push({ file, notRead: r.code === -1 ? 'budget' : 'error', hunks: [] })
      continue
    }
    left -= r.buf.length
    if (r.buf.includes(0)) {
      read.push({ file, notRead: 'binary', hunks: [] })
      continue
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(r.buf)
    } catch {
      read.push({ file, notRead: 'notText', hunks: [] })
      continue
    }
    read.push(parseConflicts(file, text, true, room))
  }
  return { files, record: { oursIs, files: read, ...(files.length > CONFLICT_LIMITS.files ? { filesLeft: files.length - CONFLICT_LIMITS.files } : {}) }, evidence: conflicted.map((c) => c.commit) }
}

/** The head of a set of commits: the one no other in it names as a parent (null unless exactly one). */
const headOf = (cs: readonly JjCommit[]): JjCommit | null => {
  const ids = new Set(cs.flatMap((c) => c.parents))
  const heads = cs.filter((c) => !ids.has(c.commit))
  return heads.length === 1 ? heads[0] : null
}

/**
 * Prepares one candidate (see the module's comment). Before anything is written, a read it can't make is a typed unknown
 * (nothing made). Once the attempt is planned, anything that stops it short is `interrupted`, with its record for
 * recovery: never a candidate, never a retained-evidence failure.
 */
export async function prepareJjCandidate(deps: JjCandidateDeps, req: JjCandidateRequest): Promise<JjCandidateOutcome> {
  if (!ATTEMPT.test(req.attempt)) return jjUnknown('malformed', 'attempt')
  for (const c of [req.revision, req.base, req.expected]) if (!COMMIT_ID.test(c)) return jjUnknown('malformed', c)
  const reads = new JjReads({ folder: deps.folder, jjRepo: deps.view.jjRepo }, deps.runner, { signal: deps.signal, timeout: deps.timeout })
  const h0 = reads.head()
  if (isJjUnknown(h0)) return h0
  const ok = await reads.supported()
  if (isJjUnknown(ok)) return ok
  // gate:signing (SPEC §16.3.6): a repository that signs its commits isn't one jj candidates are made in.
  const signing = await reads.configAt(h0, 'signing.behavior')
  if (isJjUnknown(signing)) return signing
  if (signing === 'own' || signing === 'force') return { pause: 'signing', message: `signing.behavior = ${signing}` } // i18n-ignore: a protocol detail for logs and tests, never shown
  // The inputs at h0: the reviewed revision and the target's head visible, neither divergent; the suffix linear for a rebase.
  // HI-3100: visible, not only present: a reviewed commit the user rewrote since (`jj describe`, say) is hidden, and a
  // commit built on it would bring it back beside its rewritten self. Refused unwritten; the next pass reads the head.
  const rev = await reads.commitAt(h0, visibleRev(req.revision))
  if (isJjUnknown(rev)) return rev.jjUnknown === 'none' ? jjUnknown('moved', 'hidden') : rev
  const exp = await reads.commitAt(h0, req.expected)
  if (isJjUnknown(exp)) return exp
  if (!reads.stillAt(h0)) return jjUnknown('moved')
  if (rev.divergent || exp.divergent) return jjUnknown('ambiguous', 'divergent')
  // Strict's update to build on (merge and squash; a rebase ignores it): validated before anything is written, else
  // refused unwritten (HI-2853/s10 §2). Its result visible and not divergent at h0.
  let from = req.revision
  let updated: JjAttemptRecord['updated']
  if (req.updated && req.style !== 'rebase') {
    const v = await validUpdate(deps.git, req.updated, { card: req.card, revision: req.revision, base: req.base, expected: req.expected, attempt: req.updated.attempt })
    if (isJjUnknown(v)) return v
    if (v !== true) return jjUnknown('malformed', `update:${v}`)
    const u = await reads.commitAt(h0, `${req.updated.result} & ::visible_heads()`)
    if (isJjUnknown(u)) return u.jjUnknown === 'none' ? jjUnknown('malformed', 'update:hidden') : u
    if (u.divergent || u.conflict) return jjUnknown('malformed', 'update:unsettled')
    if (!reads.stillAt(h0)) return jjUnknown('moved')
    from = req.updated.result!
    updated = { attempt: req.updated.attempt, result: from }
  }

  const rec: JjAttemptRecord = { attempt: req.attempt, card: req.card, kind: 'candidate', style: req.style, revision: req.revision, base: req.base, expected: req.expected, phase: 'planned', baseOp: h0, ops: [], commits: [], pins: [], ...(updated ? { updated } : {}) }
  const a = new Attempt(deps, rec)
  try {
    a.check()
    await a.phase('planned')
    await a.hook('planned')
    const notUp = (m: (typeof CANDIDATE_TEXT)[keyof typeof CANDIDATE_TEXT]): string => say(m, { card: req.card, revision: req.revision.slice(0, 7), expected: req.expected.slice(0, 7) })
    let fail: CandidateTestFail | null = null
    let scratch: string[] = []

    if (req.style === 'rebase') {
      const suffix = await a.commits(h0, `${req.base}..${req.revision}`)
      if (suffix.some((c) => c.parents.length > 1)) return { fail: 'notUpToDate', log: notUp(CANDIDATE_TEXT.mergeCommit), evidence: [], refs: [], record: structuredClone(rec) }
      if (!suffix.length) return { fail: 'notUpToDate', log: notUp(CANDIDATE_TEXT.rebasedNotSame), evidence: [], refs: [], record: structuredClone(rec) }
      await a.phase('writing')
      const d = await a.write('duplicate', ['duplicate', '-r', `${req.base}..(${visibleOne(req.revision)})`, '--onto', visibleOne(req.expected)], { kind: 'duplicate', n: suffix.length, onto: req.expected })
      rec.result = headOf(d.added)!.commit
    } else if (req.style === 'merge') {
      await a.phase('writing')
      const d = await a.write('merge', ['new', visibleOne(req.expected), visibleOne(from), '--no-edit', '-m', req.message], { kind: 'new', parents: [req.expected, from] })
      rec.result = d.added[0].commit
    } else {
      await a.phase('writing')
      const m = await a.write('scratch', ['new', visibleOne(req.expected), visibleOne(from), '--no-edit', '-m', `combwork scratch ${req.attempt}`], { kind: 'new', parents: [req.expected, from] }) // i18n-ignore: a protocol detail for logs and tests, never shown
      const merged = m.added[0].commit
      const s = await a.write('squash', ['new', visibleOne(req.expected), '--no-edit', '-m', req.message], { kind: 'new', parents: [req.expected] })
      const empty = s.added[0].commit
      const t = await a.write('restore', ['restore', '--from', merged, '--into', empty], { kind: 'restore', into: empty, change: s.added[0].change, parent: req.expected })
      rec.result = t.added[0].commit
      scratch = [merged]
    }
    await a.phase('written')
    await a.hook('written')

    // Evidence before anything is hidden: every commit made pinned and read back.
    await a.pinAll()

    // What was made, read pinned at the head now: still visible, the candidate exactly the recorded commit.
    const op = a.head()
    const made = await a.commits(op, visibleOf(rec.commits))
    const result = made.find((c) => c.commit === rec.result)
    if (!result) throw new Stop('gone', rec.result)
    if (made.some((c) => c.divergent)) throw new Stop('raced', 'divergent')
    // Every commit of the candidate checked for conflicts (a middle one counts: R4.8), the squash's scratch included.
    const conflicts = await conflictsOf(a, op, made)
    if (conflicts) fail = { fail: 'conflict', files: conflicts.files, log: '', conflicts: conflicts.record }
    else if (req.style === 'rebase') {
      // On top (by construction, read again), and the same change by §16.3.2's replay (change ids never count).
      const onTop = await a.commits(op, `${req.expected} & ::${result.commit}`)
      if (!onTop.length) fail = { fail: 'notUpToDate', log: notUp(CANDIDATE_TEXT.notOnTop) }
      else if (!(await jjSameRevision({ base: req.base, commit: rev }, { base: req.expected, commit: result }, deps.sameChange))) fail = { fail: 'notUpToDate', log: notUp(CANDIDATE_TEXT.rebasedNotSame) }
    }
    a.check()

    if (fail) {
      // Pinned already: the attempt's commits out of the user's log, guarded; anything kept back is an interruption.
      const kept = await a.abandon(rec.commits)
      if (kept.length) throw new Stop('kept')
      await a.held()
      rec.outcome = fail.fail === 'conflict' ? 'conflict' : 'notUpToDate'
      await a.phase('done')
      const evidence = fail.fail === 'conflict' ? (conflicts?.evidence ?? []) : [...rec.commits]
      return { ...fail, evidence, refs: a.owned(), record: structuredClone(rec) }
    }
    if (scratch.length) {
      const kept = await a.abandon(scratch)
      if (kept.length) throw new Stop('kept')
    }
    // The candidate still visible, at exactly its commit, at the head it is answered for.
    const at = a.head()
    if (!(await a.commits(at, visibleOf([result.commit]))).length) throw new Stop('gone', result.commit)
    await a.held()
    rec.outcome = 'candidate'
    await a.phase('done')
    const stays = rec.commits.filter((c) => !(rec.abandoned ?? []).includes(c) && c !== rec.result).concat(result.commit)
    return { candidate: { result: result.commit, commits: (await a.commits(at, visibleOf(stays))).map((c) => c.commit), change: result.change, op: at, refs: a.owned() }, record: structuredClone(rec) }
  } catch (e) {
    if (e instanceof Stop) return a.interrupted(e)
    throw e
  }
}

/**
 * Strict's update for jj (G8, HI-2853/s7, s10): the reviewed revision R brought up to date with the target's head E as
 * private commits, on J4's machinery (the same session, journalled steps, create-only pins and guarded abandons; recovery
 * and drop are J4's). Already up to date (E an ancestor of R): `{ updated: null }`, nothing written. Merge: a fresh
 * commit with parents R then E (git's merge of the target into the card, so the card's side is written first in a
 * conflict); rebase: R's suffix duplicated onto E (a merge in it returns the card). Conflicts read from every commit made;
 * then §16.3.2's replay (`jjSameRevision`) or `notSame`. Success: `outcome: 'updated'`, its result pinned (`…/candidate`),
 * never a candidate by itself.
 */
export async function prepareJjUpdate(deps: JjCandidateDeps, req: JjUpdateRequest): Promise<JjUpdateOutcome> {
  if (!ATTEMPT.test(req.attempt)) return jjUnknown('malformed', 'attempt')
  for (const c of [req.revision, req.base, req.expected]) if (!COMMIT_ID.test(c)) return jjUnknown('malformed', c)
  const reads = new JjReads({ folder: deps.folder, jjRepo: deps.view.jjRepo }, deps.runner, { signal: deps.signal, timeout: deps.timeout })
  const h0 = reads.head()
  if (isJjUnknown(h0)) return h0
  const ok = await reads.supported()
  if (isJjUnknown(ok)) return ok
  const signing = await reads.configAt(h0, 'signing.behavior')
  if (isJjUnknown(signing)) return signing
  if (signing === 'own' || signing === 'force') return { pause: 'signing', message: `signing.behavior = ${signing}` } // i18n-ignore: a protocol detail for logs and tests, never shown
  // HI-3100: visible, not only present: a reviewed commit the user rewrote since (`jj describe`, say) is hidden, and a
  // commit built on it would bring it back beside its rewritten self. Refused unwritten; the next pass reads the head.
  const rev = await reads.commitAt(h0, visibleRev(req.revision))
  if (isJjUnknown(rev)) return rev.jjUnknown === 'none' ? jjUnknown('moved', 'hidden') : rev
  const exp = await reads.commitAt(h0, req.expected)
  if (isJjUnknown(exp)) return exp
  if (rev.divergent || exp.divergent) return jjUnknown('ambiguous', 'divergent')
  const upToDate = await reads.run(h0, ['log', '--no-graph', '-r', `${req.expected} & ::${req.revision}`, '-T', 'commit_id ++ "\\n"'])
  if (isJjUnknown(upToDate)) return upToDate
  if (!reads.stillAt(h0)) return jjUnknown('moved')
  if (lines(upToDate).length) return { updated: null }

  const rec: JjAttemptRecord = { attempt: req.attempt, card: req.card, kind: 'update', how: req.how, style: req.how, revision: req.revision, base: req.base, expected: req.expected, phase: 'planned', baseOp: h0, ops: [], commits: [], pins: [] }
  const a = new Attempt(deps, rec)
  try {
    a.check()
    await a.phase('planned')
    await a.hook('planned')
    const say3 = (m: (typeof CANDIDATE_TEXT)[keyof typeof CANDIDATE_TEXT]): string => say(m, { card: req.card, revision: req.revision.slice(0, 7), expected: req.expected.slice(0, 7) })
    if (req.how === 'rebase') {
      const suffix = await a.commits(h0, `${req.base}..${req.revision}`)
      if (suffix.some((c) => c.parents.length > 1)) return { fail: 'notUpToDate', log: say3(CANDIDATE_TEXT.mergeCommit), evidence: [], refs: [], record: structuredClone(rec) }
      if (!suffix.length) return { fail: 'notUpToDate', log: say3(CANDIDATE_TEXT.rebasedNotSame), evidence: [], refs: [], record: structuredClone(rec) }
      await a.phase('writing')
      const d = await a.write('update', ['duplicate', '-r', `${req.base}..(${visibleOne(req.revision)})`, '--onto', visibleOne(req.expected)], { kind: 'duplicate', n: suffix.length, onto: req.expected })
      rec.result = headOf(d.added)!.commit
    } else {
      await a.phase('writing')
      const d = await a.write('update', ['new', visibleOne(req.revision), visibleOne(req.expected), '--no-edit', '-m', req.message], { kind: 'new', parents: [req.revision, req.expected] })
      rec.result = d.added[0].commit
    }
    await a.phase('written')
    await a.hook('written')
    await a.pinAll()
    const op = a.head()
    const made = await a.commits(op, visibleOf(rec.commits))
    const result = made.find((c) => c.commit === rec.result)
    if (!result) throw new Stop('gone', rec.result)
    if (made.some((c) => c.divergent)) throw new Stop('raced', 'divergent')
    const conflicts = await conflictsOf(a, op, made, req.how === 'merge' ? 'card' : 'target')
    let fail: CandidateFail | null = conflicts ? { fail: 'conflict', files: conflicts.files, log: '', conflicts: conflicts.record } : null
    if (!fail && !(await jjSameRevision({ base: req.base, commit: rev }, { base: req.expected, commit: result }, deps.sameChange))) {
      fail = { fail: 'notSame', log: say(UPDATE_NOT_SAME, { card: req.card, revision: req.revision.slice(0, 7), target: '', expected: req.expected.slice(0, 7) }) }
    }
    a.check()
    if (fail) {
      const kept = await a.abandon(rec.commits)
      if (kept.length) throw new Stop('kept')
      await a.held()
      rec.outcome = fail.fail === 'conflict' ? 'conflict' : 'notSame'
      await a.phase('done')
      const evidence = fail.fail === 'conflict' ? (conflicts?.evidence ?? []) : [...rec.commits]
      return { ...fail, evidence, refs: a.owned(), record: structuredClone(rec) }
    }
    const at = a.head()
    if (!(await a.commits(at, visibleOf([result.commit]))).length) throw new Stop('gone', result.commit)
    await a.held()
    rec.outcome = 'updated'
    await a.phase('done')
    return { updated: result.commit, record: structuredClone(rec) }
  } catch (e) {
    if (e instanceof Stop) return a.interrupted(e)
    throw e
  }
}

/** The result's sameness with the reviewed change (squash and merge: for the common carry-over under the project's `sameness`). */
export async function inspectJjCandidate(deps: Pick<JjCandidateDeps, 'runner' | 'view' | 'folder' | 'sameChange' | 'signal' | 'timeout'>, c: { revision: string; base: string; expected: string; result: string }): Promise<JjMaybe<boolean>> {
  const reads = new JjReads({ folder: deps.folder, jjRepo: deps.view.jjRepo }, deps.runner, { signal: deps.signal, timeout: deps.timeout })
  const p = await reads.pinned(async (op) => {
    const rev = await reads.commitAt(op, c.revision)
    if (isJjUnknown(rev)) return rev
    const res = await reads.commitAt(op, c.result)
    if (isJjUnknown(res)) return res
    return { rev, res }
  })
  if (isJjUnknown(p)) return p
  return jjSameRevision({ base: c.base, commit: p.value.rev }, { base: c.expected, commit: p.value.res }, deps.sameChange)
}

/** How many operations recovery's walk reads at most (HI-2992), and how many a page. */
export const OPS_WALK_MAX = 10_000
const OPS_PAGE = 1_000

/**
 * The operations after `base` up to `head`, oldest first (HI-2992), read a page at a time from the newest back, each page
 * `--at-op` the previous page's oldest operation's parent: never more than `max` in all. `unreachable` when `base` isn't
 * within `max`, isn't in this history at all (the root reached), or lies past a page holding an operation with several
 * parents (concurrent operations merged: a page past it could miss one of its branches).
 */
async function walkTo(a: Attempt, head: string, base: string, max: number, per = OPS_PAGE): Promise<JjOpEntry[] | 'unreachable'> {
  const found: JjOpEntry[] = []
  let at = head
  for (;;) {
    const page = Math.min(per, max - found.length)
    if (page <= 0) return 'unreachable'
    const ls = lines(await a.read(at, ['op', 'log', '--no-graph', '--limit', String(page), '-T', OP_T]))
    for (const l of ls) {
      const e = parseOpLine(l)
      if (!e) throw new Stop('malformed', l)
      if (e.id === base) return found.reverse()
      found.push(e)
    }
    const last = found.at(-1)
    // The root reached (or nothing read) without the base: it isn't in this history.
    if (ls.length < page || !last || !last.parents.length) return 'unreachable'
    if (found.slice(-ls.length).some((e) => e.parents.length !== 1)) return 'unreachable'
    at = last.parents[0]
  }
}

/** What recovery found of an attempt: never a success, never anything abandoned or dropped. */
export interface JjRecovered {
  recovered: {
    attempt: string
    phase: JjAttemptPhase
    /** Commits the attempt owns: added by its own validated operations (journalled, or its last step validated now). */
    commits: string[]
    /**
     * Commits a marked operation added that couldn't be validated as the attempt's step (another parent, a side effect,
     * another shape: an outside descendant jj rebased, say). Preserved, never owned, pinned or abandoned; drop refuses.
     */
    uncertain: string[]
    /** Refs the attempt owns: its own creates, read back. */
    owned: string[]
    /** A create whose outcome the journal never recorded, the ref at the intended commit: kept, not owned. */
    ambiguous: string[]
    /** Refs found at another commit than the attempt's (or created by someone else first): preserved, not owned. */
    collisions: string[]
  }
  record: JjAttemptRecord
}

/**
 * An interrupted attempt's recovery (s14 §11, s17 §1, HR2's round 1): explicit, its later caller's to run. Its objects are
 * found only by provenance: operations carrying its marker, walking back from the single head to its planned operation
 * (paged and bounded, and only for a write under way: HI-2992, below). A marked operation's commits are the attempt's only when that operation was validated in the attempt (its
 * journal's `ops`), or is its journalled last step validated now as the attempt would have (the step's parent, nothing
 * else changed in its view, the step's shape); any other marked operation's additions are `uncertain`: kept apart, never
 * owned. Refs only through its journal's pins. What it owns unpinned is pinned (create-only); nothing is abandoned or
 * dropped, and the answer is never a candidate.
 */
export async function recoverJjAttempt(deps: JjCandidateDeps, record: JjAttemptRecord): Promise<JjRecovered | JjInterrupted> {
  const rec = structuredClone(record)
  const a = new Attempt(deps, rec)
  try {
    a.check()
    const head = a.head()
    const owns = new Set(rec.commits)
    const uncertain = new Set(rec.uncertain ?? [])
    // HI-2992: only a write under way (its step journalled, its command maybe run) needs the walk: every write journals
    // its step before jj runs and clears it only once its operation is validated (or provably made nothing), so with no
    // step there is no marked operation the journal doesn't know, and the attempt is settled from its journal however far
    // the operation log has moved on. A walk that can't reach the base operation gives the step up (journalled in
    // `givenUp`): whatever that write may have made isn't the attempt's (never owned, never touched), and the rest of the
    // attempt is recovered and dropped as ever (the Assistant's (a)).
    let walk: JjOpEntry[] = []
    if (rec.step) {
      const w = await walkTo(a, head, rec.baseOp, deps.opsLimit ?? OPS_WALK_MAX, deps.opsPage)
      if (w === 'unreachable') {
        rec.givenUp = [...(rec.givenUp ?? []), rec.step.name]
        rec.step = undefined
      } else walk = w
    }
    for (const e of walk) {
      if (!markerIn(e.args, rec.attempt)) continue
      if (e.parents.length !== 1) throw new Stop('malformed', `merge op ${e.id}`) // i18n-ignore: a protocol detail for logs and tests, never shown
      const parent = e.parents[0]
      const added = await a.commits(e.id, `::visible_heads() ~ ::at_operation(${parent}, visible_heads())`)
      if (rec.ops.includes(e.id)) {
        // Validated in the attempt: its commits are the journal's already.
        if (added.some((c) => !owns.has(c.commit))) throw new Stop('malformed', `journal commits differ: ${e.id}`) // i18n-ignore: a protocol detail for logs and tests, never shown
        continue
      }
      // The journalled step under way, validated now as the attempt would have: its parent, its view's other parts, its shape.
      const step = rec.step
      let mine = false
      if (step && parent === step.parent) {
        const removed = (await a.commits(e.id, `at_operation(${parent}, ::visible_heads()) ~ ::visible_heads()`)).map((c) => c.commit)
        const [was, now] = [await a.sides(parent), await a.sides(e.id)]
        const same = was.bookmarks.join('\n') === now.bookmarks.join('\n') && was.tags.join('\n') === now.tags.join('\n') && was.workspaces.join('\n') === now.workspaces.join('\n')
        mine = same && shapeProblem(step.shape, { added, removed }) === null
      }
      if (mine) {
        rec.ops.push(e.id)
        for (const c of added) owns.add(c.commit)
        rec.step = undefined
      } else for (const c of added) if (!owns.has(c.commit)) uncertain.add(c.commit)
    }
    // The journal's commits must each have come from a marked operation in the walk (none recorded otherwise).
    rec.commits = [...owns]
    rec.uncertain = [...uncertain].filter((c) => !owns.has(c))
    const owned: string[] = []
    const ambiguous: string[] = []
    const collisions: string[] = []
    for (const p of rec.pins) {
      const now = await a.refNow(p.ref)
      if (p.state === 'created') {
        if (now === p.oid) owned.push(p.ref)
        else collisions.push(p.ref)
      } else if (p.state === 'intent') {
        if (now === p.oid) ambiguous.push(p.ref)
        else if (now !== null) {
          p.state = 'collision'
          p.found = now
          collisions.push(p.ref)
        }
      } else if (p.state === 'collision') collisions.push(p.ref)
    }
    await deps.journal(structuredClone(rec))
    // What it owns and isn't held by an owned or ambiguous pin is pinned now: fresh, create-only refs. Uncertain commits never.
    const held = new Set(rec.pins.filter((p) => owned.includes(p.ref) || ambiguous.includes(p.ref)).map((p) => p.oid))
    const prefix = pinPrefix(rec.card, rec.attempt)
    let n = rec.pins.length
    for (const c of rec.commits) {
      if (held.has(c)) continue
      let ref = `${prefix}r${n++}`
      while (rec.pins.some((p) => p.ref === ref)) ref = `${prefix}r${n++}`
      await a.pin(ref, c)
      owned.push(ref)
    }
    return { recovered: { attempt: rec.attempt, phase: rec.phase, commits: [...rec.commits], uncertain: [...rec.uncertain], owned, ambiguous, collisions }, record: structuredClone(rec) }
  } catch (e) {
    if (e instanceof Stop) return a.interrupted(e)
    throw e
  }
}

/** What a drop did: the refs it deleted, those it kept and why, the commits it abandoned and those it kept. */
export interface JjDropped {
  /** `keptSuccessors` (HI-3045): its hidden commits' visible successors left alone, as the user's or unclassifiable. */
  /** `reached` (HI-3150): the attempt's own visible commits the target reaches, left as they are (none pinned: a revived drop's). */
  dropped: { refs: string[]; keptRefs: { ref: string; why: 'reached' | 'kept' | 'notOwned' }[]; abandoned: string[]; kept: string[]; keptSuccessors?: JjKeptSuccessor[]; reached?: string[] }
  record: JjAttemptRecord
}

/**
 * Which of `ids` the target reaches now: an ancestor of (or) its bookmark, local or remote, as jj shows it at the single
 * head, or of its Git branch or a remote's (a Git move jj hasn't imported). A target that isn't there, is conflicted or
 * can't be read stops (nothing is taken as unreached).
 */
async function reachedNow(a: Attempt, target: string, ids: readonly string[]): Promise<{ op: string; reached: Set<string> }> {
  const op = a.head()
  const name = JSON.stringify(target)
  const tips = await a.commits(op, `bookmarks(exact:${name}) | remote_bookmarks(exact:${name})`)
  if (!tips.length) throw new Stop('malformed', 'no target') // i18n-ignore: a protocol detail for logs and tests, never shown
  const rows = lines(await a.read(op, ['bookmark', 'list', '--all-remotes', '-T', BOOKMARK_T])).map((l) => l.split(SEP))
  if (rows.some((f) => f[0] === target && f[2] === 'true')) throw new Stop('malformed', 'target conflicted') // i18n-ignore: a protocol detail for logs and tests, never shown
  const reached = new Set(ids.length ? (await a.commits(op, `${set([...ids])} & ::(bookmarks(exact:${name}) | remote_bookmarks(exact:${name}))`)).map((c) => c.commit) : [])
  for (const c of ids) {
    if (reached.has(c)) continue
    const r = await a.deps.git(['for-each-ref', '--format=%(refname)', '--contains', c, `refs/heads/${target}`, 'refs/remotes/'])
    if (!r.ok) throw new Stop('failed', r.err)
    if (lines(r.out).some((n) => n === `refs/heads/${target}` || (n.startsWith('refs/remotes/') && n.endsWith(`/${target}`)))) reached.add(c)
  }
  if (!a.reads.stillAt(op)) throw new Stop('raced', 'target read') // i18n-ignore: a protocol detail for logs and tests, never shown
  return { op, reached }
}

/**
 * The visible successors jj made of an attempt's hidden commits (HI-2990): jj's own rebase of a commit whose parent was
 * rewritten (the builder's `jj describe -r @-` under a merge candidate, say) leaves the recorded commit hidden and its
 * change id on a new visible commit, which a drop by recorded ids would leave in the user's log. Per change of the
 * attempt's hidden commits, exactly one visible commit outside the attempt's, not divergent, and the same change as the
 * attempt's last commit of that change (`jj interdiff` empty) with the same description and author (HR1's round 1):
 * rebased, never edited; a change the user made to its files or its metadata is theirs and kept. Read at the single head; never owned until the drop adopts them.
 *
 * HI-3045 (design HI-3045/s15): and only those **jj's automatic rebase** made (`automaticRebase`); one the user's own
 * operation made (their `jj rebase` of the candidate, say, before setting the target onto it) is theirs and kept, as is
 * one whose operation can't be classified (concurrent history, or a history cut short below it). Every successor is
 * classified before any is adopted, by reads alone: a read that fails stops the drop (interrupted, nothing adopted).
 */
async function successorsOf(a: Attempt): Promise<{ adopt: string[]; kept: JjKeptSuccessor[] }> {
  const rec = a.rec
  const none = { adopt: [], kept: [] }
  if (!rec.commits.length) return none
  const op = a.head()
  const shown = new Set((await a.commits(op, visibleOf(rec.commits))).map((c) => c.commit))
  const hidden = rec.commits.filter((c) => !shown.has(c))
  if (!hidden.length) return none
  // Named by their ids, hidden commits are read as they were (their change ids among them).
  const was = await a.commits(op, set(hidden))
  const mine = new Set(rec.commits)
  const found: Successor[] = []
  for (const change of new Set(was.map((c) => c.change))) {
    const now = (await a.commits(op, `change_id(${change}) & ::visible_heads()`)).filter((c) => !mine.has(c.commit))
    if (now.length !== 1 || now[0].divergent) continue
    // The attempt's latest commit of that change: its commits are recorded in the order its operations made them.
    const from = rec.commits.filter((c) => was.some((w) => w.commit === c && w.change === change)).at(-1)!
    const diff = await a.read(op, ['interdiff', '--from', from, '--to', now[0].commit, '--summary'])
    if (lines(diff).length) continue
    // Its metadata too (HR1's round 1): jj's rebase keeps the description and the author; the user's `jj describe` or
    // `jj metaedit` changes them with the files untouched, and that edit is theirs.
    const meta = async (id: string): Promise<string> => a.read(op, ['log', '--no-graph', '-r', id, '-T', META_T])
    if ((await meta(from)) !== (await meta(now[0].commit))) continue
    found.push({ pred: was.find((w) => w.commit === from)!, succ: now[0] })
  }
  const out = found.length ? await classifySuccessors(a, op, found) : none
  if (!a.reads.stillAt(op)) throw new Stop('raced', 'successors read') // i18n-ignore: a protocol detail for logs and tests, never shown
  return out
}

/** A hidden commit of the attempt's, and the visible successor of its change. */
interface Successor {
  pred: JjCommit
  succ: JjCommit
}

/** A successor the drop left alone (HI-3045): made by the user's own operation, or by one that couldn't be classified. */
export interface JjKeptSuccessor {
  commit: string
  why: 'user' | 'concurrent' | 'history'
}

/** The operation that made a commit, and that operation's parents, as `jj evolog` names them (one entry). */
const EVOLOG_OP_T = `operation.id() ++ "${SEP}" ++ operation.parents().map(|o| o.id()).join(",") ++ "\\n"`
const OP_ID = /^[0-9a-f]{128}$/
const ROOT_OP = /^0+$/

/**
 * HI-3045: the successors grouped by the operation that made each (one `jj evolog` read each, at the head), each group
 * decided whole: an operation with several parents (concurrent history) or with the root as its parent (history cut
 * short below it: `jj op abandon`) can't be classified, and its successors are kept; else `automaticRebase` decides.
 * Reads only, every group decided before anything is adopted.
 */
async function classifySuccessors(a: Attempt, head: string, found: Successor[]): Promise<{ adopt: string[]; kept: JjKeptSuccessor[] }> {
  const groups = new Map<string, { parents: string[]; list: Successor[] }>()
  for (const f of found) {
    const [l, ...more] = lines(await a.read(head, ['evolog', '--no-graph', '--limit', '1', '-r', f.succ.commit, '-T', EVOLOG_OP_T]))
    const parts = l?.split(SEP)
    if (!parts || more.length || parts.length !== 2 || !OP_ID.test(parts[0])) throw new Stop('malformed', l)
    const parents = parts[1] ? parts[1].split(',') : []
    if (!parents.every((p) => OP_ID.test(p))) throw new Stop('malformed', l)
    const g = groups.get(parts[0]) ?? { parents, list: [] }
    g.list.push(f)
    groups.set(parts[0], g)
  }
  const adopt: string[] = []
  const kept: JjKeptSuccessor[] = []
  const keep = (list: Successor[], why: JjKeptSuccessor['why']): void => void kept.push(...list.map((f) => ({ commit: f.succ.commit, why })))
  for (const [op, g] of groups) {
    if (g.parents.length !== 1) keep(g.list, 'concurrent')
    else if (ROOT_OP.test(g.parents[0])) keep(g.list, 'history')
    else if (await automaticRebase(a, head, op, g.parents[0], g.list)) adopt.push(...g.list.map((f) => f.succ.commit))
    else keep(g.list, 'user')
  }
  return { adopt, kept }
}

/**
 * HI-3045 (HI-3045/s15 §1): whether operation `op` (parent `parent`) made these successors by jj's automatic rebase of
 * descendants, the only shape adopted: for each, its parents in order are its predecessor's, each either (inside the
 * attempt) that commit's own successor in this group, or (outside) the same commit or that parent's change **rewritten
 * in place** by `op` (made by it, its own parents the same changes: a describe, metaedit, squash-into, amend or
 * absorb, never a move), and, for each root (a successor with a parent outside the attempt), at least one of its own
 * outside parents so rewritten. Anything else (a parent of another change, a
 * parent moved, a successor whose parents don't line up) is the user's operation, or ambiguous: false, so it stays.
 */
async function automaticRebase(a: Attempt, head: string, op: string, parent: string, list: Successor[]): Promise<boolean> {
  const mine = new Set(a.rec.commits)
  const byChange = new Map(list.map((f) => [f.pred.change, f.succ.commit]))
  const changeOf = async (ids: readonly string[]): Promise<Map<string, string>> => new Map((await a.commits(head, set([...new Set(ids)]))).map((c) => [c.commit, c.change]))
  // HR2's round 1: the rewrite is required of each root (one with a parent outside the attempt), never shared across the
  // group, so one root's rebased parent can't vouch for another root rewritten with its parents unchanged (ambiguous).
  let roots = 0
  for (const { pred, succ } of list) {
    if (pred.parents.length !== succ.parents.length) return false
    const root = pred.parents.some((p) => !mine.has(p))
    let rewritten = false
    const inside = pred.parents.filter((p) => mine.has(p))
    const insideChange = inside.length ? await changeOf(inside) : new Map<string, string>()
    for (let i = 0; i < pred.parents.length; i++) {
      const p = pred.parents[i]
      const q = succ.parents[i]
      if (mine.has(p)) {
        if (byChange.get(insideChange.get(p) ?? '') !== q) return false
        continue
      }
      if (q === p) continue
      const pair = await a.commits(head, set([p, q]))
      const pc = pair.find((c) => c.commit === p)
      const qc = pair.find((c) => c.commit === q)
      if (!pc || !qc || pc.change !== qc.change) return false
      // Made by `op`: visible there, not at its parent (where it may not exist yet: `present`, so naming it isn't an error).
      if ((await a.commits(parent, `present(${q}) & ::visible_heads()`)).length || !(await a.commits(op, visibleOf([q]))).length) return false
      // In place: its own parents the same changes, in order.
      const ch = await changeOf([...pc.parents, ...qc.parents])
      const changes = (ids: readonly string[]): string => ids.map((x) => ch.get(x) ?? `?${x}`).join(',')
      if (changes(pc.parents) !== changes(qc.parents)) return false
      rewritten = true
    }
    if (root && !rewritten) return false
    if (root) roots++
  }
  return roots > 0
}

/**
 * An attempt's clean-up (s14 §11, s17 §1–2, HR2's round 1): its still-visible commits abandoned (guarded), then its owned
 * refs deleted with exact-old deletes. Refused for anything the target reaches (the candidate, or any pinned commit, an
 * ancestor of the target bookmark, local or remote, or of its Git branch), read again under the lock right before each
 * delete: a target that moved onto a pinned commit meanwhile stops the drop with that pin and the rest kept. Refused
 * whole while the record has uncertain commits (recovery's), and when the target can't be read. Ambiguous and colliding
 * refs are never deleted. The successors jj made of its hidden commits (`successorsOf`, HI-2990) are adopted first.
 */
export async function dropJjAttempt(deps: JjCandidateDeps, record: JjAttemptRecord, target: string): Promise<JjDropped | JjInterrupted> {
  const rec = structuredClone(record)
  const a = new Attempt(deps, rec)
  try {
    a.check()
    if (rec.uncertain?.length) throw new Stop('uncertain', rec.uncertain.join(','))
    // A write whose operation was never validated (interrupted mid-step): recovery first.
    if (rec.step) throw new Stop('uncertain', `step:${rec.step.name}`)
    const owned = rec.pins.filter((p) => p.state === 'created')
    const ids0 = [...new Set([...rec.commits, ...owned.map((p) => p.oid)])]
    // HI-3045: those the user's own operation made, or one that couldn't be classified, are kept (`keptSuccessors`).
    const { adopt: successors, kept: keptSuccessors } = await successorsOf(a)
    const r0 = await reachedNow(a, target, [...ids0, ...successors])
    // HI-2990: the successors jj made of the attempt's commits (none the target reaches) adopted, journalled and pinned
    // before anything is abandoned, so they are dropped with the rest, guarded as the rest.
    const adopt = successors.filter((c) => !r0.reached.has(c))
    if (adopt.length) {
      rec.commits.push(...adopt)
      await deps.journal(structuredClone(rec))
      const prefix = pinPrefix(rec.card, rec.attempt)
      let n = rec.pins.length
      for (const c of adopt) {
        let ref = `${prefix}s${n++}`
        while (rec.pins.some((p) => p.ref === ref)) ref = `${prefix}s${n++}`
        await a.pin(ref, c)
      }
    }
    const ids = [...ids0, ...adopt]
    const { op, reached } = adopt.length ? await reachedNow(a, target, ids) : r0
    const visible = (await a.commits(op, visibleOf(ids))).map((c) => c.commit)
    // HI-3150: an owned commit visible again with no pin holding it (a dropped attempt the user's `jj op restore` brought
    // back: its pins were deleted with the drop) is pinned again first, as HI-2990's adopted successors are, so the
    // guarded abandon below may take it; what the target reaches is never pinned or abandoned.
    const held = new Set(rec.pins.filter((p) => p.state === 'created').map((p) => p.oid))
    const repin = visible.filter((c) => !reached.has(c) && rec.commits.includes(c) && !held.has(c))
    if (repin.length) {
      const prefix = pinPrefix(rec.card, rec.attempt)
      let n = rec.pins.length
      for (const c of repin) {
        let ref = `${prefix}r${n++}`
        while (rec.pins.some((p) => p.ref === ref)) ref = `${prefix}r${n++}`
        await a.pin(ref, c)
      }
    }
    const kept = visible.length ? await a.abandon(visible.filter((c) => !reached.has(c) && rec.commits.includes(c))) : []
    const keptRefs: JjDropped['dropped']['keptRefs'] = []
    const dropped: string[] = []
    const keepOid = new Set([...reached, ...kept])
    for (const p of rec.pins) {
      if (p.state !== 'created') {
        if (p.state !== 'dropped') keptRefs.push({ ref: p.ref, why: 'notOwned' }) // i18n-ignore: a protocol detail for logs and tests, never shown
        continue
      }
      if (keepOid.has(p.oid)) {
        keptRefs.push({ ref: p.ref, why: reached.has(p.oid) ? 'reached' : 'kept' }) // i18n-ignore: a protocol detail for logs and tests, never shown
        continue
      }
      await deps.lock(async () => {
        await a.hook(`beforeDelete:${p.ref}`)
        // The target read again at the delete's own boundary: exact-old deletion guards the pin's value, not containment.
        const now = await reachedNow(a, target, [p.oid])
        if (now.reached.has(p.oid)) throw new Stop('raced', `target reaches ${p.oid}`) // i18n-ignore: a protocol detail for logs and tests, never shown
        a.check()
        const r = await deps.git(['update-ref', '-d', p.ref, p.oid])
        const left = await a.refNow(p.ref)
        if (!r.ok || left !== null) throw new Stop('raced', `delete:${p.ref}`)
        p.state = 'dropped'
        dropped.push(p.ref)
        await deps.journal(structuredClone(rec))
      })
    }
    await a.phase('dropped')
    const reachedOwn = visible.filter((c) => reached.has(c) && rec.commits.includes(c))
    return { dropped: { refs: dropped, keptRefs, abandoned: [...(rec.abandoned ?? [])], kept, ...(keptSuccessors.length ? { keptSuccessors } : {}), ...(reachedOwn.length ? { reached: reachedOwn } : {}) }, record: structuredClone(rec) }
  } catch (e) {
    if (e instanceof Stop) return a.interrupted(e)
    throw e
  }
}

/**
 * Where a candidate stands now, read pinned: `current` (its commit visible), `superseded` (hidden, its change id now
 * another visible commit: jj rebased it, e.g. a merge candidate after the builder rewrote the reviewed commit, so the
 * recorded commit no longer names what jj shows), or `gone` (abandoned). The recorded commit never moves: a superseded
 * candidate is never offered as the recorded one.
 */
export async function jjCandidateNow(deps: Pick<JjCandidateDeps, 'runner' | 'view' | 'folder' | 'signal' | 'timeout'>, c: { result: string; change: string }): Promise<JjMaybe<'current' | 'superseded' | 'gone'>> {
  const reads = new JjReads({ folder: deps.folder, jjRepo: deps.view.jjRepo }, deps.runner, { signal: deps.signal, timeout: deps.timeout })
  const p = await reads.pinned(async (op): Promise<JjMaybe<'current' | 'superseded' | 'gone'>> => {
    const shown = await reads.run(op, ['log', '--no-graph', '-r', `${c.result} & ::visible_heads()`, '-T', 'commit_id ++ "\n"'])
    if (isJjUnknown(shown)) return shown
    if (lines(shown).length) return 'current'
    const now = await reads.changeAt(op, c.change)
    if (isJjUnknown(now)) return now
    return now.length ? 'superseded' : 'gone'
  })
  return isJjUnknown(p) ? p : p.value
}
