// Port 4 of the platform contract, its candidate half (SPEC §16.3.6, HI-2790's R7): how the merge queue's candidate is
// built in the queue's own workspace (strict's update, the test merge in each style, its conflicts and their cleanup,
// sameness with the reviewed change, and its pins). Plain contracts: no platform's code is imported here. The queue's
// state machine, facts, leases, pauses, messages and identity stay common (mergeQueue.ts) and call this port for each
// step, acting on its typed outcome. Each platform with integration implements it in its own module (Git:
// gitIntegration.ts, today's code moved unchanged); integrationPorts.ts finds one by platform.
//
// The advance, recovery and publish half (HI-2791's R8) is granular too: each method is one of the steps a journal phase
// is committed between, or a read the queue decides on, never the protocol. The journal facts, the decision tree, the
// repository lock and folder fence, the lease checks just before each step that touches the repository, the crash hooks
// and every pause stay the queue's (mergeQueue.ts), so the port never orchestrates the protocol through callbacks.
//
// 1.4.0 changes no behaviour (§16.3.6's rule 1): Git's implementation runs the same commands, in the same order, through
// the queue's own runner (in its lease's job), with the same cleanup after a failure.

import type { ConflictsRecord } from '../../shared/workflow/conflicts'
import type { QueueFileSide, QueueStuck } from '../../shared/workflow/queue'
import type { Maybe } from './types'
import type { SigningStatus } from '../../shared/gitSigning'

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
  /**
   * HI-1185: a program other than git run to its end within a bound, its tree ended there (the signing check's signer),
   * in the queue's run (its lease's job). Left out, a bounded spawn of its own (tests).
   */
  spawn?: (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number; argv0?: string; verbatim?: boolean }) => Promise<QueueGitResult>
  /** The longest a signed commit runs (Advanced `cw.queue.signSeconds`). */
  signTimeoutMs: number
  identity(): Promise<Maybe<CommitIdentity | null>>
  /** A round's reads, made once in it. */
  reads: { signs?: Promise<boolean | Again>; signCheck?: Promise<SigningStatus> }
  /** HI-1182: whether the queue's checkouts of its folder leave LFS files as pointers (Set up submodules and LFS on: its step fills them). */
  skipSmudge?: () => Promise<boolean>
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

  // The advance (§16.9.2, R4.1, R4.7): the steps between its journal's phases, and the reads it decides on.

  /** Where each line is checked out (line → folder); unknown when the tool can't say. */
  checkouts(h: CandidateHost): Promise<Maybe<Record<string, string>>>
  /** The compare-and-swap: `target` moved from `expected` to `result` only if it is still at `expected` (true: it was). */
  swap(h: CandidateHost, target: string, expected: string, result: string): Promise<boolean>
  /**
   * A checked-out target's conditions, read before anything is touched (after the queue's own busy check): the folder on
   * the target at `expected` (else `wrongBranch`, or `retest` when the target moved), nothing staged, no change in a file
   * the advance changes; `files`, the advance's files, when they hold. `again` for a read the tool couldn't make.
   */
  conditions(h: CandidateHost, folder: string, target: string, expected: string, result: string): Promise<Again | { pause: 'wrongBranch' | 'staged' | 'unstagedChanges'; files: string[] } | 'retest' | { files: string[] }>
  /** The folder's index and listed files moved from one revision to the other; the tool refuses, writing nothing, rather than overwrite a changed file. */
  moveFiles(h: CandidateHost, folder: string, from: string, to: string): Promise<{ ok: boolean; err: string }>
  /** The listed files with a change in the folder's working copy or index; the tool's words when it couldn't say. */
  edited(h: CandidateHost, folder: string, files: string[]): Promise<string[] | { err: string }>
  /** Where each listed file stands in the folder (both at expected, both at the result, or `other`); null when the tool can't say. */
  sides(h: CandidateHost, folder: string, files: string[], expected: string, result: string): Promise<{ path: string; side: QueueFileSide; staged: QueueFileSide }[] | null>
  /** §16.9.2's terminal state as found: the line, the ref, each file's side, and the commands that finish or undo it. */
  stuck(h: CandidateHost, target: string, folder: string, expected: string, result: string, files: string[], phase: QueueStuck['phase']): Promise<QueueStuck>
  /** The line a folder has checked out (null: none); unknown when the tool can't say. */
  folderLine(folder: string): Promise<Maybe<string | null>>
  /** A line's head (null: no such line); unknown when the tool can't say. */
  targetHead(project: string, target: string): Promise<Maybe<string | null>>
  /**
   * §16.9.2's recovery table for an advance begun into a checked-out target, from its journal's last phase and the state
   * read now (R4.4): run again, requeue, finish the swap, roll back, merged (with a residue), or stuck. Reads only.
   */
  recoveryState(h: CandidateHost, e: BegunAdvance): Promise<{ found: RecoveryFound; stuck?: QueueStuck }>

  // The publish (G18, R4.6): the head read once, proved to contain the owed result, that captured revision pushed.

  /** Whether `a` is an ancestor of (or is) `b`; unknown when the tool can't say. */
  contains(project: string, a: string, b: string): Promise<Maybe<boolean>>
  /** Where a target is pushed: its upstream, else the only remote or origin; `unreadable` for a read the tool couldn't make. */
  pushDest(h: CandidateHost, target: string): Promise<{ remote: string; ref: string } | null | 'unreadable'>
  /**
   * Pushes exactly `commit` to `dest`: never forced, never changing what the target tracks, no prompt, bounded. `rejected`:
   * not a fast-forward (the remote has commits the target hasn't); `refused` (HI-1183): the remote refused it (a hook, a
   * protected branch), its own words; `failed`: anything else (a sign-in, the network, the bound).
   */
  push(h: CandidateHost, dest: { remote: string; ref: string }, commit: string): Promise<'pushed' | { rejected: string } | { refused: string } | { failed: string }>

  // The queue host's and runner's clean-up (§16.9.3): pins and the queue's own workspace.

  /** A card's candidate pins dropped once its entry has an outcome (its test merge's, and its entries' updates). */
  dropQueuePins(project: string, card: string): Promise<void>
  /** The submissions' pins of the project's cards, by card key, each its refs; null when they can't be read. */
  cardPins(project: string): Promise<Map<string, string[]> | null>
  /** Drops one pin. */
  dropPin(project: string, ref: string): Promise<void>
  /** The platform's own removal of one of the queue's workspaces (its guard is the runner's); whether it succeeded. */
  removeWorkspace(project: string, folder: string): Promise<boolean>
  /** The platform's record of workspaces gone from disk tidied (after a removal). */
  pruneWorkspaces(project: string): Promise<void>
  /**
   * A checked-out target's paused condition read again (Resume's check): `null` when it no longer holds (or the target
   * isn't checked out), `{}` when it still does or can't be told, with the files it names now and (HI-2944: staged or
   * uncommitted changes, seen there) the folder it saw them in.
   */
  pausedCondition(project: string, target: string, reason: 'wrongBranch' | 'staged' | 'unstagedChanges', files: string[] | undefined): Promise<{ files?: string[]; folder?: string } | null>

  // Follow mode (HI-1183, SPEC §16.9.4): the target is the branch it tracks on its remote. Optional: a platform without
  // them has no follow mode (the option isn't shown), and the queue never calls them for one.

  /**
   * The one publication endpoint of a target and its transport settings, captured once for an attempt (§16.9.4's
   * snapshot): the branch it tracks (else `noUpstream`), exactly one push URL (else `remoteAmbiguous`, the URLs without
   * their credentials in `files`), a repository whose objects the sealed context can address (else `remoteUnsupported`).
   */
  destination?(h: CandidateHost, target: string): Promise<Again | { snapshot: TransportSnapshot } | { pause: FollowSetupPause; files?: string[] }>
  /** Fetches the snapshot's ref from its endpoint in the sealed context, and sets the project's `into` ref to that fetch's own head. */
  fetchHead?(h: CandidateHost, snap: TransportSnapshot, into: string): Promise<{ head: string } | { failed: string }>
  /** The project's pre-push hook, run once in the project for the exact update (`lease` → `result`): none is `ok`. */
  prePush?(h: CandidateHost, snap: TransportSnapshot, lease: string, result: string): Promise<'ok' | { refused: string } | { timedOut: string }>
  /** The exact compare-and-swap publication of `result` over `lease` at the snapshot's endpoint, in the sealed context, with no hook. */
  publish?(h: CandidateHost, snap: TransportSnapshot, lease: string, result: string): Promise<PublishReply>
  /** A tool's words with the snapshot's credentials taken out (URL userinfo, authorization values, each secret value). */
  redact?(text: string, snap: TransportSnapshot | null): string
}

/** Why follow mode can't use a target's remote (HI-1183): it tracks none, it has several push URLs or none, or the sealed context can't reach its objects. */
export type FollowSetupPause = 'noUpstream' | 'remoteAmbiguous' | 'remoteUnsupported'

/**
 * Follow mode's captured transport (HI-1183, §16.9.4): the endpoint (its exact URL, which may hold credentials), the full
 * ref, the allowlisted transport and sign-in settings as resolved then, and how to reach the project's objects. Secret:
 * kept only in the protected store (queueTransportStore.ts), never in a fact, a log or a reply; `display` is what may be shown.
 */
export interface TransportSnapshot {
  remote: string
  url: string
  /** The URL without userinfo, query or fragment: what a record, a log or a hook may name. */
  display: string
  ref: string
  config: [string, string][]
  objects: string
  alternates: string[]
  format: string
}

/**
 * A publication's reply (HI-1183): `pushed`; `atResult` (the remote was at the result already, so the lease never
 * applied); `stale` (the lease or a fast-forward refused it before anything was written: the remote moved); `refused`
 * (the remote refused it: a hook, a protected branch; nothing written); `unknown` (anything else: it may have been published).
 */
export type PublishReply = 'pushed' | 'atResult' | { stale: string } | { refused: string } | { unknown: string }

/** An advance begun into a checked-out target, as its journal recorded it. */
export interface BegunAdvance {
  target: string
  expected: string
  result: string
  files: string[]
  folder: string
  /** Its journal's last phase. */
  phase: 'started' | 'files' | 'ref' | 'rollback'
}

/** What recovery found a begun advance in (§16.9.2's table), and what it calls for. */
export type RecoveryFound = 'integrated' | 'residue' | 'rerun' | 'swap' | 'rollback' | 'requeue' | 'stuck'
