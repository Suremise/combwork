// The merge queue (SPEC §16.9): Hive performs merges, one entry at a time per target. An entry's way through: check it
// is still approved and not already in the target; test-merge it in the queue's own worktree; run the merge checks on
// exactly that result (installing clean when the manifests changed); then advance the target only on green, after
// writing `IntegrationStarted`, by compare-and-swap (not checked out) or the journaled read-tree/update-ref protocol
// (checked out). A target that moved since the test is tested again; it never advances an untested target.
//
// P2 spike (#1118): the core of the queue over the spike's runtime. The repository lock across processes, hooks and
// signing pauses are P5's. The merge checks (#1349) run as Hive's own runs (queueChecks.ts), each bracketed here: green
// only when it exited 0 and its `CheckRan` counted for exactly the test merge's revision.

import { spawn, type ChildProcess } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'original-fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { git, GIT_PREFIX } from '../git'
import { onOutputSettled, withLauncherEnv } from '../gitWorker'
import { gitExe } from '../gitTool'
import { endTree } from '../progressReporters/wrapper'
import { FOCUSED_SKIP_GATE, MERGE_CHOICE_GATE, MERGE_CHOICE_KEY, openEntry, passingReviewers, QUEUE_ADVANCE_GATE, QUEUE_STUCK_GATE, type CardState, type Fact, type FactData, type FocusedReturn, type QueueEntry } from '../../shared/workflow/facts'
import { changedSince, changePaths, choiceStands, chosenTests, FOCUSED_CHECK, FOCUSED_MAX_RESULTS_BYTES, focusedCheckName, readResults, reviewProved, type FocusedResult, type FocusedTest } from '../../shared/workflow/focused'
import { FOCUSED_PICK, FOCUSED_RUN } from '../../shared/workflow/options'
import { boundedRead, pathChanges, runPick } from './focusedRun'
import { pushesSettled, pushLogKey, pushLogOf, pushPendingKey, pushPendingOf, type PushPending, type PushSettled } from './queueLogs'
import type { TransientFailure } from '../../shared/types'
import { notApproved } from '../../shared/workflow/guards'
import { hasStage } from '../../shared/workflow/compile'
import type { CommitMessage } from '../../shared/workflow/options'
import { FOR_YOU, workflowText } from '../../shared/workflow/texts'
import * as G from '../platform/git'
import { isUnknown, type Maybe, type Unknown } from '../platform/types'
import { withWriteFence, type CardRecord } from './factStore'
import { endedBy, LeaseLost } from './queueRunner'
import { reconcile } from './reconcile'
import { leftWake, returnedComment, returnedWake } from './queueState'
import { readConflicts } from './conflictRead'
import { mergeMessage, updateMessage } from './mergeMessage'

/**
 * The conflicted files `diff --name-only -z` lists, as they are named (HR4's HI-1181 round 1): split on NUL, never on
 * lines, as git C-quotes a name with other than ASCII (café.txt) in its line form, and the reader would look for that.
 */
const namesOf = (out: string | undefined): string[] => (out ?? '').split('\0').filter(Boolean)
import type { ConflictsRecord } from '../../shared/workflow/conflicts'
import { bracketEnd, bracketStart } from './queueChecks'
import { HIVE_RUNS } from '../progress'
import type { Workflow, Write } from './runtime'
import type { RunCheck } from '../../shared/types'
import { shellLine, type QueueCommand, type QueueFileSide, type QueueStep, type QueueStuck } from '../../shared/workflow/queue'

export interface CheckResult {
  ok: boolean
  /** The failure was the environment (a check that didn't start, a network error, a timeout), not a result. */
  transient?: boolean
  /** Why it was (#1362): recorded on the card's IntegrationFailed. */
  cause?: TransientFailure
  output: string
  /** Its log's path, when the log holds its output (#1354: a returned card's wake names it). */
  logPath?: string
  /** The command that ran, and its run's id (a progress run's, when Hive keeps runs). */
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
   * Variables Hive gives this check itself, past `checkEnv` (which takes every HIVE_* out of the base): G20's runner
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
  /** The files whose change since the last install means a clean install (#187). */
  manifests?: string[]
  /**
   * G20 (HI-1367): how the queue picks a card's focused tests at the result (a check's environment, its time limit),
   * the jobs its runner is given, and where the tests and results files go (Hive's own folder, never the queue's).
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
   * Hive's is typed into that folder and no agent starts there until it settles. Left out, as it is.
   */
  fence?: <T>(folder: string, fn: () => Promise<T>) => Promise<T>
  /**
   * Merge into a checked-out branch (Advanced `hive.queue.checkedOutTarget`, OP-40, read at each use): `ask`, an entry
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
   * QueueRunner.git: its processes in the lease's job, recorded before they run); left out, Hive's own git().
   */
  git?: (cwd: string, args: string[], opts?: QueueGitOptions) => Promise<QueueGitResult>
  /**
   * The longest Hive's merge commit runs when the repository signs its commits (#1350, Advanced
   * `hive.queue.signSeconds`): a signer still waiting then (for a passphrase) is ended and the entry pauses. 60 s left out.
   */
  signTimeoutMs?: number
  /**
   * Runs the advance under the repository's lock across processes (#1347, withRepoLock), its `IntegrationStarted` and
   * the ref's compare-and-swap together; left out, as it is.
   */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>
  /**
   * Whether workflow rules are enforced now (Settings → Advanced, `hive.workflow.enforce`, read at each use): off, an
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
}

export type QueueHook = 'afterTest' | 'afterChecks' | 'afterStarted' | 'beforeFiles' | 'afterFiles' | 'beforeRef' | 'afterAdvance' | 'inRollback' | 'afterRollback' | 'beforeRetry'
export type QueueHooks = Partial<Record<QueueHook, (entry: string) => void | Promise<void>>>

/** How the queue runs a git command that may run the repository's hooks or sign (#1350): its environment and bound. */
export interface QueueGitOptions {
  env?: NodeJS.ProcessEnv
  /** Ends the command's whole tree (git, its hooks, its signer) once it has run this long. */
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
  /** HI-2020: git never started (Node's code for why): nothing ran, so nothing to classify; the entry goes round again. */
  notRun?: string
  /**
   * HI-2042: git was ended by a signal (its name), code -1: what it did is unknown, so nothing to classify (no conflict,
   * no hook); put back, and the entry goes round again, as for notRun.
   */
  signal?: string
}

export type QueueOutcome =
  | { card: string; entry: string; outcome: 'integrated'; result: string; retests: number }
  | { card: string; entry: string; outcome: 'returned'; reason: FactData['IntegrationFailed']['reason']; transient: boolean }
  | { card: string; entry: string; outcome: 'paused'; reason: PauseReason; files?: string[]; message?: string }
  | { card: string; entry: string; outcome: 'skipped'; why: 'notApproved' | 'cancelled' | 'declined' }
  | { card: string; entry: string; outcome: 'integratedOutside' }

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
 * why). `signingWaits`: signing Hive's commit waited for a passphrase (or a pinentry) and was ended; `signing`: it failed
 * (git's message in the pause). `hookTimedOut`: a hook of a signed commit was still running at the signing bound.
 * `identity`: no commit identity for the repository (its folder in the pause). `user`: Pause queue (the user's, or the
 * Assistant's within Control: #1353). `approval`: an entry ready to advance into a checked-out target waits for the
 * user's Approve (Ask each time, #1351). `checkedOut`: a pause from before #1351, which Hive no longer makes.
 * `pushRejected`, `pushFailed`, `pushNoRemote` (G18, #1179): the push of the target after a merge was refused (the
 * remote has commits it lacks), failed (git's message: a sign-in, the network, the bound), or had no remote to go to;
 * `pushUnreadable`: owed, and the target (or whether it still has the merge) couldn't be read to settle it.
 * `mergeChoice` (HI-1697): an upgraded project's merge style and commit message wait for the user's answer in For you.
 */
export type PauseReason = 'user' | 'targetMovesFast' | 'folderBusy' | 'wrongBranch' | 'staged' | 'unstagedChanges' | 'identity' | 'needsYou' | 'uncounted' | 'checkedOut' | 'rulesOff' | 'signingWaits' | 'signing' | 'hookTimedOut' | 'approval' | 'subfolderTarget' | 'pushRejected' | 'pushFailed' | 'pushNoRemote' | 'pushUnreadable' | 'mergeChoice' | 'focusedSkip'

/**
 * G18 (#1179): the push of a target Hive owes after merging into it, as store meta per target: the merge's result, its
 * card and entry. Written in the same transaction as the merge's `Integrated` (the card Done and the push owed, or
 * neither); cleared only for the result that was pushed (compare-and-clear), never a newer one.
 */
interface PushOwed {
  result: string
  card: string
  entry: string
}

export const pushOwedKey = (target: string): string => `queue.pushOwed:${target}`

/** The push Hive owes for a target, if any (an unreadable value counts as none). */
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
 * How an entry of a merge style lands, as its `Integrated` says (an advance, or recovery after a restart): Rebase and
 * fast-forward moves the target forward (#1184); a squash into the card's own target is a squash; else a merge commit.
 */
function methodOf(style: FactData['IntegrationRequested']['style'], cardTarget: string | null | undefined, target: string): 'merge' | 'squash' | 'fastForward' {
  if (style === 'rebase') return 'fastForward'
  return cardTarget === target && style === 'squash' ? 'squash' : 'merge'
}

/** A push reaches the remote and can wait on a sign-in window: as the Git view's, long but never forever. */
const PUSH_MS = 5 * 60_000

/** A push never waits on a prompt nobody sees: no terminal prompt, no askpass, a credential manager kept non-interactive. */
function pushEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never' }
}

/** git's words when a remote refuses a push that isn't a fast-forward (the Git view's test). */
const PUSH_REJECTED = /\[rejected\]|non-fast-forward|fetch first/i

/** What an entry's steps read of the repository's config once (#1386): the identity Hive commits as, and signing. */
/** What a pass of an entry reads once (HI-2019: made afresh for each pass, so a pass that goes round again reads again). */
interface EntryReads {
  identity?: Promise<Maybe<{ name: string; email: string } | null>>
  signs?: Promise<boolean | Again>
}

/** What an advance came to (advanceRef, advanceCheckedOut); `again` only before anything was touched. */
type Advance = 'done' | 'moved' | 'denied' | 'held' | 'retest' | Again | { pause: PauseReason; files?: string[]; message?: string; stuck?: QueueStuck } | { residue: QueueStuck } | { outcome: QueueOutcome }

/** The state a checked-out target's begun advance is found in (§16.9.2's recovery table), and what it calls for. */
type Found = 'integrated' | 'residue' | 'rerun' | 'swap' | 'rollback' | 'requeue' | 'stuck'

/** git's status in porcelain v1 with -z: the paths with a change in the working copy or index, both sides of a rename. */
function statusPaths(out: string): string[] {
  const t = out.split('\0')
  const paths: string[] = []
  for (let i = 0; i < t.length; i++) {
    if (t[i].length < 4) continue
    paths.push(t[i].slice(3))
    // A rename or copy: its source follows as a token of its own.
    if (t[i][0] === 'R' || t[i][0] === 'C') paths.push(t[++i] ?? '')
  }
  return paths.filter(Boolean)
}

const nulList = (out: string): string[] => out.split('\0').filter(Boolean)

/** Whether the user approved advancing this entry's test merge (`expected` → `result`) into its checked-out target. */
function advanceApprovedIn(s: CardState, entry: string, expected: string, result: string): boolean {
  return s.approvals.some((a) => {
    const r = s.made[a.request]
    return a.answer === 'approved' && r?.gate === QUEUE_ADVANCE_GATE && r.entry === entry && r.revision === expected && r.result === result
  })
}

/** The longest a signed merge commit runs when the config gives none (Advanced `hive.queue.signSeconds`'s default). */
const SIGN_TIMEOUT_MS = 60_000

/**
 * A signer's messages that say it would wait for someone (a passphrase, a pinentry, a terminal): read only once git's
 * trace says the signer is what failed, never to tell a signer from a hook.
 */
const SIGN_WAITS = /passphrase|pinentry|inappropriate ioctl|cannot open \/dev\/tty|no tty|tty.*not available/i

/** git's own line when a pre-merge-commit or commit-msg hook stopped a merge commit (used only with no trace to read). */
const MERGE_HOOK_STOPPED = /^Not committing merge;/m

/** A child git ran for a commit, as its trace names it, with the text it wrote: a hook, the signer, or another (git's own). */
export interface CommitChild {
  kind: 'hook' | 'signer' | 'other'
  /** A hook's name (`commit-msg`). */
  name?: string
  /** Its exit code; none while it ran (the stream ended, or was cut, first). */
  code?: number
  text: string
  /**
   * git's own text once it had exited, until the next child starts (HI-2399): where a newer git (Git for Windows 2.56) reprints the signer's
   * text, which it captured (`error: gpg failed to sign the data:` and gpg's lines; ssh-keygen's as `error: …`).
   */
  after: string
}

/**
 * A commit's stderr read with git's own trace in it (#1350: `GIT_TRACE2_EVENT=2`, trace2's events on git's stderr, in
 * the order things happened): each piece of text given to the source that wrote it. A child's text comes after its
 * `child_start` and before its `child_exit` (a hook writes before it exits; git writes `child_exit` once it has waited
 * for it); text while no child of the top git runs is git's own. `traced`: the top git's events were there (an old
 * git writes none). `open`: the child running where the stream ends.
 */
export interface CommitStream {
  traced: boolean
  children: CommitChild[]
  open: CommitChild | null
  git: string
  /** All the text, every source's, in order, without the events: what a message shows. */
  text: string
}

/** A trace2 event: a complete JSON record with the fields its kind needs; anything else is text, whatever it looks like. */
type TraceEvent = { event: string; sid: string; child_id?: number; child_class?: string; hook_name?: string; argv?: string[]; code?: number }

function traceEvent(s: string): TraceEvent | null {
  let v: unknown
  try {
    v = JSON.parse(s)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const e = v as Record<string, unknown>
  if (typeof e.event !== 'string' || typeof e.sid !== 'string' || typeof e.time !== 'string') return null
  if (e.event === 'child_start' && (typeof e.child_id !== 'number' || !Array.isArray(e.argv) || !e.argv.every((a) => typeof a === 'string'))) return null
  if (e.event === 'child_exit' && (typeof e.child_id !== 'number' || typeof e.code !== 'number')) return null
  return e as TraceEvent
}

/**
 * A line split into its text and the trace event ending it: an event begins at a `{"event":"` and runs to the line's
 * end, so text with no newline before it (a hook's last line) stays text. The first place a valid record starts wins;
 * an event-looking fragment that isn't one is text.
 */
function splitTraceLine(line: string): { text: string; ev: TraceEvent | null } {
  const body = line.endsWith('\r') ? line.slice(0, -1) : line
  for (let i = body.indexOf('{"event":"'); i >= 0; i = body.indexOf('{"event":"', i + 1)) {
    const ev = traceEvent(body.slice(i))
    if (ev) return { text: body.slice(0, i), ev }
  }
  return { text: line, ev: null }
}

/** Reads a commit's stderr (git's trace in it) into who wrote what (CommitStream). */
export function readCommitStream(err: string): CommitStream {
  const children: CommitChild[] = []
  const byId = new Map<number, CommitChild>()
  let open: CommitChild | null = null
  // The child that exited last, while no other has started since: git's text then is also its `after`.
  let last: CommitChild | null = null
  let top: string | null = null
  let own = ''
  let text = ''
  const add = (t: string): void => {
    if (!t) return
    text += t
    if (open) open.text += t
    else {
      own += t
      if (last) last.after += t
    }
  }
  // The top git's session starts with its `version` event (trace2's first) and has no parent's prefix; a git a hook runs
  // is `<parent>/<own>`. Only their records are events: any other record (a hook's own structured log, #1397) is text.
  const ours = (ev: TraceEvent): boolean => (top === null ? ev.event === 'version' && !ev.sid.includes('/') : ev.sid === top || ev.sid.startsWith(`${top}/`))
  const lines = err.split('\n')
  lines.forEach((line, i) => {
    const nl = i < lines.length - 1 ? '\n' : ''
    const { text: t, ev } = splitTraceLine(line)
    if (!ev || !ours(ev)) return add(line + nl)
    // Text cut by an event (no newline of its own) keeps a line of its own.
    add(t ? `${t}\n` : '')
    // A descendant's events are only dropped from the text, never a source.
    top ??= ev.sid
    if (ev.sid !== top || ev.child_id === undefined) return
    if (ev.event === 'child_start') {
      const argv = ev.argv ?? []
      const signer = argv.includes('-bsau') || (argv.includes('-Y') && argv.includes('sign'))
      const c: CommitChild = { kind: ev.child_class === 'hook' ? 'hook' : signer ? 'signer' : 'other', ...(ev.child_class === 'hook' ? { name: ev.hook_name ?? argv[0] ?? 'hook' } : {}), text: '', after: '' }
      children.push(c)
      byId.set(ev.child_id, c)
      open = c
      last = null
    } else if (ev.event === 'child_exit') {
      const c = byId.get(ev.child_id)
      if (c) c.code = ev.code
      if (open === c) {
        open = null
        last = c ?? null
      }
    }
  })
  return { traced: top !== null, children, open, git: own, text }
}

const joined = (...parts: (string | undefined)[]): string => parts.map((p) => p?.trim()).filter(Boolean).join('\n')

/**
 * Why Hive's merge, or a squash's commit, failed (#1350), from the source of each piece of what it said (its stream,
 * readCommitStream), never from words in another's (a hook that passed saying "passphrase" changes nothing):
 * - ended at the bound: always a pause, decided by what was running when it was ended (`cut`, its stream until then;
 *   ending it may make a hook exit non-zero, which is never its rejection): a hook → `hookTimedOut`; the signer, or
 *   nothing known in a repository that signs → `signingWaits`; else `needsYou`;
 * - a hook that exited non-zero → returned (`hook`) with its own text, then git's;
 * - the signer exiting non-zero → `signingWaits` when its own text says it needs a passphrase, a pinentry or a
 *   terminal, else `signing`, with its text and git's. Its own text is what it wrote while it ran (Git for Windows
 *   2.45 lets it write to stderr) and git's text right after it exited, before any other child (HI-2399: 2.56 captures it and
 *   reprints it then, `error: gpg failed to sign the data:` and gpg's lines); a hook's text is never either;
 * - anything else (an index lock, a broken repository) → `needsYou` with git's own lines, never a return.
 * With no trace (an old git), only git's own "Not committing merge" is a hook. A message never has an event in it.
 */
export function commitFailed(r: QueueGitResult, signs: boolean): { fail: 'hook'; log: string } | { pause: PauseReason; message?: string } {
  const s = readCommitStream(r.err)
  const all = joined(r.out, s.text)
  if (r.timedOut) {
    const running = readCommitStream(r.errAtTimeout ?? r.err).open
    if (running?.kind === 'hook') return { pause: 'hookTimedOut', message: all }
    return { pause: running?.kind === 'signer' || signs ? 'signingWaits' : 'needsYou', message: all }
  }
  if (!s.traced) return MERGE_HOOK_STOPPED.test(all) ? { fail: 'hook', log: all } : { pause: 'needsYou', message: all }
  const hook = s.children.find((c) => c.kind === 'hook' && c.code !== undefined && c.code !== 0)
  if (hook) return { fail: 'hook', log: joined(hook.text, s.git, r.out) }
  const signer = s.children.find((c) => c.kind === 'signer' && c.code !== undefined && c.code !== 0)
  if (signer) return { pause: SIGN_WAITS.test(signer.text) || SIGN_WAITS.test(signer.after) ? 'signingWaits' : 'signing', message: joined(signer.text, s.git) }
  return { pause: 'needsYou', message: joined(r.out, s.git) }
}

/**
 * The environment of Hive's commits (#1350): no prompt is ever waited on. git asks for no credentials, ssh-keygen never
 * asks for a passphrase, and a credential manager stays non-interactive; a pinentry window is ended by the bound.
 */
function commitEnv(): NodeJS.ProcessEnv {
  // GIT_TRACE2_EVENT=2: git's trace2 events on its own stderr, in order with what its hooks and signer write there.
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never', GIT_TRACE2_EVENT: '2' }
}

/**
 * git as Hive runs it, with no input (no terminal to prompt on), in an environment and within a bound: at the bound its
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

/**
 * HI-2019: a git read that failed before anything was touched (no `IntegrationStarted`, no pause written): the entry
 * goes round again, a fresh pass. `message` is what git said, for the pause once the budget is spent.
 */
interface Again {
  again: { message?: string }
}
const again = (message?: string): Again => ({ again: message?.trim() ? { message: message.trim() } : {} })
const isAgain = (v: unknown): v is Again => !!v && typeof v === 'object' && 'again' in v
/** An unknown's own words for the pause: what git said, else what couldn't be read. */
const gitSaid = (u: Unknown): string => u.detail ?? u.what
/**
 * HI-2054: a `git config --get` as git answered it: its value, '' when git says the key isn't set (its own exit 1), or
 * `{ failed }` with git's words for a read git couldn't make (as src/main/platform/git's identity, HI-2019). A git that
 * never started, was ended by a signal or by its bound is never an answer, whatever its code or partial output.
 */
const configRead = (r: QueueGitResult): string | { failed: string } => {
  const answered = !r.timedOut && !r.notRun && !r.signal
  if (answered && r.ok) return r.out.trim()
  if (answered && r.code === 1) return ''
  return { failed: r.err.trim() || `git exited with code ${r.code}` } // i18n-ignore: git's side of a pause's message, in English as git's are
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const refSafe = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, '-')

/** A runner that lost its lease stops at once: no outcome (another Hive's runner carries on). */
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
  private async pause(target: string, card: CardRecord, entry: QueueEntry, reason: PauseReason, files?: string[], message?: string, stuck?: QueueStuck): Promise<QueueOutcome> {
    const m = message?.trim().slice(0, 4000) || undefined
    const named = stuck ? stuck.files.map((f) => f.path) : files
    // Never in place of a pause saved meanwhile (the user's Pause queue, say), decided in the pause's own write; the
    // terminal state, which says more, and which the user must settle, is written whatever was there.
    const wrote = await this.wf.locked(() => this.wf.store.setQueuePause(target, { reason, card: card.key, ...(named?.length ? { files: named } : {}), ...(m ? { message: m } : {}), ...(stuck ? { stuck } : {}) }, !stuck))
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

  /** The queue's entries for a target, in the order they were requested: open, or recovered to run again. */
  entries(target?: string): { card: CardRecord; entry: QueueEntry }[] {
    const out: { card: CardRecord; entry: QueueEntry }[] = []
    for (const f of this.wf.store.factsOfKind('IntegrationRequested')) {
      const d = f.data as FactData['IntegrationRequested']
      if (target && d.target !== target) continue
      const s = this.wf.state(f.card)
      const e = s.entries.find((x) => x.id === d.entry)
      if (e && (e.state === 'open' || (e.state === 'started' && this.rerun.has(e.id)))) out.push({ card: this.wf.store.card(f.card), entry: e })
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
    if (p || this.cfg.teamPaused?.()) return null
    return this.fenced(target, async () => {
      // A push owed by an earlier merge goes first (G18: after a restart or a Resume), and the next entry waits for it.
      const owed = await this.settlePush(target)
      if (owed) return owed
      const next = this.entries(target)[0]
      if (!next) return null
      return this.thenPush(target, await this.process(next.card, next.entry))
    }).catch(lostIsNull)
  }

  /** After an entry's merge, the push of its target it owes (G18), before the next entry; its outcome stays the merge's. */
  private async thenPush(target: string, o: QueueOutcome | null): Promise<QueueOutcome | null> {
    if (o?.outcome === 'integrated') await this.settlePush(target)
    return o
  }

  /** Whether the project's options push the target after merging, as they are now (G18 isn't a rule: never a ruleset's). */
  private pushes(): boolean {
    const o = this.wf.cfg.options()
    return o.platform === 'git' && o.finish === 'hiveMerges' && o.pushTarget === true
  }

  /** The message of Hive's merge commits (G19, HI-1697), as the project's options are now: like G18, never a ruleset's. */
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
      const has = p.result === head ? true : await G.isAncestor(this.project, p.result, head)
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
    const head = await G.lineHead(this.project, target)
    if (isUnknown(head)) return this.pausePush(target, owed, 'pushUnreadable')
    const has = head ? await G.isAncestor(this.project, owed.result, head) : false
    if (isUnknown(has)) return this.pausePush(target, owed, 'pushUnreadable')
    if (!has) {
      // Nothing is pushed: the merges the target no longer has are settled as reset; one it still has stays pending,
      // for the next push to settle (never taken for pushed on the local target alone).
      const gone: PushPending[] = []
      for (const p of pending) if (!head || (await G.isAncestor(this.project, p.result, head)) === false) gone.push(p)
      await this.clearOwed(target, owed.result, this.notPushed(gone, 'reset'))
      return null
    }
    const dest = await this.pushDest(target)
    // The off switch as it is now, just before the push begins (HR2's #1179 round 1: the reads above take time).
    if (!this.pushes()) {
      await this.clearOwed(target, owed.result, this.notPushed(pending, 'off'))
      return null
    }
    // HI-2054: where to push couldn't be read: unreadable, as the reads above (in Hive's own words), never "no remote".
    if (dest === 'unreadable') return this.pausePush(target, owed, 'pushUnreadable')
    if (!dest) return this.pausePush(target, owed, 'pushNoRemote')
    // The head read above, by its commit (HI-1924): what was pushed is exactly what the settled merges are checked against.
    const pushed = head as string
    const r = await this.git(this.project, ['push', '--', dest.remote, `${pushed}:${dest.ref}`], { env: pushEnv(), timeoutMs: PUSH_MS })
    if (r.ok) {
      await this.clearOwed(target, owed.result, await this.pushedBy(pending, pushed))
      return null
    }
    const said = `${r.err}\n${r.out}`.trim()
    return this.pausePush(target, owed, !r.timedOut && PUSH_REJECTED.test(said) ? 'pushRejected' : 'pushFailed', said)
  }

  /**
   * Where a target is pushed: its upstream (`branch.<target>.remote` and `.merge`), else the only remote or origin.
   * HI-2054: a read git couldn't make is 'unreadable', never "nowhere to push" (nor a guessed ref).
   */
  private async pushDest(target: string): Promise<{ remote: string; ref: string } | null | 'unreadable'> {
    const get = async (key: string) => configRead(await this.git(this.project, ['config', '--get', key]))
    const remote = await get(`branch.${target}.remote`)
    if (typeof remote !== 'string') return 'unreadable'
    if (remote && remote !== '.') {
      const merge = await get(`branch.${target}.merge`)
      if (typeof merge !== 'string') return 'unreadable'
      return { remote, ref: merge.startsWith('refs/heads/') ? merge : `refs/heads/${target}` }
    }
    const list = await this.git(this.project, ['remote'])
    if (!list.ok) return 'unreadable'
    const remotes = list.out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    const only = remotes.length === 1 ? remotes[0] : remotes.includes('origin') ? 'origin' : null
    return only ? { remote: only, ref: `refs/heads/${target}` } : null
  }

  /** Pauses the target's queue for its owed push (never in place of a pause saved meanwhile), naming the merged card. */
  private async pausePush(target: string, owed: PushOwed, reason: PauseReason, message?: string): Promise<QueueOutcome> {
    const m = message?.trim().slice(0, 4000) || undefined
    await this.wf.locked(() => this.wf.store.setQueuePause(target, { reason, card: owed.card, ...(m ? { message: m } : {}) }, true))
    return { card: owed.card, entry: owed.entry, outcome: 'paused', reason, ...(m ? { message: m } : {}) }
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
    return this.wf.write(card, this.wf.rulesetOf(card, s), 'hive', fn)
  }

  /**
   * The advance's authority, decided in the transaction that writes `IntegrationStarted` (§16.4.6, §16.9.1 step 6):
   * the entry still the card's open one, the card in Merging, approved at the current generation and not stale. A
   * decision, a cancel or a stale pass that landed after the queue's last check stops it here, before git is touched.
   * Workflow rules turned off by now (while the queue waited for the repository lock, say): no advance begins, `rulesOff`.
   * The queue paused by now (Pause queue): none begins either, `held`, the entry left open.
   */
  private startAdvance(card: CardRecord, entry: QueueEntry, data: FactData['IntegrationStarted']): Promise<'started' | 'denied' | 'rulesOff' | 'held' | 'ask'> {
    return this.write(card, (w) => {
      const s = w.state()
      const e = s.entries.find((x) => x.id === entry.id)
      const open = !!e && (e.state === 'open' || (e.state === 'started' && this.rerun.has(e.id)))
      const r = w.ruleset!
      const approved = r.options.review === 'none' ? !s.stale : !notApproved(s, r, card.labels)
      if (!open || s.stage !== 'merging' || !approved) return 'denied' as const
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
      return await G.gitStep(() => this.steps(card, entry, ready))
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
      // OP-29's backstop (#1419): inside a larger repository, only into a branch the project itself named in the card's
      // ruleset (`targetOwn`, kept with a lane's rules too), never one inherited from the workspace's or Hive's defaults.
      if (!this.wf.rulesetOf(card, s).options.targetOwn && this.cfg.subfolder?.()) return this.pause(target, card, entry, 'subfolderTarget')
      // HI-1697: an upgraded project's first merge waits for its merge style and commit message to be chosen.
      if (await this.mergeAsked()) return this.askMerge(card, entry, target)
      const revision = s.approved?.revision ?? entry.revision
      const step = (now: QueueStep, expected: string | null): void => this.cfg.onStep?.({ card: card.key, number: card.id, entry: entry.id, revision, expected, step: now, started })
      let expected: string
      let result: string
      if (ready) {
        // Approved: the advance at once, on the test merge and checks the user was asked about (its result pinned on the
        // card's queue ref). The target moving since is caught below, and the entry is tested again.
        ;({ expected, result } = ready)
        ready = undefined
      } else {
        step('testMerge', null)
        const base = s.approved?.base ?? s.latest?.base ?? s.started?.base ?? ''
        const head = await G.lineHeadAndTree(this.project, target)
        if (isUnknown(head)) {
          const o = await readFailed(again(gitSaid(head)))
          if (o) return o
          continue
        }
        if (!head) return this.pause(target, card, entry, 'needsYou')
        // Already in the target (merged by hand meanwhile): observed, no empty merge. Asked of the head just read.
        const found = await G.contains(this.project, target, { base, revision, key: s.latest?.key }, head)
        if (!isUnknown(found) && found) {
          await reconcile(this.wf, card)
          return { card: card.key, entry: entry.id, outcome: 'integratedOutside' }
        }
        expected = head

        // The test merge, in the queue's own worktree, at the expected revision; under strict (G8) of the reviewed revision
        // brought up to date with it there first (#1352), the card's line untouched.
        step('testMerge', expected)
        let updated: string | undefined
        // Rebase and fast-forward (#1184) puts the change on top of the target in the test merge itself: no update first.
        if (this.wf.rulesetOf(card, s).options.strict && this.wf.rulesetOf(card, s).options.style !== 'rebase') {
          const up = await this.upToDate(card, s, entry, revision, base || (await this.mergeBaseOf(revision, expected)), expected, reads)
          if (isAgain(up)) {
            const o = await readFailed(up)
            if (o) return o
            continue
          }
          if ('pause' in up) return this.pause(target, card, entry, up.pause, up.files, up.message)
          if ('fail' in up) return this.returnCard(card, entry, revision, target, up.fail === 'hook' ? 'hook' : 'notUpToDate', false, up.files, up.log, undefined, undefined, up.conflicts)
          updated = up.updated ?? undefined
        }
        const test = await this.testMerge(card, s, revision, expected, reads, updated, base)
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
        step('checks', expected)
        const checks = await this.mergeChecks(card, result, entry, expected)
        if (checks.kind === 'red') return this.returnCard(card, entry, revision, target, 'checks', checks.transient, undefined, checks.output, checks.cause, { check: checks.check, ...(checks.logPath ? { logPath: checks.logPath } : {}) })
        // Missing review proof or a missing runner isn't the work's fault: the same revision may go back (requeue.allowed).
        if (checks.kind === 'focused') return this.returnCard(card, entry, revision, target, 'focused', checks.focused.why === 'noProof' || checks.focused.why === 'noRunner', undefined, undefined, undefined, undefined, undefined, checks.focused)
        if (checks.kind === 'skip') return this.askSkip(target, card, entry, checks.skipped, { expected: checks.expected, tree: checks.tree })
        if (checks.kind === 'uncounted') {
          if (++uncounted > MAX_RETESTS) return this.pause(target, card, entry, 'uncounted')
          continue
        }
        await this.cfg.hooks?.afterChecks?.(entry.id)
      }

      // The last check before the target moves: still approved (a decision since cancels the entry).
      const last = this.stillApproved(card, entry)
      if (!last.ok) return this.skip(card, entry, last.cancelled)
      // Paused meanwhile (Pause queue): the entry's checks are done, and it waits, open, for Resume (from its test merge).
      const held = this.paused(target)
      if (held) return this.held(card, entry, held.reason)
      step('advance', expected)
      const now = await G.lineHead(this.project, target)
      if (isUnknown(now) || now !== expected) {
        // The target moved since the test: tested again against the new head; never an untested advance.
        if (++retests > MAX_RETESTS) return this.pause(target, card, entry, 'targetMovesFast')
        continue
      }
      // Workflow rules turned off meanwhile: no advance begins (an entry already begun finishes: recover). Decided again
      // in the write of `IntegrationStarted` (startAdvance), after the wait for the lock.
      if (this.cfg.enforced && !this.cfg.enforced()) return this.pause(target, card, entry, 'rulesOff')
      const where = await G.checkouts(this.project)
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
      const integrate = (): Promise<void> => this.integrated(card, entry, revision, target, result, method, 'hive')
      const adv = folder ? await this.advanceCheckedOut(card, entry, target, expected, result, folder, integrate) : await this.advanceRef(card, entry, target, expected, result)
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
    return reads.identity ??= G.identity(this.project)
  }

  /**
   * Whether the repository signs commits, as git reads it in the queue's folder. HI-2054: a read git couldn't make is
   * `again` with git's words (the round's reads are new each time round, so it is read again), never "unsigned".
   */
  private signs(reads: EntryReads, f: string): Promise<boolean | Again> {
    return (reads.signs ??= this.git(f, ['config', '--type=bool', '--get', 'commit.gpgsign']).then((r) => {
      const v = configRead(r)
      return typeof v === 'string' ? v === 'true' : again(v.failed)
    }))
  }

  /**
   * The test merge (§16.9.1 step 4), committed as Hive's commits are (#1350): with the project's identity (else paused
   * `identity`, naming the folder), the repository's hooks run (one that fails returns the card), signed as the
   * repository says but never waiting on a prompt (paused). Any other failure of git pauses with its message; only a
   * conflict or a hook returns the card. A failure leaves the queue's worktree clean, at the expected revision.
   */
  /** Where two revisions' histories meet ('' when git can't say: an update then fails as git refuses it). */
  private async mergeBaseOf(a: string, b: string): Promise<string> {
    const r = await this.git(this.project, ['merge-base', a, b])
    return r.ok ? r.out.trim() : ''
  }

  /**
   * The queue's own worktree, made or reused, detached and clean at `at`. Reused (forced to `at`, cleaned) only when this
   * repository's worktree list names it (HI-2019: never because a folder is there); made when it is neither there nor
   * listed, or there and empty. A git that failed (the listing, the add, the checkout, which may have done part of its
   * work) is `again`: the next pass looks afresh. Nothing is ever removed or pruned: a folder there but not listed with
   * something in it, or listed but gone, is left as it is and pauses, named.
   */
  private async folderAt(at: string): Promise<Again | { pause: PauseReason; files?: string[]; message?: string } | null> {
    const f = this.cfg.folder
    const list = await this.git(this.project, ['worktree', 'list', '--porcelain'])
    if (!list.ok) return again(list.err)
    const key = (p: string): string => resolve(p).toLowerCase()
    const listed = list.out.split('\n').some((l) => l.startsWith('worktree ') && key(l.slice(9).trim()) === key(f))
    const there = existsSync(f)
    if (listed && there) {
      const co = await this.git(f, ['checkout', '--detach', '-f', at])
      if (!co.ok) return again(co.err)
      await this.git(f, ['clean', '-fdq'])
      return null
    }
    if (listed) return { pause: 'needsYou', files: [f], message: `The queue's worktree ${f} is registered with git but isn't there: left as it is.` } // i18n-ignore: git's side of a pause, in English as git's messages are
    const empty = (): boolean => {
      try {
        return readdirSync(f).length === 0
      } catch {
        return false // a file, or unreadable: never taken for an empty folder
      }
    }
    if (there && !empty()) return { pause: 'needsYou', files: [f], message: `${f} has files in it but isn't one of this repository's worktrees: left as it is.` } // i18n-ignore: git's side of a pause, in English as git's messages are
    const add = await this.git(this.project, ['worktree', 'add', '--detach', f, at])
    return add.ok ? null : again(add.err)
  }

  /**
   * Strict, G8 (§16.9.1 step 3, #1352): a reviewed revision that doesn't contain the target's head is brought up to date
   * in the queue's own worktree only, never on the card's line (the builder's branch, in its worktree): the target merged
   * into it, or, with merge style Squash, it rebased onto the target, as Hive's commits are made (#1350: the project's
   * identity, the repository's hooks and signing, never a prompt). The result is the same change (§16.3.2's replay:
   * `sameChange`) or the card goes back to its builder: a conflict with the files, or a different change, both
   * `notUpToDate`. The same: kept on `refs/hive/queue/<entry>` and recorded (`Updated`, carried), and the entry's test
   * merge merges it. Up to date already: nothing to do (`updated` null). Always from the reviewed revision, so a retest
   * after the target moved updates afresh, never on an earlier update.
   */
  private async upToDate(card: CardRecord, s: CardState, entry: QueueEntry, revision: string, base: string, expected: string, reads: EntryReads): Promise<Again | { updated: string | null } | { fail: 'conflict' | 'notSame' | 'hook'; files?: string[]; log: string; conflicts?: ConflictsRecord } | { pause: PauseReason; files?: string[]; message?: string }> {
    const anc = await this.git(this.project, ['merge-base', '--is-ancestor', expected, revision])
    if (anc.code === 0) return { updated: null }
    if (anc.code !== 1) return again(anc.err)
    const id = await this.identity(reads)
    if (isUnknown(id)) return again(gitSaid(id))
    if (!id) return { pause: 'identity', files: [this.project] }
    const at = await this.folderAt(revision)
    if (at) return at
    const f = this.cfg.folder
    const who = ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`]
    const rebase = this.wf.rulesetOf(card, s).options.style === 'squash'
    const signs = await this.signs(reads, f)
    // HI-2054: whether it signs couldn't be read: again, before anything is merged or committed.
    if (isAgain(signs)) return signs
    const opts: QueueGitOptions = { env: commitEnv(), ...(signs ? { timeoutMs: this.cfg.signTimeoutMs ?? SIGN_TIMEOUT_MS } : {}) }
    const target = entry.target
    const message = updateMessage(this.commitMessage(), target, card.key, revision)
    // A rebase here rewrites only the queue's detached HEAD: never other refs at the rebased commits (HR4's #1352 round
    // 1: with the repository's `rebase.updateRefs` on, git would move the builder's branch, or a user's, to the update).
    // Overridden for this command only; the repository's config is left as it is.
    const u = rebase ? await this.git(f, [...who, '-c', 'rebase.updateRefs=false', 'rebase', '--no-update-refs', '--no-autostash', '--onto', expected, base], opts) : await this.git(f, [...who, 'merge', '--no-ff', '--no-edit', '-m', message, expected], opts)
    // HI-2020: git never started (nothing ran), or HI-2042 a signal ended it (what it did unknown): the worktree put back as
    // after any failure, and the entry goes round again.
    if (u.notRun || u.signal) {
      await this.git(f, rebase ? ['rebase', '--abort'] : ['merge', '--abort'])
      await this.folderAt(expected)
      return again(u.err)
    }
    if (!u.ok) {
      const c = u.timedOut ? null : await this.git(f, ['diff', '--name-only', '--diff-filter=U', '-z'])
      const files = namesOf(c?.out)
      // Its hunks read before the abort (HI-1181): a merge of the target into the card's revision writes the card first.
      const conflicts = files.length ? await readConflicts(f, files, rebase ? 'target' : 'card') : undefined
      await this.git(f, rebase ? ['rebase', '--abort'] : ['merge', '--abort'])
      await this.folderAt(expected)
      if (files.length) return { fail: 'conflict', files, log: joined(u.out, readCommitStream(u.err).text), conflicts }
      return commitFailed(u, signs)
    }
    const h = await G.head(f)
    if (isUnknown(h)) return again(gitSaid(h))
    // The same change as reviewed, replayed onto the target's head (the candidate key, then the tree)?
    if (!(await G.sameChange(this.project, { base, revision, key: s.latest?.key }, { base: expected, revision: h }))) {
      return { fail: 'notSame', log: `${card.key}: ${revision.slice(0, 7)} brought up to date with ${target} (${expected.slice(0, 7)}) isn't the same change as reviewed: bring it up to date yourself and submit it again.` } // i18n-ignore: the card's log, agent-facing
    }
    await this.git(this.project, ['update-ref', `refs/hive/queue/${refSafe(entry.id)}`, h])
    await this.write(card, (w) => {
      if (this.isOpen(w, entry)) w.fact('Updated', { entry: entry.id, from: revision, to: h, how: rebase ? 'rebased' : 'mergedTarget', carried: true }) // i18n-ignore: a fact's kind and codes, not text
    })
    return { updated: h }
  }

  private async testMerge(card: CardRecord, s: CardState, revision: string, expected: string, reads: EntryReads, updated?: string, base = ''): Promise<Again | { result: string } | { fail: 'conflict' | 'hook' | 'notUpToDate'; files?: string[]; log: string; conflicts?: ConflictsRecord } | { pause: PauseReason; files?: string[]; message?: string }> {
    const id = await this.identity(reads)
    if (isUnknown(id)) return again(gitSaid(id))
    if (!id) return { pause: 'identity', files: [this.project] }
    const r = this.wf.rulesetOf(card, s)
    if (r.options.style === 'rebase') return this.rebaseOnto(card, s, revision, base || (await this.mergeBaseOf(revision, expected)), expected, id, reads)
    const f = this.cfg.folder
    const at = await this.folderAt(expected)
    if (at) return at
    // The reviewers whose passes count for what is merged: the latest submission, at the current generation.
    const reviewers = [...new Set(s.verdicts.filter((v) => v.pass && v.submission === s.latest?.id && v.generation === s.generation).map((v) => v.reviewer))].join(', ')
    // The reviewed revision, and the queue's update of it when strict brought it up to date (#1352).
    // G19 (HI-1697): Hive's, or the branch's own (its commits since it left the target, merges left out).
    const how = this.commitMessage()
    const own = how === 'branch' ? await G.messages(this.project, `${base || (await this.mergeBaseOf(revision, expected))}..${revision}`) : []
    if (isUnknown(own)) return again(`Hive couldn't read the messages of ${revision.slice(0, 7)}'s commits.`) // i18n-ignore: git's side of a pause, in English as git's messages are
    const message = mergeMessage(how, { card, revision, updated, reviewers, messages: own })
    revision = updated ?? revision
    const who = ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`]
    const squash = r.options.style === 'squash'
    // Signed as the repository says (never overridden), within a bound when it signs: a signer waiting for a passphrase
    // is ended with the rest of the commit's tree.
    const signs = await this.signs(reads, f)
    // HI-2054: whether it signs couldn't be read: again, before anything is merged or committed.
    if (isAgain(signs)) return signs
    const opts: QueueGitOptions = { env: commitEnv(), ...(signs ? { timeoutMs: this.cfg.signTimeoutMs ?? SIGN_TIMEOUT_MS } : {}) }
    const clean = async (): Promise<void> => {
      await this.git(f, ['merge', '--abort'])
      await this.git(f, ['reset', '--hard', '-q', expected])
      await this.git(f, ['clean', '-fdq'])
    }
    // Its output read with git's own trace in it (commitEnv), so a failure is told by who said what, never by words.
    const m = await this.git(f, [...who, 'merge', squash ? '--squash' : '--no-ff', ...(squash ? [] : ['--no-edit', '-m', message]), revision], opts)
    // HI-2020: git never started (nothing ran, so nothing to tell a hook or a conflict from), or HI-2042 a signal ended it
    // (no answer of git's to tell them from): put back, and again.
    if (m.notRun || m.signal) {
      await clean()
      return again(m.err)
    }
    if (!m.ok) {
      const u = m.timedOut ? null : await this.git(f, ['diff', '--name-only', '--diff-filter=U', '-z'])
      const files = namesOf(u?.out)
      // Its hunks read before the clean (HI-1181): the target is checked out, so its side comes first.
      const conflicts = files.length ? await readConflicts(f, files, 'target') : undefined
      await clean()
      if (files.length) return { fail: 'conflict', files, log: joined(m.out, readCommitStream(m.err).text), conflicts }
      return commitFailed(m, signs)
    }
    if (squash) {
      const c = await this.git(f, [...who, 'commit', '-q', '-m', message], opts)
      if (!c.ok) {
        await clean()
        return c.notRun || c.signal ? again(c.err) : commitFailed(c, signs)
      }
    }
    const h = await G.head(f)
    if (isUnknown(h)) return again(gitSaid(h))
    await this.git(this.project, ['update-ref', `refs/hive/queue/${refSafe(card.key)}`, h])
    return { result: h }
  }

  /**
   * Rebase and fast-forward's test merge (G6, #1184), under its "linear landing" policy: every commit the advance adds
   * to the target (`expected..result`) has exactly one parent, and `expected` is an ancestor of `result`. The reviewed
   * suffix (`base..revision`) is rebased onto the target's head in the queue's worktree, with merge preservation always
   * off (`rebase.rebaseMerges` overridden for this command, `--no-rebase-merges`; `--force-rebase` when the suffix holds
   * a merge, which git would otherwise take as up to date) and no other ref moved (`rebase.updateRefs`, as strict's
   * update). A linear suffix already on the target lands as it is. Then, before the merge checks: on top of the target,
   * linear, and the same change as reviewed, else the card is returned (`notUpToDate`, saying which); a conflict returns
   * it with its files; a read git couldn't answer pauses (never taken for a pass or a mismatch).
   */
  private async rebaseOnto(card: CardRecord, s: CardState, revision: string, base: string, expected: string, id: { name: string; email: string }, reads: EntryReads): Promise<Again | { result: string } | { fail: 'conflict' | 'hook' | 'notUpToDate'; files?: string[]; log: string; conflicts?: ConflictsRecord } | { pause: PauseReason; files?: string[]; message?: string }> {
    const f = this.cfg.folder
    const merges = await this.git(this.project, ['rev-list', '--min-parents=2', `${base}..${revision}`])
    if (!merges.ok) return again(merges.err)
    const linear = !merges.out.trim()
    const onTop = await this.git(this.project, ['merge-base', '--is-ancestor', expected, revision])
    if (onTop.code !== 0 && onTop.code !== 1) return again(onTop.err)
    // The queue's worktree at the reviewed revision whatever follows (HR2's #1184 round 1): a linear card already on top
    // lands as it is, and its merge checks still run there, on exactly that revision.
    const at = await this.folderAt(revision)
    if (at) return at
    let result = revision
    if (!linear || onTop.code !== 0) {
      const who = ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`]
      const signs = await this.signs(reads, f)
      // HI-2054: whether it signs couldn't be read: again, before anything is merged or committed.
      if (isAgain(signs)) return signs
      const opts: QueueGitOptions = { env: commitEnv(), ...(signs ? { timeoutMs: this.cfg.signTimeoutMs ?? SIGN_TIMEOUT_MS } : {}) }
      const u = await this.git(f, [...who, '-c', 'rebase.rebaseMerges=false', '-c', 'rebase.updateRefs=false', 'rebase', '--no-rebase-merges', '--no-update-refs', '--no-autostash', ...(linear ? [] : ['--force-rebase']), '--onto', expected, base], opts)
      // HI-2020: git never started, or HI-2042 a signal ended it: put back, and again.
      if (u.notRun || u.signal) {
        await this.git(f, ['rebase', '--abort'])
        await this.folderAt(expected)
        return again(u.err)
      }
      if (!u.ok) {
        const c = u.timedOut ? null : await this.git(f, ['diff', '--name-only', '--diff-filter=U', '-z'])
        const files = namesOf(c?.out)
        // Its hunks read before the abort (HI-1181): rebased onto the target, whose side comes first.
        const conflicts = files.length ? await readConflicts(f, files, 'target') : undefined
        await this.git(f, ['rebase', '--abort'])
        await this.folderAt(expected)
        if (files.length) return { fail: 'conflict', files, log: joined(u.out, readCommitStream(u.err).text), conflicts }
        return commitFailed(u, signs)
      }
      const h = await G.head(f)
      if (isUnknown(h)) return again(gitSaid(h))
      result = h
    }
    const notUp = (why: string): { fail: 'notUpToDate'; log: string } => ({ fail: 'notUpToDate', log: `${card.key}: ${revision.slice(0, 7)} rebased onto ${expected.slice(0, 7)} ${why}: rebase it onto the target yourself and submit it again.` }) // i18n-ignore: the card's log, agent-facing
    const anc = await this.git(this.project, ['merge-base', '--is-ancestor', expected, result])
    if (anc.code === 1) return notUp("isn't on top of the target") // i18n-ignore: the card's log, agent-facing
    if (anc.code !== 0) return again(anc.err)
    const twoParents = await this.git(this.project, ['rev-list', '--min-parents=2', `${expected}..${result}`])
    if (!twoParents.ok) return again(twoParents.err)
    if (twoParents.out.trim()) return notUp('would land a merge commit (Rebase and fast-forward lands a linear history)') // i18n-ignore: the card's log, agent-facing
    if (!(await G.sameChange(this.project, { base, revision, key: s.latest?.key }, { base: expected, revision: result }))) return notUp("isn't the same change as reviewed") // i18n-ignore: the card's log, agent-facing
    await this.git(this.project, ['update-ref', `refs/hive/queue/${refSafe(card.key)}`, result])
    return { result }
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
    const focused = o.focusedTests && o.finish === 'hiveMerges'
    if (!o.mergeChecks.length && !focused) return { kind: 'green' }
    const f = this.cfg.folder
    const ctx: CheckContext = { card: card.key, number: card.id, revision: result }
    const manifests = this.cfg.manifests ?? ['package.json', 'package-lock.json']
    const hash = createHash('sha256')
    for (const m of manifests) hash.update(existsSync(join(f, m)) ? readFileSync(join(f, m)) : `-${m}`)
    const now = hash.digest('hex')
    const key = `queue:installed:${f}`
    let noInstall = false
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
        by: HIVE_RUNS,
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
    // Proof is its reviewer's (finding 1): a counted, passing run of that test's check at the submitted revision, by the
    // card's lane reviewer or an agent whose pass approved the submission. A builder's own run never counts.
    const reviewers = new Set([card.reviewer, ...passingReviewers(s)].filter((x): x is string => !!x))
    const proved = tests.filter(reviewProved)
    const runOf = (t: FocusedTest): FactData['CheckRan'] | undefined => s.checks.findLast((c) => c.name === focusedCheckName(t.id) && c.revision === entry.revision && c.result === 'passed' && c.counted && !!c.agent && reviewers.has(c.agent))
    const missing = proved.filter((t) => !runOf(t))
    if (missing.length) return { kind: 'focused', focused: { why: 'noProof', tests: missing.map((t) => t.id) } } // i18n-ignore: codes (a why, a check name), never shown as text
    if (proved.length) {
      await this.write(card, (w) => {
        for (const t of proved) if (!w.state().focusedAccepted.some((a) => a.entry === entry.id && a.result === result && a.test === t.id)) w.fact('FocusedAccepted', { entry: entry.id, revision: entry.revision, result, test: t.id, run: runOf(t)!.run })
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
      const env = { HIVE_FOCUSED_TESTS: testsFile, HIVE_FOCUSED_RESULTS: resultsFile, HIVE_FOCUSED_JOBS: String(Math.max(1, this.cfg.focused?.jobs() ?? 2)) }
      const start = await bracketStart(f)
      const r = await this.cfg.runCheck(FOCUSED_CHECK, run, f, { ...ctx, env, label: `${FOCUSED_CHECK} (${ids.length})` }) // i18n-ignore: a run's title, no words beyond the check's name
      const b = await bracketEnd(f, result, start)
      const raw = await boundedRead(resultsFile, FOCUSED_MAX_RESULTS_BYTES)
      const read = raw === null ? { bad: 'it wrote no results file' } : raw === false ? { bad: `its results file is over ${FOCUSED_MAX_RESULTS_BYTES} bytes` } : readResults(raw, ids) // i18n-ignore: a check's output, agent-facing
      // A runner that didn't exit 0 failed, whatever its results say (finding 6): skips are reported with exit 0.
      const failed = !r.ok || 'bad' in read || read.failed.length > 0
      const data: FactData['CheckRan'] = { name: FOCUSED_CHECK, command: r.command ?? run, revision: result, tested: b.tested, result: failed ? 'failed' : 'passed', run: r.run ?? randomUUID(), durationMs: Math.max(0, Date.now() - start.t0), by: HIVE_RUNS, counted: b.counted, ...(b.whyNot ? { whyNot: b.whyNot } : {}), entry: entry.id }
      await this.write(card, (w) => w.fact('CheckRan', data))
      r.note?.({ name: FOCUSED_CHECK, counted: b.counted, ...(b.whyNot ? { whyNot: b.whyNot } : {}) })
      if (failed) {
        const why = 'bad' in read ? `Hive couldn't take its results: ${read.bad}.` : read.failed.length ? `Failed: ${read.failed.map((x) => x.test).join(', ')}.` : '' // i18n-ignore: a check's output, agent-facing
        return { kind: 'red', transient: !!r.transient, ...(r.cause ? { cause: r.cause } : {}), output: [why, r.output].filter(Boolean).join('\n'), check: FOCUSED_CHECK, ...(r.logPath ? { logPath: r.logPath } : {}) }
      }
      if (!b.counted) return { kind: 'uncounted' }
      if (!('bad' in read) && read.skipped.length) {
        const tree = await git(f, ['rev-parse', `${result}^{tree}`])
        const bound = { expected, tree: tree.ok ? tree.out.trim() : `unread:${result}` }
        const decided = this.skipDecided(card, entry, read.skipped, bound)
        if (decided === 'declined') return { kind: 'red', transient: false, output: `Skipped and not accepted: ${read.skipped.map((x) => `${x.test}${x.why ? ` (${x.why})` : ''}`).join(', ')}.`, check: FOCUSED_CHECK } // i18n-ignore: a check's output, agent-facing
        if (decided !== 'approved') return { kind: 'skip', skipped: read.skipped, ...bound }
      }
      return { kind: 'green' }
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Hive's own temporary folder: left for the system's clean-up
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
   * card's reviewer agent to decide (hive_focused_skip), or the user under For you, who can override it. Asked once per
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
      if (reviewer) this.wf.wake(w, reviewer, `${card.key}'s focused tests were skipped at its merge for their environment: ${listed}. Decide whether it merges with them skipped (hive_focused_skip with request ${request}: merge true or false, and why); the user can override.`, 'answer') // i18n-ignore: a wake, agent-facing
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
   * HI-1697: "How should Hive merge <project>'s cards into <target>?", a Decide on the card in For you; the queue waits
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
    // Under the repository's lock (#1347): the target still checked out nowhere (the user or another Hive may have
    // checked it out while the queue waited: a swap then would leave that folder's files behind), `IntegrationStarted`
    // (its write checks the lease, the fence, and the rules) and the ref's compare-and-swap, the lease checked once more
    // just before the swap.
    const r = await lock(async (): Promise<Advance> => {
      const where = await G.checkouts(this.project)
      // HI-2019: nothing touched yet, nothing written: out of the lock, and the entry goes round again.
      if (isUnknown(where)) return again(gitSaid(where))
      if (where[target]) return 'retest'
      const started = await this.startAdvance(card, entry, { entry: entry.id, expected, result, checkedOut: null })
      if (started === 'rulesOff') return this.settle(card, entry, target, { pause: 'rulesOff' })
      if (started === 'denied' || started === 'held' || started === 'ask') return started === 'ask' ? 'retest' : started
      await this.cfg.hooks?.afterStarted?.(entry.id)
      if (this.cfg.holds && !this.cfg.holds()) throw new LeaseLost(target)
      if ((await this.git(this.project, ['update-ref', `refs/heads/${target}`, result, expected])).ok) return 'done'
      await this.moved(card, entry, target)
      return 'moved'
    })
    if (r === 'done') await this.cfg.hooks?.afterAdvance?.(entry.id)
    return r
  }

  /**
   * What an advance came to, settled before the repository lock is released (HR4's #1351 round 1): a pause Hive writes
   * for what it saw there (a condition, the rules, the terminal state) is written in the lock, so no other run, this
   * Hive's or another's, acts on the target between the finding and the pause; a residue is merged, then paused.
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
    return { outcome: await this.pause(target, card, at, adv.pause, adv.files, adv.message, adv.stuck) }
  }

  /** The swap found the target moved: this entry failed (transient) and the card is queued again, to be tested again. */
  private async moved(card: CardRecord, entry: QueueEntry, target: string): Promise<void> {
    await this.write(card, (w) => {
      // Cancelled meanwhile: not queued again (the queue's next look skips it as cancelled).
      if (!this.isOpen(w, entry)) return
      w.fact('IntegrationFailed', { entry: entry.id, revision: entry.revision, target, reason: 'targetMoved', transient: true }) // i18n-ignore: a fact's kind and codes, not text
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
   * The target checked out in a folder (§16.9.2). Under the repository lock and that folder's fence (nothing of Hive's is
   * typed into it meanwhile), where it is checked out is read again and the conditions checked before anything is
   * touched, each failed one a pause naming its files; then the journal: `IntegrationStarted` (the listed files), phase
   * files and `read-tree -m -u <expected> <result>`, phase ref and `update-ref <target> <result> <expected>`, and, once
   * HEAD is seen to still name the target, `Integrated` (the caller's). A swap that finds the ref moved rolls the files
   * back (phase rollback). Each phase's fact checks the lease in its write, and the lease is checked again just before
   * git runs: a runner that lost its lease writes nothing more and touches nothing.
   */
  private async advanceCheckedOut(card: CardRecord, entry: QueueEntry, target: string, expected: string, result: string, seen: string, integrate: () => Promise<void>): Promise<Advance> {
    const r = await this.guarded(seen, async (): Promise<Advance> => {
      // Where the target is checked out now, under the lock: switched meanwhile, looked at again the right way.
      const now = await G.checkouts(this.project)
      // HI-2019: a read before anything is touched (and before IntegrationStarted) is never settled into a pause here: it
      // leaves the lock and the fence as `again`, for the entry to go round once admitted afresh.
      if (isUnknown(now)) return again(gitSaid(now))
      if (!now[target] || resolve(now[target]).toLowerCase() !== seen.toLowerCase()) return 'retest'
      const j = await this.journal(card, entry, target, expected, result, seen)
      return isAgain(j) ? j : this.settle(card, entry, target, j, integrate)
    })
    if (r === 'done') await this.cfg.hooks?.afterAdvance?.(entry.id)
    return r
  }

  private async journal(card: CardRecord, entry: QueueEntry, target: string, expected: string, result: string, folder: string): Promise<Advance> {
    // Conditions, before anything is touched: no agent builds there (an idle one, or one reviewing in a review copy,
    // doesn't count); HEAD names the target, at the expected revision; nothing staged; no unstaged or untracked change in
    // a file the merge changes (the user's other edits are left as they are).
    const busy = this.cfg.folderBusy?.(folder)
    if (busy) return { pause: 'folderBusy', files: busy.length ? busy : [folder] }
    // The folder's branch and the target's head, in one git (#1386). A branch git couldn't read is a read that failed
    // (HI-2019), never taken for the wrong branch; one it read, and isn't the target, is.
    const h = await G.heads(folder, target)
    if (isUnknown(h.line)) return again(gitSaid(h.line))
    if (h.line !== target) return { pause: 'wrongBranch', files: [folder] }
    if (h.target !== expected) return 'retest'
    // HI-2019: until IntegrationStarted below, a read git couldn't make is `again` (nothing touched, nothing written).
    const staged = await this.git(folder, ['diff', '--cached', '--name-only', '-z', expected])
    if (!staged.ok) return again(staged.err)
    if (nulList(staged.out).length) return { pause: 'staged', files: nulList(staged.out) }
    const changed = await this.git(this.project, ['diff', '--name-only', '-z', '--no-renames', expected, result])
    if (!changed.ok) return again(changed.err)
    const files = nulList(changed.out)
    const edited = await this.editedOf(folder, files)
    if (!Array.isArray(edited)) return again(edited.err || `Hive couldn't read the status of ${folder}.`) // i18n-ignore: git's side of a pause, in English as git's messages are
    if (edited.length) return { pause: 'unstagedChanges', files: edited }

    const started = await this.startAdvance(card, entry, { entry: entry.id, expected, result, files, checkedOut: folder })
    if (started === 'rulesOff') return { pause: 'rulesOff' }
    // Ask each time, as the setting is now: asked here, before the lock is released.
    if (started === 'ask') return { outcome: await this.askAdvance(card, entry, target, expected, result, folder) }
    if (started === 'denied' || started === 'held') return started
    await this.cfg.hooks?.afterStarted?.(entry.id)

    // 1. The files: index and the listed files to the result. git refuses, writing nothing, rather than overwrite a file
    // changed since the check.
    await this.phase(card, entry, 'files')
    await this.cfg.hooks?.beforeFiles?.(entry.id)
    this.stillHolds(target)
    const rt = await this.git(folder, ['read-tree', '-m', '-u', expected, result])
    if (!rt.ok) {
      const sides = await this.sidesOf(folder, files, expected, result)
      // Nothing written (every listed file still at the expected revision in the index): back to the test merge, and a
      // file the user edited since the check pauses, named. Anything else is the terminal state.
      if (sides && sides.every((f) => f.side === 'expected' || (f.side === 'other' && f.staged === 'expected'))) {
        const now = await this.editedOf(folder, files)
        await this.moved(card, entry, target)
        return Array.isArray(now) && now.length ? { pause: 'unstagedChanges', files: now } : 'moved'
      }
      return { pause: 'needsYou', message: rt.err, stuck: await this.stuckOf(target, folder, expected, result, files, 'files') }
    }
    await this.cfg.hooks?.afterFiles?.(entry.id)

    // 2. The ref: a compare-and-swap; the ref moved meanwhile, the files rolled back.
    await this.phase(card, entry, 'ref')
    await this.cfg.hooks?.beforeRef?.(entry.id)
    this.stillHolds(target)
    const u = await this.git(this.project, ['update-ref', `refs/heads/${target}`, result, expected])
    if (!u.ok) return this.rollback(card, entry, target, expected, result, folder, files)

    // HEAD no longer names the target (another client switched the folder in that instant: §16.9.2's "does not
    // guarantee"): merged, with the merged files in the other branch's working copy, listed to restore.
    // HI-2019: only a branch git couldn't read is read again (the advance is never redone), still in the lock and the
    // fence, the lease checked again before what follows is acted on.
    let after = await G.branch(folder)
    for (let i = 0; isUnknown(after) && i < CONFIRM_TRIES; i++) {
      await wait(CONFIRM_RETRY_MS)
      after = await G.branch(folder)
    }
    this.stillHolds(target)
    if (isUnknown(after) || after !== target) return { residue: await this.stuckOf(target, folder, expected, result, files, 'done') }
    return 'done'
  }

  /** The swap found the ref moved: the files rolled back (phase rollback), and the entry tested again; refused, terminal. */
  private async rollback(card: CardRecord, entry: QueueEntry, target: string, expected: string, result: string, folder: string, files: string[]): Promise<Advance> {
    await this.phase(card, entry, 'rollback')
    await this.cfg.hooks?.inRollback?.(entry.id)
    this.stillHolds(target)
    const back = await this.git(folder, ['read-tree', '-m', '-u', result, expected])
    if (!back.ok) return { pause: 'needsYou', message: back.err, stuck: await this.stuckOf(target, folder, expected, result, files, 'rollback') }
    await this.cfg.hooks?.afterRollback?.(entry.id)
    await this.moved(card, entry, target)
    return 'moved'
  }

  /**
   * Of the files a merge changes, those with a change in the folder (unstaged, staged or untracked), both sides of a
   * rename; null when git can't say. The whole folder's status, then the listed files: a long list never makes a
   * command line too long.
   */
  /** The listed files with a change in the folder's working copy or index; git's words when it couldn't say (HI-2019). */
  private async editedOf(folder: string, files: string[]): Promise<string[] | { err: string }> {
    if (!files.length) return []
    const st = await this.git(folder, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'])
    if (!st.ok) return { err: st.err }
    const listed = new Set(files)
    return [...new Set(statusPaths(st.out).filter((p) => listed.has(p)))]
  }

  /**
   * Where each listed file stands in the folder: its index entry and working copy both at the expected revision, both at
   * the result, or neither (`other`, with the side its index entry is at, when one). Null when git can't say.
   */
  private async sidesOf(folder: string, files: string[], expected: string, result: string): Promise<{ path: string; side: QueueFileSide; staged: QueueFileSide }[] | null> {
    const [ix, rx, st] = await Promise.all([
      this.git(folder, ['diff', '--cached', '--name-only', '-z', '--no-renames', expected]),
      this.git(folder, ['diff', '--cached', '--name-only', '-z', '--no-renames', result]),
      this.git(folder, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'])
    ])
    if (!ix.ok || !rx.ok || !st.ok) return null
    const notExpected = new Set(nulList(ix.out))
    const notResult = new Set(nulList(rx.out))
    // A working copy that differs from its index entry (unstaged or untracked: the status's second column, or `??`).
    const dirty = new Set(
      st.out
        .split('\0')
        .filter((t) => t.length > 3 && (t[1] !== ' ' || t.startsWith('??')))
        .map((t) => t.slice(3))
    )
    return files.map((path) => {
      const staged: QueueFileSide = !notExpected.has(path) ? 'expected' : !notResult.has(path) ? 'result' : 'other'
      return { path, side: dirty.has(path) ? 'other' : staged, staged }
    })
  }

  /**
   * §16.9.2's terminal state as Hive finds it: the branch, the ref, each listed file's side, and the commands that finish
   * or undo it, as far as the state allows (none when a file is at neither side: git would refuse them).
   */
  private async stuckOf(target: string, folder: string, expected: string, result: string, files: string[], phase: QueueStuck['phase']): Promise<QueueStuck> {
    const b = await G.branch(folder)
    const r = await G.lineHead(this.project, target)
    const branch = isUnknown(b) ? null : b
    const ref = isUnknown(r) ? null : r
    const sides = (await this.sidesOf(folder, files, expected, result)) ?? files.map((path) => ({ path, side: 'other' as const, staged: 'other' as const }))
    const all = (side: QueueFileSide): boolean => sides.every((f) => f.side === side)
    // Each command as its arguments, the ref as it is (a ref may hold `$` or `&`): shown for PowerShell by shellLine.
    const cmd = (purpose: QueueCommand['purpose'], place: QueueCommand['place'], args: string[]): QueueCommand => ({ purpose, place, args, command: shellLine(args) })
    const swap = ['git', 'update-ref', `refs/heads/${target}`, result, expected]
    const back = ['git', 'read-tree', '-m', '-u', result, expected]
    const forth = ['git', 'read-tree', '-m', '-u', expected, result]
    const commands: QueueCommand[] = []
    // A ref with `"` in it (git allows one) can't be handed to git by Windows PowerShell as written (it splits native
    // arguments at quotes): no command names it then; the state says where things are.
    if (branch === target && ref === expected && all('result')) commands.push(...(target.includes('"') ? [] : [cmd('finish', 'project', swap)]), cmd('undo', 'folder', back))
    else if (branch === target && ref === result && all('expected')) commands.push(cmd('finish', 'folder', forth))
    else if (branch === target && ref !== expected && ref !== result && all('result')) commands.push(cmd('undo', 'folder', back))
    // The merged files in another branch's working copy: put back as that branch had them.
    else if (phase === 'done' && all('result')) commands.push(cmd('undo', 'folder', back))
    return { folder, branch, ref, expected, result, phase, files: sides.map(({ path, side }) => ({ path, side })), commands }
  }

  /** `Integrated` → Done; the slot released, the lane ended if done; a decision recorded after the advance began → For you. */
  private async integrated(card: CardRecord, entry: QueueEntry, revision: string, target: string, result: string, method: 'merge' | 'squash' | 'fastForward', by: 'hive' | 'outside'): Promise<void> {
    await this.write(card, (w) => {
      // One Integrated per cycle, whoever writes it (the queue, or another Hive's recovery or observation).
      const st = w.state()
      if (st.integrated) return
      const startedAt = this.wf.store.facts(card.id).filter((f) => f.kind === 'IntegrationStarted' && (f.data as FactData['IntegrationStarted']).entry === entry.id).at(-1)?.seq ?? Infinity
      const f = w.tx.append(card.id, { kind: 'Integrated', actor: 'hive', source: 'recorded', dedupe: `cycle:${st.cycle}`, ...(w.ruleset ? { ruleset: w.ruleset.id } : {}), data: { entry: entry.id, revision, target, result, method, by } }) // i18n-ignore: a fact's kind and codes, not text
      w.written.push(f)
      w.move('done', 'derived')
      if (by === 'hive') this.owePush(w, entry.id, target, result)
      if (this.wf.store.facts(card.id).some((x) => x.kind === 'Decision' && x.seq > startedAt)) this.wf.askUser(w, 'decide', 'decision', workflowText(FOR_YOU.decidedAfterMerge, { card: card.key }))
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
      // What came back and what to do next (#1354): the files, the check, its log and last lines, bounded.
      this.wf.wake(w, w.state().started?.builder, returnedWake(card.key, failed))
      // HI-2087: and on the card, for whoever reads it (its latest comment was the review's pass).
      w.action('comment', { ...returnedComment(card.key, failed) })
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
      const { expected, result, checkedOut } = e.started
      const done = async () => {
        await this.write(card, (w) => {
          // How it landed, as an advance records it, by the style its entry was queued with (HR2's #1184 round 1).
          const requested = this.wf.store.facts(card.id).find((x) => x.kind === 'IntegrationRequested' && (x.data as FactData['IntegrationRequested']).entry === e.id)?.data as FactData['IntegrationRequested'] | undefined
          const method = methodOf(requested?.style ?? this.wf.rulesetOf(card, s).options.style, s.started?.target, e.target)
          const f = w.tx.appendObserved(card.id, { kind: 'Integrated', actor: 'outside', source: 'observed', dedupe: `cycle:${s.cycle}`, data: { entry: e.id, revision: e.revision, target: e.target, result, method, by: 'hive' } }) // i18n-ignore: a fact's kind and codes, not text
          if (!f) return
          // Its finish reads what this write recorded (HI-2014): the merge, verified.
          w.written.push(f as Fact)
          w.move('done', 'derived')
          // Hive's own merge, found done after a restart: its push owed as an advance's is (G18).
          this.owePush(w, e.id, e.target, result)
        })
      }
      // The target frozen (HR4's #1351 round 1): a needs-you pause naming a card is the terminal state, or an advance Hive
      // won't guess about. Read in the lock, before anything else, whatever started this run (another card's enqueue, a
      // reopen, another Hive): recovery writes nothing and touches nothing until the user lifts it (Resume, or the
      // answer to its For you, which check first). Other pauses still let a begun advance finish or roll back.
      const frozen = (): boolean => {
        const p = this.paused(e.target)
        return p?.reason === 'needsYou' && !!p.card
      }
      if (!checkedOut) {
        const lock = this.cfg.lock ?? (<T,>(fn: () => Promise<T>) => fn())
        const outcome = await lock(async (): Promise<'integrated' | 'rerun' | 'failed' | 'needsYou'> => {
          if (frozen()) return 'needsYou'
          const ref = await G.lineHead(this.project, e.target)
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
      // Hive's other work nor the Git view acts in the folder in between.
      const outcome = await this.guarded(checkedOut, async (): Promise<'integrated' | 'rerun' | 'failed' | 'needsYou'> => {
        if (frozen()) return 'needsYou'
        const f = await this.found(e)
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
          const u = await this.git(this.project, ['update-ref', `refs/heads/${e.target}`, result, expected])
          if (!u.ok) {
            const r = await this.rollback(card, e, e.target, expected, result, checkedOut, e.started!.files ?? [])
            return r === 'moved' ? 'failed' : stuck((r as { stuck: QueueStuck }).stuck)
          }
          const after = await G.branch(checkedOut)
          if (isUnknown(after) || after !== e.target) return stuck(await this.stuckOf(e.target, checkedOut, expected, result, e.started!.files ?? [], 'done'), true)
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
   * §16.9.2's recovery table for an advance begun into a checked-out target, from its journal (the last phase), the
   * folder's branch, the ref and each listed file's side: run it again from the test merge (`rerun`; `requeue` when the
   * ref moved before anything was touched, or after a rollback finished: failed and queued again), finish its swap
   * (`swap`), roll the files back (`rollback`: the ref moved meanwhile), merged (`integrated`; `residue` when the folder
   * is on another branch with the merged files in its working copy), or the terminal state (`stuck`). Reads only.
   */
  private async found(e: QueueEntry): Promise<{ found: Found; stuck?: QueueStuck }> {
    const { expected, result, files = [] } = e.started!
    const folder = e.started!.checkedOut!
    const phase = e.phases.at(-1) ?? 'started'
    const b = await G.branch(folder)
    const r = await G.lineHead(this.project, e.target)
    const branch = isUnknown(b) ? null : b
    const ref = isUnknown(r) ? null : r
    const sides = await this.sidesOf(folder, files, expected, result)
    const all = (side: QueueFileSide): boolean => !!sides && sides.every((f) => f.side === side)
    const stuck = async (p: QueueStuck['phase'] = phase): Promise<{ found: Found; stuck: QueueStuck }> => ({ found: 'stuck', stuck: await this.stuckOf(e.target, folder, expected, result, files, p) })
    if (ref === result) {
      if (branch === e.target || !sides) return { found: 'integrated' }
      // Merged, and the folder is on another branch now: the merged files left in its working copy (changed from its
      // HEAD, at the result), if any, are listed to restore.
      const vsHead = await this.git(folder, ['diff', '--name-only', '-z', '--no-renames', 'HEAD'])
      const changed = new Set(vsHead.ok ? nulList(vsHead.out) : files)
      return sides.some((f) => (f.side === 'result' || f.staged === 'result') && changed.has(f.path)) ? { found: 'residue', stuck: await this.stuckOf(e.target, folder, expected, result, files, 'done') } : { found: 'integrated' }
    }
    if (branch !== e.target || !sides) return stuck()
    if (ref === expected) {
      if ((phase === 'started' || phase === 'files' || phase === 'rollback') && all('expected')) return { found: 'rerun' }
      if ((phase === 'files' || phase === 'ref') && all('result')) return { found: 'swap' }
      return stuck()
    }
    // The ref moved meanwhile (another client), not to the result.
    if (ref !== null && phase !== 'started' && all('result')) return { found: 'rollback' }
    if (ref !== null && phase !== 'ref' && all('expected')) return { found: 'requeue' }
    return stuck()
  }

  /**
   * Resume of a needs-you pause (#1353, §16.9.3): whether the target's begun advance is still in §16.9.2's terminal state,
   * as recovery would find it now (the files it names, or [] for none), or null when recovery can carry on. Reads only.
   */
  async stillStuck(target: string): Promise<string[] | null> {
    for (const card of this.wf.store.cards()) {
      const e = openEntry(this.wf.state(card))
      if (!e || e.state !== 'started' || !e.started || e.target !== target || !e.started.checkedOut) continue
      const f = await this.found(e)
      return f.found === 'stuck' || f.found === 'residue' ? (f.stuck?.files.map((x) => x.path) ?? []) : null
    }
    return null
  }
}
