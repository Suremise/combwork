// jj's integration evidence (SPEC §16.3.6 port 4 under decision A, HI-2798's J5; its design HI-2798/s11, s14, s17, s20).
// Combwork never moves a jj target and this module writes no jj operation (so no `jj undo` of any kind): the user
// integrates (moves the bookmark, by hand or onto J4's candidate) and pushes. What it gives is evidence:
// - the target's head as evidence (`jjTargetHead`): one bookmark, not conflicted, its commit neither divergent nor
//   conflicted, jj and Git agreeing on it (the export matrix), read at one operation;
// - the proof that the target as moved contains the reviewed change (`jjContains`): a J4 candidate bound to exactly the
//   reviewed input, else §16.3.2's test unchanged on the backing store; refusals around it; and, before it answers
//   proved, every object the proof names retained in an immutable bundle of pins (one per observation);
// - publish as an observation (`observePublish`): what the chosen remote has, read from the remote and revalidated across
//   the read, settling each integration's own obligation (compare-and-set on its key, result and state), never pushing.
// Unregistered, like J2–J4: jj has no `integration` capability; J6 composes jj's HistoryPort (`contains`, `lineHead`)
// from these and the reconciler records `Integrated { by: 'outside' }` with this provenance (jjFacts.ts).

import type { JjAttemptRecord, JjPin } from './jjCandidates'
import { parseRefs } from './jjCandidates'
import type { JjVia } from './jjFacts'
import type { StoreLock } from './jjBoundary'
import { isJjUnknown, JjReads, jjUnknown, type JjCommit, type JjReadUnknown } from './jjReads'
import type { JjRunner } from './jjRunner'
import { COMMIT_ID, readOpHeads, type ViewOf } from './jjView'
import type { RunResult } from './repoContext'
import type { Containment, Maybe } from './types'
import { isUnknown } from './types'

const SEP = '\u001f'
const ZERO = '0'.repeat(40)
const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.length > 0)
const refSafe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '-')

/** Why the evidence is refused: the port's further outcomes (R7/R8) and the publish's own. Never "not contained". */
export type JjRefusal = 'conflictedTarget' | 'divergentChange' | 'partialExport' | 'ambiguousRemote' | 'disagree' | 'notFetched'
export interface JjRefused {
  refused: JjRefusal
  detail?: string
}
export const isRefused = (v: unknown): v is JjRefused => !!v && typeof v === 'object' && typeof (v as JjRefused).refused === 'string'
const refused = (why: JjRefusal, detail?: string): JjRefused => ({ refused: why, ...(detail ? { detail: detail.slice(0, 2000) } : {}) })

/** An answer, a refusal, or a typed unknown (J3's codes, plus `moved` for anything that changed under the read). */
export type JjEvidence<T> = T | JjRefused | JjReadUnknown

export interface JjIntegrationDeps {
  runner: JjRunner
  view: Pick<ViewOf, 'jjRepo' | 'store' | 'colocated'>
  /** A folder of the repository to run jj's pinned reads in (J2's control workspace). */
  folder: string
  /** `git --git-dir <store>`; for `ls-remote`, run with no prompt (`GIT_TERMINAL_PROMPT=0`), bounded. */
  git: (args: readonly string[]) => Promise<RunResult>
  /** §16.3.2's containment on the backing store (Git's `contains`), asked about the head given. */
  gitContains: (store: string, target: string, c: { base: string; revision: string; key?: string | null }, at: string) => Promise<Maybe<Containment | null>>
  lock: StoreLock
  /** Durable before the step it names: a card and cycle's bundles as they stand. */
  journal: (card: string, cycle: number, bundles: JjBundle[]) => Promise<void> | void
  signal?: AbortSignal
  timeout?: number
  hook?: (point: JjIntegrationPoint) => Promise<void> | void
}

/** Where a test pauses (a race placed exactly there). */
export type JjIntegrationPoint = 'afterProof' | `beforePin:${string}` | 'afterRemote'

const BOOKMARK_T = `name ++ "${SEP}" ++ if(remote, remote, "") ++ "${SEP}" ++ conflict ++ "${SEP}" ++ if(normal_target, normal_target.commit_id(), "") ++ "${SEP}" ++ tracked ++ "\\n"`

interface BookmarkRow {
  name: string
  remote: string
  conflict: boolean
  target: string
  tracked: boolean
}

export function parseBookmarkRows(out: string): BookmarkRow[] | null {
  const rows: BookmarkRow[] = []
  for (const l of lines(out)) {
    const f = l.split(SEP)
    if (f.length !== 5 || !f[0] || (f[3] && !COMMIT_ID.test(f[3]))) return null
    rows.push({ name: f[0], remote: f[1], conflict: f[2] === 'true', target: f[3], tracked: f[4] === 'true' })
  }
  return rows
}

/**
 * The export matrix (s14 §1′), pure: jj's local `T`, its `T@git` row (null: none) and the store's `refs/heads/T` (null:
 * none). A missing ref agrees only in a non-colocated store with no `@git` row (jj's normal there); wherever there is
 * `@git` evidence, the ref must be there and equal.
 */
export function exportProblem(colocated: boolean, local: string, gitRow: string | null, gitRef: string | null): string | null {
  if (gitRow !== null) return gitRow === local && gitRef === local ? null : `T=${local} T@git=${gitRow} ref=${gitRef ?? '-'}`
  if (colocated) return `T=${local} T@git=- ref=${gitRef ?? '-'}`
  return gitRef === null || gitRef === local ? null : `T=${local} ref=${gitRef}`
}

/** The target's head as evidence, with the operation and Git ref it was read at. */
export interface JjTargetHead {
  head: string
  op: string
  gitRef: string | null
  rows: BookmarkRow[]
}

async function refNow(deps: JjIntegrationDeps, ref: string): Promise<string | null | JjReadUnknown> {
  const r = await deps.git(['for-each-ref', '--format=%(objectname) %(refname)', ref])
  if (!r.ok) return jjUnknown('failed', r.err)
  const m = parseRefs(r.out)
  return m ? (m.get(ref) ?? null) : jjUnknown('malformed', r.out)
}

const readsOf = (deps: JjIntegrationDeps): JjReads => new JjReads({ folder: deps.folder, jjRepo: deps.view.jjRepo }, deps.runner, { signal: deps.signal, timeout: deps.timeout })

/**
 * The target's head (s11 §1, s14 §1′), all at the single head H: the local bookmark (none: null), not conflicted, its
 * commit neither divergent nor conflicted, the export matrix holding; the heads and Git's ref the same after the reads.
 */
export async function jjTargetHead(deps: JjIntegrationDeps, target: string): Promise<JjEvidence<JjTargetHead | null>> {
  const reads = readsOf(deps)
  const ok = await reads.supported()
  if (isJjUnknown(ok)) return ok
  const op = reads.head()
  if (isJjUnknown(op)) return op
  const out = await reads.run(op, ['bookmark', 'list', '--all-remotes', '-T', BOOKMARK_T])
  if (isJjUnknown(out)) return out
  const rows = parseBookmarkRows(out)
  if (!rows) return jjUnknown('malformed', out)
  const mine = rows.filter((r) => r.name === target)
  const local = mine.find((r) => r.remote === '')
  if (!local) return reads.stillAt(op) ? null : jjUnknown('moved')
  if (local.conflict || !local.target) return refused('conflictedTarget', target)
  const c = await reads.commitAt(op, local.target)
  if (isJjUnknown(c)) return c
  if (c.divergent) return refused('divergentChange', local.target)
  if (c.conflict) return refused('conflictedTarget', local.target)
  const gitRow = mine.find((r) => r.remote === 'git')
  const gitRef = await refNow(deps, `refs/heads/${target}`)
  if (isJjUnknown(gitRef)) return gitRef
  const bad = exportProblem(deps.view.colocated, local.target, gitRow ? gitRow.target || 'conflicted' : null, gitRef)
  if (bad) return refused('partialExport', bad)
  const again = await refNow(deps, `refs/heads/${target}`)
  if (isJjUnknown(again)) return again
  if (again !== gitRef || !reads.stillAt(op)) return jjUnknown('moved')
  return { head: local.target, op, gitRef, rows }
}

/** One retained proof bundle (s17 §1): its immutable identity, the endpoints it keeps, and its pins (J4's ownership rules). */
export interface JjBundle {
  bundle: string
  endpoints: { revision: string; base: string; head: string; proof?: string }
  pins: JjPin[]
}

/** What the composer supplies about the reviewed submission being proved. */
export interface JjProofRequest {
  card: string
  cycle: number
  target: string
  change: { base: string; revision: string; key?: string | null }
  /** The head the caller read (the reconciler's): it must be the head now, or the answer is `moved`. */
  at?: string
  /** The card's J4 attempt records: only a done `candidate` for exactly this reviewed input credits (s14 §2′). */
  candidates?: readonly JjAttemptRecord[]
  /** The card and cycle's bundles as journalled. */
  bundles: readonly JjBundle[]
  /** Bundles a recorded `Integrated` fact names: a new integration never reuses them (s20). */
  consumed: readonly string[]
  /** A fresh token for a new bundle ([a-z0-9], 6–40). */
  token: string
}

export interface JjProof {
  containment: Containment | null
  provenance?: { op: string; head: string; gitRef: string | null; via: JjVia; bundle: string; candidate?: { attempt: string; result: string }; commit?: string }
  bundles: JjBundle[]
}

const methodOf = (style: JjAttemptRecord['style'], result: string): Containment => (style === 'rebase' ? { method: 'fastForward' } : style === 'squash' ? { method: 'squash', commit: result } : { method: 'merge' })

/** Whether a J4 record credits this reviewed input (s14 §2′), its pin read now: the candidate's commit, or null. */
async function boundCandidate(deps: JjIntegrationDeps, req: JjProofRequest, r: JjAttemptRecord): Promise<string | null | JjReadUnknown> {
  if (r.outcome !== 'candidate' || r.phase !== 'done' || r.step || r.uncertain?.length || r.card !== req.card) return null
  if (r.revision !== req.change.revision || r.base !== req.change.base || !r.result) return null
  const pin = r.pins.find((p) => p.state === 'created' && p.ref.endsWith('/candidate'))
  if (!pin || pin.oid !== r.result) return null
  const now = await refNow(deps, pin.ref)
  if (isJjUnknown(now)) return now
  return now === r.result ? r.result : null
}

/**
 * The proof (s11 §2, s14 §2′/§4′, s17, s20): the target's head; a bound J4 candidate it reaches, else §16.3.2's test on
 * the store at that head; refusals for a divergent reviewed revision or a divergent or conflicted proof commit; the head,
 * the operation and Git's ref the same after; then the proof's objects retained (reused bundle or a new one) and read back
 * held. Null containment needs no bundle. A refusal or unknown is never "not contained".
 */
export async function jjContains(deps: JjIntegrationDeps, req: JjProofRequest): Promise<JjEvidence<JjProof>> {
  const th = await jjTargetHead(deps, req.target)
  if (isJjUnknown(th) || isRefused(th)) return th
  if (!th) return jjUnknown('none', req.target)
  if (req.at !== undefined && req.at !== th.head) return jjUnknown('moved', 'at')
  const reads = readsOf(deps)
  const rev = await reads.commitAt(th.op, req.change.revision)
  if (isJjUnknown(rev)) return rev
  if (rev.divergent) return refused('divergentChange', req.change.revision)
  let containment: Containment | null = null
  let via: JjVia | null = null
  let candidate: { attempt: string; result: string } | undefined
  for (const r of req.candidates ?? []) {
    const c = await boundCandidate(deps, req, r)
    if (isJjUnknown(c)) return c
    if (!c) continue
    const reach = await reads.run(th.op, ['log', '--no-graph', '-r', `${c} & ::${th.head}`, '-T', 'commit_id ++ "\\n"'])
    if (isJjUnknown(reach)) return reach
    if (!lines(reach).length) continue
    containment = methodOf(r.style, c)
    via = 'candidate'
    candidate = { attempt: r.attempt, result: c }
    break
  }
  if (!containment) {
    const g = await deps.gitContains(deps.view.store, req.target, req.change, th.head)
    if (isUnknown(g)) return jjUnknown('failed', g.what)
    if (!g) return reads.stillAt(th.op) ? { containment: null, bundles: [...req.bundles] } : jjUnknown('moved')
    containment = g
    via = g.method === 'squash' ? 'replay' : g.method === 'sameTree' ? 'sameTree' : 'ancestry'
  }
  const proofCommit = via === 'candidate' ? candidate!.result : containment.commit
  if (proofCommit) {
    const pc: JjCommit | JjReadUnknown = await reads.commitAt(th.op, proofCommit)
    if (isJjUnknown(pc)) return pc
    if (pc.divergent) return refused('divergentChange', proofCommit)
    if (pc.conflict) return refused('conflictedTarget', proofCommit)
  }
  await deps.hook?.('afterProof')
  // The moment still the proof's: the same head, operation and Git ref.
  const again = await jjTargetHead(deps, req.target)
  if (isJjUnknown(again) || isRefused(again)) return again
  if (!again || again.head !== th.head || again.op !== th.op || again.gitRef !== th.gitRef) return jjUnknown('moved', 'afterProof')
  const endpoints = { revision: req.change.revision, base: req.change.base, head: th.head, ...(proofCommit ? { proof: proofCommit } : {}) }
  const kept = await retain(deps, req, endpoints)
  if (isJjUnknown(kept) || isRefused(kept)) return kept
  return { containment, provenance: { op: th.op, head: th.head, gitRef: th.gitRef, via: via!, bundle: kept.bundle.bundle, ...(candidate ? { candidate } : {}), ...(proofCommit && via !== 'candidate' ? { commit: proofCommit } : {}) }, bundles: kept.bundles }
}

const sameEndpoints = (a: JjBundle['endpoints'], b: JjBundle['endpoints']): boolean => a.revision === b.revision && a.base === b.base && a.head === b.head && (a.proof ?? '') === (b.proof ?? '')

/** The prefix a bundle's pins live under: a namespace, never proof of who wrote a ref there. */
export const bundlePrefix = (card: string, cycle: number, bundle: string): string => `refs/cw/jj-integrated/${refSafe(card)}/${cycle}/${bundle}/`

/**
 * The proof's objects retained (s17 §1): a journalled bundle with exactly these endpoints, not consumed by a recorded
 * fact, reused (completed where a crash left it partial); else a new bundle. Every pin is created (create-only, the
 * intent journalled first, owned only on a read-back create; a ref there first is a collision: `moved`, never touched)
 * and then every pin read back held.
 */
async function retain(deps: JjIntegrationDeps, req: JjProofRequest, endpoints: JjBundle['endpoints']): Promise<JjEvidence<{ bundle: JjBundle; bundles: JjBundle[] }>> {
  const bundles = structuredClone([...req.bundles])
  let b = bundles.find((x) => !req.consumed.includes(x.bundle) && sameEndpoints(x.endpoints, endpoints) && !x.pins.some((p) => p.state === 'collision'))
  if (!b) {
    if (!/^[a-z0-9]{6,40}$/.test(req.token)) return jjUnknown('malformed', 'token')
    b = { bundle: `b${bundles.length}-${req.token}`, endpoints, pins: [] }
    bundles.push(b)
  }
  const bundle = b
  const prefix = bundlePrefix(req.card, req.cycle, bundle.bundle)
  const wanted: [string, string][] = [['revision', endpoints.revision], ['base', endpoints.base], ['head', endpoints.head], ...(endpoints.proof ? ([['proof', endpoints.proof]] as [string, string][]) : [])]
  for (const [name, oid] of wanted) {
    const ref = `${prefix}${name}`
    let pin = bundle.pins.find((p) => p.ref === ref)
    if (pin && pin.oid !== oid) return jjUnknown('malformed', `bundle ${bundle.bundle}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    if (pin?.state === 'created' || pin?.state === 'intent') {
      const now = await refNow(deps, ref)
      if (isJjUnknown(now)) return now
      if (now === oid) continue
      if (pin.state === 'created' || now !== null) return jjUnknown('moved', `pin:${ref}`)
      // An intent whose ref was never made: made now, as a fresh create.
    }
    if (!pin) {
      pin = { ref, oid, state: 'intent' }
      bundle.pins.push(pin)
    } else pin.state = 'intent'
    await deps.journal(req.card, req.cycle, structuredClone(bundles))
    const made = await deps.lock(async () => {
      await deps.hook?.(`beforePin:${ref}`)
      const r = await deps.git(['update-ref', ref, oid, ZERO])
      const now = await refNow(deps, ref)
      if (isJjUnknown(now)) return now
      if (r.ok && now === oid) pin.state = 'created'
      else if (now !== null) {
        pin.state = 'collision'
        pin.found = now
      }
      await deps.journal(req.card, req.cycle, structuredClone(bundles))
      return pin.state
    })
    if (isJjUnknown(made)) return made
    if (made === 'collision') return jjUnknown('moved', `collision:${ref}`)
    if (made !== 'created') return jjUnknown('failed', `pin:${ref}`)
  }
  const held = await heldBundle(deps, bundle)
  if (held !== true) return held
  return { bundle, bundles }
}

/**
 * Whether every pin of a bundle holds its commit now (owned ones, and ambiguous intents whose ref holds it): the check
 * at the fact's boundary, before and after its write (s14 §4′). A pin moved or gone: unknown, never a proof.
 */
export async function heldBundle(deps: JjIntegrationDeps, b: JjBundle): Promise<true | JjReadUnknown> {
  for (const p of b.pins) {
    if (p.state !== 'created' && p.state !== 'intent') return jjUnknown('moved', `pin:${p.ref}`)
    const now = await refNow(deps, p.ref)
    if (isJjUnknown(now)) return now
    if (now !== p.oid) return jjUnknown('moved', `pin:${p.ref}`)
  }
  return b.pins.length ? true : jjUnknown('none', 'empty bundle') // i18n-ignore: a protocol detail for logs and tests, never shown
}

/**
 * A recorded integration's bundle kept (s14 §4′), each later pass: a missing pin created again (create-only) while its
 * object still resolves; an object gone is unknown (`none`), and that card's containment answers unknown, never
 * LeftTarget or a fresh proof from nothing. A ref at another commit is never touched (`moved`).
 */
export async function ensureRetained(deps: JjIntegrationDeps, card: string, cycle: number, bundles: readonly JjBundle[], bundle: string): Promise<JjEvidence<JjBundle[]>> {
  const all = structuredClone([...bundles])
  const b = all.find((x) => x.bundle === bundle)
  if (!b) return jjUnknown('none', bundle)
  for (const p of b.pins) {
    const now = await refNow(deps, p.ref)
    if (isJjUnknown(now)) return now
    if (now === p.oid) continue
    if (now !== null) return jjUnknown('moved', `pin:${p.ref}`)
    const there = await deps.git(['cat-file', '-e', `${p.oid}^{commit}`])
    if (!there.ok) return jjUnknown('none', `object gone: ${p.oid}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    p.state = 'intent'
    await deps.journal(card, cycle, structuredClone(all))
    const made = await deps.lock(async () => {
      const r = await deps.git(['update-ref', p.ref, p.oid, ZERO])
      const back = await refNow(deps, p.ref)
      if (isJjUnknown(back)) return back
      if (r.ok && back === p.oid) p.state = 'created'
      else if (back !== null) {
        p.state = 'collision'
        p.found = back
      }
      await deps.journal(card, cycle, structuredClone(all))
      return p.state
    })
    if (isJjUnknown(made)) return made
    if (made !== 'created') return jjUnknown('moved', `pin:${p.ref}`)
  }
  return all
}

// ---------------------------------------------------------------------------------------------------------------------
// Publish: an observation (the user pushes), and an obligation per integration until it is seen (s14 §5′, s17 §2, s20).

/** One integration's publish obligation: keyed by its card, cycle and bundle (its `Integrated` fact), its result. */
export interface JjObligation {
  card: string
  cycle: number
  bundle: string
  target: string
  result: string
  since: number
  state: 'owed' | 'published' | 'notHeld'
  pushed?: string
  at?: number
}

export type ObligationKey = Pick<JjObligation, 'card' | 'cycle' | 'bundle'>
const keyOf = (o: ObligationKey): string => `${o.card}\u0000${o.cycle}\u0000${o.bundle}`

/** Where obligations are kept (durable: J6's board_meta rows; a test's memory). Every change a compare-and-set. */
export interface ObligationStore {
  list(target: string): JjObligation[]
  /** Creates the row only when none exists for its key, in any state (a tombstone blocks it): whether it was created. */
  create(o: JjObligation): boolean
  /** owed → published | notHeld, only while the row is exactly that key and result, and owed: whether it changed. */
  settle(k: ObligationKey, result: string, to: 'published' | 'notHeld', at: number, pushed?: string): boolean
}

/** An in-memory store with the durable store's semantics (tests; and J6's model of its rows). */
export function memoryObligations(rows: JjObligation[] = []): ObligationStore & { rows: JjObligation[] } {
  return {
    rows,
    list: (target) => rows.filter((r) => r.target === target).map((r) => ({ ...r })),
    create: (o) => {
      if (rows.some((r) => keyOf(r) === keyOf(o))) return false
      rows.push({ ...o, state: 'owed' })
      return true
    },
    settle: (k, result, to, at, pushed) => {
      const r = rows.find((x) => keyOf(x) === keyOf(k))
      if (!r || r.result !== result || r.state !== 'owed') return false
      r.state = to
      r.at = at
      if (pushed) r.pushed = pushed
      return true
    }
  }
}

/**
 * Recovery's reconstruction (s20): an obligation for each recorded jj integration (its card, cycle, bundle, target and
 * result), created only when no row for that key exists in any state, so a settled one never reappears and a new
 * integration is never blocked by an old one's tombstone. Returns how many were created.
 */
export function reconstructObligations(store: ObligationStore, facts: readonly { card: string; cycle: number; bundle: string; target: string; result: string; at: number }[]): number {
  let n = 0
  for (const f of facts) if (store.create({ card: f.card, cycle: f.cycle, bundle: f.bundle, target: f.target, result: f.result, since: f.at, state: 'owed' })) n++
  return n
}

/** The remote a target is published to (s17 §2): one tracked `T@r`; several tracked, or several configured with no origin and none tracked, refused. */
export function chooseRemote(target: string, rows: readonly BookmarkRow[], configured: readonly string[]): string | null | JjRefused {
  const tracked = [...new Set(rows.filter((r) => r.name === target && r.remote && r.remote !== 'git' && r.tracked).map((r) => r.remote))]
  if (tracked.length === 1) return tracked[0]
  if (tracked.length > 1) return refused('ambiguousRemote', tracked.join(','))
  if (configured.length === 1) return configured[0]
  if (!configured.length) return null
  return configured.includes('origin') ? 'origin' : refused('ambiguousRemote', configured.join(','))
}

/** Parses `jj git remote list` (`name url` a line). */
export function parseRemotes(out: string): Map<string, string> | null {
  const m = new Map<string, string>()
  for (const l of lines(out)) {
    const i = l.indexOf(' ')
    if (i <= 0) return null
    m.set(l.slice(0, i), l.slice(i + 1).trim())
  }
  return m
}

/** Parses `git ls-remote --refs <url> refs/heads/T`: exactly that ref (null: absent), more lines or another name malformed. */
export function parseLsRemote(out: string, ref: string): string | null | 'malformed' {
  const ls = lines(out)
  if (!ls.length) return null
  if (ls.length > 1) return 'malformed'
  const [oid, name, ...rest] = ls[0].split(/\s+/)
  return rest.length || name !== ref || !/^[0-9a-f]{40}$/.test(oid ?? '') ? 'malformed' : oid
}

export type PublishObserved =
  | { remote: string; url: string; pushed: string | null; settled: { key: ObligationKey; to: 'published' | 'notHeld' }[] }
  | { noRemote: true }
  | JjRefused
  | JjReadUnknown

/**
 * One observation of a target's publication (s14 §5′, s17 §2, s20): the owed obligations snapshotted (each with its key
 * and result); the remote chosen and its URL from jj and from the store's config, agreeing; the target's head; the
 * remote's `refs/heads/T` read from the remote; then everything read again (the single head, the target's head, the
 * remote choice and both URLs). Moved, refused or unknown: nothing settled. Else each obligation on its own: in what the
 * remote has (its commit in the store, else `notFetched` for all), `published` with that id; else not in the local
 * target any more, `notHeld`; else still owed. Each settle is the store's compare-and-set on its key, result and state.
 */
export async function observePublish(deps: JjIntegrationDeps, target: string, store: ObligationStore, now: () => number = Date.now): Promise<PublishObserved> {
  const owed = store.list(target).filter((o) => o.state === 'owed')
  const reads = readsOf(deps)
  const remoteNow = async (op: string): Promise<JjEvidence<{ remote: string | null; url: string | null; rows: BookmarkRow[] }>> => {
    const out = await reads.run(op, ['bookmark', 'list', '--all-remotes', '-T', BOOKMARK_T])
    if (isJjUnknown(out)) return out
    const rows = parseBookmarkRows(out)
    if (!rows) return jjUnknown('malformed', out)
    const rl = await reads.run(op, ['git', 'remote', 'list'])
    if (isJjUnknown(rl)) return rl
    const remotes = parseRemotes(rl)
    if (!remotes) return jjUnknown('malformed', rl)
    const chosen = chooseRemote(target, rows, [...remotes.keys()])
    if (isRefused(chosen)) return chosen
    if (chosen === null) return { remote: null, url: null, rows }
    const cfg = await deps.git(['config', '--get', `remote.${chosen}.url`])
    if (!cfg.ok) return jjUnknown('failed', cfg.err)
    const url = remotes.get(chosen)!
    if (cfg.out.trim() !== url) return refused('disagree', `${url} | ${cfg.out.trim()}`)
    return { remote: chosen, url, rows }
  }
  const th = await jjTargetHead(deps, target)
  if (isJjUnknown(th) || isRefused(th)) return th
  if (!th) return jjUnknown('none', target)
  const r1 = await remoteNow(th.op)
  if (isJjUnknown(r1) || isRefused(r1)) return r1
  if (!r1.remote || !r1.url) return { noRemote: true }
  const ref = `refs/heads/${target}`
  const ls = await deps.git(['ls-remote', '--refs', r1.url, ref])
  await deps.hook?.('afterRemote')
  if (!ls.ok) return jjUnknown('failed', ls.err)
  const pushed = parseLsRemote(ls.out, ref)
  if (pushed === 'malformed') return jjUnknown('malformed', ls.out)
  // Everything read again across the awaited read: any change, nothing settled.
  const th2 = await jjTargetHead(deps, target)
  if (isJjUnknown(th2) || isRefused(th2)) return th2
  if (!th2 || th2.head !== th.head || th2.op !== th.op || th2.gitRef !== th.gitRef) return jjUnknown('moved', 'target')
  const r2 = await remoteNow(th2.op)
  if (isJjUnknown(r2) || isRefused(r2)) return r2
  if (r2.remote !== r1.remote || r2.url !== r1.url) return jjUnknown('moved', 'remote')
  if (readOpHeads(deps.view.jjRepo)?.join() !== th.op) return jjUnknown('moved', 'heads')
  const ancestor = async (a: string, b: string): Promise<boolean | JjReadUnknown> => {
    const r = await deps.git(['merge-base', '--is-ancestor', a, b])
    return r.code === 0 ? true : r.code === 1 ? false : jjUnknown('failed', r.err)
  }
  if (pushed) {
    const there = await deps.git(['cat-file', '-e', `${pushed}^{commit}`])
    if (!there.ok) return refused('notFetched', pushed)
  }
  const decided: { o: JjObligation; to: 'published' | 'notHeld' }[] = []
  for (const o of owed) {
    if (pushed) {
      const inPushed = await ancestor(o.result, pushed)
      if (isJjUnknown(inPushed)) return inPushed
      if (inPushed) {
        decided.push({ o, to: 'published' })
        continue
      }
    }
    const held = await ancestor(o.result, th.head)
    if (isJjUnknown(held)) return held
    if (!held) decided.push({ o, to: 'notHeld' })
  }
  const settled: { key: ObligationKey; to: 'published' | 'notHeld' }[] = []
  const at = now()
  for (const { o, to } of decided) {
    const key = { card: o.card, cycle: o.cycle, bundle: o.bundle }
    if (store.settle(key, o.result, to, at, to === 'published' ? pushed! : undefined)) settled.push({ key, to })
  }
  return { remote: r1.remote, url: r1.url, pushed, settled }
}
