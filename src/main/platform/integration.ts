// Port 4 of the platform contract, its candidate half (SPEC §16.3.6, HI-2790's R7): how the merge queue's candidate is
// built in the queue's own workspace (strict's update, the test merge in each style, its conflicts and their cleanup,
// sameness with the reviewed change, and its pins). Plain contracts: no platform's code is imported here. The queue's
// state machine, facts, leases, pauses, messages and identity stay common (mergeQueue.ts) and call this port for each
// step, acting on its typed outcome. Each platform with integration implements it in its own module (Git:
// gitIntegration.ts, today's code moved unchanged); integrationPorts.ts finds one by platform. The advance, journal,
// recovery and publish half is R8's.
//
// 1.4.0 changes no behaviour (§16.3.6's rule 1): Git's implementation runs the same commands, in the same order, through
// the queue's own runner (in its lease's job), with the same cleanup after a failure.

import type { ConflictsRecord } from '../../shared/workflow/conflicts'
import type { Maybe } from './types'

/** How the queue runs a command that may run the repository's hooks or sign (#1350): its environment and bound. */
export interface QueueGitOptions {
  env?: NodeJS.ProcessEnv
  /** Ends the command's whole tree (the tool, its hooks, its signer) once it has run this long. */
  timeoutMs?: number
}

export interface QueueGitResult {
  ok: boolean
  out: string
  err: string
  code: number
  /** Ended at its bound (QueueGitOptions.timeoutMs). */
  timedOut?: boolean
  /** Its stderr as far as it had come when the bound ended it: what was running then. */
  errAtTimeout?: string
  /** HI-2020: the tool never started (Node's code for why): nothing ran, so nothing to classify; the entry goes round again. */
  notRun?: string
  /**
   * HI-2042: the tool was ended by a signal (its name), code -1: what it did is unknown, so nothing to classify (no
   * conflict, no hook); put back, and the entry goes round again, as for notRun.
   */
  signal?: string
}

/** The queue's runner: each command of a step, in the queue's run (its lease's job, its route), bounded as asked. */
export type QueueRun = (cwd: string, args: string[], opts?: QueueGitOptions) => Promise<QueueGitResult>

/**
 * HI-2019: a read that failed before anything was touched (no `IntegrationStarted`, no pause written): the entry goes
 * round again, a fresh pass. `message` is what the tool said, for the pause once the budget is spent.
 */
export interface Again {
  again: { message?: string }
}

/** The pauses a candidate's step comes to: no identity to commit with, a signer or hook that waits, anything else. */
export type CandidatePauseReason = 'identity' | 'needsYou' | 'hookTimedOut' | 'signingWaits' | 'signing'
export interface CandidatePause {
  pause: CandidatePauseReason
  files?: string[]
  message?: string
}

/** Why a candidate returns the card to its builder: a conflict (its files and hunks), a refusing hook, not the same change, not on top. */
export interface CandidateFail {
  fail: 'conflict' | 'hook' | 'notSame' | 'notUpToDate'
  files?: string[]
  log: string
  conflicts?: ConflictsRecord
}
/** A test merge's return: never `notSame` (strict's update says that). */
export type CandidateTestFail = CandidateFail & { fail: 'conflict' | 'hook' | 'notUpToDate' }

/** An identity to commit with (the project's), or null when it has none. */
export type CommitIdentity = { name: string; email: string }

/**
 * The queue's side of a candidate's step: the repository, the queue's own workspace, its runner and bound, and what a
 * round reads once (the identity, whether the repository signs), kept for the round in `reads`.
 */
export interface CandidateHost {
  project: string
  folder: string
  run: QueueRun
  /** The longest a signed commit runs (Advanced `cw.queue.signSeconds`). */
  signTimeoutMs: number
  identity(): Promise<Maybe<CommitIdentity | null>>
  /** A round's reads, made once in it. */
  reads: { signs?: Promise<boolean | Again> }
}

/** The change a candidate is built of: the card, its reviewed revision and base, its candidate key, and the target's head tested on. */
export interface CandidateOf {
  card: string
  revision: string
  base: string
  key?: string | null
  expected: string
}

/** The integration port's candidate half (Git: gitIntegration.ts). */
export interface IntegrationPort {
  /** Where two revisions' histories meet ('' when the tool can't say: what follows then fails as the tool refuses it). */
  mergeBase(h: CandidateHost, a: string, b: string): Promise<string>
  /**
   * Strict (G8, #1352): the reviewed revision brought up to date with the target in the queue's workspace only (the target
   * merged in, `merge`; or it rebased onto the target, `rebase`), committed as Combwork's commits are, the same change
   * (§16.3.2) or the card goes back; kept on the entry's queue pin. Up to date already: `updated` null. `message` (a merge's)
   * is read just before the command, after the workspace and the signing read, so the options as they are then apply (G19).
   */
  update(h: CandidateHost, c: CandidateOf & { target: string; entry: string; how: 'merge' | 'rebase'; message: () => string }): Promise<Again | { updated: string | null } | CandidateFail | CandidatePause>
  /**
   * The test merge (§16.9.1 step 4) in the queue's workspace at the target's head: a merge commit, a squash, or (`rebase`)
   * the reviewed suffix rebased onto the target, linear, on top and the same change. `message` is read once the workspace
   * is ready (a branch's own messages: its read after the workspace's). A failure leaves the workspace clean at the head;
   * the result is kept on the card's queue pin.
   */
  candidate(h: CandidateHost, c: CandidateOf & { style: 'merge' | 'squash' | 'rebase'; updated?: string; message: () => Promise<string | Again> }): Promise<Again | { result: string } | CandidateTestFail | CandidatePause>
}
