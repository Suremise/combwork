// A card's fact log (SPEC §16.4): typed, append-only, recorded by Combwork or observed from the platform, and the pure fold
// that derives the card's state from it. The same fold runs in the spike, main and tests (ARCHITECTURE "Facts and
// derived state"). Facts carry platform-neutral words (revision, line, target, result); anything only one platform
// has goes in `data.platform`, which only its adapter reads.
//
// In the app since P3: combwork.db's `card_facts` (main/workflow/factStore.ts), folded wherever a card's state is read.

import type { ConflictsRecord } from './conflicts'
import type { FocusedChoice, FocusedTest } from './focused'
import type { GitlinkSide } from '../gitlink'
import type { StoredText, TransientCause } from '../types'
import { samePath } from '../movePaths'
import type { ForwardOverride } from './forwardOrder'

/** Who caused a fact. */
export type Actor = 'user' | 'assistant' | 'combwork' | 'outside' | `agent:${string}`

export const agentActor = (agent: string): Actor => `agent:${agent}`
export const agentOf = (a: Actor): string | null => (a.startsWith('agent:') ? a.slice(6) : null)

/** Stage ids (§16.5.2). Stable strings; their names are messages, and the user may rename them (OP-30). */
export type StageId = 'hold' | 'todo' | 'active' | 'review' | 'approved' | 'merging' | 'done'

/** The six fixed categories, by today's column ids (§16.5.1): Active is `doing`, Approved is `passed`. */
export type Category = 'hold' | 'todo' | 'doing' | 'review' | 'passed' | 'done'

export const STAGE_CATEGORY: Record<StageId, Category> = { hold: 'hold', todo: 'todo', active: 'doing', review: 'review', approved: 'passed', merging: 'passed', done: 'done' }

/** The stage a column stands for, for a card no 1.0 rule has moved yet (its `stage` empty). */
export const CATEGORY_STAGE: Record<Category, StageId> = { hold: 'hold', todo: 'todo', doing: 'active', review: 'review', passed: 'approved', done: 'done' }

export type CardKind = 'code' | 'no-code'

export interface FileChange {
  path: string
  /** git's letter (A, M, D, R…), or None's A / M / D against the card's start. */
  status: string
  /** HI-2864: Git only, either side a submodule (mode 160000): what each side is, a gitlink's commit with it. */
  gitlink?: { from: GitlinkSide; to: GitlinkSide }
}

/** None: a card's paths with their content hashes (never contents), §16.3.3. */
export type Manifest = Record<string, string>

export interface StartedData {
  /** `project`, or the slot's folder. */
  folder: string
  /** The line the card works on (Git branch); null for None. */
  line: string | null
  /** The revision the card's change starts from: Git, the target's head (slots) or the folder's head; None, the manifest's hash. */
  base: string | null
  target: string | null
  builder: string
  cardKind: CardKind
  /** Slots (#1438): the slot the card is built in, and the lease it holds it by (a lane's, or the card's own). */
  slot?: string
  lease?: string
  /** None: the card's paths and their hashes at the start. */
  manifest?: Manifest
  /** None: every deliverable's hash at the start, which unclaimed changes are found against (§16.4.2). */
  deliverables?: Manifest
  /**
   * `Adopted` only: the folder's head observed at the upgrade (null when it couldn't be read), apart from `base` (§16.17:
   * the card's work so far is base..head). A `Started` fact, and an `Adopted` one written before #1218 round 2, has
   * none: its head is its base.
   */
  head?: string | null
  /** `Adopted` only: the column it was in at the upgrade (§16.17). */
  adoptedFrom?: 'doing' | 'review' | 'passed'
  passedBefore1_0?: boolean
  platform?: Record<string, unknown>
}

export interface SubmittedData {
  /** The revision submitted; null for a no-code card. */
  revision: string | null
  /** The change's endpoints, fixed when submitted (§16.3.2). */
  base: string | null
  head: string | null
  /** The candidate key (Git: patch-id). Never decides sameness on its own. */
  key: string | null
  files: FileChange[]
  round: number
  /** The decision generation the builder had received. */
  generation: number
  /** The same revision as a submission that failed review (with a note). */
  sameRevision: boolean
  summary: string
  note?: string
  /**
   * A follow-up submitted while the card was in Review (HI-1832): a commit its reviewer asked for, made the revision under
   * review with no round counted and no one reassigned; the reviewer starts its review again on it.
   */
  followUp?: boolean
  /** None: the card's declared paths. */
  paths?: string[]
  /** Shared folder: the card's commits, in order. */
  commits?: string[]
  adopted?: boolean
  /** Warnings that didn't refuse (G16). */
  warnings?: string[]
  /** G20 (HI-1367): the tests this submission's change needs, as picked or named by its builder, and the change itself. */
  focused?: FocusedChoice
  platform?: Record<string, unknown>
}

export interface CheckRanData {
  name: string
  command: string
  /** The card's revision the run was for. */
  revision: string
  /** What was checked out where it ran. */
  tested: string
  result: 'passed' | 'failed' | 'stopped'
  run: string
  durationMs: number
  by: string
  /** The agent that ran it (its id), when an agent did: a focused test's proof is its reviewer's own run (HI-1367). */
  agent?: string
  counted: boolean
  whyNot?: 'notCheck' | 'notContained' | 'dirty' | 'changed' | 'moved' | 'revisionChanged'
  /**
   * What made it `changed` (what the watcher saw written: folder-relative paths, ':reflog', ':edit') or `dirty` (the
   * uncommitted files), at most CHANGES_KEPT (#1654); left out where it isn't known (a stat snapshot's fallback).
   */
  changes?: string[]
  isolated?: boolean
  /** The merge queue's entry it ran for (a merge check or the focused tests, HI-1924): the queue history's time taken. */
  entry?: string
}

/** The paths a `CheckRan` keeps of what stopped it counting (#1654). */
export const CHANGES_KEPT = 5

export type ForYouKind = 'approve' | 'decide' | 'test' | 'signIn' | 'other'

/** What the user chose at a card's round limit (§16.11.4). */
export const ROUND_CHOICES = ['carryOn', 'split', 'accept', 'takeOver'] as const
export type RoundChoice = (typeof ROUND_CHOICES)[number]

/** The gate of Combwork's question at a card's round limit (§16.11.4). */
export const ROUND_LIMIT_GATE = 'roundLimit'

/** The gate of Combwork's questions about a builder's line held up between a lane's cards (§16.19.2, #1271). */
export const LINE_GATE = 'lineUpdate'

/**
 * The gate of Combwork's question before it updates a target checked out in a folder (§16.9.2, OP-40, #1351: Settings →
 * Advanced, Merge into a checked-out branch, Ask each time): bound to the queue entry and the target's expected revision.
 */
export const QUEUE_ADVANCE_GATE = 'queueAdvance'

/** HI-1697: the merge queue's question before an upgraded project's first merge: its merge style and commit message. */
export const MERGE_CHOICE_GATE = 'mergeChoice'
/** HI-1697: the project's board meta recording its answer to that question, first (the file follows: optionsForm.ts). */
export const MERGE_CHOICE_KEY = 'mergeChoice'

/** The gate of Combwork's notice that an advance into a checked-out target stopped part way (§16.9.2's terminal state, #1351). */
export const QUEUE_STUCK_GATE = 'queueStuck'

/**
 * G20 (HI-1367): the merge queue's question when a card's focused tests were skipped for their environment, bound to
 * the entry and those tests (`tests`): answered by the card's reviewer agent (cw_focused_skip) or the user.
 */
export const FOCUSED_SKIP_GATE = 'focusedSkip'

/** HI-2014: a finished card's slot kept on its line by uncommitted changes, until they are committed or discarded. */
export const SLOT_DIRTY_GATE = 'slotDirty'

/**
 * HI-1183: the merge queue's question when a follow-mode publication's outcome is unknown and the remote doesn't show it
 * (§16.9.4): Approve, it was published (the card Done); Decline, it wasn't (tested again). Bound to the entry and result.
 */
export const QUEUE_PUBLISH_GATE = 'queuePublish'

/** A follow-mode attempt's endpoint as a fact keeps it (HI-1183): never a credential. */
export interface PublishFact {
  remote: string
  endpoint: string
  ref: string
  onto: string
  snapshot: string
  digest: string
}

/**
 * What an agent's question may offer the user to do on its card (#1630): move it to Done, make it no code, unblock it,
 * skip its review (HI-1734), each with the agent's suggested reason. One click does it as the user, with the reason, and
 * answers the question.
 */
export const ASK_ACTIONS = ['done', 'noCode', 'unblock', 'skipReview'] as const
export type AskActionKind = (typeof ASK_ACTIONS)[number]
export interface AskAction {
  kind: AskActionKind
  reason?: string
}
/** At most this many actions on one question. */
export const ASK_ACTIONS_MAX = 3

/**
 * The gates of Combwork's own requests (§16.8.5): the user's review, the OK before merging, the round limit, a line held up,
 * the merge queue's (an advance to approve, one stopped part way) and a decision after a merge (asked on a Done card).
 * A request under any other gate is a question someone asked: an agent, the Assistant (`ask`), or a rule it couldn't
 * keep. A question settled another way is closed (#1638); Combwork's own requests stay until met.
 */
const CW_GATES: ReadonlySet<string> = new Set(['review', 'okBefore', ROUND_LIMIT_GATE, LINE_GATE, QUEUE_ADVANCE_GATE, QUEUE_STUCK_GATE, QUEUE_PUBLISH_GATE, FOCUSED_SKIP_GATE, SLOT_DIRTY_GATE, 'decision'])
export const askedQuestion = (r: Pick<FactData['ApprovalRequested'], 'gate'>): boolean => !CW_GATES.has(r.gate)

/** An answer as the user gives it (§16.8.5): its outcome, whether it has a reply or a decision, a choice and its rounds, or an action offered (#1630). */
export interface AnswerShape {
  outcome: 'approved' | 'declined' | 'answered'
  reply?: boolean
  decision?: boolean
  choice?: RoundChoice
  rounds?: number
  action?: AskActionKind
}

/**
 * Whether an answer fits its request (§16.8.5, #1269): at the round limit, a choice (a carry on with 1 to `maxRounds`
 * more rounds), nothing else; an approval (kind Approve), approved or declined (a reply may say why), never a decision
 * but one: an agent's question approved with a note, which is its decision too (HI-2286, `approveNote`); any other
 * question, answered with a reply or a decision, or with one of the actions it offers (#1630), never both.
 */
export function answerFits(req: Pick<FactData['ApprovalRequested'], 'kind' | 'gate' | 'actions'>, a: AnswerShape, maxRounds: number): boolean {
  if (req.gate === ROUND_LIMIT_GATE) return a.outcome === 'answered' && !!a.choice && ROUND_CHOICES.includes(a.choice) && !a.decision && !a.action && (a.choice !== 'carryOn' || (Number.isInteger(a.rounds) && a.rounds! >= 1 && a.rounds! <= maxRounds))
  if (a.choice !== undefined) return false
  if (a.action !== undefined) return a.outcome === 'answered' && !a.decision && !!req.actions?.some((x) => x.kind === a.action)
  if (req.kind === 'approve') return (a.outcome === 'approved' || a.outcome === 'declined') && (!a.decision || (a.outcome === 'approved' && !!a.reply && approveNote(req) === 'decision'))
  return a.outcome === 'answered' && (!!a.reply || !!a.decision)
}

/**
 * What a note given with Approve becomes (HI-2286): on an agent's question (gate `ask`), a reply and the user's decision
 * on the card (the asker works against decisions, and a reviewer checks them); on one offering a single action, that
 * action's reason (approving it is the action, HI-1734); on Combwork's own gates (the user's review, the OK before merging,
 * the merge queue's advance), a reply only: approving moves the card on at once, so a decision would come too late.
 */
export const approveNote = (r: Pick<FactData['ApprovalRequested'], 'gate' | 'actions'>): 'decision' | 'reason' | 'comment' => (r.actions?.length === 1 ? 'reason' : r.gate === 'ask' ? 'decision' : 'comment')

/**
 * Whether a decision the user made may answer a request (HI-1932, Darren's decision: the Assistant records it naming
 * the requests it answers): a question someone asked (an agent, the Assistant, a rule it couldn't keep), answered with a
 * decision. Never one of Combwork's own gates (a review, the OK before merging, the round limit's choice, the merge queue's),
 * the merge queue's merge choice, or an approval: those are approved, declined or chosen in For you.
 */
export const decisionAnswers = (r: Pick<FactData['ApprovalRequested'], 'kind' | 'gate' | 'actions'>): boolean => askedQuestion(r) && r.gate !== MERGE_CHOICE_GATE && answerFits(r, { outcome: 'answered', decision: true }, 1)

/** The most requests one decision answers (HI-1932). */
export const DECISION_ANSWERS_MAX = 20

/**
 * `pushRefused` and `notPublished` (HI-1183, follow mode): the publication was refused (the project's pre-push hook, or the
 * remote: a hook, a protected branch) before anything was written, or the user said an unknown one wasn't published;
 * both transient, the card queued again. `direction` (HI-2892): a forward merge against the release path's direction with no
 * override recorded for its pair, never merged (forwardOrder.ts). `resolution` (HI-2999): a forward's resolution whose
 * revision lacks the commit it resolves (cherry-picked or copied, not merged), never merged.
 */
export type IntegrationFailReason = 'conflict' | 'checks' | 'targetMoved' | 'folderBusy' | 'notUpToDate' | 'hook' | 'focused' | 'pushRefused' | 'notPublished' | 'direction' | 'resolution'

/**
 * Why the queue returned a card for its focused tests (G20, HI-1367), with `IntegrationFailed.focused`: none chosen for
 * its submission (`notChosen`); the result's own changes couldn't be picked (`repick`: their `paths`); a real-CLI or
 * packaged test with no counted review run at the submitted revision (`noProof`), or one only the result's pick added
 * (`newProof`): their `tests`; its runner missing from the project (`noRunner`).
 */
export interface FocusedReturn {
  why: 'notChosen' | 'repick' | 'noProof' | 'newProof' | 'noRunner'
  tests?: string[]
  paths?: string[]
}

/** The data of each kind (§16.4.2). */
export interface FactData {
  Started: StartedData
  Adopted: StartedData
  Submitted: SubmittedData
  CheckRan: CheckRanData
  ReviewStarted: { reviewer: string; submission: number; revision: string | null; reviewCopy?: string }
  /**
   * The reviewer pool (#1443, G17) gave the card's submission to a free pooled reviewer: it reviews that submission. With
   * G1b = 2, a second one after the first passes. `design` (HI-2310): what it was given is the builder's design step (its
   * `LoopStep` fact's seq in `submission`), to answer, not a submission to review.
   */
  ReviewerAssigned: { reviewer: string; submission: number; design?: true }
  /**
   * A pool's assignment given up before its review started (#1443): its reviewer stopped being free for it (it took a
   * dispatch lease, its role no longer reviews, it left the project). The submission waits for the pool again.
   */
  ReviewerReleased: { reviewer: string; submission: number; why: 'leased' | 'notReviewer' | 'gone'; design?: true }
  /**
   * `accepted` (HI-2660, a pass only): others' focused-test runs at its revision that the reviewer accepts as review
   * evidence (realProof = review): each test, the original run's id and the agent that ran it, never relabelled.
   */
  Verdict: { reviewer: string; submission: number; revision: string | null; pass: boolean; failKind?: 'content' | 'explanation'; round: number; generation: number; comment: string; accepted?: { test: string; run: string; agent?: string }[] }
  CarriedOver: { from: string; to: string; toBase: string | null; how: 'replay' | 'sameRevision' }
  Updated: { entry: string; from: string; to: string; how: 'mergedTarget' | 'rebased'; carried: boolean }
  LineMoved: { line: string; from: string; to: string; why: 'squashContinuation' }
  /** The card's line renamed (#1305: Repair renaming an agent's branch named after an old place): its work follows it. */
  LineRenamed: { from: string; to: string; why: 'repair' }
  /** A Done card's line deleted (#1438): its target contained it at `revision`, and nothing had it checked out. */
  LineDeleted: { line: string; revision: string; why: 'merged' }
  /**
   * A Done card's merged line about to be deleted (#1438, HR1's round 2): written before its ref is removed, so a deletion
   * cut short (a crash) is settled by the next pass: `LineDeleted`, or `LineDeleteUndone` with the ref put back at
   * `revision` where a checkout of it came in meanwhile.
   */
  LineDeleting: { line: string; revision: string }
  /** A deletion begun and not done: kept (`checkedOut`: a checkout of it came in, its ref put back), or never removed. */
  LineDeleteUndone: { line: string; revision: string; why: 'checkedOut' | 'notDeleted' }
  /**
   * A card's slot made ready for its start (#1438): the line checked out at `revision` (installed again with G15) under
   * `lease`. Written after the slot's preparation, in a write that finds the card's start the same: until then the start's
   * preparation is owed, and a pass of Combwork's (after a restart too) does it.
   */
  SlotPrepared: { lease: string; line: string; revision: string }
  /**
   * A card's slot couldn't be prepared for its start (HI-2913): `why` as Combwork told the builder (English), `stale` when
   * the reason was a stale jj workspace (its Recover…). Written in a write that finds the card's start the same and not
   * prepared; until a later `SlotPrepared` for the same lease, the card isn't started there (the window says not ready),
   * and the user's Recover… of that slot is let through while its lease holds it.
   */
  SlotPrepareFailed: { lease: string; slot: string; why: string; stale: boolean }
  /** Its builder's placement in the slot claimed by a Combwork (its process), so two never place it; one gone is taken over. */
  PlacementClaimed: { lease: string; pid: number; started: number }
  /** Its builder given the card in the slot: typed in, or a new conversation started there; `delivery` the one made. */
  /** `resumed`: its builder's conversation bound to the lease, resumed with the card (HI-1746). */
  BuilderPlaced: { lease: string; delivery: string | null; how: 'typed' | 'newConversation' | 'started' | 'resumed' }
  /** The card's folder moved (#1343: Repair relinking or recreating the agent's worktree at a new place): its work follows it. */
  FolderMoved: { from: string; to: string; why: 'repair' }
  /**
   * A line's move begun (#1271): written before it, so a move with no outcome after it (`LineMoved`, or
   * `LineMoveUndone`) holds the next card until it is settled.
   */
  LineMoving: { line: string; from: string; to: string }
  /** A line's move begun and not made: everything as it was (put back, or found so), the move's outcome (#1271). */
  LineMoveUndone: { line: string; at: string }
  CommitAttributed: { commit: string; how: 'trailer' | 'onlyCard' | 'assigned' }
  Stale: { approved: string | null; current: string | null; why: 'change' | 'decision' | 'exact' }
  /** `text` in English (agents, the Agent API); `requestText`, Combwork's own request as data for the window (an agent's words have none). */
  /** `entry` and `result`: the queue entry a merge queue's request is about, and its test merge's result (#1351). */
  ApprovalRequested: { request: string; kind: ForYouKind; gate: string; revision?: string | null; submission?: number; text: string; requestText?: StoredText; stage?: StageId; generation?: number; for?: 'user'; asker?: string; checklist?: string[]; entry?: string; result?: string; actions?: AskAction[]; tests?: string[] }
  /**
   * A request closed without an answer (#1638): its card reached Done (`done`), or the agent that asked moved the card
   * on itself (`carriedOn`: answered some other way, such as in its pane). It leaves For you as an answer does.
   */
  /** `slotClean` (HI-2014): a finished card's slot asked about (SLOT_DIRTY_GATE) became clean, or another card's. */
  RequestClosed: { request: string; why: 'done' | 'carriedOn' | 'slotClean' }
  /** An answer (§16.8.5): `note` the user's reply; at the round limit, their `choice` and the rounds a carry on adds; `action`, an action the question offered, done (#1630; `note` its reason). */
  /** `byDecision` (HI-1932): answered by a decision the user made, recorded on the card (its id), by whom (the authenticated recorder), when. */
  Approval: { request: string; answer: 'approved' | 'declined' | 'answered'; note?: string; generation: number; submission?: number; choice?: RoundChoice; rounds?: number; action?: AskActionKind; byDecision?: { decision: string; recordedBy: string; at: string } }
  IntegrationRequested: { entry: string; revision: string; key: string | null; target: string; style: 'merge' | 'squash' | 'rebase'; requeue?: 'transient' | 'retry' }
  /** `followUp`: a follow-up posted on the queued card (#1623), so the queue can't merge the revision while its line changes. */
  IntegrationCancelled: { entry: string; reason: 'removed' | 'stale' | 'hold' | 'user' | 'decision' | 'integratedOutside' | 'followUp' }
  /**
   * `publish` (HI-1183, follow mode): the attempt's endpoint as it may be kept (the remote's name, its URL without
   * credentials, the full ref), the remote's head it was tested on (`onto`), and its protected snapshot's id and digest
   * (queueTransportStore.ts). Its phases are `prePush` and `push`, never `files`/`ref`: nothing local moves in it.
   */
  IntegrationStarted: { entry: string; expected: string; result: string; files?: string[]; checkedOut?: string | null; publish?: PublishFact }
  IntegrationPhase: { entry: string; phase: 'files' | 'ref' | 'rollback' | 'prePush' | 'push' }
  /** `cause` and `code`: why a transient failure was one (#1362), as codes; `code` is the network error code found. */
  /** `check`: the merge check that failed (`install` for the install before them), `logPath` its log (#1354). */
  /** `conflicts` (HI-1181): a conflict's files and hunks as the queue's folder had them, bounded (shared/workflow/conflicts.ts). */
  IntegrationFailed: { entry: string; revision: string; target: string; reason: IntegrationFailReason; files?: string[]; log?: string; transient: boolean; cause?: TransientCause; code?: string; check?: string; logPath?: string; conflicts?: ConflictsRecord; focused?: FocusedReturn }
  /**
   * G20 (HI-1367): the tests the merge queue picked at a test merge's result for the paths whose change isn't exactly the
   * submission's (`paths`), run with the approved selection there; `tests` empty when the pick needed none.
   */
  FocusedPicked: { entry: string; revision: string; result: string; paths: string[]; tests: FocusedTest[] }
  /**
   * G20, realProof = review (the user's decision, 28 Oct): a real-CLI or packaged test accepted as proved by its reviewer's
   * counted run at the submitted revision (`run`), review evidence at that revision, never a run at the merged result.
   * HI-2660: or another agent's run there that its reviewer's pass accepted (`acceptedBy`, that reviewer; `run` the
   * original run, its agent its own).
   */
  FocusedAccepted: { entry: string; revision: string; result: string; test: string; run: string; acceptedBy?: string }
  Integrated: { entry?: string; revision: string; target: string; result: string; method: 'merge' | 'squash' | 'fastForward' | 'sameTree' | 'committed'; by: 'combwork' | 'agent' | 'outside'; outsideRules?: string[]; platform?: Record<string, unknown> }
  /** Some of an unfinished card's work found in the target (a partial hand merge): a mark, not a move (§16.4.4). */
  MergedInPart: { revision: string; target: string }
  /**
   * HI-2709: a card in Review whose submitted change (`submission`, its fact's seq) is found in its target already (a hand
   * merge, or another card's merge that carried it): a mark, not a move. The card stays in Review and its review decides;
   * once that passes, the queue (or the merge's report) finds the change in the target and closes it as merged.
   */
  InTarget: { revision: string; target: string; submission: number }
  /** A Done card's revision no longer in its target (the target was reset): a mark (§16.4.4). */
  LeftTarget: { revision: string; target: string }
  /** HI-2988: a Done card marked `LeftTarget` whose result is in its target again: the mark cleared. */
  BackInTarget: { revision: string; target: string }
  Accepted: { revision?: string; submission?: number }
  /** `why`: the agent's own reason, given with a put back (#1267). */
  /** `repair` (HI-1674): a card the board had in Done while its stage wasn't, brought into line when its workspace opens. */
  Moved: { from: StageId; to: StageId; cause: 'intent' | 'user' | 'derived' | 'override' | 'repair'; why?: string }
  /** The refusal's English (agents read it) and its rule and values, which the window shows translated (refusalLines). */
  Refused: { move: string; rule: string; message: string; next: string; values?: Record<string, string | number | StoredText> }
  Override: { rules: string[]; move: string; by: 'user' | 'assistant'; reason: string }
  /** A project agent proposed the card's kind when it made it (§16.7.3, OP-6/OP-7, #1277): no code, until confirmed. */
  KindProposed: { kind: CardKind }
  /** The user or the Assistant answered a proposed kind (#1277): `kind` is the card's kind from now on. */
  KindDecided: { kind: CardKind; proposed: CardKind }
  /** A project agent proposed, when it made the card, that it skip review (#1625), with its reason: until answered. */
  ReviewSkipProposed: { reason: string }
  /**
   * The card skips review, or no longer does (#1625): the user's (`reason` their optional note) or the Assistant's (the
   * user's reason, required). `proposed`: the agent's reason it answers, kept for history only.
   */
  ReviewSkipSet: { skip: boolean; by: 'user' | 'assistant'; reason: string; proposed?: string }
  /**
   * HI-2679: this card is a forward merge, bringing `to` up to date with `from` (two of its project's targets), asked by the
   * user or the Assistant (`by`) through Combwork's forward request alone, never from a card's fields. `source`: `from`'s
   * head as asked (each attempt's own frozen commit is its entry's `revision`). Written right after its `Started` (whose
   * line is null: the source is never the card's branch); its authority for the queue in place of a review (§16.9).
   */
  /** HI-2892: `override`, the user's explicit choice of a pair against the release path's direction (forwardOrder.ts). */
  ForwardRequested: { from: string; to: string; source: string; by: 'user' | 'assistant'; reason?: string; override?: ForwardOverride }
  /**
   * HI-2959: this card resolves a forward merge the queue returned (`forward`: its key), made for a builder by Resolve on
   * a builder (the user's or the Assistant's): its work merges `from` at `source` (the returned attempt's frozen commit)
   * into `to`. Written while it is in Todo, before its start, and kept over every cycle: its rules always merge it as a
   * merge commit (`mergeCommitOf`), so the destination keeps the source's history. `override` (HI-2998): the forward's
   * own request's (HI-2892), carried so the queue checks the resolution's direction at each attempt as the forward's.
   */
  ForwardResolution: { forward: string; from: string; to: string; source: string; by: 'user' | 'assistant'; override?: ForwardOverride }
  /**
   * HI-3040: the user's explicit override of the release path's direction, recorded on a resolution the queue returned
   * for its direction (`entry`: that failed entry's id), by a forward request with the override for its pair. Sets the
   * resolution's `override`, and lets its same revision go back in once, as a requeue bound to that entry.
   */
  ResolutionOverride: { override: ForwardOverride; entry: string; by: 'user' | 'assistant' }
  /**
   * HI-2753: a card in flight moved from the target it started on (`from`) to `to`, its line kept, by the user or the
   * Assistant (`by`): proved at `head` (the line's) and `toHead` (`to`'s) that everything it would bring into `to` is its
   * own (`retargetCard.ts`). `base`: its latest submission's merge base with `to` (a card reviewed: the same commits), which
   * the fold puts on that submission and its approval. `lane`: its running lane, moved with it in the same write.
   */
  Retargeted: { from: string; to: string; line: string; head: string; toHead: string; by: 'user' | 'assistant'; base?: string; lane?: string }
  Blocked: { reason: string }
  Unblocked: Record<string, never>
  /** A decision added, its words changed, or removed (`removed`, its last words): each a new generation (#1216). */
  Decision: { decision: string; generation: number; text: string; removed?: boolean }
  /**
   * What an agent has received of the card: its decisions up to `generation`, and (HI-2854) the user's comments up to
   * `comments` (a UserComment's generation), when the receipt covers them.
   */
  DecisionsReceived: { agent: string; generation: number; comments?: number }
  /** HI-2854: a comment the user wrote on the card (its id), each a new comment generation: what cw_submit checks the builder has seen. */
  UserComment: { comment: string; generation: number }
  /**
   * Paths the card's builder took Combwork's file locks on this cycle (#1481, G16: its own changes in a shared folder),
   * relative to the project folder with `/`: each only once a cycle, and only while the card is its builder's current one.
   */
  FilesLocked: { agent: string; paths: string[] }
  CannotWithinRules: { rule: string; why: string; request: string }
  ReviewerRequest: { text: string }
  /**
   * A step of a card loop between its builder and its reviewer that moves nothing (#1382, #1467): LOOP_STEPS. A design or
   * a follow-up names itself (`design`, `<key>/s<seq>`); a design also when its check is due (`until`, ISO: its post and
   * the Design check wait then, `waitMinutes`); an answer or going ahead names the step it is about (`design`) and its
   * kind (`of`).
   */
  LoopStep: { step: LoopStepId; text: string; design?: string; until?: string; waitMinutes?: number; of?: LoopAsk }
  HeadMoved: { line: string | null; from: string | null; to: string | null; key?: string | null }
  TargetMoved: { target: string; from: string | null; to: string | null }
  Gone: { what: 'line' | 'folder' | 'repository' | 'deliverables' }
  LaneChanged: { lane: string; before: number[]; after: number[] }
  Undone: { fact: number; by: Actor }
  /**
   * The card reached Done (HI-2014, the one finish path): written with every move into Done, whatever made it, and what
   * follows (its slot, line, dependents, lane, requests) hangs off it (`finish` action). `how`: the route; `verified`:
   * the merge commit the target was found to hold (its `Integrated` result), else null; `claimed`: a result a builder
   * reported that nothing checked (Not checked), never read as containment. `by`/`reason`: an override's.
   */
  Finished: { how: FinishHow; verified: string | null; claimed?: string | null; by?: 'user' | 'assistant'; reason?: string }
  /** A step of a finish done, or left (`superseded`: what it was for is no longer so), once each (HI-2014). */
  FinishStep: { finish: number; step: FinishStepId; outcome: 'done' | 'superseded'; why?: string }
}

/** How a card reached Done (HI-2014): the queue, a builder's merge report (checked or not), accepted, an override, a board move. */
export type FinishHow = 'queue' | 'reported' | 'unchecked' | 'accepted' | 'override' | 'board'
/** The steps of a finish (HI-2014) a fact records as done: the board's own effects, each once. */
export type FinishStepId = 'requests' | 'dependents' | 'lane' | 'wake' | 'journal'

export type FactKind = keyof FactData

export interface Fact<K extends FactKind = FactKind> {
  seq: number
  card: number
  kind: K
  at: string
  actor: Actor
  source: 'recorded' | 'observed'
  /** The ruleset the fact was decided under. */
  ruleset?: string
  /** Observed facts: what makes two observers' copies of one transition the same (§16.17), unique per card and kind. */
  dedupe?: string
  data: FactData[K]
}

/** A fact before the store gives it its seq and time. */
export type NewFact<K extends FactKind = FactKind> = Omit<Fact<K>, 'seq' | 'at' | 'card'>

export const isKind = <K extends FactKind>(f: Fact, k: K): f is Fact<K> => f.kind === k

// --- Derived state (§16.4.3).

export interface Submission extends SubmittedData {
  id: number
  by: string | null
}

/** A request to the user (For you, §16.8.5), with when it was asked (`asker`: the agent whose own question it is). */
export type Request = FactData['ApprovalRequested'] & { at: string }

export interface QueueEntry {
  id: string
  seq: number
  revision: string
  target: string
  requeue?: 'transient' | 'retry'
  state: 'open' | 'started' | 'cancelled' | 'failed' | 'integrated'
  failure?: FactData['IntegrationFailed']
  cancelled?: FactData['IntegrationCancelled']['reason']
  started?: FactData['IntegrationStarted']
  phases: FactData['IntegrationPhase']['phase'][]
  /** G8 (#1352): the reviewed revision brought up to date with the target for this entry, the change the same. */
  updated?: Pick<FactData['Updated'], 'from' | 'to' | 'how'>
}

export interface CardState {
  stage: StageId
  /** The seq of the cycle's Started (or Adopted); 0 before the first start. */
  cycle: number
  started: (StartedData & { seq: number; adopted: boolean }) | null
  /**
   * Every line it has started on (Started, Adopted), over its whole history, renames followed (HI-1823): a card back from
   * Done may start again elsewhere (the project folder, another line), and its earlier line still holds its work.
   */
  lines: string[]
  submissions: Submission[]
  latest: Submission | null
  /** Reviewers who started a review, per submission id. */
  reviewing: Record<number, string[]>
  verdicts: (FactData['Verdict'] & { seq: number })[]
  /** The newest decision generation on the card (0: none). */
  generation: number
  /** The generation each agent has received. */
  received: Record<string, number>
  /** HI-2854: the newest UserComment generation on the card (0: none). */
  commentGeneration: number
  /** HI-2854: the comment generation each agent has received. */
  receivedComments: Record<string, number>
  /** The revision the latest submission's passes now cover (moved by carry-overs and the queue's updates), and its base. */
  approved: { revision: string | null; base: string | null } | null
  /** A content-stale pass (a new revision that isn't the same change), until the builder submits again or its line returns to the approved revision. */
  stale: FactData['Stale'] | null
  /** HI-2679: a forward merge's request (its `ForwardRequested`), this cycle's; null for every other card. */
  forward: FactData['ForwardRequested'] | null
  /** HI-2959: the forward merge this card resolves (its `ForwardResolution`), over every cycle; null for every other card. */
  resolves: FactData['ForwardResolution'] | null
  /** HI-3040: the queue entry a recorded `ResolutionOverride` lets its revision requeue after (once), or null. */
  overrideEntry: string | null
  /** Open requests to the user: For you, each with when it was asked. */
  requests: Request[]
  /** Every request made this cycle, by id (answered or not). */
  made: Record<string, Request>
  approvals: FactData['Approval'][]
  entries: QueueEntry[]
  integrated: FactData['Integrated'] | null
  accepted: FactData['Accepted'] | null
  /** Rounds: failed verdicts and the user's declines (§16.11.4), over the card's whole history. */
  rounds: number
  /** The rounds the user added at the round limit ("carry on"), over the card's whole history. */
  moreRounds: number
  /** Every agent recorded working the card (Started, Submitted): no-self-review reads these, never commit authors. */
  builders: string[]
  overrides: FactData['Override'][]
  /** The user (or the Assistant) moved the latest submission past its review and approvals, as a recorded override. */
  approvalOverridden: boolean
  /** The last observed head of the card's folder. */
  head: string | null
  /** The last observed HeadMoved's seq this cycle (what the next observation follows), else the cycle's start. */
  lastHeadFact: number
  attributed: string[]
  /** The paths the builder locked this cycle (`FilesLocked`, #1481), in order, each once. */
  locked: string[]
  checks: FactData['CheckRan'][]
  /** G20 (HI-1367): real-CLI and packaged focused tests accepted from their review at the merge (realProof = review). */
  focusedAccepted: FactData['FocusedAccepted'][]
  marks: { mergedInPart?: FactData['MergedInPart']; inTarget?: FactData['InTarget']; leftTarget?: FactData['LeftTarget']; outsideRules?: string[] }
  blocked: string | null
  /**
   * A card loop's step waiting on the other side (#1382, #1467): the builder's design or follow-up posted for its
   * reviewer's check, until the reviewer answers, the builder goes ahead with a design, or the card moves, is submitted or
   * given a verdict.
   */
  step: { step: LoopAsk; id: string; seq: number; at: string; until: string | null; by: string | null } | null
  /** When the content-stale pass (`stale`) went stale: its `Stale` fact's time, which nothing later moves (HI-1763's stall). */
  staleSince: string | null
  /** The card's finish while it is in Done (HI-2014): its `Finished` with its seq, and the steps of it done. */
  finished: (FactData['Finished'] & { seq: number; steps: FinishStepId[] }) | null
  lastSeq: number
}

/**
 * A card loop's steps (#1382, #1467, SPEC §16.8.1): the builder's `design` (posted for the reviewer's check, in Doing),
 * `followUp` (a follow-up asked of the work, such as a screenshot change, ready for the reviewer's check, in Review or
 * Passed) and `proceed` (no answer to a design within the bound: building as posted); the reviewer's `ok` and `gaps`
 * (its answer to the step waiting).
 */
export const LOOP_STEPS = ['design', 'followUp', 'ok', 'gaps', 'proceed'] as const
export type LoopStepId = (typeof LOOP_STEPS)[number]
/** The steps that ask the reviewer to check something, and wait for its answer. */
export type LoopAsk = 'design' | 'followUp'
/** Whose step it is: the builder's, sent to the reviewer, or the reviewer's answer, sent to the builder. */
export const loopStepSide = (step: LoopStepId): 'builder' | 'reviewer' => (step === 'ok' || step === 'gaps' ? 'reviewer' : 'builder')

export const emptyState = (): CardState => ({
  stage: 'todo',
  cycle: 0,
  started: null,
  lines: [],
  submissions: [],
  latest: null,
  reviewing: {},
  verdicts: [],
  generation: 0,
  received: {},
  commentGeneration: 0,
  receivedComments: {},
  approved: null,
  stale: null,
  forward: null,
  resolves: null,
  overrideEntry: null,
  staleSince: null,
  requests: [],
  made: {},
  approvals: [],
  entries: [],
  integrated: null,
  accepted: null,
  rounds: 0,
  moreRounds: 0,
  builders: [],
  overrides: [],
  approvalOverridden: false,
  head: null,
  lastHeadFact: 0,
  attributed: [],
  locked: [],
  checks: [],
  focusedAccepted: [],
  marks: {},
  blocked: null,
  step: null,
  finished: null,
  lastSeq: 0
})

const addOnce = (list: string[], x: string): string[] => (list.includes(x) ? list : [...list, x])

/** A request a gate waits on (the user's review, or the OK before merging), bound to its submission, stage and generation. */
const isGateRequest = (r: FactData['ApprovalRequested']): boolean => r.gate === 'review' || r.gate === 'okBefore'

/** An entry's outcome retires the merge queue's requests about it (#1351): it can't be updated or stuck any more. */
const retireEntry = (s: CardState, entry: string): void => {
  s.requests = s.requests.filter((r) => r.entry !== entry)
}

/** Folds a card's facts (in seq order) into its state. Pure: the stage is the last `Moved`'s, never a claim. */
export function foldCard(facts: readonly Fact[], initial: StageId = 'todo'): CardState {
  const s = emptyState()
  s.stage = initial
  for (const f of facts) {
    s.lastSeq = Math.max(s.lastSeq, f.seq)
    const by = agentOf(f.actor)
    // A loop step waits only while the card stays where it was: a move, a submission or a verdict ends it (#1382).
    if (f.kind === 'Moved' || f.kind === 'Submitted' || f.kind === 'Verdict') s.step = null
    switch (f.kind) {
      case 'Started':
      case 'Adopted': {
        const d = f.data as StartedData
        // A new cycle: earlier submissions, verdicts and entries stay in history but don't count (§16.7.4).
        // A question at the round limit outlives the cycle: it waits for the user's answer (§16.11.4).
        const limit = s.requests.filter((r) => r.gate === ROUND_LIMIT_GATE)
        Object.assign(s, { ...emptyState(), stage: s.stage, generation: s.generation, received: s.received, commentGeneration: s.commentGeneration, receivedComments: s.receivedComments, rounds: s.rounds, moreRounds: s.moreRounds, builders: s.builders, overrides: s.overrides, blocked: s.blocked, resolves: s.resolves, lastSeq: s.lastSeq, lines: s.lines })
        s.requests = limit
        for (const r of limit) s.made[r.request] = r
        s.cycle = f.seq
        s.lastHeadFact = f.seq
        s.started = { ...d, seq: f.seq, adopted: f.kind === 'Adopted' }
        if (d.line) s.lines = addOnce(s.lines, d.line)
        s.head = d.head !== undefined ? d.head : d.base
        s.builders = addOnce(s.builders, d.builder)
        break
      }
      case 'Submitted': {
        const d = f.data as SubmittedData
        const sub: Submission = { ...d, id: f.seq, by }
        s.submissions.push(sub)
        s.latest = sub
        s.approved = { revision: d.revision, base: d.base }
        s.stale = null
        s.staleSince = null
        // A new submission retires the requests bound to an earlier one: they can't approve this one.
        s.requests = s.requests.filter((r) => r.submission === undefined)
        s.approvalOverridden = false
        if (by) s.builders = addOnce(s.builders, by)
        break
      }
      case 'ReviewStarted': {
        const d = f.data as FactData['ReviewStarted']
        s.reviewing[d.submission] = addOnce(s.reviewing[d.submission] ?? [], d.reviewer)
        break
      }
      case 'Verdict': {
        const d = f.data as FactData['Verdict']
        s.verdicts.push({ ...d, seq: f.seq })
        if (!d.pass) s.rounds++
        break
      }
      case 'CarriedOver': {
        const d = f.data as FactData['CarriedOver']
        s.approved = { revision: d.to, base: d.toBase }
        // Its line back at exactly the revision a stale pass was for (#1623): the reviewer passed that commit, so it holds.
        if (d.how === 'sameRevision' && s.stale?.approved === d.to) s.stale = null
        if (!s.stale) s.staleSince = null
        break
      }
      case 'Updated': {
        // The queue brought the reviewed revision up to date for one entry (G8, #1352): that entry's, never the card's
        // approved revision, which stays the reviewed one (the builder's line; reconciliation and requeues read it).
        const d = f.data as FactData['Updated']
        const e = s.entries.find((x) => x.id === d.entry)
        if (e && d.carried) e.updated = { from: d.from, to: d.to, how: d.how }
        break
      }
      case 'Stale': {
        const d = f.data as FactData['Stale']
        // A decision makes passes stale by generation; only a content-stale pass waits for the builder (§16.4.6).
        if (d.why !== 'decision') {
          // Its start, kept while the same stale pass stands (HI-1763: the stall counts from here).
          if (!s.stale || s.stale.current !== d.current || s.stale.approved !== d.approved) s.staleSince = f.at
          s.stale = d
        }
        break
      }
      case 'ApprovalRequested': {
        const d: Request = { ...(f.data as FactData['ApprovalRequested']), at: f.at }
        // The merge queue asks again (the target moved, a new test merge): its earlier request of that gate is retired.
        if (d.entry) s.requests = s.requests.filter((r) => !r.entry || r.gate !== d.gate)
        s.requests.push(d)
        s.made[d.request] = d
        break
      }
      case 'CannotWithinRules':
        break
      case 'LoopStep': {
        const d = f.data as FactData['LoopStep']
        // A design or a follow-up (a new one replaces the one waiting); anything else ends the one it names (the runtime
        // refuses others).
        s.step = d.step === 'design' || d.step === 'followUp' ? { step: d.step, id: d.design ?? '', seq: f.seq, at: f.at, until: d.until ?? null, by } : null
        break
      }
      case 'RequestClosed':
        s.requests = s.requests.filter((r) => r.request !== (f.data as FactData['RequestClosed']).request)
        break
      case 'Approval': {
        const d = f.data as FactData['Approval']
        s.approvals.push(d)
        s.requests = s.requests.filter((r) => r.request !== d.request)
        // A decline of a gate's request is a reviewed round (§16.11.4); of an agent's own question, only its answer.
        const made = s.made[d.request]
        if (d.answer === 'declined' && (!made || isGateRequest(made))) s.rounds++
        if (d.rounds) s.moreRounds += d.rounds
        break
      }
      case 'ForwardRequested': {
        s.forward = f.data as FactData['ForwardRequested']
        break
      }
      case 'ForwardResolution': {
        s.resolves = f.data as FactData['ForwardResolution']
        break
      }
      case 'ResolutionOverride': {
        const d = f.data as FactData['ResolutionOverride']
        if (!s.resolves) break
        s.resolves = { ...s.resolves, override: d.override }
        s.overrideEntry = d.entry
        break
      }
      case 'Retargeted': {
        // HI-2753: its target from here on is the new one; its line, base, submissions and verdicts stay. Its latest
        // submission's base is the one with the new target (the same commits, checked as it was written).
        const d = f.data as FactData['Retargeted']
        if (!s.started) break
        s.started = { ...s.started, target: d.to }
        if (d.base && s.latest) {
          const sub = { ...s.latest, base: d.base }
          s.submissions = s.submissions.map((x) => (x.id === sub.id ? sub : x))
          if (s.approved && s.approved.revision === s.latest.revision) s.approved = { ...s.approved, base: d.base }
          s.latest = sub
        }
        break
      }
      case 'IntegrationRequested': {
        const d = f.data as FactData['IntegrationRequested']
        s.entries.push({ id: d.entry, seq: f.seq, revision: d.revision, target: d.target, ...(d.requeue ? { requeue: d.requeue } : {}), state: 'open', phases: [] })
        break
      }
      case 'IntegrationCancelled': {
        const d = f.data as FactData['IntegrationCancelled']
        const e = s.entries.find((x) => x.id === d.entry)
        if (e && (e.state === 'open' || e.state === 'started')) Object.assign(e, { state: 'cancelled', cancelled: d.reason })
        retireEntry(s, d.entry)
        break
      }
      case 'IntegrationStarted': {
        const d = f.data as FactData['IntegrationStarted']
        // A late fact can't revive an entry that has its outcome (cancelled, failed, integrated). An advance begun again
        // (a restart's rerun) has a journal of its own: the earlier attempt's phases don't count (#1351).
        const e = s.entries.find((x) => x.id === d.entry)
        if (e && (e.state === 'open' || e.state === 'started')) Object.assign(e, { state: 'started', started: d, phases: [] })
        break
      }
      case 'IntegrationPhase': {
        const d = f.data as FactData['IntegrationPhase']
        s.entries.find((x) => x.id === d.entry)?.phases.push(d.phase)
        break
      }
      case 'IntegrationFailed': {
        const d = f.data as FactData['IntegrationFailed']
        const e = s.entries.find((x) => x.id === d.entry)
        if (e && (e.state === 'open' || e.state === 'started')) Object.assign(e, { state: 'failed', failure: d })
        retireEntry(s, d.entry)
        break
      }
      case 'Integrated': {
        const d = f.data as FactData['Integrated']
        s.integrated = d
        const e = d.entry ? s.entries.find((x) => x.id === d.entry) : undefined
        if (e) e.state = 'integrated'
        if (d.entry) s.requests = s.requests.filter((r) => r.entry !== d.entry || r.gate === QUEUE_STUCK_GATE)
        if (d.outsideRules?.length) s.marks.outsideRules = d.outsideRules
        delete s.marks.leftTarget
        break
      }
      case 'MergedInPart':
        s.marks.mergedInPart = f.data as FactData['MergedInPart']
        break
      case 'InTarget':
        s.marks.inTarget = f.data as FactData['InTarget']
        break
      case 'BackInTarget':
        delete s.marks.leftTarget
        break
      case 'LeftTarget':
        s.marks.leftTarget = f.data as FactData['LeftTarget']
        break
      case 'Accepted':
        s.accepted = f.data as FactData['Accepted']
        break
      case 'Finished':
        s.finished = { ...(f.data as FactData['Finished']), seq: f.seq, steps: [] }
        break
      case 'FinishStep': {
        const d = f.data as FactData['FinishStep']
        if (s.finished?.seq === d.finish && !s.finished.steps.includes(d.step)) s.finished.steps.push(d.step)
        break
      }
      case 'Moved':
        // Out of Done, its finish is over: the next move into Done is another (HI-2014).
        if ((f.data as FactData['Moved']).to !== 'done') s.finished = null
        s.stage = (f.data as FactData['Moved']).to
        // A gate's request belongs to the stage it was asked in: the card leaving it retires the request.
        s.requests = s.requests.filter((r) => !isGateRequest(r) || r.stage === undefined || r.stage === s.stage)
        break
      case 'Override': {
        const d = f.data as FactData['Override']
        s.overrides.push(d)
        if (s.latest && d.rules.includes('integrate.approved')) s.approvalOverridden = true
        break
      }
      case 'Blocked':
        s.blocked = (f.data as FactData['Blocked']).reason
        break
      case 'FilesLocked':
        for (const p of (f.data as FactData['FilesLocked']).paths) s.locked = addOnce(s.locked, p)
        break
      case 'Unblocked':
        s.blocked = null
        break
      case 'Decision':
        s.generation = Math.max(s.generation, (f.data as FactData['Decision']).generation)
        // A decision makes what was approved before it stale, an override past review included.
        s.approvalOverridden = false
        // ...and to the decision generation it was asked at: a newer decision retires it (it is asked again).
        s.requests = s.requests.filter((r) => !isGateRequest(r) || r.generation === undefined || r.generation === s.generation)
        break
      case 'DecisionsReceived': {
        const d = f.data as FactData['DecisionsReceived']
        s.received[d.agent] = Math.max(s.received[d.agent] ?? 0, d.generation)
        // Never back (HI-2854): a late receipt of an older read leaves a newer one as it is.
        if (typeof d.comments === 'number') s.receivedComments[d.agent] = Math.max(s.receivedComments[d.agent] ?? 0, d.comments)
        break
      }
      case 'UserComment':
        s.commentGeneration = Math.max(s.commentGeneration, (f.data as FactData['UserComment']).generation)
        break
      case 'LineRenamed': {
        // Its line is the new name from here on: reconciliation reads the branch by it, and never finds it gone (#1305).
        const d = f.data as FactData['LineRenamed']
        if (s.started?.line && s.started.line.toLowerCase() === d.from.toLowerCase()) s.started = { ...s.started, line: d.to }
        s.lines = s.lines.map((l) => (l.toLowerCase() === d.from.toLowerCase() ? d.to : l))
        break
      }
      case 'FolderMoved': {
        // Its folder is the new place from here on: reconciliation reads it there, and never finds it gone (#1343).
        const d = f.data as FactData['FolderMoved']
        if (s.started && s.started.folder !== 'project' && samePath(s.started.folder, d.from)) s.started = { ...s.started, folder: d.to }
        break
      }
      case 'HeadMoved': {
        const d = f.data as FactData['HeadMoved']
        s.head = d.to
        s.lastHeadFact = f.seq
        break
      }
      case 'CommitAttributed':
        s.attributed.push((f.data as FactData['CommitAttributed']).commit)
        break
      case 'CheckRan':
        s.checks.push(f.data as FactData['CheckRan'])
        break
      case 'FocusedAccepted':
        s.focusedAccepted.push(f.data as FactData['FocusedAccepted'])
        break
      default:
        break
    }
  }
  return s
}

/** The distinct reviewers who passed the latest submission at the current generation (the quorum, G1b). */
export function passingReviewers(s: CardState): string[] {
  if (!s.latest) return []
  const id = s.latest.id
  return [...new Set(s.verdicts.filter((v) => v.submission === id && v.pass && v.generation === s.generation).map((v) => v.reviewer))]
}

/** The user's approval of the latest submission at the current generation, for a request of this gate. */
export function approvedByUser(s: CardState, gate?: string): boolean {
  if (!s.latest) return false
  const id = s.latest.id
  return s.approvals.some((a) => a.answer === 'approved' && a.generation === s.generation && (a.submission === undefined || a.submission === id) && (!gate || s.made[a.request]?.gate === gate))
}

/** The open queue entry, if any (open or started: not yet with an outcome). */
export const openEntry = (s: CardState): QueueEntry | undefined => s.entries.find((e) => e.state === 'open' || e.state === 'started')

/**
 * Unchanged requeues after transient failures since the last new revision (`requeue.allowed`, §16.5.3). A hold or the
 * user's own cancel resets the count, so holding a card never strands it.
 */
export function transientRequeues(s: CardState): number {
  let n = 0
  const since = s.latest?.id ?? 0
  for (const e of s.entries.filter((x) => x.seq > since)) {
    if (e.requeue === 'transient') n++
    if (e.state === 'cancelled' && (e.cancelled === 'hold' || e.cancelled === 'user')) n = 0
  }
  return n
}

/** The card's For you, from its open requests (§16.8.5). */
export const forYou = (s: CardState): Request[] => s.requests

/**
 * Whether a card has reached its round limit (§16.11.4): its rounds (failed reviews and the user's declines) at its
 * lane's limit and the rounds the user added since, with no round-limit question open. No limit (a card in no running
 * lane): never.
 */
export function atRoundLimit(s: CardState, limit: number | null | undefined): boolean {
  return typeof limit === 'number' && s.rounds >= limit + s.moreRounds && !s.requests.some((r) => r.gate === ROUND_LIMIT_GATE)
}
