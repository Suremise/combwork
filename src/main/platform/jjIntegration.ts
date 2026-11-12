// jj's integration evidence (SPEC §16.3.6 port 4 under decision A, HI-2798's J5; its design HI-2798/s11, s14, s17, s20).
// Combwork never moves a jj target and this module writes no jj operation (so no `jj undo` of any kind): the user
// integrates (moves the bookmark, by hand or onto J4's candidate) and pushes. What it gives is evidence:
// - the target's head as evidence (`jjTargetHead`): one bookmark, not conflicted, its commit neither divergent nor
//   conflicted, jj and Git agreeing on it (the export matrix), read at one operation;
// - the proof that the target as moved contains the reviewed change (`jjContains`): a J4 candidate bound to exactly the
//   reviewed input, else §16.3.2's test unchanged on the backing store; refusals around it; and, before it answers
//   proved, every object the proof names retained in an immutable bundle of pins (one per observation);
// - publish as an observation (`observePublish`): what the chosen remote has, read from the remote and revalidated across
//   the read, settling each integration's own obligation (compare-and-set on its key, result and state), never pushing;
//   each settle keeps its evidence, and later observations re-check settled rows, flagging a mismatch `checkThis`
//   (HI-2873, its design HI-2873/s7, s11, s14).
// Unregistered, like J2–J4: jj has no `integration` capability; J6 composes jj's HistoryPort (`contains`, `lineHead`)
// from these and the reconciler records `Integrated { by: 'outside' }` with this provenance (jjFacts.ts).

import { dirname, isAbsolute, join, resolve } from 'path'
import type { JjAttemptRecord, JjPin } from './jjCandidates'
import { parseRefs, validUpdate } from './jjCandidates'
import type { JjVia } from './jjFacts'
import type { StoreLock } from './jjBoundary'
import { isJjUnknown, JjReads, jjUnknown, type JjCommit, type JjReadUnknown } from './jjReads'
import type { JjRunner } from './jjRunner'
import { COMMIT_ID, readOpHeads, type ViewOf } from './jjView'
import type { RunResult } from './repoContext'
import type { Containment, Maybe } from './types'
import { isUnknown } from './types'
import { applyRecheck, publishTail, refFromFiles, sourcesPrint, type PublishTailInput } from './jjPublishTail'
export { applyRecheck, refFromFiles, sourcesPrint }
export type { PublishTailInput }

const SEP = '\u001f'
const ZERO = '0'.repeat(40)
const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.length > 0)
const refSafe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '-')
/** How many config files the sources' fingerprint covers at most: more is unknown. */
export const SOURCES_MAX = 64

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
  /** The environment `git` runs with (its config scopes follow it): process.env when not given. */
  gitEnv?: NodeJS.ProcessEnv
  /** §16.3.2's containment on the backing store (Git's `contains`), asked about the head given. */
  gitContains: (store: string, target: string, c: { base: string; revision: string; key?: string | null }, at: string) => Promise<Maybe<Containment | null>>
  lock: StoreLock
  /** Durable before the step it names: a card and cycle's bundles as they stand. */
  journal: (card: string, cycle: number, bundles: JjBundle[]) => Promise<void> | void
  signal?: AbortSignal
  timeout?: number
  hook?: (point: JjIntegrationPoint) => Promise<void> | void
  /**
   * Where a publish observation's synchronous tail runs (HI-2882/s22): the validator and every write together, in one
   * database transaction of a worker's own (the app's). Absent: in `observePublish`'s own continuation, on its store.
   */
  commit?: (tail: PublishTailInput) => Promise<PublishObserved>
}

/** Where a test pauses (a race placed exactly there). */
export type JjIntegrationPoint = 'afterProof' | 'afterRetain' | `beforePin:${string}` | 'afterRemote' | 'ancestry' | 'finalRemote' | 'finalFence' | 'discovered'

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
 * none). Colocated, Git's working copy sees the store's refs, so `@git` and the ref must both be there and equal T.
 * Non-colocated (HI-2896, HR1's s10 answer), the local bookmark alone is the target: nothing imports or exports without
 * colocation (probed on 0.47.1: after one manual `jj git export`, a later `bookmark set` and even `jj git push` leave
 * `T@git` and the ref behind), so a past export is a record, never a disagreement. The row and ref stay in the moment's
 * print and its final fence, so their change still moves it; a raw Git write to the store is E8's (jjOpView).
 */
export function exportProblem(colocated: boolean, local: string, gitRow: string | null, gitRef: string | null): string | null {
  if (!colocated) return null
  if (gitRow !== null) return gitRow === local && gitRef === local ? null : `T=${local} T@git=${gitRow} ref=${gitRef ?? '-'}`
  return `T=${local} T@git=- ref=${gitRef ?? '-'}`
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

/** How many whole reads `jjTargetHead` makes at most while the operation head moves under them (HI-2916). */
export const TARGET_READS = 3

/**
 * The target's head (s11 §1, s14 §1′), all at the single head H: the local bookmark (none: null), not conflicted, its
 * commit neither divergent nor conflicted, the export matrix holding; the heads and Git's ref the same after the reads.
 * A read that the operation head moved under (`moved`) is made again whole, at most TARGET_READS reads in all (HI-2916:
 * Combwork's own jj operations beside it, a slot made or detached, move it); nothing of a moved read is kept.
 */
export async function jjTargetHead(deps: JjIntegrationDeps, target: string): Promise<JjEvidence<JjTargetHead | null>> {
  let r = await targetHeadOnce(deps, target)
  for (let i = 1; i < TARGET_READS && isJjUnknown(r) && r.jjUnknown === 'moved'; i++) r = await targetHeadOnce(deps, target)
  return r
}

async function targetHeadOnce(deps: JjIntegrationDeps, target: string): Promise<JjEvidence<JjTargetHead | null>> {
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

/**
 * The target's evidence read again and compared with the moment an answer rests on (HR1's round 1): the same head, the
 * same operation, the same Git ref, the export matrix still holding. Null when it is; else the refusal or unknown that
 * the answer must become (never a proof, a null or a settle from the earlier moment).
 */
async function fence(deps: JjIntegrationDeps, target: string, th: JjTargetHead, where: string): Promise<JjRefused | JjReadUnknown | null> {
  const again = await jjTargetHead(deps, target)
  if (isJjUnknown(again) || isRefused(again)) return again
  if (!again || again.head !== th.head || again.op !== th.op || again.gitRef !== th.gitRef) return jjUnknown('moved', where)
  return null
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
async function boundCandidate(deps: JjIntegrationDeps, req: JjProofRequest, r: JjAttemptRecord, pins: { ref: string; oid: string }[]): Promise<string | null | JjReadUnknown> {
  if ((r.kind ?? 'candidate') !== 'candidate' || r.outcome !== 'candidate' || r.phase !== 'done' || r.step || r.uncertain?.length || r.card !== req.card) return null
  if (r.revision !== req.change.revision || r.base !== req.change.base || !r.result) return null
  const pin = r.pins.find((p) => p.state === 'created' && p.ref.endsWith('/candidate'))
  if (!pin || pin.oid !== r.result) return null
  // Built on strict's update (HI-2853/s10): only a merge or squash, and only on a valid update for exactly this reviewed
  // input and this candidate's target head, found among the card's records and its result pin read now. Else no credit.
  if (r.updated) {
    if (r.style === 'rebase') return null
    const u = (req.candidates ?? []).find((x) => x.attempt === r.updated!.attempt)
    const v = await validUpdate(deps.git, u, { card: req.card, revision: req.change.revision, base: req.change.base, expected: r.expected, attempt: r.updated.attempt, result: r.updated.result })
    if (isJjUnknown(v)) return v
    if (v !== true) return null
    const upin = u!.pins.find((p) => p.state === 'created' && p.ref.endsWith('/candidate'))!
    pins.push({ ref: upin.ref, oid: upin.oid })
  }
  const now = await refNow(deps, pin.ref)
  if (isJjUnknown(now)) return now
  if (now !== r.result) return null
  pins.push({ ref: pin.ref, oid: pin.oid })
  return r.result
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
  // The J4 pins a candidate's credit rests on (its own, and its update's): read again at the answer (HI-2853/s10 §2).
  let boundPins: { ref: string; oid: string }[] = []
  for (const r of req.candidates ?? []) {
    const used: { ref: string; oid: string }[] = []
    const c = await boundCandidate(deps, req, r, used)
    if (isJjUnknown(c)) return c
    if (!c) continue
    const reach = await reads.run(th.op, ['log', '--no-graph', '-r', `${c} & ::${th.head}`, '-T', 'commit_id ++ "\\n"'])
    if (isJjUnknown(reach)) return reach
    if (!lines(reach).length) continue
    containment = methodOf(r.style, c)
    via = 'candidate'
    candidate = { attempt: r.attempt, result: c }
    boundPins = used
    break
  }
  if (!containment) {
    const g = await deps.gitContains(deps.view.store, req.target, req.change, th.head)
    if (isUnknown(g)) return jjUnknown('failed', g.what)
    if (!g) {
      // A negative answer is fenced like a positive one: a Git move (no jj operation) during the read is a refusal or
      // unknown, never "not contained" (a null may become LeftTarget).
      const moved = await fence(deps, req.target, th, 'notContained')
      return moved ?? { containment: null, bundles: [...req.bundles] }
    }
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
  const afterProof = await fence(deps, req.target, th, 'afterProof')
  if (afterProof) return afterProof
  const endpoints = { revision: req.change.revision, base: req.change.base, head: th.head, ...(proofCommit ? { proof: proofCommit } : {}) }
  const kept = await retain(deps, req, endpoints)
  if (isJjUnknown(kept) || isRefused(kept)) return kept
  // Retention awaited pins and journal writes: the moment is fenced again before the proof is answered (the bundle stays,
  // reusable for exactly these endpoints).
  await deps.hook?.('afterRetain')
  const afterRetain = await fence(deps, req.target, th, 'afterRetain')
  if (afterRetain) return afterRetain
  // Last, synchronously and in the answer's own continuation: every pin the credit rests on still at its commit.
  for (const b of boundPins) if (refFromFiles(deps.view.store, b.ref) !== b.oid) return jjUnknown('moved', `bound:${b.ref}`)
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

/**
 * What a settle was based on (HI-2873, Darren's B on HI-2798): the remote and its URL, what the remote had (null: not
 * there), the target's head and jj operation, the sources print the final validator checked, and when. Immutable once
 * written; a re-observation compares the remote, the URL and the verdict with it (the print is kept for diagnosis only).
 */
export interface PublishSeen {
  remote: string
  url: string
  pushed: string | null
  head: string
  op: string
  print: string
  at: number
}

/** One way a settled row no longer matches a re-observation: what, as recorded, and now (null: none). */
export interface PublishDiffer {
  what: 'remote' | 'url' | 'pushed' | 'inRemote' | 'held'
  was: string | null
  now: string | null
}

/** A settled row a re-observation contradicted: what it was, what differs, when seen. Its `seen` is kept as it was. */
export interface PublishCheck {
  was: 'published' | 'notHeld'
  differs: PublishDiffer[]
  at: number
}

/**
 * One integration's publish obligation: keyed by its card, cycle and bundle (its `Integrated` fact), its result.
 * The only moves per key (HI-2873/s11 §3): owed → published | notHeld (`settle`, which writes `seen`, `at` and the
 * store's `seq`), and published | notHeld → checkThis (`flag`, which keeps `seen`). `checkThis` is the user's to resolve
 * (J9c, HI-2869): nothing automatic moves it again. Should J9c ever replace a row at the same key, the flag's
 * compare-and-set needs a monotonic generation then: `at` alone is not unique enough.
 */
export interface JjObligation {
  card: string
  cycle: number
  bundle: string
  target: string
  result: string
  since: number
  state: 'owed' | 'published' | 'notHeld' | 'checkThis'
  pushed?: string
  at?: number
  /** The store's settle sequence, per target, strictly increasing, assigned only by a successful settle (HI-2873/s14). */
  seq?: number
  seen?: PublishSeen
  check?: PublishCheck
}

export type ObligationKey = Pick<JjObligation, 'card' | 'cycle' | 'bundle'>
const keyOf = (o: ObligationKey): string => `${o.card}\u0000${o.cycle}\u0000${o.bundle}`

/**
 * The re-check's schedule for one target (HI-2873/s14, HR2's round 1): the sweep in progress covers the rows with
 * `after < seq ≤ end`, `end` fixed when it starts (rows settled later wait for the next one); `end` 0: none in progress,
 * the next pass starts one. `gen` is the schedule's generation, advanced by every pass that applies (a sweep completed
 * or its position unchanged included), so a delayed pass's compare-and-set fails whatever values the schedule passed
 * through meanwhile (no ABA).
 */
export interface RecheckSweep {
  gen: number
  after: number
  end: number
}

/**
 * Where obligations are kept (durable: J6's board_meta rows; a test's memory). Every change a compare-and-set.
 * Bounded reads on the observation path (HR2's round 1): `owed` and `recheckPage` only, each answered from an index
 * (owed rows by target and state; settled rows by target and `seq`), never by reading the target's whole history.
 */
export interface ObligationStore {
  /** Every row of the target, any state: diagnostics and tests, never the observation path (unbounded). */
  list(target: string): JjObligation[]
  /** The target's owed rows only (an index on target and state). */
  owed(target: string): JjObligation[]
  /** Creates the row only when none exists for its key, in any state (a tombstone blocks it): whether it was created. */
  create(o: JjObligation): boolean
  /**
   * owed → published | notHeld, only while the row is exactly that key and result, and owed: whether it changed. Writes
   * `seen`, `at` (seen's), `pushed` (published) and the next `seq` for the target in the same compare-and-set.
   */
  settle(k: ObligationKey, result: string, to: 'published' | 'notHeld', seen: PublishSeen): boolean
  /** published | notHeld → checkThis, only while the row is that key and result, in state `from`, settled at `recordedAt`. */
  flag(k: ObligationKey, result: string, from: 'published' | 'notHeld', recordedAt: number, check: PublishCheck): boolean
  /**
   * Up to `limit` rows of the target in state published or notHeld, with `seen`, and `after < seq ≤ end`, in `seq` order,
   * from an index on (target, seq): its work bounded by `limit`, never by the target's history.
   */
  recheckPage(target: string, after: number, end: number, limit: number): JjObligation[]
  /** The highest `seq` assigned for the target (0: none). */
  maxSeq(target: string): number
  /** The schedule, or null before any pass applied (generation 0). */
  getSweep(target: string): RecheckSweep | null
  /** Sets the schedule only while its generation is still `expectedGen` (0: none yet), `next.gen` above it: whether it changed. */
  setSweep(target: string, expectedGen: number, next: RecheckSweep): boolean
}

/**
 * An in-memory store with the durable store's semantics and its indexes (tests; and J6's model of its rows): rows by
 * key, owed rows by target, settled rows by target in `seq` order. `work` counts the rows the observation path's reads
 * touch (`owed`, `recheckPage`), so a test can hold them to their bounds.
 */
export function memoryObligations(initial: JjObligation[] = []): ObligationStore & { rows: JjObligation[]; sweeps: Map<string, RecheckSweep>; work: { rows: number } } {
  const rows: JjObligation[] = []
  const byKey = new Map<string, JjObligation>()
  const owedBy = new Map<string, Map<string, JjObligation>>()
  const settledBy = new Map<string, JjObligation[]>()
  const seqs = new Map<string, number>()
  const sweeps = new Map<string, RecheckSweep>()
  const work = { rows: 0 }
  const index = <V>(m: Map<string, V>, k: string, make: () => V): V => {
    let v = m.get(k)
    if (!v) m.set(k, (v = make()))
    return v
  }
  /** The index of the first row with `seq > after` in a list in `seq` order (a binary search). */
  const firstAfter = (list: JjObligation[], after: number): number => {
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].seq! <= after) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const add = (r: JjObligation): void => {
    rows.push(r)
    byKey.set(keyOf(r), r)
    if (r.state === 'owed') index(owedBy, r.target, () => new Map()).set(keyOf(r), r)
    if (r.seq !== undefined) seqs.set(r.target, Math.max(seqs.get(r.target) ?? 0, r.seq))
    if ((r.state === 'published' || r.state === 'notHeld') && r.seen && r.seq !== undefined) {
      const list = index(settledBy, r.target, (): JjObligation[] => [])
      list.splice(firstAfter(list, r.seq), 0, r)
    }
  }
  for (const r of initial) add(r)
  return {
    rows,
    sweeps,
    work,
    list: (target) => rows.filter((r) => r.target === target).map((r) => structuredClone(r)),
    owed: (target) => {
      const out = [...(owedBy.get(target)?.values() ?? [])].map((r) => structuredClone(r))
      work.rows += out.length
      return out
    },
    create: (o) => {
      if (byKey.has(keyOf(o))) return false
      add({ card: o.card, cycle: o.cycle, bundle: o.bundle, target: o.target, result: o.result, since: o.since, state: 'owed' })
      return true
    },
    settle: (k, result, to, seen) => {
      const r = byKey.get(keyOf(k))
      if (!r || r.result !== result || r.state !== 'owed') return false
      const seq = (seqs.get(r.target) ?? 0) + 1
      seqs.set(r.target, seq)
      r.state = to
      r.at = seen.at
      r.seq = seq
      r.seen = { ...seen }
      if (to === 'published' && seen.pushed) r.pushed = seen.pushed
      owedBy.get(r.target)?.delete(keyOf(r))
      index(settledBy, r.target, (): JjObligation[] => []).push(r) // the highest seq so far: the index stays in order
      return true
    },
    flag: (k, result, from, recordedAt, check) => {
      const r = byKey.get(keyOf(k))
      if (!r || r.result !== result || r.state !== from || r.at !== recordedAt) return false
      r.state = 'checkThis'
      r.check = structuredClone(check)
      const list = settledBy.get(r.target)
      if (list && r.seq !== undefined) {
        const i = firstAfter(list, r.seq - 1)
        if (list[i] === r) list.splice(i, 1)
      }
      return true
    },
    recheckPage: (target, after, end, limit) => {
      const list = settledBy.get(target) ?? []
      const out: JjObligation[] = []
      for (let i = firstAfter(list, after); i < list.length && out.length < limit && list[i].seq! <= end; i++) out.push(structuredClone(list[i]))
      work.rows += out.length
      return out
    },
    maxSeq: (target) => seqs.get(target) ?? 0,
    getSweep: (target) => (sweeps.has(target) ? { ...sweeps.get(target)! } : null),
    setSweep: (target, expectedGen, next) => {
      if ((sweeps.get(target)?.gen ?? 0) !== expectedGen || next.gen <= expectedGen) return false
      sweeps.set(target, { ...next })
      return true
    }
  }
}

/** How many settled rows one pass looks at, and how many ancestry reads it may spend on them (HI-2873/s14). */
export const RECHECK_SCAN = 64
export const RECHECK_MAX = 16
/** The most ancestry reads one row's re-check can take (published: seen.pushed ⊂ P, then result ⊂ P; notHeld: in P, then held). */
const READS_PER_ROW = 2

/** What a re-observation sees now: the remote and its URL (null: verified absent), what it has, the target's head. */
export interface PublishNow {
  remote: string | null
  url: string | null
  pushed: string | null
  head: string
}

/** One pass's plan of the re-check: the flags to write, and the sweep to move from `expected` to `next`. */
export interface RecheckPlan {
  flags: { o: JjObligation; check: Omit<PublishCheck, 'at'> }[]
  /** The schedule's generation the plan was made at (0: none yet), and the schedule it moves to (the next generation). */
  expectedGen: number
  next: RecheckSweep
  /** Rows decided in this pass (flagged or unchanged), and ancestry reads spent. */
  decided: number
  reads: number
}

/**
 * Plans one bounded, fair pass of the re-check (HI-2873/s7 §4, s11, s14): the sweep's page of settled rows (at most
 * RECHECK_SCAN), each decided against `now` in `seq` order until the next row's worst case would pass RECHECK_MAX
 * ancestry reads. Reads nothing but the store and `ancestor` (cached per pair within the pass); writes nothing: the
 * caller applies the plan in its synchronous final step. A remote or URL that differs (absent included) flags with no
 * read; a published row stays while its result is still in what the remote has (the remote advancing included); a
 * notHeld row is flagged once its result is in the remote or held by the target again.
 */
export async function planRecheck(store: ObligationStore, target: string, now: PublishNow, ancestor: (a: string, b: string) => Promise<boolean | JjReadUnknown>): Promise<RecheckPlan | JjReadUnknown> {
  const expected = store.getSweep(target)
  const expectedGen = expected?.gen ?? 0
  const sweep = expected && expected.end > 0 ? expected : { after: 0, end: store.maxSeq(target) }
  const page = sweep.end > sweep.after ? store.recheckPage(target, sweep.after, sweep.end, RECHECK_SCAN) : []
  const cache = new Map<string, boolean>()
  let reads = 0
  const anc = async (a: string, b: string): Promise<boolean | JjReadUnknown> => {
    if (a === b) return true
    const k = `${a}..${b}`
    const hit = cache.get(k)
    if (hit !== undefined) return hit
    reads++
    const r = await ancestor(a, b)
    if (typeof r === 'boolean') cache.set(k, r)
    return r
  }
  const flags: RecheckPlan['flags'] = []
  let last = sweep.after
  let decided = 0
  let stopped = false
  for (const o of page) {
    const seen = o.seen!
    const was = o.state as 'published' | 'notHeld'
    const differs: PublishDiffer[] = []
    if (seen.remote !== now.remote) differs.push({ what: 'remote', was: seen.remote, now: now.remote })
    if (seen.url !== now.url) differs.push({ what: 'url', was: seen.url, now: now.url })
    const free = differs.length > 0 || (was === 'published' && (now.pushed === null || now.pushed === seen.pushed))
    if (!free && reads + READS_PER_ROW > RECHECK_MAX) {
      stopped = true
      break
    }
    if (!differs.length) {
      if (was === 'published') {
        const P = now.pushed
        let holds = P !== null && P === seen.pushed
        if (!holds && P !== null) {
          const via = seen.pushed ? await anc(seen.pushed, P) : false
          if (isJjUnknown(via)) return via
          holds = via
          if (!holds) {
            const own = await anc(o.result, P)
            if (isJjUnknown(own)) return own
            holds = own
          }
        }
        if (!holds) differs.push({ what: 'pushed', was: seen.pushed, now: P }, { what: 'inRemote', was: 'yes', now: 'no' })
      } else {
        const inRemote = now.pushed ? await anc(o.result, now.pushed) : false
        if (isJjUnknown(inRemote)) return inRemote
        if (inRemote) differs.push({ what: 'pushed', was: seen.pushed, now: now.pushed }, { what: 'inRemote', was: 'no', now: 'yes' })
        else {
          const held = await anc(o.result, now.head)
          if (isJjUnknown(held)) return held
          if (held) differs.push({ what: 'held', was: 'no', now: 'yes' })
        }
      }
    }
    if (differs.length) flags.push({ o, check: { was, differs } })
    last = o.seq!
    decided++
  }
  // The sweep completes when the page ran out below its fixed end (an empty page included: rows flagged by another
  // pass simply aren't in it); else it carries on after the last row decided, its end unchanged. Either way the
  // generation advances.
  const complete = !stopped && page.length < RECHECK_SCAN
  const next = complete ? { gen: expectedGen + 1, after: 0, end: 0 } : { gen: expectedGen + 1, after: last, end: sweep.end }
  return { flags, expectedGen, next, decided, reads }
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

/** The config files Git reads for the store, found by Git (never parsed here), and the environment that steers Git's config. */
export interface ConfigSources {
  files: string[]
  env: string
}

/** The includeIf conditions Combwork knows the inputs of (all covered by the print: the git dir's path, HEAD, config). */
const CONDITIONS = /^includeif\.(gitdir|gitdir\/i|onbranch|hasconfig:remote\.\*\.url):.*\.path$/i

/** Parses `git config --show-scope --show-origin -z --list` (scope NUL origin NUL key LF value NUL, repeated). */
export function parseConfigList(out: string): { scope: string; origin: string; key: string; value: string }[] | null {
  const parts = out.split('\u0000')
  if (parts.at(-1) === '') parts.pop()
  if (parts.length % 3 !== 0) return null
  const rows: { scope: string; origin: string; key: string; value: string }[] = []
  for (let i = 0; i < parts.length; i += 3) {
    const kv = parts[i + 2]
    const nl = kv.indexOf('\n')
    rows.push({ scope: parts[i], origin: parts[i + 1], key: nl < 0 ? kv : kv.slice(0, nl), value: nl < 0 ? '' : kv.slice(nl + 1) })
  }
  return rows
}

/**
 * The files the print covers (the Assistant's notes on rounds 4–5, HR1's round 4), discovered from Git's own decoded
 * output, never a parser of Combwork's: every file Git reports a value from (system, global, local and everything they
 * include, `--includes`), every include and includeIf target Git reports (resolved against the file naming it, so an
 * empty or missing target is covered too), and each scope's own file whether or not it exists yet (the store's config
 * and config.worktree; `GIT_CONFIG_GLOBAL`, else the XDG and home files; `GIT_CONFIG_SYSTEM`, else Git's install's
 * etc/gitconfig). Unknown (fail closed) for anything it can't resolve to a concrete file: a `~` path, a condition it
 * doesn't know, an origin that isn't a file or Git's own environment config, no home, more than SOURCES_MAX files.
 */
export async function configSources(deps: JjIntegrationDeps): Promise<ConfigSources | JjReadUnknown> {
  const env = deps.gitEnv ?? process.env
  const files = new Set<string>()
  const add = (f: string): void => void files.add(resolve(f))
  add(join(deps.view.store, 'config'))
  add(join(deps.view.store, 'config.worktree'))
  if (env.GIT_CONFIG_GLOBAL) add(env.GIT_CONFIG_GLOBAL)
  else {
    const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : env.USERPROFILE
    if (!home) return jjUnknown('failed', 'no home') // i18n-ignore: a protocol detail for logs and tests, never shown
    add(join(env.XDG_CONFIG_HOME || join(home, '.config'), 'git', 'config'))
    add(join(home, '.gitconfig'))
  }
  if (!/^(1|true|yes|on)$/i.test(env.GIT_CONFIG_NOSYSTEM ?? '')) {
    if (env.GIT_CONFIG_SYSTEM) add(env.GIT_CONFIG_SYSTEM)
    else {
      const exec = await deps.git(['--exec-path'])
      if (!exec.ok || !exec.out.trim()) return jjUnknown('failed', exec.err || 'exec-path')
      // Git for Windows: <install>/<mingw|ucrt>64/libexec/git-core, its system file <install>/etc/gitconfig; elsewhere
      // <prefix>/libexec/git-core and <prefix>/etc/gitconfig. Both covered; an existing one is also among the origins.
      const at = exec.out.trim()
      add(join(at, '..', '..', 'etc', 'gitconfig'))
      add(join(at, '..', '..', '..', 'etc', 'gitconfig'))
    }
  }
  const listed = await deps.git(['config', '--show-scope', '--show-origin', '-z', '--includes', '--list'])
  await deps.hook?.('discovered')
  if (!listed.ok) return jjUnknown('failed', listed.err)
  const rows = parseConfigList(listed.out)
  if (!rows) return jjUnknown('malformed', 'config list') // i18n-ignore: a protocol detail for logs and tests, never shown
  for (const r of rows) {
    if (r.origin.startsWith('file:')) add(r.origin.slice(5))
    else if (r.origin !== 'command line:') return jjUnknown('malformed', `origin ${r.origin}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    if (!/^include(if\..*)?\.path$/i.test(r.key)) continue
    if (/^includeif\./i.test(r.key) && !CONDITIONS.test(r.key)) return jjUnknown('malformed', `condition ${r.key}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    if (!r.origin.startsWith('file:') || !r.value || r.value.startsWith('~')) return jjUnknown('malformed', `include ${r.value}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    add(isAbsolute(r.value) ? r.value : join(dirname(r.origin.slice(5)), r.value))
  }
  if (files.size > SOURCES_MAX) return jjUnknown('malformed', 'too many config files') // i18n-ignore: a protocol detail for logs and tests, never shown
  const steering = Object.keys(env).filter((k) => /^GIT_CONFIG/i.test(k) || /^(HOME|USERPROFILE|XDG_CONFIG_HOME)$/i.test(k)).sort()
  return { files: [...files].sort(), env: steering.map((k) => `${k}=${env[k]}`).join('\n') }
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

/** A settled row the pass turned into checkThis, and what differs. */
export type PublishFlagged = { key: ObligationKey; differs: PublishDiffer[] }

export type PublishObserved =
  | { remote: string; url: string; pushed: string | null; settled: { key: ObligationKey; to: 'published' | 'notHeld' }[]; flagged: PublishFlagged[] }
  | { noRemote: true; flagged: PublishFlagged[] }
  | JjRefused
  | JjReadUnknown

/**
 * One observation of a target's publication (s14 §5′, s17 §2, s20): the owed obligations snapshotted (each with its key
 * and result); the remote chosen and its URL from jj and from the store's config, agreeing; the target's head; the
 * remote's `refs/heads/T` read from the remote; then everything read again (the single head, the target's head, the
 * remote choice and both URLs). Moved, refused or unknown: nothing settled. Else each obligation on its own: in what the
 * remote has (its commit in the store, else `notFetched` for all), `published` with that id; else not in the local
 * target any more, `notHeld`; else still owed. Each settle is the store's compare-and-set on its key, result and state,
 * and keeps what it was based on (`seen`, HI-2873).
 * The same observation re-checks settled rows (HI-2873/s7, s11, s14): one bounded, fair pass of the sweep (`planRecheck`)
 * against what is seen now; a row that no longer matches becomes checkThis with what differs. No remote at all is a
 * verified absence through the same capture: owed rows are never settled then, and settled rows are flagged. The
 * settles, the sweep and the flags are written together in the synchronous step after the final validator.
 */
export async function observePublish(deps: JjIntegrationDeps, target: string, store: ObligationStore, now: () => number = Date.now): Promise<PublishObserved> {
  const owed = store.owed(target)
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
    // The effective URL as Git and jj give it (never parsed here): exactly one value at every level, the same from the
    // store's own config alone, and jj's.
    const all = await deps.git(['config', '--get-all', `remote.${chosen}.url`])
    const own = await deps.git(['config', '--local', '--get-all', `remote.${chosen}.url`])
    if (!all.ok || !own.ok) return jjUnknown('failed', all.err || own.err)
    const url = remotes.get(chosen)!
    const values = lines(all.out)
    if (values.length !== 1 || lines(own.out).join('\n') !== values[0] || values[0] !== url) return refused('disagree', `${url} | ${values.join(' ')} | ${own.out.trim()}`)
    return { remote: chosen, url, rows }
  }
  const th = await jjTargetHead(deps, target)
  if (isJjUnknown(th) || isRefused(th)) return th
  if (!th) return jjUnknown('none', target)
  const r1 = await remoteNow(th.op)
  if (isJjUnknown(r1) || isRefused(r1)) return r1
  // No remote at all: a verified absence, through the same capture (HI-2873/s11 §2); nothing read from a remote.
  const absent = !r1.remote || !r1.url
  const ref = `refs/heads/${target}`
  let pushed: string | null = null
  if (!absent) {
    const ls = await deps.git(['ls-remote', '--refs', r1.url!, ref])
    await deps.hook?.('afterRemote')
    if (!ls.ok) return jjUnknown('failed', ls.err)
    const p = parseLsRemote(ls.out, ref)
    if (p === 'malformed') return jjUnknown('malformed', ls.out)
    pushed = p
  }
  // The observation's whole context read again (the target, its export, the operation, the remote and both URLs): any
  // change, nothing settled. Run across the network read and again after every awaited decision read (HR1's round 1),
  // right before the settles, which are synchronous.
  // Its last step is synchronous (HR1's round 2): the operation heads, the target's Git ref and the remote's URL read from
  // the files with no await between them and the settles, so nothing (a plain Git move included) can come in after them.
  // The check returns its synchronous tail as a validator (HR2's round 6): the caller runs it in its own continuation
  // straight before the synchronous writes, so no awaited return (a microtask) comes between the last read and the CAS.
  // It also hands back the print it validates against, kept as the settles' evidence (HI-2873).
  type Validator = { check: () => JjReadUnknown | null; print: string; sources: ConfigSources }
  const isValidator = (v: JjRefused | JjReadUnknown | Validator): v is Validator => typeof (v as Validator).check === 'function'
  const still = async (where: string): Promise<JjRefused | JjReadUnknown | Validator> => {
    // Every source fingerprinted before the awaited reads, and again at the synchronous end: any change between, or a
    // source that can't be read, is unknown (whether or not the change would matter).
    // The files Git reads, found by Git, as a verified capture (HR2's round 5): discover, print, discover again, print
    // again. The second discovery ran wholly while the files it found were the first print's bytes (the second print is
    // equal), so the set it found describes exactly those bytes: an include added during either discovery is in a changed
    // print or a different set. Any difference: unknown, nothing settled.
    const first = await configSources(deps)
    if (isJjUnknown(first)) return first
    const firstPrint = sourcesPrint(deps.view.store, deps.view.jjRepo, target, first)
    if (firstPrint === undefined) return jjUnknown('failed', `sources:${where}`)
    const sources = await configSources(deps)
    if (isJjUnknown(sources)) return sources
    if (sources.files.join('|') !== first.files.join('|') || sources.env !== first.env) return jjUnknown('moved', `sourceSet:${where}`)
    const before = sourcesPrint(deps.view.store, deps.view.jjRepo, target, sources)
    if (before === undefined) return jjUnknown('failed', `sources:${where}`)
    if (before !== firstPrint) return jjUnknown('moved', `sourceBytes:${where}`)
    const r2 = await remoteNow(th.op)
    if (isJjUnknown(r2) || isRefused(r2)) return r2
    if (r2.remote !== r1.remote || r2.url !== r1.url) return jjUnknown('moved', `remote:${where}`)
    await deps.hook?.('finalRemote')
    const moved = await fence(deps, target, th, where)
    if (moved) return moved
    await deps.hook?.('finalFence')
    const check = (): JjReadUnknown | null => {
      if (readOpHeads(deps.view.jjRepo)?.join() !== th.op) return jjUnknown('moved', `heads:${where}`)
      const refNowSync = refFromFiles(deps.view.store, `refs/heads/${target}`)
      if (refNowSync === undefined || refNowSync !== th.gitRef) return jjUnknown('moved', `ref:${where}`)
      if (sourcesPrint(deps.view.store, deps.view.jjRepo, target, sources) !== before) return jjUnknown('moved', `sources:${where}`)
      return null
    }
    return { check, print: before, sources }
  }
  const afterRemote = await still('afterRemote')
  if (!isValidator(afterRemote)) return afterRemote
  const afterRemoteNow = afterRemote.check()
  if (afterRemoteNow) return afterRemoteNow
  const ancestor = async (a: string, b: string): Promise<boolean | JjReadUnknown> => {
    const r = await deps.git(['merge-base', '--is-ancestor', a, b])
    await deps.hook?.('ancestry')
    return r.code === 0 ? true : r.code === 1 ? false : jjUnknown('failed', r.err)
  }
  if (pushed) {
    const there = await deps.git(['cat-file', '-e', `${pushed}^{commit}`])
    if (!there.ok) return refused('notFetched', pushed)
  }
  // Absent: no publish evidence, so no owed row is decided (as before HI-2873); settled rows are still re-checked.
  const decided: { o: JjObligation; to: 'published' | 'notHeld' }[] = []
  for (const o of absent ? [] : owed) {
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
  const plan = await planRecheck(store, target, { remote: r1.remote, url: r1.url, pushed, head: th.head }, ancestor)
  if (isJjUnknown(plan)) return plan
  const beforeSettle = await still('beforeSettle')
  if (!isValidator(beforeSettle)) return beforeSettle
  // From here to the last write: synchronous, one continuation, or one database transaction of the caller's (`commit`,
  // HI-2882/s22). The validator's reads are the last before the writes (the settles, the sweep and the flags alike).
  const tail: PublishTailInput = { target, view: { jjRepo: deps.view.jjRepo, store: deps.view.store }, op: th.op, gitRef: th.gitRef, head: th.head, sources: beforeSettle.sources, print: beforeSettle.print, where: 'beforeSettle', plan, decided, remote: r1.remote, url: r1.url, pushed, absent, at: now() }
  if (deps.commit) return deps.commit(tail)
  return publishTail(store, tail)
}
