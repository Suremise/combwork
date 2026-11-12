// The workflow runtime (SPEC §16.7, §16.8): intents from agents and moves from the user pass through one place. It asks
// the platform adapter for the facts the guards need first, outside the transaction (slow reads); then, in one
// transaction, it reads the card's facts again, runs the ruleset's guards in order, and on a refusal appends `Refused`
// and returns it; else it writes the facts, `Moved`, the stage cache and the side effects as durable actions, which a
// worker runs after the commit (§16.4.5).
//
// In the app, one instance per project of an open workspace comes from service.ts (#1263), on the board's store, its
// writes changes of the board and its actions run by the actions worker; reconciliation uses it. P4 routes `tasks.ts`'s
// moves and the intents' routes through it (#1265 on). `tests/workflow` runs it on a store of its own, with `runActions`.

import { AsyncLocalStorage } from 'async_hooks'
import { resolve as resolvePath } from 'path'
import { agentActor, agentOf, answerFits, askedQuestion, approvedByUser, decisionAnswers, atRoundLimit, FOCUSED_SKIP_GATE, foldCard, LINE_GATE, loopStepSide, MERGE_CHOICE_GATE, openEntry, overridableEntry, passingReviewers, QUEUE_ADVANCE_GATE, QUEUE_STUCK_GATE, ROUND_LIMIT_GATE, SLOT_DIRTY_GATE, type Actor, type AskAction, type AskActionKind, type CardKind, type CardState, type Fact, type FactData, type FactKind, type FinishStepId, type ForYouKind, type LoopStepId, type RoundChoice, type StageId } from '../../shared/workflow/facts'
import { awaitsAgentMerge, baseRulesetId, compile, hasStage, mergeCommitOf, skipReviewOf, targetedOf, type Ruleset } from '../../shared/workflow/compile'
import { evaluate, evaluateAll, notApproved, okBeforeApplies, type GuardInputs, type GuardRefusal } from '../../shared/workflow/guards'
import { nextStep, type NextStep } from '../../shared/workflow/nextStep'
import { FOCUSED_PICK, reviewByYou, reviewerAgent, type WorkflowOptions } from '../../shared/workflow/options'
import { reviewsInProgress, submissionReviewers } from '../../shared/workflow/reviewerPool'
import { ACCEPT_MAX, chosenTests, focusedCheckName, reviewProved, standingFocusedRun, validTestId, type FocusedChoice, type FocusedTest, type PathChange } from '../../shared/workflow/focused'
import { pathChanges, pickAtRevision, type PickOutcome } from './focusedRun'
import type { GuardId, MoveId } from '../../shared/workflow/pieces'
import { refusal, type Refusal, type RuleId } from '../../shared/workflow/refusals'
import { FOR_YOU, UNREADABLE, workflowEnglish, workflowText } from '../../shared/workflow/texts'
import type { StoredText, TargetChanges } from '../../shared/types'
import { parseCardRef } from '../../shared/workflow/cardRefs'
import type { ForwardOverride } from '../../shared/workflow/forwardOrder'
import { changeList, nextCard, type LaneList } from '../../shared/workflow/laneList'
import { LANE_MAX_ROUNDS } from '../../shared/lanes'
import type { FinishInputs, LineNow, PlatformAdapter, Unsubmitted } from '../platform/adapter'
import type { JjCardDeps } from '../platform/jjPlatform'
import { adaptersFor } from '../platform/adapters'
import { historyOf } from '../platform/historyPorts'
import { NoneAdapter } from '../platform/none'
import { readBaseline } from '../noneBaseline'
import { isUnknown, unknown, withDetail, type Maybe } from '../platform/types'
import { declaresPaths, hasCapability, needsRepository, type PlatformId } from '../../shared/platform/descriptors'
import { FactStore, type CardRecord, type Tx } from './factStore'
import { finishAccepts, recordFinish } from './finish'
import { NOT_RUN_HERE, pauseWait, queueLine, queueStateOf, type QueueLive } from './queueState'
import { checksView } from '../../shared/toolReplies'
import { agentMsg, say, type AgentMsg, type AgentValues } from '../../shared/agentText'
import { inDefaultDialect } from '../../shared/agentText/asyncScope'
import { HISTORY, storedText } from '../../shared/taskHistory'

import { ownRuleset, reviewSkipOf } from '../../shared/workflow/workView'
import { admit } from '../platform/platformFence'
import { PLATFORM_NAME } from '../../shared/platform/switching'
import { createLogger, userText } from '../logger'
import { GatherDepth } from './gatherDepth'
import { asCardCounts } from './containment'

const log = createLogger('workflow')

export { APPLY_OPTIONS } from '../../shared/workflow/workView'

export interface Moved {
  ok: true
  card: string
  from: StageId
  to: StageId
  data?: Record<string, unknown>
  warnings?: string[]
  /** A start whose builder is given the card in a slot (#1438): that placement's new conversation carries its prompt. */
  placed?: boolean
}

/** The user's drag across rules: what it would skip, asked before it's done (§16.8.4). */
export interface Ask {
  ask: true
  card: string
  rules: string[]
  /**
   * The user's drag that submits a None code card whose paths leave files out (HI-2352): asked before the rules (none
   * then), nothing written. `paths`: what it would submit with; `files`: what they leave out (its pre-fill beyond them,
   * then the unclaimed changes, which may be another card's). Moved again with `paths` to include them, or without asking.
   */
  leftOut?: { paths: string[]; files: string[] }
}

export type Reply = Moved | Refusal

/** What an intent decided on, fingerprinted (`evidenceOf`): the adapter's primed reads and the fingerprint then. */
export interface Evidence {
  primed: unknown
  value: string | null
  /** The platform's own answer by content, taken with it (`content`), when it has one. */
  content: string | null
}

/** The user's (or the Assistant's) drag running an intent: asking first, or across the rules that refuse, with a reason. */
export interface Drag {
  by: 'user' | 'assistant'
  reason: string
  ask: boolean
}

/**
 * What runs inside each write of an intent that changes the card, in its transaction, after the runtime's own facts
 * (#1265): the board's 0.9 fields (tasks.ts) follow the stage the write left, so a reader never sees one without the
 * other. Set per call (`alongside`), for every write the intent makes (a drag's start, then its submit).
 */
export interface Alongside {
  written: (w: Write) => Promise<void>
}
const alongsideOf = new AsyncLocalStorage<Alongside>()

/** Runs `fn` (a runtime call) with `a` run inside each of its writes that change a card. */
export function alongside<T>(a: Alongside, fn: () => Promise<T>): Promise<T> {
  return alongsideOf.run(a, fn)
}

export const isRefusal = (r: unknown): r is Refusal => !!r && typeof r === 'object' && (r as Refusal).refused === true

/** What happens outside the store: a delivery per action, deduplicated by the action's id (§16.4.5). */
export interface Effects {
  wake?: (agent: string, card: CardRecord, why: string) => void
  /** A notice to the user: its English, and its text as data for the window when Combwork wrote it (an agent's words have none). */
  notify?: (card: CardRecord, text: string, shown?: StoredText) => void
  /** HI-2087: a comment of Combwork's on the card: its English, and its text as data for the window. */
  comment?: (card: CardRecord, text: string, shown?: StoredText) => void
}

/** What `slotFor` gives a start (#1438): the slot and lease, or why it waits for one; null, no slot. */
export type SlotForStart = { slot: string; folder: string; lease: string; fresh: boolean } | { wait: string } | null

/**
 * What a reviewer is told of a submission's focused tests (G20, HI-1367) when it starts its review: the list to check
 * against the change (and that it is the builder's own, standing in for a pick that couldn't choose), and the tests the
 * merge queue won't run (real CLI, packaged), which count only from the reviewer's own run at this revision.
 */
function focusedForReview(f: FocusedChoice | undefined): Record<string, string | string[]> {
  if (!f) return {}
  const tests = chosenTests(f)
  const yours = tests.filter(reviewProved)
  return {
    focusedTests: tests.map((t) => t.id),
    ...(f.source === 'manual' ? { focusedChosenBy: say(W.focusedChosenBy, { why: f.state === 'tooBroad' ? say(W.everyTest) : (f.why ?? say(W.pickFailed)) }) } : {}),
    ...(yours.length ? { runYourself: say(W.runYourself, { tests: yours.map((t) => t.id).join(', '), check: focusedCheckName('<test>') }) } : {})
  }
}

/**
 * HI-2660: the card's checks recorded at a revision, for its reviewer to reuse: the latest counted run of each name there
 * (a failure after a pass says failed), not the merge queue's own runs (`entry`), and not a configured check whose command
 * has changed since (an old command doesn't prove the check as it is now). Names are data, never a command. Only these:
 * what else the change needs is the reviewer's to judge. Empty: none, and the reply leaves the field out.
 */
export function checksAtRevision(checks: readonly FactData['CheckRan'][], revision: string, commands: Readonly<Record<string, string>>): { name: string; result: FactData['CheckRan']['result'] }[] {
  const latest = new Map<string, FactData['CheckRan']>()
  for (const c of checks) if (c.counted && !c.entry && c.revision === revision) latest.set(c.name, c)
  return [...latest.values()].filter((c) => commands[c.name] === undefined || commands[c.name] === c.command).map((c) => ({ name: c.name, result: c.result }))
}

/**
 * HI-2660: the focused-test runs a reviewer's pass accepts (`cw_verdict`'s `accept`), each the standing run of that test
 * at the passed revision (`standingFocusedRun`: its latest counted run there, not the queue's, its command unchanged)
 * when that run passed; its own id and agent kept. Anything else is a warning and accepts nothing, whoever calls: a bad
 * id, beyond ACCEPT_MAX, no standing run, or one that failed (an earlier pass never stands behind it).
 */
export function acceptedRuns(checks: readonly FactData['CheckRan'][], revision: string | null, accept: readonly unknown[], commands: Readonly<Record<string, string>>): { accepted: NonNullable<FactData['Verdict']['accepted']>; warnings: string[] } {
  const accepted: NonNullable<FactData['Verdict']['accepted']> = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const [i, test] of accept.entries()) {
    if (i >= ACCEPT_MAX) {
      warnings.push(say(W.acceptTooMany, { max: ACCEPT_MAX }))
      break
    }
    if (!validTestId(test)) {
      warnings.push(say(W.acceptInvalid, { test: JSON.stringify(String(test)).slice(0, 80) }))
      continue
    }
    if (seen.has(test)) continue
    seen.add(test)
    const run = revision ? standingFocusedRun(checks, test, revision, commands) : undefined
    if (!run) warnings.push(say(W.acceptNone, { test }))
    else if (run.result !== 'passed') warnings.push(say(W.acceptFailed, { test }))
    else accepted.push({ test, run: run.run, ...(run.agent ? { agent: run.agent } : {}) })
  }
  return { accepted, warnings }
}

export interface WorkflowConfig {
  store: FactStore
  /** The project folder. */
  project: string
  /** The project key (`AM`). */
  projectKey: string
  /** The project's identity as the slot and copy tables key it (HI-2799: the platform fence's admissions); absent in tests. */
  projectId?: () => string
  /** The project's resolved options (§16.6.6); a card in flight keeps its own ruleset. */
  options: () => WorkflowOptions
  /** Where cards' own folders go (the P2 spike's stand-in for slots, its unit tests only: the app lends slots, `slotFor`). */
  slots?: string
  /**
   * Slots (#1438, SPEC §16.10): the slot a card under G11 = slots starts in, for its builder (`leaseForStart`, the app's):
   * its lease (a lane's, kept for the lane; else the card's own, `fresh` when lent now), or why none can be now (`wait`,
   * English). `dry`: only whether one could be, nothing lent. Null: no slot here (the rules off, the builder a reviewer).
   */
  slotFor?: (card: CardRecord, builder: string, o: { dry: boolean; target: string | null }) => Promise<SlotForStart>
  /** A lease lent for a start that wasn't written (refused, or undone): given back. */
  slotUnused?: (lease: string) => Promise<void>
  /** HI-2944: a start found its target's folder with uncommitted changes (warned, never refused): the app tells the window. */
  targetChanges?: (changes: TargetChanges, card: string) => void
  /** jj's card work's dependencies (HI-2868, the app's jjCards.ts): absent where jj's adapter answers nothing. */
  jj?: JjCardDeps
  /** Runs an agent started that are still going (G13). */
  runsOf?: (agent: string) => string[]
  /**
   * HI-2487: the project's agents that may be reviewing now (in the project, their session running), by id with their
   * names: a review one of them has in progress refuses another agent's start of it. Left out, none (unit tests without
   * sessions).
   */
  reviewersPresent?: () => Promise<ReadonlyMap<string, string>>
  /**
   * An agent's own worktree (SPEC §16.19.1: before P7's slots, it stands in for a card's slot): its folder, and the line
   * its project.json names as its base. Null for an agent without one.
   */
  agentFolder?: (agent: string) => Promise<{ path: string; base: string | null } | null>
  /**
   * The new name of a line Repair began renaming and hasn't finished (#1305: project.json's `pendingBranchRenames`), or
   * null: reconciliation then follows the rename rather than take the line for gone.
   */
  pendingRename?: (line: string) => Promise<string | null>
  /**
   * Whether the project, or its workspace, moved and Repair hasn't recorded it yet (#1343: `lastPath` isn't where it is):
   * an agent's worktree still recorded at its old place is Repair's to move then, not gone.
   */
  movePending?: () => Promise<boolean>
  /**
   * Whether the project's repository of `platform` is gone (#1419, S20: Git's `.git` removed or moved, or another version
   * control found instead): a card of a platform that needs one, refused for what couldn't be read, then offers the switch
   * to None as its next step.
   */
  repositoryGone?: (platform: PlatformId) => boolean
  /**
   * The lock records still being written for the project (#1481: a lock taken before an intent is recorded before the
   * intent reads the cards' records); left out, none are.
   */
  locksSettled?: () => Promise<void>
  /**
   * The check runs' records still being written for the project (#1651: a check whose run has finished is in its card's
   * facts before a submit reads them); left out, none are.
   */
  checksSettled?: () => Promise<void>
  /**
   * G20 (HI-1367): how a submission's pick runs (a check's environment, its time limit). Left out, the project's picker
   * still runs, with an empty environment and a minute's limit (unit tests); `pick` replaces it (a test's stub).
   */
  focused?: { env: () => Record<string, string>; timeoutMs: () => number; life?: AbortSignal; pick?: (command: string, folder: string, revision: string, base: string, changes: PathChange[]) => Promise<PickOutcome> }
  /** Run the actions after each write (false: leave them pending, as a crash right after the commit would). */
  autoRun?: boolean
  effects?: Effects
  /**
   * After a write that moved a card, once it is committed: from and to (HI-2938: a jj card's pass changes no jj operation
   * or ref, so the app asks for its reconciliation here, which builds its candidate).
   */
  moved?: (card: CardRecord, from: StageId, to: StageId) => void
  /** Test seams: called between gathering and the transaction. */
  hooks?: { beforeWrite?: (move: string) => void | Promise<void>; unsubmittedRead?: () => void | Promise<void> }
  /**
   * Runs a write of the store under the lock its store needs (#1217): in the app, a change of the workspace's board
   * (boardWrite), since the board's store writes only inside one; left out, the write runs as it is (a store on its own
   * connection).
   */
  locked?: <T>(fn: () => T) => Promise<T>
  /**
   * Whether reconciliation acts on what it observes (§16.4.4's moves: Done when integrated outside, a queue entry
   * cancelled, the builder woken, a stale card moved back), or only records it (#1217: P3 is record-only). The P4
   * runtime turns it on; the P2 scenarios run with it.
   */
  reconcileActs?: boolean
  /**
   * Whether the ruleset's guards run (#1265: Settings → Advanced → Workflow rules are enforced): off, no guard refuses or
   * is skipped, so nothing asks, is refused for a rule or records an Override; facts are recorded under the card's
   * ruleset as ever. Read at each use; left out, always.
   */
  enforced?: () => boolean
  /** What runs a target's queue in this Combwork now (queueHost's queueLive, #1354); left out, nothing here runs one. */
  queueLive?: (target: string) => QueueLive
}

/** A branch name's slug from a card title (§16.10.1): lower case ASCII letters, digits and hyphens, at most 40. */
export function slugOf(title: string): string {
  return title
    // Accents folded (é → e): decomposed, the marks dropped.
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

/** A card's line (§16.10.1): `cw/<KEY>/<card key>-<slug>` (`cw/AM/AM-12-fix-the-login`); no slug, the key alone. */
export function lineName(projectKey: string, card: Pick<CardRecord, 'key' | 'title'>): string {
  const slug = slugOf(card.title)
  return `cw/${projectKey}/${card.key}${slug ? `-${slug}` : ''}`
}

const ORDER: StageId[] = ['todo', 'active', 'review', 'approved', 'merging', 'done']
/**
 * Where file locks were seen (recordLocks, #1481): on that cycle of the agent's current card then, or, when the cards
 * weren't read then (the runtime not made yet this launch), at that time (ISO).
 */
export type LockSeen = { card: number; cycle: number } | { at: string }

/** The stages in which a card's lock record counts (G16, #1481): started and not finished. */
const LOCK_STAGES: readonly StageId[] = ['active', 'review', 'approved', 'merging']

/** A reviewer's intents (§16.7.2): refused outside Review, their next step is the reviewer's (`sideOf`, #1604). */
const REVIEW_MOVES: ReadonlySet<string> = new Set(['start review', 'verdict']) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)

/**
 * What the workflow runtime tells agents (dialects, HI-2435): its wakes, its intents' warnings and reply fields. A wake
 * is a durable action delivered later, and a fact's reason is stored: both are said in the Default (`stored`) until
 * stored text is said when read (dialects, 4 and 5b); a reply's text is said in the caller's scope.
 */
/** HI-2944: paths as a warning names them: three at most, then how many more (HI-2960: an agent's reply, kept short). */
const FILES_NAMED = 3
const filesNamed = (files: readonly string[]): string => (files.length <= FILES_NAMED ? files.join(', ') : say(W.moreFiles, { files: files.slice(0, FILES_NAMED).join(', '), more: files.length - FILES_NAMED }))

/**
 * HI-2984: whether the target's folder with uncommitted changes is worth a start's warning (and the window's notice):
 * only when the rules merge something into the target (a finish other than Committed, whose target is just the line
 * the work is committed on) and that folder isn't where the work is built (Solo's: the agent's own folder, maybe its
 * own half-done work, never a merge's).
 */
const targetChangesApply = (o: WorkflowOptions, folder: string, workFolder: string | null): boolean =>
  o.finish !== 'committed' && (workFolder === null || resolvePath(folder).toLowerCase() !== resolvePath(workFolder).toLowerCase())

const W = {
  forwardResolving: agentMsg({ id: 'runtime.forward.resolving', text: 'Ended here, nothing merged: Resolve on a builder made {card} for a builder to merge {from} ({source}) into {to} and resolve the conflict there. Follow {card}.', note: 'HI-2959: the comment on a forward merge card (Combwork merging branch {from} into {to}) ended by Resolve on a builder. {card}: the new card’s key; {source}: a short commit id.' }),
  choiceCarryOn: agentMsg({ id: 'runtime.choice.carryOn', text: 'carry on', note: "The user's choice at a lane's round limit, as its answer's wake says it." }),
  choiceSplit: agentMsg({ id: 'runtime.choice.split', text: 'split it', note: "The user's choice at a lane's round limit, as its answer's wake says it." }),
  choiceAccept: agentMsg({ id: 'runtime.choice.accept', text: 'accept it with follow-ups', note: "The user's choice at a lane's round limit, as its answer's wake says it." }),
  choiceTakeOver: agentMsg({ id: 'runtime.choice.takeOver', text: 'the user takes it over', note: "The user's choice at a lane's round limit, as its answer's wake says it." }),
  actionDone: agentMsg({ id: 'runtime.action.done', text: 'moved it to Done', note: 'What the user did with an action a question offered (#1630), as its answer\'s wake says it.' }),
  actionNoCode: agentMsg({ id: 'runtime.action.noCode', text: 'made it no code', note: 'What the user did with an action a question offered (#1630), as its answer\'s wake says it.' }),
  actionUnblock: agentMsg({ id: 'runtime.action.unblock', text: 'unblocked it', note: 'What the user did with an action a question offered (#1630), as its answer\'s wake says it.' }),
  actionSkipReview: agentMsg({ id: 'runtime.action.skipReview', text: 'skipped its review', note: 'What the user did with an action a question offered (#1630), as its answer\'s wake says it.' }),
  focusedChosenBy: agentMsg({ id: 'runtime.review.focusedChosenBy', text: "its builder, as its picker couldn't choose ({why}): check they cover the change", note: "G20 (HI-1367): start review's focusedChosenBy, when the builder named the focused tests itself. {why}: the picker's reason (runtime.review.everyTest, or its own words)." }),
  everyTest: agentMsg({ id: 'runtime.review.everyTest', text: 'it said every test', note: "Why the focused-test picker couldn't choose: it named every test." }),
  pickFailed: agentMsg({ id: 'runtime.review.pickFailed', text: 'failed', note: "Why the focused-test picker couldn't choose, when it gave no reason." }),
  runYourself: agentMsg({ id: 'runtime.review.runYourself', text: "{tests}: the merge queue doesn't run these (a real CLI or the installed app); each counts from your run at this revision, cw-progress --check \"{check}\" --card <card> -- <its command>, or from another's run of it there that your pass accepts (cw_verdict's accept)", note: "G20 (HI-1367): start review's runYourself: focused tests the merge queue won't run, which count only from the reviewer's own run. {tests}: their ids. {check}: the check's name pattern (focused:<test>)." }),
  acceptOnPass: agentMsg({ id: 'runtime.verdict.acceptOnPass', text: "accept is taken only with a pass: nothing accepted", note: "HI-2660: cw_verdict's accept given with a fail. Agent-facing." }),
  acceptInvalid: agentMsg({ id: 'runtime.verdict.acceptInvalid', text: "accept: {test} isn't a test id, so it isn't accepted", note: "HI-2660: an accept entry that isn't a valid focused test id. {test}: what was given, quoted, short." }),
  acceptTooMany: agentMsg({ id: 'runtime.verdict.acceptTooMany', text: 'accept: only the first {max} tests are taken', note: "HI-2660: more than ACCEPT_MAX tests in cw_verdict's accept. {max}: the limit." }),
  acceptNone: agentMsg({ id: 'runtime.verdict.acceptNone', text: "accept: {test} has no counted run at this revision (or its command changed since), so it isn't accepted", note: "HI-2660: no standing run of focused:<test> at the passed revision to accept. {test}: the test id." }),
  acceptFailed: agentMsg({ id: 'runtime.verdict.acceptFailed', text: "accept: {test}'s latest counted run at this revision failed, so it isn't accepted", note: "HI-2660: the standing run of focused:<test> at the passed revision didn't pass; an earlier pass never stands behind it. {test}: the test id." }),
  questionDone: agentMsg({ id: 'runtime.wake.questionDone', text: '{card}: your question "{question}" no longer stands: the card is in Done.', note: "An asker's wake when the card reached Done with its question open. {question}: the question, quoted short (#1626)." }),
  boardDone: agentMsg({ id: 'runtime.repair.boardDone', text: 'the board had it in Done while its stage was {stage}', note: "A repair's reason, stored on the card's Moved fact: the board's column and the card's stage disagreed. {stage}: the stage id." }),
  laneStarted: agentMsg({ id: 'runtime.start.laneStarted', text: "Combwork started {card} for you, as your lane's next card: carry on with it.", note: "HI-2092: a lane's builder starting the card Combwork had already started for it: its start's warning." }),
  blocked: agentMsg({ id: 'runtime.start.blocked', text: '{card} is blocked: {why}', note: "A start's warning: the card is blocked. {why}: the block's reason, in its author's words." }),
  targetChanges: agentMsg({ id: 'runtime.start.targetChanges', text: "{target}'s folder {folder} has uncommitted changes ({files}): a merge into {target} that changes them pauses until they are committed or set aside. Combwork tells the user in its window; leave them as they are.", note: "HI-2944: a start's warning (never a refusal): the folder the target is checked out in has uncommitted changes; the user's window shows a notification with Commit and Set Aside. {files}: up to three paths, then how many more." }),
  moreFiles: agentMsg({ id: 'runtime.start.moreFiles', text: '{files} and {more} more', note: 'HI-2944: a list of paths cut at three, and how many more there are.' }),
  slotWait: agentMsg({ id: 'runtime.start.slotWait', text: '{card} waits for a slot: {why}', note: "A start's warning beside its refusal (#1438): why no slot is free." }),
  slotMove: agentMsg({ id: 'runtime.start.slotMove', text: "You'll continue in {slot}, on {line}: Combwork makes the line there from {target}, then gives you {card} there (a new conversation unless you already work there; your old one is kept). End your turn now.", note: "A start given a slot (#1438): the card's line is made there and the card given to the agent there, so it ends its turn now." }),
  staleChange: agentMsg({ id: 'runtime.wake.stalePaths', text: 'stale: your paths changed since the pass, submit again', note: "The builder's wake when its declared paths changed after its pass." }),
  approvedMerge: agentMsg({ id: 'runtime.wake.approvedMerge', text: 'approved: merge it and report the merge', note: "The builder's wake when its card passed and the builder merges it." }),
  movedAhead: agentMsg({ id: 'runtime.submit.movedAhead', text: 'moved ahead of {cards} (not started); its reviewer is told', note: "A submit's lane field: the card was moved before its lane's cards nobody has started. {cards}: their keys." }),
  followUp: agentMsg({ id: 'runtime.wake.followUp', text: '{card}: follow-up submitted for review at {revision} (submission {submission}). Start your review again (cw_start_review), which takes it and moves your review copy to it; a verdict on the earlier submission is refused', note: "HI-1832: the reviewer's wake for a follow-up (the card stays in Review, so no arrival wakes it). {revision}: short. {submission}: its number." }),
  aheadInLane: agentMsg({ id: 'runtime.wake.aheadInLane', text: '{card} is in Review ahead of {cards}, earlier in its lane, which nobody has started: Combwork moved it before them in the lane. Review {card} now; the lane goes on to {next} after it', note: "The reviewer's wake for a card submitted ahead of its lane's unstarted cards. {cards}: their keys. {next}: the first of them." }),
  inReview: agentMsg({ id: 'runtime.wake.inReview', text: '{card} is in Review', note: "The reviewer's wake for a card's arrival in Review." }),
  failedReview: agentMsg({ id: 'runtime.wake.failedReview', text: '{card} failed review', note: "The builder's wake for a failing verdict." }),
  resolutionOverride: agentMsg({ id: 'runtime.wake.resolutionOverride', text: '{card}: the user’s override of the release path’s direction is recorded on it, so its merge may bring {to} up to date with {from}. Submit the same revision again (cw_submit): it goes back into the merge queue once, as approved.', note: 'HI-3040: the builder’s wake when the user (or the Assistant on their explicit request) recorded an override on a forward merge’s resolution the queue returned for its direction. {from} and {to}: branch names.' }),
  staleSubmit: agentMsg({ id: 'runtime.wake.stale', text: 'stale: submit again', note: "The builder's wake when its pass went stale at the verdict (its line moved)." }),
  focusedSkip: agentMsg({ id: 'runtime.wake.focusedSkip', text: '{card}: its reviewer {merge, select, yes {accepted} other {declined}} the focused tests its merge skipped ({why})', note: "The builder's wake for its reviewer's cw_focused_skip. {merge}: yes when it accepted. {why}: the reviewer's reason." }),
  answered: agentMsg({ id: 'runtime.wake.answered', text: '{card}: the user {answer, select, approved {approved} declined {declined} other {answered}} "{question}"', note: "An answer's wake: what the user did with a question. {answer}: approved, declined or another answer. {question}: the question, quoted short (#1626); what they chose or noted follows." }),
  answeredChoice: agentMsg({ id: 'runtime.wake.answered.choice', text: '{said}: {choice}', note: "An answer's wake with the user's choice at the round limit. {said}: runtime.wake.answered. {choice}: runtime.choice.*." }),
  moreRounds: agentMsg({ id: 'runtime.wake.answered.rounds', text: '{said} ({rounds, plural, one {{rounds} more round} other {{rounds} more rounds}})', note: '{said}: the answer and its choice. {rounds}: the rounds the user gave.' }),
  answeredAction: agentMsg({ id: 'runtime.wake.answered.action', text: '{said}: {action}', note: "An answer's wake with the action the user took (#1630). {action}: runtime.action.*." }),
  answeredNote: agentMsg({ id: 'runtime.wake.answered.note', text: '{said} ({note})', note: "An answer's action with the user's note: {note}, in their words." }),
  answeredWith: agentMsg({ id: 'runtime.wake.answered.with', text: '{said}: {note}', note: "An answer's wake with the user's reply: {note}, in their words." }),
  byDecision: agentMsg({ id: 'runtime.wake.byDecision', text: '{card}: the user answered {questions} with a decision (recorded by {recordedBy}): {decision}', note: '{questions}: the questions, each quoted short, joined by runtime.wake.byDecision.and. {recordedBy}: who recorded it. {decision}: its text.' }),
  and: agentMsg({ id: 'runtime.wake.byDecision.and', text: '{list} and {item}', note: 'The questions a decision answered, joined: each one added to the list before it.' }),
  reviewerAsks: agentMsg({ id: 'runtime.wake.reviewerAsks', text: '{card}: the reviewer asks: {text}', note: "#912: the builder's wake for its reviewer's request mid-review. {text}: the request, in the reviewer's words." }),
  newDecision: agentMsg({ id: 'runtime.wake.newDecision', text: '{card} has a new decision', note: "The builder's (and a reviewing reviewer's) wake for a decision the user recorded on the card." }),
  doneByOverride: agentMsg({ id: 'runtime.move.doneByOverride', text: "{cards} can start without {card}'s work in the target: it is Done by an override, not merged.", note: "A move's warning: cards waiting on this one can start, but its work isn't in their target. {cards}: their keys." }),
  removed: agentMsg({ id: 'runtime.wake.removed', text: "{card} was taken out of the merge queue by {by, select, user {the user} other {the Assistant}}{reason}. It isn't merged; it is queued again only if the user retries it or it is approved again.", note: "The builder's wake for a card taken out of the queue. {by}: user or assistant. {reason}: \": \" and the reason, or nothing." }),
  pathsLeaveOut: agentMsg({ id: 'runtime.submit.pathsLeaveOut', text: "{card}'s paths leave out files it recorded as its agents' edits: {files}. Its revision covers only its paths: to include them, submit with paths listing every file of its work (or declare its paths); to leave them out, carry on.", note: "A submit's warning (HI-2339): files its agents edited that its declared paths leave out. {files}: those files." }),
  unclaimed: agentMsg({ id: 'runtime.submit.unclaimed', text: "Changed in the project since {card} started, in neither its paths nor what it recorded as its agents' edits: {files}. Not part of its revision: to include any, submit with paths listing every file of its work; else leave them.", note: "A submit's warning (HI-2339): files changed in the project that are neither its paths nor its agents' edits." }),
  laneListChanged: agentMsg({ id: 'runtime.wake.laneListChanged', text: "Your lane's card list changed, as queued: its cards are now {cards}. cw_lane next names your next card.", note: "A lane's builder's wake when its queued list applied. {cards}: the keys, in order." }),
  squashed: agentMsg({ id: 'runtime.wake.squashed', text: '{line} is up to date with {target} ({prev} was squashed into it): {next} can start.', note: "A builder's wake when its next card's line was moved onto the target after a squash merge. {prev}: the card squashed, {next}: the card that can start." })
}

/** Text a stored record keeps (a wake's action, a fact's reason): in the Default, whatever the caller's dialect. */
const stored = (m: AgentMsg, values?: AgentValues): string => inDefaultDialect(() => say(m, values))

/** The user's choice at the round limit, as an agent's wake says it. */
const CHOICE_WORDS: Record<RoundChoice, AgentMsg> = { carryOn: W.choiceCarryOn, split: W.choiceSplit, accept: W.choiceAccept, takeOver: W.choiceTakeOver }
/** What the user did with an action a question offered (#1630), as its answer's wake says it. */
const ACTION_WORDS: Record<AskActionKind, AgentMsg> = { done: W.actionDone, noCode: W.actionNoCode, unblock: W.actionUnblock, skipReview: W.actionSkipReview }

/** How much of the question an answer's wake quotes before the user's reply (#1626). */
const QUESTION_QUOTE_MAX = 200

/** A write inside one transaction, for one card: facts with the ruleset and actor, the stage cache, actions. */
export class Write {
  readonly written: Fact[] = []
  /**
   * The user's answer this write records, as agents read it (#1269): every wake it makes is an answer's (`about:
   * 'answer'`, delivered with or without a loop), saying the answer first; `woken`, the agents it woke.
   */
  answer: string | null = null
  readonly woken: string[] = []
  /** A builder's reported merge result nothing checked (Not checked), for the card's finish (HI-2014): a claim, never containment. */
  claimed: string | null = null
  /** The card's stage when the write began. */
  readonly was: StageId
  constructor(
    readonly tx: Tx,
    readonly card: CardRecord,
    readonly ruleset: Ruleset | null,
    readonly actor: Actor,
    private stage: StageId
  ) {
    this.was = stage
  }

  fact<K extends FactKind>(kind: K, data: FactData[K], actor: Actor = this.actor): Fact<K> {
    const f = this.tx.append(this.card.id, { kind, actor, source: 'recorded', ...(this.ruleset ? { ruleset: this.ruleset.id } : {}), data })
    this.written.push(f)
    return f
  }

  move(to: StageId, cause: FactData['Moved']['cause'], why?: string): void {
    if (to === this.stage) return
    this.fact('Moved', { from: this.stage, to, cause, ...(why ? { why } : {}) }) // i18n-ignore: a fact's kind and codes, not text
    this.tx.setStage(this.card.id, to)
    this.stage = to
  }

  get current(): StageId {
    return this.stage
  }

  /** An action for the card, for the fact that caused it (the last this write wrote, unless named). */
  action(kind: string, payload: Record<string, unknown> = {}, fact: number | null = this.written.at(-1)?.seq ?? null): number {
    return this.tx.action(this.card.id, kind, payload, fact)
  }

  /** The card's state with what this write has added. */
  state(): CardState {
    return foldCard(this.tx.facts(this.card.id), this.was)
  }
}

/** A start gathered outside the lock (§16.7): what its write records, and what its guards decide on. */
interface StartGathered {
  r: Ruleset
  o: WorkflowOptions
  data: FactData['Started']
  existing: boolean
  ins: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>
  before: Evidence
  warnings: string[]
  /** A slot's lease lent for this start (#1438): given back if the start isn't written. */
  lent: string | null
  /** None (HI-2340): the generation its whole-project read was made under; another at the write, it is gathered again. */
  baselineGen?: number
}

/** A submission gathered outside the lock: the revision with its endpoints, keys and files, and its guards' inputs. */
interface SubmitGathered {
  r: Ruleset
  o: WorkflowOptions
  /** The card as gathered (None: with the paths the submission sets, `setPaths`). */
  card: CardRecord
  s: CardState
  from: StageId
  agent: string | null
  /** Whose own running work the submission waits for (G13): the submitting agent, else the card's builder. */
  runner: string | null
  setPaths: string[] | null
  revision: string | null
  base: string | null
  key: string | null
  files: FactData['Submitted']['files']
  commits?: string[]
  paths?: string[]
  /** What only the platform records of the submission (`Submitted.platform`: jj's ids and chain, HI-2868). */
  platform?: Record<string, unknown>
  inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>
  /** G20 (HI-1367): its submission's operation, aborted once a newer submission of the card or its workspace's close ended it. */
  focusedOp?: AbortSignal
  warnings: string[]
  earlier: boolean
  fin: FinishInputs | Record<string, never>
  before: Evidence
  only?: (id: GuardId) => boolean
}

/** The guards a no-code card's submission keeps (§16.7.3). */
const NO_CODE_GUARDS: GuardId[] = ['submit.notDuplicate', 'submit.ownRunsStopped', 'submit.decisionsReceived']

/** A drag's write undone (it throws, so its part of the change is undone): a refusal, or rules not decided on (ask again). */
/**
 * The lanes' next cards whose builder's line is being moved now (moveLineOn, #1271), by project folder and card: their
 * start waits for that move's LineMoved, whichever runtime of the project starts them (HR2's round 2 finding 2).
 */
const lineMoving = new Map<string, LineBehind>()

/** A lane's next card held up by its builder's line (lineBehind, §16.19.2): the cards, the builder, its worktree and line now. */
export interface LineBehind extends LineNow {
  next: CardRecord
  prev: CardRecord
  builder: string
  folder: string
  target: string
  /** A move begun (its `LineMoving`) with no `LineMoved` after it, and the line not back where it was (HR2's round 3). */
  unfinished?: { from: string; to: string }
}

class DragUndone extends Error {
  constructor(readonly refused: GuardRefusal) {
    super(refused.rule)
  }
}

/** Refuses from inside a write, undoing what it wrote (writeWhole, dragForward). */
const undo = (g: GuardRefusal): never => {
  throw new DragUndone(g)
}

export class Workflow {
  readonly store: FactStore
  readonly none: NoneAdapter
  /** The platform adapters (§16.3.1): the runtime asks them, and never switches on a platform id. */
  private platforms: Record<PlatformId, PlatformAdapter>

  constructor(readonly cfg: WorkflowConfig) {
    this.store = cfg.store
    this.none = new NoneAdapter(cfg.project, cfg.options().excluded)
    this.platforms = adaptersFor(this, this.none)
  }

  /** The adapter of a ruleset's platform (a card keeps its ruleset's, so a switch applies from the next card). */
  platform(o: WorkflowOptions): PlatformAdapter {
    return this.platforms[o.platform]
  }

  /** A card's platform adapter, by the ruleset it works under. */
  platformOf(card: CardRecord, s: CardState = this.state(card)): PlatformAdapter {
    return this.platform(this.rulesetOf(card, s).options)
  }

  // --- Cards, rulesets, folders.

  createCard(input: { title: string; kind?: CardKind; labels?: string[]; blockedBy?: number[]; target?: string; paths?: string[] }): CardRecord {
    return this.store.createCard({ title: input.title, kind: input.kind ?? 'code', labels: input.labels ?? [], blockedBy: input.blockedBy ?? [], ...(input.target ? { target: input.target } : {}), ...(input.paths ? { paths: input.paths } : {}) })
  }

  /** A card by reference (`AM-12`, `#12`) or id; a plain number from an agent is refused (§16.12). */
  resolve(ref: unknown, actor: Actor = 'user'): CardRecord | Refusal {
    if (typeof ref === 'number' && !agentOf(actor)) return this.store.card(ref)
    const p = parseCardRef(ref)
    if (!p.ok) return refusal('card.plainNumber', { key: `${this.cfg.projectKey}-12` }, null)
    const c = 'key' in p.ref ? this.store.cardByKey(p.ref.key) : this.store.cards().find((x) => x.id === (p.ref as { alias: number }).alias)
    if (!c) return refusal('card.plainNumber', { key: `${this.cfg.projectKey}-12` }, null)
    // A forward merge (HI-2679) is the user's and the Assistant's alone: every intent of an agent on it is refused here.
    if (agentOf(actor) && this.state(c).forward) return refusal('forward.notAgents', { card: c.key }, null)
    return c
  }

  /**
   * The card's state from its facts, from its cached stage: a card no 1.0 rule has moved (one adopted at the upgrade,
   * whose stage is its column's, #1218) has no `Moved` saying where it is (#1268's S40); any `Moved` decides.
   */
  state(card: CardRecord | number): CardState {
    const rec = typeof card === 'number' ? this.store.card(card) : card
    return foldCard(this.store.facts(rec.id), rec.stage)
  }

  /** The current options, compiled and stored. */
  currentRuleset(save = true): Ruleset {
    const r = compile(this.cfg.options())
    if (!r.ok) throw new Error(`contradictory options: ${r.contradictions.join(', ')}`) // i18n-ignore: a programming error in the spike, never shown
    if (save) this.store.saveRuleset(r.ruleset)
    return r.ruleset
  }

  /**
   * The ruleset a card works under (§16.5.4): the one it started with until it's Done, unless the user applied changed
   * options to it since (an Override, §16.11.4: the latest one's); a card in Todo uses its lane's (the one in force when
   * the lane started), else the current one.
   */
  rulesetOf(card: CardRecord, s: CardState = this.state(card)): Ruleset {
    const facts = this.store.facts(card.id)
    // A forward resolution (HI-2959) merges as a merge commit, whatever its base's style.
    const base = s.resolves ? mergeCommitOf(this.baseRulesetOf(card, s, facts)) : this.baseRulesetOf(card, s, facts)
    // A card that skips review (#1625) runs under its rules with no review, whenever the skip was set.
    if (!reviewSkipOf(facts).skip) return base
    const skipped = skipReviewOf(base)
    if (skipped !== base) this.skippedBases.set(skipped.id, base)
    return skipped
  }

  /** Each ruleset with review skipped that `rulesetOf` gave, by id, and its base: a write stores both (#1625). */
  private readonly skippedBases = new Map<string, Ruleset>()

  /** The rules a card keeps (§16.5.4) or starts under, before its review skip (#1625) is applied. */
  private baseRulesetOf(card: CardRecord, s: CardState, facts: Fact[]): Ruleset {
    // A card back in Todo (put back, or a Done card reopened) starts its next cycle under the rules then (§16.5.4,
    // HR2's #1290 round 1): its last cycle's ruleset isn't its own any more.
    const own = s.started && s.stage !== 'todo' ? ownRuleset(facts, s) : null
    if (own) return this.store.ruleset(baseRulesetId(own))
    if (card.lane) {
      const lane = this.lane(card.lane)
      if (lane && !lane.ended && lane.ruleset) return this.store.ruleset(lane.ruleset)
    }
    // Not stored here (a read): a write naming it stores it in its own transaction (write()).
    return this.currentRuleset(false)
  }

  /** The rules a card's review skip (#1625) would leave out of: its base rules, as `rulesetOf` reads them. */
  reviewedRuleset(card: CardRecord, s: CardState = this.state(card)): Ruleset {
    return this.baseRulesetOf(card, s, this.store.facts(card.id))
  }

  /** The card's folder on disk: its own, or the project folder. */
  folderOf(s: CardState): string {
    return !s.started || s.started.folder === 'project' ? this.cfg.project : s.started.folder
  }

  ownLine = (s: CardState): boolean => !!s.started && s.started.folder !== 'project'

  // --- File-lock records (G16, #1481).

  /**
   * Each agent's current card, by agent: the card it started last (the project's starts in the order written), while
   * that cycle runs and the card isn't finished (Active to Merging). Its lock record (`locked`) is the agent's own changes
   * in a shared folder; an earlier card's stops counting once the agent starts another, and a card's once it is Done,
   * back in Todo or on hold.
   */
  currentCards(): Map<string, { card: CardRecord; s: CardState }> {
    // Read again only once the board has committed something (HI-1909: each agent's PreToolUse asks); never in a write.
    const token = this.store.readToken()
    if (token !== null && this.current?.token === token) return new Map(this.current.cards)
    const cards = this.readCurrentCards()
    if (token !== null) this.current = { token, cards }
    return new Map(cards)
  }

  /**
   * One agent's current card (currentCards), working out that agent's alone (HI-1909: each lock event asked for every
   * agent's, a card state each, to take one).
   */
  currentCard(agent: string): { card: CardRecord; s: CardState } | undefined {
    const token = this.store.readToken()
    if (token !== null && this.current?.token === token) return this.current.cards.get(agent)
    return this.readCurrentCards(agent).get(agent)
  }

  private current: { token: string; cards: Map<string, { card: CardRecord; s: CardState }> } | null = null

  /** The current cards (currentCards), with `only` that agent's alone. */
  private readCurrentCards(only?: string): Map<string, { card: CardRecord; s: CardState }> {
    const last = new Map<string, Fact>()
    for (const f of this.store.factsOfKind(['Started', 'Adopted'])) { // i18n-ignore: fact kinds, not text
      const b = (f.data as FactData['Started']).builder
      if (b && b !== 'user' && (only === undefined || b === only)) last.set(b, f)
    }
    const out = new Map<string, { card: CardRecord; s: CardState }>()
    for (const [b, f] of last) {
      if (this.store.isArchived(f.card)) continue
      const card = this.store.card(f.card)
      if (!LOCK_STAGES.includes(card.stage)) continue
      const s = this.state(card)
      if (s.cycle === f.seq && LOCK_STAGES.includes(s.stage)) out.set(b, { card, s })
    }
    return out
  }

  /**
   * Records paths an agent held file locks on, on its current card when the locks were seen (`seen`). Decided in the
   * write, against the cards as they are then: the card must still be the agent's current one in that cycle (a lock seen
   * before the agent started its next card is never put on that one), and only paths not recorded this cycle are.
   * Returns whether anything was written.
   */
  async recordLocks(agent: string, paths: string[], seen: LockSeen): Promise<boolean> {
    const first = this.currentCard(agent)
    if (!first || ('card' in seen && (first.card.id !== seen.card || first.s.cycle !== seen.cycle))) return false
    return this.write(first.card, null, agentActor(agent), (w) => {
      const now = this.currentCard(agent)
      if (!now || now.card.id !== first.card.id || now.s.cycle !== first.s.cycle) return false
      // Seen when the cards weren't read: only a card started before then.
      const startedAt = 'at' in seen ? this.store.facts(now.card.id).find((f) => f.seq === now.s.cycle)?.at : null
      if ('at' in seen && (!startedAt || startedAt >= seen.at)) return false
      const fresh = [...new Set(paths)].filter((p) => !now.s.locked.includes(p))
      if (!fresh.length) return false
      w.fact('FilesLocked', { agent, paths: fresh })
      return true
    })
  }

  // --- Writing.

  /**
   * One write for a card, in one transaction; then the actions run (unless left pending). `prepare`: what the write
   * decides on that lives outside the card's facts (a design's reviewer, #1382), read inside the same lock (in the app,
   * the same board change) just before the transaction, so nothing that change orders against comes between.
   */
  async write<T, P = undefined>(card: CardRecord, ruleset: Ruleset | null, actor: Actor, fn: (w: Write, prepared: P) => T, prepare?: () => Promise<P>): Promise<T> {
    const also = alongsideOf.getStore()
    let movedTo: { from: StageId; to: StageId } | null = null
    const out = await this.locked(async () => {
      const prepared = (prepare ? await prepare() : undefined) as P
      let w: Write | null = null
      const r = this.store.tx((tx) => {
        // The ruleset its facts name, stored with them.
        if (ruleset) tx.saveRuleset(ruleset)
        // Its base too (#1625): the rules it is found again by once its review skip is undone.
        const base = ruleset && this.skippedBases.get(ruleset.id)
        if (base) tx.saveRuleset(base)
        w = new Write(tx, tx.card(card.id), ruleset, actor, tx.card(card.id).stage)
        const written = fn(w, prepared)
        this.closeSettled(w)
        // Into Done by whatever route: its finish, once, in the move's own transaction (HI-2014).
        if (w.current === 'done' && w.was !== 'done') {
          recordFinish(tx, w.card.id, w.actor, w.ruleset?.id ?? null, w.written, { claimed: w.claimed })
          this.kickDependents(w)
        }
        return written
      })
      // What the call runs alongside (the board's 0.9 fields), in the same transaction, once this write changed the card.
      if (also && w && (w as Write).written.length) await also.written(w)
      const done = w as Write | null
      if (done && done.current !== done.was) movedTo = { from: done.was, to: done.current }
      return r
    })
    // Set in the write's continuation above (TypeScript can't see it there).
    const m = movedTo as { from: StageId; to: StageId } | null
    if (m && this.cfg.moved) {
      try {
        this.cfg.moved(card, m.from, m.to)
      } catch {
        // A hook's own failure never undoes or fails the committed write.
      }
    }
    if (this.cfg.autoRun !== false) await this.runActions()
    return out
  }

  /**
   * Requests a write settled without an answer (#1638), closed in the same write: a question still open once the card is
   * in Done (an agent's or the Assistant's, askedQuestion; an agent that asked is told, unless it made the move), and an
   * agent's own questions once it moves the card on itself (a submit, a put back: it went on, answered some other way).
   * Combwork's own requests stay: a merge stopped part way still needs the user on a Done card.
   */
  private closeSettled(w: Write): void {
    if (!w.written.length) return
    const done = w.current === 'done'
    const agent = agentOf(w.actor)
    const movedOn = !!agent && w.written.some((f) => f.kind === 'Moved')
    if (!done && !movedOn) return
    for (const r of w.state().requests) {
      if (!askedQuestion(r)) continue
      const own = movedOn && r.gate === 'ask' && r.asker === agent
      if (!done && !own) continue
      w.fact('RequestClosed', { request: r.request, why: done ? 'done' : 'carriedOn' }) // i18n-ignore: a fact's kind and codes, not text
      if (done && r.asker && r.asker !== agent) {
        const asked = [...r.text.replace(/\s+/g, ' ').trim()]
        const quoted = asked.length > QUESTION_QUOTE_MAX ? `${asked.slice(0, QUESTION_QUOTE_MAX - 1).join('')}…` : asked.join('')
        this.wake(w, r.asker, stored(W.questionDone, { card: w.card.key, question: quoted }), 'answer')
      }
    }
  }

  /**
   * A step of a card's finish recorded once (HI-2014), in a write of its own: `superseded` when that finish is over (the
   * card left Done, or finished again), `already` when the step was recorded. Recording `requests` in Done closes the
   * card's asked questions in the same write (closeSettled), so no route leaves one open.
   */
  async finishStep(card: CardRecord, finish: number, step: FinishStepId): Promise<'done' | 'already' | 'superseded'> {
    return this.write(card, null, 'combwork', (w) => {
      const s = w.state()
      if (s.finished?.seq !== finish) {
        const noted = w.tx.facts(card.id).some((f) => f.kind === 'FinishStep' && (f.data as FactData['FinishStep']).finish === finish && (f.data as FactData['FinishStep']).step === step)
        if (!noted) w.fact('FinishStep', { finish, step, outcome: 'superseded', why: s.stage === 'done' ? 'finished again' : `left Done for ${s.stage}` }) // i18n-ignore: a fact's kind and codes, not text
        return 'superseded'
      }
      if (s.finished.steps.includes(step)) return 'already'
      w.fact('FinishStep', { finish, step, outcome: 'done' }) // i18n-ignore: a fact's kind and codes, not text
      return 'done'
    })
  }

  /**
   * A finish's loop wake (HI-2014): its builder told the card is Done, once for the move that finished it, whatever made
   * it. A board move's recorder already wrote it (the same move's `wake` action): nothing more. Only while the card is in
   * a loop (it was reviewed by an agent, or its lane runs) and `finish` is still the card's. True when it was written.
   */
  async finishWake(card: CardRecord, finish: number): Promise<boolean> {
    return this.write(card, null, 'combwork', (w) => {
      const s = w.state()
      if (s.finished?.seq !== finish || !s.started) return false
      const facts = w.tx.facts(card.id)
      const moved = facts.findLast((f) => f.kind === 'Moved' && f.seq < finish && (f.data as FactData['Moved']).to === 'done')
      if (!moved || w.tx.hasAction(card.id, 'wake', moved.seq)) return false
      const lane = card.lane ? this.store.lane(card.lane) : null
      const loop = facts.some((f) => f.kind === 'ReviewStarted') || (!!lane && !lane.ended)
      if (!loop) return false
      w.action('wake', { agent: 'builder', about: 'done', by: moved.actor }, moved.seq)
      return true
    })
  }

  /**
   * A finished card's slot that couldn't be detached for uncommitted changes (HI-2014): asked of the user once (For you,
   * SLOT_DIRTY_GATE), while that finish is the card's. False when it wasn't asked (asked already, or the finish is over).
   */
  async askSlotDirty(card: CardRecord, finish: number, v: { slot: string; line: string; target: string }): Promise<boolean> {
    return this.write(card, null, 'combwork', (w) => {
      const s = w.state()
      if (s.finished?.seq !== finish || s.requests.some((r) => r.gate === SLOT_DIRTY_GATE)) return false
      this.askUser(w, 'decide', SLOT_DIRTY_GATE, workflowText(FOR_YOU.slotDirty, { card: card.key, ...v }), { unbound: true })
      return true
    })
  }

  /**
   * The question about a finished card's slot closed (HI-2014): the slot is clean now, detached or another card's. Only
   * while `finish` is the card's: a later finish's question is its own.
   */
  async closeSlotDirty(card: CardRecord, finish: number): Promise<boolean> {
    return this.write(card, null, 'combwork', (w) => {
      const s = w.state()
      const open = s.finished?.seq === finish ? s.requests.filter((r) => r.gate === SLOT_DIRTY_GATE) : []
      for (const r of open) w.fact('RequestClosed', { request: r.request, why: 'slotClean' }) // i18n-ignore: a fact's kind and codes, not text
      return open.length > 0
    })
  }

  /**
   * A card the board has in Done while its stage isn't (HI-1674: a move that reached the column and not the workflow,
   * from before setStage cleared a started card's 1.0 mark): its stage brought into line as a repair (`Moved` to done,
   * cause `repair`, the stage it had said), its asked questions closed with it (closeSettled). Checked in the write's own
   * change: a card moved since it was picked (the user's move back to Doing), done meanwhile, or no longer this project's
   * is left. False when there was nothing to do.
   */
  async repairToDone(id: number): Promise<boolean> {
    const card = this.store.cardByKey(`#${id}`)
    if (!card) return false
    return this.write(card, null, 'combwork', (w) => {
      const now = this.store.cardByKey(`#${id}`)
      if (!now || now.category !== 'done' || w.current === 'done') return false
      w.move('done', 'repair', stored(W.boardDone, { stage: w.current }))
      return true
    })
  }

  /**
   * A write that may refuse after it has written part of its change (a reopening's move to Todo, a review it started):
   * such a refusal is thrown with `undo` and the write's transaction undone whole, the refusal returned (#1268).
   */
  private async writeWhole(card: CardRecord, ruleset: Ruleset | null, actor: Actor, fn: (w: Write) => GuardRefusal | null): Promise<GuardRefusal | null> {
    try {
      return await this.write(card, ruleset, actor, fn)
    } catch (e) {
      if (e instanceof DragUndone) return e.refused
      throw e
    }
  }

  /** Runs a write under the lock its store needs (cfg.locked), else as it is. */
  locked<T>(fn: () => T): Promise<T> {
    return this.cfg.locked ? this.cfg.locked(fn) : Promise.resolve(fn())
  }

  /** A refusal: recorded as `Refused` when an agent or the Assistant was refused (the user's refused drags aren't). */
  // agent-protocol: who can override a refusal, the Agent API's fixed `override` value (AGENT_API.md, §16.8.3)
  async refuse(card: CardRecord | null, actor: Actor, move: string, g: GuardRefusal, override: Refusal['override'] = 'the user'): Promise<Refusal> { // i18n-ignore: the override field, agent-facing (§16.8.3)
    // A card refused for what couldn't be read, its platform's repository gone (S20, Git): the next step is the offer (#1419).
    const needs = g.rule === 'platform.unknown' && card ? this.rulesetOf(card).options.platform : null
    if (needs && needsRepository(needs) && this.cfg.repositoryGone?.(needs)) g = { ...g, values: { ...g.values, offer: 'repositoryGone' } }
    const side = g.rule === 'move.notFromHere' && card ? this.sideOf(card, actor, move, g.values.stage) : null
    if (side) g = { ...g, values: { ...g.values, ...side } }
    const out = refusal(g.rule, g.values, override)
    if (card && actor !== 'user') {
      // Under the store's lock, as every write (in the app, a change of the board).
      await this.locked(() => this.store.tx((tx) => tx.append(card.id, { kind: 'Refused', actor, source: 'recorded', data: { move, rule: g.rule, message: out.message, next: out.next, values: g.values } }))) // i18n-ignore: a fact's kind and codes, not text
    }
    return out
  }

  /**
   * An agent refused a move for where its card is, when that stage's intents are the other side's (#1604): a reviewer's
   * review or verdict on a card that left Review (its review is over: it waits for the card's return, or leaves it), or
   * its builder's move while the card waits in Review (it waits for the verdict). Null for the user, or where the
   * stage's own intents are the agent's next step.
   */
  private sideOf(card: CardRecord, actor: Actor, move: string, stage: unknown): { whose: 'reviewer' | 'builder' | 'builderSubmit'; back?: 'yes' | 'no' } | null {
    const agent = agentOf(actor)
    if (!agent || typeof stage !== 'string') return null
    const builds = this.state(card).builders.includes(agent)
    if (REVIEW_MOVES.has(move) && stage !== 'review' && !builds) return { whose: 'reviewer', back: stage === 'todo' || stage === 'active' ? 'yes' : 'no' }
    // A submission again (HI-1832): a change its reviewer asked for goes in as a follow-up.
    if (move === 'submit' && stage === 'review' && builds) return { whose: 'builderSubmit' }
    if (!REVIEW_MOVES.has(move) && stage === 'review' && builds) return { whose: 'builder' }
    return null
  }

  private notFrom(card: CardRecord, actor: Actor, s: CardState, move: string): Promise<Refusal> {
    return this.refuse(card, actor, move, { rule: 'move.notFromHere', values: { card: card.key, stage: s.stage, move, moves: this.movesFrom(s.stage, this.rulesetOf(card, s), s).join(', ') } })
  }

  /** What comes next on card `n` from where it is now, under its rules (#1530: an intent's reply names it). */
  nextFor(n: number): NextStep | null {
    const card = this.store.card(n)
    const s = this.state(card)
    return nextStep(s, this.rulesetOf(card, s))
  }

  /** The intents an agent can use from a stage under a ruleset (§16.7.2's table): what a refusal offers as the next step. */
  movesFrom(stage: StageId, r?: Ruleset, s?: CardState): string[] {
    const o = r?.options
    switch (stage) {
      case 'todo':
        return ['start']
      case 'active':
        return ['submit', 'put back', ...(r && s && awaitsAgentMerge(r, s) ? ['report merge'] : [])] // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      case 'review':
        return !o || reviewerAgent(o.review) ? ['start review', 'verdict'] : [] // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      case 'approved':
        return [...(s?.stale ? ['submit'] : []), ...(!o || o.finish === 'agentMerges' || o.finish === 'notChecked' ? ['report merge'] : [])] // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      default:
        return []
    }
  }

  private ok(card: CardRecord, from: StageId, to: StageId, data?: Record<string, unknown>, warnings?: string[]): Moved {
    return { ok: true, card: card.key, from, to, ...(data ? { data } : {}), ...(warnings?.length ? { warnings } : {}) }
  }

  /** Guards evaluated inside the transaction, on the card's facts as they are now. */
  private check(w: Write, move: MoveId, inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>, only?: (id: GuardId) => boolean): GuardRefusal | null {
    return evaluate(this.guardIds(w, move, only), this.guardInputs(w, inputs))
  }

  /**
   * HI-2854 (Darren's B): an agent's own submit, in a ruleset that doesn't hold `submit.decisionsReceived` already (Solo,
   * All off: their compiled guards and ids unchanged, so the user's drags there still ask nothing), is refused all the
   * same while the agent hasn't seen a decision or a comment of the user's: work-on-card no longer reads the card again
   * before submitting. In the submit's write, under its lock; nothing with the rules off, or what an override leaves out.
   */
  private agentHasSeen(w: Write, inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>, only?: (id: GuardId) => boolean): GuardRefusal | null {
    const id: GuardId = 'submit.decisionsReceived'
    if (!this.enforced() || !inputs.agent || (only && !only(id)) || (w.ruleset?.guards.submit ?? []).includes(id)) return null
    return evaluate([id], this.guardInputs(w, inputs))
  }

  private guardIds(w: Write, move: MoveId, only?: (id: GuardId) => boolean): GuardId[] {
    return this.idsOf(w.ruleset, move, only)
  }

  /** What runs a target's queue in this Combwork now (cfg.queueLive): for the queue's order, queueState.ts. */
  queueLive(target: string): QueueLive {
    return this.cfg.queueLive?.(target) ?? NOT_RUN_HERE
  }

  /** Whether the guards run (cfg.enforced: Settings → Advanced, #1265). */
  enforced(): boolean {
    return this.cfg.enforced ? this.cfg.enforced() : true
  }

  /** A move's guards in a ruleset, those `only` keeps; none while the rules aren't enforced. */
  private idsOf(r: Ruleset | null, move: MoveId, only?: (id: GuardId) => boolean): GuardId[] {
    if (!this.enforced()) return []
    return (r?.guards[move] ?? []).filter((id) => !only || only(id))
  }

  private guardInputs(w: Write, inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>): GuardInputs {
    return this.inputsOf(w.card, w.state(), w.ruleset!, inputs)
  }

  private inputsOf(card: CardRecord, s: CardState, r: Ruleset, inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>): GuardInputs {
    return { card: { key: card.key, kind: card.kind, labels: card.labels, blocked: s.blocked }, state: s, ruleset: r, ...inputs }
  }

  /** The rules a move's guards refuse on a state, read outside the write (a drag deciding what to ask): none, each once. */
  private failingOf(card: CardRecord, s: CardState, r: Ruleset, move: MoveId, inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>, only?: (id: GuardId) => boolean): string[] {
    return [...new Set(evaluateAll(this.idsOf(r, move, only), this.inputsOf(card, s, r, inputs)).map((f) => f.rule))]
  }

  /** The same, in the write, on the card's facts as they are now. */
  private failingIn(w: Write, move: MoveId, inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>, only?: (id: GuardId) => boolean): string[] {
    return [...new Set(evaluateAll(this.guardIds(w, move, only), this.guardInputs(w, inputs)).map((f) => f.rule))]
  }

  /**
   * An intent's guards for the user's (or the Assistant's) drag (§16.8.4): nothing refuses → it just moves; else, asking,
   * the rules that refuse (`move.needsOverride`, nothing written); across them, an `Override` naming exactly those.
   */
  private across(w: Write, move: MoveId, to: StageId, inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>, drag: Drag, only?: (id: GuardId) => boolean): GuardRefusal | null {
    const failing = evaluateAll(this.guardIds(w, move, only), this.guardInputs(w, inputs))
    if (!failing.length) return null
    const rules = [...new Set(failing.map((f) => f.rule))]
    if (drag.ask) return { rule: 'move.needsOverride', values: { card: w.card.key, stage: to, rules: rules.join(', ') } }
    w.fact('Override', { rules, move: `${w.current}→${to}`, by: drag.by, reason: drag.reason }) // i18n-ignore: a fact's kind and codes, not text
    return null
  }

  // --- Intents and moves (§16.7.2).

  /** start: Todo → Active, the card's line and base recorded, its folder prepared (slots). */
  async start(ref: unknown, actor: Actor, opts: { builder?: string; drag?: Drag; reopen?: boolean } = {}): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    // `reopen`: a Done card started again, or one On Hold never started (an agent's old move to Doing, #1268), back to
    // Todo and started in one write, its new cycle gathered and guarded as from Todo (§16.7.4, as the user's reopening).
    const reopening = !!opts.reopen && (s.stage === 'done' || (s.stage === 'hold' && !s.started))
    // A lane's card Combwork has just started for this builder (HI-1990, laneStarts.ts): its own start, racing Combwork's, is that
    // start, not a refusal; Combwork's landing between this start's checks and its write too (HI-2029's lanebrief run).
    const forIt = (st: CardState): Reply | null =>
      st.stage === 'active' && !!st.started && !!agentOf(actor) && st.started.builder === agentOf(actor) && this.store.facts(card.id).find((f) => f.seq === st.started!.seq)?.actor === 'combwork'
        ? this.ok(card, 'active', 'active', { folder: this.folderOf(st), line: st.started.line, base: st.started.base, target: st.started.target }, [say(W.laneStarted, { card: card.key })])
        : null
    const started = forIt(s)
    if (started) return started
    if (s.stage !== 'todo' && !reopening) return this.notFrom(card, actor, s, 'start')
    const from: CardState = reopening ? { ...s, stage: 'todo' } : s
    // One card at a time (#1270, §16.11.2): a lane's card starts only once the cards before it in the lane are Done. The
    // user's own drag is theirs to make.
    const lane = this.enforced() && !opts.drag ? this.laneRefusal(card) : null
    if (lane) return this.refuse(card, actor, 'start', lane)
    // Its builder's worktree still has an earlier card's squashed work (§16.19.2, #1271): it waits for Combwork (or the user)
    // to bring the branch up to date, so its change is only its own.
    const behind = this.enforced() && !opts.drag ? await this.lineBehind(card) : null
    if (behind) return this.refuse(card, actor, 'start', { rule: 'lane.lineBehind', values: { card: card.key, earlier: behind.prev.key, line: behind.line ?? behind.folder, target: behind.target } })
    // Its line being moved right now: it waits for that move's LineMoved (refused as behind, checked again in its write).
    const moving = (): GuardRefusal | null => {
      const m = this.enforced() && !opts.drag ? lineMoving.get(this.movingKey(card.id)) : undefined
      return m ? { rule: 'lane.lineBehind', values: { card: card.key, earlier: m.prev.key, line: m.line ?? m.folder, target: m.target } } : null
    }
    const inMove = moving()
    if (inMove) return this.refuse(card, actor, 'start', inMove)
    const g = await this.gatherStart(card, from, actor, opts.builder)
    if (!('data' in g)) return this.refuse(card, actor, 'start', g)
    try {
      // HI-2985: a forward's resolution starts only on the branch it resolves (one made unpinned, or Work merges into moved).
      const res = from.resolves
      if (res && g.data.target !== res.to) return await this.refuse(card, actor, 'start', { rule: 'forward.resolutionTarget', values: { card: card.key, from: res.from, to: res.to, target: g.data.target ?? '' } })
      // Its ruleset is stored by the write that names it (write()), under the store's lock.
      await this.cfg.hooks?.beforeWrite?.('start')
      // How many times it may be gathered again while only its fingerprint moved (its platform's; HI-2916: jj's head moves
      // with Combwork's own jj operations beside it).
      const gathers = this.platform(g.o).startGathers ?? 1
      // Each pass gathered again is awaited here, never returned bare (HI-2916): this pass's `finally` gives back the slot
      // it lent only once the pass after has started with it, or hasn't. Returned bare, the `finally` ran at once, so the
      // pass after found its lease ended, lent another, and a third could find the slot still settling and wait.
      if (await this.revalidate(card, from, g.o, g.before, gathers)) return await this.regather(card, () => this.start(ref, actor, opts))
      let laneMoved = false
      let baselineMoved = false
      let evidenceMoved = false
      const out = await this.writeWhole(card, g.r, actor, (w) => {
        const moved = this.stillAt(w, s, 'start')
        if (moved) return moved
        // Back to Todo first: its evidence was gathered on that state.
        if (reopening) w.move('todo', 'intent')
        // Refused once it has moved it back to Todo: undone whole (writeWhole), nothing of the reopening kept (a lane's
        // boundary applied in it too: the next write applies it again).
        const undone = (g2: GuardRefusal): GuardRefusal => (reopening ? undo(g2) : g2)
        // None (HI-2340): its baseline read under the folders left out as they are now, else gathered again (once).
        const changed = this.evidenceChanged(w, g.o, g.before)
        if (changed) {
          evidenceMoved = true
          return undone(changed)
        }
        if (g.baselineGen !== undefined && g.baselineGen !== this.none.generation) {
          baselineMoved = true
          return undone({ rule: 'evidence.changed', values: { card: card.key } } as GuardRefusal)
        }
        // Decided where the start is written, from the lane as it is there (HR6's #1270 round 1, the Assistant's round 4
        // design): a queued list whose boundary has passed applies first (committed with its wake even if this start is
        // then refused: the boundary passed either way), then the start is checked against it.
        // The platform fence (HI-2799): a start is an admission on the project's repository, decided in this transaction.
        const fenced = this.cfg.projectId ? admit({ get: (k) => this.store.boardMeta(k), set: () => undefined }, this.cfg.projectId(), g.o.platform) : null
        if (fenced) return undone(fenced.why === 'switching' ? { rule: 'platform.switching', values: { card: card.key } } : { rule: 'platform.changed', values: { card: card.key, platform: workflowText(PLATFORM_NAME[fenced.now]) } })
        if (this.enforced() && !opts.drag) {
          this.applyLaneBoundary(w, this.store.card(card.id))
          // The lane and ruleset the gather used must still be the card's (HR6's round 4: a queued list that took the card
          // out, or a lane changed meanwhile): else it is gathered again from the top, once, as what it is now.
          const now = this.store.card(card.id)
          const r = this.rulesetOf(now, w.state())
          if ((now.lane ?? null) !== (card.lane ?? null) || r.id !== g.r.id || r.version !== g.r.version) {
            laneMoved = true
            return undone({ rule: 'evidence.changed', values: { card: card.key } } as GuardRefusal)
          }
        }
        const waits = (this.enforced() && !opts.drag ? this.laneRefusal(this.store.card(card.id)) : null) ?? moving()
        if (waits) return undone(waits)
        // The user's Start across a rule: the rules skipped are recorded, and the start's own facts still are.
        const bad = opts.drag ? this.across(w, 'start', 'active', g.ins, opts.drag) : this.check(w, 'start', g.ins)
        if (bad) return undone(bad)
        this.applyStart(w, g, w.written.some((f) => f.kind === 'Override') ? 'override' : actor === 'user' ? 'user' : 'intent')
        return null
      })
      if (out && (laneMoved || baselineMoved) && !this.gathering.depth(card.id)) return await this.regather(card, () => this.start(ref, actor, opts))
      // Its fingerprint moved again between the last gather and the write, its answer by content still the same, or the
      // fingerprint unreadable at that instant (HI-2972): gathered again from the top while its platform allows more
      // passes (none beyond #1206's one unless it says so), else refused.
      if (out && evidenceMoved) {
        const again = gathers > 1 && this.gathering.depth(card.id) < gathers ? await this.startAgain(card, from, g.o, g.before) : null
        if (again) {
          this.startPassLog(card, 'write', again, gathers)
          return await this.regather(card, () => this.start(ref, actor, opts))
        }
      }
      if (out?.rule === 'evidence.changed') this.startRefusedLog(card, laneMoved ? 'lane' : baselineMoved ? 'baseline' : 'write', gathers, evidenceMoved ? this.noPassWhy(card, gathers) : undefined)
      if (out) return (out.rule === 'move.notFromHere' ? forIt(this.state(this.store.card(card.id))) : null) ?? this.refuse(card, actor, 'start', out)
      const moved = this.ok(card, s.stage, 'active', { folder: this.folderOf(this.state(card)), line: g.data.line, base: g.data.base, target: g.data.target }, g.warnings)
      return g.data.lease && g.data.slot ? { ...moved, placed: true } : moved
    } finally {
      // A slot lent for it and not started with (refused, undone): given back (#1438).
      if (g.lent) await this.slotUnused(card, g.lent)
    }
  }

  /** A start's slow part, outside the lock: its folder, line, base and target, the cards it waits for, its evidence. */
  private async gatherStart(card: CardRecord, s: CardState, actor: Actor, builderOpt?: string, dry = false): Promise<StartGathered | GuardRefusal> {
    const r = this.rulesetOf(card, s)
    const o = r.options
    // The agent it is started for: one named (the user's drag, an agent's old move giving it to another, #1268), else the starter.
    const builder = builderOpt ?? agentOf(actor) ?? 'user'
    const warnings: string[] = []
    if (s.blocked && !r.guards.start.includes('start.notBlocked')) warnings.push(say(W.blocked, { card: card.key, why: s.blocked }))
    // Its target's ref included, resolved as the plan resolves it (#1401: the default branch, when G7 is empty).
    const before = await this.evidenceOf(card, s, o, builder)
    const plan = await this.platform(o).start(card, o, builder, dry)
    if (isUnknown(plan)) {
      // Which read and why (HI-2916): the refusal says only what couldn't be read.
      log.info(`#${card.id} not started: ${userText(plan.what)}${plan.detail ? ` (${userText(plan.detail)})` : ''}`)
      return { rule: 'platform.unknown', values: { card: card.key, what: plan.whatText ?? plan.what, rule: 'start' } }
    }
    const { existing, slotWait, fresh, baselineGen, ...planned } = plan
    // A slot lent for this start (#1438) is given back if the start isn't written (refused, gathered again, undone).
    const lent = fresh && plan.lease ? plan.lease : null
    // Its target resolved again as it was planned (the builder worktree's base moved meanwhile): not what the evidence
    // covers, so a change to it before the write would go unseen (#1401 round 2).
    if (!this.platform(o).planCovered(before.primed, plan)) {
      if (lent) await this.slotUnused(card, lent)
      this.startRefusedLog(card, 'plan', this.platform(o).startGathers ?? 1)
      return { rule: 'evidence.changed', values: { card: card.key } } as GuardRefusal
    }
    const data: FactData['Started'] = { ...planned, builder, cardKind: card.kind }
    if (dry) delete data.lease
    if (slotWait) warnings.push(say(W.slotWait, { card: card.key, why: slotWait }))
    // Where it is built (#1438): its builder is given it there once its line is made, so a builder starting it ends its turn.
    if (data.lease && data.slot) warnings.push(say(W.slotMove, { slot: String(data.slot), line: String(data.line), target: String(data.target), card: card.key }))
    // HI-2944: its target's folder with uncommitted changes, said before the start is written or any work is dispatched:
    // a merge into it that changes them pauses. A warning only; never asked of a dry run (a drag's plan). HI-2984: only
    // where something merges into the target, from another folder than the one the card is built in.
    const tc = !dry && data.target ? await this.platform(o).targetChanges?.(String(data.target)).catch(() => null) : null
    if (tc && targetChangesApply(o, tc.folder, data.folder === 'project' ? this.cfg.project : String(data.folder))) {
      warnings.push(say(W.targetChanges, { target: tc.target, folder: tc.folder, files: filesNamed(tc.files) }))
      this.cfg.targetChanges?.(tc, card.key)
    }
    // Dependencies Done by facts, in this card's target (§16.7.4).
    const waitingFor = r.guards.start.includes('start.dependenciesIntegrated') ? await this.waitingFor(card, data.target, o) : []
    return { r, o, data, existing: !!existing, ins: { agent: agentOf(actor), waitingFor, slotFree: !slotWait }, before, warnings, lent, ...(baselineGen !== undefined ? { baselineGen } : {}) }
  }

  /**
   * A slot's lease lent for a start of the card that wasn't written (#1438): given back, unless the card started with it
   * after all (a start gathered again reuses its card's lease, and its write is the one that counts).
   */
  private async slotUnused(card: CardRecord, lease: string): Promise<void> {
    if (this.state(card).started?.lease === lease) return
    await this.cfg.slotUnused?.(lease).catch(() => undefined)
  }

  /** A start's facts and actions, in its write: `Started`, the move into Active, its folder prepared (a slot of its own). */
  private applyStart(w: Write, g: StartGathered, cause: FactData['Moved']['cause']): void {
    w.fact('Started', g.data) // i18n-ignore: a fact's kind and codes, not text
    w.move('active', cause)
    // A slot's (#1438): its lease's, and whether it is brought up to date (G15).
    if (g.data.folder !== 'project' && !g.existing) w.action('prepareSlot', { folder: g.data.folder, line: g.data.line, base: g.data.base, ...(g.data.lease ? { slot: g.data.slot, lease: g.data.lease, upToDate: g.o.slotsUpToDate, builder: g.data.builder } : {}) })
  }

  /** The card's state as it would be once a gathered start is written (a drag gathers its submission on it). */
  private predicted(card: CardRecord, s: CardState, g: StartGathered): CardState {
    const facts = this.store.facts(card.id)
    const seq = (facts.at(-1)?.seq ?? 0) + 1
    const at = new Date().toISOString()
    const started: Fact<'Started'> = { seq, card: card.id, kind: 'Started', at, actor: 'combwork', source: 'recorded', data: g.data } // i18n-ignore: a fact's kind and codes, not text
    const moved: Fact<'Moved'> = { seq: seq + 1, card: card.id, kind: 'Moved', at, actor: 'combwork', source: 'recorded', data: { from: s.stage, to: 'active', cause: 'user' } } // i18n-ignore: a fact's kind and codes, not text
    return foldCard([...facts, started, moved])
  }

  /** put back: Active → Todo; its folder is released. */
  async putBack(ref: unknown, actor: Actor, args: { why?: string } = {}): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    if (s.stage !== 'active') return this.notFrom(card, actor, s, 'put back') // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    const out = await this.write(card, this.rulesetOf(card, s), actor, (w) => {
      const changed = this.stillAt(w, s, 'put back') // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      if (changed) return changed
      w.move('todo', 'intent', args.why)
      w.action('releaseSlot', {})
      return null
    })
    if (out) return this.refuse(card, actor, 'put back', out) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    return this.ok(card, 'active', 'todo')
  }

  /**
   * The card changed between the reads an intent gathered and its transaction (another intent or move won the race):
   * its stage, cycle, latest submission or queue entries differ. Refused from where it is now, never applied to a card
   * that moved on (§16.7, ARCHITECTURE "The one path").
   */
  stillAt(w: Write, s: CardState, move: string): GuardRefusal | null {
    const now = w.state()
    if (now.stage === s.stage && now.cycle === s.cycle && (now.latest?.id ?? 0) === (s.latest?.id ?? 0) && now.entries.length === s.entries.length) return null
    return { rule: 'move.notFromHere', values: { card: w.card.key, stage: now.stage, move, moves: this.movesFrom(now.stage, w.ruleset ?? undefined, now).join(', ') } }
  }

  /**
   * What an intent decides on, fingerprinted (§16.7, ARCHITECTURE "The one path"): its platform's evidence (refs,
   * None's paths' hash) and the facts of the cards it waits for. Taken before the slow reads and again inside the
   * transaction (`evidenceChanged`), so nothing is written on evidence that changed meanwhile.
   */
  async evidenceOf(card: CardRecord, s: CardState, o: WorkflowOptions, builder?: string): Promise<Evidence> {
    const primed = await this.platform(o).prime(card, s, o, builder)
    const content = await this.platform(o).content(card, s, o, primed)
    return { primed, value: this.evidenceNow(card, s, o, primed), content }
  }

  /**
   * How many passes deep each intent is in being gathered again (`regather`), its own call chain's (gatherDepth.ts): at
   * most once, so a fingerprint moving again refuses, except a start on a platform allowing more (`startGathers`, HI-2916).
   */
  private readonly gathering = new GatherDepth()

  /**
   * Just before an intent's transaction (#1206): whether to gather it again from the top. Only when the fingerprint
   * moved since it was taken while the platform's answer by content, asked again outside the transaction, is the same
   * (with the fingerprint steady across the asking and the cards waited for unchanged): what moved is likely cached
   * stat data only (an outside `git status`, a file touched). Even then, what the intent read in between (its guards'
   * inputs: dirty files, the revision) may have seen another state and back, so it is never reused with a new
   * fingerprint: the intent starts again, reading everything afresh, once (`regather`). A real change refuses at once,
   * as does a fingerprint moving again in the second pass. Git, the files and SQLite can't be one transaction:
   * reconciliation settles what comes after the transaction's read. `passes`: how many passes deep it may go (a start's
   * platform may allow more than one, `startGathers`).
   */
  private async revalidate(card: CardRecord, s: CardState, o: WorkflowOptions, before: Evidence, passes = 1): Promise<boolean> {
    if (this.gathering.depth(card.id) >= passes) return false
    // A start allowed several passes (HI-2972): `startAgain`'s answer, a steady fingerprint going on to the write.
    if (passes > 1) {
      const again = await this.startAgain(card, s, o, before)
      if (again === 'moved' || again === 'unreadable') this.startPassLog(card, 'before write', again, passes) // i18n-ignore: a log line's code, never shown
      return again === 'moved' || again === 'unreadable'
    }
    const a = before.value === null ? null : this.evidenceNow(card, s, o, before.primed)
    return a !== null && a !== before.value && (await this.sameContent(card, s, o, before))
  }

  /**
   * Whether a start on a platform allowing several passes (`startGathers`) is gathered again (HI-2972), asked with passes
   * left: `moved`, its fingerprint moved and its answer by content is the gathered one; `unreadable`, its fingerprint
   * couldn't be read when it was gathered or can't be now (jj's operation heads while any jj operation lands, Combwork's
   * own included: the new head is written before the old one goes); `steady`, the fingerprint is the gathered one;
   * null, a real change (the cards waited for, or the content). Another pass reads everything afresh, and the write
   * still needs exactly the fingerprint it gathered, so nothing unreadable or changed is ever written on: unlike
   * `sameContent`, this asks no steadiness across its own read, since its answer only decides to read again.
   */
  private async startAgain(card: CardRecord, s: CardState, o: WorkflowOptions, before: Evidence): Promise<'moved' | 'unreadable' | 'steady' | null> {
    if (before.value === null || before.content === null) return 'unreadable'
    const a = this.evidenceNow(card, s, o, before.primed)
    if (a === null) return 'unreadable'
    if (a === before.value) return 'steady'
    if (this.depsOf(a) !== this.depsOf(before.value)) return null
    const content = await this.platform(o).content(card, s, o, before.primed)
    if (content === null) return 'unreadable'
    return content === before.content ? 'moved' : null
  }

  /** A start gathered again (HI-2972): where, why, and the pass the next one is, in the log. */
  private startPassLog(card: CardRecord, at: string, why: string, passes: number): void {
    log.info(`#${card.id}'s start gathered again (${at}: fingerprint ${why}), pass ${this.gathering.depth(card.id) + 2} of ${passes}`)
  }

  /** A start refused as `evidence.changed` (HI-2972): which check, on which pass, in the log (` not started: `, as the platform's). */
  private startRefusedLog(card: CardRecord, check: string, passes: number, why?: string): void {
    log.info(`#${card.id} not started: evidence.changed at ${check}, pass ${this.gathering.depth(card.id) + 1} of ${passes}${why ? ` (${why})` : ''}`)
  }

  /** Why a start whose fingerprint moved at its write wasn't gathered again (HI-2972's log): its passes, or a real change. */
  private noPassWhy(card: CardRecord, passes: number): string {
    return passes <= 1 ? 'one pass' : this.gathering.depth(card.id) >= passes ? 'passes spent' : 'a change by content' // i18n-ignore: a log line's codes, never shown
  }

  /**
   * Whether the platform's answer by content is still the one the intent gathered on, the cards waited for unchanged and
   * the fingerprint steady across the asking (`revalidate`'s test, whether or not the fingerprint moved).
   */
  private async sameContent(card: CardRecord, s: CardState, o: WorkflowOptions, before: Evidence): Promise<boolean> {
    if (before.value === null || before.content === null) return false
    const a = this.evidenceNow(card, s, o, before.primed)
    if (a === null || this.depsOf(a) !== this.depsOf(before.value)) return false
    const content = await this.platform(o).content(card, s, o, before.primed)
    return content !== null && content === before.content && this.evidenceNow(card, s, o, before.primed) === a
  }

  /** Runs an intent again from the top, one pass deeper in its own call chain (`revalidate`). */
  private regather<T>(card: CardRecord, run: () => Promise<T>): Promise<T> {
    return this.gathering.again(card.id, run)
  }

  /** The part of a fingerprint that is the cards waited for (`evidenceNow`). */
  private depsOf(value: string): string {
    const i = value.indexOf('#')
    return i < 0 ? '' : value.slice(i)
  }

  private evidenceNow(card: CardRecord, s: CardState, o: WorkflowOptions, primed: unknown): string | null {
    const platform = this.platform(o).evidence(card, s, o, primed)
    return platform === null ? null : [platform, ...card.blockedBy.map((id) => `${id}:${this.state(id).lastSeq}`)].join('#')
  }

  /** Refused when the evidence changed since it was taken, or can't be read now or then (unknown never satisfies). */
  private evidenceChanged(w: Write, o: WorkflowOptions, before: Evidence, card: CardRecord = w.card): GuardRefusal | null {
    const now = this.evidenceNow(card, w.state(), o, before.primed)
    return before.value !== null && now === before.value ? null : { rule: 'evidence.changed', values: { card: w.card.key } }
  }

  /** Is a card Done by facts: integrated, or accepted (§16.5.3 `start.dependenciesIntegrated`), not just Approved. */
  doneByFacts(id: number): boolean {
    const s = this.state(id)
    return s.stage === 'done' && (!!s.integrated || !!s.accepted)
  }

  /**
   * HI-2709: the cards a card in the merge queue waits for, by key: those it is blocked by that aren't Done. Read in a
   * write (`tx`, the advance's `IntegrationStarted` one), they are that write's: its blocked-by list and each blocker's
   * stage as they are then, never a record read before. A blocker that can't be read counts as waited for (by its number):
   * a card is never merged on doubt.
   */
  queueWaitingOn(id: number, tx?: Tx): string[] {
    const read = (n: number): CardRecord | null => {
      try {
        return tx ? tx.card(n) : this.store.card(n)
      } catch {
        return null
      }
    }
    const card = read(id)
    if (!card) return []
    const out: string[] = []
    for (const b of card.blockedBy) {
      const dep = read(b)
      if (!dep) out.push(`#${b}`)
      else if (dep.stage !== 'done') out.push(dep.key)
    }
    return out
  }

  /**
   * HI-2709: the one rule every route that closes a card as merged keeps, in its own write (`w.tx`, so a dependency added
   * while its reads ran counts): not while a card it depends on isn't Done. An agent's merge report is refused so;
   * reconciliation writes nothing (reconcile.ts integratedOutside); the queue's advance decided it in IntegrationStarted's
   * write. With the rules not enforced, nothing is refused.
   */
  blockersNotDone(w: Write): GuardRefusal | null {
    if (!this.enforced()) return null
    const waits = this.closeWaitsFor(w)
    return waits.length ? ({ rule: 'merge.waitsForBlockers', values: { card: w.card.key, waitsFor: waits.join(', ') } } as GuardRefusal) : null
  }

  /**
   * HI-2709: the choke point of every write that records a card as merged (`Integrated`): what it still waits for, read
   * in that write (empty: it may close). The queue's integrated(), reconciliation's integratedOutside and an agent's merge
   * report all ask it. `afterAdvance`: the queue's own record of an advance it made, which only records what the target
   * now has; its authority was IntegrationStarted's write, which asked this then.
   */
  closeWaitsFor(w: Write, opts: { afterAdvance?: boolean } = {}): string[] {
    return opts.afterAdvance ? [] : this.queueWaitingOn(w.card.id, w.tx)
  }

  /**
   * HI-2709: a card into Done, in its write: each card it blocks that waits in a merge queue gets that queue run again
   * (`enqueue`, its entry's target), so a queue that went idle with only waiting entries takes it, with no new approval.
   */
  private kickDependents(w: Write): void {
    for (const dep of this.store.dependents(w.card.id)) {
      const e = openEntry(foldCard(w.tx.facts(dep), w.tx.card(dep).stage))
      if (e) w.tx.action(dep, 'enqueue', { target: e.target }, null)
    }
  }

  /**
   * A lane's card is finished once it is Done, however it got there (Not checked finishes with no `Integrated`): the
   * lane goes on. Dependencies need more (`waitingFor`).
   */
  laneDone(id: number): boolean {
    return this.state(id).stage === 'done'
  }

  /**
   * HI-2944: a lane starting for `target` (a start's own warning is gatherStart's): its folder's uncommitted changes told to
   * the window, and the warning for the caller's reply; null when there are none (or no such folder, or no platform read).
   */
  async targetChangesWarning(target: string): Promise<string | null> {
    const o = this.cfg.options()
    const tc = await this.platform(o).targetChanges?.(target).catch(() => null)
    // HI-2984: as a card's start says it (targetChangesApply): the lane's cards are built in the project folder, or slots.
    if (!tc || !targetChangesApply(o, tc.folder, o.folder === 'project' ? this.cfg.project : null)) return null
    this.cfg.targetChanges?.(tc, '')
    return say(W.targetChanges, { target: tc.target, folder: tc.folder, files: filesNamed(tc.files) })
  }

  /**
   * The cards a card waits for that aren't Done by facts **in its target** (§16.7.4): accepted, or with their change in
   * that target now, by containment of their stored endpoints (merged into a release branch and then into main counts;
   * a target reset since doesn't). A Done card with no `Integrated` (Not checked, an override) counts once its change is
   * found there: verified, never assumed.
   */
  async waitingFor(card: CardRecord, target: string | null, o: WorkflowOptions): Promise<Maybe<string[]>> {
    const out: string[] = []
    for (const id of card.blockedBy) {
      const dep = this.store.card(id)
      // From its cached stage (#1265): a card from before 1.0 has no facts, only where it is.
      const d = foldCard(this.store.facts(id), dep.stage)
      const key = dep.key
      if (d.stage !== 'done') {
        out.push(key)
        continue
      }
      // Done before 1.0, or never started under the rules (moved to Done by hand): nothing to look for in the target. An
      // override's Done counts as accepted (HI-2014, Darren's option A): its dependents start without its work in the target.
      if (d.accepted || dep.preWorkflow || !d.started || finishAccepts(d.finished)) continue
      const revision = d.integrated?.revision ?? d.approved?.revision ?? d.latest?.revision
      const base = d.approved?.base ?? d.latest?.base ?? d.started?.base
      if (!revision || !base || !target || revision === base) {
        out.push(key)
        continue
      }
      const c = asCardCounts(d, await this.platform(o).contains(target, { base, revision, key: d.latest?.key }))
      if (isUnknown(c)) return c
      if (!c) out.push(key)
    }
    return out
  }

  /**
   * HI-2245: the commits past its submission on a card in Review, for its builder (`agent`, its id) only: its platform's
   * answer, kept only while the card is still that cycle's, in Review, on the same submission, builder and folder.
   */
  async unsubmitted(card: CardRecord, agent: string): Promise<Unsubmitted | null> {
    const s = this.state(card)
    const submitted = s.latest?.revision
    const same = (x: CardState): boolean => x.stage === 'review' && x.cycle === s.cycle && x.latest?.id === s.latest?.id && x.latest?.revision === submitted && x.started?.builder === agent && x.started?.folder === s.started?.folder && x.started?.line === s.started?.line
    if (card.kind !== 'code' || !submitted || !same(s)) return null
    const p = this.platformOf(card, s)
    if (!p.unsubmitted) return null
    const r = await p.unsubmitted(card, s, submitted, () => this.cfg.hooks?.unsubmittedRead?.()).catch(() => null)
    return r && same(this.state(this.store.card(card.id))) ? r : null
  }

  /** The card's revision now (its platform's answer). */
  revisionNow(card: CardRecord, s: CardState): Promise<Maybe<string | null>> {
    return this.platformOf(card, s).revisionNow(card, s)
  }

  /** What a finish needs from the platform (gathered before the transaction). */
  finishInputs(card: CardRecord, s: CardState, r: Ruleset, revision: string | null | undefined): Promise<FinishInputs> {
    return this.platform(r.options).finishInputs(card, s, r.options, revision)
  }

  /**
   * Asks the user (For you, §16.8.5): `ApprovalRequested` and a notification. `asker`: the agent whose own question it
   * is; `unbound`: a question no new submission retires (the round limit's, answered only by the user); `revision` and
   * `checklist`: an agent's ask about a revision of its choice, with a Test checklist (#1267).
   */
  askUser(w: Write, kind: ForYouKind, gate: string, text: string | StoredText, o: { asker?: string | null; unbound?: boolean; revision?: string; checklist?: string[]; entry?: string; result?: string; actions?: AskAction[]; tests?: string[] } = {}): string {
    const s = w.state()
    // Combwork's own requests are messages (FOR_YOU): the English for agents and the Agent API, the message for the window.
    // agent-stored: storedForAgents says a request again for each reader (its forYou rows, a lane wake's detail; HI-2464)
    const english = typeof text === 'string' ? text : workflowEnglish(text)
    const shown = typeof text === 'string' ? {} : { requestText: text }
    const request = `${w.card.key}/r${s.lastSeq + 1}`
    // Bound to what the user is shown: the submission and revision, the stage and the decision generation it is asked at.
    w.fact('ApprovalRequested', { request, kind, gate, text: english, ...shown, for: 'user', ...(o.asker ? { asker: o.asker } : {}), stage: w.current, generation: s.generation, ...(s.latest && !o.unbound ? { submission: s.latest.id, revision: s.approved?.revision ?? s.latest.revision } : {}), ...(o.revision ? { revision: o.revision } : {}), ...(o.checklist ? { checklist: o.checklist } : {}), ...(o.entry ? { entry: o.entry } : {}), ...(o.result ? { result: o.result } : {}), ...(o.actions?.length ? { actions: o.actions } : {}), ...(o.tests ? { tests: o.tests } : {}) })
    w.action('notify', { text: english, ...(typeof text === 'string' ? {} : { shown: text }) })
    return request
  }

  /**
   * Asks the user again for a gate still unmet where the card now is (its request was retired by a trip to On Hold):
   * the review under "You" (or "…, then you" once the reviewers passed it) in Review, the OK before merging in Approved.
   */
  reask(w: Write): void {
    const r = w.ruleset
    const s = w.state()
    if (!r || !s.latest || s.stale || s.requests.some((x) => x.gate === 'review' || x.gate === 'okBefore')) return
    const o = r.options
    const userReviews = w.current === 'review' || (w.current === 'approved' && o.finish === 'accept')
    if (userReviews && reviewByYou(o.review) && !approvedByUser(s, 'review') && (o.review === 'you' || passingReviewers(s).length >= o.reviewers)) {
      this.askUser(w, 'approve', 'review', workflowText(FOR_YOU.review, { card: w.card.key }))
    } else if (w.current === 'approved' && this.enforced() && okBeforeApplies(r, w.card.labels) && !approvedByUser(s, 'okBefore') && notApproved(s, r, w.card.labels)?.missing === 'userOk') {
      this.askUser(w, 'approve', 'okBefore', workflowText(FOR_YOU.okBefore, { card: w.card.key }))
    }
  }

  /**
   * At the round limit (§16.11.4): Combwork asks the user (Decide: carry on, split, accept with follow-ups, take it over), and
   * the card's lane pauses until they answer. Only for a card in a running lane (its rounds: the Card loops settings it
   * started with) and while the rules are enforced (Settings → Advanced).
   */
  askAtLimit(w: Write): void {
    const s = w.state()
    if (!this.enforced() || !atRoundLimit(s, w.card.rounds)) return
    // Not bound to the submission: a new one can't retire it, only the user's answer (HR3's #1269 round 1 finding 1).
    this.askUser(w, 'decide', ROUND_LIMIT_GATE, workflowText(FOR_YOU.roundLimit, { card: w.card.key, rounds: s.rounds }), { unbound: true })
  }

  /**
   * Refuses an agent's or the Assistant's submission or forward move while the card waits for the user at its round
   * limit (§16.11.4): only the user's answer resumes its loop. The user's own moves go on.
   */
  private atLimit(card: CardRecord, s: CardState, actor: Actor): GuardRefusal | null {
    if (actor === 'user' || !this.enforced() || !s.requests.some((r) => r.gate === ROUND_LIMIT_GATE)) return null
    return { rule: 'loop.roundLimit', values: { card: card.key } } as GuardRefusal
  }

  /**
   * Wakes an agent: a durable action delivered once (§16.4.5). `about: 'answer'`: the user's answer, which reaches the
   * agent whether or not the card has a reviewer (loopWakes.ts); `'review'`: an arrival in Review whose wake says `why`.
   */
  wake(w: Write, agent: string | null | undefined, why: string, about?: 'answer' | 'review'): void {
    if (!agent || agent === 'user') return
    // In the user's answer's write (finish's wakes too): an answer's wake, the answer first (HR3's #1269 round 2).
    const answer = about ?? (w.answer !== null ? 'answer' : undefined)
    const said = w.answer !== null && !why.startsWith(w.answer) ? `${w.answer}. ${why}` : why
    w.action('wake', { agent, why: said, ...(answer ? { about: answer } : {}) })
    w.woken.push(agent)
  }

  /** The reviewer to wake: the card's (a lane's), else the pool. */
  reviewerOf(card: CardRecord): string {
    return card.reviewer ?? 'reviewers'
  }

  /**
   * Starts a forward merge (HI-2679) on its card, made for it a moment ago: `Started` with no line (the source is never
   * the card's branch), then its authority (`ForwardRequested`), then straight to Merging with its first entry, the
   * source frozen at `d.source`. Under its own rules (`forwardOf`), recorded with these facts. Only from the forward
   * request (queueControls' `forwardMerge`), as the user or the Assistant: refused for a card started before.
   */
  async forwardStart(ref: unknown, d: { from: string; to: string; source: string; base: string; override?: ForwardOverride; defaultBranch?: string }, by: 'user' | 'assistant', ruleset: Ruleset, guard?: () => void): Promise<Reply> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const out = await this.write(card, ruleset, by, (w) => {
      guard?.()
      const now = w.state()
      if (now.started || now.stage !== 'todo') return { rule: 'move.notFromHere', values: { card: card.key, stage: now.stage, move: 'start', moves: '' } } as GuardRefusal // i18n-ignore: intent names
      w.fact('Started', { folder: 'project', line: null, base: d.base, target: d.to, builder: 'combwork', cardKind: 'code' }) // i18n-ignore: a fact's kind and codes, not text
      w.fact('ForwardRequested', { from: d.from, to: d.to, source: d.source, by, ...(d.override ? { override: d.override } : {}), ...(d.defaultBranch ? { defaultBranch: d.defaultBranch } : {}) }) // i18n-ignore: a fact's kind and codes, not text
      w.move('active', 'intent')
      this.enqueueForward(w, d.source)
      return null
    })
    if (out) return this.refuse(card, by, 'start', out)
    return this.ok(card, s.stage, this.state(card).stage)
  }

  /** A forward merge's entry (HI-2679): its source's frozen commit, into its destination, as a merge commit. */
  private enqueueForward(w: Write, source: string, requeue?: 'retry'): void {
    const s = w.state()
    const target = s.started?.target ?? ''
    w.fact('IntegrationRequested', { entry: `${w.card.key}/e${s.lastSeq + 1}`, revision: source, key: null, target, style: 'merge', ...(requeue ? { requeue } : {}) })
    w.move('merging', 'derived')
    w.action('enqueue', { target })
  }

  /** Puts a card in the merge queue: a new entry (`IntegrationRequested`). */
  enqueue(w: Write, requeue?: 'transient' | 'retry'): void {
    const s = w.state()
    const target = s.started?.target ?? ''
    w.fact('IntegrationRequested', { entry: `${w.card.key}/e${s.lastSeq + 1}`, revision: s.approved?.revision ?? s.latest?.revision ?? '', key: s.latest?.key ?? null, target, style: w.ruleset!.options.style, ...(requeue ? { requeue } : {}) })
    w.move('merging', 'derived')
    w.action('enqueue', { target })
  }

  /** Finish (§16.7.2): after review, or straight after submit with no review. */
  finish(w: Write, fin: FinishInputs): void {
    const r = w.ruleset!
    const o = r.options
    const s = w.state()
    if (w.card.kind === 'no-code') {
      w.fact('Accepted', { submission: s.latest!.id }) // i18n-ignore: a fact's kind and codes, not text
      w.move('done', 'derived')
      return
    }
    if (o.finish === 'accept') {
      // Accepted only if the card's work still has the approved revision (None: its paths still hash to it, §16.3.3).
      const approved = s.approved?.revision ?? null
      if (!isUnknown(fin.currentRevision) && fin.currentRevision === approved) {
        w.fact('Accepted', { revision: approved! }) // i18n-ignore: a fact's kind and codes, not text
        w.move('done', 'derived')
      } else {
        w.fact('Stale', { approved, current: isUnknown(fin.currentRevision) ? null : (fin.currentRevision ?? null), why: 'change' }) // i18n-ignore: a fact's kind and codes, not text
        w.move(hasStage(r, 'review') ? 'review' : 'active', 'derived')
        this.wake(w, s.started?.builder, stored(W.staleChange))
      }
      return
    }
    // G10 asks only while the rules are enforced (Settings → Advanced): off, the card goes on as if it were never set.
    const needOk = this.enforced() && okBeforeApplies(r, w.card.labels) && !approvedByUser(s, 'okBefore')
    switch (o.finish) {
      case 'combworkMerges':
        if (needOk) {
          w.move('approved', 'derived')
          this.askUser(w, 'approve', 'okBefore', workflowText(FOR_YOU.okBefore, { card: w.card.key }))
        } else this.enqueue(w)
        return
      case 'agentMerges':
        // With no review and no OK before merging there is no Approved (§16.5.2): it waits for the merge in Active.
        if (hasStage(r, 'approved')) w.move('approved', 'derived')
        if (needOk) this.askUser(w, 'approve', 'okBefore', workflowText(FOR_YOU.okBefore, { card: w.card.key }))
        else this.wake(w, s.started?.builder, stored(W.approvedMerge))
        return
      case 'committed':
        // Its revision is on the folder's line by construction: done.contained.
        if (fin.contained === true) {
          w.fact('Integrated', { revision: s.approved!.revision!, target: s.started!.target ?? '', result: s.approved!.revision!, method: 'committed', by: 'combwork' }) // i18n-ignore: a fact's kind and codes, not text
          w.move('done', 'derived')
        }
        return
      case 'notChecked':
        // G10 applies here too (decided on #1592): the OK is asked in Approved, and the report of the merge waits for it.
        if (o.review !== 'none' || needOk) {
          w.move('approved', 'derived')
          if (needOk) this.askUser(w, 'approve', 'okBefore', workflowText(FOR_YOU.okBefore, { card: w.card.key }))
        } else {
          w.move('done', 'derived')
        }
        return
      case 'userIntegrates':
        // jj (HI-2868, option A): the user integrates what passed. It waits in Approved, its OK asked there first where G10
        // applies, until reconciliation finds it in its target (J9b2); Combwork never merges or moves anything for it.
        if (hasStage(r, 'approved')) w.move('approved', 'derived')
        if (needOk) this.askUser(w, 'approve', 'okBefore', workflowText(FOR_YOU.okBefore, { card: w.card.key }))
        return
      default:
        return
    }
  }

  /**
   * submit (§16.8.1): the card's revision with its endpoints, keys and files → Review, or Finish without review, or
   * back into the merge queue after a transient failure (`requeue.allowed`). `followUp` (HI-1832): from Review, its
   * builder's commit the reviewer asked for, made the revision under review: no round, no move, no one reassigned.
   */
  async submit(ref: unknown, actor: Actor, args: { summary: string; revision?: string; note?: string; paths?: string[]; drag?: Drag; followUp?: boolean; tests?: FocusedTest[] }): Promise<Reply> {
    const card0 = this.resolve(ref, actor)
    if (isRefusal(card0)) return card0
    return this.submitAs(ref, actor, args, this.submitOperation(card0.id))
  }

  /**
   * A submission's operation (G20, HI-1367; HR4's rounds 1–3, finding 8), settled once: made by each `submit` call and
   * only there, which ends the card's operation before it (a newer submission supersedes the one in flight), and ended
   * too by its workspace closing. Every retry of that call (a re-gather after the evidence changed, a requeue's) carries
   * the same operation and never makes one, so a superseded call can never end its replacement. It is checked wherever
   * the call resumes after waiting: after gathering, after the evidence is checked again (before any re-gather), and
   * under the write's lock; ended, the call is refused there (`submit.focusedChosen`, `cancelled`). Its pick ends with it.
   */
  private submitOperation(card: number): AbortSignal {
    this.picks.get(card)?.abort()
    const own = new AbortController()
    this.picks.set(card, own)
    const life = this.cfg.focused?.life
    return life ? AbortSignal.any([own.signal, life]) : own.signal
  }

  /** `submit` within its operation (`op`): every retry of the call is this, with the same `op`. */
  private async submitAs(ref: unknown, actor: Actor, args: { summary: string; revision?: string; note?: string; paths?: string[]; drag?: Drag; followUp?: boolean; tests?: FocusedTest[] }, op: AbortSignal): Promise<Reply> {
    const card0 = this.resolve(ref, actor)
    if (isRefusal(card0)) return card0
    let card = card0
    let s = this.state(card)
    if (!s.started) return this.notFrom(card, actor, s, 'submit')
    const limit = this.atLimit(card, s, actor)
    if (limit) return this.refuse(card, actor, 'submit', limit)
    const r = this.rulesetOf(card, s)
    const o = r.options
    const agent = agentOf(actor)
    const from = s.stage

    // After a queue failure: the same approved, unstale revision goes straight back into the queue (no review, no round).
    const last = s.entries.at(-1)
    // (A decision's cancel isn't a queue failure: the builder resubmits as usual, with a note for the same revision.)
    // Only while that failure is the newest thing on the card (HI-2504): once a submission came after it (the builder's
    // fix of a conflict, reviewed and failed, say), the failure was answered, and its revision is resubmitted as usual.
    const returnedSince = !!last && last.seq > (s.latest?.id ?? 0)
    if (from === 'active' && o.finish === 'combworkMerges' && card.kind === 'code' && last && returnedSince && (last.state === 'failed' || (last.state === 'cancelled' && last.cancelled !== 'decision')) && !s.stale) {
      // The same evidence protocol as an ordinary submit: taken before the revision is read, checked at the write.
      const evidence = await this.evidenceOf(card, s, o)
      const now = await this.revisionNow(card, s)
      if (!isUnknown(now) && now && now === s.approved?.revision) {
        await this.cfg.hooks?.beforeWrite?.('submit')
        if (await this.revalidate(card, s, o, evidence)) return this.regather(card, () => this.submitAs(ref, actor, args, op))
        const g = await this.write(card, r, actor, (w) => {
          const bad = this.stillAt(w, s, 'submit') ?? this.evidenceChanged(w, o, evidence) ?? this.check(w, 'requeue', { agent, revision: now })
          if (bad) return bad
          this.enqueue(w, 'transient')
          return null
        })
        return g ? this.refuse(card, actor, 'submit', g) : this.ok(card, from, 'merging', { requeued: true })
      }
    }
    if (!(from === 'active' || ((from === 'approved' || from === 'review') && s.stale) || from === 'review')) return this.notFrom(card, actor, s, 'submit')

    const g = await this.gatherSubmit(card, s, actor, args, undefined, false, op)
    // Nothing changed in its paths (None): what they leave out goes with the refusal (HI-2339), the likely why.
    if (!('inputs' in g)) return this.withNotices(await this.refuse(card, actor, 'submit', g), g.rule === 'submit.unchanged' ? await this.pathNotices({ ...card, paths: args.paths ?? card.paths ?? this.prefill(card) }, o, !!args.paths, op) : [])
    const ended: GuardRefusal = { rule: 'submit.focusedChosen', values: { card: card.key, revision: (g.revision ?? '').slice(0, 7), state: 'unknown', why: 'cancelled' } } // i18n-ignore: codes
    // Its operation ended while it gathered (G20: only where it picked): refused before anything.
    if (g.focusedOp?.aborted) return this.refuse(card, actor, 'submit', ended)
    // The same revision again: a new submission only with a note (§16.8.1).
    const waiting = (from === 'review' || from === 'approved' || awaitsAgentMerge(g.r, g.s)) && !g.s.stale
    if (g.earlier && !waiting && !args.note && !args.drag) return this.withNotices(await this.refuse(card, actor, 'submit', { rule: 'submit.sameRevisionNote', values: { revision: g.revision!.slice(0, 7) } }), await this.pathNotices(g.card, g.o, !!args.paths, op))

    await this.cfg.hooks?.beforeWrite?.('submit')
    const again = await this.revalidate(g.card, g.s, g.o, g.before)
    // Ended while it waited or checked the evidence again (HR4's round 3): refused, never gathered again.
    if (g.focusedOp?.aborted) return this.refuse(card, actor, 'submit', ended)
    if (again) return this.regather(card, () => this.submitAs(ref, actor, args, op))
    let ahead: CardRecord[] | null = null
    // A follow-up (HI-1832): only from Review, unstale, and never a drag (the user's moves); elsewhere an ordinary submission.
    const followUp = !!args.followUp && !args.drag && from === 'review' && !g.s.stale
    const out = await this.write(card, g.r, actor, (w) => {
      const changed = this.stillAt(w, g.s, 'submit') ?? this.evidenceChanged(w, g.o, g.before, g.card)
      if (changed) return changed
      // Ended (HR4's round 2 finding 1): a newer submission of the card, or its workspace closing, read under the lock.
      if (g.focusedOp?.aborted) return ended
      // Every refusal before anything is written: an override never commits without its move.
      if (from === 'review' && !g.s.stale && !followUp) return { rule: 'move.notFromHere', values: { card: card.key, stage: from, move: 'submit', moves: this.movesFrom(from, g.r).join(', ') } } as GuardRefusal
      // Read again under the transaction: still in Review, unstale, and the agent its builder now (not when the call began).
      // Its builder is the agent the board gives it to now (a card given to another in Review keeps its Started: HR4's
      // HI-1832 round 1); given to nobody, its cycle's builder. The user and the Assistant may either way.
      if (followUp) {
        const now = w.state()
        if (w.current !== 'review' || now.stale) return { rule: 'move.notFromHere', values: { card: card.key, stage: w.current, move: 'submit', moves: this.movesFrom(w.current, g.r, now).join(', ') } } as GuardRefusal
        const owner = this.store.cardAgent(card.id) ?? now.started?.builder ?? null
        if (agent && agent !== owner) return { rule: 'submit.followUpNotBuilder', values: { card: card.key } } as GuardRefusal
      }
      const ins = this.submitInputs(g)
      const bad = args.drag ? this.across(w, 'submit', 'review', ins, args.drag, g.only) : (this.check(w, 'submit', ins, g.only) ?? this.agentHasSeen(w, ins, g.only))
      if (bad) return bad
      // Ahead of earlier cards of its lane nobody has started (#1410): it goes before them, so its reviewer takes it next.
      ahead = this.enforced() && !args.drag && !followUp && g.o.review !== 'none' ? this.laneReorder(w, card) : null
      this.applySubmit(w, g, { ...args, followUp }, w.written.some((f) => f.kind === 'Override') ? 'override' : 'intent', ahead)
      return null
    })
    if (out) return this.refuse(card, actor, 'submit', out)
    const reordered = ahead as CardRecord[] | null
    return this.ok(card, from, this.state(card).stage, { revision: g.revision, base: g.base, files: g.files.length, ...(followUp ? { followUp: true } : {}), ...(reordered ? { lane: say(W.movedAhead, { cards: reordered.map((c) => c.key).join(', ') }) } : {}) }, g.warnings)
  }

  /**
   * A lane's card submitted ahead of earlier cards of its lane that haven't started (#1410: the user's own drag started
   * it, or it was started before the lane listed it): it moves before them in the lane's list, in the submission's
   * write, so its reviewer reviews it next instead of waiting for a card nobody works on, and `LaneChanged` records it.
   * Returns the cards it went before; null when there are none, when an earlier card is in flight unreviewed (Active or
   * in Review: the lane waits on that one as it is), or while a list change is queued (applied at the card boundary, it
   * would undo this).
   */
  private laneReorder(w: Write, card: CardRecord): CardRecord[] | null {
    const now = this.store.card(card.id)
    const l = now.lane ? this.lane(now.lane) : null
    if (!l || l.ended || l.pending?.length) return null
    const at = l.cards.indexOf(card.id)
    const open = l.cards.slice(0, Math.max(at, 0)).filter((c) => !this.laneDone(c) && this.laneOwn(l.id, c)).map((c) => this.store.card(c))
    if (!open.some((c) => c.stage === 'todo') || open.some((c) => c.stage === 'active' || c.stage === 'review')) return null
    const ahead = open.filter((c) => c.stage === 'todo')
    const first = l.cards.indexOf(ahead[0].id)
    const cards = [...l.cards.slice(0, first), card.id, ...l.cards.slice(first).filter((c) => c !== card.id)]
    this.saveLane({ ...l, cards })
    w.fact('LaneChanged', { lane: l.id, before: [...l.cards], after: cards }) // i18n-ignore: a fact's kind and codes, not text
    return ahead
  }

  /**
   * A submission's slow part, outside the lock (it writes nothing): the card's revision with its fixed endpoints, key and
   * files, and its guards' inputs. None's paths it sets are kept with it (`setPaths`), written by its write. `r`: the
   * ruleset, for a state predicted after a start (a drag's) whose ruleset isn't stored yet.
   */
  private async gatherSubmit(card0: CardRecord, s0: CardState, actor: Actor, args: { revision?: string; paths?: string[]; tests?: FocusedTest[] }, r: Ruleset = this.rulesetOf(card0, s0), predicted = false, op?: AbortSignal): Promise<SubmitGathered | GuardRefusal> {
    let card = card0
    let s = s0
    const o = r.options
    const agent = agentOf(actor)
    const from = s.stage
    let revision: string | null = null
    let base: string | null = null
    let key: string | null = null
    let files: FactData['Submitted']['files'] = []
    let commits: string[] | undefined
    let paths: string[] | undefined
    let platform: Record<string, unknown> | undefined
    const inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'> = { agent, folder: this.folderOf(s) }
    const warnings: string[] = []
    // A lock taken before the submission is in the cards' records before it reads them (G16, submit.clean: #1481).
    await this.cfg.locksSettled?.()
    // A check run that finished before the submission is in the card's facts before it reads them (submit.checksPassed: #1651).
    await this.cfg.checksSettled?.()
    // The card's declared paths (None) are its data: what the evidence and the revision are read with (args, else the
    // pre-fill), written with the submission.
    const setPaths = args.paths ?? (card.kind === 'code' && declaresPaths(o.platform) && !card.paths ? this.prefill(card) : null)
    // Submit's paths as declare paths' (#1511): none under `.combwork`, `.git` or an excluded folder.
    const bad = args.paths && declaresPaths(o.platform) ? this.excludedPath(args.paths) : null
    if (bad) return { rule: 'paths.excluded', values: { card: card.key, ...bad } }
    if (setPaths) card = { ...card, paths: setPaths }
    const before = await this.evidenceOf(card, s, o)
    if (card.kind === 'code') {
      const plan = await this.platform(o).submission(card, s, o, { revision: args.revision, agent, guards: r.guards.submit, predicted })
      if (!plan.ok) return plan.refusal
      ;({ revision, base, key, files, commits, paths, platform } = plan)
      Object.assign(inputs, plan.inputs)
      warnings.push(...plan.warnings, ...(await this.pathNotices(card, o, !!args.paths, op)))
      // The adapter may have reconciled (a shared folder's attribution): the card and its state as they are now.
      if (!predicted) {
        card = { ...this.store.card(card.id), ...(setPaths ? { paths: setPaths } : {}) }
        s = this.state(card)
      }
      // HI-2999: a forward's resolution carries the commit it resolves, merged, never cherry-picked or copied; what can't
      // be read refuses too (Unknown never satisfies a rule), saying what: submitted again once it reads.
      const has = s.resolves ? await this.resolutionHasSource(o, s, revision) : null
      if (isUnknown(has)) return { rule: 'platform.unknown', values: { card: card.key, what: has.whatText ?? has.what, rule: 'forward.resolutionSource' } }
      if (has === false && s.resolves) return { rule: 'forward.resolutionSource', values: { card: card.key, from: s.resolves.from, to: s.resolves.to, source: s.resolves.source, revision: (revision ?? '').slice(0, 7) } }
    }
    inputs.revision = revision
    if (r.guards.submit.includes('submit.checksPassed') && card.kind === 'code') {
      inputs.checksMissing = o.preChecks.filter((name) => !s.checks.some((c) => c.name === name && c.revision === revision && c.result === 'passed' && c.counted))
      // The first missing check's newest run on the revision, if it passed and didn't count: the refusal says why (#1654).
      const last = inputs.checksMissing.length ? s.checks.findLast((c) => c.name === inputs.checksMissing![0] && c.revision === revision) : undefined
      if (last && last.result === 'passed' && !last.counted && last.whyNot) inputs.checkUncounted = { whyNot: last.whyNot, ...(last.changes?.length ? { changes: last.changes } : {}), isolatable: hasCapability(o.platform, 'checkCopies') && !last.isolated }
    }
    // G13: the builder's own running work, whoever submits (an agent itself; the user's or the Assistant's move: the
    // card's builder). Read again in the write (`runsNow`): work started meanwhile counts.
    const runner = agent ?? (s.started?.builder && s.started.builder !== 'user' ? s.started.builder : null)
    if (runner && this.cfg.runsOf) inputs.runsGoing = this.cfg.runsOf(runner)
    // G20 (HI-1367): the tests the change needs, picked in the card's folder at exactly this revision, or named by its
    // builder; kept with the submission (its `focused`), and a pick that couldn't choose refuses without the builder's list.
    let focusedOp: AbortSignal | undefined
    if (r.guards.submit.includes('submit.focusedChosen') && card.kind === 'code' && revision && base && !predicted) {
      // A move of the user's that submits (a drag) has no operation of its own: one for this gathering alone.
      focusedOp = op ?? this.submitOperation(card.id)
      inputs.focused = await this.pickFor(o, this.folderOf(s), revision, base, args.tests, focusedOp)
    }
    const earlier = card.kind === 'code' && s.submissions.some((x) => x.revision === revision)
    const fin = o.review === 'none' ? await this.finishInputs(card, s, r, revision) : {}
    const only = card.kind === 'no-code' ? (id: GuardId) => NO_CODE_GUARDS.includes(id) : undefined
    return { r, o, card, s, from, agent, runner, setPaths, revision, base, key, files, ...(commits ? { commits } : {}), ...(paths ? { paths } : {}), ...(platform ? { platform } : {}), inputs, warnings, earlier, fin, before, ...(only ? { only } : {}), ...(focusedOp ? { focusedOp } : {}) }
  }

  /** Each card's latest submission's operation (`submitOperation`): a newer one aborts the one before (its pick, and its write). */
  private readonly picks = new Map<number, AbortController>()

  /**
   * A submission's focused tests (G20, HI-1367): its change path by path, and the project's picker run on it at exactly
   * the revision (`pickAtRevision`); the builder's `tests` are its additions, or, when the pick couldn't choose, the list
   * that stands in for it (`manual`, reviewed with the change). Never throws; a pick its operation (`signal`) ended is
   * `cancelled`, never manual.
   */
  private async pickFor(o: WorkflowOptions, folder: string, revision: string, base: string, tests: FocusedTest[] | undefined, signal: AbortSignal): Promise<FocusedChoice> {
    const change = await pathChanges(folder, base, revision)
    const command = o.commands[FOCUSED_PICK]?.trim()
    const deps = { env: this.cfg.focused?.env ?? (() => ({})), timeoutMs: this.cfg.focused?.timeoutMs() ?? 60_000, signal }
    let p: PickOutcome
    if (!change) p = { state: 'unknown', tests: [], why: 'noChange' } // i18n-ignore: codes (a why, a check name), never shown as text
    else if (!command) p = { state: 'unknown', tests: [], why: 'noPicker' } // i18n-ignore: codes (a why, a check name), never shown as text
    else p = await (this.cfg.focused?.pick ?? ((c, f, rev, b, ch) => pickAtRevision(deps, c, f, rev, b, ch)))(command, folder, revision, base, change)
    const manual = p.state !== 'chosen' && p.why !== 'cancelled' && !!tests
    return { state: p.state, ...(p.why ? { why: p.why } : {}), source: manual ? 'manual' : 'picked', picked: p.tests, added: tests ?? [], change, ...(p.diagnostics ? { diagnostics: p.diagnostics } : {}) }
  }

  /** A submission's guard inputs in its write: as gathered, its builder's running work read again (HR2's #1265 round 2). */
  private submitInputs(g: SubmitGathered): Omit<GuardInputs, 'card' | 'state' | 'ruleset'> {
    return g.runner && this.cfg.runsOf ? { ...g.inputs, runsGoing: this.cfg.runsOf(g.runner) } : g.inputs
  }

  /** A submission's facts and actions, in its write: `Submitted`, its pin, then Review (its reviewer woken or the user asked) or Finish. */
  private applySubmit(w: Write, g: SubmitGathered, args: { summary: string; note?: string; followUp?: boolean }, cause: FactData['Moved']['cause'], ahead: CardRecord[] | null = null): void {
    if (g.setPaths) this.store.updateCard(g.card.id, { paths: g.setPaths })
    const st = w.state()
    const sub = w.fact('Submitted', { // i18n-ignore: a fact's kind and codes, not text
      revision: g.revision,
      base: g.base,
      head: g.revision,
      key: g.key,
      files: g.files,
      round: st.rounds + 1,
      generation: g.agent ? (st.received[g.agent] ?? 0) : st.generation,
      sameRevision: g.earlier,
      summary: args.summary,
      ...(args.note ? { note: args.note } : {}),
      ...(args.followUp ? { followUp: true } : {}),
      ...(g.paths ? { paths: g.paths } : {}),
      ...(g.commits ? { commits: g.commits } : {}),
      ...(g.platform ? { platform: g.platform } : {}),
      ...(g.warnings.length ? { warnings: g.warnings } : {}),
      ...(g.inputs.focused ? { focused: g.inputs.focused } : {})
    })
    if (g.revision) w.action('pin', { ref: `refs/cw/cards/${g.card.key.toLowerCase()}/${st.submissions.length + 1}`, revision: g.revision, submission: sub.seq, card: g.card.id })
    if (g.o.review === 'none') {
      this.finish(w, g.fin)
      return
    }
    w.move('review', cause)
    w.action('prepareReviewCopy', { revision: g.revision })
    // A lane reviewed by the pool (#1443, G17), or a card no running lane holds (HI-2046: loose): the pool's pass gives
    // the submission to a free reviewer and tells it, so no lane reviewer is woken here. A follow-up keeps the reviewer
    // of the submission before it (HR1's round 1): carried onto this one in this write, so no pass gives it to another,
    // and told once by the pass, as a follow-up.
    if (reviewerAgent(g.o.review) && (g.card.reviewerPool || !g.card.lane)) {
      const kept = args.followUp && st.latest ? submissionReviewers(w.tx.facts(g.card.id), st.latest.id, () => true).reviewing : null
      if (kept && kept !== 'user') w.fact('ReviewerAssigned', { reviewer: kept, submission: sub.seq })
      w.action('assignReviewer', { submission: sub.seq })
    }
    // A follow-up (HI-1832): the card stays in Review, so no arrival wakes its reviewer; told what to do, its words kept.
    else if (reviewerAgent(g.o.review) && args.followUp) this.wake(w, this.reviewerOf(g.card), stored(W.followUp, { card: g.card.key, revision: (g.revision ?? '').slice(0, 7), submission: sub.seq }), 'review')
    else if (reviewerAgent(g.o.review) && ahead) {
      const keys = ahead.map((c) => c.key).join(', ')
      this.wake(w, this.reviewerOf(g.card), stored(W.aheadInLane, { card: g.card.key, cards: keys, next: ahead[0].key }), 'review')
    } else if (reviewerAgent(g.o.review)) this.wake(w, this.reviewerOf(g.card), stored(W.inReview, { card: g.card.key }))
    else this.askUser(w, 'approve', 'review', workflowText(FOR_YOU.review, { card: g.card.key }))
  }

  /** start review: the reviewer takes the latest submission (§16.8.1). */
  async startReview(ref: unknown, actor: Actor, args: { submission?: number } = {}): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    if (s.stage !== 'review') return this.notFrom(card, actor, s, 'start review') // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    const sub = args.submission !== undefined ? s.submissions.find((x) => x.id === args.submission) : s.latest
    if (!sub) return this.refuse(card, actor, 'start review', { rule: 'review.noSubmission', values: { card: card.key } }) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    const r = this.rulesetOf(card, s)
    const present = await this.reviewersPresent(actor)
    const out = await this.write(card, r, actor, (w) => {
      const bad = this.stillAt(w, s, 'start review') ?? this.check(w, 'startReview', { agent: agentOf(actor) }) ?? this.reviewTaken(w, sub.id, agentOf(actor), present) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      if (bad) return bad
      w.fact('ReviewStarted', { reviewer: agentOf(actor) ?? 'user', submission: sub.id, revision: sub.revision })
      return null
    })
    if (out) return this.refuse(card, actor, 'start review', out) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    // A no-code card's submission has no revision: nothing recorded at one.
    const recorded = sub.revision ? checksAtRevision(this.state(card).checks, sub.revision, r.options.commands) : []
    return this.ok(card, 'review', 'review', { submission: sub.id, revision: sub.revision, base: sub.base, files: sub.files, ...focusedForReview(sub.focused), ...(recorded.length ? { checksAtRevision: recorded } : {}) })
  }

  /**
   * The agents that may be reviewing now (cfg.reviewersPresent), read before a write: for an agent's start of a review
   * only (null: not checked). `unknown` when they couldn't be read (HR1's round 1): never taken for gone.
   */
  private async reviewersPresent(actor: Actor): Promise<ReadonlyMap<string, string> | 'unknown' | null> {
    if (!agentOf(actor) || !this.cfg.reviewersPresent || !this.enforced()) return null
    return this.cfg.reviewersPresent().catch(() => 'unknown' as const)
  }

  /**
   * HI-2487: another reviewer's review of the submission in progress refuses an agent's start of it (a stale wake once
   * took HI-2444's from HR2): one that started it, has given no verdict, and is still here (`present`). With G1b = 2, as
   * many may review at once as there are passes still needed. The user's own review in progress holds it too, and the
   * user's start takes any over; with the rules off, nothing refuses. Who is present unread (`unknown`), a review that
   * would hold it refuses as unknown (HR1's round 1: never taken for its reviewer gone).
   */
  private reviewTaken(w: Write, submission: number, agent: string | null, present: ReadonlyMap<string, string> | 'unknown' | null): GuardRefusal | null {
    if (!agent || !present || !this.enforced()) return null
    const needed = Math.max(1, (w.ruleset?.options.reviewers ?? 1) - passingReviewers(w.state()).length)
    const holding = (here: (id: string) => boolean) => reviewsInProgress(w.tx.facts(w.card.id), submission, here).filter((x) => x.reviewer !== agent)
    if (present === 'unknown') return holding(() => true).length < needed ? null : { rule: 'platform.unknown', values: { card: w.card.key, what: workflowText(UNREADABLE.reviewers, { card: w.card.key }), rule: 'review.inProgress' } }
    const others = holding((id) => present.has(id))
    if (others.length < needed) return null
    const first = others[0]
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(first.since)) / 60_000)) || 0
    // The user's review: said by the message's own words (`who`), translated; an agent's by its name.
    const user = first.reviewer === 'user'
    return { rule: 'review.inProgress', values: { card: w.card.key, who: user ? 'user' : 'agent', reviewer: user ? '' : (present.get(first.reviewer) ?? first.reviewer), submission, minutes } }
  }

  /** verdict (§16.7.2): always recorded; a pass may finish, ask the user, or go stale at once if the head moved to another change. */
  async verdict(ref: unknown, actor: Actor, args: { submission?: number; pass: boolean; failKind?: 'content' | 'explanation'; comment: string; startReview?: boolean; accept?: readonly unknown[] }): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    if (s.stage !== 'review') return this.notFrom(card, actor, s, 'verdict')
    const r = this.rulesetOf(card, s)
    const agent = agentOf(actor)
    const subId = args.submission ?? s.latest?.id
    const sub = s.submissions.find((x) => x.id === subId)
    // The head moved since the submission (a card with its own line): same change or not (§16.4.4).
    const before = await this.evidenceOf(card, s, r.options)
    const moved = args.pass && sub?.revision ? await this.platform(r.options).headMoved(card, s, r.options, { base: sub.base, revision: sub.revision, key: sub.key }) : null
    // HI-1763 (the Assistant's design call, 26 Oct): a pass covers only the revision submitted, while it is the card's head
    // or the same change. A line moved on to another change (a follow-up commit, OK'd or not) refuses the pass: the
    // builder submits the new revision, which runs its checks, the user's gates and a review copy as any submission does.
    if (args.pass && moved && !moved.same) return this.refuse(card, actor, 'verdict', { rule: 'review.headMoved', values: { card: card.key, submitted: (sub?.revision ?? '').slice(0, 7), head: moved.to.slice(0, 7) } } as GuardRefusal)
    const fin = args.pass ? await this.finishInputs(card, s, r, moved?.same ? moved.to : sub?.revision) : {}
    // HI-1734: a code card passing with nothing to merge (its change already in its target: HI-1449's checks only, which
    // others' merges had superseded) is proposed no code. Read before the write; unknown is no proposal.
    const merged = args.pass && card.kind === 'code' && sub?.revision && sub.base && s.started?.target && !this.store.facts(card.id).some((f) => f.kind === 'KindProposed' || f.kind === 'KindDecided') ? asCardCounts(s, await this.platform(r.options).contains(s.started.target, { base: sub.base, revision: sub.revision, key: sub.key })) : null
    const nothingToMerge = !!merged && !isUnknown(merged)
    const present = args.startReview ? await this.reviewersPresent(actor) : null
    // HI-2660: what the pass accepts of others' focused-test runs, worked out in the write on the card's facts then.
    let acceptance: ReturnType<typeof acceptedRuns> = { accepted: [], warnings: [] }
    await this.cfg.hooks?.beforeWrite?.('verdict')
    if (await this.revalidate(card, s, r.options, before)) return this.regather(card, () => this.verdict(ref, actor, args))
    const out = await this.writeWhole(card, r, actor, (w) => {
      const changed = this.stillAt(w, s, 'verdict') ?? this.evidenceChanged(w, r.options, before)
      if (changed) return changed
      // `startReview`: its review started in the same write, under start review's guards (an agent's old verdict, #1268:
      // one write, so a refusal or an error later in it leaves nothing of either).
      if (args.startReview && sub) {
        const notYet = this.check(w, 'startReview', { agent }) ?? this.reviewTaken(w, sub.id, agent, present)
        if (notYet) return notYet
        w.fact('ReviewStarted', { reviewer: agent ?? 'user', submission: sub.id, revision: sub.revision })
      }
      const bad = this.check(w, 'verdict', { agent, submission: args.submission })
      // Refused after the review it started: undone whole (writeWhole), the review start too.
      if (bad) return args.startReview ? undo(bad) : bad
      const st = w.state()
      acceptance = args.accept?.length ? (args.pass ? acceptedRuns(st.checks, sub?.revision ?? null, args.accept, r.options.commands) : { accepted: [], warnings: [say(W.acceptOnPass)] }) : { accepted: [], warnings: [] }
      w.fact('Verdict', { reviewer: agent ?? 'user', submission: subId!, revision: sub?.revision ?? null, pass: args.pass, ...(args.failKind ? { failKind: args.failKind } : {}), round: args.pass ? st.rounds : st.rounds + 1, generation: agent ? (st.received[agent] ?? 0) : st.generation, comment: args.comment, ...(acceptance.accepted.length ? { accepted: acceptance.accepted } : {}) }) // i18n-ignore: a fact's kind and codes, not text
      // HI-1734: a code card passing with nothing to merge is proposed no code, as an agent's proposal is (the user
      // confirms; then it finishes with nothing to merge). HI-1449 sat in Approved for two days. Once only: not after a
      // proposal or a decision of its kind (`merged` was only read without either).
      if (nothingToMerge) w.fact('KindProposed', { kind: 'no-code' })
      // A verdict frees its pooled reviewer for the next card, and with G1b = 2 a pass asks for the second (#1443); a loose
      // card's too (HI-2046).
      if (card.reviewerPool || !card.lane) w.action('assignReviewer', { submission: subId! })
      if (!args.pass) {
        w.move('active', 'intent')
        this.wake(w, st.started?.builder, stored(W.failedReview, { card: card.key }))
        this.askAtLimit(w)
        return null
      }
      if (moved && !moved.same) {
        w.fact('Stale', { approved: sub!.revision, current: moved.to, why: r.options.sameness === 'exact' ? 'exact' : 'change' }) // i18n-ignore: a fact's kind and codes, not text
        if (hasStage(r, 'approved')) w.move('approved', 'derived')
        this.wake(w, st.started?.builder, stored(W.staleSubmit))
        return null
      }
      if (moved?.same) w.fact('CarriedOver', { from: sub!.revision!, to: moved.to, toBase: moved.base, how: 'replay' })
      const now = w.state()
      if (passingReviewers(now).length < r.options.reviewers) return null
      if (reviewByYou(r.options.review) && !approvedByUser(now, 'review')) {
        // None's "a reviewer agent, then you" (N1): your OK after the pass is asked in Approved (§16.5.2, #1417).
        if (r.options.finish === 'accept' && hasStage(r, 'approved')) w.move('approved', 'derived')
        this.askUser(w, 'approve', 'review', workflowText(FOR_YOU.passedReview, { card: card.key }))
        return null
      }
      this.finish(w, fin)
      return null
    })
    if (out) return this.refuse(card, actor, 'verdict', out)
    return this.ok(card, 'review', this.state(card).stage, acceptance.accepted.length ? { accepted: acceptance.accepted } : undefined, acceptance.warnings)
  }

  /**
   * The card's reviewer agent decides on focused tests its merge skipped for their environment (G20, HI-1367; the
   * user's decision, 28 Oct): `merge` true merges with them skipped, false returns the card. Recorded as its answer to
   * the queue's request, by the reviewer, with why; the user can still answer it first (For you). Its queue looks again.
   */
  async focusedSkip(ref: unknown, actor: Actor, request: string, merge: boolean, why: string): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    // Its reviewer agent's to decide (HR4's round 1 finding 2): the lane's, else one whose pass approved the submission.
    // Not the Assistant's or anyone else's; the user answers on the user's own path (For you, `answer`). Read again in the
    // write: the reviewer, the request still open, and still about the entry the queue is merging.
    const agent = agentOf(actor)
    const eligible = (c: CardRecord, st: CardState): boolean => !!agent && (agent === c.reviewer || passingReviewers(st).includes(agent))
    const notReviewer = { rule: 'verdict.reviewing', values: { card: card.key } } as GuardRefusal
    const notOpen = (st: CardState): GuardRefusal => ({ rule: 'move.notFromHere', values: { card: card.key, stage: st.stage, move: 'focused skip', moves: '' } }) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    if (!eligible(card, s)) return this.refuse(card, actor, 'focused skip', notReviewer) // i18n-ignore: intent names
    const bound = (st: CardState): FactData['ApprovalRequested'] | undefined => {
      const req = st.requests.find((x) => x.request === request && x.gate === FOCUSED_SKIP_GATE)
      return req && req.entry && openEntry(st)?.id === req.entry ? req : undefined
    }
    if (!bound(s)) return this.refuse(card, actor, 'focused skip', notOpen(s)) // i18n-ignore: intent names
    const r = this.rulesetOf(card, s)
    const out = await this.write(card, r, actor, (w) => {
      const st = w.state()
      if (!eligible(this.store.card(card.id), st)) return notReviewer
      const req = bound(st)
      if (!req) return notOpen(st)
      w.fact('Approval', { request, answer: merge ? 'approved' : 'declined', note: why, generation: st.generation }) // i18n-ignore: a fact's kind and codes, not text
      const e = st.entries.find((x) => x.id === req.entry)
      if (e) w.action('enqueue', { target: e.target })
      w.answer = stored(W.focusedSkip, { card: card.key, merge: merge ? 'yes' : 'no', why })
      this.wake(w, st.started?.builder, w.answer, 'answer')
      return null
    })
    return out ? this.refuse(card, actor, 'focused skip', out) : this.ok(card, s.stage, this.state(card).stage, { request, merge }) // i18n-ignore: intent names
  }

  /**
   * The user answers a request (§16.8.5): only the user (Darren's point 7, #1269: never an agent or the Assistant). An
   * approval satisfies its gate; a decline of a gate's request is a round, the card back to its builder; a reply (`note`)
   * is relayed. At the round limit the answer is the user's `choice`, and a carry on adds `rounds`. A decision (`decided`:
   * a Decide answer, or an agent's question approved with a note, HI-2286) is the board's to record, beside this. The agent waiting on it is woken: whoever asked (an agent's own question), else the builder;
   * at the round limit the builder and the reviewer, whose lane paused for it.
   */
  async answer(ref: unknown, request: string, answer: 'approved' | 'declined' | 'answered', opts: { note?: string; choice?: RoundChoice; rounds?: number; decided?: boolean; action?: AskActionKind } = {}): Promise<Reply> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const req = s.requests.find((x) => x.request === request)
    if (!req) return this.refuse(card, 'user', 'answer', { rule: 'move.notFromHere', values: { card: card.key, stage: s.stage, move: 'answer', moves: '' } })
    const r = this.rulesetOf(card, s)
    const before = await this.evidenceOf(card, s, r.options)
    const fin = await this.finishInputs(card, s, r, s.approved?.revision ?? s.latest?.revision)
    const from = s.stage
    const { note, choice, action } = opts
    // What the answer may be follows its request (HR3's #1269 round 1 finding 2): checked before anything is written.
    if (!answerFits(req, { outcome: answer, reply: !!note, decision: !!opts.decided, choice, rounds: opts.rounds, action }, LANE_MAX_ROUNDS)) throw new Error(`an answer (${answer}${choice ? `, ${choice}` : ''}) that doesn't fit request ${request} (${req.kind}, ${req.gate})`) // i18n-ignore: a programming error (tasks.ts checks first, in the user's words)
    const rounds = choice === 'carryOn' ? opts.rounds : undefined
    await this.cfg.hooks?.beforeWrite?.('answer')
    if (await this.revalidate(card, s, r.options, before)) return this.regather(card, () => this.answer(ref, request, answer, opts))
    const out = await this.write(card, r, 'user', (w) => {
      // Under the transaction: the request still open (a newer submission retires the old one's), the card where it was.
      const changed = this.stillAt(w, s, 'answer') ?? this.evidenceChanged(w, r.options, before)
      if (changed) return changed
      const st = w.state()
      if (!st.requests.some((x) => x.request === request)) return { rule: 'move.notFromHere', values: { card: card.key, stage: st.stage, move: 'answer', moves: '' } } as GuardRefusal
      w.fact('Approval', { request, answer, ...(note ? { note } : {}), generation: st.generation, ...(req.submission !== undefined ? { submission: req.submission } : {}), ...(choice ? { choice } : {}), ...(rounds ? { rounds } : {}), ...(action ? { action } : {}) }) // i18n-ignore: a fact's kind and codes, not text
      const builder = st.started?.builder
      // The question quoted short (its asker has it), so the reply after it is never cut off the wake (#1626).
      const asked = [...req.text.replace(/\s+/g, ' ').trim()]
      const quoted = asked.length > QUESTION_QUOTE_MAX ? `${asked.slice(0, QUESTION_QUOTE_MAX - 1).join('')}…` : asked.join('')
      // The answer, then what the user chose (and the rounds they gave), then the action they took or their reply.
      const said = inDefaultDialect(() => {
        let t = say(W.answered, { card: card.key, answer: answer === 'approved' || answer === 'declined' ? answer : 'other', question: quoted })
        if (choice) t = say(W.answeredChoice, { said: t, choice: say(CHOICE_WORDS[choice]) })
        if (choice && rounds) t = say(W.moreRounds, { said: t, rounds })
        if (action) {
          t = say(W.answeredAction, { said: t, action: say(ACTION_WORDS[action]) })
          if (note) t = say(W.answeredNote, { said: t, note })
        } else if (note) t = say(W.answeredWith, { said: t, note })
        return t
      })
      w.answer = said
      if (req.gate === ROUND_LIMIT_GATE) {
        this.wake(w, builder, said, 'answer')
        // Its lane's reviewer, which paused with it.
        if (card.reviewer && card.reviewer !== builder) this.wake(w, card.reviewer, said, 'answer')
        return null
      }
      if (req.gate === FOCUSED_SKIP_GATE) {
        // G20 (HI-1367): the user's decision on skipped focused tests, over its reviewer's: its queue looks again now.
        const e = st.entries.find((x) => x.id === req.entry)
        if (e) w.action('enqueue', { target: e.target })
        if (card.reviewer) this.wake(w, card.reviewer, said, 'answer')
      }
      if (req.gate === QUEUE_ADVANCE_GATE || req.gate === QUEUE_STUCK_GATE) {
        // The merge queue's own (#1351): its target's queue looks at the answer now (an approved update runs at once; a
        // stuck advance is looked at again, as Resume does).
        const e = st.entries.find((x) => x.id === req.entry)
        if (e) w.action('enqueue', { target: e.target, ...(req.gate === QUEUE_STUCK_GATE ? { recheck: true } : {}) })
      }
      if (req.gate === MERGE_CHOICE_GATE) {
        // HI-1697: the merge style and commit message are saved with the answer (chooseMerge); its queue looks again now.
        const e = st.entries.find((x) => x.id === req.entry)
        if (e) w.action('enqueue', { target: e.target })
      }
      if (req.gate !== 'review' && req.gate !== 'okBefore') {
        // A question an agent asked (or Combwork's own, after a merge): recorded, and the asker told; nothing moves.
        this.wake(w, req.asker ?? builder, said, 'answer')
        return null
      }
      if (answer === 'declined') {
        w.move('active', 'user')
        this.wake(w, builder, said, 'answer')
        this.askAtLimit(w)
        return null
      }
      // The gate is evaluated before anything moves on: passes and approvals at the current generation, not stale.
      const now = w.state()
      const missing = notApproved(now, r, card.labels)
      if (req.gate === 'review') {
        if (!missing || (missing.missing === 'userOk' && approvedByUser(now, 'review'))) this.finish(w, fin)
      } else if (!missing && st.stage === 'approved') {
        if (r.options.finish === 'combworkMerges') this.enqueue(w)
        else this.wake(w, builder, stored(W.approvedMerge))
      }
      // Whatever the approval led to (finished, queued, still waiting on another gate), its builder hears of it, once.
      if (!w.woken.includes(builder ?? '')) this.wake(w, builder, said)
      return null
    })
    if (out) return this.refuse(card, 'user', 'answer', out)
    return this.ok(card, from, this.state(card).stage)
  }

  /**
   * A decision the user made answers some of a card's open requests (HI-1932, Darren's decision): the questions it names,
   * each answered by it, in one write. Each must still be open and one a decision may answer (`decisionAnswers`), checked
   * under the write: any that isn't refuses the whole of it, nothing written. Each request's asker (else the builder) is
   * woken once with the requests it answers; nothing moves. The caller adds the decision itself in the same write
   * (runIntent's patch) and checks who may (tasks.ts: the user or the Assistant, never an agent).
   */
  async answerByDecision(ref: unknown, requests: readonly string[], d: { text: string; decision: string; recordedBy: string }): Promise<Reply> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const r = this.rulesetOf(card, s)
    const notOpen = (st: CardState, request: string): GuardRefusal | null => {
      const req = st.requests.find((x) => x.request === request)
      return req && decisionAnswers(req) ? null : { rule: 'move.notFromHere', values: { card: card.key, stage: st.stage, move: `answer ${request}`, moves: '' } } // i18n-ignore: an intent's name and a request id
    }
    for (const id of requests) {
      const no = notOpen(s, id)
      if (no) return this.refuse(card, 'user', 'answer', no)
    }
    const at = new Date().toISOString()
    const out = await this.write(card, r, 'user', (w) => {
      const st = w.state()
      // Under the transaction: every request still open and answerable, or none is answered.
      for (const id of requests) {
        const no = notOpen(st, id)
        if (no) return no
      }
      const byAgent = new Map<string, string[]>()
      for (const id of requests) {
        const req = st.requests.find((x) => x.request === id)!
        w.fact('Approval', { request: id, answer: 'answered', note: d.text, generation: st.generation, ...(req.submission !== undefined ? { submission: req.submission } : {}), byDecision: { decision: d.decision, recordedBy: d.recordedBy, at } }) // i18n-ignore: a fact's kind and codes, not text
        const asked = [...req.text.replace(/\s+/g, ' ').trim()]
        const quoted = asked.length > QUESTION_QUOTE_MAX ? `${asked.slice(0, QUESTION_QUOTE_MAX - 1).join('')}…` : asked.join('')
        const who = req.asker ?? st.started?.builder
        if (who) byAgent.set(who, [...(byAgent.get(who) ?? []), `"${quoted}"`])
      }
      const said = (qs: string[]): string => stored(W.byDecision, { card: card.key, questions: qs.length ? qs.reduce((list, item) => stored(W.and, { list, item })) : '', recordedBy: d.recordedBy, decision: d.text })
      w.answer = said([...byAgent.values()].flat())
      for (const [agent, qs] of byAgent) this.wake(w, agent, said(qs), 'answer')
      return null
    })
    if (out) return this.refuse(card, 'user', 'answer', out)
    return this.ok(card, s.stage, this.state(card).stage, { answered: [...requests] })
  }

  /** report merge (§16.9.3): the builder merged; Combwork checks containment (unless Not checked), then Done. */
  async reportMerge(ref: unknown, actor: Actor, args: { result?: string } = {}): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const r = this.rulesetOf(card, s)
    // Under Combwork merges (the card's own ruleset) the queue merges, never a report: refused saying where it is (#1354).
    const combwork = r.options.finish === 'combworkMerges'
    const queued = this.combworkMergesRefusal(card, s)
    if (queued) return this.refuse(card, actor, 'report merge', queued, null) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    // Only where the builder merges (or nothing is checked); with workflow rules off, a card Combwork merges is reported as
    // before 1.0 too, approved or waiting in the queue, whose entry it drops (a merge outside the queue, as S7's).
    const from = s.stage === 'approved' || (combwork && s.stage === 'merging') || awaitsAgentMerge(r, s)
    if (!from || (!combwork && r.options.finish !== 'agentMerges' && r.options.finish !== 'notChecked')) return this.notFrom(card, actor, s, 'report merge') // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    const before = await this.evidenceOf(card, s, r.options)
    const target = s.started?.target ?? ''
    const rev = s.approved?.revision ?? s.latest?.revision ?? null
    let contained: Maybe<boolean> | undefined
    let method: FactData['Integrated']['method'] = 'merge'
    // The target's head, read once (#1376): what containment is asked of, and the integration's result.
    const th = await this.platform(r.options).targetHead(target)
    if (r.guards.reportMerge.includes('done.contained')) {
      // Integration needs a non-empty change (§16.4.4).
      if (!rev || !s.approved?.base || rev === s.approved.base) contained = false
      else {
        const c = asCardCounts(s, await this.platform(r.options).contains(target, { base: s.approved.base, revision: rev, key: s.latest?.key }, !isUnknown(th) && th ? th : undefined))
        contained = isUnknown(c) ? c : !!c
        if (!isUnknown(c) && c) method = c.method === 'sameTree' ? 'sameTree' : c.method
      }
    }
    if (await this.revalidate(card, s, r.options, before)) return this.regather(card, () => this.reportMerge(ref, actor, args))
    const out = await this.write(card, r, actor, (w) => {
      const bad = this.stillAt(w, s, 'report merge') ?? this.evidenceChanged(w, r.options, before) ?? this.check(w, 'reportMerge', { agent: agentOf(actor), contained, revision: rev, target }) ?? this.staleUnchecked(w, r, rev) ?? this.blockersNotDone(w) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      if (bad) return bad
      if (contained === true) w.fact('Integrated', { revision: rev!, target, result: args.result ?? (!isUnknown(th) && th ? th : rev!), method, by: 'agent' }) // i18n-ignore: a fact's kind and codes, not text
      const open = combwork ? openEntry(w.state()) : undefined
      if (open) w.fact('IntegrationCancelled', { entry: open.id, reason: 'integratedOutside' }) // i18n-ignore: a fact's kind and codes, not text
      // Unchecked, its result is the builder's claim (HI-2014): kept on its finish, never read as the merge commit.
      if (contained !== true) w.claimed = args.result ?? null
      // Its slot, lane and the rest follow its finish (HI-2014).
      w.move('done', 'intent')
      return null
    })
    if (out) return this.refuse(card, actor, 'report merge', out) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    return this.ok(card, s.stage, 'done')
  }

  /**
   * Under Not checked, nothing checks what was merged, so the OK before merging (G10) must still be for the work in the
   * folder (HR2's #1592 round 1): a stale pass refuses the report, whether the OK was given or only asked. `approval.given`
   * passes a stale card (it waits for its new submission's OK), and the agent merging has `done.contained` besides.
   */
  private staleUnchecked(w: Write, r: Ruleset, rev: string | null): GuardRefusal | null {
    if (r.options.finish !== 'notChecked' || !this.enforced() || !okBeforeApplies(r, w.card.labels) || !w.state().stale) return null
    return { rule: 'integrate.approved', values: { card: w.card.key, revision: rev ? rev.slice(0, 7) : '—', cause: 'stale' } } as GuardRefusal
  }

  /**
   * A card Combwork merges (its own ruleset: the options it started under, or a change applied to it, never the project's
   * current options) while the rules are enforced: an agent's merge of it is refused, its next step where it is in the
   * merge queue (#1354, queueState.ts). Null otherwise: the agent merges, nobody checks, or the rules are off.
   */
  combworkMergesRefusal(card: CardRecord, s: CardState = this.state(card)): GuardRefusal | null {
    if (!this.enforced()) return null
    const q = queueStateOf(this, card, s)
    if (!q) return null
    const values: Record<string, string | number> = { card: card.key, queue: q.state }
    if (q.state === 'queued' || q.state === 'testing' || q.state === 'paused') values.target = q.target
    if (q.state === 'queued') values.n = q.position
    if (q.state === 'stale') values.current = (q.current ?? '').slice(0, 7)
    // What the pause waits for (#1406): the refusal's next step says it.
    if (q.state === 'paused') values.waits = pauseWait(q.reason, q.stuck)
    return { rule: 'merge.combworkMerges', values }
  }

  /** Who merges a card and where it is with the merge queue, in a sentence for agents (#1354); null unless Combwork merges it. */
  queueLineOf(ref: unknown): string | null {
    const card = this.resolve(ref)
    if (isRefusal(card)) return null
    const q = queueStateOf(this, card)
    // Merged, it is Done: nothing more to say.
    return q && q.state !== 'merged' ? queueLine(q, this.enforced()) : null
  }

  /**
   * A code card's checks before review and how to run one, for agents (HI-2276, toolReplies' `checksView`); null for a
   * no-code card, one past review, or rules that name no checks.
   */
  checksOf(ref: unknown): ReturnType<typeof checksView> {
    const card = this.resolve(ref)
    if (isRefusal(card) || card.kind !== 'code') return null
    const s = this.state(card)
    if (s.stage !== 'todo' && s.stage !== 'hold' && s.stage !== 'active' && s.stage !== 'review') return null
    const o = this.rulesetOf(card, s).options
    return checksView(o.preChecks, card.key, hasCapability(o.platform, 'checkCopies'))
  }

  /** The merge slot claimed for a card (#1354): refused, and recorded as Refused, when Combwork merges it. */
  async refuseCombworkMerge(ref: unknown, actor: Actor, move: string): Promise<Refusal | null> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return null
    const g = this.combworkMergesRefusal(card)
    return g ? this.refuse(card, actor, move, g, null) : null
  }

  /** ask the user (§16.8.1): For you of a kind. */
  async askTheUser(ref: unknown, actor: Actor, args: { kind: ForYouKind; text: string; revision?: string; checklist?: string[]; actions?: AskAction[] }): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    // HI-1734: Skip Review only where the card's rules review it (nothing to skip otherwise: it would only be refused).
    const reviews = this.reviewedRuleset(card, s).options.review !== 'none'
    const actions = (args.actions ?? []).filter((a) => a.kind !== 'skipReview' || reviews)
    let request = ''
    await this.write(card, s.started ? this.rulesetOf(card, s) : null, actor, (w) => {
      request = this.askUser(w, args.kind, 'ask', args.text, { asker: agentOf(actor), ...(args.revision ? { revision: args.revision } : {}), ...(args.checklist?.length ? { checklist: args.checklist } : {}), ...(actions.length ? { actions } : {}) })
    })
    return this.ok(card, s.stage, s.stage, { request })
  }

  /** couldn't within the rules (#686): For you (Decide), never a failed round, never a stall. */
  async cannotWithinRules(ref: unknown, actor: Actor, args: { rule: string; why: string }): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    await this.write(card, s.started ? this.rulesetOf(card, s) : null, actor, (w) => {
      const request = `${card.key}/r${s.lastSeq + 1}`
      w.fact('CannotWithinRules', { rule: args.rule, why: args.why, request })
      w.fact('ApprovalRequested', { request, kind: 'decide', gate: args.rule, text: args.why, for: 'user', ...(agentOf(actor) ? { asker: agentOf(actor)! } : {}) })
      w.action('notify', { text: args.why })
    })
    return this.ok(card, s.stage, s.stage)
  }

  /** request to builder (#912): the reviewer's request mid-review; wakes the builder now. */
  async requestToBuilder(ref: unknown, actor: Actor, text: string): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    await this.write(card, this.rulesetOf(card, s), actor, (w) => {
      w.fact('ReviewerRequest', { text })
      this.wake(w, s.started?.builder, stored(W.reviewerAsks, { card: card.key, text }))
    })
    return this.ok(card, s.stage, s.stage)
  }

  /**
   * A card loop's step (#1382, #1467): the builder's design posted for its reviewer's check (in Doing), or its going ahead
   * with it unchecked once the check is due (`proceed`), or a follow-up of its work ready for the reviewer's check (in
   * Review or Passed: a change asked of it, such as a screenshot's; never gone ahead with unchecked), or the reviewer's
   * answer (`ok`, `gaps`). A design or a follow-up is named (`<key>/s<seq>`); a design is due `waitMinutes` after its post
   * (Card loops → Design check wait, the caller's), kept in its fact: an answer or `proceed` names the step it is about,
   * and one for an earlier step is refused, so a late reply never settles a newer one. Moves nothing; wakes the other side: the builder's steps its reviewer (the lane's, else the
   * agent that last reviewed it), an answer its builder. A design or follow-up with no reviewer to check it is refused,
   * but a pool lane's design (HI-2310): the pool gives it to the next free reviewer and tells it (`assignReviewer`). With the rules
   * off, nothing is checked. `reviewer`: the card's loop reviewer as it is when the write decides (loopReviewer.ts), read
   * inside its board change: an agent's removal publishes under the same lock, so it is either before (refused) or after.
   */
  async loopStep(ref: unknown, actor: Actor, step: LoopStepId, text: string, opts: { design?: string; waitMinutes: number; reviewer: () => Promise<string | null>; now?: number }): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    let posted: { design: string; until?: string } | null = null
    const refused = await this.write(
      card,
      s.started ? this.rulesetOf(card, s) : null,
      actor,
      (w, reviewer): GuardRefusal | null => {
        // Read under the transaction: the step waiting, the card's builder and reviewer now, not when the call began.
        const now = w.state()
        const agent = agentOf(actor)
        const side = loopStepSide(step)
        const at = opts.now ?? Date.now()
        if (this.enforced()) {
          const builder = now.started?.builder ?? null
          // An answer or going ahead names a step waiting: none waiting, or an earlier one, is said first (HI-3011), so a
          // reviewer the pool gave a design that has since closed (the card put back) hears that, not that it isn't its.
          if (step !== 'design' && step !== 'followUp') {
            if (!now.step) return { rule: 'loop.noStep', values: { card: card.key } } as GuardRefusal
            if (opts.design !== now.step.id) return { rule: 'loop.staleStep', values: { card: card.key, design: opts.design ?? '', waiting: now.step.id } } as GuardRefusal
          }
          // Each side its own (an agent; the user and the Assistant take either): the builder's steps by the card's
          // builder, an answer by its reviewer, never its builder.
          if (agent && (side === 'builder' ? agent !== builder : agent !== reviewer || agent === builder)) return { rule: 'loop.stepNotYours', values: { card: card.key, side } } as GuardRefusal
          if (step === 'design' || step === 'followUp') {
            // A design before the work goes to review; a follow-up of work reviewed or under review.
            // (Queued counts as approved: its entry is taken out below, #1623; one the queue is merging now can't be.)
            const here = step === 'design' ? now.stage === 'active' : now.stage === 'review' || now.stage === 'approved' || now.stage === 'merging'
            if (!here) return { rule: 'loop.stepNotHere', values: { card: card.key, stage: now.stage, step } } as GuardRefusal
            if (step === 'followUp' && openEntry(now)?.state === 'started') return { rule: 'loop.followUpMerging', values: { card: card.key } } as GuardRefusal
            // A pool lane's design (HI-2310) needs no reviewer yet: the pool gives it to the next free one.
            if (!(step === 'design' && w.card.reviewerPool) && (!reviewer || reviewer === builder)) return { rule: 'loop.noReviewer', values: { card: card.key } } as GuardRefusal
          } else if (now.step) {
            // A follow-up was asked for: it waits for its check, with no going ahead unchecked.
            if (step === 'proceed' && now.step.step === 'followUp') return { rule: 'loop.followUpChecked', values: { card: card.key } } as GuardRefusal
            const due = now.step.until ? Date.parse(now.step.until) : NaN
            if (step === 'proceed' && due > at) return { rule: 'loop.tooEarly', values: { card: card.key, minutes: Math.ceil((due - at) / 60_000) } } as GuardRefusal
          }
        }
        if (step === 'design') {
          posted = { design: `${card.key}/s${now.lastSeq + 1}`, until: new Date(at + opts.waitMinutes * 60_000).toISOString() }
          w.fact('LoopStep', { step, text, ...posted, waitMinutes: opts.waitMinutes })
        } else if (step === 'followUp') {
          // A follow-up on a queued card first takes it out of the queue (#1623): the queue mustn't merge the approved
          // revision while the follow-up changes its line. The reviewer's ok queues it again.
          const open = openEntry(now)
          if (open?.state === 'open') {
            w.fact('IntegrationCancelled', { entry: open.id, reason: 'followUp' }) // i18n-ignore: a fact's kind and codes, not text
            if (w.current === 'merging') w.move('approved', 'derived')
          }
          posted = { design: `${card.key}/s${w.state().lastSeq + 1}` }
          w.fact('LoopStep', { step, text, ...posted })
        } else {
          const about = opts.design ?? now.step?.id
          w.fact('LoopStep', { step, text, ...(about ? { design: about } : {}), ...(now.step ? { of: now.step.step } : {}) })
          // A follow-up checked on an approved card where Combwork merges (#1623): queued again while its pass holds.
          const r = w.ruleset
          const after = w.state()
          if (step === 'ok' && now.step?.step === 'followUp' && r?.options.finish === 'combworkMerges' && w.current === 'approved' && !openEntry(after) && !notApproved(after, r, card.labels)) this.enqueue(w)
        }
        // A pool lane's design (HI-2310) is the pool's to give out and tell, as a submission is: no reviewer is woken. Its
        // builder going ahead wakes the design's reviewer, if the pool gave it to one.
        if (step === 'design' && w.card.reviewerPool) w.action('assignReviewer', { submission: now.lastSeq + 1 })
        // Its words are the fact's (loopWakes.ts' aboutOf); `why` is the action's own note.
        else if (side === 'builder') {
          if (reviewer || !w.card.reviewerPool) this.wake(w, reviewer ?? 'reviewers', `${card.key}: ${step}`) // i18n-ignore: a wake, agent-facing
        }
        else this.wake(w, now.started?.builder, `${card.key}: ${step}`) // i18n-ignore: a wake, agent-facing
        return null
      },
      opts.reviewer
    )
    if (refused) return this.refuse(card, actor, 'loop step', refused) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    const p = posted as { design: string; until?: string } | null
    return this.ok(card, s.stage, s.stage, p ? { design: p.design, ...(p.until ? { until: p.until, waitMinutes: opts.waitMinutes } : {}) } : undefined)
  }

  /**
   * A comment or message on a card: no fact can move it (§16.8.2: only a submission or a decision moves an Approved
   * card back to Review). The board keeps comments; the workflow sees nothing.
   */
  comment(ref: unknown, actor: Actor): Reply {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    return this.ok(card, s.stage, s.stage)
  }

  /** The user records a decision (§16.4.6): a new generation; passes and approvals before it go stale. */
  async recordDecision(ref: unknown, text: string): Promise<Reply> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const r = s.started ? this.rulesetOf(card, s) : null
    const from = s.stage
    await this.write(card, r, 'user', (w) => {
      // Read under the transaction: where the card is now, not where it was when the call began.
      const now = w.state()
      const generation = now.generation + 1
      w.fact('Decision', { decision: `${card.key}/d${generation}`, generation, text }) // i18n-ignore: a fact's kind and codes, not text
      this.wake(w, now.started?.builder, stored(W.newDecision, { card: card.key }))
      if (['review', 'approved', 'merging'].includes(now.stage)) this.wake(w, this.reviewerOf(card), stored(W.newDecision, { card: card.key }))
      // The user's own review request was for the old generation (retired by the decision): asked again at once.
      if (r && now.stage === 'review' && r.options.review === 'you' && now.latest) this.askUser(w, 'approve', 'review', workflowText(FOR_YOU.newDecision, { card: card.key }))
      if (!r || (now.stage !== 'approved' && now.stage !== 'merging' && !awaitsAgentMerge(r, now))) return
      const entry = openEntry(now)
      // After IntegrationStarted it's too late to stop that merge: it completes, then For you (§16.4.6).
      if (entry?.state === 'started') return
      w.fact('Stale', { approved: now.approved?.revision ?? null, current: now.approved?.revision ?? null, why: 'decision' }) // i18n-ignore: a fact's kind and codes, not text
      if (entry) w.fact('IntegrationCancelled', { entry: entry.id, reason: 'decision' }) // i18n-ignore: a fact's kind and codes, not text
      const back = hasStage(r, 'review') ? 'review' : 'active'
      if (now.stage !== back) w.move(back, 'derived')
    })
    return this.ok(card, from, this.state(card).stage)
  }

  /** An agent received the card's decisions (the delivery, its reply flag, or reading the card after them). */
  async received(ref: unknown, agent: string): Promise<void> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return
    const s = this.state(card)
    await this.write(card, null, `agent:${agent}`, (w) => {
      w.fact('DecisionsReceived', { agent, generation: s.generation })
    })
  }

  async block(ref: unknown, actor: Actor, reason: string): Promise<void> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return
    await this.write(card, null, actor, (w) => (reason ? w.fact('Blocked', { reason }) : w.fact('Unblocked', {}))) // i18n-ignore: a fact's kind and codes, not text
  }

  /** The rules a drag from one stage to another would skip (§16.8.4): the guards of the moves it jumps over. */
  skippedRules(card: CardRecord, r: Ruleset, from: StageId, to: StageId): string[] {
    if (!this.enforced()) return []
    const a = ORDER.indexOf(from)
    const b = ORDER.indexOf(to)
    if (a < 0 || b < 0 || b <= a) return []
    const out = new Set<string>()
    const past = (stage: StageId) => a <= ORDER.indexOf(stage) && b > ORDER.indexOf(stage)
    if (past('todo')) r.guards.start.forEach((g) => out.add(g))
    if (past('active') && card.kind === 'code') r.guards.submit.filter((g) => g !== 'submit.notDuplicate').forEach((g) => out.add(g))
    if ((past('review') || past('approved')) && (r.options.review !== 'none' || okBeforeApplies(r, card.labels))) out.add('integrate.approved')
    if (to === 'done' && card.kind === 'code') {
      if (r.options.finish === 'combworkMerges') r.guards.integrate.filter((g) => g !== 'integrate.approved').forEach((g) => out.add(g))
      if (r.options.finish === 'agentMerges' || r.options.finish === 'notChecked') r.guards.reportMerge.forEach((g) => out.add(g))
      if (r.options.finish === 'committed') r.guards.finish.forEach((g) => out.add(g))
    }
    return [...out]
  }

  /**
   * Whether the Assistant's move into Active leaves the card with nobody on it (HI-2062): no builder named, the card's
   * agent as its caller read it (tasks.ts gateOf; the write checks the card again as it leaves it).
   */
  private leavesNobody(to: StageId, by: 'user' | 'assistant', opts: { builder?: string }): boolean {
    return by === 'assistant' && to === 'active' && !opts.builder
  }

  /** That move refused without the user's reason: `move.doingNobody`, naming the other rules it skips too. Null: it may go. */
  private async nobodyOn(card: CardRecord, to: StageId, by: 'user' | 'assistant', opts: { builder?: string; reason?: string }, others: string[]): Promise<Refusal | null> {
    if (!this.leavesNobody(to, by, opts) || opts.reason) return null
    // agent-protocol: who can override a refusal, the Agent API's fixed `override` value (AGENT_API.md, §16.8.3)
    return this.refuse(card, 'assistant', 'move', { rule: 'move.doingNobody', values: { card: card.key, stage: to, also: others.length ? 'yes' : 'no', rules: others.join(', ') } }, 'the user or the Assistant') // i18n-ignore: select keys and who can override, agent-facing (§16.8.3)
  }

  /**
   * The user's drag (or menu): never refused. A move that skips rules asks first, then records an `Override`; a move
   * that skips nothing just moves (§16.7.1). The Assistant passes `override: { reason }` or is refused.
   */
  async move(ref: unknown, to: StageId, by: 'user' | 'assistant', opts: { confirm?: boolean; reason?: string; builder?: string; dry?: boolean; paths?: string[]; askPaths?: boolean } = {}): Promise<Moved | Ask | Refusal> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const from = s.stage
    if (to === from) return this.ok(card, from, to)
    // `dry` (the user's, #1275): only whether it would ask, and which rules; nothing written (a window Start asks first).
    if (opts.dry && by !== 'user') throw new Error('a dry move is the user\'s') // i18n-ignore: a programming error, never shown
    // The Assistant's move on, while the card waits for the user at its round limit: only the user's answer resumes it.
    const limit = ORDER.indexOf(to) > ORDER.indexOf(from === 'hold' ? 'active' : from) ? this.atLimit(card, s, by) : null
    if (limit) return this.refuse(card, by, 'move', limit)
    // A Done card dragged on is reopened: its next cycle's rules (as from Todo), not its last's.
    const reopened = from === 'done' && ORDER.indexOf(to) > ORDER.indexOf('todo')
    const r = this.rulesetOf(card, reopened ? { ...s, stage: 'todo' } : s)
    // Never into a stage the card's ruleset doesn't have (no review: no Review; no merge step: no Approved or Merging).
    if (!hasStage(r, to)) return this.refuse(card, by, 'move', { rule: 'move.noStage', values: { card: card.key, stage: to, stages: r.stages.map((x) => x.id).join(', ') } })
    // On Hold cancels a queue entry and keeps the lease; leaving it returns the card where it was (§16.7.4).
    if (to === 'hold') {
      if (opts.dry) return this.ok(card, from, to)
      const out = await this.write(card, r, by, (w) => {
        const changed = this.stillAt(w, s, 'move')
        if (changed) return changed
        const e = openEntry(s)
        if (e) w.fact('IntegrationCancelled', { entry: e.id, reason: 'hold' }) // i18n-ignore: a fact's kind and codes, not text
        w.move('hold', 'user')
        return null
      })
      return out ? this.refuse(card, by, 'move', out) : this.ok(card, from, 'hold')
    }
    if (from === 'hold') {
      const back = [...this.store.facts(card.id)].reverse().find((f): f is Fact<'Moved'> => f.kind === 'Moved' && (f.data as FactData['Moved']).to === 'hold')
      const was = back?.data.from ?? 'todo'
      const forward = ORDER.indexOf(to) > ORDER.indexOf(was) && to !== 'done'
      // Past where it was: back there and the intents of a drag from there, in one write (dragForward).
      if (forward) return this.dragForward(card, was, to, by, opts, was)
      if (to === was) {
        if (opts.dry) return this.ok(card, from, to)
        const nobody = await this.nobodyOn(card, to, by, opts, [])
        if (nobody) return nobody
        const out = await this.write(card, r, by, (w) => {
          const changed = this.stillAt(w, s, 'move')
          if (changed) return changed
          if (this.leavesNobody(to, by, opts)) w.fact('Override', { rules: ['move.doingNobody'], move: `${from}→${to}`, by, reason: opts.reason ?? '' }) // i18n-ignore: a fact's kind and codes, not text
          // A card that was queued (Merging, or Approved under Combwork merges) is queued again.
          const requeue = to === was && (was === 'merging' || (was === 'approved' && r.options.finish === 'combworkMerges' && !s.stale && !notApproved(s, r, card.labels)))
          w.move(requeue ? 'approved' : was, 'user')
          if (requeue) this.enqueue(w)
          // The trip to On Hold retired the gate's request (it belongs to its stage): asked again, if still unmet.
          else this.reask(w)
          return null
        })
        if (out) return this.refuse(card, by, 'move', out)
        return this.ok(card, from, this.state(card).stage)
      }
    }
    // Reopening a Done card past Todo (§16.7.4): no rule skipped by the reopening; back to Todo and a drag from there, a
    // new cycle (its start), in one write.
    if (from === 'done' && ORDER.indexOf(to) > ORDER.indexOf('todo') && to !== 'done') return this.dragForward(card, from, to, by, opts, 'todo')
    // A forward drag into Active, Review, Approved or Merging stands for intents, and runs them in order (Start, then
    // submit, then the review skipped): never a bare move that leaves a card with no start, nothing to review or no
    // queue entry. Each step that skips nothing just happens; one that would skip a rule asks first (§16.8.4).
    if (from !== 'hold' && ORDER.indexOf(to) > ORDER.indexOf(from) && to !== 'done') return this.dragForward(card, from, to, by, opts)
    // Out of On Hold, the rules a move skips count from where the card was, not from Todo.
    const heldFrom = from === 'hold' ? ([...this.store.facts(card.id)].reverse().find((f): f is Fact<'Moved'> => f.kind === 'Moved' && (f.data as FactData['Moved']).to === 'hold')?.data.from ?? 'todo') : from
    const others = this.skippedRules(card, r, heldFrom, to)
    // Back into Active with nobody on it (HI-2062): the Assistant's, a rule as a start's is (dragForward).
    const skipped = this.leavesNobody(to, by, opts) ? [...others, 'move.doingNobody'] : others
    if (skipped.length && by === 'user' && (!opts.confirm || opts.dry)) return { ask: true, card: card.key, rules: skipped }
    if (opts.dry) return this.ok(card, from, to)
    const nobody = await this.nobodyOn(card, to, by, opts, others)
    if (nobody) return nobody
    // agent-protocol: who can override a refusal, the Agent API's fixed `override` value (AGENT_API.md, §16.8.3)
    if (skipped.length && by === 'assistant' && !opts.reason) return this.refuse(card, 'assistant', 'move', { rule: 'move.needsOverride', values: { card: card.key, stage: to, rules: skipped.join(', ') } }, 'the user or the Assistant') // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    const out = await this.write(card, r, by, (w) => {
      // The drag was made on the card as it was: if it moved on meanwhile, the user sees where it is now and drags again.
      const changed = this.stillAt(w, s, 'move')
      if (changed) return changed
      if (skipped.length) w.fact('Override', { rules: skipped, move: `${from}→${to}`, by, reason: opts.reason ?? '' }) // i18n-ignore: a fact's kind and codes, not text
      // Leaving a stage with a queue entry cancels it (the user moved it out).
      const e = openEntry(s)
      if (e && to !== 'merging') w.fact('IntegrationCancelled', { entry: e.id, reason: 'user' }) // i18n-ignore: a fact's kind and codes, not text
      w.move(to, skipped.length ? 'override' : 'user')
      return null
    })
    if (out) return this.refuse(card, by, 'move', out)
    // An override's Done (Darren's option A, HI-2014): the reply says which cards waiting on it start without its work.
    const waiting = to === 'done' && skipped.length ? this.store.cards().filter((c) => c.blockedBy.includes(card.id) && c.stage !== 'done').map((c) => c.key) : []
    return this.ok(card, from, to, undefined, waiting.length ? [say(W.doneByOverride, { cards: waiting.join(', '), card: card.key })] : undefined)
  }

  /**
   * A forward drag's intents (§16.8.4), decided whole and written in one write (HR2's #1265 round 1): each step is
   * gathered first, outside the lock (a start; a submission on the state the start would leave; past Review, the review
   * skipped), and the rules they would skip, together, are the question (the user's, nothing written), the refusal (the
   * Assistant's without a reason: only its `Refused`) or one `Override` naming them all. A step refused for what no
   * override makes true (nothing to submit, a fact that couldn't be read) refuses the drag, nothing written. The write
   * checks the rules again: one not decided on undoes it, and asks again. `fromHold`: where the card goes first, in the
   * same write (back from On Hold to where it was; a Done card reopened, to Todo), the drag counted from there.
   */
  private async dragForward(card: CardRecord, from: StageId, to: StageId, by: 'user' | 'assistant', opts: { confirm?: boolean; reason?: string; builder?: string; dry?: boolean; paths?: string[]; askPaths?: boolean }, fromHold?: StageId): Promise<Moved | Ask | Refusal> {
    const asking = by === 'user' ? !opts.confirm || !!opts.dry : !opts.reason
    const s0 = this.state(card)
    // Back from On Hold: the drag counts from where the card was.
    const s: CardState = fromHold ? { ...s0, stage: fromHold } : s0
    // The rules of where the drag counts from (a reopened card's: its next cycle's).
    const r = this.rulesetOf(card, s)
    const gs = s.stage === 'todo' ? await this.gatherStart(card, s, by, opts.builder, !!opts.dry) : null
    if (gs && !('data' in gs)) return this.refuse(card, by, 'start', gs)
    try {
      const s1 = gs ? this.predicted(card, s, gs) : s
      const gsub = ORDER.indexOf(to) > ORDER.indexOf('active') && s1.stage === 'active' ? await this.gatherSubmit(card, s1, by, opts.paths ? { paths: opts.paths } : {}, gs ? gs.r : r, !!gs) : null
      // The window's drag of a started None code card (HI-2352): what its paths leave out is asked first, read-only, so
      // the user includes it or leaves it (an unchanged revision too: a later round's new file may be all its change).
      const leftOut = gsub && !gs && by === 'user' && opts.askPaths && !opts.dry && ('inputs' in gsub || gsub.rule === 'submit.unchanged') ? await this.leftOutOf('inputs' in gsub ? gsub.card : card, r.options) : null
      if (leftOut) return { ask: true, card: card.key, rules: [], leftOut }
      if (gsub && !('inputs' in gsub)) {
        // A submission refused for what no override makes true stops the drag there (§16.8.4), after its start. Its folder
        // may only exist once started (a slot of its own): the start alone, then the submission gathered again on it.
        if (!gs) return this.refuse(card, by, 'submit', gsub)
        if (opts.dry) return this.dragForward(card, from, 'active', by, opts, fromHold)
        const started = await this.dragForward(card, from, 'active', by, opts, fromHold)
        // Its paths aren't asked after the start (HI-2352: nothing written may then ask; nothing is since it started).
        return isRefusal(started) || 'ask' in started ? started : this.dragForward(card, from, to, by, { ...opts, askPaths: false })
      }
      // Where the card is once submitted (null: Finish decides, with no review), and what is left to the stage dragged to.
      const after: StageId | null = gsub ? (r.options.review === 'none' ? null : 'review') : s1.stage
      const approved = !gsub && !!s1.latest && !s1.stale && !notApproved(s1, r, card.labels)
      const queueOnly = approved && to === 'merging' && r.options.finish === 'combworkMerges' && ORDER.indexOf(s1.stage) < ORDER.indexOf('merging')
      const pastReview = !approved && after !== null && ORDER.indexOf(after) < ORDER.indexOf(to)
      if (!gs && !gsub && !pastReview && !queueOnly && !fromHold) return this.ok(card, from, s0.stage)
      const rules = new Set<string>()
      if (gs) for (const x of this.failingOf(card, s, gs.r, 'start', gs.ins)) rules.add(x)
      if (gsub) for (const x of this.failingOf(gsub.card, gsub.s, gsub.r, 'submit', gsub.inputs, gsub.only)) rules.add(x)
      // Past Review (or the user's OK): the review and approvals are skipped, and the change counts as approved.
      if (pastReview && this.enforced()) rules.add('integrate.approved')
      // The Assistant's start into Active naming nobody (HI-2062): nobody on it, an agent on it or one started is the
      // user's choice, so it is a rule its reason overrides, recorded in the same Override as any other the move skips.
      const others = [...rules]
      const nobody = !!gs && this.leavesNobody(to, by, opts)
      if (nobody) rules.add('move.doingNobody')
      const skipped = [...rules]
      // agent-protocol: who can override a refusal, the Agent API's fixed `override` value (AGENT_API.md, §16.8.3)
      const needs = (list: string[]): Ask | Refusal => (by === 'user' ? { ask: true, card: card.key, rules: list } : refusal('move.needsOverride', { card: card.key, stage: to, rules: list.join(', ') }, 'the user or the Assistant')) // i18n-ignore: who can override, agent-facing (§16.8.3)
      if (opts.dry && !skipped.length) return this.ok(card, from, s0.stage)
      if (nobody && asking) return (await this.nobodyOn(card, to, by, opts, others))!
      // agent-protocol: who can override a refusal, the Agent API's fixed `override` value (AGENT_API.md, §16.8.3)
      if (skipped.length && asking) return by === 'user' ? needs(skipped) : this.refuse(card, 'assistant', 'move', { rule: 'move.needsOverride', values: { card: card.key, stage: to, rules: skipped.join(', ') } }, 'the user or the Assistant') // i18n-ignore: who can override, agent-facing (§16.8.3)
      await this.cfg.hooks?.beforeWrite?.('move')
      // A start's passes, as `start`'s (its platform's `startGathers`, HI-2916).
      const gathers = gs ? (this.platform(gs.o).startGathers ?? 1) : 1
      if (gs && (await this.revalidate(card, s, gs.o, gs.before, gathers))) return await this.regather(card, () => this.dragForward(card, from, to, by, opts, fromHold))
      if (!gs && gsub && (await this.revalidate(gsub.card, gsub.s, gsub.o, gsub.before))) return await this.regather(card, () => this.dragForward(card, from, to, by, opts, fromHold))
      const cause: FactData['Moved']['cause'] = skipped.length ? 'override' : 'user'
      // The rules as they are in the write: one not decided on undoes the write (it throws), to ask again.
      const decided = (now: string[]): void => {
        const more = now.filter((x) => !rules.has(x))
        if (more.length) throw new DragUndone({ rule: 'move.needsOverride', values: { card: card.key, stage: to, rules: [...skipped, ...more].join(', ') } })
      }
      let out: GuardRefusal | null
      let startMoved = false
      try {
        out = await this.write(card, r, by, (w) => {
          const moved = this.stillAt(w, s0, 'move')
          if (moved) return moved
          // One Override naming every rule skipped: after the submission when it approves it (past Review: it counts as
          // approved for the latest submission), else first.
          const override = (): void => void (skipped.length && w.fact('Override', { rules: skipped, move: `${s.stage}→${to}`, by, reason: opts.reason ?? '' })) // i18n-ignore: a fact's kind and codes, not text
          const approves = pastReview && !!gsub
          if (!approves) override()
          if (fromHold) w.move(fromHold, 'user')
          // The evidence on the state it was gathered on (back where it was, from On Hold): moved since, the write is undone.
          const changed = gs ? this.evidenceChanged(w, gs.o, gs.before) : gsub ? this.evidenceChanged(w, gsub.o, gsub.before, gsub.card) : null
          startMoved = !!changed && !!gs
          if (changed) throw new DragUndone(changed)
          if (gs) {
            decided(this.failingIn(w, 'start', gs.ins))
            this.applyStart(w, gs, cause)
          }
          if (gsub) {
            // After the start, the submission's evidence as it was gathered on the state the start leaves.
            const shifted = gs ? this.evidenceChanged(w, gsub.o, gsub.before, gsub.card) : null
            if (shifted) throw new DragUndone(shifted)
            decided(this.failingIn(w, 'submit', this.submitInputs(gsub), gsub.only))
            this.applySubmit(w, gsub, { summary: '' }, cause)
            if (approves) override()
          }
          if (queueOnly) this.enqueue(w)
          else if (pastReview && ORDER.indexOf(w.current) < ORDER.indexOf(to)) {
            if (to === 'merging' && r.options.finish === 'combworkMerges') this.enqueue(w)
            else w.move(hasStage(r, 'approved') ? 'approved' : to, cause)
          }
          return null
        })
      } catch (e) {
        if (!(e instanceof DragUndone)) throw e
        // The start's fingerprint moved again before the write, its content the same: gathered again while its platform
        // allows more passes (`start`'s rule, HI-2916).
        const again = startMoved && gs && gathers > 1 && this.gathering.depth(card.id) < gathers ? await this.startAgain(card, s, gs.o, gs.before) : null
        if (again) {
          this.startPassLog(card, 'write', again, gathers)
          return await this.regather(card, () => this.dragForward(card, from, to, by, opts, fromHold))
        }
        if (startMoved) this.startRefusedLog(card, 'write', gathers, this.noPassWhy(card, gathers))
        if (e.refused.rule === 'move.needsOverride' && by === 'user') return needs(String(e.refused.values.rules).split(', '))
        // agent-protocol: who can override a refusal, the Agent API's fixed `override` value (AGENT_API.md, §16.8.3)
        return this.refuse(card, by, 'move', e.refused, e.refused.rule === 'move.needsOverride' ? 'the user or the Assistant' : 'the user') // i18n-ignore: who can override, agent-facing (§16.8.3)
      }
      return out ? this.refuse(card, by, 'move', out) : this.ok(card, from, this.state(card).stage)
    } finally {
      // A slot lent for its start and not started with (asked, refused, undone): given back (#1438).
      if (gs && 'data' in gs && gs.lent) await this.slotUnused(card, gs.lent)
    }
  }

  /**
   * An agent's `cw_update_task` column move (§16.7.1): refused with the intent to use; or, for one transition (P4
   * to P8), translated into that intent through the same guards (§16.17). `summary`: the move's comment, as the
   * submission's summary, the verdict's comment or put back's why. Doing: `builder`, the agent it is started for (given
   * to another); a Done card is reopened and started.
   */
  async agentColumnMove(ref: unknown, actor: Actor, column: 'doing' | 'review' | 'passed' | 'done' | 'todo', opts: { translate?: boolean; summary?: string; builder?: string } = {}): Promise<Reply> {
    const intent = { doing: 'start', review: 'submit', passed: 'verdict', done: 'report merge', todo: 'put back' }[column] // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    if (!opts.translate) {
      const card = this.resolve(ref, actor)
      // Done for a card Combwork merges: no intent of the agent's does it, so the refusal names the queue (#1354).
      const queued = column === 'done' && !isRefusal(card) ? this.combworkMergesRefusal(card) : null
      return this.refuse(isRefusal(card) ? null : card, actor, `column ${column}`, queued ?? { rule: 'move.useIntent', values: { intent } }, null) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    }
    const reply = await (column === 'doing'
      ? this.start(ref, actor, { reopen: true, ...(opts.builder ? { builder: opts.builder } : {}) })
      : column === 'review'
        ? this.submit(ref, actor, { summary: opts.summary ?? '' })
        : column === 'passed'
          ? this.verdictOnLatest(ref, actor, true, opts.summary ?? '')
          : column === 'done'
            ? this.reportMerge(ref, actor)
            : this.putBack(ref, actor, opts.summary ? { why: opts.summary } : {}))
    return isRefusal(reply) ? reply : { ...reply, data: { ...reply.data, useNextTime: intent } }
  }

  /**
   * An agent's `cw_update_task` `review` (§16.8.1), for one transition (P4 to P8): `start` is start review of the
   * latest submission, `passed` and `failed` a verdict on it (its review started first when it wasn't).
   */
  async agentReview(ref: unknown, actor: Actor, review: 'start' | 'passed' | 'failed', comment = ''): Promise<Reply> {
    const intent = review === 'start' ? 'start review' : 'verdict' // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    const reply = await (review === 'start' ? this.startReview(ref, actor) : this.verdictOnLatest(ref, actor, review === 'passed', comment))
    return isRefusal(reply) ? reply : { ...reply, data: { ...reply.data, useNextTime: intent } }
  }

  private async verdictOnLatest(ref: unknown, actor: Actor, pass: boolean, comment: string): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    // Its review started in the verdict's own write when it isn't yet (HR2's #1268 round 1: one write, all or nothing).
    // The card as the caller named it (its key may not be one an agent can name: a project named in one letter, #1294).
    const startReview = s.stage === 'review' && !!s.latest && !(s.reviewing[s.latest.id] ?? []).includes(agentOf(actor) ?? '')
    return this.verdict(ref, actor, { pass, comment, ...(startReview ? { startReview } : {}) })
  }

  /**
   * Remove from queue (the user's, or the Assistant's within Control with a reason: OP-9): `IntegrationCancelled`,
   * recorded as an override; a rebuilt queue skips it; the card back to Approved and its builder woken. An entry whose
   * advance has begun is being merged: refused (its recovery finishes it). `guard`: the caller's authority, checked again
   * inside the write (the Assistant's change boundary: it throws, and nothing is written, once it no longer holds).
   */
  async removeFromQueue(ref: unknown, reason = '', by: 'user' | 'assistant' = 'user', guard?: () => void): Promise<Reply> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const r = this.rulesetOf(card, s)
    await this.cfg.hooks?.beforeWrite?.('remove from queue') // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    const out = await this.write(card, r, by, (w) => {
      guard?.()
      const changed = this.stillAt(w, s, 'remove from queue') // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      if (changed) return changed
      const e = openEntry(w.state())
      // A forward merge (HI-2679), queued or returned: it ends, not merged (Done with no `Integrated`), unless it is
      // advancing now (whose outcome the queue records, in the same lock).
      if (w.state().forward && w.state().stage !== 'done') {
        if (e?.state === 'started') return { rule: 'queue.advancing', values: { card: card.key, target: e.target } } as GuardRefusal
        w.fact('Override', { rules: ['integrate'], move: 'remove from queue', by, reason }) // i18n-ignore: a fact's kind and codes, not text
        if (e) w.fact('IntegrationCancelled', { entry: e.id, reason: 'removed' }) // i18n-ignore: a fact's kind and codes, not text
        w.move('done', 'user')
        return null
      }
      if (!e) return null
      if (e.state === 'started') return { rule: 'queue.advancing', values: { card: card.key, target: e.target } } as GuardRefusal
      w.fact('Override', { rules: ['integrate'], move: 'remove from queue', by, reason }) // i18n-ignore: a fact's kind and codes, not text
      w.fact('IntegrationCancelled', { entry: e.id, reason: 'removed' }) // i18n-ignore: a fact's kind and codes, not text
      // Never into a stage the ruleset doesn't have (no review, no G10: no Approved).
      w.move(hasStage(r, 'approved') ? 'approved' : 'active', 'user')
      this.wake(w, w.state().started?.builder, stored(W.removed, { card: card.key, by: by === 'user' ? 'user' : 'assistant', reason: reason ? `: ${reason}` : '' }))
      return null
    })
    if (out) return this.refuse(card, by, 'remove from queue', out) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    return this.ok(card, s.stage, this.state(card).stage)
  }

  /** Retry merge (the user's override, or the Assistant's with a reason): requeues an unchanged revision once, even after a red check (§16.8.1). */
  async retryMerge(ref: unknown, reason = '', by: 'user' | 'assistant' = 'user', guard?: () => void, forward?: { source: string }): Promise<Reply> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const r = this.rulesetOf(card, s)
    const out = await this.write(card, r, by, (w) => {
      guard?.()
      // A forward merge (HI-2679) the queue returned: a new attempt, its source frozen again at `forward.source` (read by
      // the caller just before), each time asked; never one still queued or advancing.
      const fs = w.state()
      if (fs.forward) {
        const last = fs.entries.at(-1)
        // Returned (a conflict, a red check) or its advance declined (Ask each time, HR3's round 1): either may go again.
        if (fs.stage !== 'active' || (last?.state !== 'failed' && last?.state !== 'cancelled') || !forward?.source) return { rule: 'move.notFromHere', values: { card: card.key, stage: fs.stage, move: 'retry merge', moves: this.movesFrom(fs.stage, r, fs).join(', ') } } as GuardRefusal // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
        w.fact('Override', { rules: ['requeue.allowed'], move: 'retry merge', by, reason }) // i18n-ignore: a fact's kind and codes, not text
        this.enqueueForward(w, forward.source, 'retry')
        return null
      }
      // For a card the queue returned (Active, its last entry failed), once per revision; or one waiting in Approved
      // where Combwork merges with no entry (taken out of the queue, #1623) and no follow-up waiting: approved and unstale.
      const st = w.state()
      const last = st.entries.at(-1)
      const retries = st.entries.filter((x) => x.seq > (st.latest?.id ?? 0) && x.requeue === 'retry').length
      const returned = st.stage === 'active' && last?.state === 'failed' && retries < 1
      const waiting = st.stage === 'approved' && r.options.finish === 'combworkMerges' && !openEntry(st) && !st.step
      if (!(returned || waiting) || st.stale || notApproved(st, r, card.labels)) return { rule: 'move.notFromHere', values: { card: card.key, stage: st.stage, move: 'retry merge', moves: this.movesFrom(st.stage, r, st).join(', ') } } as GuardRefusal // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      // Past a return it skips the requeue rule; from Approved it skips nothing.
      if (returned) w.fact('Override', { rules: ['requeue.allowed'], move: 'retry merge', by, reason }) // i18n-ignore: a fact's kind and codes, not text
      this.enqueue(w, 'retry')
      return null
    })
    if (out) return this.refuse(card, by, 'retry merge', out) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    return this.ok(card, s.stage, this.state(card).stage)
  }

  /**
   * HI-2999: whether a forward's resolution (`s.resolves`) has the commit it resolves in `revision`'s history: false when
   * it doesn't (cherry-picked or copied, not merged: the next forward would conflict again), unknown when that can't be
   * read (git failed or threw, no revision, a platform with no history): never taken as either. Null for any other card.
   */
  async resolutionHasSource(o: WorkflowOptions, s: CardState, revision: string | null): Promise<Maybe<boolean> | null> {
    const res = s.resolves
    if (!res) return null
    const what = unknown(UNREADABLE.contains, { revision: res.source.slice(0, 7), target: (revision ?? '').slice(0, 7) || '?' })
    const h = historyOf(o.platform)
    if (!revision || !h) return what
    const has = await h.isAncestor(this.cfg.project, res.source, revision).catch((e: unknown) => withDetail(what, e instanceof Error ? e.message : String(e)))
    return isUnknown(has) ? { ...what, ...(has.detail ? { detail: has.detail } : {}) } : has
  }

  /**
   * HI-2959: the attempt Resolve on a builder would hand over, on a forward merge the queue returned (Active, its last
   * entry failed, or its advance declined): that entry, its frozen source and what came back; null for any other card,
   * and for one returned against the release path's direction (HI-2892: Remove from queue alone ends that).
   */
  returnedForward(card: CardRecord, s: CardState = this.state(card)): { entry: string; from: string; to: string; source: string; failed: FactData['IntegrationFailed'] | null } | null {
    const last = s.entries.at(-1)
    if (!s.forward || s.stage !== 'active' || !last || (last.state !== 'failed' && last.state !== 'cancelled')) return null
    const failed = this.store.facts(card.id).findLast((f) => f.kind === 'IntegrationFailed' && (f.data as FactData['IntegrationFailed']).entry === last.id)
    // Returned against the release path's direction (HI-2892): only Remove from queue ends it, never a builder's merge.
    if ((failed?.data as FactData['IntegrationFailed'] | undefined)?.reason === 'direction') return null
    return { entry: last.id, from: s.forward.from, to: s.forward.to, source: last.revision, failed: failed ? (failed.data as FactData['IntegrationFailed']) : null }
  }

  /**
   * HI-2959: Resolve on a builder, on a forward merge the queue returned (the user's, or the Assistant's with a reason):
   * it ends in Done, nothing merged (as Remove from queue: an override, never an `Integrated`), its comment naming
   * `resolver`, the card made for a builder in the same board change. Refused unless its last attempt is still `entry`
   * (read by the caller, which froze that attempt's source for the new card): a Retry, a Remove or another Resolve since
   * leaves it as it is.
   */
  async resolveForward(ref: unknown, d: { entry: string; resolver: string }, reason = '', by: 'user' | 'assistant' = 'user', guard?: () => void): Promise<Reply> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const r = this.rulesetOf(card, s)
    const out = await this.write(card, r, by, (w) => {
      guard?.()
      const now = w.state()
      const back = this.returnedForward(card, now)
      if (!back || back.entry !== d.entry) return { rule: 'move.notFromHere', values: { card: card.key, stage: now.stage, move: 'resolve on a builder', moves: this.movesFrom(now.stage, r, now).join(', ') } } as GuardRefusal // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      w.fact('Override', { rules: ['integrate'], move: 'resolve on a builder', by, reason }) // i18n-ignore: a fact's kind and codes, not text
      w.move('done', 'user')
      const values = { card: d.resolver, from: back.from, to: back.to, source: back.source.slice(0, 12) }
      w.action('comment', { text: stored(W.forwardResolving, values), shown: storedText(HISTORY.forwardResolving, values) })
      return null
    })
    if (out) return this.refuse(card, by, 'resolve on a builder', out) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    return this.ok(card, s.stage, this.state(card).stage)
  }

  /**
   * HI-2959: marks a card made a moment ago by Resolve on a builder (in Todo, never started) as the forward resolution
   * of `d.forward`: its `ForwardResolution`, kept over every cycle, which makes its rules merge it as a merge commit.
   */
  async markForwardResolution(ref: unknown, d: Omit<FactData['ForwardResolution'], 'by'>, by: 'user' | 'assistant', guard?: () => void): Promise<Reply> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const out = await this.write(card, null, by, (w) => {
      guard?.()
      const now = w.state()
      if (now.started || now.stage !== 'todo' || now.resolves) return { rule: 'move.notFromHere', values: { card: card.key, stage: now.stage, move: 'resolve on a builder', moves: '' } } as GuardRefusal // i18n-ignore: intent names
      w.fact('ForwardResolution', { ...d, by }) // i18n-ignore: a fact's kind and codes, not text
      return null
    })
    if (out) return this.refuse(card, by, 'resolve on a builder', out) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    return this.ok(card, s.stage, this.state(card).stage)
  }

  /**
   * HI-3040: the user's override recorded on a forward merge's resolution the queue returned for its direction, by a
   * forward request with the override for its pair (queueControls' forwardMerge, the user's or the Assistant's alone).
   * Only while, read in this write, it can take it (`overridableEntry`: back in Active for its direction, that entry its
   * latest submission's, no override yet). `d.override` none: the direction reads forward again, so only the requeue.
   * Its builder is woken to submit the same revision again, which `requeue.allowed` lets back in once. Refused
   * (`move.notFromHere`) otherwise, nothing written.
   */
  async overrideResolution(ref: unknown, d: { from: string; to: string; override?: ForwardOverride }, by: 'user' | 'assistant', guard?: () => void): Promise<Reply> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const out = await this.write(card, null, by, (w) => {
      guard?.()
      const now = w.state()
      const last = overridableEntry(now, d.from, d.to, !!d.override)
      if (!last) return { rule: 'move.notFromHere', values: { card: card.key, stage: now.stage, move: 'resolve on a builder', moves: '' } } as GuardRefusal // i18n-ignore: intent names
      w.fact('ResolutionOverride', { ...(d.override ? { override: d.override } : {}), entry: last.id, by }) // i18n-ignore: a fact's kind and codes, not text
      this.wake(w, now.started?.builder, stored(W.resolutionOverride, { card: card.key, from: d.from, to: d.to }))
      return null
    })
    if (out) return this.refuse(card, by, 'resolve on a builder', out) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    return this.ok(card, s.stage, this.state(card).stage)
  }

  /**
   * The user merged the card's branch from the Merge dialog, outside the queue (#1357, OP-13): an override, with the
   * user's reason. Nothing else: the merge is observed (§16.4.4), which cancels its queue entry and moves the card.
   */
  async mergedOutsideQueue(ref: unknown, reason = ''): Promise<void> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return
    await this.write(card, this.rulesetOf(card), 'user', (w) => {
      w.fact('Override', { rules: ['integrate'], move: 'merge outside the queue', by: 'user', reason }) // i18n-ignore: a fact's kind and codes, not text
      return null
    })
  }

  // --- None: a card's paths (§16.3.3).

  /** Edits Combwork saw through the card's agents' hooks and file locks: the pre-fill of its paths. */
  noteEdit(card: CardRecord, path: string): void {
    this.store.addPrefill(card.id, path)
    this.none.invalidate(path)
  }

  /**
   * A deliverable write the watcher saw: pre-filled for the card whose agent's turn ran alone in the folder (no other
   * agent or the user active), else left as an unclaimed change.
   */
  noteWrite(path: string, active: { agents: string[]; user: boolean }): void {
    this.none.invalidate(path)
    if (active.user || active.agents.length !== 1) return
    const card = this.store.cards().find((c) => c.stage === 'active' && this.state(c).started?.builder === active.agents[0])
    if (card) this.noteEdit(card, path)
  }

  prefill(card: CardRecord): string[] {
    return this.store.prefill(card.id)
  }

  /** declare paths (None): sets the card's paths; replies with the pre-fill, the unclaimed changes and the revision. */
  /** `commit`: a revocable caller's check (HI-2420, the Assistant's guard), made in the write, before the paths are saved. */
  async declarePaths(ref: unknown, actor: Actor, paths: string[], commit?: () => void): Promise<{ prefill: string[]; unclaimed: string[]; revision: string | null } | Refusal> {
    const card0 = this.resolve(ref, actor)
    if (isRefusal(card0)) return card0
    // A card's paths narrow the deliverables, never widen them (#1511): none under `.combwork`, `.git` or an excluded folder.
    const bad = this.excludedPath(paths)
    if (bad) return refusal('paths.excluded', { card: card0.key, ...bad }, null)
    const card = await this.locked(() => {
      commit?.()
      return this.store.updateCard(card0.id, { paths })
    })
    const rev = this.none.revision(paths)
    return { prefill: this.prefill(card), unclaimed: await this.unclaimed(card), revision: isUnknown(rev) ? null : rev.revision }
  }

  /** The first declared path under `.combwork`, `.git` or an excluded folder (#1511), with that folder; null when none is. */
  private excludedPath(paths: readonly string[]): { path: string; folder: string } | null {
    for (const path of paths) {
      const folder = this.none.excludedPart(path)
      if (folder) return { path, folder }
    }
    return null
  }

  /**
   * Deliverables changed since the card started that are in neither its paths nor its pre-fill: for it to add or leave.
   * Advisory, never written. The project is read whole off main's thread (HI-2340); after that read, the card is read
   * again from the board, and the read compared with its baseline, paths (`paths`: a submit's given ones, not stored
   * yet) and pre-fill as they are then, in the same start cycle as before it: a newer cycle (put back and started again
   * meanwhile) or a read under folders left out that changed since, read once more, and then nothing rather than a
   * misleading list. No-code cards keep no baseline: nothing.
   */
  async unclaimed(card0: CardRecord, o: { paths?: readonly string[]; signal?: AbortSignal } = {}): Promise<string[]> {
    if (this.store.card(card0.id).kind === 'no-code') return []
    for (let tries = 0; tries < 2; tries++) {
      const cycle = this.state(this.store.card(card0.id)).cycle
      const generation = this.none.generation
      const now = await readBaseline(this.none, o.signal)
      if (!now || isUnknown(now) || o.signal?.aborted) return []
      const card = this.store.card(card0.id)
      const s = this.state(card)
      if (s.cycle !== cycle || card.kind === 'no-code') return []
      if (this.none.generation !== generation) continue
      const before = this.none.covering(s.started?.deliverables ?? {})
      // Covered as a revision covers them (HI-2339): a declared folder's files are the card's.
      const mine = [...(o.paths ?? card.paths ?? []), ...this.prefill(card)]
      return NoneAdapter.diff(before, this.none.covering(now))
        .map((f) => f.path)
        .filter((p) => !this.none.covers(mine, p))
    }
    return []
  }

  /**
   * What a None code card's submission leaves out of its paths (HI-2339, §16.3.3), for its builder to add or leave: its
   * pre-fill's files the paths don't cover (paths set, none given), and the unclaimed changes. Never claimed: the
   * declared paths stay what the revision covers. Agent-facing English; empty elsewhere (Git, no-code).
   */
  private async pathNotices(card: CardRecord, o: WorkflowOptions, given: boolean, signal?: AbortSignal): Promise<string[]> {
    if (!declaresPaths(o.platform) || card.kind !== 'code') return []
    const paths = card.paths ?? []
    const out: string[] = []
    const outside = given ? [] : this.prefill(card).filter((p) => !this.none.covers(paths, p))
    if (outside.length) out.push(say(W.pathsLeaveOut, { card: card.key, files: outside.join(', ') }))
    const unclaimed = (await this.unclaimed(card, { paths, signal })).filter((p) => !outside.includes(p))
    if (unclaimed.length) out.push(say(W.unclaimed, { card: card.key, files: unclaimed.join(', ') }))
    return out
  }

  /**
   * What a None code card's submission with its paths (else its pre-fill) leaves out, counted as pathNotices counts it
   * (HI-2352), for the window's drag to ask the user: null when nothing is, or it isn't a None code card.
   */
  private async leftOutOf(card: CardRecord, o: WorkflowOptions): Promise<{ paths: string[]; files: string[] } | null> {
    if (!declaresPaths(o.platform) || card.kind !== 'code') return null
    const prefill = this.prefill(card)
    const paths = card.paths ?? prefill
    const outside = prefill.filter((p) => !this.none.covers(paths, p))
    const files = [...outside, ...(await this.unclaimed(card, { paths })).filter((p) => !outside.includes(p))]
    return files.length ? { paths, files } : null
  }

  /** A refusal with what its card's paths leave out (HI-2339): its `warnings`, passed on to the agent's reply. */
  private withNotices(r: Refusal, notices: string[]): Refusal {
    return notices.length ? { ...r, warnings: notices } : r
  }

  // --- Lanes (§16.11).

  lane(id: string): LaneList | null {
    return this.store.lane(id)
  }

  private saveLane(l: LaneList): void {
    this.store.saveLane(l)
  }

  /**
   * Starts a lane (lanes.ts's of that id, else a new one): its cards use the ruleset in force now until it ends; with a
   * `target` other than G7's (HI-2556, its Merges into), that ruleset merging into it (`targetedOf`, stored too).
   */
  startLane(id: string, cards: number[], reviewer?: string, rounds?: number, target?: string | null): LaneList {
    const r = targetedOf(this.currentRuleset(), target)
    this.store.saveRuleset(r)
    return this.store.startLane(id, cards, r.id, reviewer, rounds)
  }

  /** Changes a lane's list: never refused; queued while a card is in flight ("list changes after AM-2"). */
  changeLane(id: string, cards: number[]): { lane: LaneList; queuedAfter: string | null } {
    const l = this.lane(id)!
    const current = l.current !== null && !this.laneDone(l.current) ? l.current : null
    // A card queued is in the lane already (its queued list): it uses the lane's ruleset.
    const next = changeList({ ...l, current }, cards)
    this.saveLane(next)
    return { lane: next, queuedAfter: current !== null ? this.store.card(current).key : null }
  }

  /** A lane's card in flight: started and not Done (Active, Review, Approved or Merging), by the stage the board keeps. */
  private laneCardFlying(n: number): boolean {
    const stage = this.store.card(n).stage
    return stage === 'active' || stage === 'review' || stage === 'approved' || stage === 'merging'
  }

  /**
   * A lane's list as a start reads it (#1270; the Assistant's round 4 design, one lane state): the list now, or, once
   * none of its cards is in flight (the card boundary has passed), the queued list, which `applies` then.
   */
  laneNow(l: LaneList): { cards: number[]; applies: boolean } {
    if (!l.pending?.length || l.cards.some((c) => this.laneCardFlying(c) && this.laneOwn(l.id, c))) return { cards: l.cards, applies: false }
    return { cards: l.pending, applies: true }
  }

  /**
   * Whether a lane's card is its own (HI-1821, as lanes.ts's view reads it: boardStore's cardOwnersNow): given to its
   * builder on the board, or given to no agent and its lane (`card.lane`: the newest running lane listing it) this one.
   * Another's card is another lane's work: its lane never waits on it, and a queued list change never waits for it.
   */
  laneOwn(lane: string, n: number): boolean {
    const agent = this.store.cardAgent(n)
    return agent ? agent === this.store.laneBuilder(lane) : this.store.card(n).lane === lane
  }

  /**
   * The card this one waits for in its running lane, or null (one card at a time, #1270), from the lane's list as a start
   * reads it (laneNow): a card before it there that isn't Done. A card only in a queued list that hasn't applied (a card
   * is still in flight) is never eligible: it waits for that card, so no queued card passes an earlier one.
   */
  laneWaits(card: CardRecord): CardRecord | null {
    if (!card.lane) return null
    const l = this.lane(card.lane)
    if (!l || l.ended) return null
    const now = this.laneNow(l)
    let open: number | undefined
    // Never on another agent's card (HI-1821).
    const waitsOn = (c: number): boolean => !this.laneDone(c) && this.laneOwn(l.id, c)
    if (now.cards.includes(card.id)) open = now.cards.slice(0, now.cards.indexOf(card.id)).find(waitsOn)
    else if (l.pending?.includes(card.id)) open = l.cards.find((c) => this.laneCardFlying(c) && this.laneOwn(l.id, c)) ?? l.cards.find((c) => c !== card.id && waitsOn(c))
    return open === undefined ? null : this.store.card(open)
  }

  /**
   * Inside a start's write (its board change, #1270): a queued list whose boundary has passed is applied there, before the
   * start is checked, and the builder is told (a wake, delivered once). lanes.ts's refresh then finds nothing queued.
   */
  private applyLaneBoundary(w: Write, card: CardRecord): void {
    if (!card.lane) return
    const l = this.lane(card.lane)
    if (!l || l.ended) return
    const now = this.laneNow(l)
    if (!now.applies) return
    this.saveLane({ ...l, cards: [...now.cards], pending: null })
    const builder = this.store.laneBuilder(l.id)
    if (builder) this.wake(w, builder, stored(W.laneListChanged, { cards: now.cards.map((c) => this.store.card(c).key).join(', ') }))
  }

  /** A start refused for a card that waits in its lane (laneWaits), or null. */
  private laneRefusal(card: CardRecord): GuardRefusal | null {
    const earlier = this.laneWaits(card)
    return earlier ? { rule: 'lane.oneAtATime', values: { card: card.key, earlier: earlier.key } } : null
  }

  // --- An agent's worktree between a lane's cards (§16.19.2, #1271).

  /**
   * Whether a lane's card would start on a line that still has an earlier card's squashed work: its builder's own worktree
   * (standing in for a slot), the last card before it in the lane that was worked there and is Done, and the worktree as
   * it is now, its head not in that card's target. Null when the card isn't a lane's, its builder has no worktree, no
   * earlier card was worked there, the head is in the target (a merge commit or a fast-forward leaves it so), or the
   * folder can't be read (nothing is held up on what can't be told).
   */
  async lineBehind(card: CardRecord): Promise<LineBehind | null> {
    if (!card.lane || !this.cfg.agentFolder) return null
    const l = this.lane(card.lane)
    if (!l || l.ended) return null
    const builder = this.store.laneBuilder(l.id)
    const own = builder ? await this.cfg.agentFolder(builder) : null
    if (!builder || !own) return null
    const cards = this.laneNow(l).cards
    const at = cards.indexOf(card.id)
    const same = (a: string | undefined): boolean => !!a && a !== 'project' && resolvePath(a).toLowerCase() === resolvePath(own.path).toLowerCase()
    const prev = (at < 0 ? cards : cards.slice(0, at))
      .map((c) => this.store.card(c))
      .reverse()
      .find((c) => this.laneDone(c.id) && same(this.state(c).started?.folder))
    if (!prev) return null
    const ps = this.state(prev)
    const target = ps.started?.target
    if (!target) return null
    const p = this.platform(this.rulesetOf(prev, ps).options)
    if (!p.lineNow) return null
    const now = await p.lineNow(own.path, target)
    if (isUnknown(now)) return null
    // A move begun and not recorded as done (it failed part way, or Combwork stopped during it): held until it is settled,
    // unless the line is back where it began.
    const facts = this.store.facts(prev.id)
    // Its outcome is a fact (HR2's round 4): a head back where it began proves nothing of the files and index.
    const moving = facts.findLast((f) => f.kind === 'LineMoving')
    const begun = moving && !facts.some((f) => (f.kind === 'LineMoved' || f.kind === 'LineMoveUndone') && f.seq > moving.seq) ? (moving.data as FactData['LineMoving']) : null
    const unfinished = begun ? { from: begun.from, to: begun.to } : undefined
    if (now.inTarget && !unfinished) return null
    return { next: card, prev, builder, folder: own.path, target, ...now, ...(unfinished ? { unfinished } : {}) }
  }

  /**
   * What on the line isn't in the target (§16.19.2 step 2): nothing when the line's change since the earlier card's base
   * is in the target (the squash replays it), else the commits after what was approved there (a commit made after the
   * approval), as short ids and subjects.
   */
  async lineWorkNotIn(b: LineBehind): Promise<Maybe<string[]>> {
    const s = this.state(b.prev)
    const p = this.platform(this.rulesetOf(b.prev, s).options)
    const base = s.approved?.base ?? s.latest?.base ?? s.started?.base
    if (!base) return unknown(UNREADABLE.branchedOffTarget)
    // In the target's head the line was compared with (#1376: not read again).
    const c = asCardCounts(s, await p.contains(b.target, { base, revision: b.head, key: null }, b.targetHead))
    if (isUnknown(c)) return c
    if (c) return []
    const from = s.approved?.revision ?? base
    const list = p.commitsBetween ? await p.commitsBetween(b.folder, from, b.head) : []
    return isUnknown(list) || list.length ? list : [b.head.slice(0, 7)]
  }

  /**
   * Moves the line to the target (§16.19.2 step 3) and records it: a `LineMoved` on the card just Done, before the next
   * card's `Started` (whose base is its `to`), and the builder told. Only from the state checked (HR2's #1271 round 1):
   * the line, its head and the target's head read again, the worktree clean and `still()` (the caller's own conditions:
   * the rules on, the switch or the user's approval, the builder idle with no run, the workspace open) just before, and
   * the platform's move itself serialized with the worktree's other git work and conditional on that branch, head and
   * target, `still()` asked again at its boundary (HR2's round 2). The next card is reserved meanwhile (`lineMoving`):
   * its start is refused until the `LineMoved` is saved, and the move goes ahead only while the card is still in Todo.
   * A move whose fact can't be saved is undone the same way. Git's refusal comes back as its reason; null when anything
   * changed (nothing moved, nothing recorded: looked at again).
   */
  async moveLineOn(b: LineBehind, still: () => boolean): Promise<true | string | null> {
    const s = this.state(b.prev)
    const p = this.platform(this.rulesetOf(b.prev, s).options)
    if (!p.moveLine || !p.lineNow) return 'no line to move' // i18n-ignore: a platform with no lines (never asked: lineBehind is Git's)
    const key = this.movingKey(b.next.id)
    if (lineMoving.has(key)) return null
    lineMoving.set(key, b)
    try {
      const ok = (): boolean => this.state(b.next).stage === 'todo' && still()
      const now = await p.lineNow(b.folder, b.target)
      if (isUnknown(now) || now.line !== b.line || now.head !== b.head || now.targetHead !== b.targetHead || now.dirty.length || !ok()) return null
      const line = b.line ?? b.folder
      // Begun, durably, before anything moves (HR2's round 3): a move that doesn't finish (it fails part way and can't be
      // put back, or Combwork stops) holds the next card until it is settled.
      await this.write(b.prev, null, 'combwork', (w) => {
        w.fact('LineMoving', { line, from: b.head, to: b.targetHead }) // i18n-ignore: a fact's kind and codes, not text
        return null
      })
      const moved = await p.moveLine(b.folder, b.targetHead, { line: b.line, head: b.head, target: b.target }, ok)
      // Not made, everything as it was (the platform put it back, or never began): the move's outcome, recorded.
      if (moved !== true) {
        await this.lineMoveUndoneRecord(b, b.head)
        return moved
      }
      try {
        await this.lineMovedRecord(b, b.head, b.targetHead)
      } catch (e) {
        // Not recorded (the workspace closed, the board failing): the branch put back where it was, as conditionally.
        await p.moveLine(b.folder, b.head, { line: b.line, head: b.targetHead }, () => true)
        throw e
      }
      return true
    } finally {
      lineMoving.delete(key)
    }
  }

  /** Records a line's move as not made, everything as it was at `at` (`LineMoveUndone` on the card just Done). */
  async lineMoveUndoneRecord(b: LineBehind, at: string): Promise<void> {
    await this.write(b.prev, null, 'combwork', (w) => {
      w.fact('LineMoveUndone', { line: b.line ?? b.folder, at }) // i18n-ignore: a fact's kind and codes, not text
      return null
    })
  }

  /** Records a line's move as done (`LineMoved` on the card just Done) and tells its builder the next card can start. */
  async lineMovedRecord(b: LineBehind, from: string, to: string): Promise<void> {
    const line = b.line ?? b.folder
    await this.write(b.prev, null, 'combwork', (w) => {
      w.fact('LineMoved', { line, from, to, why: 'squashContinuation' }) // i18n-ignore: a fact's kind and codes, not text
      this.wake(w, b.builder, stored(W.squashed, { line, target: b.target, prev: b.prev.key, next: b.next.key }))
      return null
    })
  }

  /** A card as `lineMoving` keys it: its project's folder, resolved, and its number (any runtime of that project sees it). */
  private movingKey(card: number): string {
    return `${resolvePath(this.cfg.project).toLowerCase()}#${card}`
  }

  /** Asks the user about a line held up (§16.19.2): on the lane's next card, bound to the line's head, so asked once for it. */
  async askAboutLine(b: LineBehind, kind: ForYouKind, text: StoredText): Promise<void> {
    await this.write(b.next, null, 'combwork', (w) => {
      this.askUser(w, kind, LINE_GATE, text, { unbound: true, revision: b.head })
      return null
    })
  }

  /** The lane's next card, read from Combwork: one at a time, a queued change applied at the boundary. */
  laneNext(id: string): number | null {
    const { lane, card } = nextCard(this.lane(id)!, (c) => this.laneDone(c))
    this.saveLane(lane)
    return card
  }

  // --- Actions (§16.4.5).

  /** Runs pending actions in order; each checks its effect first, so running one twice delivers once. */
  async runActions(): Promise<void> {
    for (const a of this.store.pendingActions()) {
      try {
        await this.perform(a.id, a.card, a.kind, a.payload)
        this.store.markAction(a.id, 'done')
      } catch {
        this.store.markAction(a.id, 'failed')
      }
    }
  }

  private async perform(id: number, cardId: number, kind: string, payload: Record<string, unknown>): Promise<void> {
    const card = this.store.card(cardId)
    switch (kind) {
      case 'wake':
        if (this.store.deliver({ action: id, kind, target: String(payload.agent), payload })) this.cfg.effects?.wake?.(String(payload.agent), card, String(payload.why))
        return
      case 'notify':
        if (this.store.deliver({ action: id, kind, target: 'user', payload })) this.cfg.effects?.notify?.(card, String(payload.text), payload.shown as StoredText | undefined)
        return
      case 'comment':
        if (this.store.deliver({ action: id, kind, target: 'card', payload })) this.cfg.effects?.comment?.(card, String(payload.text), payload.shown as StoredText | undefined)
        return
      case 'prepareSlot':
      case 'pin':
        await this.platformOf(card).perform(kind, payload)
        return
      // A finish (HI-2014) ends its lane once all its cards are Done, as `endLaneIfDone` (written before it) still does.
      case 'finish':
      case 'endLaneIfDone': {
        if (!card.lane) return
        const l = this.lane(card.lane)
        if (!l || l.ended) return
        const cards = l.pending ?? l.cards
        if (!cards.every((c) => this.laneDone(c))) return
        const results = cards.map((c) => this.state(c).integrated?.result ?? null)
        this.saveLane({ ...l, ended: true, current: null })
        this.store.deliver({ action: id, kind: 'laneEnded', target: l.id, payload: { results } })
        return
      }
      default:
        // prepareReviewCopy, releaseSlot, enqueue: P5 and P7 build them (a finish's slot is the app's pass); the queue reads its entries from facts.
        return
    }
  }
}

export type { RuleId }
