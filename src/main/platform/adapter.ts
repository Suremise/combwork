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

/** What a start records of the platform: the card's folder, line, base and target (None: its manifests). */
export interface StartPlan {
  folder: string
  line: string | null
  base: string | null
  target: string | null
  /** The folder is there already (an agent's own worktree standing in for a slot): nothing to prepare. */
  existing?: boolean
  manifest?: Manifest
  deliverables?: Manifest
}

/** A submission's platform side: the revision with its fixed endpoints, key and files, and the guards' platform inputs. */
export type SubmitPlan =
  | { ok: true; revision: string; base: string | null; key: string | null; files: FileChange[]; commits?: string[]; paths?: string[]; inputs: Partial<GuardInputs>; warnings: string[] }
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

/** A check run's bracket: the card's revision, what was tested, the run's result, and why it doesn't count, if not. */
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
  start(card: CardRecord, o: WorkflowOptions, builder?: string): Promise<Maybe<StartPlan>>
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
  /** Is a change in a target (containment, §16.3.1)? None: never by containment (acceptance is recorded). */
  contains(target: string, change: { base: string; revision: string; key?: string | null }): Promise<Maybe<Containment | null>>
  /** A target's head now, for a recorded integration's result. */
  targetHead(target: string): Promise<Maybe<string | null>>
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
   * evidence. `prime` does the slow part once per intent (the git folders, the tracked files) and hands it on.
   */
  prime(card: CardRecord, s: CardState, o: WorkflowOptions): Promise<unknown>
  evidence(card: CardRecord, s: CardState, o: WorkflowOptions, primed: unknown): string | null
  /**
   * The platform's own answer about the same evidence, by content (#1206), read with processes (never in the
   * transaction): when the fingerprint moved, the same answer means the content didn't (Git: an index's stat data
   * refreshed, a file touched), and the runtime decides on the fingerprint now. Null where the fingerprint is already
   * content (None) or the platform can't say.
   */
  content(card: CardRecord, s: CardState, o: WorkflowOptions, primed: unknown): Promise<string | null>
  /** A check copy at the card's revision (§16.13 `--isolated`), or null where the platform has no isolation (None). */
  checkCopy(card: CardRecord, s: CardState, folder: string): Promise<string | null>
  /** The project's changes outside an intent (§16.3.1 observe), from the watcher (observe.ts), until disposed. */
  observe(onChange: (e: ObserveEvent) => void): Disposable
}
