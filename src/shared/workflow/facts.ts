// A card's fact log (SPEC §16.4): typed, append-only, recorded by Hive or observed from the platform, and the pure fold
// that derives the card's state from it. The same fold runs in the spike, main and tests (ARCHITECTURE "Facts and
// derived state"). Facts carry platform-neutral words (revision, line, target, result); anything only one platform
// has goes in `data.platform`, which only its adapter reads.
//
// In the app since P3: hive.db's `card_facts` (main/workflow/factStore.ts), folded wherever a card's state is read.

import type { StoredText, TransientCause } from '../types'
import { samePath } from '../movePaths'

/** Who caused a fact. */
export type Actor = 'user' | 'assistant' | 'hive' | 'outside' | `agent:${string}`

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
  /** None: the card's declared paths. */
  paths?: string[]
  /** Shared folder: the card's commits, in order. */
  commits?: string[]
  adopted?: boolean
  /** Warnings that didn't refuse (G16). */
  warnings?: string[]
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
  counted: boolean
  whyNot?: 'notCheck' | 'notContained' | 'dirty' | 'changed' | 'moved' | 'revisionChanged'
  isolated?: boolean
}

export type ForYouKind = 'approve' | 'decide' | 'test' | 'signIn' | 'other'

/** What the user chose at a card's round limit (§16.11.4). */
export const ROUND_CHOICES = ['carryOn', 'split', 'accept', 'takeOver'] as const
export type RoundChoice = (typeof ROUND_CHOICES)[number]

/** The gate of Hive's question at a card's round limit (§16.11.4). */
export const ROUND_LIMIT_GATE = 'roundLimit'

/** The gate of Hive's questions about a builder's line held up between a lane's cards (§16.19.2, #1271). */
export const LINE_GATE = 'lineUpdate'

/**
 * The gate of Hive's question before it updates a target checked out in a folder (§16.9.2, OP-40, #1351: Settings →
 * Advanced, Merge into a checked-out branch, Ask each time): bound to the queue entry and the target's expected revision.
 */
export const QUEUE_ADVANCE_GATE = 'queueAdvance'

/** The gate of Hive's notice that an advance into a checked-out target stopped part way (§16.9.2's terminal state, #1351). */
export const QUEUE_STUCK_GATE = 'queueStuck'

/** An answer as the user gives it (§16.8.5): its outcome, whether it has a reply or a decision, a choice and its rounds. */
export interface AnswerShape {
  outcome: 'approved' | 'declined' | 'answered'
  reply?: boolean
  decision?: boolean
  choice?: RoundChoice
  rounds?: number
}

/**
 * Whether an answer fits its request (§16.8.5, #1269): at the round limit, a choice (a carry on with 1 to `maxRounds`
 * more rounds), nothing else; an approval (kind Approve), approved or declined (a reply may say why), never a decision;
 * any other question, answered with a reply or a decision.
 */
export function answerFits(req: Pick<FactData['ApprovalRequested'], 'kind' | 'gate'>, a: AnswerShape, maxRounds: number): boolean {
  if (req.gate === ROUND_LIMIT_GATE) return a.outcome === 'answered' && !!a.choice && ROUND_CHOICES.includes(a.choice) && !a.decision && (a.choice !== 'carryOn' || (Number.isInteger(a.rounds) && a.rounds! >= 1 && a.rounds! <= maxRounds))
  if (a.choice !== undefined) return false
  if (req.kind === 'approve') return (a.outcome === 'approved' || a.outcome === 'declined') && !a.decision
  return a.outcome === 'answered' && (!!a.reply || !!a.decision)
}

export type IntegrationFailReason = 'conflict' | 'checks' | 'targetMoved' | 'folderBusy' | 'notUpToDate' | 'hook'

/** The data of each kind (§16.4.2). */
export interface FactData {
  Started: StartedData
  Adopted: StartedData
  Submitted: SubmittedData
  CheckRan: CheckRanData
  ReviewStarted: { reviewer: string; submission: number; revision: string | null; reviewCopy?: string }
  Verdict: { reviewer: string; submission: number; revision: string | null; pass: boolean; failKind?: 'content' | 'explanation'; round: number; generation: number; comment: string }
  CarriedOver: { from: string; to: string; toBase: string | null; how: 'replay' | 'sameRevision' }
  Updated: { entry: string; from: string; to: string; how: 'mergedTarget' | 'rebased'; carried: boolean }
  LineMoved: { line: string; from: string; to: string; why: 'squashContinuation' }
  /** The card's line renamed (#1305: Repair renaming an agent's branch named after an old place): its work follows it. */
  LineRenamed: { from: string; to: string; why: 'repair' }
  /** A Done card's line deleted (#1438): its target contained it at `revision`, and nothing had it checked out. */
  LineDeleted: { line: string; revision: string; why: 'merged' }
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
  /** `text` in English (agents, the Agent API); `requestText`, Hive's own request as data for the window (an agent's words have none). */
  /** `entry` and `result`: the queue entry a merge queue's request is about, and its test merge's result (#1351). */
  ApprovalRequested: { request: string; kind: ForYouKind; gate: string; revision?: string | null; submission?: number; text: string; requestText?: StoredText; stage?: StageId; generation?: number; for?: 'user'; asker?: string; checklist?: string[]; entry?: string; result?: string }
  /** An answer (§16.8.5): `note` the user's reply; at the round limit, their `choice` and the rounds a carry on adds. */
  Approval: { request: string; answer: 'approved' | 'declined' | 'answered'; note?: string; generation: number; submission?: number; choice?: RoundChoice; rounds?: number }
  IntegrationRequested: { entry: string; revision: string; key: string | null; target: string; style: 'merge' | 'squash'; requeue?: 'transient' | 'retry' }
  IntegrationCancelled: { entry: string; reason: 'removed' | 'stale' | 'hold' | 'user' | 'decision' | 'integratedOutside' }
  IntegrationStarted: { entry: string; expected: string; result: string; files?: string[]; checkedOut?: string | null }
  IntegrationPhase: { entry: string; phase: 'files' | 'ref' | 'rollback' }
  /** `cause` and `code`: why a transient failure was one (#1362), as codes; `code` is the network error code found. */
  /** `check`: the merge check that failed (`install` for the install before them), `logPath` its log (#1354). */
  IntegrationFailed: { entry: string; revision: string; target: string; reason: IntegrationFailReason; files?: string[]; log?: string; transient: boolean; cause?: TransientCause; code?: string; check?: string; logPath?: string }
  Integrated: { entry?: string; revision: string; target: string; result: string; method: 'merge' | 'squash' | 'fastForward' | 'sameTree' | 'committed'; by: 'hive' | 'agent' | 'outside'; outsideRules?: string[] }
  /** Some of an unfinished card's work found in the target (a partial hand merge): a mark, not a move (§16.4.4). */
  MergedInPart: { revision: string; target: string }
  /** A Done card's revision no longer in its target (the target was reset): a mark (§16.4.4). */
  LeftTarget: { revision: string; target: string }
  Accepted: { revision?: string; submission?: number }
  /** `why`: the agent's own reason, given with a put back (#1267). */
  Moved: { from: StageId; to: StageId; cause: 'intent' | 'user' | 'derived' | 'override'; why?: string }
  /** The refusal's English (agents read it) and its rule and values, which the window shows translated (refusalLines). */
  Refused: { move: string; rule: string; message: string; next: string; values?: Record<string, string | number | StoredText> }
  Override: { rules: string[]; move: string; by: 'user' | 'assistant'; reason: string }
  /** A project agent proposed the card's kind when it made it (§16.7.3, OP-6/OP-7, #1277): no code, until confirmed. */
  KindProposed: { kind: CardKind }
  /** The user or the Assistant answered a proposed kind (#1277): `kind` is the card's kind from now on. */
  KindDecided: { kind: CardKind; proposed: CardKind }
  Blocked: { reason: string }
  Unblocked: Record<string, never>
  /** A decision added, its words changed, or removed (`removed`, its last words): each a new generation (#1216). */
  Decision: { decision: string; generation: number; text: string; removed?: boolean }
  DecisionsReceived: { agent: string; generation: number }
  /**
   * Paths the card's builder took Hive's file locks on this cycle (#1481, G16: its own changes in a shared folder),
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
}

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
  submissions: Submission[]
  latest: Submission | null
  /** Reviewers who started a review, per submission id. */
  reviewing: Record<number, string[]>
  verdicts: (FactData['Verdict'] & { seq: number })[]
  /** The newest decision generation on the card (0: none). */
  generation: number
  /** The generation each agent has received. */
  received: Record<string, number>
  /** The revision the latest submission's passes now cover (moved by carry-overs and the queue's updates), and its base. */
  approved: { revision: string | null; base: string | null } | null
  /** A content-stale pass (a new revision that isn't the same change), until the builder submits again. */
  stale: FactData['Stale'] | null
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
  marks: { mergedInPart?: FactData['MergedInPart']; leftTarget?: FactData['LeftTarget']; outsideRules?: string[] }
  blocked: string | null
  /**
   * A card loop's step waiting on the other side (#1382, #1467): the builder's design or follow-up posted for its
   * reviewer's check, until the reviewer answers, the builder goes ahead with a design, or the card moves, is submitted or
   * given a verdict.
   */
  step: { step: LoopAsk; id: string; seq: number; at: string; until: string | null; by: string | null } | null
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
  submissions: [],
  latest: null,
  reviewing: {},
  verdicts: [],
  generation: 0,
  received: {},
  approved: null,
  stale: null,
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
  marks: {},
  blocked: null,
  step: null,
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
        Object.assign(s, { ...emptyState(), stage: s.stage, generation: s.generation, received: s.received, rounds: s.rounds, moreRounds: s.moreRounds, builders: s.builders, overrides: s.overrides, blocked: s.blocked, lastSeq: s.lastSeq })
        s.requests = limit
        for (const r of limit) s.made[r.request] = r
        s.cycle = f.seq
        s.lastHeadFact = f.seq
        s.started = { ...d, seq: f.seq, adopted: f.kind === 'Adopted' }
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
        if (d.why !== 'decision') s.stale = d
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
      case 'LeftTarget':
        s.marks.leftTarget = f.data as FactData['LeftTarget']
        break
      case 'Accepted':
        s.accepted = f.data as FactData['Accepted']
        break
      case 'Moved':
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
        break
      }
      case 'LineRenamed': {
        // Its line is the new name from here on: reconciliation reads the branch by it, and never finds it gone (#1305).
        const d = f.data as FactData['LineRenamed']
        if (s.started?.line && s.started.line.toLowerCase() === d.from.toLowerCase()) s.started = { ...s.started, line: d.to }
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
