// The merge queue (SPEC §16.9): Combwork performs merges, one entry at a time per target. An entry's way through: check it
// is still approved and not already in the target; test-merge it in the queue's own worktree; run the merge checks on
// exactly that result (installing clean when the manifests changed); then advance the target only on green, after
// writing `IntegrationStarted`, by compare-and-swap (not checked out) or the journaled read-tree/update-ref protocol
// (checked out). A target that moved since the test is tested again; it never advances an untested target.
//
// P2 spike (#1118): the core of the queue over the spike's runtime. The repository lock across processes, hooks and
// signing pauses are P5's. The merge checks (#1349) run as Combwork's own runs (queueChecks.ts), each bracketed here: green
// only when it exited 0 and its `CheckRan` counted for exactly the test merge's revision.

import { spawn, type ChildProcess } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'original-fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { git, GIT_PREFIX } from '../git'
import { onOutputSettled, withLauncherEnv } from '../gitWorker'
import { gitExe } from '../gitTool'
import { endTree } from '../progressReporters/wrapper'
import { FOCUSED_SKIP_GATE, MERGE_CHOICE_GATE, MERGE_CHOICE_KEY, openEntry, passingReviewers, QUEUE_ADVANCE_GATE, QUEUE_PUBLISH_GATE, QUEUE_STUCK_GATE, type CardState, type Fact, type FactData, type FocusedReturn, type IntegrationFailReason, type PublishFact, type QueueEntry } from '../../shared/workflow/facts'
import { changedSince, changePaths, choiceStands, chosenTests, FOCUSED_CHECK, FOCUSED_MAX_RESULTS_BYTES, readResults, reviewProved, standingFocusedRun, type FocusedResult, type FocusedTest } from '../../shared/workflow/focused'
import { FOCUSED_PICK, FOCUSED_RUN } from '../../shared/workflow/options'
import { boundedRead, pathChanges, runPick } from './focusedRun'
import { pushesSettled, pushLogKey, pushLogOf, pushPendingKey, pushPendingOf, type PushPending, type PushSettled } from './queueLogs'
import type { TransientFailure } from '../../shared/types'
import { notApproved } from '../../shared/workflow/guards'
import { hasStage } from '../../shared/workflow/compile'
import { forwardDirection, forwardPermitted } from '../../shared/workflow/forwardOrder'
import { merges } from '../../shared/platform/descriptors'
import type { CommitMessage } from '../../shared/workflow/options'
import { FOR_YOU, workflowText } from '../../shared/workflow/texts'
import { historyFor, lineHistory, readStep } from '../platform/historyPorts'
import type { HistoryPort } from '../platform/history'
import { isUnknown, type Maybe, type Unknown } from '../platform/types'
import { withWriteFence, type CardRecord } from './factStore'
import { endedBy, LeaseLost } from './queueRunner'
import { reconcile } from './reconcile'
import { leftWake, returnedAbout, returnedComment, returnedWake } from './queueState'
import { mergeMessage, updateMessage } from './mergeMessage'
import { again, isAgain } from '../platform/again'
import type { Again, BegunAdvance, CandidateFail, CandidateHost, CandidatePause, CandidateTestFail, IntegrationPort, PublishReply, QueueGitOptions, QueueGitResult, TransportSnapshot } from '../platform/integration'
import type { TransportStore } from './transportSnapshots'
import { integrationFor, queueIntegration } from '../platform/integrationPorts'
// Git's commit reading (HI-2790: moved to the platform with the candidate steps), named here for its tests.
export { commitFailed, readCommitStream, type CommitChild, type CommitStream } from '../platform/gitCommits'
import type { ConflictsRecord } from '../../shared/workflow/conflicts'
import { bracketEnd, bracketStart } from './queueChecks'
import { CW_RUNS } from '../progress'
import type { Workflow, Write } from './runtime'
import type { RunCheck } from '../../shared/types'
import type { QueueStep, QueueStuck } from '../../shared/workflow/queue'
import { agentMsg, say } from '../../shared/agentText'

/** A focused-test run's results Combwork couldn't read, as its check's output (HI-2463: Combwork's name). */
const RESULTS_UNREAD = agentMsg({ id: 'workflow.focused.resultsUnread', text: "Combwork couldn't take its results: {why}.", note: "A check's output: the focused tests' runner wrote results that couldn't be read. why: what was wrong with them." })

export interface CheckResult {
  ok: boolean
  /** The failure was the environment (a check that didn't start, a network error, a timeout), not a result. */
  transient?: boolean
  /** Why it was (#1362): recorded on the card's IntegrationFailed. */
  cause?: TransientFailure
  output: string
  /** Its log's path, when the log holds its output (#1354: a returned card's wake names it). */
  logPath?: string
  /** The command that ran, and its run's id (a progress run's, when Combwork keeps runs). */
  command?: string
  run?: string
  /** Tells the check's run how it counted (its details say why not). */
  note?: (c: RunCheck) => void
}

/** What a merge check or install runs for: the card, and the test merge's result revision it runs on. */
export interface CheckContext {
  card: string
  number: number
  revision: string
  /** Nothing was installed before the checks (no setup command and no lock file): this check's run says so. */
  noInstall?: boolean
  /**
   * Variables Combwork gives this check itself, past `checkEnv` (which takes every CW_* out of the base): G20's runner
   * reads its tests, results file and jobs from them (HI-1367).
   */
  env?: Record<string, string>
  /** Its run's title, when not the check's name (G20's: "focused tests (7)"). */
  label?: string
}

/** What the merge checks of a test merge came to: green (every one passed and counted), red, or not proved. */
/** A red outcome names the check (`install` for the install before them) and its log, when it holds its output (#1354). */
/** G20 (HI-1367): `focused`, its focused tests stopped it (returned, with why); `skip`, some were skipped and wait for a decision. */
type ChecksOutcome = { kind: 'green' } | { kind: 'red'; transient: boolean; cause?: TransientFailure; output: string; check: string; logPath?: string } | { kind: 'uncounted' } | { kind: 'focused'; focused: FocusedReturn } | { kind: 'skip'; skipped: FocusedResult[]; expected: string; tree: string }

export interface QueueConfig {
  /** The queue's own worktree (a merge slot, kept warm). */
  folder: string
  /**
   * Whether the project is a subfolder of a larger repository (OP-29, #1419): a card whose ruleset names no target then
   * pauses the queue rather than merge into the whole repository's default branch (a backstop: the options refuse it).
   */
  subfolder?: () => boolean
  /**
   * Whether the project's merge style and commit message are still to be chosen (HI-1697: a project the 1.0 upgrade gave
   * its options, `mergeAsk`): the queue then asks in For you (paused `mergeChoice`) before its first merge.
   */
  mergeAsk?: () => Promise<boolean>
  /** HI-1697: brings the project's options in line with the board's recorded merge choice, when its write is pending. */
  settle?: () => Promise<void>
  /** Runs a named merge check (its configured command) in a folder, on the test merge's result. */
  runCheck: (name: string, command: string, folder: string, ctx: CheckContext) => Promise<CheckResult>
  /** Installs dependencies there; `clean` from scratch (`npm ci`). `skipped`: there was nothing to install. */
  install?: (folder: string, clean: boolean, ctx: CheckContext) => Promise<CheckResult & { skipped?: boolean }>
  /** HI-1182: the folder's submodules and LFS files set up before the install and checks; `skipped`: nothing to do. */
  gitFiles?: (folder: string, ctx: CheckContext) => Promise<CheckResult & { skipped?: boolean }>
  /** HI-1182: whether that is on, so the queue's checkouts of its folder leave LFS files for it. */
  gitFilesOn?: () => Promise<boolean>
  /** The files whose change since the last install means a clean install (#187). */
  manifests?: string[]
  /**
   * G20 (HI-1367): how the queue picks a card's focused tests at the result (a check's environment, its time limit),
   * the jobs its runner is given, and where the tests and results files go (Combwork's own folder, never the queue's).
   */
  focused?: { env: () => Record<string, string>; pickTimeoutMs: () => number; jobs: () => number; dir: string }
  /**
   * What makes an agent build in this folder now (§16.9.2): the files it holds locks on there, a run going with it as
   * its working folder; null when none does. An idle agent, or one whose session lives there but works in a review copy,
   * doesn't count.
   */
  folderBusy?: (folder: string) => string[] | null
  /**
   * Runs the advance into a checked-out target with its folder fenced (#646, folderFence.changingFolder): nothing of
   * Combwork's is typed into that folder and no agent starts there until it settles. Left out, as it is.
   */
  fence?: <T>(folder: string, fn: () => Promise<T>) => Promise<T>
  /**
   * Merge into a checked-out branch (Advanced `cw.queue.checkedOutTarget`, OP-40, read at each use): `ask`, an entry
   * ready to advance into a target checked out in a folder waits for the user's Approve (For you); `auto`, it advances.
   * A target checked out nowhere is always automatic. Left out, automatic.
   */
  checkedOutTarget?: () => 'ask' | 'auto'
  /**
   * Whether this queue's runner still holds its target's lease (#1360, QueueRunner.holds): checked inside every store
   * write the queue's work makes (its facts, reconciliation's, values, a pause: withWriteFence), which is refused whole
   * once it doesn't, and the queue stops. Left out, always.
   */
  holds?: () => boolean
  /**
   * Runs git for the queue (its test merges, the advance, the pins): the runner's recording one in the app (#1360,
   * QueueRunner.git: its processes in the lease's job, recorded before they run); left out, Combwork's own git().
   */
  git?: (cwd: string, args: string[], opts?: QueueGitOptions) => Promise<QueueGitResult>
  /**
   * The longest Combwork's merge commit runs when the repository signs its commits (#1350, Advanced
   * `cw.queue.signSeconds`): a signer still waiting then (for a passphrase) is ended and the entry pauses. 60 s left out.
   */
  signTimeoutMs?: number
  /**
   * Runs the advance under the repository's lock across processes (#1347, withRepoLock), its `IntegrationStarted` and
   * the ref's compare-and-swap together; left out, as it is.
   */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>
  /**
   * Whether workflow rules are enforced now (Settings → Advanced, `cw.workflow.enforce`, read at each use): off, an
   * entry stops just before its advance, paused `rulesOff`, and an advance already begun finishes. Left out, always.
   */
  enforced?: () => boolean
  /**
   * Whether the project's team is paused now (HI-2081, read at each use): no entry is taken, and one about to advance
   * stops just before it (`held`, nothing written: it is taken as it is once the team resumes). An advance begun finishes.
   */
  teamPaused?: () => boolean
  /**
   * Told each step of an entry's way as it begins (#1353: the queue's model shows what is testing now), and null once the
   * entry has its outcome.
   */
  onStep?: (step: QueueStepInfo | null) => void
  /**
   * Test seams: crash injection and races between the queue's steps. A checked-out target's journal (§16.9.2), in order:
   * `afterStarted` (IntegrationStarted written), `beforeFiles` (phase files written, before read-tree), `afterFiles`
   * (read-tree ran), `beforeRef` (phase ref written, before update-ref), `afterAdvance` (update-ref ran, before
   * `Integrated`); a rollback's `inRollback` (phase rollback written, before its read-tree) and `afterRollback`; and
   * `beforeRetry` (HI-2019: a failed read's wait is over, before the entry is admitted again).
   */
  hooks?: QueueHooks
  /**
   * G21 (HI-1183): where follow mode keeps an attempt's transport snapshot (queueTransportStore.ts in the app, encrypted;
   * a memory one in tests). Left out, follow mode pauses `remoteUnsupported`: nowhere safe to keep one.
   */
  transport?: TransportStore
  /**
   * HI-1185: runs a program other than git for the queue, bounded (the signing check's signer): the runner's recorded run
   * in the app, in its lease's job; left out, a bounded spawn of the platform's own (tests).
   */
  spawn?: CandidateHost['spawn']
}

/**
 * Follow mode's seams too (HI-1183): `beforePublish` (phase push written, before the publication), `afterPublish` (its
 * reply in, before it is acted on), and the owed catch-up's `beforeCatchUpFiles` and `beforeCatchUpRef`.
 */
export type QueueHook = 'afterTest' | 'afterChecks' | 'afterStarted' | 'beforeFiles' | 'afterFiles' | 'beforeRef' | 'afterAdvance' | 'inRollback' | 'afterRollback' | 'beforeRetry' | 'beforePublish' | 'afterPublish' | 'beforeCatchUpFiles' | 'beforeCatchUpRef'
export type QueueHooks = Partial<Record<QueueHook, (entry: string) => void | Promise<void>>>

// How the queue runs a command, and what it answered: the integration port's types (platform/integration.ts, HI-2790).
export type { QueueGitOptions, QueueGitResult } from '../platform/integration'

export type QueueOutcome =
  | { card: string; entry: string; outcome: 'integrated'; result: string; retests: number }
  | { card: string; entry: string; outcome: 'returned'; reason: FactData['IntegrationFailed']['reason']; transient: boolean }
  | { card: string; entry: string; outcome: 'paused'; reason: PauseReason; files?: string[]; message?: string }
  | { card: string; entry: string; outcome: 'skipped'; why: 'notApproved' | 'cancelled' | 'declined' }
  | { card: string; entry: string; outcome: 'integratedOutside' }
  /** HI-2709: blocked by cards that aren't Done (`on`, their keys): the entry stays open, and the queue goes on without it. */
  | { card: string; entry: string; outcome: 'waiting'; on: string[] }

/** How much of a failure's output its card keeps (`IntegrationFailed.log`), and how much of that is its start. */
export const KEPT_LOG = 4000
const KEPT_HEAD = 800

/**
 * A failure's output as its card keeps it (#1354): whole up to KEPT_LOG characters, else its start and its end (where
 * the error is, which the wake and card reads quote as its last lines), the middle replaced by a line saying how much
 * was left out.
 */
export function keptLog(log: string, max = KEPT_LOG): string {
  if (log.length <= max) return log
  const head = Math.min(KEPT_HEAD, Math.floor(max / 5))
  const mark = (left: number): string => `\n… (${left} characters left out) …\n` // i18n-ignore: inside a command's stored output, which agents read
  // The mark's own length decides the tail's, and the count it gives: settled in two steps (its digits barely change).
  let tail = max - head - mark(log.length).length
  tail = max - head - mark(log.length - head - tail).length
  return `${log.slice(0, head)}${mark(log.length - head - tail)}${log.slice(log.length - tail)}`
}

/** The entry a queue is taking through its steps now: its card, revision, the target's head it tests on, since when. */
export interface QueueStepInfo {
  card: string
  number: number
  entry: string
  revision: string
  /** The target's head the test merge is made on (null until it is read). */
  expected: string | null
  step: QueueStep
  /** When the queue took the entry (ISO). */
  started: string
}

/**
 * `uncounted`: its checks passed but didn't count for the result MAX_RETESTS times in a row (the card's `CheckRan` says
 * why). `signingWaits`: signing Combwork's commit waited for a passphrase (or a pinentry) and was ended; `signing`: it failed
 * (git's message in the pause). `hookTimedOut`: a hook of a signed commit was still running at the signing bound.
 * `identity`: no commit identity for the repository (its folder in the pause). `user`: Pause queue (the user's, or the
 * Assistant's within Control: #1353). `approval`: an entry ready to advance into a checked-out target waits for the
 * user's Approve (Ask each time, #1351). `checkedOut`: a pause from before #1351, which Combwork no longer makes.
 * `pushRejected`, `pushFailed`, `pushNoRemote` (G18, #1179): the push of the target after a merge was refused (the
 * remote has commits it lacks), failed (git's message: a sign-in, the network, the bound), or had no remote to go to;
 * `pushUnreadable`: owed, and the target (or whether it still has the merge) couldn't be read to settle it.
 * `mergeChoice` (HI-1697): an upgraded project's merge style and commit message wait for the user's answer in For you.
 * `pushRefused` (HI-1183): the remote (or, in follow mode, the project's pre-push hook) refused the push, its words kept.
 * Follow mode's (G21, HI-1183, §16.9.4): `noUpstream` (the target tracks no remote branch), `remoteAmbiguous` (its remote
 * has several push URLs, or none), `remoteUnsupported` (a shallow repository, or nowhere safe to keep the snapshot),
 * `fetchFailed` (git's words), `remoteDiverged` (the local target has commits its remote lacks), `publishUnknown` (a
 * publication's outcome unknown and the remote not showing it: For you asks), `publishRefused` (the project's pre-push
 * hook or the remote refused the publication: nothing published, the card queued again).
 */
export type PauseReason = 'user' | 'targetMovesFast' | 'folderBusy' | 'wrongBranch' | 'staged' | 'unstagedChanges' | 'identity' | 'needsYou' | 'uncounted' | 'checkedOut' | 'rulesOff' | 'signingWaits' | 'signing' | 'hookTimedOut' | 'approval' | 'subfolderTarget' | 'pushRejected' | 'pushFailed' | 'pushNoRemote' | 'pushUnreadable' | 'pushRefused' | 'mergeChoice' | 'focusedSkip' | 'noUpstream' | 'remoteAmbiguous' | 'remoteUnsupported' | 'fetchFailed' | 'remoteDiverged' | 'publishUnknown' | 'publishRefused'

/**
 * G18 (#1179): the push of a target Combwork owes after merging into it, as store meta per target: the merge's result, its
 * card and entry. Written in the same transaction as the merge's `Integrated` (the card Done and the push owed, or
 * neither); cleared only for the result that was pushed (compare-and-clear), never a newer one.
 */
interface PushOwed {
  result: string
  card: string
  entry: string
}

export const pushOwedKey = (target: string): string => `queue.pushOwed:${target}`

/** The push Combwork owes for a target, if any (an unreadable value counts as none). */
export function pushOwedOf(value: string | null): PushOwed | null {
  if (!value) return null
  try {
    const v = JSON.parse(value) as Partial<PushOwed>
    return typeof v.result === 'string' && typeof v.card === 'string' && typeof v.entry === 'string' ? { result: v.result, card: v.card, entry: v.entry } : null
  } catch {
    return null
  }
}

/**
 * G21 (HI-1183, §16.9.4): the local target's catch-up Combwork owes once a merge is published to its remote, as store meta
 * per target: from the local head (`from`) to the published result (`to`), the merged card and entry. Written in the same
 * transaction as the merge's `Integrated`, settled before the next entry; a checked-out target's steps journalled here
 * (`folder`, `files`, `phase`), so a crash or a lost lease is recovered by §16.9.2's table. Never a reason to retest,
 * roll back or publish again: the card is Done once its remote has it.
 */
export interface CatchUp {
  from: string
  to: string
  card: string
  entry: string
  folder?: string
  files?: string[]
  phase?: 'files' | 'ref' | 'rollback'
}

export const catchUpKey = (target: string): string => `queue.catchUp:${target}`

/** The catch-up Combwork owes a target, if any (an unreadable value counts as none). */
export function catchUpOf(value: string | null): CatchUp | null {
  if (!value) return null
  try {
    const v = JSON.parse(value) as Partial<CatchUp>
    if (typeof v.from !== 'string' || typeof v.to !== 'string' || typeof v.card !== 'string' || typeof v.entry !== 'string') return null
    const phase = v.phase === 'files' || v.phase === 'ref' || v.phase === 'rollback' ? v.phase : undefined
    return { from: v.from, to: v.to, card: v.card, entry: v.entry, ...(typeof v.folder === 'string' ? { folder: v.folder } : {}), ...(Array.isArray(v.files) ? { files: v.files.filter((x): x is string => typeof x === 'string') } : {}), ...(phase ? { phase } : {}) }
  } catch {
    return null
  }
}

/**
 * HI-2988: whether a pause is the owed catch-up's (a card already merged and published, the local target behind it): the
 * catch-up owed for `target` names the paused card. Its changes are set aside, never committed on the local target,
 * which would then have a commit its remote lacks.
 */
export const catchUpPaused = (catchUp: string | null, pause: { card: string } | null | undefined): boolean => !!pause?.card && catchUpOf(catchUp)?.card === pause.card

/** The project's pin of an entry's fetched remote head (HI-1183): under its entry's queue pins, dropped with them. */
export const fetchPin = (entry: string): string => `refs/cw/queue/${entry.replace(/[^A-Za-z0-9._-]/g, '-')}-fetch`

/**
 * How an entry of a merge style lands, as its `Integrated` says (an advance, or recovery after a restart): Rebase and
 * fast-forward moves the target forward (#1184); a squash into the card's own target is a squash; else a merge commit.
 */
/** An entry's begun advance into a checked-out target, as the port's recovery reads it (its journal's last phase). */
const begun = (e: QueueEntry): BegunAdvance => {
  const last = e.phases.at(-1)
  return { target: e.target, expected: e.started!.expected, result: e.started!.result, files: e.started!.files ?? [], folder: e.started!.checkedOut!, phase: last === 'files' || last === 'ref' || last === 'rollback' ? last : 'started' }
}

function methodOf(style: FactData['IntegrationRequested']['style'], cardTarget: string | null | undefined, target: string): 'merge' | 'squash' | 'fastForward' {
  if (style === 'rebase') return 'fastForward'
  return cardTarget === target && style === 'squash' ? 'squash' : 'merge'
}

/** What an entry's steps read of the repository's config once (#1386): the identity Combwork commits as, and signing. */
/** What a pass of an entry reads once (HI-2019: made afresh for each pass, so a pass that goes round again reads again). */
interface EntryReads {
  identity?: Promise<Maybe<{ name: string; email: string } | null>>
  signs?: Promise<boolean | Again>
}

/** What an advance came to (advanceRef, advanceCheckedOut); `again` only before anything was touched. */
/** HI-2944: the pauses on a checked-out folder's own changes, which record that folder. */
const FOLDER_PAUSES: ReadonlySet<string> = new Set(['staged', 'unstagedChanges'])

type Advance = 'done' | 'moved' | 'denied' | 'held' | 'waiting' | 'retest' | Again | { pause: PauseReason; files?: string[]; message?: string; stuck?: QueueStuck; folder?: string } | { residue: QueueStuck } | { outcome: QueueOutcome }

/** Whether the user approved advancing this entry's test merge (`expected` → `result`) into its checked-out target. */
/**
 * A real-CLI or packaged focused test's proof at the submitted revision, from the card's facts as they are (G20, realProof
 * = review; HI-2660): the test's standing run there (`standingFocusedRun`: its latest counted run, not the queue's, its
 * command unchanged), passed, and either run by one of `reviewers` (the lane reviewer, an agent whose pass approved the
 * latest submission) or accepted by its run id in such a reviewer's passing verdict of that submission at the current
 * generation (`acceptedBy`). None: no proof stands, so an earlier pass never stands behind a later counted failure.
 */
export function focusedProof(s: CardState, commands: Readonly<Record<string, string>>, reviewers: ReadonlySet<string>, test: string, revision: string): { run: FactData['CheckRan']; acceptedBy?: string } | undefined {
  const c = standingFocusedRun(s.checks, test, revision, commands)
  if (!c || c.result !== 'passed') return undefined
  if (c.agent && reviewers.has(c.agent)) return { run: c }
  const v = s.verdicts.findLast((x) => x.pass && x.submission === s.latest?.id && x.generation === s.generation && reviewers.has(x.reviewer) && (x.accepted ?? []).some((a) => a.test === test && a.run === c.run))
  return v ? { run: c, acceptedBy: v.reviewer } : undefined
}

/** The reviewers whose runs and acceptances prove a card's focused tests: its lane reviewer and its passing reviewers. */
export const proofReviewers = (reviewer: string | null | undefined, s: CardState): Set<string> => new Set([reviewer, ...passingReviewers(s)].filter((x): x is string => !!x))

/**
 * HI-2660 (HR3's round 1): the tests accepted as review proof for this entry and test merge (`FocusedAccepted`) whose
 * proof no longer stands in `s` (a counted failure since, its acceptance gone, its command changed): read again at the
 * queue's last check and in `IntegrationStarted`'s write, so evidence that arrived after the checks is never hidden by
 * what they accepted.
 */
export function focusedProofGone(s: CardState, commands: Readonly<Record<string, string>>, reviewers: ReadonlySet<string>, entry: QueueEntry, result: string): string[] {
  const tests = [...new Set(s.focusedAccepted.filter((a) => a.entry === entry.id && a.result === result).map((a) => a.test))]
  return tests.filter((t) => !focusedProof(s, commands, reviewers, t, entry.revision))
}

function advanceApprovedIn(s: CardState, entry: string, expected: string, result: string): boolean {
  return s.approvals.some((a) => {
    const r = s.made[a.request]
    return a.answer === 'approved' && r?.gate === QUEUE_ADVANCE_GATE && r.entry === entry && r.revision === expected && r.result === result
  })
}

/** The longest a signed merge commit runs when the config gives none (Advanced `cw.queue.signSeconds`'s default). */
const SIGN_TIMEOUT_MS = 60_000

/**
 * git as Combwork runs it, with no input (no terminal to prompt on), in an environment and within a bound: at the bound its
 * whole tree (git, a hook, a signer) is ended, and the result says so. The queue's git when its config gives none (tests;
 * the app runs it through the runner's recorded spawn). Exported for its tests (HI-2043: its bound against its output).
 */
export function gitTree(cwd: string, args: string[], opts: QueueGitOptions): Promise<QueueGitResult> {
  return new Promise((res) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    let child: ChildProcess
    try {
      const use = gitExe()
      child = spawn(use.exe, [...GIT_PREFIX, ...args], { cwd, env: use.launcherEnv ? withLauncherEnv(opts.env ?? process.env, use.launcherEnv) : opts.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      // HI-2020: a start that failed at once ran nothing.
      return res({ ok: false, out: '', err: e instanceof Error ? e.message : String(e), code: -1, notRun: String((e as NodeJS.ErrnoException).code ?? 'error') })
    }
    let atTimeout: string | undefined
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          atTimeout = Buffer.concat(err).toString('utf8')
          endTree(child)
        }, opts.timeoutMs)
      : undefined
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    let settled = false
    const done = (code: number, notRun?: string, signal?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      res({ ok: code === 0 && !timedOut, code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8').trim() || (signal ? endedBy('git', signal) : ''), ...(timedOut ? { timedOut, errAtTimeout: atTimeout } : {}), ...(notRun ? { notRun } : {}), ...(signal ? { signal } : {}) })
    }
    child.once('error', (e) => {
      err.push(Buffer.from(e.message))
      // HI-2020: an error with no pid is a start that failed (EAGAIN on a loaded machine): nothing ran.
      done(-1, child.pid ? undefined : String((e as NodeJS.ErrnoException).code ?? 'error'))
    })
    // HI-2043: its output read whole before it is told (a hook's refusal by git's trace at its end), bounded once git has
    // exited. HI-2042: ended by a signal (no code of its own) is -1, never 1 (git's "no"); one its bound ended stays timed out.
    // Its bound is on git, not its output: a git that exited in time is never timed out by output still open after it.
    child.once('exit', () => clearTimeout(timer))
    onOutputSettled(child, (c, sig) => (c === null && !timedOut ? done(-1, undefined, sig ?? 'unknown') : done(c ?? 1)))
  })
}

/**
 * How many times an entry is tested again for a target that moved (§16.9.1 step 6), or for checks that passed without
 * counting (#1349), before it pauses.
 */
export const MAX_RETESTS = 3

/** Follow mode's last test of an entry (its remote head, result and snapshot), for an approval of it (Ask each time). */
interface FollowTested {
  onto: string
  result: string
  snap: TransportSnapshot
}

/**
 * HI-2986: follow mode's tests, by project and entry, for this Combwork's life: the host makes a new MergeQueue for each
 * run, and a run ends at Ask each time's pause, so the Approve is taken by another queue than the one that tested. Kept
 * until the entry's snapshot is dropped (its outcome written, or not published), at most `FOLLOW_TESTED_MAX`, the oldest
 * dropped first (an entry then tested, and asked about, again, as after a restart).
 */
const followTested = new Map<string, FollowTested>()
const FOLLOW_TESTED_MAX = 256
const followKey = (project: string, entry: string): string => `${project}\u0000${entry}`

/**
 * HI-2019: how many times an entry goes round again after a git read failed before anything was touched (a lock held
 * for a moment, git not starting on a loaded machine), each after READ_RETRY_MS × the try, before it pauses `needsYou`
 * with git's text. A budget of its own: target moves and uncounted checks keep MAX_RETESTS.
 */
export const READ_RETRIES = 3
const READ_RETRY_MS = 250
/** After the advance, the folder's branch read again this often, this far apart, when git couldn't say. */
const CONFIRM_TRIES = 3
const CONFIRM_RETRY_MS = 100

/** An unknown's own words for the pause: what git said, else what couldn't be read. */
const gitSaid = (u: Unknown): string => u.detail ?? u.what
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))


/** A runner that lost its lease stops at once: no outcome (another Combwork's runner carries on). */
const lostIsNull = (e: unknown): null => {
  if (e instanceof LeaseLost) return null
  throw e
}

export class MergeQueue {
  /** Entries a restart's recovery found should run again from the test merge. */
  private rerun = new Set<string>()

  constructor(
    readonly wf: Workflow,
    readonly cfg: QueueConfig
  ) {}

  private get project(): string {
    return this.wf.cfg.project
  }

  private git(cwd: string, args: string[], opts?: QueueGitOptions): Promise<QueueGitResult> {
    return this.cfg.git ? this.cfg.git(cwd, args, opts) : opts ? gitTree(cwd, args, opts) : git(cwd, args)
  }

  paused(target: string): { reason: PauseReason; card: string; files?: string[]; message?: string } | null {
    return this.wf.store.queuePause(target) as { reason: PauseReason; card: string; files?: string[]; message?: string } | null
  }

  resume(target: string): void {
    this.wf.store.setQueuePause(target, null)
  }

  /**
   * Pauses the target's queue at this entry: its reason, the files or folder it names, git's message (bounded). A stuck
   * advance (§16.9.2's terminal state) keeps its state, and the user is asked (For you) to finish or undo it.
   */
  private async pause(target: string, card: CardRecord, entry: QueueEntry, reason: PauseReason, files?: string[], message?: string, stuck?: QueueStuck, folder?: string): Promise<QueueOutcome> {
    const m = message?.trim().slice(0, 4000) || undefined
    const named = stuck ? stuck.files.map((f) => f.path) : files
    // Never in place of a pause saved meanwhile (the user's Pause queue, say), decided in the pause's own write; the
    // terminal state, which says more, and which the user must settle, is written whatever was there.
    const wrote = await this.wf.locked(() => this.wf.store.setQueuePause(target, { reason, card: card.key, ...(named?.length ? { files: named } : {}), ...(m ? { message: m } : {}), ...(stuck ? { stuck } : folder ? { folder } : {}) }, !stuck))
    if (!wrote) return this.held(card, entry, this.paused(target)?.reason ?? 'user')
    if (stuck) {
      const finish = stuck.commands.find((c) => c.purpose === 'finish')
      const undo = stuck.commands.find((c) => c.purpose === 'undo')
      const how = finish && undo ? 'both' : finish ? 'finish' : undo ? 'undo' : 'none'
      const text = workflowText(FOR_YOU.queueStuck, { card: card.key, target, folder: stuck.folder, files: stuck.files.length, project: this.project, how, finish: finish?.command ?? '', undo: undo?.command ?? '' })
      await this.write(card, (w) => this.wf.askUser(w, 'decide', QUEUE_STUCK_GATE, text, { unbound: true, entry: entry.id, result: stuck.result, revision: stuck.expected }))
    }
    return { card: card.key, entry: entry.id, outcome: 'paused', reason, ...(named?.length ? { files: named } : {}), ...(m ? { message: m } : {}) }
  }

  /**
   * Runs the queue's work with every store write it makes fenced by the runner's lease (withWriteFence): checked inside
   * each write, which throws LeaseLost (undone whole) once the runner doesn't hold the target.
   */
  private fenced<T>(target: string, fn: () => Promise<T>): Promise<T> {
    const holds = this.cfg.holds
    if (!holds) return fn()
    return withWriteFence(() => {
      if (!holds()) throw new LeaseLost(target)
    }, fn)
  }

  /**
   * The queue's entries for a target, in the order they were requested: open, or recovered to run again. `runnable`
   * (HI-2709): without the open ones whose card waits for a blocker that isn't Done (a begun one recovered to run again
   * stays: its advance began, at the advance's authority, before any blocker it has now).
   */
  entries(target?: string, runnable = false): { card: CardRecord; entry: QueueEntry }[] {
    const out: { card: CardRecord; entry: QueueEntry }[] = []
    for (const f of this.wf.store.factsOfKind('IntegrationRequested')) {
      const d = f.data as FactData['IntegrationRequested']
      if (target && d.target !== target) continue
      const s = this.wf.state(f.card)
      const e = s.entries.find((x) => x.id === d.entry)
      if (!e || !(e.state === 'open' || (e.state === 'started' && this.rerun.has(e.id)))) continue
      if (runnable && e.state === 'open' && this.wf.queueWaitingOn(f.card).length) continue
      out.push({ card: this.wf.store.card(f.card), entry: e })
    }
    return out
  }

  /** Runs the queue for a target until it is empty or paused; the outcomes in order. */
  async drain(target: string): Promise<QueueOutcome[]> {
    const out: QueueOutcome[] = []
    for (let i = 0; i < 50; i++) {
      const o = await this.runOnce(target).catch(lostIsNull)
      if (!o) break
      out.push(o)
      if (o.outcome === 'paused') break
    }
    return out
  }

  /** Takes the next entry for the target and takes it as far as it goes. Null when there's none or the queue is paused. */
  async runOnce(target: string): Promise<QueueOutcome | null> {
    // HI-1697: the project's options brought in line with the board's recorded merge choice first, if their write is
    // pending (a save stopped after the board's commit), and read again. Only a project with a choice recorded: a waiting
    // card's style is its own Override's either way.
    if (this.wf.store.meta(MERGE_CHOICE_KEY)) await this.cfg.settle?.()
    const p = this.paused(target)
    if (p?.reason === 'approval') return this.fenced(target, async () => this.thenPush(target, await this.answered(target, p.card))).catch(lostIsNull)
    // HI-1697: lifted once the merge style and commit message are chosen (the answer, or a save of the options), the
    // choice carried to the cards waiting first. Still to be chosen with no question open (answered in words, say):
    // lifted too, so the next entry asks again.
    if (p?.reason === 'mergeChoice' && (!(await this.mergeAsked()) || !this.asking(p.card)) && (await this.fenced(target, () => this.chosen(target, p.card)).catch(lostIsNull))) return this.runOnce(target)
    // G20 (HI-1367): lifted once its skipped focused tests are decided (the reviewer's answer or the user's); the entry is
    // tested again from its test merge and takes that decision (`skipDecided`).
    if (p?.reason === 'focusedSkip' && !this.skipAsking(p.card) && (await this.wf.locked(() => this.wf.store.clearQueuePause(target, 'focusedSkip')))) return this.runOnce(target)
    // G21 (HI-1183): an unknown publication waits for the user's answer (Resume verifies it again, below).
    if (p?.reason === 'publishUnknown') return this.fenced(target, () => this.publishAnswered(target, p.card)).catch(lostIsNull)
    if (p || this.cfg.teamPaused?.()) return null
    return this.fenced(target, async () => {
      // G21 (HI-1183): a begun publication settled first (verified at its own endpoint), then the local catch-up it owes.
      const published = await this.settlePublications(target)
      if (published) return this.thenPush(target, published)
      const behind = await this.settleCatchUp(target)
      if (behind) return behind
      // A push owed by an earlier merge goes first (G18: after a restart or a Resume), and the next entry waits for it.
      const owed = await this.settlePush(target)
      if (owed) return owed
      const next = this.entries(target, true)[0]
      if (!next) return null
      return this.thenPush(target, await this.process(next.card, next.entry))
    }).catch(lostIsNull)
  }

  /** After an entry's merge, the push of its target it owes (G18), before the next entry; its outcome stays the merge's. */
  private async thenPush(target: string, o: QueueOutcome | null): Promise<QueueOutcome | null> {
    // G21 (HI-1183): a published merge's local catch-up first (its pause, if any, is saved: the outcome stays the merge's).
    if (o?.outcome === 'integrated' && (await this.settleCatchUp(target))) return o
    if (o?.outcome === 'integrated') await this.settlePush(target)
    return o
  }

  /** Whether the project's options push the target after merging, as they are now (G18 isn't a rule: never a ruleset's). */
  private pushes(): boolean {
    const o = this.wf.cfg.options()
    return merges(o.platform) && o.finish === 'combworkMerges' && (o.pushTarget === true || o.followRemote === true)
  }

  /** The message of Combwork's merge commits (G19, HI-1697), as the project's options are now: like G18, never a ruleset's. */
  private commitMessage(): CommitMessage {
    return this.wf.cfg.options().commitMessage ?? 'branch'
  }

  /** In a merge's `Integrated` write: the push of its target owed, when the options push it (G18). */
  private owePush(w: Write, entry: string, target: string, result: string): void {
    if (!this.pushes()) return
    w.tx.setMeta(pushOwedKey(target), JSON.stringify({ result, card: w.card.key, entry } satisfies PushOwed))
    // The merge pending its push, for the queue's history (HI-1924), until a push settles it.
    const pending = pushPendingOf(w.tx.meta(pushPendingKey(target))).filter((p) => p.entry !== entry)
    w.tx.setMeta(pushPendingKey(target), JSON.stringify([...pending, { entry, result } satisfies PushPending]))
  }

  /**
   * Clears the owed push of a target, only if it is still the one for `result` (a newer merge's is kept), and settles
   * the pending merges in `settled` (HI-1924) in the same write: only those, as they were captured before the push, so
   * a merge made meanwhile stays pending.
   */
  private clearOwed(target: string, result: string, settled: PushSettled[] = []): Promise<void> {
    return this.wf.locked(() =>
      this.wf.store.tx((tx) => {
        if (pushOwedOf(tx.meta(pushOwedKey(target)))?.result === result) tx.setMeta(pushOwedKey(target), '')
        if (!settled.length) return
        const done = new Set(settled.map((s) => s.entry))
        const pending = pushPendingOf(tx.meta(pushPendingKey(target)))
        tx.setMeta(pushPendingKey(target), JSON.stringify(pending.filter((p) => !done.has(p.entry))))
        tx.setMeta(pushLogKey(target), JSON.stringify(pushesSettled(pushLogOf(tx.meta(pushLogKey(target))), settled)))
      })
    )
  }

  /**
   * The pending merges a push of `head` settles (HI-1924): each one `head` holds is pushed; one it doesn't (reset away)
   * is `reset`. An ancestry that can't be read leaves that merge pending (said as Not pushed yet), never pushed.
   */
  private async pushedBy(pending: PushPending[], head: string): Promise<PushSettled[]> {
    const at = new Date().toISOString()
    const out: PushSettled[] = []
    for (const p of pending) {
      const has = p.result === head ? true : await queueIntegration().contains(this.project, p.result, head)
      if (!isUnknown(has)) out.push({ entry: p.entry, state: has ? 'pushed' : 'reset', at })
    }
    return out
  }

  /** The pending merges, settled as not pushed (`why`): pushing turned off, or the target no longer has them. */
  private notPushed(pending: PushPending[], why: 'off' | 'reset'): PushSettled[] {
    const at = new Date().toISOString()
    return pending.map((p) => ({ entry: p.entry, state: why, at }))
  }

  /**
   * Settles the push a target is owed (G18, #1179): none owed, nothing. The options no longer push, or the target no
   * longer has the merge (reset since): cleared, nothing pushed. Else the target is pushed to the remote it tracks (or
   * the only remote, or origin, under its own name), never forced and never changing what it tracks, with no prompt and
   * within PUSH_MS; pushed (or up to date already: a retry after a crash before the clear), cleared. Refused, failed or
   * with nowhere to go: the queue pauses, naming the merged card (Done already), and the next entry waits.
   */
  private async settlePush(target: string): Promise<QueueOutcome | null> {
    const owed = pushOwedOf(this.wf.store.meta(pushOwedKey(target)))
    if (!owed) return null
    // The merges pending their push as they are now (HI-1924): only these are settled below.
    const pending = pushPendingOf(this.wf.store.meta(pushPendingKey(target)))
    if (!this.pushes()) {
      await this.clearOwed(target, owed.result, this.notPushed(pending, 'off'))
      return null
    }
    // Unreadable now (HR2's #1179 round 1): never taken for settled. Still owed, and the queue pauses saying so in its
    // own words (`pushUnreadable`, a message the window translates: HR2's round 2), so no later merge goes ahead of it;
    // Resume reads again.
    const I = queueIntegration()
    const h = this.host({})
    const head = await I.targetHead(this.project, target)
    if (isUnknown(head)) return this.pausePush(target, owed, 'pushUnreadable')
    const has = head ? await I.contains(this.project, owed.result, head) : false
    if (isUnknown(has)) return this.pausePush(target, owed, 'pushUnreadable')
    if (!has) {
      // Nothing is pushed: the merges the target no longer has are settled as reset; one it still has stays pending,
      // for the next push to settle (never taken for pushed on the local target alone).
      const gone: PushPending[] = []
      for (const p of pending) if (!head || (await I.contains(this.project, p.result, head)) === false) gone.push(p)
      await this.clearOwed(target, owed.result, this.notPushed(gone, 'reset'))
      return null
    }
    const dest = await I.pushDest(h, target)
    // The off switch as it is now, just before the push begins (HR2's #1179 round 1: the reads above take time).
    if (!this.pushes()) {
      await this.clearOwed(target, owed.result, this.notPushed(pending, 'off'))
      return null
    }
    // HI-2054: where to push couldn't be read: unreadable, as the reads above (in Combwork's own words), never "no remote".
    if (dest === 'unreadable') return this.pausePush(target, owed, 'pushUnreadable')
    if (!dest) return this.pausePush(target, owed, 'pushNoRemote')
    // The head read above, by its commit (HI-1924): what was pushed is exactly what the settled merges are checked against.
    const pushed = head as string
    const r = await I.push(h, dest, pushed)
    if (r === 'pushed') {
      await this.clearOwed(target, owed.result, await this.pushedBy(pending, pushed))
      return null
    }
    if ('rejected' in r) return this.pausePush(target, owed, 'pushRejected', r.rejected)
    // HI-1183: the remote's own refusal (a hook, a protected branch), its words as it gave them.
    return 'refused' in r ? this.pausePush(target, owed, 'pushRefused', r.refused) : this.pausePush(target, owed, 'pushFailed', r.failed)
  }

  /** Pauses the target's queue for its owed push (never in place of a pause saved meanwhile), naming the merged card. */
  private async pausePush(target: string, owed: PushOwed, reason: PauseReason, message?: string): Promise<QueueOutcome> {
    const m = message?.trim().slice(0, 4000) || undefined
    await this.wf.locked(() => this.wf.store.setQueuePause(target, { reason, card: owed.card, ...(m ? { message: m } : {}) }, true))
    return { card: owed.card, entry: owed.entry, outcome: 'paused', reason, ...(m ? { message: m } : {}) }
  }

  // ---- Follow mode (G21, HI-1183, SPEC §16.9.4): the target is the branch it tracks on its remote. The endpoint is
  // captured once for an attempt and every fetch and publication runs in the platform's sealed context (the port's
  // destination, fetchHead, prePush, publish). The publication is the advance: an exact compare-and-swap at the remote,
  // journalled (phases prePush, push) after IntegrationStarted. Once the remote has the result the card is Done, and the
  // local target's catch-up is owed (as G18's push is), never a reason to retest, roll back or publish again. A reply
  // that doesn't say plainly is verified, and stays unknown (For you asks) unless the remote shows the result.

  /** What each entry's last test in follow mode was made on (its remote head and snapshot), for an approval of it. */
  private readonly tested = {
    get: (entry: string): FollowTested | undefined => followTested.get(followKey(this.project, entry)),
    set: (entry: string, t: FollowTested): void => {
      const k = followKey(this.project, entry)
      followTested.delete(k)
      followTested.set(k, t)
      while (followTested.size > FOLLOW_TESTED_MAX) followTested.delete(followTested.keys().next().value!)
    },
    delete: (entry: string): void => void followTested.delete(followKey(this.project, entry))
  }

  /** Whether the target follows its remote, as the project's options are now (G21 isn't a rule), on a platform that can. */
  private follows(card: CardRecord, s: CardState): boolean {
    const o = this.wf.cfg.options()
    if (!(merges(o.platform) && o.finish === 'combworkMerges' && o.followRemote === true)) return false
    const port = this.integration(card, s)
    return !!(port.destination && port.fetchHead && port.prePush && port.publish)
  }

  /**
   * §16.9.4 step 1: the endpoint captured for this attempt, the remote's branch fetched into the entry's own pin (its head
   * that fetch's, never a shared tracking ref's), and the local target behind it or at it; one with commits the remote
   * lacks pauses `remoteDiverged`, never forced and never merged silently.
   */
  private async followFetch(card: CardRecord, s: CardState, entry: QueueEntry, target: string, local: string): Promise<Again | { pause: PauseReason; files?: string[]; message?: string } | { onto: string; snap: TransportSnapshot }> {
    const I = this.integration(card, s)
    const h = this.host({})
    const d = await I.destination!(h, target)
    if (isAgain(d)) return d
    if ('pause' in d) return { pause: d.pause, ...(d.files?.length ? { files: d.files } : {}) }
    const f = await I.fetchHead!(h, d.snapshot, fetchPin(entry.id))
    if ('failed' in f) return { pause: 'fetchFailed', message: f.failed }
    if (f.head !== local) {
      const behind = await I.contains(this.project, local, f.head)
      if (isUnknown(behind)) return again(gitSaid(behind))
      if (!behind) return { pause: 'remoteDiverged', files: [target, `${d.snapshot.remote}/${d.snapshot.ref.replace(/^refs\/heads\//, '')}`] }
    }
    return { onto: f.head, snap: d.snapshot }
  }

  /**
   * Follow mode's advance: the result proved to contain the remote head it was tested on (so the lease is a fast-forward),
   * the snapshot kept in the protected store, `IntegrationStarted` with its record (never a secret), then the publication.
   */
  private async advancePublish(card: CardRecord, entry: QueueEntry, target: string, expected: string, onto: string, result: string, folder: string | null, snap: TransportSnapshot): Promise<Advance> {
    const I = this.integration(card, this.wf.state(card))
    const on = await I.contains(this.project, onto, result)
    if (isUnknown(on)) return again(gitSaid(on))
    if (!on) return { pause: 'needsYou', message: `The test merge ${result.slice(0, 12)} doesn't contain ${onto.slice(0, 12)}, the remote's head it was tested on, so Combwork didn't publish it.` } // i18n-ignore: git's side of a pause, in English as git's are
    // The store unreadable now (HI-2993): nothing kept or published, tried again as a failed read is.
    let saved: Awaited<ReturnType<TransportStore['save']>> | undefined
    try {
      saved = await this.cfg.transport?.save(this.project, target, snap)
    } catch (e) {
      return again(e instanceof Error ? e.message : String(e))
    }
    if (!saved) return { pause: 'remoteUnsupported' }
    const publish: PublishFact = { remote: snap.remote, endpoint: snap.display, ref: snap.ref, onto, snapshot: saved.id, digest: saved.digest }
    const started = await this.startAdvance(card, entry, { entry: entry.id, expected, result, checkedOut: folder, publish })
    if (started !== 'started') await this.cfg.transport!.drop(saved.id)
    if (started === 'rulesOff') return { pause: 'rulesOff' }
    if (started === 'ask') return folder ? { outcome: await this.askAdvance(card, entry, target, expected, result, folder) } : 'retest'
    if (started === 'proofGone') return 'retest'
    if (started === 'denied' || started === 'held' || started === 'waiting') return started
    await this.cfg.hooks?.afterStarted?.(entry.id)
    return this.publishBegun(card, entry, target, snap, publish, result)
  }

  /** The project's pre-push hook (phase prePush: nothing sent), then the publication (phase push), then its reply acted on. */
  private async publishBegun(card: CardRecord, entry: QueueEntry, target: string, snap: TransportSnapshot, rec: PublishFact, result: string): Promise<Advance> {
    const I = this.integration(card, this.wf.state(card))
    const h = this.host({})
    this.stillHolds(target)
    await this.phase(card, entry, 'prePush')
    const hook = await I.prePush!(h, snap, rec.onto, result)
    if (hook !== 'ok') {
      await this.unpublished(card, entry, target, 'pushRefused')
      return 'refused' in hook ? { pause: 'publishRefused', message: hook.refused } : { pause: 'hookTimedOut', message: hook.timedOut }
    }
    this.stillHolds(target)
    await this.phase(card, entry, 'push')
    await this.cfg.hooks?.beforePublish?.(entry.id)
    this.stillHolds(target)
    const reply = await I.publish!(h, snap, rec.onto, result)
    await this.cfg.hooks?.afterPublish?.(entry.id)
    return this.publishReplied(card, entry, target, snap, rec, result, reply)
  }

  /**
   * A publication's reply: published (or at the result already) → done; refused before anything was written (the lease,
   * a fast-forward: the remote moved) → tested again; refused by the remote → paused with its words; anything else is
   * verified at the endpoint, and stays unknown (For you) unless the remote shows the result.
   */
  private async publishReplied(card: CardRecord, entry: QueueEntry, target: string, snap: TransportSnapshot, rec: PublishFact, result: string, reply: PublishReply): Promise<Advance> {
    if (reply === 'pushed' || reply === 'atResult') return 'done'
    if ('stale' in reply) {
      await this.unpublished(card, entry, target, 'targetMoved')
      return 'moved'
    }
    if ('refused' in reply) {
      await this.unpublished(card, entry, target, 'pushRefused')
      return { pause: 'publishRefused', message: reply.refused }
    }
    const v = await this.verifyPublished(card, entry.id, snap, result)
    if (v === 'published') return 'done'
    return { outcome: await this.askPublished(target, card, entry, rec, result, typeof v === 'object' ? `${reply.unknown}\n${v.unreadable}` : reply.unknown) }
  }

  /** Whether the endpoint has the result now: a fresh fetch in the attempt's own sealed context, into the entry's pin. */
  private async verifyPublished(card: CardRecord, entry: string, snap: TransportSnapshot, result: string): Promise<'published' | 'absent' | { unreadable: string }> {
    const I = this.integration(card, this.wf.state(card))
    const f = await I.fetchHead!(this.host({}), snap, fetchPin(entry))
    if ('failed' in f) return { unreadable: f.failed }
    const has = await I.contains(this.project, result, f.head)
    if (isUnknown(has)) return { unreadable: gitSaid(has) }
    return has ? 'published' : 'absent'
  }

  /** Not published (nothing was written): the entry failed, transient, the card queued again, its snapshot dropped. */
  private async unpublished(card: CardRecord, entry: QueueEntry, target: string, reason: IntegrationFailReason): Promise<void> {
    await this.dropSnapshot(card, entry.id)
    await this.moved(card, entry, target, reason)
  }

  /** An entry's protected snapshot dropped, by its IntegrationStarted's record (none: nothing to drop). */
  private async dropSnapshot(card: CardRecord, entry: string): Promise<void> {
    // Its test kept for an approval (HI-2986) goes with it: the entry's outcome is written, or it is tested again.
    this.tested.delete(entry)
    const f = this.wf.store.facts(card.id).filter((x) => x.kind === 'IntegrationStarted' && (x.data as FactData['IntegrationStarted']).entry === entry).at(-1)
    const id = (f?.data as FactData['IntegrationStarted'] | undefined)?.publish?.snapshot
    if (id) await this.cfg.transport?.drop(id)
  }

  /**
   * A target's snapshots its begun publications no longer need (crash leftovers), dropped by its own queue's host between
   * its entries, under its lease (HR2's round 2): never another target's, which may be between its save and its
   * IntegrationStarted.
   */
  async pruneSnapshots(target: string): Promise<void> {
    if (!this.cfg.transport) return
    const keep = new Set<string>()
    for (const card of this.wf.store.cards()) {
      const e = openEntry(this.wf.state(card))
      if (e?.state === 'started' && e.started?.publish && e.target === target) keep.add(e.started.publish.snapshot)
    }
    await this.cfg.transport.dropExcept(this.project, target, keep)
  }

  /**
   * An unknown publication the remote doesn't show: paused `publishUnknown` (the attempt, its pins and snapshot kept),
   * and For you asks, once: Approve, it was published; Decline, it wasn't (tested again). Never pushed or tested again
   * before the remote shows it or the user answers (HR2's s14).
   */
  private async askPublished(target: string, card: CardRecord, entry: QueueEntry, rec: PublishFact, result: string, message: string): Promise<QueueOutcome> {
    const out = await this.pause(target, card, entry, 'publishUnknown', undefined, message)
    await this.write(card, (w) => {
      if (w.state().requests.some((r) => r.gate === QUEUE_PUBLISH_GATE && r.entry === entry.id)) return
      this.wf.askUser(w, 'approve', QUEUE_PUBLISH_GATE, workflowText(FOR_YOU.queuePublish, { card: card.key, target, endpoint: rec.endpoint, result: result.slice(0, 12) }), { unbound: true, entry: entry.id, result })
    })
    return out
  }

  /** The user's answer to an unknown publication: approved, declined, or none yet (still open, or never asked). */
  private publishAnswer(card: CardRecord, e: QueueEntry): 'approved' | 'declined' | undefined {
    const s = this.wf.state(card)
    const asked = Object.values(s.made).filter((r) => r.gate === QUEUE_PUBLISH_GATE && r.entry === e.id).at(-1)
    if (!asked || s.requests.some((r) => r.request === asked.request)) return undefined
    const a = s.approvals.filter((x) => x.request === asked.request).at(-1)?.answer
    return a === 'approved' || a === 'declined' ? a : undefined
  }

  /**
   * Begun publications of a target settled before anything else (a restart, a lost lease, Resume, an answer): one that
   * never reached phase push sent nothing (tested again); one in phase push takes the user's answer, else is verified at
   * its own endpoint (its protected snapshot, never the configuration as it is now): shown there, Done; else unknown.
   */
  private async settlePublications(target: string): Promise<QueueOutcome | null> {
    for (const card of this.wf.store.cards()) {
      const e = openEntry(this.wf.state(card))
      if (!e || e.state !== 'started' || !e.started?.publish || e.target !== target) continue
      const o = await this.settlePublication(card, e)
      if (o) return o
    }
    return null
  }

  private async settlePublication(card: CardRecord, e: QueueEntry): Promise<QueueOutcome | null> {
    const rec = e.started!.publish!
    const result = e.started!.result
    const target = e.target
    if (e.phases.at(-1) !== 'push') {
      await this.unpublished(card, e, target, 'targetMoved')
      return null
    }
    const lift = (): Promise<boolean> => this.wf.locked(() => this.wf.store.clearQueuePause(target, 'publishUnknown'))
    const answer = this.publishAnswer(card, e)
    if (answer === 'declined') {
      await this.unpublished(card, e, target, 'notPublished')
      await lift()
      return null
    }
    let shown = answer === 'approved'
    let message = ''
    if (!shown) {
      const snap = await this.cfg.transport?.load(rec.snapshot, rec.digest)
      if (!snap) return this.askPublished(target, card, e, rec, result, `Combwork no longer has this push's protected settings, so it can't look at ${rec.endpoint} the way it pushed.`) // i18n-ignore: the pause's detail, in English as git's are
      const v = await this.verifyPublished(card, e.id, snap, result)
      shown = v === 'published'
      message = typeof v === 'object' ? v.unreadable : `${rec.ref} at ${rec.endpoint} doesn't contain ${result.slice(0, 12)}.` // i18n-ignore: the pause's detail, in English as git's are
    }
    if (!shown) return this.askPublished(target, card, e, rec, result, message)
    const s = this.wf.state(card)
    const requested = this.wf.store.facts(card.id).find((x) => x.kind === 'IntegrationRequested' && (x.data as FactData['IntegrationRequested']).entry === e.id)?.data as FactData['IntegrationRequested'] | undefined
    const method = methodOf(requested?.style ?? this.wf.rulesetOf(card, s).options.style, s.started?.target, target)
    await this.integrated(card, e, s.approved?.revision ?? e.revision, target, result, method, 'combwork', { afterAdvance: true, published: { from: e.started!.expected } })
    await this.dropSnapshot(card, e.id)
    await lift()
    return { card: card.key, entry: e.id, outcome: 'integrated', result, retests: 0 }
  }

  /** The paused queue's answer to its unknown publication: none yet, it stays paused; answered, settled, and the queue goes on. */
  private async publishAnswered(target: string, key: string): Promise<QueueOutcome | null> {
    const card = this.wf.store.cardByKey(key)
    const e = card ? openEntry(this.wf.state(card)) : undefined
    if (!card || !e || e.state !== 'started' || !e.started?.publish) {
      // Settled meanwhile (another Combwork, a restart): the pause lifted.
      return (await this.wf.locked(() => this.wf.store.clearQueuePause(target, 'publishUnknown'))) ? this.runOnce(target) : null
    }
    if (!this.publishAnswer(card, e)) return null
    const o = await this.settlePublication(card, e)
    return this.thenPush(target, o ?? (await this.runOnce(target)))
  }

  /** In a published merge's `Integrated` write: the local target's catch-up owed, and its push recorded as made (HI-1924's log). */
  private oweCatchUp(w: Write, entry: string, target: string, from: string, to: string, pushed: boolean): void {
    w.tx.setMeta(catchUpKey(target), JSON.stringify({ from, to, card: w.card.key, entry } satisfies CatchUp))
    if (pushed) w.tx.setMeta(pushLogKey(target), JSON.stringify(pushesSettled(pushLogOf(w.tx.meta(pushLogKey(target))), [{ entry, state: 'pushed', at: new Date().toISOString() }])))
  }

  /** The integration port of a catch-up's merged card (its platform's), or null when the card is gone. */
  private catchUpPort(c: CatchUp): IntegrationPort | null {
    const card = this.wf.store.cardByKey(c.card)
    return card ? this.integration(card, this.wf.state(card)) : null
  }

  /** Replaces the owed catch-up (null: clears it), only while it is still the one for `to` (a newer merge's is kept). */
  private setCatchUp(target: string, to: string, next: CatchUp | null): Promise<void> {
    return this.wf.locked(() =>
      this.wf.store.tx((tx) => {
        if (catchUpOf(tx.meta(catchUpKey(target)))?.to === to) tx.setMeta(catchUpKey(target), next ? JSON.stringify(next) : '')
      })
    )
  }

  /**
   * Settles the local target's owed catch-up (§16.9.4): a recorded step first, by §16.9.2's recovery table (HR2's s10
   * note), then a fresh one from the local head as it is now (another ancestor of the result gets its own journalled
   * plan). Not checked out: a compare-and-swap. Checked out: the advance's conditions, files and ref, journalled. A
   * condition pauses the queue naming the merged card; the user's edits and ref changes are never overwritten.
   */
  private async settleCatchUp(target: string): Promise<QueueOutcome | null> {
    for (let i = 0; i < 3; i++) {
      const c = catchUpOf(this.wf.store.meta(catchUpKey(target)))
      if (!c) return null
      // Its merged card gone from the board: nothing to name a pause on, and no platform to ask; left to the user (cleared).
      if (!this.catchUpPort(c)) {
        await this.setCatchUp(target, c.to, null)
        return null
      }
      const folder = c.folder
      const r = c.phase && folder ? await this.guarded(folder, () => this.catchUpRecorded(target, c, folder)) : await this.catchUpFresh(target, c)
      if (r !== 'again') return r
    }
    return null
  }

  private async catchUpRecorded(target: string, c: CatchUp, folder: string): Promise<QueueOutcome | null | 'again'> {
    const I = this.catchUpPort(c)!
    const h = this.host({})
    const f = await I.recoveryState(h, { target, expected: c.from, result: c.to, files: c.files ?? [], folder, phase: c.phase! })
    if (f.found === 'integrated' || f.found === 'requeue') {
      await this.setCatchUp(target, c.to, null)
      return null
    }
    if (f.found === 'residue') {
      await this.setCatchUp(target, c.to, null)
      return this.catchUpPause(target, c, 'needsYou', undefined, undefined, f.stuck)
    }
    if (f.found === 'rerun') {
      await this.setCatchUp(target, c.to, { from: c.from, to: c.to, card: c.card, entry: c.entry })
      return 'again'
    }
    if (f.found === 'rollback') return this.catchUpRollback(target, c, folder)
    if (f.found === 'swap') {
      await this.cfg.hooks?.beforeCatchUpRef?.(c.entry)
      this.stillHolds(target)
      if (!(await I.swap(h, target, c.from, c.to))) return this.catchUpRollback(target, c, folder)
      return this.catchUpConfirm(target, c, folder)
    }
    return this.catchUpPause(target, c, 'needsYou', undefined, undefined, f.stuck)
  }

  private async catchUpFresh(target: string, c: CatchUp): Promise<QueueOutcome | null | 'again'> {
    const I = this.catchUpPort(c)!
    const h = this.host({})
    const local = await I.targetHead(this.project, target)
    // Unreadable now: still owed, read again at the next look.
    if (isUnknown(local)) return null
    const done = async (): Promise<null> => {
      await this.setCatchUp(target, c.to, null)
      return null
    }
    if (!local || local === c.to) return done()
    const has = await I.contains(this.project, c.to, local)
    if (isUnknown(has)) return null
    if (has) return done()
    const behind = await I.contains(this.project, local, c.to)
    if (isUnknown(behind)) return null
    // Commits the remote lacks (the user's, since): left as they are, never forced or merged by Combwork, and the catch-up
    // still owed (HI-2988: dropping it left the published merge out of the local target, all looking well): paused
    // `remoteDiverged`, naming the published card, until the user brings the local target in line with its remote.
    if (!behind) return this.catchUpPause(target, c, 'remoteDiverged', [target])
    const where = await I.checkouts(h)
    if (isUnknown(where)) return null
    const folder = where[target] ? resolve(where[target]) : null
    if (folder) return this.guarded(folder, () => this.catchUpChecked(target, { ...c, from: local }, folder))
    const lock = this.cfg.lock ?? (<T,>(fn: () => Promise<T>) => fn())
    return lock(async (): Promise<null | 'again'> => {
      const now = await I.checkouts(h)
      if (isUnknown(now)) return null
      if (now[target]) return 'again'
      this.stillHolds(target)
      if (await I.swap(h, target, local, c.to)) return done()
      return 'again'
    })
  }

  /** A checked-out target's catch-up from `c.from` (the local head now), under the lock and the folder's fence. */
  private async catchUpChecked(target: string, c: CatchUp, folder: string): Promise<QueueOutcome | null | 'again'> {
    const I = this.catchUpPort(c)!
    const h = this.host({})
    const now = await I.checkouts(h)
    if (isUnknown(now)) return null
    if (!now[target] || resolve(now[target]).toLowerCase() !== folder.toLowerCase()) return 'again'
    const busy = this.cfg.folderBusy?.(folder)
    if (busy) return this.catchUpPause(target, c, 'folderBusy', busy.length ? busy : [folder])
    const cond = await I.conditions(h, folder, target, c.from, c.to)
    if (isAgain(cond)) return null
    if (cond === 'retest') return 'again'
    if ('pause' in cond) return this.catchUpPause(target, c, cond.pause, cond.files, undefined, undefined, FOLDER_PAUSES.has(cond.pause) ? folder : undefined)
    // Its plan journalled before anything moves (from the local head it found: never an earlier plan's files).
    const plan: CatchUp = { from: c.from, to: c.to, card: c.card, entry: c.entry, folder, files: cond.files, phase: 'files' }
    await this.setCatchUp(target, c.to, plan)
    await this.cfg.hooks?.beforeCatchUpFiles?.(c.entry)
    this.stillHolds(target)
    const rt = await I.moveFiles(h, folder, c.from, c.to)
    if (!rt.ok) {
      const sides = await I.sides(h, folder, cond.files, c.from, c.to)
      if (sides && sides.every((f) => f.side === 'expected' || (f.side === 'other' && f.staged === 'expected'))) {
        // Nothing moved: the plan left without a phase, and a file the user edited since pauses, named.
        await this.setCatchUp(target, c.to, { from: c.from, to: c.to, card: c.card, entry: c.entry })
        const ed = await I.edited(h, folder, cond.files)
        return Array.isArray(ed) && ed.length ? this.catchUpPause(target, c, 'unstagedChanges', ed) : null
      }
      return this.catchUpPause(target, plan, 'needsYou', undefined, rt.err, await I.stuck(h, target, folder, c.from, c.to, cond.files, 'files'))
    }
    const ref: CatchUp = { ...plan, phase: 'ref' }
    await this.setCatchUp(target, c.to, ref)
    await this.cfg.hooks?.beforeCatchUpRef?.(c.entry)
    this.stillHolds(target)
    if (!(await I.swap(h, target, c.from, c.to))) return this.catchUpRollback(target, ref, folder)
    return this.catchUpConfirm(target, ref, folder)
  }

  /** The ref moved under the catch-up: its files back to where they were (phase rollback), and looked at again; refused, terminal. */
  private async catchUpRollback(target: string, c: CatchUp, folder: string): Promise<QueueOutcome | null | 'again'> {
    const I = this.catchUpPort(c)!
    const h = this.host({})
    await this.setCatchUp(target, c.to, { ...c, folder, phase: 'rollback' })
    this.stillHolds(target)
    const back = await I.moveFiles(h, folder, c.to, c.from)
    if (!back.ok) return this.catchUpPause(target, c, 'needsYou', undefined, back.err, await I.stuck(h, target, folder, c.from, c.to, c.files ?? [], 'rollback'))
    await this.setCatchUp(target, c.to, { from: c.from, to: c.to, card: c.card, entry: c.entry })
    return 'again'
  }

  /** After the catch-up's swap: cleared, and a folder switched in that instant is §16.9.2's residue (paused, the files listed). */
  private async catchUpConfirm(target: string, c: CatchUp, folder: string): Promise<QueueOutcome | null> {
    const I = this.catchUpPort(c)!
    let after = await I.folderLine(folder)
    for (let i = 0; isUnknown(after) && i < CONFIRM_TRIES; i++) {
      await wait(CONFIRM_RETRY_MS)
      after = await I.folderLine(folder)
    }
    this.stillHolds(target)
    await this.setCatchUp(target, c.to, null)
    if (isUnknown(after) || after !== target) return this.catchUpPause(target, c, 'needsYou', undefined, undefined, await I.stuck(this.host({}), target, folder, c.from, c.to, c.files ?? [], 'done'))
    return null
  }

  /** A catch-up's pause, naming the published card (Done already); a stuck one asks For you on it, as an advance's does. */
  private async catchUpPause(target: string, c: CatchUp, reason: PauseReason, files?: string[], message?: string, stuck?: QueueStuck, folder?: string): Promise<QueueOutcome> {
    const card = this.wf.store.cardByKey(c.card)
    const entry = card ? this.wf.state(card).entries.find((x) => x.id === c.entry) : undefined
    if (card && entry) return this.pause(target, card, entry, reason, files, message, stuck, folder)
    const m = message?.trim().slice(0, 4000) || undefined
    await this.wf.locked(() => this.wf.store.setQueuePause(target, { reason, card: c.card, ...(files?.length ? { files } : {}), ...(m ? { message: m } : {}), ...(stuck ? { stuck } : folder ? { folder } : {}) }, !stuck))
    return { card: c.card, entry: c.entry, outcome: 'paused', reason, ...(files?.length ? { files } : {}), ...(m ? { message: m } : {}) }
  }

  /** Resume's check of a stuck catch-up (§16.9.2's terminal state, as recovery would find it now): its files, or null. */
  async catchUpStuck(target: string): Promise<string[] | null> {
    const c = catchUpOf(this.wf.store.meta(catchUpKey(target)))
    const I = c ? this.catchUpPort(c) : null
    if (!c?.phase || !c.folder || !I) return null
    const f = await I.recoveryState(this.host({}), { target, expected: c.from, result: c.to, files: c.files ?? [], folder: c.folder, phase: c.phase })
    return f.found === 'stuck' || f.found === 'residue' ? (f.stuck?.files.map((x) => x.path) ?? []) : null
  }

  /**
   * The user's answer to "Update <target> in <folder> now" (Ask each time, #1351), read from the card's facts: not yet,
   * the queue still waits. Approved: the pause lifted and the advance run at once, on the test merge it was asked about
   * (tested again, and asked again, if the target moved meanwhile). Declined: the entry leaves the queue, the card back
   * to Approved as Remove from queue leaves it, and the queue goes on. An entry with an outcome meanwhile: the pause lifted.
   */
  private async answered(target: string, key: string): Promise<QueueOutcome | null> {
    const card = this.wf.store.cardByKey(key)
    const s = card ? this.wf.state(card) : null
    const e = s ? openEntry(s) : undefined
    const asked = s && e ? Object.values(s.made).filter((r) => r.gate === QUEUE_ADVANCE_GATE && r.entry === e.id).at(-1) : undefined
    // Lifted only from the approval it is (a Pause queue saved in its place stays, and the queue with it).
    const lift = (): Promise<boolean> => this.wf.locked(() => this.wf.store.clearQueuePause(target, 'approval'))
    if (!card || !s || !e || e.target !== target || !asked) {
      return (await lift()) ? this.runOnce(target) : null
    }
    const open = s.requests.some((r) => r.request === asked.request)
    // Still asked: waits, unless the setting says Automatically now (HR4's #1351 round 1: a change to it wakes the queue,
    // queueHost), which advances that test merge as an approval would; its question is retired by the entry's outcome.
    const auto = open && this.cfg.checkedOutTarget?.() === 'auto'
    if (open && !auto) return null
    const answer = auto ? 'approved' : s.approvals.filter((a) => a.request === asked.request).at(-1)?.answer
    if (!(await lift())) return null
    if (answer !== 'approved') {
      const wrote = await this.write(card, (w) => {
        if (!this.isOpen(w, e)) return false
        w.fact('IntegrationCancelled', { entry: e.id, reason: 'user' }) // i18n-ignore: a fact's kind and codes, not text
        w.move(w.ruleset && hasStage(w.ruleset, 'approved') ? 'approved' : 'active', 'user')
        return true
      })
      return { card: card.key, entry: e.id, outcome: 'skipped', why: wrote ? 'declined' : 'cancelled' } // i18n-ignore: a reason's key, not text
    }
    return this.process(card, e, asked.revision && asked.result ? { expected: asked.revision, result: asked.result } : undefined)
  }

  private async write<T>(card: CardRecord, fn: (w: Write) => T): Promise<T> {
    const s = this.wf.state(card)
    return this.wf.write(card, this.wf.rulesetOf(card, s), 'combwork', fn)
  }

  /**
   * The advance's authority, decided in the transaction that writes `IntegrationStarted` (§16.4.6, §16.9.1 step 6):
   * the entry still the card's open one, the card in Merging, approved at the current generation and not stale. A
   * decision, a cancel or a stale pass that landed after the queue's last check stops it here, before git is touched.
   * Workflow rules turned off by now (while the queue waited for the repository lock, say): no advance begins, `rulesOff`.
   * The queue paused by now (Pause queue): none begins either, `held`, the entry left open. A focused test's review
   * proof gone since its checks (HI-2660): none begins, `proofGone`, and the entry goes round again.
   */
  private startAdvance(card: CardRecord, entry: QueueEntry, data: FactData['IntegrationStarted']): Promise<'started' | 'denied' | 'rulesOff' | 'held' | 'ask' | 'proofGone' | 'waiting'> {
    return this.write(card, (w) => {
      const s = w.state()
      const e = s.entries.find((x) => x.id === entry.id)
      const open = !!e && (e.state === 'open' || (e.state === 'started' && this.rerun.has(e.id)))
      const r = w.ruleset!
      const approved = r.options.review === 'none' ? !s.stale : !notApproved(s, r, card.labels)
      if (!open || s.stage !== 'merging' || !approved) return 'denied' as const
      // HI-2709: the advance's authority over the card's blockers (SPEC §16.9.1): its blocked-by list and their stages as
      // this write reads them. One that isn't Done (or can't be read) holds it: nothing begins, the entry stays open, and
      // it is tested again once unblocked. A dependency added after this write is refused (tasks.ts: too late to hold it).
      if (this.wf.closeWaitsFor(w).length) return 'waiting' as const
      // HI-2660: the focused tests' review proof read again here, in the lock, on the facts as they are now: one that no
      // longer stands sends the entry round again, whose checks then return the card for its proof (`noProof`).
      if (focusedProofGone(s, r.options.commands, proofReviewers(this.wf.store.card(card.id).reviewer, s), entry, data.result).length) return 'proofGone' as const
      if (this.cfg.enforced && !this.cfg.enforced()) return 'rulesOff' as const
      if (this.wf.store.queuePause(entry.target) || this.cfg.teamPaused?.()) return 'held' as const
      // A checked-out target under Ask each time (OP-40): only with the user's Approve of this entry and test merge, as
      // the setting and the answers are now, here in the lock (HR4's #1351 round 1: a check before it is an early-out).
      if (data.checkedOut && this.cfg.checkedOutTarget?.() === 'ask' && !advanceApprovedIn(s, entry.id, data.expected, data.result)) return 'ask' as const
      w.fact('IntegrationStarted', data)
      return 'started' as const
    })
  }

  /** Is the entry still the card's open one, approved at the current generation and not stale (§16.9.1 step 2)? */
  private stillApproved(card: CardRecord, entry: QueueEntry): { s: CardState; ok: boolean; cancelled: boolean } {
    const s = this.wf.state(card)
    const e = s.entries.find((x) => x.id === entry.id)
    const cancelled = !e || e.state === 'cancelled' || e.state === 'failed' || e.state === 'integrated'
    const r = this.wf.rulesetOf(card, s)
    const ok = !cancelled && (r.options.review === 'none' ? !s.stale : !notApproved(s, r, card.labels))
    return { s, ok, cancelled }
  }

  /**
   * `ready`: the test merge the user approved advancing (Ask each time): straight to its advance while the target is still
   * where it was. One git step (#1386): what it asks about fixed commits is asked once; refs, HEAD and files are read anew.
   */
  private async process(card: CardRecord, entry: QueueEntry, ready?: { expected: string; result: string }): Promise<QueueOutcome> {
    try {
      return await readStep(() => this.steps(card, entry, ready))
    } finally {
      this.cfg.onStep?.(null)
    }
  }

  private async steps(card: CardRecord, entry: QueueEntry, ready?: { expected: string; result: string }): Promise<QueueOutcome> {
    const target = entry.target
    const started = new Date().toISOString()
    let retests = 0
    let uncounted = 0
    let readRetries = 0
    // HI-2019: a read git couldn't make before anything was touched (the lock and the fence released already): the entry
    // goes round again after a wait, admitted afresh first (still approved, no pause saved meanwhile, the rules on, the
    // lease held), so nothing more is merged or checked once one of those changed; past the budget, paused with git's text.
    const readFailed = async (a: Again): Promise<QueueOutcome | null> => {
      if (++readRetries > READ_RETRIES) return this.pause(target, card, entry, 'needsYou', undefined, a.again.message)
      await wait(READ_RETRY_MS * readRetries)
      await this.cfg.hooks?.beforeRetry?.(entry.id)
      const now = this.stillApproved(card, entry)
      if (!now.ok) return this.skip(card, entry, now.cancelled)
      const held = this.paused(target)
      if (held) return this.held(card, entry, held.reason)
      if (this.cfg.enforced && !this.cfg.enforced()) return this.pause(target, card, entry, 'rulesOff')
      this.stillHolds(target)
      return null
    }
    for (;;) {
      const reads: EntryReads = {}
      const check = this.stillApproved(card, entry)
      if (!check.ok) return this.skip(card, entry, check.cancelled)
      const s = check.s
      // HI-2892: a forward merge against the release path's direction, its request with no override, is never merged: it
      // comes back with why, whatever let it be queued (one from before, or the default branch changed since). HI-2998: and
      // so does a forward's resolution (Resolve on a builder), checked at Resolve, with its forward's override.
      if ((s.forward || s.resolves) && !(await this.forwardAllowed(card, s))) return this.returnCard(card, entry, entry.revision, target, 'direction', false)
      // HI-2999: a resolution without the commit it resolves (cherry-picked, not merged), however it got here: back to its builder.
      if (s.resolves && (await this.wf.resolutionMissing(this.wf.rulesetOf(card, s).options, s, s.approved?.revision ?? entry.revision))) return this.returnCard(card, entry, entry.revision, target, 'resolution', false)
      // HI-2709: blocked by a card that isn't Done: no test merge for it now (decided again at the advance's authority).
      const blockers = this.wf.queueWaitingOn(card.id)
      if (blockers.length) return this.waiting(card, entry, blockers)
      // OP-29's backstop (#1419): inside a larger repository, only into a branch the project itself named in the card's
      // ruleset (`targetOwn`, kept with a lane's rules too), never one inherited from the workspace's or Combwork's defaults.
      if (!this.wf.rulesetOf(card, s).options.targetOwn && this.cfg.subfolder?.()) return this.pause(target, card, entry, 'subfolderTarget')
      // HI-1697: an upgraded project's first merge waits for its merge style and commit message to be chosen.
      if (await this.mergeAsked()) return this.askMerge(card, entry, target)
      const revision = s.approved?.revision ?? entry.revision
      const step = (now: QueueStep, expected: string | null): void => this.cfg.onStep?.({ card: card.key, number: card.id, entry: entry.id, revision, expected, step: now, started })
      let expected: string
      let result: string
      // G21 (HI-1183, §16.9.4): the target follows its remote, as the options are now. `onto` is the remote's head the test
      // merge is made on (the local head otherwise); `expected` stays the local head, the advance's own compare-and-swap.
      const follow = this.follows(card, s)
      let onto: string
      let snap: TransportSnapshot | undefined
      // Follow mode's approved test merge is only the one tested on a fetch this Combwork still has (its remote head and
      // snapshot, kept across the host's queues: HI-2986): after a restart, it is tested, and asked about, again.
      const kept = ready && follow ? this.tested.get(entry.id) : undefined
      if (ready && follow && kept?.result !== ready.result) ready = undefined
      if (ready) {
        // Approved: the advance at once, on the test merge and checks the user was asked about (its result pinned on the
        // card's queue ref). The target moving since is caught below, and the entry is tested again.
        ;({ expected, result } = ready)
        onto = kept?.onto ?? expected
        snap = kept?.snap
        ready = undefined
      } else {
        step('testMerge', null)
        const base = s.approved?.base ?? s.latest?.base ?? s.started?.base ?? ''
        const head = await this.history(card, s).lineHeadAndTree(this.project, target)
        if (isUnknown(head)) {
          const o = await readFailed(again(gitSaid(head)))
          if (o) return o
          continue
        }
        if (!head) return this.pause(target, card, entry, 'needsYou')
        onto = head
        if (follow) {
          // The remote's branch fetched first, with the endpoint captured for this attempt (§16.9.4 step 1).
          const f = await this.followFetch(card, s, entry, target, head)
          if (isAgain(f)) {
            const o = await readFailed(f)
            if (o) return o
            continue
          }
          if ('pause' in f) return this.pause(target, card, entry, f.pause, f.files, f.message)
          onto = f.onto
          snap = f.snap
        }
        // Already in the target (merged by hand meanwhile): observed, no empty merge. Asked of the head just read (the
        // remote's, following it). A forward merge (HI-2885) only when its source is in the target's history: one whose
        // files the target already has (main after a release, into the next version) still lands as a merge commit.
        const there = await this.history(card, s).contains(this.project, target, { base, revision, key: s.latest?.key }, onto)
        const found = s.forward && !isUnknown(there) && there && there.method !== 'merge' && there.method !== 'fastForward' ? null : there
        if (!isUnknown(found) && found) {
          // A forward merge (HI-2679) has no line to reconcile: its attempt's own frozen commit, proven in the target just
          // now, is what is recorded (never a newer source head's).
          if (s.forward) await this.integrated(card, entry, revision, target, onto, 'merge', 'outside') // no advance: the blocker rule applies
          // G21 (HR2's HI-1183 round 1): found in the remote's head just fetched, which is the target: recorded from that
          // head (reconcile would read the local target, still behind), the blocker rule applying, and the local catch-up owed.
          else if (follow) await this.integrated(card, entry, revision, target, onto, 'merge', 'outside', { catchUp: { from: head } })
          else await reconcile(this.wf, card)
          // HI-2709: not closed while a dependency added meanwhile isn't Done (reconcile writes nothing then): it waits.
          const held = this.wf.state(card).stage !== 'done' ? this.wf.queueWaitingOn(card.id) : []
          if (held.length) return this.waiting(card, entry, held)
          return { card: card.key, entry: entry.id, outcome: 'integratedOutside' }
        }
        expected = head

        // The test merge, in the queue's own worktree, at the expected revision; under strict (G8) of the reviewed revision
        // brought up to date with it there first (#1352), the card's line untouched.
        step('testMerge', onto)
        let updated: string | undefined
        // Rebase and fast-forward (#1184) puts the change on top of the target in the test merge itself: no update first.
        if (this.wf.rulesetOf(card, s).options.strict && this.wf.rulesetOf(card, s).options.style !== 'rebase') {
          const up = await this.upToDate(card, s, entry, revision, base || (await this.integration(card, s).mergeBase(this.host(reads), revision, onto)), onto, reads)
          if (isAgain(up)) {
            const o = await readFailed(up)
            if (o) return o
            continue
          }
          if ('pause' in up) return this.pause(target, card, entry, up.pause, up.files, up.message)
          if ('fail' in up) return this.returnCard(card, entry, revision, target, up.fail === 'hook' ? 'hook' : 'notUpToDate', false, up.files, up.log, undefined, undefined, up.conflicts)
          updated = up.updated ?? undefined
        }
        const test = await this.testMerge(card, s, revision, onto, reads, updated, base)
        if (isAgain(test)) {
          const o = await readFailed(test)
          if (o) return o
          continue
        }
        if ('pause' in test) return this.pause(target, card, entry, test.pause, test.files, test.message)
        if ('fail' in test) return this.returnCard(card, entry, revision, target, test.fail, false, test.files, test.log, undefined, undefined, test.conflicts)
        result = test.result
        await this.cfg.hooks?.afterTest?.(entry.id)

        // The merge checks, on exactly that result (dependencies from scratch when the manifests changed). Passed but not
        // proved (something changed the folder while one ran): tested again from a fresh test merge, then paused.
        step('checks', onto)
        const checks = await this.mergeChecks(card, result, entry, onto)
        if (checks.kind === 'red') return this.returnCard(card, entry, revision, target, 'checks', checks.transient, undefined, checks.output, checks.cause, { check: checks.check, ...(checks.logPath ? { logPath: checks.logPath } : {}) })
        // Missing review proof or a missing runner isn't the work's fault: the same revision may go back (requeue.allowed).
        if (checks.kind === 'focused') return this.returnCard(card, entry, revision, target, 'focused', checks.focused.why === 'noProof' || checks.focused.why === 'noRunner', undefined, undefined, undefined, undefined, undefined, checks.focused)
        if (checks.kind === 'skip') return this.askSkip(target, card, entry, checks.skipped, { expected: checks.expected, tree: checks.tree })
        if (checks.kind === 'uncounted') {
          if (++uncounted > MAX_RETESTS) return this.pause(target, card, entry, 'uncounted')
          continue
        }
        await this.cfg.hooks?.afterChecks?.(entry.id)
        // Follow mode: what this result was tested on, for an approval of it (Ask each time) to publish exactly that.
        if (follow && snap) this.tested.set(entry.id, { onto, result, snap })
      }

      // The last check before the target moves: still approved (a decision since cancels the entry).
      const last = this.stillApproved(card, entry)
      if (!last.ok) return this.skip(card, entry, last.cancelled)
      // HI-2660: a focused test's review proof gone since its checks: round again, whose checks return the card for it.
      if (focusedProofGone(last.s, this.wf.rulesetOf(card, last.s).options.commands, proofReviewers(this.wf.store.card(card.id).reviewer, last.s), entry, result).length) {
        if (++retests > MAX_RETESTS) return this.pause(target, card, entry, 'targetMovesFast')
        continue
      }
      // Paused meanwhile (Pause queue): the entry's checks are done, and it waits, open, for Resume (from its test merge).
      const held = this.paused(target)
      if (held) return this.held(card, entry, held.reason)
      // HI-2709: a dependency added (or a blocker reopened) while it was tested: it waits, open. An early-out: startAdvance decides.
      const blocked = this.wf.queueWaitingOn(card.id)
      if (blocked.length) return this.waiting(card, entry, blocked)
      step('advance', expected)
      const now = await this.integration(card, s).targetHead(this.project, target)
      if (isUnknown(now) || now !== expected) {
        // The target moved since the test: tested again against the new head; never an untested advance.
        if (++retests > MAX_RETESTS) return this.pause(target, card, entry, 'targetMovesFast')
        continue
      }
      // Workflow rules turned off meanwhile: no advance begins (an entry already begun finishes: recover). Decided again
      // in the write of `IntegrationStarted` (startAdvance), after the wait for the lock.
      if (this.cfg.enforced && !this.cfg.enforced()) return this.pause(target, card, entry, 'rulesOff')
      const where = await this.integration(card, s).checkouts(this.host(reads))
      if (isUnknown(where)) {
        const o = await readFailed(again(gitSaid(where)))
        if (o) return o
        continue
      }
      // Checked out in a folder, as far as is known now (each advance looks again under the lock).
      const folder = where[target] ? resolve(where[target]) : null
      // Ask each time (OP-40): the user approves updating the folder, bound to this entry and its test merge. An early-out
      // only: decided again in IntegrationStarted's write, in the lock.
      if (folder && this.cfg.checkedOutTarget?.() === 'ask' && !advanceApprovedIn(this.wf.state(card), entry.id, expected, result)) return this.askAdvance(card, entry, target, expected, result, folder)
      const method = methodOf(this.wf.rulesetOf(card, s).options.style, s.started?.target, target)
      // The record of its own advance: written whatever (HI-2709: its blockers were decided in IntegrationStarted's write).
      // Follow mode's advance is the publication (§16.9.4): `Integrated` then owes the local target's catch-up, not a push.
      const integrate = async (): Promise<void> => {
        await this.integrated(card, entry, revision, target, result, method, 'combwork', { afterAdvance: true, ...(follow ? { published: { from: expected } } : {}) })
        // Its snapshot no longer needed once the outcome is written (never before: recovery verifies with it).
        if (follow) await this.dropSnapshot(card, entry.id)
      }
      const adv = follow && snap ? await this.advancePublish(card, entry, target, expected, onto, result, folder, snap) : follow ? 'retest' : folder ? await this.advanceCheckedOut(card, entry, target, expected, result, folder, integrate) : await this.advanceRef(card, entry, target, expected, result)
      // Settled in the lock: a pause, the terminal state, the ask.
      if (typeof adv === 'object' && 'outcome' in adv) return adv.outcome
      // A read failed before anything was touched (no IntegrationStarted, nothing settled), the lock released: again.
      if (isAgain(adv)) {
        const o = await readFailed(adv)
        if (o) return o
        continue
      }
      // Checked out (or not any more) while the queue waited for the lock, or the target moved before anything was
      // touched: looked at again, the right way.
      if (adv === 'retest') {
        if (++retests > MAX_RETESTS) return this.pause(target, card, entry, 'targetMovesFast')
        continue
      }
      if (adv === 'moved') {
        if (++retests > MAX_RETESTS) return this.pause(target, card, entry, 'targetMovesFast')
        entry = this.wf.state(card).entries.at(-1)!
        continue
      }
      if (adv === 'denied') return this.skip(card, entry, this.stillApproved(card, entry).cancelled)
      if (adv === 'held') return this.held(card, entry, this.paused(target)?.reason ?? 'user')
      if (adv === 'waiting') return this.waiting(card, entry, this.wf.queueWaitingOn(card.id))
      if (typeof adv === 'object') {
        // Every advance settles its pauses in the lock; one that didn't is settled here.
        const s2 = await this.settle(card, entry, target, adv, integrate)
        if (typeof s2 === 'object' && 'outcome' in s2) return s2.outcome
        return this.pause(target, card, entry, 'needsYou')
      }
      await integrate()
      return { card: card.key, entry: entry.id, outcome: 'integrated', result, retests }
    }
  }

  /**
   * Whether the entry is still open (or begun) in this write's state: an outcome the queue writes late (a red check, a
   * stale pass, a moved target) is written only then, so one removed from the queue meanwhile (Remove from queue, a
   * decision) keeps its cancellation and the card where that put it (#1353).
   */
  private isOpen(w: Write, entry: QueueEntry): boolean {
    const e = w.state().entries.find((x) => x.id === entry.id)
    return !!e && (e.state === 'open' || e.state === 'started')
  }

  /** HI-2709: blocked by cards that aren't Done: it stays open, and the queue goes on with the entries behind it. */
  private waiting(card: CardRecord, entry: QueueEntry, on: string[]): QueueOutcome {
    return { card: card.key, entry: entry.id, outcome: 'waiting', on }
  }

  /** Paused by someone while the entry ran (Pause queue): it stays open, and the pause as it is. */
  private held(card: CardRecord, entry: QueueEntry, reason: string): QueueOutcome {
    return { card: card.key, entry: entry.id, outcome: 'paused', reason: reason as PauseReason }
  }

  /**
   * An entry that isn't approved any more (its pass stale, a pass or approval missing at the current generation) gets
   * an outcome, so the queue never stalls on it: cancelled, the card back to Review (or Active), its builder woken. An
   * entry already cancelled (a decision, the user) needs nothing more.
   */
  private async skip(card: CardRecord, entry: QueueEntry, cancelled: boolean): Promise<QueueOutcome> {
    if (!cancelled) {
      const wrote = await this.write(card, (w) => {
        if (!this.isOpen(w, entry)) return false
        const s = w.state()
        // Why (#1354): its pass is stale, or a decision since needs its passes again (none at the current generation).
        const why = !s.stale && s.generation > 0 && !s.verdicts.some((v) => v.pass && v.generation === s.generation) ? 'decision' : 'stale'
        w.fact('IntegrationCancelled', { entry: entry.id, reason: why }) // i18n-ignore: a fact's kind and codes, not text
        const to = w.ruleset && hasStage(w.ruleset, 'review') ? 'review' : 'active'
        w.move(to, 'derived')
        this.wf.wake(w, s.started?.builder, leftWake(card.key, why, to))
        return true
      })
      // Cancelled meanwhile: that cancellation is its outcome.
      if (!wrote) cancelled = true
    }
    return { card: card.key, entry: entry.id, outcome: 'skipped', why: cancelled ? 'cancelled' : 'notApproved' } // i18n-ignore: a reason's key, not text
  }

  /**
   * The project's identity, read from git each time, G12 on or off (HI-2266: G12's saved value only means "on", never a
   * copy that goes stale): null when git says it isn't set, unknown when git couldn't read it (HI-2019).
   */
  private async identity(reads: EntryReads): Promise<Maybe<{ name: string; email: string } | null>> {
    return reads.identity ??= lineHistory().identity(this.project)
  }

  /** The history port of the card's platform (port 3, HI-2792): the queue's step reads ask it. */
  /**
   * HI-2892: whether a forward merge may go, as its direction reads now (the default branch as the card's own port names
   * it; one it can't name or that is gone counts as none, so it makes no direction) or with its request's override.
   * HI-2998: a forward's resolution as its forward, with the override its forward's request recorded.
   */
  private async forwardAllowed(card: CardRecord, s: CardState): Promise<boolean> {
    const f = s.forward ?? s.resolves
    if (!f) return true
    const H = this.history(card, s)
    const d = await H.defaultTarget(this.project).catch(() => null)
    const named = d && !isUnknown(d) ? d : null
    const there = named ? await H.lineHead(this.project, named).catch(() => null) : null
    const main = named && there && !isUnknown(there) ? named : null
    return forwardPermitted(forwardDirection(f.from, f.to, main), f.override)
  }

  private history(card: CardRecord, s?: CardState): HistoryPort {
    return historyFor(this.wf.rulesetOf(card, s).options.platform)
  }

  /** The integration port of the card's platform (port 4's candidate half, HI-2790): the queue's steps call it. */
  private integration(card: CardRecord, s: CardState): IntegrationPort {
    return integrationFor(this.wf.rulesetOf(card, s).options.platform)
  }

  /** What a candidate's step is given of the queue: the repository, its own worktree, its runner and this round's reads. */
  private host(reads: EntryReads): CandidateHost {
    return { project: this.project, folder: this.cfg.folder, run: (cwd, args, opts) => this.git(cwd, args, opts), ...(this.cfg.spawn ? { spawn: this.cfg.spawn } : {}), signTimeoutMs: this.cfg.signTimeoutMs ?? SIGN_TIMEOUT_MS, identity: () => this.identity(reads), reads, skipSmudge: async () => !!(await this.cfg.gitFilesOn?.().catch(() => true)) }
  }

  /**
   * Strict, G8 (§16.9.1 step 3, #1352): the reviewed revision brought up to date with the target in the queue's own
   * worktree (the port's `update`: the target merged in, or with merge style Squash rebased onto it), the same change or
   * the card goes back. The same: recorded (`Updated`, carried), and the entry's test merge merges it.
   */
  private async upToDate(card: CardRecord, s: CardState, entry: QueueEntry, revision: string, base: string, expected: string, reads: EntryReads): Promise<Again | { updated: string | null } | CandidateFail | CandidatePause> {
    const rebase = this.wf.rulesetOf(card, s).options.style === 'squash'
    // Read by the port just before its command, as the options are then (G19), never when the step began.
    const message = (): string => updateMessage(this.commitMessage(), entry.target, card.key, revision)
    const up = await this.integration(card, s).update(this.host(reads), { card: card.key, revision, base, key: s.latest?.key, target: entry.target, expected, entry: entry.id, how: rebase ? 'rebase' : 'merge', message })
    if (isAgain(up) || !('updated' in up) || up.updated === null) return up
    const h = up.updated
    await this.write(card, (w) => {
      if (this.isOpen(w, entry)) w.fact('Updated', { entry: entry.id, from: revision, to: h, how: rebase ? 'rebased' : 'mergedTarget', carried: true }) // i18n-ignore: a fact's kind and codes, not text
    })
    return up
  }

  /**
   * The test merge (§16.9.1 step 4), the port's `candidate` in the queue's own worktree: its message the queue's (G19,
   * HI-1697: Combwork's, or the branch's own, its commits since it left the target with merges left out), read once the
   * worktree is ready, naming the reviewers whose passes count for what is merged (the latest submission, at the current
   * generation) and the queue's update when strict brought it up to date (#1352).
   */
  private async testMerge(card: CardRecord, s: CardState, revision: string, expected: string, reads: EntryReads, updated?: string, base = ''): Promise<Again | { result: string } | CandidateTestFail | CandidatePause> {
    const r = this.wf.rulesetOf(card, s)
    const port = this.integration(card, s)
    const h = this.host(reads)
    const message = async (): Promise<string | Again> => {
      const reviewers = [...new Set(s.verdicts.filter((v) => v.pass && v.submission === s.latest?.id && v.generation === s.generation).map((v) => v.reviewer))].join(', ')
      const how = this.commitMessage()
      const own = how === 'branch' ? await this.history(card, s).messages(this.project, `${base || (await port.mergeBase(h, revision, expected))}..${revision}`) : []
      if (isUnknown(own)) return again(`Combwork couldn't read the messages of ${revision.slice(0, 7)}'s commits.`) // i18n-ignore: git's side of a pause, in English as git's messages are
      return mergeMessage(how, { card, revision, updated, reviewers, messages: own })
    }
    return port.candidate(h, { card: card.key, revision, base, key: s.latest?.key, expected, style: r.options.style === 'rebase' ? 'rebase' : r.options.style === 'squash' ? 'squash' : 'merge', ...(updated ? { updated } : {}), message })
  }

  /**
   * Runs the merge checks (G9) on the test merge's result, one after another, stopping at the first that isn't green.
   * Installs clean first when the manifests changed since the folder's last install (#187, always), or before every
   * entry's checks (`mergeInstall: 'always'`). Each check is bracketed and writes `CheckRan` at the result revision
   * (§16.13): green only if it exited 0 and counted; exit 0 but uncounted is `uncounted`, never green.
   */
  private async mergeChecks(card: CardRecord, result: string, entry: QueueEntry, expected: string): Promise<ChecksOutcome> {
    const o = this.wf.rulesetOf(card).options
    // G20 runs with no G9 checks too (HI-1367), after the same install.
    const focused = o.focusedTests && o.finish === 'combworkMerges'
    if (!o.mergeChecks.length && !focused) return { kind: 'green' }
    const f = this.cfg.folder
    // CW_CHECK_BASE: the target's head the test merge is made on, so a check can look at what the card adds (HI-2617).
    const ctx: CheckContext = { card: card.key, number: card.id, revision: result, env: { CW_CHECK_BASE: expected } }
    const manifests = this.cfg.manifests ?? ['package.json', 'package-lock.json']
    const hash = createHash('sha256')
    for (const m of manifests) hash.update(existsSync(join(f, m)) ? readFileSync(join(f, m)) : `-${m}`)
    const now = hash.digest('hex')
    const key = `queue:installed:${f}`
    let noInstall = false
    // HI-1182: the merged result's submodules and LFS files, every time, before the install and checks.
    if (this.cfg.gitFiles) {
      const g = await this.cfg.gitFiles(f, ctx)
      if (!g.ok) return { kind: 'red', transient: !!g.transient, ...(g.cause ? { cause: g.cause } : {}), output: g.output, check: g.command ?? '', ...(g.logPath ? { logPath: g.logPath } : {}) }
    }
    if (this.cfg.install && (o.mergeInstall === 'always' || this.wf.store.meta(key) !== now)) {
      const i = await this.cfg.install(f, true, ctx)
      if (!i.ok) return { kind: 'red', transient: !!i.transient, ...(i.cause ? { cause: i.cause } : {}), output: i.output, check: 'install', ...(i.logPath ? { logPath: i.logPath } : {}) }
      noInstall = !!i.skipped
      await this.wf.locked(() => this.wf.store.setMeta(key, now))
    }
    for (const name of o.mergeChecks) {
      const command = o.commands[name] ?? name
      const start = await bracketStart(f)
      const r = await this.cfg.runCheck(name, command, f, { ...ctx, ...(noInstall ? { noInstall } : {}) })
      noInstall = false
      const b = await bracketEnd(f, result, start)
      const data: FactData['CheckRan'] = {
        name,
        command: r.command ?? command,
        revision: result,
        tested: b.tested,
        result: r.ok ? 'passed' : 'failed',
        run: r.run ?? randomUUID(),
        durationMs: Math.max(0, Date.now() - start.t0),
        by: CW_RUNS,
        counted: b.counted,
        ...(b.whyNot ? { whyNot: b.whyNot } : {}),
        entry: entry.id
      }
      await this.write(card, (w) => w.fact('CheckRan', data))
      r.note?.({ name, counted: b.counted, ...(b.whyNot ? { whyNot: b.whyNot } : {}) })
      if (!r.ok) return { kind: 'red', transient: !!r.transient, ...(r.cause ? { cause: r.cause } : {}), output: r.output, check: name, ...(r.logPath ? { logPath: r.logPath } : {}) }
      if (!b.counted) return { kind: 'uncounted' }
    }
    if (focused) return this.focusedTests(card, entry, expected, result, { ...ctx, ...(noInstall ? { noInstall } : {}) })
    return { kind: 'green' }
  }

  /**
   * G20 (HI-1367): the card's focused tests at the test merge's result. The approved submission's selection stands for
   * the paths whose change is exactly the submission's; the others are picked here, at exactly the result under a
   * check's bracket (`FocusedPicked`), and any the pick can't choose, or that need a real CLI or the packaged build there
   * (a new test, or one whose needs grew), return the card. A real-CLI or packaged test of the approved selection is
   * proved by a counted run of its card's reviewer at the submitted revision (`FocusedAccepted`, review evidence, never a
   * run here); the rest run once, as the check `focused tests`, bracketed like a G9 check: green only when the runner
   * exited 0, it counted, and its results file has exactly one result per test, none failed. Skipped tests (exit 0, the
   * runner's way to say only skips) wait for a decision bound to this entry, target and merged tree (`askSkip`).
   */
  private async focusedTests(card: CardRecord, entry: QueueEntry, expected: string, result: string, ctx: CheckContext): Promise<ChecksOutcome> {
    const s = this.wf.state(card)
    const o = this.wf.rulesetOf(card, s).options
    const sub = s.submissions.findLast((x) => x.revision === entry.revision) ?? s.latest
    const choice = sub?.focused
    if (!sub || !choice || !choiceStands(choice)) return { kind: 'focused', focused: { why: 'notChosen' } } // i18n-ignore: codes (a why, a check name), never shown as text
    const run = o.commands[FOCUSED_RUN]?.trim()
    if (!run) return { kind: 'focused', focused: { why: 'noRunner' } } // i18n-ignore: codes (a why, a check name), never shown as text
    const f = this.cfg.folder
    const deps = { env: this.cfg.focused?.env ?? (() => ({})), timeoutMs: this.cfg.focused?.pickTimeoutMs() ?? 60_000 }
    const approved = chosenTests(choice)
    // The result's own changes: every path not exactly as submitted, picked here (all the submission's when the result's are unread).
    const now = await pathChanges(f, expected, result)
    const changed = now ? changedSince(choice.change, now) : (choice.change ?? [])
    let tests = approved
    if (changed.length || !now) {
      const pick = o.commands[FOCUSED_PICK]?.trim()
      if (!pick || !now) return { kind: 'focused', focused: { why: 'repick', paths: changePaths(changed) } } // i18n-ignore: codes (a why, a check name), never shown as text
      // At exactly the result, as a check (HR4's round 1 finding 5): a picker that writes in the folder proves nothing.
      const start = await bracketStart(f)
      const p = await runPick(deps, pick, f, expected, changed)
      const b = await bracketEnd(f, result, start)
      if (!b.counted) return { kind: 'uncounted' }
      if (p.state !== 'chosen') return { kind: 'focused', focused: { why: 'repick', paths: changePaths(changed) } } // i18n-ignore: codes (a why, a check name), never shown as text
      await this.write(card, (w) => w.fact('FocusedPicked', { entry: entry.id, revision: entry.revision, result, paths: changePaths(changed), tests: p.tests }))
      // Needs combined by id (finding 4): a test that needs a real CLI or the packaged build only as the merge picks it has
      // no review to prove it (realProof = review, the user's decision), new or not.
      // Each review-only need the merge's pick finds that the reviewed selection didn't have for that id (HR4's round 2
      // finding 2: real → real and packaged is new too).
      const had = (id: string): FocusedTest['needs'] => approved.find((a) => a.id === id)?.needs ?? []
      const unproved = p.tests.filter((t) => t.needs.some((n) => (n === 'real' || n === 'packaged') && !had(t.id).includes(n)))
      if (unproved.length) return { kind: 'focused', focused: { why: 'newProof', tests: unproved.map((t) => t.id) } } // i18n-ignore: codes (a why, a check name), never shown as text
      tests = chosenTests({ ...choice, source: 'picked', picked: approved, added: p.tests })
    }
    // Proof is its review's (finding 1): the test's standing run at the submitted revision (its latest counted run there,
    // not the queue's, its command unchanged: HI-2660, so a later counted failure is never hidden by an earlier pass),
    // passed, and either run by the card's lane reviewer or an agent whose pass approved the submission, or another
    // agent's run (the builder's) that such a pass accepted by its run id (HI-2660, the user's decision, 7 Nov). A
    // builder's own run never counts unaccepted.
    const reviewers = proofReviewers(card.reviewer, s)
    const proved = tests.filter(reviewProved)
    const proofOf = (t: FocusedTest): { run: FactData['CheckRan']; acceptedBy?: string } | undefined => focusedProof(s, o.commands, reviewers, t.id, entry.revision)
    const runOf = (t: FocusedTest): FactData['CheckRan'] | undefined => proofOf(t)?.run
    const missing = proved.filter((t) => !runOf(t))
    if (missing.length) return { kind: 'focused', focused: { why: 'noProof', tests: missing.map((t) => t.id) } } // i18n-ignore: codes (a why, a check name), never shown as text
    if (proved.length) {
      await this.write(card, (w) => {
        for (const t of proved) {
          const p = proofOf(t)!
          if (!w.state().focusedAccepted.some((a) => a.entry === entry.id && a.result === result && a.test === t.id)) w.fact('FocusedAccepted', { entry: entry.id, revision: entry.revision, result, test: t.id, run: p.run.run, ...(p.acceptedBy ? { acceptedBy: p.acceptedBy } : {}) })
        }
      })
    }
    const ids = tests.filter((t) => !reviewProved(t)).map((t) => t.id)
    // Nothing to run here: an explicit "nothing needed", or only tests proved by review.
    if (!ids.length) return { kind: 'green' }
    const dir = join(this.cfg.focused?.dir ?? tmpdir(), `${card.key.replace(/[^\w.-]/g, '_')}-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    const testsFile = join(dir, 'tests.json')
    const resultsFile = join(dir, 'results.json')
    try {
      writeFileSync(testsFile, JSON.stringify(ids))
      const env = { CW_FOCUSED_TESTS: testsFile, CW_FOCUSED_RESULTS: resultsFile, CW_FOCUSED_JOBS: String(Math.max(1, this.cfg.focused?.jobs() ?? 2)) }
      const start = await bracketStart(f)
      const r = await this.cfg.runCheck(FOCUSED_CHECK, run, f, { ...ctx, env, label: `${FOCUSED_CHECK} (${ids.length})` }) // i18n-ignore: a run's title, no words beyond the check's name
      const b = await bracketEnd(f, result, start)
      const raw = await boundedRead(resultsFile, FOCUSED_MAX_RESULTS_BYTES)
      const read = raw === null ? { bad: 'it wrote no results file' } : raw === false ? { bad: `its results file is over ${FOCUSED_MAX_RESULTS_BYTES} bytes` } : readResults(raw, ids) // i18n-ignore: a check's output, agent-facing
      // A runner that didn't exit 0 failed, whatever its results say (finding 6): skips are reported with exit 0.
      const failed = !r.ok || 'bad' in read || read.failed.length > 0
      const data: FactData['CheckRan'] = { name: FOCUSED_CHECK, command: r.command ?? run, revision: result, tested: b.tested, result: failed ? 'failed' : 'passed', run: r.run ?? randomUUID(), durationMs: Math.max(0, Date.now() - start.t0), by: CW_RUNS, counted: b.counted, ...(b.whyNot ? { whyNot: b.whyNot } : {}), entry: entry.id }
      await this.write(card, (w) => w.fact('CheckRan', data))
      r.note?.({ name: FOCUSED_CHECK, counted: b.counted, ...(b.whyNot ? { whyNot: b.whyNot } : {}) })
      if (failed) {
        const why = 'bad' in read ? say(RESULTS_UNREAD, { why: read.bad }) : read.failed.length ? `Failed: ${read.failed.map((x) => x.test).join(', ')}.` : '' // i18n-ignore: a check's output, agent-facing
        return { kind: 'red', transient: !!r.transient, ...(r.cause ? { cause: r.cause } : {}), output: [why, r.output].filter(Boolean).join('\n'), check: FOCUSED_CHECK, ...(r.logPath ? { logPath: r.logPath } : {}) }
      }
      if (!b.counted) return { kind: 'uncounted' }
      if (!('bad' in read) && read.skipped.length) {
        const tree = await this.history(card).treeOf(f, result)
        const bound = { expected, tree: tree ?? `unread:${result}` }
        const decided = this.skipDecided(card, entry, read.skipped, bound)
        if (decided === 'declined') return { kind: 'red', transient: false, output: `Skipped and not accepted: ${read.skipped.map((x) => `${x.test}${x.why ? ` (${x.why})` : ''}`).join(', ')}.`, check: FOCUSED_CHECK } // i18n-ignore: a check's output, agent-facing
        if (decided !== 'approved') return { kind: 'skip', skipped: read.skipped, ...bound }
      }
      return { kind: 'green' }
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Combwork's own temporary folder: left for the system's clean-up
      }
    }
  }

  /**
   * The decision on these skipped tests (G20): its reviewer's or the user's answer to the request bound to this entry,
   * these tests, the target's head it was tested on and the merged result's tree (HR4's round 1 finding 3: a target that
   * moved, or another result, needs a new decision; the tree, not the commit, as a test merge made again has new dates).
   */
  private skipDecided(card: CardRecord, entry: QueueEntry, skipped: FocusedResult[], bound: { expected: string; tree: string }): 'approved' | 'declined' | null {
    const s = this.wf.state(card)
    const tests = skipped.map((x) => x.test).sort().join('\n')
    const asked = Object.values(s.made).filter((r) => r.gate === FOCUSED_SKIP_GATE && r.entry === entry.id && r.revision === bound.expected && r.result === bound.tree && (r.tests ?? []).slice().sort().join('\n') === tests)
    const a = s.approvals.findLast((x) => asked.some((r) => r.request === x.request))
    return a ? (a.answer === 'approved' ? 'approved' : 'declined') : null
  }

  /**
   * Focused tests skipped for their environment (G20; the user's decision, 28 Oct): the entry waits, paused, for the
   * card's reviewer agent to decide (cw_focused_skip), or the user under For you, who can override it. Asked once per
   * entry, tests, target head and merged tree: a request for anything else is replaced by this one (its gate's earlier
   * request of the entry retires). The answer looks at the queue again (`runOnce` lifts the pause once nothing is open).
   */
  private async askSkip(target: string, card: CardRecord, entry: QueueEntry, skipped: FocusedResult[], bound: { expected: string; tree: string }): Promise<QueueOutcome> {
    const out = await this.pause(target, card, entry, 'focusedSkip', skipped.map((x) => x.test))
    if (this.paused(target)?.reason !== 'focusedSkip' || this.paused(target)?.card !== card.key) return out
    const tests = skipped.map((x) => x.test).sort()
    const listed = skipped.map((x) => `${x.test}${x.why ? ` (${x.why})` : ''}`).join(', ')
    await this.write(card, (w) => {
      const same = (r: { gate: string; entry?: string; revision?: string | null; result?: string; tests?: string[] }): boolean => r.gate === FOCUSED_SKIP_GATE && r.entry === entry.id && r.revision === bound.expected && r.result === bound.tree && (r.tests ?? []).slice().sort().join('\n') === tests.join('\n')
      if (w.state().requests.some(same)) return
      const request = this.wf.askUser(w, 'approve', FOCUSED_SKIP_GATE, workflowText(FOR_YOU.focusedSkip, { card: card.key, tests: listed }), { unbound: true, entry: entry.id, revision: bound.expected, result: bound.tree, tests })
      const reviewer = card.reviewer ?? passingReviewers(w.state()).at(-1) ?? null
      if (reviewer) this.wf.wake(w, reviewer, `${card.key}'s focused tests were skipped at its merge for their environment: ${listed}. Decide whether it merges with them skipped (cw_focused_skip with request ${request}: merge true or false, and why); the user can override.`, 'answer') // i18n-ignore: a wake, agent-facing
    })
    return out
  }

  /**
   * Ask each time (OP-40, #1351): "Update <target> in <folder> now", the card's For you Approve, bound to the entry and
   * its test merge; the queue waits for it (paused `approval`, naming the folder). Asked once per test merge.
   */
  private async askAdvance(card: CardRecord, entry: QueueEntry, target: string, expected: string, result: string, folder: string): Promise<QueueOutcome> {
    // The pause first, and only when none is saved (HR4's #1351 round 1: the user's Pause queue meanwhile stands, and
    // nothing is asked under it); then the question.
    const out = await this.pause(target, card, entry, 'approval', [folder])
    if (this.paused(target)?.reason !== 'approval' || this.paused(target)?.card !== card.key) return out
    await this.write(card, (w) => {
      const s = w.state()
      if (s.requests.some((r) => r.gate === QUEUE_ADVANCE_GATE && r.entry === entry.id && r.revision === expected && r.result === result)) return
      this.wf.askUser(w, 'approve', QUEUE_ADVANCE_GATE, workflowText(FOR_YOU.queueAdvance, { card: card.key, target, folder }), { unbound: true, entry: entry.id, revision: expected, result })
    })
    return out
  }

  /**
   * HI-1697: "How should Combwork merge <project>'s cards into <target>?", a Decide on the card in For you; the queue waits
   * for it (paused `mergeChoice`). Asked once: a request of the gate already open on the card stands.
   */
  private async askMerge(card: CardRecord, entry: QueueEntry, target: string): Promise<QueueOutcome> {
    const out = await this.pause(target, card, entry, 'mergeChoice')
    if (this.paused(target)?.reason !== 'mergeChoice' || this.paused(target)?.card !== card.key) return out
    await this.write(card, (w) => {
      if (w.state().requests.some((r) => r.gate === MERGE_CHOICE_GATE)) return
      this.wf.askUser(w, 'decide', MERGE_CHOICE_GATE, workflowText(FOR_YOU.mergeChoice, { project: basename(this.project), target }), { unbound: true, entry: entry.id })
    })
    return out
  }

  /** HI-1697: the project's merge style and commit message still to be chosen: the upgrade's mark, and no choice on the board. */
  private async mergeAsked(): Promise<boolean> {
    return !!(await this.cfg.mergeAsk?.()) && !this.wf.store.meta(MERGE_CHOICE_KEY)
  }

  /** Whether the card's question about its skipped focused tests (G20) is open. */
  private skipAsking(key: string): boolean {
    const card = this.wf.store.cardByKey(key)
    return !!card && this.wf.state(card).requests.some((r) => r.gate === FOCUSED_SKIP_GATE)
  }

  /** Whether the card's question about the merge style and message (HI-1697) is open. */
  private asking(key: string): boolean {
    const card = this.wf.store.cardByKey(key)
    return !!card && this.wf.state(card).requests.some((r) => r.gate === MERGE_CHOICE_GATE)
  }

  /** The merge style and message chosen (HI-1697): the pause lifted, and the question still open on its card closed. */
  private async chosen(target: string, key: string): Promise<boolean> {
    if (!(await this.wf.locked(() => this.wf.store.clearQueuePause(target, 'mergeChoice')))) return false
    const card = this.wf.store.cardByKey(key)
    if (card && this.wf.state(card).requests.some((r) => r.gate === MERGE_CHOICE_GATE)) {
      await this.write(card, (w) => {
        for (const r of w.state().requests.filter((x) => x.gate === MERGE_CHOICE_GATE)) w.fact('RequestClosed', { request: r.request, why: 'done' }) // i18n-ignore: a fact's kind and codes, not text
      })
    }
    return true
  }

  /** The lease, checked just before git touches the target: a runner that lost it touches nothing. */
  private stillHolds(target: string): void {
    if (this.cfg.holds && !this.cfg.holds()) throw new LeaseLost(target)
  }

  /** The target checked out nowhere: one compare-and-swap (`update-ref <target> <result> <expected>`). */
  private async advanceRef(card: CardRecord, entry: QueueEntry, target: string, expected: string, result: string): Promise<Advance> {
    const lock = this.cfg.lock ?? (<T,>(fn: () => Promise<T>) => fn())
    // Under the repository's lock (#1347): the target still checked out nowhere (the user or another Combwork may have
    // checked it out while the queue waited: a swap then would leave that folder's files behind), `IntegrationStarted`
    // (its write checks the lease, the fence, and the rules) and the ref's compare-and-swap, the lease checked once more
    // just before the swap.
    const I = this.integration(card, this.wf.state(card))
    const h = this.host({})
    const r = await lock(async (): Promise<Advance> => {
      const where = await I.checkouts(h)
      // HI-2019: nothing touched yet, nothing written: out of the lock, and the entry goes round again.
      if (isUnknown(where)) return again(gitSaid(where))
      if (where[target]) return 'retest'
      const started = await this.startAdvance(card, entry, { entry: entry.id, expected, result, checkedOut: null })
      if (started === 'rulesOff') return this.settle(card, entry, target, { pause: 'rulesOff' })
      if (started === 'denied' || started === 'held' || started === 'waiting' || started === 'ask' || started === 'proofGone') return started === 'ask' || started === 'proofGone' ? 'retest' : started
      await this.cfg.hooks?.afterStarted?.(entry.id)
      if (this.cfg.holds && !this.cfg.holds()) throw new LeaseLost(target)
      if (await I.swap(h, target, expected, result)) return 'done'
      await this.moved(card, entry, target)
      return 'moved'
    })
    if (r === 'done') await this.cfg.hooks?.afterAdvance?.(entry.id)
    return r
  }

  /**
   * What an advance came to, settled before the repository lock is released (HR4's #1351 round 1): a pause Combwork writes
   * for what it saw there (a condition, the rules, the terminal state) is written in the lock, so no other run, this
   * Combwork's or another's, acts on the target between the finding and the pause; a residue is merged, then paused.
   */
  private async settle(card: CardRecord, entry: QueueEntry, target: string, adv: Advance, integrate?: () => Promise<void>): Promise<Advance> {
    // `again` is never settled into a pause (HI-2019): it leaves the lock for the entry to go round.
    if (typeof adv !== 'object' || 'outcome' in adv || isAgain(adv)) return adv
    if ('residue' in adv) {
      await integrate?.()
      return { outcome: await this.pause(target, card, entry, 'needsYou', undefined, undefined, adv.residue) }
    }
    // A pause on a condition after the entry was failed and queued again (an edit since the check): that entry's.
    const at = adv.stuck ? entry : (openEntry(this.wf.state(card)) ?? entry)
    return { outcome: await this.pause(target, card, at, adv.pause, adv.files, adv.message, adv.stuck, adv.folder) }
  }

  /** The swap found the target moved: this entry failed (transient) and the card is queued again, to be tested again. */
  private async moved(card: CardRecord, entry: QueueEntry, target: string, reason: IntegrationFailReason = 'targetMoved'): Promise<void> {
    await this.write(card, (w) => {
      // Cancelled meanwhile: not queued again (the queue's next look skips it as cancelled).
      if (!this.isOpen(w, entry)) return
      w.fact('IntegrationFailed', { entry: entry.id, revision: entry.revision, target, reason, transient: true }) // i18n-ignore: a fact's kind and codes, not text
      const s = w.state()
      w.fact('IntegrationRequested', { entry: `${card.key}/e${s.lastSeq + 1}`, revision: entry.revision, key: s.latest?.key ?? null, target, style: w.ruleset!.options.style })
    })
  }

  /** Appends a journal phase of a begun advance (§16.9.2): written, and committed, before its step runs. */
  private async phase(card: CardRecord, entry: QueueEntry, phase: FactData['IntegrationPhase']['phase']): Promise<void> {
    await this.write(card, (w) => w.fact('IntegrationPhase', { entry: entry.id, phase }))
  }

  /** The repository lock and the folder's fence around `fn` (#1347, #646), as the config gives them. */
  private guarded<T>(folder: string, fn: () => Promise<T>): Promise<T> {
    const lock = this.cfg.lock ?? (<U,>(f: () => Promise<U>) => f())
    const fence = this.cfg.fence ?? (<U,>(_folder: string, f: () => Promise<U>) => f())
    return lock(() => fence(folder, fn))
  }

  /**
   * The target checked out in a folder (§16.9.2). Under the repository lock and that folder's fence (nothing of Combwork's is
   * typed into it meanwhile), where it is checked out is read again and the conditions checked before anything is
   * touched, each failed one a pause naming its files; then the journal: `IntegrationStarted` (the listed files), phase
   * files and `read-tree -m -u <expected> <result>`, phase ref and `update-ref <target> <result> <expected>`, and, once
   * HEAD is seen to still name the target, `Integrated` (the caller's). A swap that finds the ref moved rolls the files
   * back (phase rollback). Each phase's fact checks the lease in its write, and the lease is checked again just before
   * git runs: a runner that lost its lease writes nothing more and touches nothing.
   */
  private async advanceCheckedOut(card: CardRecord, entry: QueueEntry, target: string, expected: string, result: string, seen: string, integrate: () => Promise<void>): Promise<Advance> {
    const I = this.integration(card, this.wf.state(card))
    const r = await this.guarded(seen, async (): Promise<Advance> => {
      // Where the target is checked out now, under the lock: switched meanwhile, looked at again the right way.
      const now = await I.checkouts(this.host({}))
      // HI-2019: a read before anything is touched (and before IntegrationStarted) is never settled into a pause here: it
      // leaves the lock and the fence as `again`, for the entry to go round once admitted afresh.
      if (isUnknown(now)) return again(gitSaid(now))
      if (!now[target] || resolve(now[target]).toLowerCase() !== seen.toLowerCase()) return 'retest'
      const j = await this.journal(card, entry, target, expected, result, seen)
      // HI-2944: a pause on the folder's own changes names the folder they are in (Commit and Set aside act there only).
      const named = typeof j === 'object' && 'pause' in j && FOLDER_PAUSES.has(j.pause) ? { ...j, folder: seen } : j
      return isAgain(named) ? named : this.settle(card, entry, target, named, integrate)
    })
    if (r === 'done') await this.cfg.hooks?.afterAdvance?.(entry.id)
    return r
  }

  private async journal(card: CardRecord, entry: QueueEntry, target: string, expected: string, result: string, folder: string): Promise<Advance> {
    const I = this.integration(card, this.wf.state(card))
    const h = this.host({})
    // Conditions, before anything is touched: no agent builds there (an idle one, or one reviewing in a review copy,
    // doesn't count); HEAD names the target, at the expected revision; nothing staged; no unstaged or untracked change in
    // a file the merge changes (the user's other edits are left as they are).
    const busy = this.cfg.folderBusy?.(folder)
    if (busy) return { pause: 'folderBusy', files: busy.length ? busy : [folder] }
    // Then the platform's (the port's `conditions`, before anything is touched): the folder on the target at the expected
    // revision, nothing staged, no change in a file the merge changes. HI-2019: until IntegrationStarted below, a read
    // the platform couldn't make is `again` (nothing touched, nothing written).
    const cond = await I.conditions(h, folder, target, expected, result)
    if (isAgain(cond) || cond === 'retest' || 'pause' in cond) return cond
    const { files } = cond

    const started = await this.startAdvance(card, entry, { entry: entry.id, expected, result, files, checkedOut: folder })
    if (started === 'rulesOff') return { pause: 'rulesOff' }
    // Ask each time, as the setting is now: asked here, before the lock is released.
    if (started === 'ask') return { outcome: await this.askAdvance(card, entry, target, expected, result, folder) }
    if (started === 'proofGone') return 'retest'
    if (started === 'denied' || started === 'held' || started === 'waiting') return started
    await this.cfg.hooks?.afterStarted?.(entry.id)

    // 1. The files: index and the listed files to the result. git refuses, writing nothing, rather than overwrite a file
    // changed since the check.
    await this.phase(card, entry, 'files')
    await this.cfg.hooks?.beforeFiles?.(entry.id)
    this.stillHolds(target)
    const rt = await I.moveFiles(h, folder, expected, result)
    if (!rt.ok) {
      const sides = await I.sides(h, folder, files, expected, result)
      // Nothing written (every listed file still at the expected revision in the index): back to the test merge, and a
      // file the user edited since the check pauses, named. Anything else is the terminal state.
      if (sides && sides.every((f) => f.side === 'expected' || (f.side === 'other' && f.staged === 'expected'))) {
        const now = await I.edited(h, folder, files)
        await this.moved(card, entry, target)
        return Array.isArray(now) && now.length ? { pause: 'unstagedChanges', files: now } : 'moved'
      }
      return { pause: 'needsYou', message: rt.err, stuck: await I.stuck(h, target, folder, expected, result, files, 'files') }
    }
    await this.cfg.hooks?.afterFiles?.(entry.id)

    // 2. The ref: a compare-and-swap; the ref moved meanwhile, the files rolled back.
    await this.phase(card, entry, 'ref')
    await this.cfg.hooks?.beforeRef?.(entry.id)
    this.stillHolds(target)
    if (!(await I.swap(h, target, expected, result))) return this.rollback(card, entry, target, expected, result, folder, files)

    // HEAD no longer names the target (another client switched the folder in that instant: §16.9.2's "does not
    // guarantee"): merged, with the merged files in the other branch's working copy, listed to restore.
    // HI-2019: only a branch git couldn't read is read again (the advance is never redone), still in the lock and the
    // fence, the lease checked again before what follows is acted on.
    let after = await I.folderLine(folder)
    for (let i = 0; isUnknown(after) && i < CONFIRM_TRIES; i++) {
      await wait(CONFIRM_RETRY_MS)
      after = await I.folderLine(folder)
    }
    this.stillHolds(target)
    if (isUnknown(after) || after !== target) return { residue: await I.stuck(h, target, folder, expected, result, files, 'done') }
    return 'done'
  }

  /** The swap found the ref moved: the files rolled back (phase rollback), and the entry tested again; refused, terminal. */
  private async rollback(card: CardRecord, entry: QueueEntry, target: string, expected: string, result: string, folder: string, files: string[]): Promise<Advance> {
    const I = this.integration(card, this.wf.state(card))
    const h = this.host({})
    await this.phase(card, entry, 'rollback')
    await this.cfg.hooks?.inRollback?.(entry.id)
    this.stillHolds(target)
    const back = await I.moveFiles(h, folder, result, expected)
    if (!back.ok) return { pause: 'needsYou', message: back.err, stuck: await I.stuck(h, target, folder, expected, result, files, 'rollback') }
    await this.cfg.hooks?.afterRollback?.(entry.id)
    await this.moved(card, entry, target)
    return 'moved'
  }

  /**
   * `Integrated` → Done; the slot released, the lane ended if done; a decision recorded after the advance began → For you.
   * HI-2709: the blocker rule's choke point (wf.closeWaitsFor, read in this write) for every caller: `waiting`, nothing
   * written, while a card it depends on isn't Done. Only the record of the queue's own advance (`afterAdvance`) is
   * written whatever: the target has moved, its blockers decided in IntegrationStarted's write.
   */
  private async integrated(card: CardRecord, entry: QueueEntry, revision: string, target: string, result: string, method: 'merge' | 'squash' | 'fastForward', by: 'combwork' | 'outside', opts: { afterAdvance?: boolean; published?: { from: string }; catchUp?: { from: string } } = {}): Promise<'written' | 'waiting' | 'already'> {
    return this.write(card, (w) => {
      // One Integrated per cycle, whoever writes it (the queue, or another Combwork's recovery or observation).
      const st = w.state()
      if (st.integrated) return 'already' as const
      if (this.wf.closeWaitsFor(w, opts).length) return 'waiting' as const
      const startedAt = this.wf.store.facts(card.id).filter((f) => f.kind === 'IntegrationStarted' && (f.data as FactData['IntegrationStarted']).entry === entry.id).at(-1)?.seq ?? Infinity
      const f = w.tx.append(card.id, { kind: 'Integrated', actor: 'combwork', source: 'recorded', dedupe: `cycle:${st.cycle}`, ...(w.ruleset ? { ruleset: w.ruleset.id } : {}), data: { entry: entry.id, revision, target, result, method, by } }) // i18n-ignore: a fact's kind and codes, not text
      w.written.push(f)
      w.move('done', 'derived')
      // G21 (HI-1183): published to the remote, so pushed already (the push log says so) and the local catch-up owed.
      if (by === 'combwork' && opts.published) this.oweCatchUp(w, entry.id, target, opts.published.from, result, true)
      else if (by === 'combwork') this.owePush(w, entry.id, target, result)
      // Found published by someone else (follow mode): the local target's catch-up owed, no push of Combwork's logged.
      else if (opts.catchUp && opts.catchUp.from !== result) this.oweCatchUp(w, entry.id, target, opts.catchUp.from, result, false)
      if (this.wf.store.facts(card.id).some((x) => x.kind === 'Decision' && x.seq > startedAt)) this.wf.askUser(w, 'decide', 'decision', workflowText(FOR_YOU.decidedAfterMerge, { card: card.key }))
      return 'written' as const
    })
  }

  /** A conflict, red checks or a hook: `IntegrationFailed`, the card back to its builder with the output (§16.9.1 step 8). */
  private async returnCard(card: CardRecord, entry: QueueEntry, revision: string, target: string, reason: FactData['IntegrationFailed']['reason'], transient: boolean, files?: string[], log?: string, cause?: TransientFailure, check?: { check: string; logPath?: string }, conflicts?: ConflictsRecord, focused?: FocusedReturn): Promise<QueueOutcome> {
    // Removed from the queue (or cancelled by a decision) while its test merge or checks ran: its cancellation stands,
    // the card where that left it (Approved), and the late failure isn't written.
    const wrote = await this.write(card, (w) => {
      if (!this.isOpen(w, entry)) return false
      // Why a transient failure was one, as codes (#1362): its cause, and the network error code that said so.
      const why = transient && cause ? { cause: cause.cause, ...(cause.code ? { code: cause.code } : {}) } : {}
      const failed: FactData['IntegrationFailed'] = { entry: entry.id, revision, target, reason, transient, ...why, ...(files ? { files } : {}), ...(log ? { log: keptLog(log) } : {}), ...check, ...(conflicts?.files.length ? { conflicts } : {}), ...(focused ? { focused } : {}) }
      w.fact('IntegrationFailed', failed)
      w.move('active', 'derived')
      // What came back and what to do next (#1354): the files, the check, its log and last lines, bounded. A forward
      // merge (HI-2679) has no builder: its card says it, for the user or the Assistant to Retry merge or Remove.
      // HI-2998: a forward's resolution says so, for what its builder does next.
      const about = returnedAbout(w.state())
      if (!w.state().forward) this.wf.wake(w, w.state().started?.builder, returnedWake(card.key, failed, about))
      // HI-2087: and on the card, for whoever reads it (its latest comment was the review's pass).
      w.action('comment', { ...returnedComment(card.key, failed, about) })
      return true
    })
    if (!wrote) return { card: card.key, entry: entry.id, outcome: 'skipped', why: 'cancelled' } // i18n-ignore: a reason's key, not text
    return { card: card.key, entry: entry.id, outcome: 'returned', reason, transient }
  }

  /**
   * After a restart (§16.4.5): an entry with `IntegrationStarted` and no outcome is reconciled from the platform, never
   * assumed. Target not checked out: the ref at the result → `Integrated` (observed); at the expected revision → runs
   * again from the test merge; anywhere else → failed (target moved) and containment decides. Checked out: §16.9.2's
   * recovery table, whose last row pauses the queue for that target ("needs you").
   */
  /**
   * Recovers a target's entries (#1348: each target's host its own; every target's when none is given, the tests'). A
   * runner that lost its lease meanwhile stops, its recovery the next runner's.
   */
  async recover(target?: string): Promise<{ card: string; entry: string; outcome: 'integrated' | 'rerun' | 'failed' | 'needsYou' }[]> {
    return this.fenced(target ?? '', () => this.recoverAll(target)).catch((e) => lostIsNull(e) ?? [])
  }

  private async recoverAll(target?: string): Promise<{ card: string; entry: string; outcome: 'integrated' | 'rerun' | 'failed' | 'needsYou' }[]> {
    const out: { card: string; entry: string; outcome: 'integrated' | 'rerun' | 'failed' | 'needsYou' }[] = []
    for (const card of this.wf.store.cards()) {
      const s = this.wf.state(card)
      const e = openEntry(s)
      if (!e || e.state !== 'started' || !e.started || (target !== undefined && e.target !== target)) continue
      // G21 (HI-1183): a begun publication is settled by its queue's next look (settlePublications), never by this table.
      if (e.started.publish) continue
      const { expected, result, checkedOut } = e.started
      const I = this.integration(card, s)
      const h = this.host({})
      const done = async () => {
        await this.write(card, (w) => {
          // A begun advance recovered (HI-2709: a record after an advance, closeWaitsFor's `afterAdvance`: its blockers were
          // decided in its IntegrationStarted's write, so it is written whatever).
          // How it landed, as an advance records it, by the style its entry was queued with (HR2's #1184 round 1).
          const requested = this.wf.store.facts(card.id).find((x) => x.kind === 'IntegrationRequested' && (x.data as FactData['IntegrationRequested']).entry === e.id)?.data as FactData['IntegrationRequested'] | undefined
          const method = methodOf(requested?.style ?? this.wf.rulesetOf(card, s).options.style, s.started?.target, e.target)
          const f = w.tx.appendObserved(card.id, { kind: 'Integrated', actor: 'outside', source: 'observed', dedupe: `cycle:${s.cycle}`, data: { entry: e.id, revision: e.revision, target: e.target, result, method, by: 'combwork' } }) // i18n-ignore: a fact's kind and codes, not text
          if (!f) return
          // Its finish reads what this write recorded (HI-2014): the merge, verified.
          w.written.push(f as Fact)
          w.move('done', 'derived')
          // Combwork's own merge, found done after a restart: its push owed as an advance's is (G18).
          this.owePush(w, e.id, e.target, result)
        })
      }
      // The target frozen (HR4's #1351 round 1): a needs-you pause naming a card is the terminal state, or an advance Combwork
      // won't guess about. Read in the lock, before anything else, whatever started this run (another card's enqueue, a
      // reopen, another Combwork): recovery writes nothing and touches nothing until the user lifts it (Resume, or the
      // answer to its For you, which check first). Other pauses still let a begun advance finish or roll back.
      const frozen = (): boolean => {
        const p = this.paused(e.target)
        return p?.reason === 'needsYou' && !!p.card
      }
      if (!checkedOut) {
        const lock = this.cfg.lock ?? (<T,>(fn: () => Promise<T>) => fn())
        const outcome = await lock(async (): Promise<'integrated' | 'rerun' | 'failed' | 'needsYou'> => {
          if (frozen()) return 'needsYou'
          const ref = await I.targetHead(this.project, e.target)
          if (ref === result) {
            await done()
            return 'integrated'
          }
          if (ref === expected) {
            this.rerun.add(e.id)
            return 'rerun'
          }
          // The target moved meanwhile: containment decides. Found → Done (observed); not found → tested again.
          await this.write(card, (w) => w.fact('IntegrationFailed', { entry: e.id, revision: e.revision, target: e.target, reason: 'targetMoved', transient: true })) // i18n-ignore: a fact's kind and codes, not text
          await reconcile(this.wf, card)
          if (this.wf.state(card).stage === 'merging') {
            await this.write(card, (w) => {
              const st = w.state()
              w.fact('IntegrationRequested', { entry: `${card.key}/e${st.lastSeq + 1}`, revision: e.revision, key: st.latest?.key ?? null, target: e.target, style: w.ruleset!.options.style })
            })
          }
          return 'failed'
        })
        out.push({ card: card.key, entry: e.id, outcome })
        continue
      }
      // Checked out (§16.9.2's table): read and acted on under the repository lock and the folder's fence, so neither
      // Combwork's other work nor the Git view acts in the folder in between.
      const outcome = await this.guarded(checkedOut, async (): Promise<'integrated' | 'rerun' | 'failed' | 'needsYou'> => {
        if (frozen()) return 'needsYou'
        const f = await I.recoveryState(h, begun(e))
        const stuck = async (st: QueueStuck, merged = false): Promise<'integrated' | 'needsYou'> => {
          if (merged) await done()
          await this.pause(e.target, card, e, 'needsYou', undefined, undefined, st)
          return merged ? 'integrated' : 'needsYou'
        }
        if (f.found === 'integrated') {
          await done()
          return 'integrated'
        }
        if (f.found === 'residue') return stuck(f.stuck!, true)
        if (f.found === 'rerun') {
          this.rerun.add(e.id)
          return 'rerun'
        }
        if (f.found === 'requeue') {
          await this.moved(card, e, e.target)
          return 'failed'
        }
        if (f.found === 'rollback') {
          const r = await this.rollback(card, e, e.target, expected, result, checkedOut, e.started!.files ?? [])
          return r === 'moved' ? 'failed' : stuck((r as { stuck: QueueStuck }).stuck)
        }
        if (f.found === 'swap') {
          // The journaled commit, never a new merge: hooks or time can't make it differ.
          if (e.phases.at(-1) !== 'ref') await this.phase(card, e, 'ref')
          this.stillHolds(e.target)
          if (!(await I.swap(h, e.target, expected, result))) {
            const r = await this.rollback(card, e, e.target, expected, result, checkedOut, e.started!.files ?? [])
            return r === 'moved' ? 'failed' : stuck((r as { stuck: QueueStuck }).stuck)
          }
          const after = await I.folderLine(checkedOut)
          if (isUnknown(after) || after !== e.target) return stuck(await I.stuck(h, e.target, checkedOut, expected, result, e.started!.files ?? [], 'done'), true)
          await done()
          return 'integrated'
        }
        return stuck(f.stuck!)
      })
      out.push({ card: card.key, entry: e.id, outcome })
    }
    return out
  }

  /**
   * Resume of a needs-you pause (#1353, §16.9.3): whether the target's begun advance is still in §16.9.2's terminal state,
   * as recovery would find it now (the files it names, or [] for none), or null when recovery can carry on. Reads only.
   */
  async stillStuck(target: string): Promise<string[] | null> {
    for (const card of this.wf.store.cards()) {
      const e = openEntry(this.wf.state(card))
      if (!e || e.state !== 'started' || !e.started || e.target !== target || !e.started.checkedOut || e.started.publish) continue
      const f = await this.integration(card, this.wf.state(card)).recoveryState(this.host({}), begun(e))
      return f.found === 'stuck' || f.found === 'residue' ? (f.stuck?.files.map((x) => x.path) ?? []) : null
    }
    // G21 (HI-1183): a published merge's catch-up stopped part way is the same terminal state.
    return this.catchUpStuck(target)
  }
}
