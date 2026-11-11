// jj's workflow adapter (HI-2799's J6, filled in by HI-2868's J9b1, design HI-2868/s7–s19): what the runtime asks of a jj
// project's cards, through Review and its reconciliation to Integrated (J9b2). On for real cards since J9e (HI-2874),
// which retired the start guard J6 put in every jj ruleset.
//
// Decision A (HI-2794) throughout: nothing here makes or moves a bookmark, or pushes. Its only writes are J9a's owned slot
// writes (through the pool, never here), J3's boundary snapshots, and create-only `refs/cw/cards/…` pins in the Git store.
//
// - Start: a code card in a slot (jj needs slots), on its target bookmark's head (J5's jjTargetHead), its line J9a's key
//   `jj:<workspace>/<card>.<ordinal>`; a restart of the same card in the same slot, on the same target, carries its base.
// - Submission: J3's boundary (the snapshot under the store's lock, the lease its owner); `@` empty on one parent P, P
//   from the slot's binding's base, the chain over it neither divergent nor conflicted and no other card's (J3's
//   attribution over every card's recorded ids, the whole chain); its endpoints fixed on the Git store; the chain recorded
//   as the card's provenance (`platform.jj.chain`). The final fence is the evidence, read again in the Submitted write.
// - Checks: J3's bracket (B1, the run, B2, the credit) in one call. No check copies (`checkCopies`): `--isolated` refused.
// - Containment: typed unknown in J9b1 (J9b2's proof decides); reconciliation and observation are J9b2's.

import { boundaryOf } from './repoBoundary'
import { gitAbove } from '../vcsDetect'
import { statSync } from 'original-fs'
import { join } from 'path'
import type { CardState } from '../../shared/workflow/facts'
import type { GuardInputs, GuardRefusal } from '../../shared/workflow/guards'
import type { WorkflowOptions } from '../../shared/workflow/options'
import { UNREADABLE } from '../../shared/workflow/texts'
import type { CardRecord } from '../workflow/factStore'
import type { ReconcileHooks } from '../workflow/reconcile'
import type { Workflow } from '../workflow/runtime'
import type { CheckBracket, FinishInputs, HeadMove, PlatformAdapter, RunRevision, StartPlan, SubmitPlan } from './adapter'
import type { HistoryPort } from './history'
import { historyFor, observePort } from './historyPorts'
import type { Disposable, ObserveEvent } from './observe'
import { isUnknown, unknown, withDetail, type Containment, type Maybe, type Unknown } from './types'
import { agentMsg, say } from '../../shared/agentText'
import { jjAttribute, type JjAttribution } from './jjAttribution'
import { jjBoundary, isRefused as boundaryRefused, type Owner, type StoreLock } from './jjBoundary'
import { jjCheckEnd, jjCheckStart, jjCredit, jjSameRevision } from './jjChecks'
import { jjContextOf, type JjContext } from './jjDetect'
import { jjChainOf, jjIntegratedPlatform, jjPlatform, recordedIds, type JjChainEntry, type JjIntegratedIds } from './jjFacts'
import { ensureRetained, isRefused as integrationRefused, jjContains, jjTargetHead, observePublish, type JjBundle, type JjIntegrationDeps, type PublishObserved, type PublishTailInput } from './jjIntegration'
import { jjUnknown } from './jjReads'
import { anyRetainedDue, dueRetained, markRetainedDue, publishTargets, recordIntegration, retainedVisited, sqlObligations, type SqlDb } from './jjObligations'
import { folderIdentity, type PublishCommitAnswer, type PublishCommitRequest } from './jjPublishCommit'
import { candidateFingerprint, candidateKey, candidateShown, checksAgain, clearEndedCycle, cycleOver, publishCandidateChecks, reconcileJj, type JjChecksUpdate } from '../workflow/reconcile'
import { checksJournalKey, checksKeyOf, readChecksJournal, runCandidateChecks, writeChecksJournal, type CandidateChecksDeps, type ChecksJournal } from '../workflow/jjCandidateChecks'
import { jjCandidateEntry } from '../workflow/jjCandidateReturn'
import type { Spawn } from '../workflow/queueChecks'
import type { CheckContext, CheckResult } from '../workflow/mergeQueue'
import type { CheckWhyNot } from '../../shared/types'
import type { FactData } from '../../shared/workflow/facts'
import { CW_RUNS } from '../progress'
import { createLogger, userText } from '../logger'
import { mergeMessage, updateMessage } from '../workflow/mergeMessage'
import { jjCandidateNow, type JjCandidateDeps } from './jjCandidates'
import { cleanCycle, cycleLive, readAttemptsValue, jjCandidateStep, sameFingerprint, type JjCandidateOffer, type JjAttemptEntry, type JjCandidateFingerprint, type JjCandidateStep } from './jjCandidateStep'
import { randomUUID } from 'crypto'
import { isJjUnknown, JjReads, parseCommitLine, type JjCommit } from './jjReads'
import { jjRunner, storeGatedHistory, type JjRunner } from './jjRunner'
import { jjLineKey } from './jjSlotPrep'
import { readCheckout, singleHead, viewNow } from './jjView'
import type { JjWorkspacePort } from './jjWorkspacePort'

/** What jj's adapter can't answer, for agents and the log (the start's guard words it for the window first). */
const NOT_YET_TEXT = agentMsg({ id: 'workflow.jj.notYet', text: "a jj project's card work (not enabled yet)", note: "HI-2799: what Combwork couldn't read for a card of a project using jj: its card work isn't enabled yet." })
const notYet = (): Unknown => ({ unknown: true, what: say(NOT_YET_TEXT) })
/** HI-2868: containment, decided by J9b2's proof; until then typed unknown, never a guess either way. */
const CONTAINMENT_TEXT = agentMsg({ id: 'workflow.jj.containment', text: "whether a jj card's change is in its target (decided by jj's integration proof, not enabled yet)", note: "HI-2868: what Combwork couldn't read for a jj project's card: containment in its target is decided by a later card's proof." })

/** Why a jj start couldn't be planned (HI-2868): the detail of its unknown, for agents and the log. */
const START_TEXT = {
  slots: agentMsg({ id: 'workflow.jj.start.slots', text: 'jj cards work in slots', note: 'HI-2868: why a jj card could not start: the project does not give cards slots.' }),
  target: agentMsg({ id: 'workflow.jj.start.target', text: 'a jj project needs a target bookmark (Work merges into)', note: 'HI-2868: why a jj card could not start: no target bookmark is set. Work merges into is a name in the window.' }),
  noSlot: agentMsg({ id: 'workflow.jj.start.noSlot', text: 'no slot for its builder', note: 'HI-2868: why a jj card could not start: its builder was lent no slot.' }),
  notWorkspace: agentMsg({ id: 'workflow.jj.start.notWorkspace', text: 'the slot is not a jj workspace Combwork made', note: 'HI-2868: why a jj card could not start: its slot folder is not a workspace Combwork made.' }),
  inGit: agentMsg({ id: 'workflow.jj.start.inGit', text: 'the slot is inside the Git repository at {root}, which git commands in it would reach', note: 'HI-2896: why a jj card could not start: its slot of a jj repository not colocated with Git is inside a Git working tree ({root}, made or moved there after the switch).' }),
  carryTarget: agentMsg({ id: 'workflow.jj.start.carryTarget', text: 'its earlier work is in slot {slot} on {target}', note: 'HI-2868: why a restarted jj card could not start: its earlier work is still in its slot, on another target bookmark. {slot} is the slot name, {target} the bookmark.' })
}

/** The commit fields a chain read asks for, as jjReads' commit lines. */
const COMMIT_TEMPLATE = 'commit_id ++ "\\t" ++ change_id ++ "\\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\t" ++ empty ++ "\\t" ++ divergent ++ "\\t" ++ conflict ++ "\\n"'
/** The most commits a submission's chain holds (more is refused, never cut). */
export const CHAIN_MAX = 500
/** A commit id an agent can name: hex, at least 7 characters (as Git's). */
const COMMIT_PREFIX = /^[0-9a-f]{7,40}$/
const ZERO_OID = '0000000000000000000000000000000000000000'

/** The slot a jj submission was made from (`Submitted.platform.jjSlot`, HR2's round 1): its folder, line key and binding. */
export interface JjSubmittedSlot {
  folder: string
  key: string
  store: string
  workspace: string
  generation: string
}

/** A submission's slot from its fact, or null when it has none (a fact from before) or any field isn't a string. */
export function jjSubmittedSlotOf(platform: unknown): JjSubmittedSlot | null {
  const v = platform && typeof platform === 'object' ? (platform as { jjSlot?: unknown }).jjSlot : null
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const keys = ['folder', 'key', 'store', 'workspace', 'generation'] as const
  return keys.every((k) => typeof o[k] === 'string' && (o[k] as string).length) ? { folder: o.folder as string, key: o.key as string, store: o.store as string, workspace: o.workspace as string, generation: o.generation as string } : null
}

/** A pin's ownership record (HI-2868/s13 §2), board_meta `jj_pin:<ref>`. */
export interface JjPinRecord {
  seq: number
  revision: string
  phase: 'creating' | 'created' | 'held'
  /** Whether Combwork made the ref: only `true` may ever be reclaimed (J9b2's, later). */
  owned?: true | false | 'uncertain'
}

/** What jj's adapter needs beside jj, composed by the app (jjCards.ts): never imported from an app module. */
export interface JjCardDeps {
  runner?: JjRunner
  /** J9a's registered jj workspace port (slots and copies), null while none is. */
  port: () => JjWorkspacePort | null
  /** The store's repository lock (one store, one lock). */
  lock: (store: string) => StoreLock
  /** `git --git-dir <store> <args>`. */
  git: (store: string, args: readonly string[]) => Promise<{ ok: boolean; out: string; err: string }>
  /** J5's reads for the project (its control workspace), null while they can't be made. */
  integration: () => Promise<JjIntegrationDeps | null>
  /**
   * The card's lease and slot as rows say now, synchronously (read in the write under way, HR2's round 1): `held` only
   * while the lease is open, on the card's slot, its builder's and (a card lease) this card's, with no operation or job in
   * the slot and no writer but its builder's under this lease; `print` what was read, for the evidence. Null when gone.
   */
  slotHold: (lease: string, expect: { slot: string; agent: string; card: number }) => { held: boolean; print: string } | null
  /** A pin's ownership record, read synchronously, and written. */
  pins: { read(ref: string): JjPinRecord | null; write(ref: string, rec: JjPinRecord): Promise<void> }
  /** The Git store's history (Git's port, asked on the store's own folder). */
  history?: HistoryPort
  /** HI-2871, tests only: where a candidate attempt pauses (J4's points), so a race can be placed exactly there. */
  candidateHook?: JjCandidateDeps['hook']
  /**
   * HI-2938: the app's side of the merge checks on a candidate: the project's setup command, a check copy leased at a
   * revision with its job's spawn (and whether a lease is freed through the pool's barrier), the queue's runner and
   * install, and whether Stop ended a run. Absent: no checks run (a candidate is offered after its conflict check).
   */
  candidateChecks?: JjChecksHost
  /**
   * J9b2's (HI-2882): the project's canonical id (its rows' scope), the workspace database's file, a synchronous read and
   * an async write on it (the board's connections), a card and cycle's journalled bundles, and a publish commit sent to
   * the publish worker with its own cancel fence. Absent: nothing reconciled to Integrated, nothing observed.
   */
  records?: {
    projectId: () => string
    dbFile: () => string
    read: <T>(fn: (db: SqlDb) => T) => T
    write: (fn: (db: SqlDb) => void) => Promise<void>
    bundles: (card: string, cycle: number) => JjBundle[]
    publish: (req: PublishCommitRequest) => { answer: Promise<PublishCommitAnswer>; cancel(): void }
    /** HI-2871: a card and cycle's journalled candidate attempts, as stored now. Absent: no candidate is built. */
    attempts?: (card: string, cycle: number) => JjAttemptEntry[]
    /** HI-2871: an attempt's entry stored (merged by its attempt, in one write), durable before it resolves. */
    saveAttempt?: (card: string, cycle: number, e: JjAttemptEntry) => Promise<void>
  }
}

/**
 * A candidate's description on one line, its first (HI-2871): J4 reads its writes back from jj's operation log a line
 * each, and a description's newline in the command's arguments makes that read malformed (probed on 0.47.1). Which card
 * a candidate was is its attempt's record and the Integrated fact, never its message.
 */
const oneLine = (m: string): string => m.split(/\r?\n/)[0].trim()

/** A replay on the store that couldn't be read, mid-attempt (HI-2871): the step's answer is unknown, never "not the same". */
class SamenessUnread extends Error {}

const checksLog = createLogger('jj')

/** HI-2938: what the app gives the candidate checks (jjCards.ts). */
export interface JjChecksHost {
  /**
   * The project's setup command, and a stamp of where it was read from (project.json's identity: its id, size and time),
   * which `setupStamp` reads again synchronously in a publishing transaction (HR1's round 1 finding 3).
   */
  setup(): Promise<{ setup: string; stamp: string }>
  setupStamp(): string
  lease(card: number, revision: string): Promise<{ id: string; folder: string; spawn: Spawn; give(why: string, end?: boolean): Promise<void> } | { wait: string } | { refused: string }>
  /**
   * HI-2950: the free check copies still at a candidate's commit moved onto the head it was built on, so it can be dropped
   * (a working copy on it would keep it): whether none is left there (one leased or returning: later).
   */
  parkCopies?(at: string, to: string): Promise<boolean>
  leaseFreed(id: string): Promise<boolean>
  runCheck(name: string, command: string, folder: string, ctx: CheckContext, spawn: Spawn): Promise<CheckResult>
  install(folder: string, ctx: CheckContext, spawn: Spawn): Promise<CheckResult & { skipped?: boolean }>
  stopped(run: string): boolean
  hook?: CandidateChecksDeps['hook']
  /** How often a running command's validity is read again (tests: shorter than the default). */
  watchMs?: number
  /** How long the runner waits before looking again: a copy wait (0), the nth transient failure in a row. */
  againMs?: (misses: number) => number
  /** The workspace's life (s11 §3): closing it ends a running check's job and gives its lease back; nothing more runs. */
  signal?: AbortSignal
}

/** HI-2950: each workflow's per-card locks (the candidate step and an ended cycle's clean-up), and its sweep's state. */
const cardLocks = new WeakMap<Workflow, Map<number, Promise<unknown>>>()
/**
 * Each workflow's sweep (HI-2950, HR2's round 3): `pass`, whether the pass under way has left anything unresolved so far
 * (all its pages, reset as a new pass begins); `last`, what the last finished pass left (kept for the tick's retries).
 */
const sweeps = new WeakMap<Workflow, { pass: boolean; last: boolean }>()
/** Ended cycles cleaned up per sweep, at most. */
export const SWEEP_PAGE = 8
/** Journals read per sweep, at most (HR1's round 1, finding 2): the selection bounded, not only the clean-up. */
export const SWEEP_SCAN = 32

/** HI-2938: each workflow's checks runner: one look at a time, another asked for mid-look runs after it. */
interface ChecksRunner {
  busy: boolean
  again: boolean
  timer: NodeJS.Timeout | null
}
const runners = new WeakMap<Workflow, ChecksRunner>()

/** The retention pass's page and how often each retained bundle is verified again (HI-2882/s13 §2). */
export const RETAIN_PAGE = 8
export const RETAIN_EVERY_MS = 6 * 60 * 60 * 1000

/** A jj refusal of a card's move, worded by its code (`platform.jjRefused`). */
type JjWhy = 'tooLarge' | 'mergeWorkingCopy' | 'notFromBase' | 'otherCard' | 'divergent' | 'conflicted' | 'isolated' | 'tooLong' | 'unbound'

/** What prime reads for the evidence: a started card's slot (its view, lease and binding), or a Todo card's target. */
interface Primed {
  view: JjContext | null
  folder: string | null
  lease: string | null
  /** Who the lease must be for: its slot, its builder, the card. */
  holder: { slot: string; agent: string; card: number } | null
  target: string | null
  /** The project's own view, for a card not started (its operation heads, its store's refs). */
  project: JjContext | null
}

/** A folder's generation, synchronously: its and its `.jj`'s file ids and birth times (J2's generation's basis). */
function generationSync(folder: string): string {
  try {
    const a = statSync(folder)
    const b = statSync(join(folder, '.jj'))
    return `${a.ino}:${a.birthtimeMs}:${b.ino}:${b.birthtimeMs}`
  } catch {
    return 'gone'
  }
}

/** A ref's object id read from the store's files (loose, then packed), synchronously; null where they don't say. */
function refSync(H: HistoryPort, store: string, ref: string): string {
  return H.refSync(store, ref) ?? ''
}

export class JjPlatform implements PlatformAdapter {
  readonly id = 'jj' as const
  /**
   * A start gathered again up to three times while only the operation head moved (HI-2916, HR1's answer on its s12): the
   * head stays in the evidence (it witnesses jj's whole view of the target, not only its exported ref), and Combwork's own
   * jj operations beside a start (a slot made, another detached) move it.
   */
  readonly startGathers = 3

  constructor(private readonly wf?: Workflow) {}

  private get deps(): JjCardDeps | null {
    return this.wf?.cfg.jj ?? null
  }

  private get H(): HistoryPort {
    return this.deps?.history ?? storeGatedHistory(historyFor('git'))
  }

  private runner(): JjRunner {
    return this.deps?.runner ?? jjRunner
  }

  private async ctxOf(folder: string): Promise<JjContext | null> {
    const d = await jjContextOf(folder, this.runner()).catch(() => null)
    return d && 'jj' in d ? d.jj : null
  }

  private refused(card: CardRecord, why: JjWhy, values: Record<string, string | number> = {}): GuardRefusal {
    return { rule: 'platform.jjRefused', values: { card: card.key, why, ...values } }
  }

  private unknownRefusal(card: CardRecord, what: Unknown, rule: string): GuardRefusal {
    return { rule: 'platform.unknown', values: { card: card.key, what: what.whatText ?? what.what, rule } }
  }

  /** Who a started card's lease must be for: its slot, its builder and the card (null: it started without a slot). */
  private holderOf(card: CardRecord, s: CardState): { slot: string; agent: string; card: number } | null {
    return s.started?.slot && s.started.builder ? { slot: s.started.slot, agent: s.started.builder, card: card.id } : null
  }

  /** The lease's hold as the evidence prints it: what was read, and whether it holds. */
  private holdPrint(lease: string | null, holder: { slot: string; agent: string; card: number } | null): string {
    if (!lease || !holder || !this.deps) return '-'
    const h = this.deps.slotHold(lease, holder)
    return h ? `${h.held ? 'held' : 'not'}:${h.print}` : 'gone'
  }

  /**
   * The card's owner for J3's boundaries (HR2's round 1): held at entry (else null: refused before anything is read),
   * then still held and unchanged at every await; `alsoStage` the card still in the stage it was in.
   */
  private ownerOf(card: CardRecord, s: CardState, alsoStage: boolean): Owner | null {
    const d = this.deps
    const lease = s.started?.lease ?? null
    const holder = this.holderOf(card, s)
    if (!d || !lease || !holder) return null
    const first = d.slotHold(lease, holder)
    if (!first?.held) return null
    return {
      still: () => {
        const now = d.slotHold(lease, holder)
        return !!now?.held && now.print === first.print && (!alsoStage || this.wf!.store.card(card.id).stage === s.stage)
      }
    }
  }

  /** The card's own keys, from its Started facts (every cycle's). */
  private ownKeys(card: CardRecord): Set<string> {
    const out = new Set<string>()
    for (const f of this.wf!.store.facts(card.id)) if (f.kind === 'Started' && typeof (f.data as { line?: unknown }).line === 'string') out.add((f.data as { line: string }).line)
    return out
  }

  /** The card's start ordinal for its next start: one more than its Started and Adopted facts (HI-2868/s10 §3). */
  private nextOrdinal(card: CardRecord): number {
    return 1 + this.wf!.store.facts(card.id).filter((f) => f.kind === 'Started' || f.kind === 'Adopted').length
  }

  async startTarget(card: CardRecord, o: WorkflowOptions): Promise<Maybe<string | null>> {
    return card.target || o.target || null
  }

  async start(card: CardRecord, o: WorkflowOptions, builder?: string, dry = false): Promise<Maybe<StartPlan>> {
    const d = this.deps
    if (!this.wf || !d) return notYet()
    const target = card.target || o.target || null
    // A no-code card changes nothing: it starts where its agent is, with no line (as under Git).
    if (card.kind === 'no-code') return { folder: 'project', line: null, base: null, target }
    if (o.folder !== 'slots' || !this.wf.cfg.slotFor) return withDetail(unknown(UNREADABLE.folderFor, { branch: card.key }), say(START_TEXT.slots))
    if (!target) return withDetail(unknown(UNREADABLE.target, { target: '' }), say(START_TEXT.target))
    const got = builder ? await this.wf.cfg.slotFor(card, builder, { dry, target }) : null
    if (!got) return withDetail(unknown(UNREADABLE.folderFor, { branch: card.key }), say(START_TEXT.noSlot))
    if ('wait' in got) return { folder: 'project', line: null, base: null, target, slotWait: got.wait }
    const port = d.port()
    const identity = port ? await port.identity!(got.folder) : null
    if (!port || !identity) return withDetail(unknown(UNREADABLE.worktrees, { folder: got.folder }), say(START_TEXT.notWorkspace))
    // Not colocated (HI-2896): a Git working tree above the slot, made or moved there after the switch, refuses the start.
    const bound = await boundaryOf(got.folder)
    const outer = 'jj' in bound ? gitAbove(got.folder) : null
    if (outer || 'unknown' in bound) return withDetail(unknown(UNREADABLE.worktrees, { folder: got.folder }), outer ? say(START_TEXT.inGit, { root: outer }) : say(START_TEXT.notWorkspace))
    const integ = await d.integration()
    if (!integ) return notYet()
    const th = await jjTargetHead(integ, target)
    if (isJjUnknown(th) || integrationRefused(th) || !th) return withDetail(unknown(UNREADABLE.target, { target }), th ? (integrationRefused(th) ? th.refused : th.jjUnknown) : 'none')
    const key = jjLineKey(identity.workspace, card.id, this.nextOrdinal(card))
    // A restart of the same card in its own slot carries its work and its base (s10 §3); on another target it is refused.
    const b = await port.binding(got.folder)
    if (isUnknown(b)) return b
    let base = th.head
    if (b && b.card === card.id && b.key && b.generation === identity.generation && this.ownKeys(card).has(b.key)) {
      if (b.target !== target) return withDetail(unknown(UNREADABLE.target, { target }), say(START_TEXT.carryTarget, { slot: got.slot, target: b.target ?? '?' }))
      base = b.base
    }
    return { folder: got.folder, line: key, base, target, slot: got.slot, lease: got.lease, fresh: got.fresh, platform: { jj: { workspace: identity.workspace, store: identity.store, generation: identity.generation } } }
  }

  planCovered(primed: unknown, plan: StartPlan): boolean {
    const p = primed as Primed | null
    return !p || p.view !== null || p.target === plan.target
  }

  async prime(card: CardRecord, s: CardState, o: WorkflowOptions): Promise<unknown> {
    if (!this.wf) return null
    if (!s.started || s.stage === 'todo') return { view: null, folder: null, lease: null, holder: null, target: card.target || o.target || null, project: await this.ctxOf(this.wf.cfg.project) } satisfies Primed
    const folder = this.wf.folderOf(s)
    return { view: s.started.line ? await this.ctxOf(folder) : null, folder, lease: s.started.lease ?? null, holder: this.holderOf(card, s), target: s.started.target ?? null, project: null } satisfies Primed
  }

  /**
   * The state an intent decided on, synchronously (HI-2868/s10 §2, s13 §1, s19): the project's provenance epoch and the
   * card's cycle; a Todo card's target bookmark and the operation heads; a started card's slot (J3's view: the single
   * head, its workspace's name, a colocated workspace's Git state), its folder's generation, its binding, its lease and
   * slot rows, and its target's ref. Read before the intent's reads and again in its write: any change refuses it.
   */
  evidence(card: CardRecord, s: CardState, _o: WorkflowOptions, primed: unknown): string | null {
    const p = primed as Primed | null
    const d = this.deps
    if (!p || !this.wf || !d) return null
    const parts = [`epoch:${this.wf.store.provenanceEpoch()}`, `cycle:${s.cycle}`, `stage:${s.stage}`]
    if (!p.view) {
      if (!p.project) return null
      const head = singleHead(p.project.jjRepo)
      if (!head) return null
      parts.push(`head:${head}`, p.target ? `target:${refSync(this.H, p.project.store, `refs/heads/${p.target}`)}` : '')
      return parts.join('|')
    }
    // J3's view without the checkout record's operation: a snapshot that records nothing (the boundary's own, after
    // another workspace's operation) moves only that, never the single head, which any jj operation moves.
    const now = viewNow(p.view)
    if (!now || !p.folder) return null
    const fp = `jj|${now.head}|${now.checkout.workspace}|${now.git ?? ''}`
    const co = readCheckout(p.view.workspace)
    const ptr = co && d.port() ? d.port()!.pointerSync(p.view.store, co.workspace) : null
    parts.push(fp, `gen:${generationSync(p.folder)}`, `ptr:${ptr === 'unreadable' ? 'unreadable' : ptr ? `${ptr.prep}:${ptr.key}:${ptr.generation}` : '-'}`, `slot:${this.holdPrint(p.lease, p.holder)}`)
    if (p.target) parts.push(`target:${refSync(this.H, p.view.store, `refs/heads/${p.target}`)}`)
    return parts.join('|')
  }

  /**
   * The same evidence without the provenance epoch (#1206's content answer): when only the epoch moved (another card's
   * submission or adoption meanwhile), the runtime gathers the intent again once, so its attribution is read afresh
   * against the new provenance; anything else that moved refuses it.
   */
  async content(card: CardRecord, s: CardState, o: WorkflowOptions, primed: unknown): Promise<string | null> {
    const e = this.evidence(card, s, o, primed)
    if (e === null) return null
    const parts = e.split('|').filter((x) => !x.startsWith('epoch:'))
    // A card not started yet (HI-2887, HB6's proof): its start itself makes jj workspaces (the control's, its slot's),
    // each a jj operation, so the single head moves under it. Leaving the head out here, only that start's own move
    // gathers it once more (its slot now there, nothing made again); a target that moved is read afresh by that pass.
    const p = primed as Primed | null
    if (p?.view === null) return parts.filter((x) => !x.startsWith('head:')).join('|')
    // A started card (HI-2890): any jj operation moves the single head, another workspace's or a read's snapshot in the
    // slot as much as the card's own work. The answer by content names the slot's own head in its place, read pinned
    // (no snapshot): an operation that leaves the slot's working copy and its head as they were gathers the intent
    // again once; a new commit or recorded edit in the slot changes it and still refuses. The rest stays (the
    // workspace, a colocated Git state, the generation, the binding, the lease, the target).
    // The slot's rows name its writer's run last: the builder's own session ending (its writer cleared as its exit
    // settles, HR2's diagnostic on HI-2890) or starting changes only that. The hold says whether the writer is none or
    // the builder's under this lease (held) or anyone else's (not), so the answer keeps the hold and leaves out the run.
    const i = parts.findIndex((x) => x === 'jj')
    if (i < 0 || !p?.folder) return null
    const at = await this.headOf(p.folder)
    if (isUnknown(at)) return null
    const slot = (x: string): string => (x.startsWith('slot:held:') || x.startsWith('slot:not:') ? x.slice(0, x.lastIndexOf(':')) : x)
    return [...parts.slice(0, i + 1), `at:${at.at.commit}:${at.head}`, ...parts.slice(i + 2)].map(slot).join('|')
  }

  /** The slot's head as J2 reads it, pinned: `@-` when `@` is empty with one parent, else `@`. */
  private async headOf(folder: string): Promise<Maybe<{ op: string; at: JjCommit; head: string; ctx: JjContext; workspace: string }>> {
    const ctx = await this.ctxOf(folder)
    const co = ctx ? readCheckout(ctx.workspace) : null
    if (!ctx || !co) return unknown(UNREADABLE.revisionIn, { folder })
    const reads = new JjReads({ folder, jjRepo: ctx.jjRepo }, this.runner())
    const got = await reads.pinned((op) => reads.commitAt(op, `${co.workspace.replace(/"/g, '')}@`))
    if (isJjUnknown(got)) return withDetail(unknown(UNREADABLE.revisionIn, { folder }), got.detail ?? got.jjUnknown)
    const at = got.value
    return { op: got.op, at, head: at.empty && at.parents.length === 1 ? at.parents[0] : at.commit, ctx, workspace: co.workspace }
  }

  async revisionNow(card: CardRecord, s: CardState): Promise<Maybe<string | null>> {
    if (card.kind === 'no-code' || !this.wf || !s.started?.line) return null
    const h = await this.headOf(this.wf.folderOf(s))
    return isUnknown(h) ? h : h.head
  }

  /** A name an agent gave resolved to exactly `head`, without any jj revset: a hex prefix the Git store gives only it. */
  private async names(store: string, named: string, head: string): Promise<GuardRefusal | null> {
    const n = named.trim().toLowerCase()
    if (n === head) return null
    const shown = n.length > 12 ? `${n.slice(0, 12)}…` : n
    const refusal = (why: 'ambiguous' | 'other'): GuardRefusal => ({ rule: 'check.revisionMismatch', values: { revision: shown || named, head: head.slice(0, 12), why } }) // i18n-ignore: a refusal's code and values
    if (!COMMIT_PREFIX.test(n) || !head.startsWith(n) || !this.deps) return refusal('other')
    const r = await this.deps.git(store, ['rev-parse', '--verify', '--quiet', `${n}^{commit}`])
    return r.ok && r.out.trim() === head ? null : refusal(r.ok ? 'other' : 'ambiguous')
  }

  async runRevision(card: CardRecord, s: CardState, folder: string | null, named: string | null): Promise<RunRevision> {
    const revision = await this.revisionNow(card, s)
    const rev = isUnknown(revision) ? null : revision
    const own = !!this.wf && folder !== null && !!s.started?.line && join(folder) === join(this.wf.folderOf(s))
    const at = own ? rev : folder ? await this.headOf(folder).then((h) => (isUnknown(h) ? null : h.head)) : null
    let resolved: string | null = null
    if (named !== null && folder && at) {
      const ctx = await this.ctxOf(folder)
      resolved = ctx && !(await this.names(ctx.store, named, at)) ? at : null
    }
    return { revision: rev, tested: at, testedIs: 'checkout', ...(named !== null ? { named: resolved } : {}) }
  }

  async submission(card: CardRecord, s: CardState, o: WorkflowOptions, args: { revision?: string; agent: string | null; guards: readonly string[]; predicted?: boolean }): Promise<SubmitPlan> {
    const d = this.deps
    const port = d?.port() ?? null
    if (!this.wf || !d || !port || !s.started?.line) return { ok: false, refusal: this.unknownRefusal(card, notYet(), 'submit') }
    const folder = this.wf.folderOf(s)
    const ctx = await this.ctxOf(folder)
    const co = ctx ? readCheckout(ctx.workspace) : null
    if (!ctx || !co) return { ok: false, refusal: this.unknownRefusal(card, unknown(UNREADABLE.revisionIn, { folder }), 'submit') }
    const workspace = co.workspace
    const reads = new JjReads({ folder, jjRepo: ctx.jjRepo }, this.runner())
    // The moment it answers for: J3's boundary (the snapshot, under the store's lock, its owner the card's lease and slot
    // as they were at the start of this submission); a predicted submission only reads, at the single head.
    let op: string
    let at: JjCommit
    if (args.predicted) {
      const got = await reads.pinned((h) => reads.commitAt(h, `${workspace}@`))
      if (isJjUnknown(got)) return { ok: false, refusal: this.unknownRefusal(card, withDetail(unknown(UNREADABLE.revisionIn, { folder }), got.detail ?? got.jjUnknown), 'submit') }
      op = got.op
      at = got.value
    } else {
      const owner = this.ownerOf(card, s, true)
      if (!owner) return { ok: false, refusal: this.refused(card, 'unbound') }
      const b = await jjBoundary({ ...ctx, folder }, owner, { lock: d.lock(ctx.store) }, this.runner())
      // New files jj left out for its size limit (HI-2973): the work isn't all recorded, named for the agent to commit
      // (raising the limit) or ignore.
      if (boundaryRefused(b) && b.refused === 'tooLarge') return { ok: false, refusal: this.refused(card, 'tooLarge', { files: (b.files ?? []).slice(0, 10).join(', '), count: (b.files ?? []).length }) }
      if (boundaryRefused(b)) return { ok: false, refusal: b.refused === 'moved' || b.refused === 'owner' ? { rule: 'evidence.changed', values: { card: card.key } } : this.unknownRefusal(card, withDetail(unknown(UNREADABLE.state, { folder }), b.detail ?? b.refused), 'submit') }
      // Something recorded: the folder had changes jj hadn't seen (an uncommitted edit): commit them first.
      if (b.recorded) return { ok: false, refusal: { rule: 'submit.empty', values: { card: card.key, changes: 'yes' } } }
      op = b.op
      at = b.at
    }
    // `@` empty on exactly one parent P: the work is committed (`jj commit`), and P is the card's revision.
    if (!at.empty) return { ok: false, refusal: { rule: 'submit.empty', values: { card: card.key, changes: 'yes' } } }
    if (at.parents.length !== 1) return { ok: false, refusal: this.refused(card, 'mergeWorkingCopy') }
    const P = await reads.commitAt(op, at.parents[0])
    if (isJjUnknown(P)) return { ok: false, refusal: this.unknownRefusal(card, withDetail(unknown(UNREADABLE.revision, { revision: at.parents[0].slice(0, 12) }), P.detail ?? P.jjUnknown), 'submit') }
    if (P.divergent) return { ok: false, refusal: this.refused(card, 'divergent', { commit: P.commit.slice(0, 12) }) }
    if (P.conflict) return { ok: false, refusal: this.refused(card, 'conflicted', { commit: P.commit.slice(0, 12) }) }
    if (args.revision) {
      const mismatch = await this.names(ctx.store, args.revision, P.commit)
      if (mismatch) return { ok: false, refusal: mismatch }
    }
    // The slot's binding: still this card's line, at its generation, its base an ancestor of P.
    const bound = await port.binding(folder)
    if (isUnknown(bound)) return { ok: false, refusal: this.unknownRefusal(card, bound, 'submit') }
    if (!bound || bound.key !== s.started.line) return { ok: false, refusal: this.refused(card, 'unbound') }
    const base0 = bound.base
    if (P.commit === base0) return { ok: false, refusal: { rule: 'submit.empty', values: { card: card.key, changes: 'none' } } }
    const chainOut = await reads.run(op, ['log', '--no-graph', '--reversed', '-r', `(${base0}::${P.commit}) ~ ${base0}`, '-n', String(CHAIN_MAX + 1), '-T', COMMIT_TEMPLATE])
    if (isJjUnknown(chainOut)) return { ok: false, refusal: this.unknownRefusal(card, withDetail(unknown(UNREADABLE.commitsSince, { revision: P.commit.slice(0, 7), base: base0.slice(0, 7) }), chainOut.detail ?? chainOut.jjUnknown), 'submit') }
    const lines = chainOut.split('\n').filter(Boolean)
    if (lines.length > CHAIN_MAX) return { ok: false, refusal: this.refused(card, 'tooLong', { max: CHAIN_MAX }) }
    const chain = lines.map(parseCommitLine)
    if (!chain.every((c): c is JjCommit => c !== null)) return { ok: false, refusal: this.unknownRefusal(card, unknown(UNREADABLE.commitsSince, { revision: P.commit.slice(0, 7), base: base0.slice(0, 7) }), 'submit') }
    if (chain.at(-1)?.commit !== P.commit) return { ok: false, refusal: this.refused(card, 'notFromBase', { base: base0.slice(0, 12) }) }
    for (const c of chain) {
      if (c.divergent) return { ok: false, refusal: this.refused(card, 'divergent', { commit: c.commit.slice(0, 12) }) }
      if (c.conflict) return { ok: false, refusal: this.refused(card, 'conflicted', { commit: c.commit.slice(0, 12) }) }
    }
    // Every commit of the chain recorded by no card, or by this one (its own earlier submissions): never another's (s13 §3, s16).
    const rec = recordedIds(this.wf.store.cards().map((c) => ({ card: c.key, facts: this.wf!.store.facts(c.id) })))
    for (const c of chain) {
      const evolution = await reads.evolutionAt(op, c.commit)
      const who: JjAttribution = jjAttribute({ commit: c.commit, divergent: c.divergent, evolution }, rec)
      if ('none' in who) continue
      if ('card' in who && who.card === card.key) continue
      return { ok: false, refusal: this.refused(card, 'otherCard', { commit: c.commit.slice(0, 12), other: 'card' in who ? who.card : (who.detail ?? who.ambiguous) }) }
    }
    if (!reads.stillAt(op)) return { ok: false, refusal: { rule: 'evidence.changed', values: { card: card.key } } }
    // The fixed endpoints, on the Git store: the base where P and the target's head meet now (as Git's), the change's
    // files and key from that base to P.
    const integ = await d.integration()
    const th = integ && s.started.target ? await jjTargetHead(integ, s.started.target) : null
    if (!th || isJjUnknown(th) || integrationRefused(th)) return { ok: false, refusal: this.unknownRefusal(card, withDetail(unknown(UNREADABLE.target, { target: s.started.target ?? '' }), th ? (integrationRefused(th) ? th.refused : th.jjUnknown) : 'none'), 'submit') }
    const mb = th.head === P.commit ? P.commit : await this.H.mergeBase(ctx.store, th.head, P.commit)
    if (isUnknown(mb) || !mb) return { ok: false, refusal: this.unknownRefusal(card, unknown(UNREADABLE.branchedOffTarget), 'submit') }
    const ch = await this.H.change(ctx.store, mb, P.commit)
    if (isUnknown(ch)) return { ok: false, refusal: this.unknownRefusal(card, ch, 'submit') }
    if (!ch.files.length) return { ok: false, refusal: { rule: 'submit.empty', values: { card: card.key, changes: 'none' } } }
    const inputs: Partial<GuardInputs> = {}
    if (args.guards.includes('submit.clean')) inputs.dirty = []
    if (args.guards.includes('submit.ready')) inputs.conflicts = []
    if (args.guards.includes('submit.trailer')) inputs.untrailered = null
    if (args.guards.includes('submit.identity')) inputs.badIdentity = await this.badIdentity(reads, op, ctx.store, chain, o)
    const entries: JjChainEntry[] = chain.map((c) => ({ commit: c.commit, change: c.change }))
    // The slot it was submitted from, as bound then (HR2's round 1): its retention and reuse record follow this, never the
    // card's later state.
    const slot: JjSubmittedSlot = { folder, key: s.started.line, store: ctx.store, workspace, generation: bound.generation }
    return { ok: true, revision: P.commit, base: mb, key: ch.key, files: ch.files, commits: chain.map((c) => c.commit), inputs, warnings: [], platform: { ...jjPlatform({ changeId: P.change, commitId: P.commit, workspace, operation: op }, entries), jjSlot: slot } }
  }

  /** G12: the first commit of the chain not authored with jj's configured identity, or `missing`. */
  private async badIdentity(reads: JjReads, op: string, store: string, chain: JjCommit[], o: WorkflowOptions): Promise<Maybe<{ commit: string; email: string } | 'missing' | null>> {
    if (!o.identity || !this.deps) return null
    const email = await reads.configAt(op, 'user.email')
    if (isJjUnknown(email)) return unknown(UNREADABLE.history, { target: store })
    if (!email) return 'missing'
    const r = await this.deps.git(store, ['log', '--no-walk=unsorted', '--format=%H %ae', ...chain.map((c) => c.commit)])
    if (!r.ok) return unknown(UNREADABLE.history, { target: store })
    for (const l of r.out.split(/\r?\n/).filter(Boolean)) {
      const [commit, ...rest] = l.split(' ')
      if (rest.join(' ').toLowerCase() !== email.toLowerCase()) return { commit, email }
    }
    return null
  }

  /** jj's finish is the user's integration (`userIntegrates`): nothing to read for a finish. */
  async finishInputs(): Promise<FinishInputs> {
    return {}
  }

  async headMoved(_card: CardRecord, s: CardState, o: WorkflowOptions, from: { base: string | null; revision: string; key?: string | null }): Promise<HeadMove | null> {
    if (!this.wf || !s.started?.line) return null
    const h = await this.headOf(this.wf.folderOf(s))
    if (isUnknown(h) || h.head === from.revision) return null
    const integ = await this.deps?.integration()
    const th = integ && s.started.target ? await jjTargetHead(integ, s.started.target) : null
    const b2 = th && !isJjUnknown(th) && !integrationRefused(th) ? await this.H.mergeBase(h.ctx.store, th.head, h.head) : null
    const base = b2 && !isUnknown(b2) ? b2 : null
    let same = false
    if (o.sameness === 'change' && base && from.base) {
      const reads = new JjReads({ folder: this.wf.folderOf(s), jjRepo: h.ctx.jjRepo }, this.runner())
      const [a, b] = await Promise.all([reads.commitAt(h.op, from.revision), reads.commitAt(h.op, h.head)])
      if (!isJjUnknown(a) && !isJjUnknown(b) && reads.stillAt(h.op)) same = await jjSameRevision({ base: from.base, commit: a }, { base, commit: b }, (x, y) => this.H.sameChange(h.ctx.store, x, y).then((v) => v === true))
    }
    return { to: h.head, base, same }
  }

  /** Typed unknown in J9b1: J9b2's proof decides containment (s13 §4), never a partial answer either way. */
  async contains(): Promise<Maybe<Containment | null>> {
    return { unknown: true, what: say(CONTAINMENT_TEXT) }
  }

  async targetHead(target: string): Promise<Maybe<string | null>> {
    const integ = await this.deps?.integration()
    if (!integ) return notYet()
    const th = await jjTargetHead(integ, target)
    if (isJjUnknown(th) || integrationRefused(th)) return withDetail(unknown(UNREADABLE.target, { target }), integrationRefused(th) ? th.refused : th.jjUnknown)
    return th ? th.head : null
  }

  /**
   * A jj card's reconciliation (HI-2882's J9b2): the workflow's `reconcileJj` with this adapter's reads: the slot's head,
   * J3's sameness, J5's proof for the approved submission, and the Integrated write's rows (obligation, retained bundle).
   */
  async reconcile(card: CardRecord, hooks: ReconcileHooks): Promise<void> {
    const d = this.deps
    if (!this.wf || !d?.records) return
    const rec = d.records
    await reconcileJj(this.wf, card, hooks, {
      headNow: (_c, s) => this.revisionNow(card, s),
      same: async (_c, s, approved, head) => {
        // Every read that can't be made (no context, the target refused or unknown, no merge base, a commit unread, the
        // view moved, the replay unknown) is unknown, never "not the same" (HR1's round 1).
        const integ = await d.integration()
        const ctx = await this.ctxOf(this.wf!.folderOf(s))
        const th = integ && s.started?.target ? await jjTargetHead(integ, s.started.target) : null
        if (!ctx || !th || isJjUnknown(th) || integrationRefused(th)) return { unknown: 'sameness:target' } // i18n-ignore: a protocol code, for the log
        const b = await this.H.mergeBase(ctx.store, th.head, head)
        if (isUnknown(b) || !b) return { unknown: 'sameness:mergeBase' } // i18n-ignore: a protocol code, for the log
        const reads = new JjReads({ folder: this.wf!.folderOf(s), jjRepo: ctx.jjRepo }, this.runner())
        const op = reads.head()
        if (isJjUnknown(op)) return { unknown: 'sameness:heads' } // i18n-ignore: a protocol code, for the log
        const [a, n] = await Promise.all([reads.commitAt(op, approved.revision), reads.commitAt(op, head)])
        if (isJjUnknown(a) || isJjUnknown(n) || !reads.stillAt(op)) return { unknown: 'sameness:commits' } // i18n-ignore: a protocol code, for the log
        let unread = false
        const same = await jjSameRevision({ base: approved.base, commit: a }, { base: b, commit: n }, async (x, y) => {
          const v = await this.H.sameChange(ctx.store, x, y)
          if (isUnknown(v)) unread = true
          return v === true
        })
        return unread ? { unknown: 'sameness:replay' } : { same, base: b } // i18n-ignore: a protocol code, for the log
      },
      prove: async (_c, s, approved) => {
        const integ = await d.integration()
        if (!integ || !s.started?.target) return { unknown: 'notComposed' }
        const project = rec.projectId()
        const consumed = rec.read((db) => (db.prepare('SELECT bundle FROM jj_retained WHERE project = ?').all(project) as { bundle: string }[]).map((r) => r.bundle)) // i18n-ignore: SQL
        // HI-2871: the cycle's J4 records, so the user's move onto a candidate is credited as one (J5's bound candidate).
        const candidates = (rec.attempts?.(card.key, s.cycle) ?? []).map((e) => e.record)
        const p = await jjContains(integ, { card: card.key, cycle: s.cycle, target: s.started.target, change: approved, candidates, bundles: rec.bundles(card.key, s.cycle), consumed, token: randomUUID().replace(/-/g, '').slice(0, 16) })
        if (isJjUnknown(p)) return { unknown: `${p.jjUnknown}${p.detail ? `: ${p.detail}` : ''}` }
        if (integrationRefused(p)) return { unknown: `refused: ${p.refused}` }
        if (!p.containment || !p.provenance) return { contained: false }
        return { contained: true, method: p.containment.method, result: p.provenance.head, bundle: p.provenance.bundle, platform: jjIntegratedPlatform(p.provenance as JjIntegratedIds) }
      },
      record: (w, row) => w.tx.sql((db) => recordIntegration(db as unknown as SqlDb, rec.projectId(), row)),
      projectId: () => rec.projectId(),
      ...(rec.attempts && rec.saveAttempt ? { candidate: (_c: CardRecord, s: CardState, fp: JjCandidateFingerprint, still: () => boolean) => this.withCardLock(card.id, () => this.candidateStep(card, s, fp, still)), headIs: (target: string, expected: string) => this.headIs(target, expected), offerCurrent: (target: string, offer: JjCandidateOffer) => this.offerCurrent(target, offer), candidatesDone: (_c: CardRecord, cycle: number) => this.candidatesDone(card, cycle), checksNow: (_c: CardRecord, s: CardState) => this.checksNow(card, s), checksWanted: () => this.checksWanted() } : {})
    })
  }

  /** Whether a target's head is still `expected` (J5's read): false when it moved or can't be read. */
  private async headIs(target: string, expected: string): Promise<boolean> {
    const integ = await this.deps?.integration()
    const th = integ ? await jjTargetHead(integ, target) : null
    return !!th && !isJjUnknown(th) && !integrationRefused(th) && th.head === expected
  }

  /**
   * HI-2871's candidate step for a card's approval (jjCandidateStep.ts): J4 composed from J5's dependencies (the control
   * folder, the store's lock, git on the store) and Git's replay on the store, its attempts journalled in the workspace
   * database under the card's cycle. A replay that can't be read stops the attempt (never "not the same").
   */
  /** HI-2938: the project's merge checks for a card now: names and key; none when not configured or not composed. */
  private async checksNow(card: CardRecord, s: CardState): Promise<{ key: string; names: string[] }> {
    const host = this.deps?.candidateChecks
    if (!this.wf || !host) return { key: '', names: [] }
    const o = this.wf.rulesetOf(card, s).options
    return o.mergeChecks.length ? { key: checksKeyOf(o, (await host.setup()).setup), names: [...o.mergeChecks] } : { key: '', names: [] }
  }

  /** HI-2938: asks the project's checks runner to look (one per workflow; a look asked for mid-look runs after it). */
  checksWanted(): void {
    if (!this.wf || !this.deps?.candidateChecks) return
    const r = runners.get(this.wf) ?? { busy: false, again: false, timer: null }
    runners.set(this.wf, r)
    if (r.busy) {
      r.again = true
      return
    }
    r.busy = true
    void (async () => {
      try {
        do {
          r.again = false
          await this.checksPass(r)
        } while (r.again)
      } catch (e) {
        checksLog.warn("a jj candidate's checks", e) // i18n-ignore: a log line, English
      } finally {
        r.busy = false
      }
    })()
  }

  /**
   * HI-2938's Run Checks Again (s11 §1): a candidate whose checks were stopped or keep failing runs them again, under
   * the same validity as any publication (its fingerprint, checks key, head and recorded commit). Whether it did.
   */
  async checksAgain(card: CardRecord): Promise<boolean> {
    const host = this.deps?.candidateChecks
    const rec = this.deps?.records
    if (!this.wf || !host || !rec) return false
    const project = rec.projectId()
    const s = this.wf.state(card)
    const shown = candidateShown(this.wf, card, s, project, undefined, true)
    const fp = candidateFingerprint(this.wf, card, s)
    if (!shown?.offer || !fp) return false
    const ok = await checksAgain(this.wf, card, project, (await host.setup()).setup, await this.offerCurrent(fp.target, shown.offer))
    if (ok) this.checksWanted()
    return ok
  }

  /** Whether the project's checks runner is looking now (tests wait for it to finish). */
  checksBusy(): boolean {
    return !!this.wf && !!runners.get(this.wf)?.busy
  }

  /** One look: each card waiting for its candidate's checks, in turn (s11). */
  private async checksPass(r: ChecksRunner): Promise<void> {
    const wf = this.wf!
    const d = this.deps!
    const host = d.candidateChecks!
    const rec = d.records
    if (!rec) return
    const project = rec.projectId()
    let later: number | null = null
    for (const card0 of wf.store.cards()) {
      if (host.signal?.aborted) return
      if (card0.stage !== 'approved') continue
      const s = wf.state(card0)
      const shown = candidateShown(wf, card0, s, project, undefined, true)
      const fp = candidateFingerprint(wf, card0, s)
      if (!shown?.offer || !shown.checks || !fp || (shown.checks.state !== 'running' && shown.checks.state !== 'waiting' && shown.checks.state !== 'failing')) continue
      const offer = shown.offer
      const read = await host.setup()
      const setup = read.setup
      const o = wf.rulesetOf(card0, s).options
      const key = checksKeyOf(o, setup)
      const at = { fp, attempt: offer.attempt, key, setup, setupStill: () => host.setupStamp() === read.stamp }
      // Other checks, commands, install or setup since (finding 3): they start anew under the key now.
      if (key !== shown.checks.key) {
        if (!o.mergeChecks.length || !(await publishCandidateChecks(wf, wf.store.card(card0.id), project, at, { restart: [...o.mergeChecks] }, await this.offerCurrent(fp.target, offer)))) continue
      }
      const publish = async (u: JjChecksUpdate): Promise<boolean> => publishCandidateChecks(wf, wf.store.card(card0.id), project, at, u, await this.offerCurrent(fp.target, offer))
      const jkey = checksJournalKey(project, card0.key, fp.cycle, offer.attempt)
      const valid = async (): Promise<boolean> => {
        const c = wf.store.card(card0.id)
        const st = wf.state(c)
        return sameFingerprint(candidateFingerprint(wf, c, st), fp) && checksKeyOf(wf.rulesetOf(c, st).options, (await host.setup()).setup) === key && host.setupStamp() === read.stamp && (await this.offerCurrent(fp.target, offer))
      }
      let done = 0
      const out = await runCandidateChecks(
        {
          journal: {
            read: () => rec.read((db) => readChecksJournal(db, jkey)),
            write: (j) => rec.write((db) => writeChecksJournal(db, jkey, j))
          },
          leaseFreed: (id) => host.leaseFreed(id),
          lease: (revision) => host.lease(card0.id, revision),
          runCheck: (name, command, folder, ctx, spawn) => host.runCheck(name, command, folder, ctx, spawn),
          install: (folder, ctx, spawn) => host.install(folder, ctx, spawn),
          bracket: (folder, revision) => this.copyBracket(folder, revision),
          valid,
          checkRan: async (c) => {
            const data: FactData['CheckRan'] = { name: c.name, command: c.command, revision: c.revision, tested: c.tested, result: c.ok ? 'passed' : 'failed', run: c.run || randomUUID(), durationMs: c.durationMs, by: CW_RUNS, counted: c.counted, ...(c.whyNot ? { whyNot: c.whyNot } : {}), entry: jjCandidateEntry(offer.attempt) }
            await wf.write(wf.store.card(card0.id), null, 'combwork', (w) => void w.fact('CheckRan', data))
            if (c.ok && c.counted) await publish({ progress: { done: ++done } })
          },
          stopped: (run) => host.stopped(run),
          ...(host.signal ? { signal: host.signal } : {}),
          ...(host.watchMs ? { watchMs: host.watchMs } : {}),
          hook: async (p) => {
            if (p.startsWith('beforeCheck:')) await publish({ progress: { done, current: p.slice('beforeCheck:'.length) } })
            await host.hook?.(p)
          }
        },
        { card: { key: card0.key, number: card0.id }, fp, attempt: offer.attempt, result: offer.result, expected: offer.expected, checksKey: key, names: [...o.mergeChecks], commands: o.commands, installAlways: o.mergeInstall === 'always' }
      )
      const misses = shown.checks.state === 'failing' ? (shown.checks.misses ?? 1) : 0
      if ('green' in out) await publish({ passed: out.checks })
      else if ('red' in out) await publish({ red: { ...out.red, expected: offer.expected } })
      else if ('stopped' in out) await publish({ stopped: out.stopped.check })
      else if ('wait' in out) {
        await publish({ waiting: out.wait })
        later = Math.min(later ?? Infinity, host.againMs?.(0) ?? 30_000)
      } else if ('transient' in out) {
        await publish({ failing: `${out.transient.check}: ${out.transient.why}`.slice(0, 500) })
        later = Math.min(later ?? Infinity, host.againMs?.(misses + 1) ?? Math.min(15 * 60_000, 30_000 * 2 ** misses))
      }
    }
    if (later !== null && Number.isFinite(later) && !host.signal?.aborted) {
      if (r.timer) clearTimeout(r.timer)
      r.timer = setTimeout(() => {
        r.timer = null
        this.checksWanted()
      }, later)
      r.timer.unref?.()
    }
  }

  /** J3's check bracket at a check copy, for exactly `revision` (HI-2938/s11): counted only when its credit is that commit. */
  private async copyBracket(folder: string, revision: string): Promise<{ end(): Promise<{ counted: boolean; tested: string; whyNot?: CheckWhyNot }> }> {
    const ctx = await this.ctxOf(folder)
    const d = this.deps!
    if (!ctx) return { end: async () => ({ counted: false, tested: '', whyNot: 'changed' as const }) }
    const r = { view: ctx, folder, revision, owner: { still: () => true }, lock: d.lock(ctx.store) }
    const start = await jjCheckStart(r, observePort, { runner: this.runner() })
    return {
      end: async () => {
        const credit = jjCredit(await jjCheckEnd(r, start, observePort, { runner: this.runner() }))
        const counted = !credit.whyNot && credit.tested === revision
        return { counted, tested: credit.tested ?? '', ...(counted ? {} : { whyNot: credit.whyNot ?? ('notContained' as const) }) }
      }
    }
  }

  /** HI-2871 (HR3's round 2): an offer still current: its target at its head, its candidate the visible commit recorded. */
  private async offerCurrent(target: string, offer: JjCandidateOffer): Promise<boolean> {
    if (!(await this.headIs(target, offer.expected))) return false
    const integ = await this.deps?.integration()
    if (!integ) return false
    const now = await jjCandidateNow({ runner: integ.runner, view: { jjRepo: integ.view.jjRepo, store: integ.view.store }, folder: integ.folder }, { result: offer.result, change: offer.change }).catch(() => null)
    return now === 'current'
  }

  /**
   * HI-2871: an integrated cycle's candidates dropped at once, as the sweep's clean-up (`cleanCycle`, HI-2990: the same
   * one, under the card's lock, the cycle still over its owner); what it leaves unresolved the sweep finds again. A
   * failure only logged.
   */
  private async candidatesDone(card: CardRecord, cycle: number): Promise<void> {
    const wf = this.wf
    const rec = this.deps?.records
    const integ = await this.deps?.integration()
    if (!wf || !rec?.attempts || !rec.saveAttempt || !integ) return
    const attempts = rec.attempts
    const save = rec.saveAttempt
    const j4 = { runner: integ.runner, view: { jjRepo: integ.view.jjRepo, store: integ.view.store }, folder: integ.folder, git: integ.git, lock: integ.lock, sameChange: async () => false, ...(this.deps?.candidateHook ? { hook: this.deps.candidateHook } : {}) }
    const park = this.deps?.candidateChecks?.parkCopies
    const still = (): boolean => {
      const c = wf.store.card(card.id)
      return cycleOver(c, wf.state(c), cycle)
    }
    await this.withCardLock(card.id, () => cleanCycle({ j4, entries: () => attempts(card.key, cycle), save: (e) => save(card.key, cycle, e), still, ...(park ? { park } : {}) })).catch((e) => checksLog.warn(`dropping #${userText(card.key)}'s candidates after Integrated`, e)) // i18n-ignore: a log line, English
  }

  private async candidateStep(card: CardRecord, s: CardState, fp: JjCandidateFingerprint, still: () => boolean): Promise<JjCandidateStep> {
    const d = this.deps
    const rec = d?.records
    const integ = await d?.integration()
    if (!this.wf || !rec?.attempts || !rec.saveAttempt || !integ) return { unknown: 'notComposed' } // i18n-ignore: a protocol code, for the log
    const o = this.wf.rulesetOf(card, s).options
    let unread = false
    const j4 = {
      runner: integ.runner,
      view: { jjRepo: integ.view.jjRepo, store: integ.view.store },
      folder: integ.folder,
      git: integ.git,
      lock: integ.lock,
      ...(d!.candidateHook ? { hook: d!.candidateHook } : {}),
      sameChange: async (a: { base: string; revision: string }, b: { base: string; revision: string }) => {
        const v = await this.H.sameChange(integ.view.store, a, b)
        if (isUnknown(v)) {
          unread = true
          throw new SamenessUnread()
        }
        return v === true
      }
    }
    const attempts = rec.attempts
    const save = rec.saveAttempt
    try {
      return await jjCandidateStep(
        {
          j4,
          targetHead: async (target) => {
            const th = await jjTargetHead(integ, target)
            if (isJjUnknown(th)) return { unknown: `target:${th.jjUnknown}` } // i18n-ignore: a protocol code, for the log
            if (integrationRefused(th)) return { unknown: `refused: ${th.refused}` } // i18n-ignore: a protocol code, for the log
            return th ? { head: th.head } : { unknown: 'target:none' } // i18n-ignore: a protocol code, for the log
          },
          entries: () => attempts(card.key, fp.cycle),
          save: (e) => save(card.key, fp.cycle, e),
          still,
          token: () => randomUUID().replace(/-/g, '').slice(0, 16),
          ...(d?.candidateChecks?.parkCopies ? { park: d.candidateChecks.parkCopies } : {})
        },
        card.key,
        fp,
        { message: oneLine(mergeMessage(o.commitMessage, { card: { key: card.key, title: card.title }, revision: fp.revision, messages: [] })), updateMessage: oneLine(updateMessage(o.commitMessage, fp.target, card.key, fp.revision)) }
      )
    } catch (e) {
      if (unread || e instanceof SamenessUnread) return { unknown: 'sameness:replay' } // i18n-ignore: a protocol code, for the log
      throw e
    }
  }

  /**
   * The repository watch's invalidation (HI-2882/s13 §2–3): a bundle's pins changed (that row due), packed refs or a watch
   * re-armed (every row due), each wanting a run; the minute's tick wants one only while any row is due.
   */
  async invalidated(what: string): Promise<boolean> {
    const rec = this.deps?.records
    if (!rec) return false
    const project = rec.projectId()
    // A new pass while the pass under way or the last finished one left work unresolved (HR2's round 3: across its pages).
    const sw = this.wf ? sweeps.get(this.wf) : undefined
    if (what === 'tick') return !!sw?.pass || !!sw?.last || rec.read((db) => anyRetainedDue(db, project, Date.now(), RETAIN_EVERY_MS))
    if (what === 'retained:*') {
      await rec.write((db) => markRetainedDue(db, project, null))
      return true
    }
    const m = /^retained:(.+):(\d+):([^:]+)$/.exec(what)
    if (m) await rec.write((db) => markRetainedDue(db, project, { card: m[1], cycle: Number(m[2]), bundle: m[3] }))
    return true
  }

  /**
   * Once per reconciliation run (HI-2882/s13, the reconciler's): each target's publish observation (J5's, its tail in the
   * publish worker's transaction, cancelled with `signal`), then one fair page of retained bundles verified (J5's
   * `ensureRetained`), every visit recorded whatever its outcome. `more`: due bundles remain after the page.
   */
  async afterRun(signal?: AbortSignal): Promise<{ more: boolean }> {
    // HI-2938: candidates waiting for their checks (after a restart too) looked at by the project's checks runner.
    this.checksWanted()
    const d = this.deps
    const rec = d?.records
    if (!this.wf || !d || !rec) return { more: false }
    const integ = await d.integration()
    if (!integ) return { more: false }
    const project = rec.projectId()
    const reader: SqlDb = {
      prepare: (sql) => ({
        all: (...a) => rec.read((db) => db.prepare(sql).all(...a)),
        get: (...a) => rec.read((db) => db.prepare(sql).get(...a)),
        run: () => {
          throw new Error('the publish observation writes only in its worker') // i18n-ignore: a programming error, never shown
        }
      })
    }
    for (const target of rec.read((db) => publishTargets(db, project))) {
      if (signal?.aborted) return { more: false }
      const identity = { repo: folderIdentity(integ.view.jjRepo), store: folderIdentity(integ.view.store) }
      const commit = async (tail: PublishTailInput): Promise<PublishObserved> => {
        const h = rec.publish({ tail, project, file: rec.dbFile(), identity })
        const cancel = (): void => h.cancel()
        signal?.addEventListener('abort', cancel, { once: true })
        if (signal?.aborted) h.cancel()
        try {
          const a = await h.answer
          return 'stale' in a ? jjUnknown('moved', a.stale) : a
        } finally {
          signal?.removeEventListener('abort', cancel)
        }
      }
      await observePublish({ ...integ, ...(signal ? { signal } : {}), commit }, target, sqlObligations(reader, project))
    }
    // HI-2950: ended cycles' candidates cleaned up, a fair page each run.
    const swept = await this.sweepEnded(signal)
    const page = rec.read((db) => dueRetained(db, project, Date.now(), RETAIN_EVERY_MS, RETAIN_PAGE))
    for (const row of page.rows) {
      if (signal?.aborted) return { more: false }
      const r = await ensureRetained(integ, row.card, row.cycle, rec.bundles(row.card, row.cycle), row.bundle)
      const outcome = isJjUnknown(r) ? `unknown:${r.jjUnknown}` : integrationRefused(r) ? `refused:${r.refused}` : 'held'
      await rec.write((db) => retainedVisited(db, project, row, Date.now(), outcome))
    }
    return { more: page.more || swept.more }
  }

  /** HI-2950: runs `fn` with the card's own lock (the candidate step and an ended cycle's clean-up never run at once). */
  withCardLock<T>(card: number, fn: () => Promise<T>): Promise<T> {
    const wf = this.wf!
    const locks = cardLocks.get(wf) ?? new Map<number, Promise<unknown>>()
    cardLocks.set(wf, locks)
    const before = locks.get(card) ?? Promise.resolve()
    const run = before.then(fn, fn)
    const tail = run.catch(() => undefined)
    locks.set(card, tail)
    void tail.then(() => {
      if (locks.get(card) === tail) locks.delete(card)
    })
    return run
  }

  /**
   * HI-2950's sweep (design HI-2950/s10), from `afterRun` whatever the cards' stages: the project's candidate journals
   * read by one key-prefix query; each card and cycle with something left to do (an attempt not dropped or kept, a checks
   * journal, the window's record) whose cycle is over (`cycleOver`: ended, or Integrated, HI-2990) is cleaned up, a fair page at a time after a durable
   * cursor (so one that stays unresolved never starves the rest): under the card's lock, its attempts recovered and
   * dropped with the cycle still ended as their owner, then its rows deleted in a write that finds it still ended; a checks
   * journal only once its lease is freed. `more`: due ones beyond the page.
   */
  async sweepEnded(signal?: AbortSignal): Promise<{ more: boolean }> {
    const wf = this.wf
    const d = this.deps
    const rec = d?.records
    if (!wf || !d || !rec?.attempts || !rec.saveAttempt) return { more: false }
    const integ = await d.integration()
    if (!integ) return { more: false }
    const project = rec.projectId().toLowerCase()
    const prefix = `jj_attempts:${project}:`
    const cursorKey = `jj_sweep_cursor:${project}`
    // Bounded on main (HR1's round 1, finding 2): at most SWEEP_SCAN journals read a run, by the key's index after the
    // durable cursor, whatever they hold; each card looked up by its key. A pass runs from the start to the last key and
    // ends there (HR1's round 2): its cursor goes back to the start and `more` is false, so a quiet project's next pass
    // waits for a reason (a move, the tick while something was left unresolved, a start), never a continuation loop.
    const cursor = rec.read((db) => (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(cursorKey) as { value: string } | undefined)?.value ?? '') // i18n-ignore: SQL
    // A workflow's first sweep begins a pass at the start, whatever the cursor (HR1's round 4): the pass's unresolved work
    // is this workflow's memory, so a pass carried over a restart would forget what its earlier pages left.
    const after = sweeps.has(wf) && cursor > prefix ? cursor : prefix
    const scan = (from: string, to: string, n: number): { key: string; value: string }[] =>
      n > 0 ? (rec.read((db) => db.prepare('SELECT key, value FROM board_meta WHERE key > ? AND key < ? ORDER BY key LIMIT ?').all(from, to, n)) as { key: string; value: string }[]) : [] // i18n-ignore: SQL
    const all = scan(after, `${prefix}\uffff`, SWEEP_SCAN)
    const passEnds = all.length < SWEEP_SCAN
    const byKey = (k: string): CardRecord | null => wf.store.cardByKey(k)
    type Due = { key: string; cardKey: string; cycle: number }
    const due: Due[] = []
    for (const row of all) {
      const m = /^jj_attempts:[^:]+:(.+):(\d+)$/.exec(row.key)
      if (!m) continue
      const cardKey = m[1]
      const cycle = Number(m[2])
      const card = byKey(cardKey)
      if (card && !cycleOver(card, wf.state(card), cycle)) continue
      const entries = readAttemptsValue(row.value)
      const rows = rec.read((db) => (db.prepare('SELECT COUNT(*) AS n FROM board_meta WHERE key = ? OR (key > ? AND key < ?)').get(candidateKey(project, cardKey, cycle), `jj_candidate_checks:${project}:${cardKey}:${cycle}:`, `jj_candidate_checks:${project}:${cardKey}:${cycle}:\uffff`) as { n: number }).n) // i18n-ignore: SQL
      if (!cycleLive(entries) && !rows) continue
      due.push({ key: row.key, cardKey, cycle })
    }
    // Fair: in key order after the cursor, the cursor past each row scanned, due or not (a page short of the due rows
    // stops at its last one, so the rest come first next run).
    const page = due.slice(0, SWEEP_PAGE)
    const cut = page.length < due.length
    let unresolved = false
    for (const x of page) {
      if (signal?.aborted) break
      const card = byKey(x.cardKey)
      const still = (): boolean => {
        const c = byKey(x.cardKey)
        return !c || cycleOver(c, wf.state(c), x.cycle)
      }
      const clean = async (): Promise<void> => {
        if (!still()) return
        const j4 = { runner: integ.runner, view: { jjRepo: integ.view.jjRepo, store: integ.view.store }, folder: integ.folder, git: integ.git, lock: integ.lock, sameChange: async () => false, ...(d.candidateHook ? { hook: d.candidateHook } : {}) }
        const keyOf = card?.key ?? x.cardKey
        const park = d.candidateChecks?.parkCopies
        const out = await cleanCycle({ j4, entries: () => rec.attempts!(keyOf, x.cycle), save: (e) => rec.saveAttempt!(keyOf, x.cycle, e), still, ...(park ? { park } : {}), log: (w) => checksLog.info(`#${userText(keyOf)} cycle ${x.cycle}: ${w}`) }) // i18n-ignore: a log line, English
        if (out.unresolved) unresolved = true
        // Its checks journals: each deleted only once its lease is freed (its tree can't still write; HR1's gap 2).
        const checks = rec.read((db) => db.prepare('SELECT key, value FROM board_meta WHERE key > ? AND key < ?').all(`jj_candidate_checks:${project}:${x.cardKey}:${x.cycle}:`, `jj_candidate_checks:${project}:${x.cardKey}:${x.cycle}:\uffff`) as { key: string; value: string }[]) // i18n-ignore: SQL
        const free: string[] = []
        for (const c of checks) {
          let lease: string | undefined
          try {
            lease = (JSON.parse(c.value) as ChecksJournal).lease
          } catch {
            lease = undefined
          }
          if (lease && d.candidateChecks && !(await d.candidateChecks.leaseFreed(lease))) unresolved = true
          else free.push(c.key)
        }
        if (card) await clearEndedCycle(wf, wf.store.card(card.id), project, x.cycle, free)
        else
          await rec.write((db) => {
            const del = db.prepare('DELETE FROM board_meta WHERE key = ?') // i18n-ignore: SQL
            del.run(candidateKey(project, x.cardKey, x.cycle))
            for (const k of free) del.run(k)
          })
      }
      try {
        if (card) await this.withCardLock(card.id, clean)
        else await clean()
      } catch (e) {
        unresolved = true
        checksLog.warn(`cleaning up #${userText(x.cardKey)}'s ended cycle ${x.cycle}`, e) // i18n-ignore: a log line, English
      }
    }
    // The cursor past what this run took on (its page's last row when cut short), or back to the start once a pass ends.
    const next = cut ? page.at(-1)!.key : passEnds ? '' : (all.at(-1)?.key ?? '')
    await rec.write((db) => void db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(cursorKey, next)) // i18n-ignore: SQL
    // Unresolved accumulated over the whole pass (from its first page: a pass begins at the start), and kept once it ends.
    const was = sweeps.get(wf) ?? { pass: false, last: false }
    const pass = (after === prefix ? false : was.pass) || unresolved
    sweeps.set(wf, passEnds && !cut ? { pass: false, last: pass } : { pass, last: was.last })
    return { more: cut || !passEnds }
  }

  /**
   * A jj check (§16.13, J3's bracket, s10 §4), in one call: the run's folder's view, B1 (the snapshot under the store's
   * lock) with the revision read at its head, the run, then always the end (its write record, J3's stat fallback, B2),
   * and the credit. No check copies: an isolated run is refused before anything runs.
   */
  async checkRun(card: CardRecord, s: CardState, run: { command: string | undefined; revision?: string; isolated?: string; exec: (command: string, folder: string) => Promise<{ ok: boolean }> }): Promise<CheckBracket | GuardRefusal> {
    const d = this.deps
    if (!this.wf || !d) return this.unknownRefusal(card, notYet(), 'submit.checksPassed')
    if (run.isolated) return this.refused(card, 'isolated')
    const folder = this.wf.folderOf(s)
    const ctx = await this.ctxOf(folder)
    const rev = await this.revisionNow(card, s)
    if (!ctx || isUnknown(rev) || !rev) return this.unknownRefusal(card, unknown(UNREADABLE.revisionIn, { folder }), 'submit.checksPassed')
    if (run.revision) {
      const mismatch = await this.names(ctx.store, run.revision, rev)
      if (mismatch) return mismatch
    }
    const owner = this.ownerOf(card, s, false)
    if (!owner) return this.refused(card, 'unbound')
    const r = { view: ctx, folder, revision: rev, owner, lock: d.lock(ctx.store) }
    const start = await jjCheckStart(r, observePort, { runner: this.runner() })
    let ok = false
    let threw: { error: unknown } | null = null
    try {
      ok = run.command && !boundaryRefused(start.b1) ? (await run.exec(run.command, folder)).ok : false
    } catch (error) {
      threw = { error }
    }
    // The end is collected whatever the run did (it failed, threw or was cancelled), then a throw goes on.
    const credit = jjCredit(await jjCheckEnd(r, start, observePort, { runner: this.runner() }))
    if (threw) throw threw.error
    return { revision: rev, tested: credit.tested, ok, ...(run.command ? (credit.whyNot ? { whyNot: credit.whyNot } : {}) : { whyNot: 'notCheck' as const }) }
  }

  /**
   * A submission's pin (HI-2868/s13 §2), the runtime's post-write action, bound to its own submission (HR2's round 1):
   * its fact says the store, the slot and the binding it was made from (`jjSlot`) and its chain; the pin is made in that
   * store, create-only, read back, its ownership journalled; only once it is held, that same binding's submitted commits
   * advanced, and only while the slot is still bound to that key at that generation (seq-ordered): a later cycle, another
   * slot or a removed folder is never filled from it. Never deletes or moves a ref. False for another kind.
   */
  async perform(kind: string, payload: Record<string, unknown>): Promise<boolean> {
    if (kind !== 'pin') return false
    const d = this.deps
    const port = d?.port() ?? null
    if (!this.wf || !d || !port) throw new Error('jj card work is not composed') // i18n-ignore: an action's failure, recorded on the action
    const ref = String(payload.ref)
    const revision = String(payload.revision)
    const seq = Number(payload.submission)
    const cardId = Number(payload.card)
    const sub = this.wf.store.facts(cardId).find((f) => f.kind === 'Submitted' && f.seq === seq)
    const platform = sub ? (sub.data as { platform?: unknown; revision?: unknown }) : null
    const slot = platform ? jjSubmittedSlotOf(platform.platform) : null
    if (!sub || !slot || platform?.revision !== revision) throw new Error(`card ${cardId}'s submission ${seq} has no jj slot for ${revision.slice(0, 12)}`) // i18n-ignore: an action's failure, recorded on the action
    const store = slot.store
    const read = async (): Promise<string | null> => {
      const r = await d.git(store, ['rev-parse', '--verify', '--quiet', ref])
      return r.ok ? r.out.trim() : null
    }
    let rec = d.pins.read(ref)
    if (!rec) {
      // A ref there before any intent of ours: retained by it, never ours to delete.
      const before = await read()
      if (before !== null) {
        if (before !== revision) throw new Error(`${ref} is at ${before.slice(0, 12)}, not ${revision.slice(0, 12)}: left untouched`) // i18n-ignore: an action's failure, recorded on the action
        rec = { seq, revision, phase: 'held', owned: false }
        await d.pins.write(ref, rec)
      } else {
        rec = { seq, revision, phase: 'creating' }
        await d.pins.write(ref, rec)
      }
    }
    if (rec.revision !== revision) throw new Error(`${ref} is journalled for ${rec.revision.slice(0, 12)}`) // i18n-ignore: an action's failure, recorded on the action
    if (rec.phase === 'creating') {
      const now = await read()
      if (now === null) {
        const c = await d.git(store, ['update-ref', ref, revision, ZERO_OID])
        const after = await read()
        if (after !== revision) throw new Error(`pinning ${revision.slice(0, 12)} at ${ref} failed: ${c.err.trim()}`) // i18n-ignore: an action's failure, recorded on the action
        rec = { ...rec, phase: 'created', owned: c.ok ? true : 'uncertain' }
      } else if (now === revision) {
        // A crash after our create, or someone else's same ref: retained either way, ownership not proven.
        rec = { ...rec, phase: 'held', owned: 'uncertain' }
      } else throw new Error(`${ref} is at ${now.slice(0, 12)}, not ${revision.slice(0, 12)}: left untouched`) // i18n-ignore: an action's failure, recorded on the action
      await d.pins.write(ref, rec)
    }
    if ((await read()) !== revision) throw new Error(`${ref} no longer holds ${revision.slice(0, 12)}`) // i18n-ignore: an action's failure, recorded on the action
    // Held: the submission's own binding's submitted commits from exactly its chain, while the slot it was made from is
    // still bound to its key at its generation (port.submitted's compare and swap, seq-ordered); a folder gone, nothing.
    const chain = jjChainOf(platform!.platform)
    if (chain && chain.at(-1)?.commit === revision) await port.submitted(slot.folder, slot.key, chain.map((c) => c.commit), { store: slot.store, workspace: slot.workspace, generation: slot.generation }, seq)
    return true
  }

  /** No check copy (`checkCopies` is Git's): an isolated run is refused before this is asked. */
  async checkCopy(): Promise<string | null> {
    return null
  }

  /** Observation is J9b2's (HI-2882: every repository operation schedules reconciliation). */
  observe(_onChange: (e: ObserveEvent) => void): Disposable {
    return { dispose: () => undefined }
  }
}
