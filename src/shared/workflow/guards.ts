// The guards of the piece library (SPEC §16.5.3), as pure functions of a card's derived state and the platform's
// answers gathered before the transaction. Each holds (null) or refuses with its rule and values; an answer the
// platform couldn't give refuses as unknown, naming what couldn't be read (§16.3.1).
//
// In the app (#1263): the runtime (main/workflow/service.ts) runs them; #1265 on route the board's moves through it.

import { awaitsAgentMerge, type Ruleset } from './compile'
import { approvedByUser, passingReviewers, transientRequeues, type CardKind, type CardState, type CheckRanData } from './facts'
import { reviewByYou, reviewerAgent } from './options'
import { choiceStands, type FocusedChoice } from './focused'
import type { GuardId } from './pieces'
import type { RefusalValues, RuleId } from './refusals'
import type { StoredText } from '../types'

export interface UnknownAnswer {
  unknown: true
  what: string
  whatText?: StoredText
}
type Ans<T> = T | UnknownAnswer
const isUnknownAnswer = (v: unknown): v is UnknownAnswer => !!v && typeof v === 'object' && (v as UnknownAnswer).unknown === true

/** The platform's answers and the move's arguments a guard reads; only those its move's guards need are filled. */
export interface GuardInputs {
  card: { key: string; kind: CardKind; labels: string[]; blocked: string | null }
  state: CardState
  ruleset: Ruleset
  /** The acting agent, if an agent acts. */
  agent: string | null
  revision?: string | null
  /** Cards it waits for that aren't Done by facts. */
  waitingFor?: Ans<string[]>
  slotFree?: Ans<boolean>
  folder?: string
  dirty?: Ans<string[]>
  conflicts?: Ans<string[]>
  /** A commit attributed to no card since the agent's last submission, when another card shares the folder. */
  untrailered?: Ans<string | null>
  /**
   * A commit not authored with the project's identity, read from git at the move (HI-2266: never a saved copy), with
   * that identity's email; `missing` when git has none for the project.
   */
  badIdentity?: Ans<{ commit: string; email: string } | 'missing' | null>
  /** Configured checks with no passing, counted run on the revision. */
  checksMissing?: string[]
  /**
   * The first missing check's newest run on the revision, when it didn't count (#1654): why, what it saw change, and
   * whether a check copy (`--isolated`) is a remedy on the platform.
   */
  checkUncounted?: { whyNot: NonNullable<CheckRanData['whyNot']>; changes?: string[]; isolatable: boolean }
  runsGoing?: string[]
  /** The verdict's submission. */
  submission?: number
  contained?: Ans<boolean>
  target?: string
  upToDate?: Ans<boolean>
  mergeChecks?: 'passed' | 'failed'
  /** G20 (HI-1367): the submission's focused tests, as its pick and the builder's list left them. */
  focused?: FocusedChoice
}

export interface GuardRefusal {
  rule: RuleId
  values: RefusalValues
}

const short = (r: string | null | undefined): string => (r ? r.slice(0, 7) : '—')

/** Does the user's OK before merging (G10) apply to this card? */
/** submit.trailer's refusal: card `key`'s commit `commit` names no card, with the amend that fixes it (HI-2562: also its submit's). */
export function trailerRefusal(key: string, commit: string): GuardRefusal {
  return { rule: 'submit.trailer', values: { card: key, commit: short(commit), command: `git commit --amend --no-edit --trailer "Hive-Card: ${key}"` } } // i18n-ignore: a git command, as typed
}

export function okBeforeApplies(r: Ruleset, labels: string[]): boolean {
  const o = r.options.okBefore
  return o.mode === 'every' || (o.mode === 'labels' && labels.some((l) => o.labels.includes(l)))
}

/**
 * Why the revision isn't approved under the ruleset (`integrate.approved`), or null when it is: passes from the
 * required number of distinct reviewers and the approvals it needs, all at the current generation, none stale.
 */
export function notApproved(s: CardState, r: Ruleset, labels: string[]): { missing: 'stale' | 'passes' | 'userOk'; n?: number; q?: number } | null {
  if (s.stale) return { missing: 'stale' }
  // The user moved it past review across the rules (an override, recorded): it counts as approved.
  if (s.approvalOverridden) return null
  const o = r.options
  if (reviewerAgent(o.review)) {
    const n = passingReviewers(s).length
    if (n < o.reviewers) return { missing: 'passes', n, q: o.reviewers }
  }
  if (reviewByYou(o.review) && !approvedByUser(s, 'review')) return { missing: 'userOk' }
  if (okBeforeApplies(r, labels) && !approvedByUser(s, 'okBefore')) return { missing: 'userOk' }
  return null
}

type Guard = (i: GuardInputs) => GuardRefusal | null

const unknownRefusal = (i: GuardInputs, id: GuardId, a: UnknownAnswer): GuardRefusal => ({ rule: 'platform.unknown', values: { card: i.card.key, what: a.whatText ?? a.what, rule: id } })

/** Each guard. A guard refuses only from what it was given: inputs a move didn't gather hold (the move doesn't need them). */
export const GUARD_FNS: Record<GuardId, Guard> = {
  'start.notBlocked': (i) => (i.card.blocked ? { rule: 'start.notBlocked', values: { card: i.card.key, reason: i.card.blocked } } : null),
  'start.dependenciesIntegrated': (i) => {
    const w = i.waitingFor
    if (w === undefined) return null
    if (isUnknownAnswer(w)) return unknownRefusal(i, 'start.dependenciesIntegrated', w)
    return w.length ? { rule: 'start.dependenciesIntegrated', values: { card: i.card.key, waitsFor: w[0] } } : null
  },
  'start.slotAvailable': (i) => {
    // A no-code card takes no slot (HI-2335): this rule never holds it.
    if (i.slotFree === undefined || i.card.kind === 'no-code') return null
    if (isUnknownAnswer(i.slotFree)) return unknownRefusal(i, 'start.slotAvailable', i.slotFree)
    return i.slotFree ? null : { rule: 'start.slotAvailable', values: { card: i.card.key } }
  },
  'submit.notDuplicate': (i) => {
    const s = i.state
    const waiting = s.latest && (s.stage === 'review' || s.stage === 'merging' || ((s.stage === 'approved' || awaitsAgentMerge(i.ruleset, s)) && !s.stale))
    if (i.card.kind === 'no-code') return waiting ? { rule: 'submit.notDuplicate', values: { card: i.card.key, revision: '—' } } : null
    if (waiting && s.latest!.revision === i.revision) return { rule: 'submit.notDuplicate', values: { card: i.card.key, revision: short(i.revision) } }
    return null
  },
  'requeue.allowed': (i): GuardRefusal | null => {
    const s = i.state
    const last = s.entries[s.entries.length - 1]
    const transient = last && ((last.state === 'failed' && last.failure?.transient) || (last.state === 'cancelled' && (last.cancelled === 'hold' || last.cancelled === 'user')))
    if (!transient) return { rule: 'requeue.allowed', values: { card: i.card.key, revision: short(i.revision), cause: 'requeueNotTransient' } }
    const n = transientRequeues(s)
    if (n >= 2) return { rule: 'requeue.allowed', values: { card: i.card.key, revision: short(i.revision), cause: 'requeueLimit', n } }
    return null
  },
  'submit.ready': (i) => {
    if (i.conflicts === undefined) return null
    if (isUnknownAnswer(i.conflicts)) return unknownRefusal(i, 'submit.ready', i.conflicts)
    return i.conflicts.length ? { rule: 'submit.ready', values: { card: i.card.key, revision: short(i.revision), files: i.conflicts.join(', ') } } : null
  },
  'submit.clean': (i) => {
    if (i.dirty === undefined) return null
    if (isUnknownAnswer(i.dirty)) return unknownRefusal(i, 'submit.clean', i.dirty)
    return i.dirty.length ? { rule: 'submit.clean', values: { card: i.card.key, folder: i.folder ?? '', files: i.dirty.slice(0, 5).join(', ') } } : null
  },
  'submit.trailer': (i) => {
    const u = i.untrailered
    if (u === undefined || u === null) return null
    if (isUnknownAnswer(u)) return unknownRefusal(i, 'submit.trailer', u)
    return trailerRefusal(i.card.key, u)
  },
  // G20 (HI-1367): a pick that failed or said "every test" stands only with the builder's own list (`tests`).
  'submit.focusedChosen': (i) => (!i.focused || choiceStands(i.focused) ? null : { rule: 'submit.focusedChosen', values: { card: i.card.key, revision: short(i.revision), state: i.focused.state, why: i.focused.why ?? 'none' } }), // i18n-ignore: codes (a why, a check name), never shown as text
  'submit.checksPassed': (i) => {
    const missing = i.checksMissing ?? []
    if (!missing.length) return null
    // Its last run's reason when it ran and didn't count (#1654): `none` when it didn't run or failed.
    const u = i.checkUncounted
    const why = { why: u?.whyNot ?? 'none', files: u?.changes?.length ? u.changes.join(', ') : 'none', copy: u?.isolatable ? 'yes' : 'no' } // i18n-ignore: select keys and paths, never shown as they are
    return { rule: 'submit.checksPassed', values: { card: i.card.key, check: missing[0], revision: short(i.revision), command: `hive-progress --check ${missing[0]} --card ${i.card.key}`, ...why } } // i18n-ignore: a command, as typed
  },
  'submit.identity': (i) => {
    const b = i.badIdentity
    if (b === undefined || b === null) return null
    if (isUnknownAnswer(b)) return unknownRefusal(i, 'submit.identity', b)
    if (b === 'missing') return { rule: 'submit.identity', values: { card: i.card.key, missing: 'yes', commit: '', email: '', command: 'git config user.email' } } // i18n-ignore: a select key and a git command, as typed
    return { rule: 'submit.identity', values: { card: i.card.key, missing: 'no', commit: short(b.commit), email: b.email, command: 'git commit --amend --no-edit --reset-author' } } // i18n-ignore: a select key and a git command, as typed
  },
  'submit.ownRunsStopped': (i) => (i.runsGoing?.length ? { rule: 'submit.ownRunsStopped', values: { card: i.card.key, runs: i.runsGoing.join(', ') } } : null),
  'submit.decisionsReceived': (i) => (i.agent !== null && (i.state.received[i.agent] ?? 0) < i.state.generation ? { rule: 'submit.decisionsReceived', values: { card: i.card.key } } : null),
  'review.notAuthor': (i) => (i.agent !== null && i.state.builders.includes(i.agent) ? { rule: 'review.notAuthor', values: { card: i.card.key } } : null),
  'review.decisionsReceived': (i) => (i.agent !== null && (i.state.received[i.agent] ?? 0) < i.state.generation ? { rule: 'review.decisionsReceived', values: { card: i.card.key } } : null),
  'verdict.reviewing': (i) => {
    const sub = i.submission ?? i.state.latest?.id
    return i.agent !== null && sub !== undefined && (i.state.reviewing[sub] ?? []).includes(i.agent) ? null : { rule: 'verdict.reviewing', values: { card: i.card.key, submission: sub ?? 0 } }
  },
  'verdict.currentSubmission': (i) => {
    const latest = i.state.latest?.id
    return i.submission === undefined || i.submission === latest ? null : { rule: 'verdict.currentSubmission', values: { card: i.card.key, submission: i.submission, latest: latest ?? 0 } }
  },
  'approval.given': (i) => (notApproved(i.state, i.ruleset, i.card.labels)?.missing === 'userOk' ? { rule: 'approval.given', values: { card: i.card.key } } : null),
  'integrate.approved': (i) => {
    const n = notApproved(i.state, i.ruleset, i.card.labels)
    return n ? { rule: 'integrate.approved', values: { card: i.card.key, revision: short(i.revision), cause: n.missing, ...(n.n !== undefined ? { n: n.n, q: n.q! } : {}) } } : null
  },
  'integrate.upToDate': (i) => {
    if (i.upToDate === undefined) return null
    if (isUnknownAnswer(i.upToDate)) return unknownRefusal(i, 'integrate.upToDate', i.upToDate)
    return i.upToDate ? null : { rule: 'integrate.upToDate', values: { card: i.card.key, revision: short(i.revision), target: i.target ?? '' } }
  },
  'integrate.checksPassed': (i) => (i.mergeChecks === 'failed' ? { rule: 'integrate.checksPassed', values: { card: i.card.key } } : null),
  'done.contained': (i) => {
    if (i.contained === undefined) return null
    if (isUnknownAnswer(i.contained)) return unknownRefusal(i, 'done.contained', i.contained)
    return i.contained ? null : { rule: 'done.contained', values: { card: i.card.key, revision: short(i.revision), target: i.target ?? '' } }
  }
}

/** Every guard that refuses, in the ruleset's order: what a move across rules would skip (§16.8.4). */
export function evaluateAll(ids: readonly GuardId[], inputs: GuardInputs): GuardRefusal[] {
  return ids.map((id) => GUARD_FNS[id](inputs)).filter((r): r is GuardRefusal => !!r)
}

/** Runs guards in the ruleset's order: the first refusal, or null when all hold. */
export function evaluate(ids: readonly GuardId[], inputs: GuardInputs): GuardRefusal | null {
  for (const id of ids) {
    const r = GUARD_FNS[id](inputs)
    if (r) return r
  }
  return null
}
