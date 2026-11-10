// jj's target-advance EVIDENCE PROBE (SPEC §16.3.6 "Open: jj's target advance", HI-2794's J1). A diagnostic, not a
// protocol: it runs one advance attempt on jj 0.47.1's CLI, step by step, and records what it observed, so the real-jj
// fixtures (tests/jjAdvanceProbeReal.test.ts) can show where the tested CLI protocol falls short of R4.1. The tested
// jj 0.47.1 CLI protocol does not meet R4.1, and no conforming protocol has been proved: gate:advance stays CLOSED.
//
// NOTHING IN COMBWORK MAY USE THIS TO ADVANCE A TARGET. It is in no port (repoPorts.ts, integrationPorts.ts), writes no
// fact, and only tests import it (tests/jjAdvanceProbeImports.test.ts fails otherwise). Its verdicts are observations,
// not a linearizable compare-and-swap result: reading the same heads and refs twice detects some torn reads but can't
// exclude ABA or a writer moving right after a read, so `advancedObserved` is never Integrated evidence and
// `notApplied` is never permission for an automatic retry. A future product integration still needs the repository
// lock, the folder fence and the lease (R4.2); the injected lease here only stops further commands in a test.
//
// The steps (each mutation journaled first, the lease checked just before it):
//   base      read at the current single operation P0 (`--at-op`, never merging): T, T@git, the Git ref, every
//             worktree's HEAD, pending exports; refuse anything but T = T@git = ref = E with nothing pending.
//   prepare   `jj --at-op P0 --no-integrate-operation bookmark move T --from E --to R`: an operation O, not yet a head.
//             Validated: its parent is P0, it carries this attempt's marker, and its view differs from P0's only in T.
//   integrate `jj op integrate O`.
//   export    `jj git export` (it exports every pending ref and detaches Git checkouts of what it moves: jj 0.47.1's
//             export_refs / check_and_detach_head, reproduced by the fixtures).
//   observe   every head and its ancestry back to P0, each view, the Git refs and worktrees, twice; then classify.
// jj's own files and texts used here (op_heads/heads, the uncommitted-operation line, the `args` attribute) are this
// version's mechanics, not an API: anything unexpected is Unknown, never worked around.

import { readdir } from 'original-fs/promises'
import { join } from 'path'
import type { RunResult } from './repoContext'
import { JJ_READ, type JjRunner } from './jjRunner'

/** jj's platform literal, as J2's WorkspacePort carries it (HI-2795: `JjPlatform`); not a PlatformId (J6's switch). */
export type JjPlatform = 'jj'

/** The attempt, immutable and journaled before anything else: whose it is, in which store, and which move. */
export interface JjAdvanceIntent {
  /** This attempt's id, carried by each of its jj commands as a marker (`--config=combwork.txn="<txn>"`, kept in `args`). */
  txn: string
  platform: JjPlatform
  /** The backing Git store (JjContext.store): the repository lock's key (R1.1). */
  store: string
  /** The jj repository's shared folder (JjContext.jjRepo), where the operation heads are. */
  jjRepo: string
  /** The workspace root the commands run in. */
  root: string
  /** The target bookmark, and the full commit ids it is expected at and moved to. */
  target: string
  expected: string
  result: string
  /** The run or lease the attempt belongs to (attribution only: the probe writes no fact). */
  lease: string
}

/** How far an attempt got. A `…ing` phase is journaled before its command runs, its `…ed` after it answered. */
export type JjProbePhase = 'requested' | 'based' | 'preparing' | 'prepared' | 'integrating' | 'integrated' | 'exporting' | 'exported'
const PHASES: readonly JjProbePhase[] = ['requested', 'based', 'preparing', 'prepared', 'integrating', 'integrated', 'exporting', 'exported']
const at = (p: JjProbePhase): number => PHASES.indexOf(p)

/** The journal's record of an attempt: the intent, its phase, P0 and the Git side seen there, and O once known. */
export interface JjProbeRecord {
  intent: JjAdvanceIntent
  phase: JjProbePhase
  baseOp?: string
  base?: GitSnapshot
  op?: string
}

/** One bookmark row of an operation's view: local (`remote` empty) or a remote's (`git` is jj's record of the Git ref). */
export interface BookmarkRow {
  name: string
  remote: string
  conflict: boolean
  /** The single target, or '' when conflicted or absent. */
  target: string
  added: string[]
  removed: string[]
}

/** An operation's view, as far as the probe compares it. */
export interface OpView {
  bookmarks: BookmarkRow[]
  tags: { name: string; target: string }[]
  visibleHeads: string[]
}

/** An operation in a head's ancestry: its id, its parents and its `args` attribute. */
export interface OpEntry {
  id: string
  parents: string[]
  args: string
}

/** The Git side: every ref under refs/heads and refs/tags, and each worktree's HEAD (a branch, or detached at a commit). */
export interface GitSnapshot {
  refs: Record<string, string>
  worktrees: { path: string; head: string; branch: string | null }[]
}

/** One operation head, read pinned (`--at-op`): its ancestry (newest first, up to the bound) and its view. */
export interface HeadObservation {
  op: string
  ancestry: OpEntry[]
  /** The ancestry reached the base operation (or the bound wasn't hit): nothing between it and P0 is missing. */
  complete: boolean
  view: OpView
}

/** Everything observed at the end, each part read twice: a part that differed between its reads is torn. */
export type JjObservation = { unreadable: string } | { heads: HeadObservation[]; headsStable: boolean; git: GitSnapshot; gitStable: boolean }

/**
 * What the probe observed (never a CAS result; see the header):
 * - `advancedObserved`: O in every head's history, and T = T@git = the Git ref = R, nothing else moved on the Git side.
 * - `notApplied`: positive evidence this attempt changed nothing (no mutation started, or none of its operations in any
 *   head's complete history and no integration attempted).
 * - `moved`, `conflicted`, `partialExport`, `pendingExports`, `targetCheckedOut`, `divergentStart`: the state refused at
 *   base, or found at the end.
 * - `checkoutDetached`: a worktree's HEAD changed (jj's export detaches Git checkouts of what it moves).
 * - `foreignRefs`: Git refs other than T changed during the attempt (jj's export writes every pending ref).
 * - `leaseLost`: the injected lease was gone before a mutation; nothing more ran.
 * - `unknown`: anything not proved either way, with a code saying why.
 */
export type JjProbeVerdict =
  | { kind: 'advancedObserved' }
  | { kind: 'notApplied'; code: 'noMutation' | 'notInHistory' }
  | { kind: 'moved'; actual: string; where: 'jj' | 'git' }
  | { kind: 'conflicted'; added: string[]; removed: string[] }
  | { kind: 'partialExport'; local: string; tracked: string; gitRef: string }
  | { kind: 'pendingExports'; refs: string[] }
  | { kind: 'targetCheckedOut'; worktrees: string[] }
  | { kind: 'divergentStart'; heads: number }
  | { kind: 'checkoutDetached'; worktrees: string[] }
  | { kind: 'foreignRefs'; refs: string[] }
  | { kind: 'leaseLost'; before: JjProbePhase }
  | { kind: 'unknown'; code: string; detail?: string }

/** Where a fixture's racer runs: between the probe's steps, and between the observation's individual reads. */
export type JjProbePoint = 'based' | 'prepared' | 'beforeIntegrate' | 'integrated' | 'beforeExport' | 'exported' | `observe:${string}`

/** What the probe is given: the J0 runner, a Git reader (the store's), the journal, the lease, and a fixture's hook. */
export interface JjProbeDeps {
  runner: JjRunner
  /** Runs `git --git-dir <store> --no-optional-locks <args>` (a read; the probe never writes through Git). */
  git: (args: readonly string[]) => Promise<RunResult>
  /** Durable before the step it names (R4.3's shape; the probe's caller keeps it). */
  journal: (r: JjProbeRecord) => Promise<void> | void
  /** Whether the attempt still holds its lease: checked just before each mutation (R4.2's shape). */
  leaseHeld: () => Promise<boolean> | boolean
  hook?: (point: JjProbePoint, r: JjProbeRecord) => Promise<void> | void
  /** How many operations of a head's ancestry are read at most (default 2000): past it, incomplete (Unknown). */
  ancestryLimit?: number
}

const SEP = '\u001f'
const HEX = /^[0-9a-f]+$/
const marker = (txn: string): string => `--config=combwork.txn="${txn}"`
const markerIn = (args: string, txn: string): boolean => args.includes(`combwork.txn="${txn}"`) || args.includes(`combwork.txn=\\"${txn}\\"`)

const BOOKMARK_T = `name ++ "${SEP}" ++ if(remote, remote, "") ++ "${SEP}" ++ conflict ++ "${SEP}" ++ if(normal_target, normal_target.commit_id(), "") ++ "${SEP}" ++ added_targets.map(|c| c.commit_id()).join(",") ++ "${SEP}" ++ removed_targets.map(|c| c.commit_id()).join(",") ++ "\\n"`
const TAG_T = `name ++ "${SEP}" ++ if(normal_target, normal_target.commit_id(), "") ++ "\\n"`
const OP_T = `id ++ "${SEP}" ++ parents.map(|p| p.id()).join(",") ++ "${SEP}" ++ attributes ++ "\\n"`

class Unreadable extends Error {}
const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.length > 0)
const ids = (s: string): string[] => (s ? s.split(',') : [])

/** Parses `bookmark list --all-remotes` with BOOKMARK_T. */
export function parseBookmarks(out: string): BookmarkRow[] {
  return lines(out).map((l) => {
    const f = l.split(SEP)
    if (f.length !== 6) throw new Unreadable(`bookmark row: ${l}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    return { name: f[0], remote: f[1], conflict: f[2] === 'true', target: f[3], added: ids(f[4]), removed: ids(f[5]) }
  })
}

/** Parses `op log` with OP_T (an `args` attribute may hold anything but the separator and a newline). */
export function parseOps(out: string): OpEntry[] {
  return lines(out).map((l) => {
    const f = l.split(SEP)
    if (f.length !== 3 || !HEX.test(f[0])) throw new Unreadable(`op row: ${l}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    return { id: f[0], parents: ids(f[1]), args: f[2] }
  })
}

/** Parses `git worktree list --porcelain`. */
export function parseWorktrees(out: string): GitSnapshot['worktrees'] {
  const found: GitSnapshot['worktrees'] = []
  for (const block of out.split(/\r?\n\r?\n/)) {
    const ls = lines(block)
    if (!ls.length) continue
    const path = ls.find((l) => l.startsWith('worktree '))?.slice(9)
    const head = ls.find((l) => l.startsWith('HEAD '))?.slice(5)
    if (ls.includes('bare')) continue
    if (!path || !head) throw new Unreadable(`worktree block: ${block}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    found.push({ path, head, branch: ls.find((l) => l.startsWith('branch '))?.slice(7) ?? null })
  }
  return found
}

const local = (v: OpView, name: string): BookmarkRow | undefined => v.bookmarks.find((b) => b.name === name && b.remote === '')
const tracked = (v: OpView, name: string): BookmarkRow | undefined => v.bookmarks.find((b) => b.name === name && b.remote === 'git')
const rowKey = (b: BookmarkRow): string => [b.name, b.remote, b.conflict, b.target, b.added.join(','), b.removed.join(',')].join(SEP)

/**
 * Bookmarks and tags whose jj value Git doesn't have yet (or has, deleted in jj): what `jj git export` would write
 * besides T. A local bookmark without a `git` row, or differing from it, a `git` row without a local one, a jj tag
 * differing from Git's.
 */
export function pendingExports(v: OpView, git: GitSnapshot, except?: string): string[] {
  const out: string[] = []
  for (const b of v.bookmarks) {
    if (b.name === except) continue
    if (b.remote === '' && (b.conflict || tracked(v, b.name)?.target !== b.target)) out.push(`refs/heads/${b.name}`)
    if (b.remote === 'git' && !local(v, b.name)) out.push(`refs/heads/${b.name}`)
  }
  for (const t of v.tags) if (git.refs[`refs/tags/${t.name}`] !== t.target) out.push(`refs/tags/${t.name}`)
  return [...new Set(out)].sort()
}

/**
 * Whether O is exactly this attempt's move: one parent, P0; this attempt's marker; and its view P0's but for T's local
 * row, E → R (T@git, every other bookmark, the tags and the visible heads unchanged). A version-specific check: any
 * other difference fails it.
 */
export function validPrepared(intent: JjAdvanceIntent, baseOp: string, o: OpEntry, p0: OpView, ov: OpView): string | null {
  if (o.parents.length !== 1 || o.parents[0] !== baseOp) return 'parent'
  if (!markerIn(o.args, intent.txn)) return 'marker'
  const was = local(p0, intent.target)
  const now = local(ov, intent.target)
  if (!was || was.conflict || was.target !== intent.expected) return 'baseView'
  if (!now || now.conflict || now.target !== intent.result) return 'opView'
  const others = (v: OpView): string[] => v.bookmarks.filter((b) => !(b.name === intent.target && b.remote === '')).map(rowKey).sort()
  if (JSON.stringify(others(p0)) !== JSON.stringify(others(ov))) return 'otherBookmarks'
  if (JSON.stringify(p0.tags) !== JSON.stringify(ov.tags)) return 'tags'
  if (JSON.stringify([...p0.visibleHeads].sort()) !== JSON.stringify([...ov.visibleHeads].sort())) return 'visibleHeads'
  return null
}

/**
 * The base check (pure): the single head P0's view and the Git side must say T = T@git = ref = E, nothing pending to
 * export, and T checked out in no worktree (jj's export would detach it). Anything else is refused, with what was seen.
 */
export function baseVerdict(intent: JjAdvanceIntent, heads: number, view: OpView, git: GitSnapshot): JjProbeVerdict | null {
  if (heads !== 1) return { kind: 'divergentStart', heads }
  const t = local(view, intent.target)
  if (!t) return { kind: 'unknown', code: 'noTarget' }
  if (t.conflict) return { kind: 'conflicted', added: t.added, removed: t.removed }
  if (t.target !== intent.expected) return { kind: 'moved', actual: t.target, where: 'jj' }
  const tg = tracked(view, intent.target)?.target ?? ''
  const ref = git.refs[`refs/heads/${intent.target}`] ?? ''
  if (tg !== t.target) return { kind: 'partialExport', local: t.target, tracked: tg, gitRef: ref }
  if (ref !== intent.expected) return { kind: 'moved', actual: ref, where: 'git' }
  const out = git.worktrees.filter((w) => w.branch === `refs/heads/${intent.target}`).map((w) => w.path)
  if (out.length) return { kind: 'targetCheckedOut', worktrees: out }
  const pending = pendingExports(view, git, intent.target)
  if (pending.length) return { kind: 'pendingExports', refs: pending }
  return null
}

/**
 * The classifier (pure): what the record and the end's observation prove, against the Git side seen at base. Positive
 * evidence only; everything else is Unknown. See JjProbeVerdict for each answer's meaning, and the header for why none
 * of them is a CAS result.
 */
export function classify(r: JjProbeRecord, obs: JjObservation): JjProbeVerdict {
  const { intent, base } = r
  if (at(r.phase) <= at('based')) return { kind: 'notApplied', code: 'noMutation' }
  if ('unreadable' in obs) return { kind: 'unknown', code: 'unreadable', detail: obs.unreadable }
  if (!obs.headsStable || !obs.gitStable) return { kind: 'unknown', code: 'torn' }
  if (!r.baseOp || !base) return { kind: 'unknown', code: 'noBase' }
  if (!obs.heads.length) return { kind: 'unknown', code: 'noHeads' }
  for (const h of obs.heads) {
    if (!h.complete) return { kind: 'unknown', code: 'ancestry', detail: h.op }
    if (!h.ancestry.some((e) => e.id === r.baseOp)) return { kind: 'unknown', code: 'baseNotInHistory', detail: h.op }
  }
  // The Git side apart from T: a worktree whose HEAD changed, or another ref that moved, fails it whatever jj says.
  const moved = base.worktrees.filter((w) => {
    const now = obs.git.worktrees.find((x) => x.path === w.path)
    return !now || now.head !== w.head || now.branch !== w.branch
  })
  if (moved.length) return { kind: 'checkoutDetached', worktrees: moved.map((w) => w.path) }
  // A worktree added or removed during the attempt: what it had checked out before the end's reads isn't known (jj's
  // export may have detached it). A checkout made and undone between the base and the end can't be seen at all.
  const changed = obs.git.worktrees.filter((w) => !base.worktrees.some((x) => x.path === w.path)).map((w) => w.path)
  if (changed.length) return { kind: 'unknown', code: 'worktreesChanged', detail: changed.join(',') }
  const tRef = `refs/heads/${intent.target}`
  const refs = new Set([...Object.keys(base.refs), ...Object.keys(obs.git.refs)])
  const foreign = [...refs].filter((k) => k !== tRef && base.refs[k] !== obs.git.refs[k]).sort()
  if (foreign.length) return { kind: 'foreignRefs', refs: foreign }
  // This attempt's operations: any after P0 carrying its marker, in each head's history.
  const ours = (h: HeadObservation): OpEntry[] => {
    const i = h.ancestry.findIndex((e) => e.id === r.baseOp)
    return h.ancestry.slice(0, i).filter((e) => markerIn(e.args, intent.txn))
  }
  const withO = obs.heads.filter((h) => (r.op ? h.ancestry.some((e) => e.id === r.op) : false))
  const anyOurs = obs.heads.some((h) => ours(h).length > 0)
  const gitRef = obs.git.refs[tRef] ?? ''
  if (!anyOurs && !withO.length) {
    if (at(r.phase) >= at('integrating')) return { kind: 'unknown', code: 'integrateUncertain' }
    return { kind: 'notApplied', code: 'notInHistory' }
  }
  if (!r.op || withO.length !== obs.heads.length) return { kind: 'unknown', code: 'concurrent' }
  const views = obs.heads.map((h) => h.view)
  const ts = views.map((v) => local(v, intent.target))
  const conflicted = ts.find((t) => t?.conflict)
  if (conflicted) return { kind: 'conflicted', added: conflicted.added, removed: conflicted.removed }
  const agreed = new Set(ts.map((t) => t?.target ?? ''))
  if (agreed.size !== 1) return { kind: 'unknown', code: 'headsDisagree' }
  const lt = [...agreed][0]
  if (lt !== intent.result) return { kind: 'unknown', code: 'movedAfter', detail: lt }
  const tg = new Set(views.map((v) => tracked(v, intent.target)?.target ?? ''))
  if (tg.size !== 1 || !tg.has(intent.result)) return { kind: 'partialExport', local: lt, tracked: [...tg].join(','), gitRef }
  // Exported (jj recorded Git at R), and Git elsewhere since: a later Git move or a torn read, not proved either way.
  if (gitRef !== intent.result) return { kind: 'unknown', code: 'gitMovedAfter', detail: gitRef }
  return { kind: 'advancedObserved' }
}

/** The probe's reads and steps over the J0 runner. */
function steps(intent: JjAdvanceIntent, deps: JjProbeDeps) {
  const limit = deps.ancestryLimit ?? 2000
  const read = async (args: readonly string[]): Promise<string> => {
    const r = await deps.runner.run(intent.root, args)
    if (!r.ok || r.code !== 0) throw new Unreadable(`jj ${args.join(' ')}: ${r.code} ${r.err.trim()}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    return r.out
  }
  const write = (args: readonly string[]): Promise<RunResult> => deps.runner.run(intent.root, [...JJ_READ, marker(intent.txn), ...args], { write: true })
  const gitRead = async (args: readonly string[]): Promise<string> => {
    const r = await deps.git(args)
    if (!r.ok || r.code !== 0) throw new Unreadable(`git ${args.join(' ')}: ${r.code} ${r.err.trim()}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    return r.out
  }
  const view = async (op: string): Promise<OpView> => ({
    bookmarks: parseBookmarks(await read(['--at-op', op, 'bookmark', 'list', '--all-remotes', '-T', BOOKMARK_T])),
    tags: lines(await read(['--at-op', op, 'tag', 'list', '-T', TAG_T])).map((l) => {
      const [name, target] = l.split(SEP)
      return { name, target }
    }),
    visibleHeads: lines(await read(['--at-op', op, 'log', '--no-graph', '-r', 'visible_heads()', '-T', 'commit_id ++ "\\n"']))
  })
  const opEntry = async (op: string): Promise<OpEntry> => {
    const [e] = parseOps(await read(['--at-op', op, 'op', 'log', '--no-graph', '--limit', '1', '-T', OP_T]))
    if (!e) throw new Unreadable(`no op ${op}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    return e
  }
  /** The head files (this version's layout), each confirmed by jj as a full operation id. */
  const heads = async (): Promise<string[]> => {
    let names: string[]
    try {
      names = await readdir(join(intent.jjRepo, 'op_heads', 'heads'))
    } catch (e) {
      throw new Unreadable(`op_heads: ${(e as Error).message}`)
    }
    if (!names.length || names.some((n) => !HEX.test(n) || n.length < 64)) throw new Unreadable(`op_heads: ${names.join(',')}`)
    const out: string[] = []
    for (const n of names.sort()) {
      const e = await opEntry(n)
      if (e.id !== n) throw new Unreadable(`op head ${n} is ${e.id}`) // i18n-ignore: a protocol detail for logs and tests, never shown
      out.push(n)
    }
    return out
  }
  const gitSnapshot = async (): Promise<GitSnapshot> => {
    const refs: Record<string, string> = {}
    for (const l of lines(await gitRead(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags']))) {
      const [k, v] = l.split(' ')
      refs[k] = v
    }
    return { refs, worktrees: parseWorktrees(await gitRead(['worktree', 'list', '--porcelain'])) }
  }
  const head = async (op: string, baseOp: string | undefined): Promise<HeadObservation> => {
    const ancestry = parseOps(await read(['--at-op', op, 'op', 'log', '--no-graph', '--limit', String(limit), '-T', OP_T]))
    const complete = baseOp ? ancestry.some((e) => e.id === baseOp) : ancestry.length < limit
    return { op, ancestry, complete, view: await view(op) }
  }
  return { read, write, view, opEntry, heads, gitSnapshot, head }
}

/** Reads the end's observation: heads, each head pinned, the Git side, then heads and the Git side again. */
export async function observe(intent: JjAdvanceIntent, record: JjProbeRecord, deps: JjProbeDeps): Promise<JjObservation> {
  const s = steps(intent, deps)
  const point = async (p: string): Promise<void> => {
    await deps.hook?.(`observe:${p}`, record)
  }
  try {
    const first = await s.heads()
    await point('heads')
    const hs: HeadObservation[] = []
    for (const h of first) {
      hs.push(await s.head(h, record.baseOp))
      await point(`head:${hs.length}`)
    }
    const git = await s.gitSnapshot()
    await point('git')
    const again = await s.heads()
    await point('headsAgain')
    const git2 = await s.gitSnapshot()
    return { heads: hs, headsStable: JSON.stringify(first) === JSON.stringify(again), git, gitStable: JSON.stringify(git) === JSON.stringify(git2) }
  } catch (e) {
    if (e instanceof Unreadable) return { unreadable: e.message }
    throw e
  }
}

/** What a run of the probe returns: its verdict and the record as journaled last. */
export interface JjProbeRun {
  verdict: JjProbeVerdict
  record: JjProbeRecord
}

/** One attempt, journaled step by step; never retried, never forced, never undone. */
export async function runProbe(intent: JjAdvanceIntent, deps: JjProbeDeps): Promise<JjProbeRun> {
  const s = steps(intent, deps)
  let record: JjProbeRecord = { intent, phase: 'requested' }
  const journal = async (next: Partial<JjProbeRecord>): Promise<void> => {
    record = { ...record, ...next }
    await deps.journal(record)
  }
  const done = (verdict: JjProbeVerdict): JjProbeRun => ({ verdict, record })
  /**
   * Before each mutation: an early lease check (an optimisation), the phase journaled, then the lease checked again
   * after the journal's write, immediately before the command is dispatched: a lease revoked while the journal waited
   * stops it. The phase stays journaled either way (recovery reads it conservatively: never "it didn't start").
   */
  const mutate = async (phase: JjProbePhase): Promise<boolean> => {
    if (!(await deps.leaseHeld())) return false
    await journal({ phase })
    return !!(await deps.leaseHeld())
  }
  await journal({})
  try {
    // base
    const hs = await s.heads()
    const base = await s.gitSnapshot()
    const p0 = hs[0]
    const p0View = await s.view(p0)
    const refused = baseVerdict(intent, hs.length, p0View, base)
    if (refused) return done(refused)
    await journal({ phase: 'based', baseOp: p0, base })
    await deps.hook?.('based', record)
    // prepare
    if (!(await mutate('preparing'))) return done({ kind: 'leaseLost', before: 'preparing' })
    const prep = await s.write(['--at-op', p0, '--no-integrate-operation', 'bookmark', 'move', intent.target, '--from', intent.expected, '--to', intent.result])
    const short = /--no-integrate-operation was requested: ([0-9a-f]{8,})\s*$/m.exec(`${prep.err}\n${prep.out}`)?.[1]
    if (prep.code !== 0 || !short) return done({ kind: 'unknown', code: 'prepare', detail: `${prep.code} ${prep.err.trim()}` })
    const o = await s.opEntry(short)
    const bad = validPrepared(intent, p0, o, p0View, await s.view(o.id))
    if (bad) return done({ kind: 'unknown', code: 'prepareInvalid', detail: bad })
    await journal({ phase: 'prepared', op: o.id })
    await deps.hook?.('prepared', record)
    // integrate
    await deps.hook?.('beforeIntegrate', record)
    if (!(await mutate('integrating'))) return done({ kind: 'leaseLost', before: 'integrating' })
    const integ = await s.write(['op', 'integrate', o.id])
    if (integ.code !== 0) return done(classify(record, await observe(intent, record, deps)))
    await journal({ phase: 'integrated' })
    await deps.hook?.('integrated', record)
    // export
    await deps.hook?.('beforeExport', record)
    if (!(await mutate('exporting'))) return done({ kind: 'leaseLost', before: 'exporting' })
    const exp = await s.write(['git', 'export'])
    if (exp.code === 0) await journal({ phase: 'exported' })
    await deps.hook?.('exported', record)
    return done(classify(record, await observe(intent, record, deps)))
  } catch (e) {
    if (e instanceof Unreadable) return done({ kind: 'unknown', code: 'unreadable', detail: e.message })
    throw e
  }
}

/** Recovery's reading of a journaled attempt (a crash at any phase): the same classifier on the state read now. */
export async function recoverProbe(record: JjProbeRecord, deps: JjProbeDeps): Promise<JjProbeVerdict> {
  if (at(record.phase) <= at('based')) return { kind: 'notApplied', code: 'noMutation' }
  return classify(record, await observe(record.intent, record, deps))
}
