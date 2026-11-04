// The reviewer pool's choice (#1443, SPEC §16.10.5 G17): which free pooled reviewer each submitted card of a pool lane
// goes to, and each design step of one (HI-2310). Pure, so the pass in main (reviewerPool.ts) and the unit tests share it.

import { agentOf } from './facts'
import { reviewsWork, type WorkflowRole } from './roles'

/** A card in Review in one of the project's running lanes, or a pool lane's card in Doing with a design to check (HI-2310), as the pool sees it. */
export interface PoolCard {
  card: number
  /**
   * Its latest submission (the `Submitted` fact's seq) and when it was made: the oldest is given first. For a design
   * (`design`), the design step's own `LoopStep` fact and its time: given out the same way, in the same order.
   */
  submission: number
  submittedAt: string
  /** What is given out is the builder's design waiting for its check (HI-2310), not a submission: answered, not reviewed. */
  design?: boolean
  /**
   * The card's preferred reviewer (HI-2310: whoever answered its design, else gave its last verdict): given it first when
   * free and allowed; busy or not allowed, the next free one takes it as usual.
   */
  preferred?: string | null
  /** Its lane is reviewed by the pool; a lane's own reviewer's card only counts for who is reviewing. */
  pool: boolean
  /** Every agent recorded building it (`review.notAuthor`'s): never its reviewer. */
  builders: string[]
  /** Who was given or started this submission, or gave it a verdict: with G1b = 2 the second is someone else. */
  seen: string[]
  /** Who reviews this submission now (given or started it, no verdict yet): the card waits for it, and it isn't free. */
  reviewing: string | null
  /** G1b: distinct reviewers who must pass it, and how many have. */
  quorum: number
  passes: number
}

/** A project agent, as the pool sees it now. */
export interface PoolAgent {
  id: string
  role: WorkflowRole
  /** It holds an open dispatch lease (#1434: building a card or a lane in a slot). */
  leased: boolean
  /** Not in a turn, waiting, watching, or with background tasks or runs (or not running). */
  idle: boolean
}

export interface PoolAssignment {
  card: number
  submission: number
  reviewer: string
}

/**
 * The assignments to make now: each pool card waiting for a reviewer (nobody on its latest submission, fewer passes than
 * its quorum), oldest submission first, given to the first free agent that reviews, isn't its builder and hasn't seen
 * this submission. Free: its role reviews (reviewer or either), no open dispatch lease, idle, and not reviewing another
 * card (one of `cards`, or of `reviewing`: whoever reviews any other card of the project, or checks a design of one, in
 * a lane or not). In its turn a card takes its preferred reviewer (HI-2310) if still free and allowed, else the next
 * free one; a card no free agent can take doesn't hold up the cards after it.
 */
export function poolAssignments(cards: readonly PoolCard[], agents: readonly PoolAgent[], reviewing: Iterable<string> = []): PoolAssignment[] {
  const busy = new Set([...reviewing, ...cards.map((c) => c.reviewing).filter((r): r is string => !!r)])
  const free = agents.filter((a) => reviewsWork(a.role) && !a.leased && a.idle && !busy.has(a.id))
  const waiting = cards.filter((c) => c.pool && !c.reviewing && c.passes < c.quorum).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.card - b.card)
  const allowed = (c: PoolCard, a: PoolAgent): boolean => !c.builders.includes(a.id) && !c.seen.includes(a.id)
  const out: PoolAssignment[] = []
  for (const c of waiting) {
    // In its turn, oldest first: its preferred reviewer (HI-2310: the same eyes on the design and the build) if still
    // free and allowed, else the next free one. A preference never puts a card ahead of an older one.
    const a = (c.preferred ? free.find((x) => x.id === c.preferred && allowed(c, x)) : undefined) ?? free.find((x) => allowed(c, x))
    if (!a) continue
    out.push({ card: c.card, submission: c.submission, reviewer: a.id })
    free.splice(free.indexOf(a), 1)
  }
  return out
}

type FactLike = { kind: string; seq: number; at?: string; actor?: string; data: unknown }

/**
 * A card's design step waiting for its check (HI-2310), as the card's fold has it (`CardState.step`): the newest
 * `LoopStep` a design, with no step, move, submission or verdict after it. Null: none waits.
 */
export function openDesign(facts: readonly FactLike[]): { seq: number; at: string } | null {
  let open: { seq: number; at: string } | null = null
  for (const f of facts) {
    if (f.kind === 'LoopStep') open = (f.data as { step?: string }).step === 'design' ? { seq: f.seq, at: f.at ?? '' } : null
    else if (f.kind === 'Moved' || f.kind === 'Submitted' || f.kind === 'Verdict') open = null
  }
  return open
}

/** Who checks a card's open design (HI-2310): its pool assignment not given up, or null (none open, or not given out yet). */
export function designReviewer(facts: readonly FactLike[], known: (id: string) => boolean): string | null {
  const d = openDesign(facts)
  return d ? submissionReviewers(facts, d.seq, known).reviewing : null
}

/**
 * A pool card's preferred reviewer (HI-2310): the agent who last answered one of its designs (`ok` or `gaps`), else the
 * one who gave its last verdict; null when neither is an agent (the user's or the Assistant's answer). It stays with the
 * card for its review rounds while it is free.
 */
export function preferredReviewer(facts: readonly FactLike[]): string | null {
  const answer = facts.findLast((f) => f.kind === 'LoopStep' && ['ok', 'gaps'].includes((f.data as { step?: string }).step ?? '') && (f.data as { of?: string }).of === 'design')
  const by = answer?.actor ? agentOf(answer.actor as `agent:${string}`) : null
  if (by) return by
  const verdict = facts.findLast((f) => f.kind === 'Verdict')?.data as { reviewer?: string } | undefined
  return verdict?.reviewer && verdict.reviewer !== 'user' ? verdict.reviewer : null
}

/**
 * A submission's reviewers from its card's facts after it (in order): who was given it (`ReviewerAssigned`) or started
 * it (`ReviewStarted`), and who gave it a verdict. An assignment given up (`ReviewerReleased`) counts as neither.
 * `reviewing`: the newest given or started with no verdict yet, among `known` (an agent removed from the project can't
 * review it; the user always counts).
 */
export function submissionReviewers(facts: readonly { kind: string; seq: number; data: unknown }[], submission: number, known: (id: string) => boolean): { seen: string[]; reviewing: string | null } {
  let on: string[] = []
  const judged = new Set<string>()
  for (const f of facts) {
    if (f.seq <= submission) continue
    const d = f.data as { reviewer?: unknown; submission?: unknown }
    if (d.submission !== submission || typeof d.reviewer !== 'string') continue
    if (f.kind === 'ReviewerAssigned' || f.kind === 'ReviewStarted') on.push(d.reviewer)
    else if (f.kind === 'ReviewerReleased') on = on.filter((r) => r !== d.reviewer)
    else if (f.kind === 'Verdict') judged.add(d.reviewer)
  }
  const reviewing = on.filter((r) => !judged.has(r) && (r === 'user' || known(r))).at(-1) ?? null
  return { seen: [...new Set([...on, ...judged])], reviewing }
}

/**
 * The reviews of a submission in progress (HI-2487): each reviewer that started it (`ReviewStarted`) and has given it no
 * verdict since, with when it started, oldest first: the user's (HR1's round 1: a review the user took is the user's
 * until its verdict), and an agent's among `present` (one of the project's agents with its session running). A start
 * again (a follow-up's, its own) keeps its first time.
 */
export function reviewsInProgress(facts: readonly { kind: string; seq: number; at?: string; data: unknown }[], submission: number, present: (id: string) => boolean): { reviewer: string; since: string }[] {
  const on = new Map<string, string>()
  for (const f of facts) {
    if (f.seq <= submission) continue
    const d = f.data as { reviewer?: unknown; submission?: unknown }
    if (d.submission !== submission || typeof d.reviewer !== 'string') continue
    if (f.kind === 'ReviewStarted' && !on.has(d.reviewer)) on.set(d.reviewer, f.at ?? '')
    else if (f.kind === 'Verdict' || f.kind === 'ReviewerReleased') on.delete(d.reviewer)
  }
  return [...on].filter(([r]) => r === 'user' || present(r)).map(([reviewer, since]) => ({ reviewer, since }))
}

/** Who reviews a card now: its latest submission's reviewer with no verdict yet (submissionReviewers), else null. */
export function reviewingNow(facts: readonly { kind: string; seq: number; data: unknown }[], known: (id: string) => boolean): { submission: number; reviewing: string | null } | null {
  const latest = facts.findLast((f) => f.kind === 'Submitted')
  return latest ? { submission: latest.seq, reviewing: submissionReviewers(facts, latest.seq, known).reviewing } : null
}
