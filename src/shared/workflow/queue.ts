// The merge queue's model (#1353, SPEC §16.9.3): what a target's queue is doing, as every control reads it. The window
// (IPC `queue:list`, the panel #1356 and the card #1357), the Agent API (`GET /v1/queue`) and the Assistant's
// `cw_queue` all read this one model; main builds it from the cards' facts, the target's pause and lease, and the
// queue host's step (workflow/queueControls.ts). Codes, never words: the window says them in its language.

import type { FactData } from './facts'

/**
 * HI-2087: how a returned card's wake begins after its key ("HI-12 came back from the merge queue: …", queueState's
 * returnedText), so a line that tells several changes of a card leads with the return.
 */
export const CAME_BACK = 'came back from the merge queue' // i18n-ignore: agent-facing, the wake's words

/** The step the entry testing now is at: its test merge, its merge checks (an install first when one is due), the advance. */
export type QueueStep = 'testMerge' | 'checks' | 'advance'

/** The entry the queue is taking through its steps now. */
export interface QueueTesting {
  card: number
  key: string
  title: string
  entry: string
  /** The approved revision being merged. */
  revision: string
  /** The target's head it is tested on (null: not read yet, or another Combwork runs the queue). */
  expected: string | null
  /** Null when not known here: another Combwork runs the queue, or the advance began before a restart (its recovery finishes it). */
  step: QueueStep | null
  /** When the queue took it (ISO), as far as known here. */
  started: string | null
  /** The progress run of the check running now (its id), when Combwork keeps runs. */
  run: string | null
}

/** An entry waiting its turn, in order. */
export interface QueueQueued {
  card: number
  key: string
  title: string
  entry: string
  revision: string
  /** When it was queued (ISO). */
  at: string
  /** HI-2709: the cards it waits for (keys), blocked by them while they aren't Done: the queue goes on without it. */
  waitingOn?: string[]
}

/** An entry's outcome, kept for the panel: merged (with the result), returned to its builder (why, the log, the files), cancelled. */
export interface QueueRecent {
  card: number
  key: string
  title: string
  entry: string
  outcome: 'merged' | 'returned' | 'cancelled'
  at: string
  /** merged, returned: the card's revision the entry was for (#1357, the Git tab's history; the window's model only). */
  revision?: string
  /** merged: the target's new head. */
  result?: string
  /** merged: Combwork's merge or one seen done outside it. */
  by?: FactData['Integrated']['by']
  /** returned: why (conflict, checks, hook…); cancelled: why (removed, stale, …). */
  reason?: string
  /** returned: the failure was the environment's (a check that couldn't start), not a result. */
  transient?: boolean
  /** returned: the files a conflict named. */
  files?: string[]
  /** returned by a red check: the check that failed (`install` for the install before them), as its outcome recorded it. */
  check?: string
  /** returned by a red check: its run's log (the window's model only: Show log's run is the one with this log). */
  logPath?: string
  /** returned: its output (the window's model only; the Agent API says whether there is one). */
  log?: string
  /** returned: when the user saw it (ISO; #1356, the window's model only): until then it shows on its queue's card. */
  seen?: string
  /**
   * How long the queue took over it (HI-1924, the window's model only): from its first merge check's start (or, with
   * none, its merge's) to the outcome. Left out when nothing began for it, or old facts can't say.
   */
  tookMs?: number
  /** merged by Combwork (HI-1924, the window's model only): its push (G18), as recorded; left out where nothing is to say. */
  push?: QueuePushState
}

/**
 * A merge's push (G18, HI-1924): pushed; owed and not yet (`pending`); not pushed because pushing was turned off
 * (`off`) or the target no longer had it (`reset`); `unknown`: none recorded (a merge before Combwork recorded pushes),
 * said while the project pushes now.
 */
export type QueuePushState = 'pushed' | 'pending' | 'off' | 'reset' | 'unknown'

/** A pause of a target's queue as its log keeps it (HI-1924): why, on which card, by whom, when, and when it was lifted. */
export interface QueuePauseLogged {
  reason: string
  /** Its card's key ('' : a pause of the queue itself). */
  card: string
  by?: 'user' | 'assistant'
  message?: string
  at: string
  /** When it was lifted (ISO); left out while it holds. */
  ended?: string
}

/** How many pauses, and how many settled pushes, a target's logs keep (HI-1924: the panel's history, as RECENT_MAX). */
export const QUEUE_LOG_MAX = 20

/** Where a listed file of a begun advance stands (#1351): its index and working copy at the expected revision, at the result, or neither. */
export type QueueFileSide = 'expected' | 'result' | 'other'

/**
 * A command that finishes or undoes an advance left part way (#1351), generated from its journal: its arguments as they
 * are (`args`, `git` first; only revisions and a ref name, no paths), run in the project folder (`project`) or the folder
 * the target is checked out in (`folder`), and `command`, the line to type in PowerShell (shellLine).
 */
export interface QueueCommand {
  purpose: 'finish' | 'undo'
  place: 'project' | 'folder'
  args: string[]
  command: string
}

/**
 * Arguments as a PowerShell command line that gives the program exactly these arguments (HR4's #1351 round 1: a ref
 * with `$` in it must reach git as written): an argument of anything but letters, digits and `._/:=+-` is single-quoted,
 * its `'` doubled. Plain otherwise, so a revision or a usual ref reads as typed.
 */
export function shellLine(args: string[]): string {
  return args.map((a) => (/^[A-Za-z0-9._/:=+-]+$/.test(a) ? a : `'${a.replace(/'/g, "''")}'`)).join(' ')
}

/**
 * The state an advance into a checked-out target was left in (§16.9.2's terminal state, #1351): the folder, the branch
 * its HEAD named (null: none, a detached HEAD) and the target's ref (null: unreadable) as Combwork found them, the advance's
 * revisions, the journal's last phase (`done`: the ref moved, but the folder was on another branch by then, so the merged
 * files are in that branch's working copy), each listed file's side, and the commands that finish or undo it.
 */
export interface QueueStuck {
  folder: string
  branch: string | null
  ref: string | null
  expected: string
  result: string
  phase: 'started' | 'files' | 'ref' | 'rollback' | 'done'
  files: { path: string; side: QueueFileSide }[]
  commands: QueueCommand[]
}

/** Why a queue is paused: `user` (Pause queue), or Combwork's own reason (needsYou, checkedOut, rulesOff, …: mergeQueue.ts). */
export interface QueuePauseInfo {
  reason: string
  /** The card it paused on (null: none, a pause of the queue itself). */
  card: string | null
  files: string[]
  /** Who paused it: the user or the Assistant (null: Combwork, for its reason). */
  by: 'user' | 'assistant' | null
  at: string | null
  /** Git's own message, for a pause Combwork made on its output (signing, needs you: #1350). */
  message?: string
  /** An advance into a checked-out target left part way (needsYou, #1351): the state it is in and how to settle it. */
  stuck?: QueueStuck
  /**
   * HI-2988: the owed catch-up's pause (follow mode: `card` merged and published already, the local target behind it):
   * its changes are set aside, never committed there.
   */
  catchUp?: true
}

/** A project's queue for one target. */
/**
 * A target's forward merges (HI-2679; the window's model only): the project's other targets it can be brought up to date
 * with (its Bring up to date… button), and how far behind each one it is: the commits along the other's first-parent
 * history it lacks (a card merged with a merge commit or squashed counts once, a rebased card once per commit); null when
 * a head can't be read (unknown, never zero).
 */
export interface QueueForward {
  others: string[]
  behind: { from: string; commits: number | null }[]
}

export interface QueueView {
  /** The project's folder name and its folder. */
  project: string
  projectPath: string
  target: string
  paused: QueuePauseInfo | null
  /** The profile of the Combwork running this queue now ("Combwork-Dev"; null: none runs it now). */
  runBy: string | null
  /** Whether this Combwork is the one running it now. */
  runHere: boolean
  testing: QueueTesting | null
  queued: QueueQueued[]
  /** Newest first, at most RECENT_MAX. */
  recent: QueueRecent[]
  /**
   * The returns the panel shows (#1356's returns policy; the window's model only), at most RETURNS_MAX: those seen less
   * than RETURN_SEEN_SHOWN_MS ago first (by seen time), then those not seen (newest first) in the slots left. Each is
   * its card's newest outcome, the card not queued or testing again.
   */
  returns: QueueRecent[]
  /** How many returns not seen yet are beyond `returns` (the window's model only): they come as the kept ones fold. */
  returnsMore: number
  /** Its latest pauses, newest first, at most QUEUE_LOG_MAX (HI-1924; the window's model only). */
  pauses: QueuePauseLogged[]
  /** The project's current options have Combwork merge into this target (#1356; the window's model only). */
  combworkMerges: boolean
  /** Its forward merges (HI-2679; the window's model only), where the project has more than one target. */
  forward?: QueueForward
  /**
   * The project's cards in flight (started, not Done) whose own ruleset has Combwork merge into this target, by number
   * (#1356; the window's model only): an old ruleset's queue stays shown while they are.
   */
  inFlight: number[]
  /**
   * HI-2893: a past branch's queue: its target is none of the project's targets now (Work merges into, Other branches work
   * can merge into) and it holds nothing: no entry testing or queued, and (HI-2927) no card in flight into it, no pause
   * and no Combwork running it; unreadable targets make none past. The Merges tab leaves it out, Version Control lists
   * its history under Past branches, and the Agent API lists it only when asked (`past=true`).
   */
  past?: true
}

/**
 * A queue as the Agent API gives it (GET /v1/queue, cw_queue): no folder (a stuck advance's folder neither), and whether
 * an outcome has a log, not the log.
 */
export type QueuePublic = Omit<QueueView, 'projectPath' | 'recent' | 'returns' | 'returnsMore' | 'paused' | 'combworkMerges' | 'inFlight' | 'pauses'> & {
  paused: (Omit<QueuePauseInfo, 'stuck' | 'message'> & { stuck?: Omit<QueueStuck, 'folder'> }) | null
  recent: (Omit<QueueRecent, 'log' | 'seen' | 'revision' | 'tookMs' | 'push' | 'logPath'> & { hasLog?: true })[]
}

/** How many outcomes a queue's model keeps for the panel. */
export const RECENT_MAX = 20
/** How many outcomes a target's history keeps for the Git tab's Merge queue section (#1357). */
export const HISTORY_MAX = 50

/**
 * The card an agent's worktree branch is for, when Combwork merges it (#1357, the Merge dialog): its key and title, its
 * target, and where it stands: testing now, queued (its place, counting the one testing), or not in the queue yet (in
 * review, say); whether the target's queue is paused.
 */
export interface BranchQueueCard {
  card: number
  key: string
  title: string
  target: string
  where: 'testing' | 'queued' | 'notYet'
  position?: number
  paused: boolean
}

/** How many returns a queue's window model holds (those just seen, then those not seen; the count of the rest beside them). */
export const RETURNS_MAX = 50
/** A return the user has seen stays this long, then leaves the queue's card (as a failed run folds once seen). */
export const RETURN_SEEN_SHOWN_MS = 10_000

/** What Resume did: resumed, or paused again because §16.9.2's conditions still fail (the pause as it is now). */
export interface QueueResumed {
  resumed: boolean
  view: QueueView
}
