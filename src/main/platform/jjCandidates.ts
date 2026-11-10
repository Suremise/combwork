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
import { CANDIDATE_TEXT } from './candidateText'
import type { CandidateTestFail } from './integration'
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
  pins: JjPin[]
  abandoned?: string[]
  kept?: string[]
}

/** Why an attempt stopped short: never a candidate, a retained-evidence failure, or anything to act on but recovery. */
export type JjInterruptWhy = 'owner' | 'cancelled' | 'raced' | 'heads' | 'failed' | 'malformed' | 'pin' | 'kept' | 'tool' | 'gone'

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
  /** How many operations recovery walks back at most (default 200): past it, unknown. */
  opsLimit?: number
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
}

const SEP = '\u001f'
const ZERO = '0'.repeat(40)
const ATTEMPT = /^[a-z0-9]{6,40}$/
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
const CONFLICT_T = `if(conflict, path ++ "${SEP}" ++ conflict_side_count ++ "\\n")`

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
   * the identity), then validated (deltaProblem) and its added commits read at the new head. `expect` says whether the
   * delta is what this step should have made.
   */
  async write(name: string, args: readonly string[], expect: (d: JjOpDelta) => string | null): Promise<JjOpDelta> {
    return this.deps.lock(async () => {
      this.check()
      const parent = this.head()
      const before = { ...(await this.sides(parent)), refs: await this.refs() }
      await this.hook(`beforeWrite:${name}`)
      if (this.head() !== parent) throw new Stop('raced', `beforeWrite:${name}`)
      this.check()
      const who = this.deps.identity ? [`--config=user.name=${toml(this.deps.identity.name)}`, `--config=user.email=${toml(this.deps.identity.email)}`] : []
      const r = await this.deps.runner.run(this.deps.folder, ['--ignore-working-copy', '--config=snapshot.auto-update-stale=false', marker(this.rec.attempt), ...who, ...args], { write: true, signal: this.deps.signal, timeout: this.deps.timeout })
      if (r.cancelled) throw new Stop('cancelled', name)
      const heads = readOpHeads(this.deps.view.jjRepo)
      if (!heads || heads.length !== 1) throw new Stop('raced', `heads after ${name}`) // i18n-ignore: a protocol detail for logs and tests, never shown
      const op = heads[0]
      if (op === parent) throw new Stop('failed', r.err || `${name}: no operation`) // i18n-ignore: a protocol detail for logs and tests, never shown
      const entry = await this.opEntry(op)
      const added = await this.commits(op, `::visible_heads() ~ ::at_operation(${parent}, visible_heads())`)
      const removed = (await this.commits(op, `at_operation(${parent}, ::visible_heads()) ~ ::visible_heads()`)).map((c) => c.commit)
      const after = { ...(await this.sides(op)), refs: await this.refs() }
      const why = deltaProblem({ entry, parent, attempt: this.rec.attempt, before, after, added: added.map((c) => c.commit), removed })
      if (why) throw new Stop('raced', `${name}: ${why}`)
      if (this.head() !== op) throw new Stop('raced', `after ${name}`) // i18n-ignore: a protocol detail for logs and tests, never shown
      const d: JjOpDelta = { op, parent, added, removed }
      const bad = expect(d)
      if (bad) throw new Stop('raced', `${name}: ${bad}`)
      // Only now are its commits the attempt's: an operation validated as its own.
      this.rec.ops.push(op)
      for (const c of added) if (!this.rec.commits.includes(c.commit)) this.rec.commits.push(c.commit)
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
    // Held: an owned pin, or a journalled intent whose ref holds exactly the commit now (recovery's ambiguous: not owned,
    // never deleted, but it keeps the commit reachable all the same).
    const held = new Set(this.rec.pins.filter((p) => p.state === 'created').map((p) => p.oid))
    for (const p of this.rec.pins) if (p.state === 'intent' && !held.has(p.oid) && (await this.refNow(p.ref)) === p.oid) held.add(p.oid)
    if (owned.some((c) => !held.has(c))) throw new Stop('pin', 'abandon before pin') // i18n-ignore: a protocol detail for logs and tests, never shown
    await this.phase('abandoning')
    await this.hook(`beforeAbandon:${owned.length}`)
    const op = this.head()
    const visible = new Set((await this.commits(op, visibleOf(owned))).map((c) => c.commit))
    const live = owned.filter((c) => visible.has(c))
    const guard = guardedSet(live)
    const will = live.length ? (await this.commits(op, guard)).map((c) => c.commit) : []
    const kept = live.filter((c) => !will.includes(c))
    if (will.length) {
      await this.write('abandon', ['abandon', '-r', guard], (d) => (d.added.length ? 'rebased' : sameSet(d.removed, will) ? null : 'abandoned'))
    }
    this.rec.abandoned = [...(this.rec.abandoned ?? []), ...will]
    this.rec.kept = kept
    await this.phase('abandoned')
    await this.hook('abandoned')
    return kept
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
async function conflictsOf(a: Attempt, op: string, commits: readonly JjCommit[]): Promise<{ files: string[]; record: ConflictsRecord; evidence: string[] } | null> {
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
  return { files, record: { oursIs: 'target', files: read, ...(files.length > CONFLICT_LIMITS.files ? { filesLeft: files.length - CONFLICT_LIMITS.files } : {}) }, evidence: conflicted.map((c) => c.commit) }
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
  const rev = await reads.commitAt(h0, req.revision)
  if (isJjUnknown(rev)) return rev
  const exp = await reads.commitAt(h0, req.expected)
  if (isJjUnknown(exp)) return exp
  if (!reads.stillAt(h0)) return jjUnknown('moved')
  if (rev.divergent || exp.divergent) return jjUnknown('ambiguous', 'divergent')

  const rec: JjAttemptRecord = { attempt: req.attempt, card: req.card, style: req.style, revision: req.revision, base: req.base, expected: req.expected, phase: 'planned', baseOp: h0, ops: [], commits: [], pins: [] }
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
      const d = await a.write('duplicate', ['duplicate', '-r', `${req.base}..${req.revision}`, '--onto', req.expected], (x) => {
        if (x.removed.length || x.added.length !== suffix.length) return 'shape'
        const h = headOf(x.added)
        const roots = x.added.filter((c) => !c.parents.some((p) => x.added.some((y) => y.commit === p)))
        if (!h || roots.length !== 1 || roots[0].parents.join() !== req.expected) return 'shape'
        return null
      })
      rec.result = headOf(d.added)!.commit
    } else if (req.style === 'merge') {
      await a.phase('writing')
      const d = await a.write('merge', ['new', req.expected, req.revision, '--no-edit', '-m', req.message], (x) => (x.removed.length || x.added.length !== 1 || x.added[0].parents.join() !== `${req.expected},${req.revision}` ? 'shape' : null))
      rec.result = d.added[0].commit
    } else {
      await a.phase('writing')
      const m = await a.write('scratch', ['new', req.expected, req.revision, '--no-edit', '-m', `combwork scratch ${req.attempt}`], (x) => (x.removed.length || x.added.length !== 1 || x.added[0].parents.join() !== `${req.expected},${req.revision}` ? 'shape' : null)) // i18n-ignore: a protocol detail for logs and tests, never shown
      const merged = m.added[0].commit
      const s = await a.write('squash', ['new', req.expected, '--no-edit', '-m', req.message], (x) => (x.removed.length || x.added.length !== 1 || x.added[0].parents.join() !== req.expected ? 'shape' : null))
      const empty = s.added[0].commit
      const t = await a.write('restore', ['restore', '--from', merged, '--into', empty], (x) => (x.removed.join() !== empty || x.added.length !== 1 || x.added[0].parents.join() !== req.expected || x.added[0].change !== s.added[0].change ? 'shape' : null))
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
    await a.phase('done')
    const stays = rec.commits.filter((c) => !(rec.abandoned ?? []).includes(c) && c !== rec.result).concat(result.commit)
    return { candidate: { result: result.commit, commits: (await a.commits(at, visibleOf(stays))).map((c) => c.commit), change: result.change, op: at, refs: a.owned() }, record: structuredClone(rec) }
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

/** What recovery found of an attempt: never a success, never anything abandoned or dropped. */
export interface JjRecovered {
  recovered: {
    attempt: string
    phase: JjAttemptPhase
    /** Commits the attempt's own validated operations added (provenance: their marker, never a description). */
    commits: string[]
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
 * An interrupted attempt's recovery (s14 §11, s17 §1): explicit, its later caller's to run. Its objects are found only by
 * provenance: operations carrying its marker, walking back from the single head to its planned operation (bounded), and
 * the commits their views added; refs only through its journal's pins. What is unpinned is pinned (create-only); nothing
 * is abandoned or dropped, and the answer is never a candidate.
 */
export async function recoverJjAttempt(deps: JjCandidateDeps, record: JjAttemptRecord): Promise<JjRecovered | JjInterrupted> {
  const rec = structuredClone(record)
  const a = new Attempt(deps, rec)
  try {
    a.check()
    const head = a.head()
    const limit = deps.opsLimit ?? 200
    const log: JjOpEntry[] = []
    for (const l of lines(await a.read(head, ['op', 'log', '--no-graph', '--limit', String(limit + 1), '-T', OP_T]))) {
      const e = parseOpLine(l)
      if (!e) throw new Stop('malformed', l)
      log.push(e)
    }
    const reach = log.findIndex((e) => e.id === rec.baseOp)
    if (reach < 0) throw new Stop('malformed', log.length > limit ? 'history:capped' : 'history:baseOp')
    const commits: string[] = []
    for (const e of log.slice(0, reach).reverse()) {
      if (!markerIn(e.args, rec.attempt)) continue
      if (e.parents.length !== 1) throw new Stop('malformed', `merge op ${e.id}`) // i18n-ignore: a protocol detail for logs and tests, never shown
      for (const c of await a.commits(e.id, `::visible_heads() ~ ::at_operation(${e.parents[0]}, visible_heads())`)) if (!commits.includes(c.commit)) commits.push(c.commit)
    }
    // The journal's commits must be among them (a commit it recorded and no marked operation made isn't the attempt's).
    if (rec.commits.some((c) => !commits.includes(c))) throw new Stop('malformed', 'journal commits not found') // i18n-ignore: a protocol detail for logs and tests, never shown
    rec.commits = commits
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
    // What isn't held by an owned or ambiguous pin is pinned now: fresh, create-only refs.
    const held = new Set(rec.pins.filter((p) => owned.includes(p.ref) || ambiguous.includes(p.ref)).map((p) => p.oid))
    const prefix = pinPrefix(rec.card, rec.attempt)
    let n = rec.pins.length
    for (const c of commits) {
      if (held.has(c)) continue
      let ref = `${prefix}r${n++}`
      while (rec.pins.some((p) => p.ref === ref)) ref = `${prefix}r${n++}`
      await a.pin(ref, c)
      owned.push(ref)
    }
    return { recovered: { attempt: rec.attempt, phase: rec.phase, commits, owned, ambiguous, collisions }, record: structuredClone(rec) }
  } catch (e) {
    if (e instanceof Stop) return a.interrupted(e)
    throw e
  }
}

/** What a drop did: the refs it deleted, those it kept and why, the commits it abandoned and those it kept. */
export interface JjDropped {
  dropped: { refs: string[]; keptRefs: { ref: string; why: 'reached' | 'kept' | 'notOwned' }[]; abandoned: string[]; kept: string[] }
  record: JjAttemptRecord
}

/**
 * An attempt's clean-up (s14 §11, s17 §1–2): its still-visible commits abandoned (guarded), then its owned refs deleted
 * with exact-old deletes. Refused for anything the target reaches (the candidate, or any pinned commit, an ancestor of
 * the target bookmark's commit, local or remote) and when that can't be read: those commits and pins stay. Ambiguous and
 * colliding refs are never deleted.
 */
export async function dropJjAttempt(deps: JjCandidateDeps, record: JjAttemptRecord, target: string): Promise<JjDropped | JjInterrupted> {
  const rec = structuredClone(record)
  const a = new Attempt(deps, rec)
  try {
    a.check()
    const op = a.head()
    const name = JSON.stringify(target)
    const tips = await a.commits(op, `bookmarks(exact:${name}) | remote_bookmarks(exact:${name})`)
    if (!tips.length) throw new Stop('malformed', 'no target') // i18n-ignore: a protocol detail for logs and tests, never shown
    const rows = lines(await a.read(op, ['bookmark', 'list', '--all-remotes', '-T', BOOKMARK_T])).map((l) => l.split(SEP))
    if (rows.some((f) => f[0] === target && f[2] === 'true')) throw new Stop('malformed', 'target conflicted') // i18n-ignore: a protocol detail for logs and tests, never shown
    const owned = rec.pins.filter((p) => p.state === 'created')
    const ids = [...new Set([...rec.commits, ...owned.map((p) => p.oid)])]
    const reached = new Set((await a.commits(op, `${set(ids)} & ::(bookmarks(exact:${name}) | remote_bookmarks(exact:${name}))`)).map((c) => c.commit))
    const visible = (await a.commits(op, visibleOf(ids))).map((c) => c.commit)
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
        const r = await deps.git(['update-ref', '-d', p.ref, p.oid])
        const now = await a.refNow(p.ref)
        if (!r.ok || now !== null) throw new Stop('raced', `delete:${p.ref}`)
        p.state = 'dropped'
        dropped.push(p.ref)
        await deps.journal(structuredClone(rec))
      })
    }
    await a.phase('dropped')
    return { dropped: { refs: dropped, keptRefs, abandoned: [...(rec.abandoned ?? [])], kept }, record: structuredClone(rec) }
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
