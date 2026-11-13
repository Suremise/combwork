// The platform adapter (SPEC §16.3.1): everything the workflow asks of a version control, behind one interface, so the
// runtime, reconciliation and checks never switch on a platform id (AGENTS.md's rule for providers, for platforms).
// A platform is a descriptor (shared, `descriptors.ts`) and an adapter (here), looked up by the options' platform.
//
// P2 spike (#1118): the interface the spike proves; P3 builds it into main.

import type { PlatformId } from '../../shared/platform/descriptors'
import type { CardState, CheckRanData, FileChange, Manifest } from '../../shared/workflow/facts'
import type { GuardInputs, GuardRefusal } from '../../shared/workflow/guards'
import type { WorkflowOptions } from '../../shared/workflow/options'
import type { CardRecord } from '../workflow/factStore'
import type { ReconcileHooks } from '../workflow/reconcile'
import type { Disposable, ObserveEvent } from './observe'
import type { Containment, Maybe } from './types'
import type { TargetChanges } from '../../shared/types'

/** What a start records of the platform: the card's folder, line, base and target (None: its manifests). */
export interface StartPlan {
  folder: string
  line: string | null
  base: string | null
  target: string | null
  /** The folder is there already (an agent's own worktree standing in for a slot): nothing to prepare. */
  existing?: boolean
  /** Slots (HI-3112): the card's line from an earlier start is there already and carries on, not made from the target. */
  carried?: boolean
  /** Slots (#1438): the slot lent for it and its lease (`fresh`: lent for this start, given back if it isn't written). */
  slot?: string
  lease?: string
  fresh?: boolean
  /** Slots: none could be lent now, in English (why it waits for one): the start is refused `start.slotAvailable`. */
  slotWait?: string
  manifest?: Manifest
  deliverables?: Manifest
  /** None (HI-2340): the adapter's generation its whole-project read was made under, checked again at the write. */
  baselineGen?: number
  /** What only this platform records of the start (`Started.platform`; jj's workspace and its identity, HI-2868). */
  platform?: Record<string, unknown>
}

/** A submission's platform side: the revision with its fixed endpoints, key and files, and the guards' platform inputs. */
export type SubmitPlan =
  | { ok: true; revision: string; base: string | null; key: string | null; files: FileChange[]; commits?: string[]; paths?: string[]; inputs: Partial<GuardInputs>; warnings: string[]; platform?: Record<string, unknown> }
  | { ok: false; refusal: GuardRefusal }

/** What a finish needs from the platform, gathered before the transaction. */
export interface FinishInputs {
  /** Committed is done: the revision on the folder's line. */
  contained?: Maybe<boolean>
  /** Acceptance: the revision of the card's work now (None: its paths' hash). */
  currentRevision?: Maybe<string>
}

/** A later revision of a card's work than the one a pass was for, and whether it is the same change. */
export interface HeadMove {
  to: string
  base: string | null
  same: boolean
}

/**
 * Commits on a card's line past its submitted revision, in its folder (HI-2245): how many (`atLeast`: a lower bound, the
 * read was capped) and the submission's short id.
 */
export interface Unsubmitted {
  count: number
  atLeast: boolean
  since: string
}

/** A check run's bracket: the card's revision, what was tested, the run's result, and why it doesn't count, if not. */
/** An agent's worktree as a lane's next card finds it (lineNow). */
export interface LineNow {
  line: string | null
  head: string
  targetHead: string
  inTarget: boolean
  dirty: string[]
}

export interface CheckBracket {
  revision: string
  tested: string
  ok: boolean
  whyNot?: CheckRanData['whyNot']
}

/**
 * What a progress run for a card is for (§16.13, #1233): the card's revision now, the revision the run is tested on,
 * and a revision the run names (`--revision`) as the platform reads names (null: it names none). `tested` is a
 * `checkout` (Git: what's checked out where it runs) or the card's `content` (None: its paths' hash).
 */
export interface RunRevision {
  revision: string | null
  tested: string | null
  testedIs: 'checkout' | 'content'
  named?: string | null
}

export interface PlatformAdapter {
  readonly id: PlatformId
  /** Start (§16.7.2): where the card works and what its change starts from. */
  /** `builder`: the agent the card starts with (an agent's worktree stands in for a slot before P7, SPEC §16.19.1). */
  start(card: CardRecord, o: WorkflowOptions, builder?: string, dry?: boolean): Promise<Maybe<StartPlan>>
  /** The card's revision now (Git: its folder's head, or its newest attributed commit; None: its paths' hash). */
  revisionNow(card: CardRecord, s: CardState): Promise<Maybe<string | null>>
  /** A progress run's revisions for the card, run in `folder` (null: none given), resolving `named` if given (§16.13). */
  runRevision(card: CardRecord, s: CardState, folder: string | null, named: string | null): Promise<RunRevision>
  /** Submit's platform side; a refusal for an empty change, a wrong revision or what couldn't be read. */
  /**
   * `predicted`: `s` is the state a start not written yet would leave (a drag planning its steps, #1265): read the
   * folder only, reconcile and write nothing, and take the card's state as given.
   */
  submission(card: CardRecord, s: CardState, o: WorkflowOptions, args: { revision?: string; agent: string | null; guards: readonly string[]; predicted?: boolean }): Promise<SubmitPlan>
  /** What a finish needs (§16.7.2's Finish table). */
  finishInputs(card: CardRecord, s: CardState, o: WorkflowOptions, revision: string | null | undefined): Promise<FinishInputs>
  /** The card's work moved on since `from` (a pass's revision): to what, and is it the same change (§16.3.2)? */
  headMoved(card: CardRecord, s: CardState, o: WorkflowOptions, from: { base: string | null; revision: string; key?: string | null }): Promise<HeadMove | null>
  /**
   * Is a change in a target (containment, §16.3.1)? None: never by containment (acceptance is recorded). `at`: the
   * target's head as the caller just read it, asked about as it is.
   */
  contains(target: string, change: { base: string; revision: string; key?: string | null }, at?: string): Promise<Maybe<Containment | null>>
  /** A target's head now, for a recorded integration's result. */
  targetHead(target: string): Promise<Maybe<string | null>>
  /**
   * An agent's worktree between a lane's cards (§16.19.2, #1271; Git only): its line, its head, the target's head, whether
   * the head is in the target (an ancestor of it), and its uncommitted files.
   */
  lineNow?(folder: string, target: string): Promise<Maybe<LineNow>>
  /**
   * HI-2944: the folder a target is checked out in and its uncommitted files, for a start's warning (Git only; absent:
   * no such folder). Null: checked out nowhere, clean, or unreadable (a warning, never a refusal).
   */
  targetChanges?(target: string): Promise<TargetChanges | null>
  /**
   * Moves an agent's worktree's line to `to` (Git: `reset --keep`, which refuses to overwrite a local change), only from
   * `expect` (its line and head as checked): true; git's reason; or null when the line changed since (nothing moved).
   */
  moveLine?(folder: string, to: string, expect: { line: string | null; head: string; target?: string }, go: () => boolean): Promise<true | string | null>
  /**
   * Commits on the card's line past `submitted` in its folder as checked out there (HI-2245; Git only), committed only;
   * null where that can't be proven. `between` runs after the history is read, before the folder is read again (a seam).
   */
  unsubmitted?(card: CardRecord, s: CardState, submitted: string, between?: () => void | Promise<void>): Promise<Unsubmitted | null>
  /** The commits on a line from `from` (exclusive) to `to`, oldest first, as short ids and subjects. */
  commitsBetween?(folder: string, from: string, to: string): Promise<Maybe<string[]>>
  /** Reconciles a card with the platform (§16.4.4). */
  reconcile(card: CardRecord, hooks: ReconcileHooks): Promise<void>
  /** Runs a check and brackets it (§16.13). */
  checkRun(card: CardRecord, s: CardState, run: { command: string | undefined; revision?: string; isolated?: string; exec: (command: string, folder: string) => Promise<{ ok: boolean }> }): Promise<CheckBracket | GuardRefusal>
  /** A platform's durable action (a card's folder, a pin): false when the kind isn't this platform's. */
  perform(kind: string, payload: Record<string, unknown>): Promise<boolean>
  /**
   * The evidence an intent decides on, as a fingerprint read synchronously, with no process: Git, the target's and
   * line's refs, the card folder's own HEAD, its index, an operation under way and every tracked file and folder it
   * covers (the agent's own paths in a shared folder); None, its paths' hash. Read before the slow reads and again
   * inside the transaction: if it changed, or can't be read (null), the intent is refused, never written on stale
   * evidence. `prime` does the slow part once per intent (the git folders, the tracked files) and hands it on; for a
   * start, `builder` (the agent it is started for) decides its target as the start's plan does (#1401).
   */
  prime(card: CardRecord, s: CardState, o: WorkflowOptions, builder?: string): Promise<unknown>
  /**
   * Whether a start's plan is on what `prime` covered (#1401): the plan resolves its target again after the evidence was
   * taken, and a target that changed meanwhile (the builder worktree's base, say) isn't in the fingerprint. False: the
   * start is refused as evidence that changed.
   */
  planCovered(primed: unknown, plan: StartPlan): boolean
  /**
   * The target a start of the card for `builder` would record under `o`, by the start's own rule (HI-2674: what a change of
   * the target says a running lane's cards still to start keep). Absent: a platform with no targets.
   */
  startTarget?(card: CardRecord, o: WorkflowOptions, builder?: string): Promise<Maybe<string | null>>
  evidence(card: CardRecord, s: CardState, o: WorkflowOptions, primed: unknown): string | null
  /**
   * The platform's own answer about the same evidence, by content (#1206), read with processes (never in the
   * transaction): when the fingerprint moved, the same answer means the content didn't (Git: an index's stat data
   * refreshed, a file touched), and the runtime decides on the fingerprint now. Null where the fingerprint is already
   * content (None) or the platform can't say.
   */
  content(card: CardRecord, s: CardState, o: WorkflowOptions, primed: unknown): Promise<string | null>
  /**
   * How many times a start is gathered again from the top while only its fingerprint moved and its answer by content
   * didn't (`content`), each pass reading everything afresh; absent: once (#1206's rule for every intent). jj's
   * (HI-2916): any jj operation, Combwork's own included (a slot made, another detached), moves the head its fingerprint
   * keeps, so a start beside them needs a few passes. Spent, the start is refused as evidence that changed.
   */
  readonly startGathers?: number
  /** A check copy at the card's revision (§16.13 `--isolated`), or null where the platform has no isolation (None). */
  checkCopy(card: CardRecord, s: CardState, folder: string): Promise<string | null>
  /** The project's changes outside an intent (§16.3.1 observe), from the watcher (observe.ts), until disposed. */
  observe(onChange: (e: ObserveEvent) => void): Disposable
  /**
   * Once per reconciliation run of the project, after its cards (HI-2882, jj's): the platform's own passes (jj's publish
   * observations and retained bundles). `more`: work remains for a continuation run. Absent: nothing.
   */
  afterRun?(signal?: AbortSignal): Promise<{ more: boolean }>
  /**
   * Something its repository watch says may have changed, or its tick (HI-2882): `what` as the watch names it. Whether a
   * reconciliation run is wanted for it. Absent: always.
   */
  invalidated?(what: string): Promise<boolean>
}
