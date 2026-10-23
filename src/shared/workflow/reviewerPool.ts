// The reviewer pool's choice (#1443, SPEC §16.10.5 G17): which free pooled reviewer each submitted card of a pool lane
// goes to. Pure, so the pass in main (reviewerPool.ts) and the unit tests share it.

import { reviewsWork, type WorkflowRole } from './roles'

/** A card in Review in one of the project's running lanes, as the pool sees its latest submission. */
export interface PoolCard {
  card: number
  /** Its latest submission (the `Submitted` fact's seq) and when it was made: the oldest is given first. */
  submission: number
  submittedAt: string
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
 * card. A card no free agent can take doesn't hold up the cards after it.
 */
export function poolAssignments(cards: readonly PoolCard[], agents: readonly PoolAgent[]): PoolAssignment[] {
  const busy = new Set(cards.map((c) => c.reviewing).filter((r): r is string => !!r))
  const free = agents.filter((a) => reviewsWork(a.role) && !a.leased && a.idle && !busy.has(a.id))
  const waiting = cards.filter((c) => c.pool && !c.reviewing && c.passes < c.quorum).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.card - b.card)
  const out: PoolAssignment[] = []
  for (const c of waiting) {
    const a = free.find((x) => !c.builders.includes(x.id) && !c.seen.includes(x.id))
    if (!a) continue
    out.push({ card: c.card, submission: c.submission, reviewer: a.id })
    free.splice(free.indexOf(a), 1)
  }
  return out
}

/**
 * A submission's reviewers from its card's facts after it (in order): who was given it (`ReviewerAssigned`) or started
 * it (`ReviewStarted`), and who gave it a verdict. `reviewing`: the newest given or started with no verdict yet, among
 * `known` (an agent removed from the project can't review it; the user always counts).
 */
export function submissionReviewers(facts: readonly { kind: string; seq: number; data: unknown }[], submission: number, known: (id: string) => boolean): { seen: string[]; reviewing: string | null } {
  const on: string[] = []
  const judged = new Set<string>()
  for (const f of facts) {
    if (f.seq <= submission) continue
    const d = f.data as { reviewer?: unknown; submission?: unknown }
    if (d.submission !== submission || typeof d.reviewer !== 'string') continue
    if (f.kind === 'ReviewerAssigned' || f.kind === 'ReviewStarted') on.push(d.reviewer)
    else if (f.kind === 'Verdict') judged.add(d.reviewer)
  }
  const reviewing = on.filter((r) => !judged.has(r) && (r === 'user' || known(r))).at(-1) ?? null
  return { seen: [...new Set([...on, ...judged])], reviewing }
}
