// HI-2753 (SPEC §16.5.4, designs s8 → s11 → s15 → s18): a card in flight, and its running lane, moved from the target it
// started on (`from`, an integration branch that ended, say) to another (`to`), its line, base and work kept. Only when
// everything the card would bring into `to` is provably its own work, never another branch's history:
//
// - (a) S = `rev-list H ^T` (H the line's head, T `to`'s) lies on H's first-parent chain: no merge brought in commits
//   `to` lacks;
// - (b) no commit of S is reachable from any ref but the card's own (its lines, its pins, its queue refs, a stash) or from
//   another worktree's detached HEAD: nothing shared with `from`, a remote copy of it, a tag or another branch;
// - (c) the line's reflog, from its creation on, records only the card's own work: commits, cherry-picks, reverts and
//   real merges; any other entry (a fast-forward, a reset, a rebase, a pull, a move of Combwork's) only to a commit `to`
//   has, or back to one the line had before. A rebase or a reflog that doesn't start at the line's creation refuses;
// - (d) every point the line was created or (re)started from (its reflog's first entry, each `Started`'s base on it) is
//   in `to`: the history it inherited is `to`'s.
//
// A card reviewed (Review, Passed, Merging) also needs its reviewed revision R to pass (a), (b) and (d) and to bring into
// `to` exactly the commits it was reviewed with (`R ^T` = `R ^base`): its verdicts and runs at R stay, its base becomes
// `merge-base(R, T)`, and the queue checks the merge result against `to` as for any card.
//
// The move is a compare and swap that holds git's own locks (refHold.ts): the check outside every lock; then the lanes'
// lock, the board's, and a prepared `git update-ref --stdin` verifying the line at H and `to` at T (an agent's commit or
// reset meanwhile fails on git's lock, or makes the prepare fail); under them the card (and its lane) checked again as
// it was seen; then one board write. The transaction is closed after the write commits (or is undone), always.
//
// HI-2821: the proof is the card's platform's (its history port's `ownWork`: Git's is gitOwnWork.ts), and the hold port
// 1's `holdRefs`; this module keeps the workflow's parts. A platform without the proof doesn't offer the move.

import { historyOf } from '../platform/historyPorts'
import type { OwnWorkAsk, OwnWorkRule } from '../platform/history'
import { portsOf, repoContext } from '../platform/repoPorts'
import type { RefHold, RefHoldRefused } from '../platform/repoContext'
import { isUnknown } from '../platform/types'
import type { PlatformId } from '../../shared/platform/descriptors'
import { laneTargetOf, targetedOf } from '../../shared/workflow/compile'
import type { CardState, StageId } from '../../shared/workflow/facts'
import type { CardRecord } from './factStore'
import type { Workflow } from './runtime'

/**
 * How long a move waits for git to prepare its ref transaction (the locks taken), and for git to exit once it is closed
 * (else it is ended). Only the prepare is bounded: once held, nothing but the close releases the locks.
 */
export const REF_HOLD = { prepareMs: 15_000, closeMs: 5_000 }

/** Tests: told once a move's check is made, before any lock is taken (a seam between the check and the hold). */
export const moveTestHooks: { checked?: (c: CardMoveCheck) => void | Promise<void> } = {}

/** The stages a card is in flight in (started, not Done): Doing, Review, Passed, Merging. */
export const IN_FLIGHT_STAGES: readonly StageId[] = ['active', 'review', 'approved', 'merging']

/** Why a card in flight can't move to another target (said in words where it is shown). */
export type MoveWhy = 'notStarted' | 'noLine' | 'queued' | 'targetMissing' | 'notInTarget' | 'reviewed' | 'cantCheck' | 'lane' | 'changed' | 'locked'

/** Which rule of the proof failed (MoveWhy `notInTarget`). */
export type ProofRule = OwnWorkRule

export interface MoveRefusal {
  why: MoveWhy
  rule?: ProofRule
  /** What git or the check said (English, for the log and the reply's detail). */
  detail?: string
  /** A lock someone else holds (`locked`): its file, never removed by Combwork. */
  lock?: string
  ref?: string
}

/** A card's move as it was checked: the commits it was proved at, its lane as it was, and the base its submission takes. */
export interface CardMoveCheck {
  card: number
  key: string
  /** The platform it was proved on (its ruleset's): the one whose locks hold its refs. */
  platform: PlatformId
  from: string
  to: string
  line: string
  head: string
  toHead: string
  /** Its latest submission's base with `to` (a reviewed card: the same commits), else none. */
  base?: string
  /** Its running lane as it was seen (its id and ruleset). */
  lane?: { id: string; ruleset: string; target: string | null }
  /**
   * The card's last fact when it was checked (HR2's round 1, finding 1): any fact since (a submission, a verdict, an
   * approval, an enqueue, options applied) changes what the proof was made for, so the move is refused as changed.
   */
  seq: number
}

export type CheckResult = { ok: true; check: CardMoveCheck } | ({ ok: false } & MoveRefusal)

const FULL = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/** The lane a card is in, while it runs, with its target (the one its ruleset marks, else the ruleset's G7). */
/** A running lane as a preview saw it (HR2's round 1, finding 2): the apply moves it only while it is still so. */
export interface LaneSeen {
  id: string
  ruleset: string
  cards: number[]
  pending: number[] | null
}

/** Whether lane `id` is still as `seen` (its record, ruleset, list and queued list), read where the caller holds the locks. */
export function laneStill(wf: Workflow, seen: LaneSeen): boolean {
  const rec = wf.lane(seen.id)
  const same = (a: readonly number[] | null, b: readonly number[] | null): boolean => (a === null || b === null ? a === b : a.length === b.length && a.every((x, i) => x === b[i]))
  return !!rec && !rec.ended && rec.ruleset === seen.ruleset && same(rec.cards, seen.cards) && same(rec.pending, seen.pending)
}

export function laneOf(wf: Workflow, card: CardRecord): CardMoveCheck['lane'] | undefined {
  const rec = card.lane ? wf.lane(card.lane) : null
  if (!rec || rec.ended || !rec.ruleset) return undefined
  return { id: rec.id, ruleset: rec.ruleset, target: laneTargetOf(rec.ruleset, (r) => wf.store.ruleset(r).options) }
}

/** Whether a card in `s` could be moved at all (in flight, started on a target, on a line of its own): the first refusal, else null. */
export function movable(wf: Workflow, s: CardState): MoveRefusal | null {
  if (!s.started || !IN_FLIGHT_STAGES.includes(s.stage) || !s.started.target) return { why: 'notStarted' } // i18n-ignore: a reason's code, said in words where it is shown
  if (!wf.ownLine(s) || !s.started.line) return { why: 'noLine' } // i18n-ignore: a reason's code, said in words where it is shown
  if (s.entries.some((e) => e.state === 'open' || e.state === 'started')) return { why: 'queued' } // i18n-ignore: a reason's code, said in words where it is shown
  return null
}

/**
 * Checks a move of the card in flight `card` to `to` in the project at `projectPath` (rules (a) to (d) above), read
 * outside every lock: what the apply holds the refs at and checks again, or why not.
 */
export async function checkCardMove(wf: Workflow, projectPath: string, card: CardRecord, to: string): Promise<CheckResult> {
  const s = wf.state(card)
  const first = movable(wf, s)
  if (first) return { ok: false, ...first }
  const from = s.started!.target!
  const line = s.started!.line!
  // The card's platform's proof (its ruleset's); none: the move isn't offered (§16.3.6's rule 6), as one it can't check.
  const platform = wf.rulesetOf(card, s).options.platform
  const hist = historyOf(platform)
  const proof = hist?.ownWork
  if (!hist || !proof) return { ok: false, why: 'cantCheck', detail: noProof(platform) } // i18n-ignore: a reason's code, said in words where it is shown
  const H = await hist.lineHead(projectPath, line)
  if (isUnknown(H)) return { ok: false, why: 'cantCheck', detail: H.what } // i18n-ignore: a reason's code, said in words where it is shown
  if (!H) return { ok: false, why: 'cantCheck', detail: `the branch ${line} is gone` } // i18n-ignore: a reason's detail (English)
  const T = await hist.lineHead(projectPath, to)
  if (isUnknown(T)) return { ok: false, why: 'cantCheck', detail: T.what } // i18n-ignore: a reason's code, said in words where it is shown
  if (!T) return { ok: false, why: 'targetMissing', ref: to } // i18n-ignore: a reason's code, said in words where it is shown
  const facts = wf.store.facts(card.id)
  const anchors = [...new Set(facts.filter((f) => (f.kind === 'Started' || f.kind === 'Adopted') && (f.data as { line?: string | null }).line === line).map((f) => (f.data as { base?: string | null }).base).filter((b): b is string => !!b && FULL.test(b)))]
  const own = ownRefs(card.key, s.lines.length ? s.lines : [line])
  const folder = wf.folderOf(s)
  const refused = await proof.prove(projectPath, { line, head: H, target: T, anchors, own, folder, reflog: true })
  if (refused) return { ok: false, ...refused }
  // A reviewed card: its reviewed revision brings into `to` what it was reviewed with.
  const sub = s.latest
  let base: string | undefined
  const reviewed = s.stage !== 'active'
  if (sub?.revision && sub.base && FULL.test(sub.revision)) {
    const same = await proof.sameCommits(projectPath, sub.revision, sub.base, T)
    if (isUnknown(same)) return { ok: false, why: 'cantCheck', detail: same.what } // i18n-ignore: a reason's code, said in words where it is shown
    if (same && sub.revision !== H) {
      const r = await proof.prove(projectPath, { line, head: sub.revision, target: T, anchors, own, folder, reflog: false })
      if (r) return reviewed ? { ok: false, ...r, why: r.why === 'notInTarget' ? 'reviewed' : r.why } : { ok: false, ...r } // i18n-ignore: a reason's code, said in words where it is shown
    }
    if (!same && reviewed) return { ok: false, why: 'reviewed' } // i18n-ignore: a reason's code, said in words where it is shown
    if (same) {
      const mb = await hist.mergeBase(projectPath, sub.revision, T)
      if (isUnknown(mb) || !mb) return { ok: false, why: 'cantCheck', detail: isUnknown(mb) ? mb.what : `no merge base of ${sub.revision.slice(0, 7)} and ${to}` } // i18n-ignore: a reason's detail (English)
      base = mb
    }
  } else if (reviewed) return { ok: false, why: 'reviewed' } // i18n-ignore: a reason's code, said in words where it is shown
  const lane = laneOf(wf, card)
  return { ok: true, check: { card: card.id, key: card.key, platform, from, to, line, head: H, toHead: T, seq: s.lastSeq, ...(base ? { base } : {}), ...(lane ? { lane } : {}) } }
}

/** A platform's missing own-work proof, as a refusal's detail (English, for the log and the reply's detail). */
const noProof = (platform: PlatformId): string => `${platform} has no proof that a line's work is its own` // i18n-ignore: a reason's detail (English)

/** The card's own refs (rule b): its lines (and remote copies of them), its submissions' pins, its queue refs, a stash. */
export function ownRefs(key: string, lines: readonly string[]): (ref: string) => boolean {
  const k = key.toLowerCase()
  const ls = lines.map((l) => l.toLowerCase())
  return (ref: string): boolean => {
    const r = ref.toLowerCase()
    if (r === 'refs/stash') return true
    if (ls.some((l) => r === `refs/heads/${l}` || (r.startsWith('refs/remotes/') && r.endsWith(`/${l}`)))) return true
    if (r.startsWith(`refs/cw/cards/${k}/`)) return true
    return r === `refs/cw/queue/${k}` || new RegExp(`^refs/cw/queue/${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-e\\d+$`).test(r)
  }
}

/**
 * Rules (a) to (d) for `head` against `target` (both full ids), by the own-work proof of the platform whose repository
 * holds `repo` (HI-2821; Git's is gitOwnWork.ts): null when every commit `head` would bring into `target` is provably the
 * line's own; else the rule that failed, or why it couldn't be read. `reflog`: rule (c) too.
 */
export async function proveOwn(repo: string, p: OwnWorkAsk): Promise<MoveRefusal | null> {
  const ctx = await repoContext(repo)
  const proof = ctx ? historyOf(ctx.platform)?.ownWork : undefined
  if (!ctx || !proof) return { why: 'cantCheck', detail: ctx ? noProof(ctx.platform) : `no repository at ${repo}` } // i18n-ignore: a reason's detail (English)
  return proof.prove(repo, p)
}

/** A move refused at the apply: what was found then. */
export class MoveRefused extends Error {
  constructor(readonly refusal: MoveRefusal) {
    super(refusal.detail ?? refusal.why)
  }
}

/** A hold's refusal, as a move's: someone else's lock named (never removed), a ref moved meanwhile, or git couldn't. */
export function heldRefusal(r: RefHoldRefused): MoveRefusal {
  if (r.why === 'locked') return { why: 'locked', ...(r.lock ? { lock: r.lock } : {}), ...(r.ref ? { ref: r.ref } : {}), detail: r.detail } // i18n-ignore: a reason's code, said in words where it is shown
  if (r.why === 'moved') return { why: 'changed', ...(r.ref ? { ref: r.ref } : {}), detail: r.detail } // i18n-ignore: a reason's code, said in words where it is shown
  return { why: 'cantCheck', detail: r.detail } // i18n-ignore: a reason's code, said in words where it is shown
}

/**
 * Holds the refs a check was made at (the line at its head, the target at its head): git's own locks, taken under the
 * caller's board lock and closed by the caller once its write has committed or been undone (`close()` in a finally
 * outside the board's write, which is after either). Refused (MoveRefused) when they can't be held as checked.
 */
export async function holdChecked(projectPath: string, c: Pick<CardMoveCheck, 'platform' | 'line' | 'head' | 'to' | 'toHead'>): Promise<RefHold> {
  // Port 1's holds, of the platform it was proved on (HI-2821): Git's are refHold.ts's, through its context's folder.
  const ctx = await repoContext(projectPath, c.platform)
  if (!ctx) throw new MoveRefused({ why: 'cantCheck', detail: `no repository at ${projectPath}` }) // i18n-ignore: a reason's detail (English)
  const got = await portsOf(ctx).locks.holdRefs(
    ctx,
    [
      { ref: `refs/heads/${c.line}`, oid: c.head },
      { ref: `refs/heads/${c.to}`, oid: c.toHead }
    ],
    REF_HOLD
  )
  if ('refused' in got) throw new MoveRefused(heldRefusal(got.refused))
  return got.hold
}

/** Throws once `hold` is lost (its git ended or its input broke): called last in the write, in the tick it commits in. */
export function stillHeld(hold: RefHold): void {
  if (hold.lost()) throw new MoveRefused({ why: 'changed', detail: 'git stopped holding the branches before the move was written' }) // i18n-ignore: a reason's detail (English)
}

/**
 * Checks, under the board's lock and the held refs, that the card is still as `c` saw it: started on `from` on the same
 * line, in flight, with no open queue entry, and its lane (if any) as it was. The first difference, else null.
 */
export function stillAsChecked(wf: Workflow, card: CardRecord, c: CardMoveCheck): MoveRefusal | null {
  const s = wf.state(card)
  const first = movable(wf, s)
  if (first) return first.why === 'notStarted' ? { why: 'changed' } : first // i18n-ignore: a reason's code, said in words where it is shown
  if (s.started!.target !== c.from || s.started!.line !== c.line || s.lastSeq !== c.seq) return { why: 'changed' } // i18n-ignore: a reason's code, said in words where it is shown
  const lane = laneOf(wf, card)
  if ((lane?.id ?? null) !== (c.lane?.id ?? null) || (lane?.ruleset ?? null) !== (c.lane?.ruleset ?? null)) return { why: 'changed' } // i18n-ignore: a reason's code, said in words where it is shown
  return null
}

/** The card's rules merging into `to` (HI-2556's targeted rules), and its lane's (when it moves with it). */
export function rulesInto(wf: Workflow, card: CardRecord, to: string): { card: ReturnType<Workflow['reviewedRuleset']>; lane: ReturnType<Workflow['reviewedRuleset']> | null } {
  const lane = laneOf(wf, card)
  return { card: targetedOf(wf.reviewedRuleset(card), to), lane: lane ? targetedOf(wf.store.ruleset(lane.ruleset), to) : null }
}
