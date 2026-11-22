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
import type { Workflow } from '../workflow/runtime'
import type { CheckBracket, FinishInputs, HeadMove, KeptWork, PlatformAdapter, RunRevision, StartPlan, SubmitPlan } from './adapter'
import type { HistoryPort } from './history'
import { historyFor, observePort } from './historyPorts'
import type { Disposable, ObserveEvent } from './observe'
import { isUnknown, unknown, withDetail, type Containment, type Maybe, type Unknown } from './types'
import { agentMsg, say } from '../../shared/agentText'
import { jjAttribute, type JjAttribution } from './jjAttribution'
import { jjBoundary, isRefused as boundaryRefused, type Owner, type StoreLock } from './jjBoundary'
import { jjCheckEnd, jjCheckStart, jjCredit, jjSameRevision } from './jjChecks'
import { jjContextOf, type JjContext } from './jjDetect'
import { jjChainOf, jjPlatform, recordedIds, type JjChainEntry } from './jjFacts'
import { isRefused as integrationRefused, jjTargetHead, type JjIntegrationDeps } from './jjIntegration'
import type { FactData } from '../../shared/workflow/facts'
import { isJjUnknown, JjReads, parseCommitLine, type JjCommit } from './jjReads'
import { jjRunner, storeGatedHistory, type JjRunner } from './jjRunner'
import { jjFileGate, pathKeySync, storeKey } from './jjFileGate'
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

/** What jj's adapter needs beside jj (the app composes none since HI-3483): never imported from an app module. */
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
}

/** A jj refusal of a card's move, worded by its code (`platform.jjRefused`). */
type JjWhy = 'tooLarge' | 'autoTrack' | 'mergeWorkingCopy' | 'notFromBase' | 'otherCard' | 'divergent' | 'conflicted' | 'isolated' | 'tooLong' | 'unbound' | 'recovered'

/**
 * A file Recover… of a stale slot wrote beside another (HI-2996, jjRecovery.ts): its copy of the user's version, or the
 * file it moved aside. Never part of a card's work unasked: a submission whose change holds one is refused, naming them.
 */
export const RECOVERY_COPY = /\.cw-(?:recovered|before-recovery)-[^/]+$/

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

/**
 * A ref's object id read from the store's files (loose, then packed), synchronously; '' where they don't say, and null
 * while a jj write of Combwork's holds or waits on the store (HI-3012): not read then, as the store-gated history's own
 * answer is, so the evidence is unreadable rather than a target that seems to have gone. Read as '', a start's answer by
 * content looked changed beside Combwork's own jj operations and was refused instead of gathered again.
 */
function refSync(H: HistoryPort, store: string, ref: string): string | null {
  const key = pathKeySync(store)
  return key ? jjFileGate.readSync([storeKey(key)], () => H.refSync(store, ref) ?? '', null) : (H.refSync(store, ref) ?? '')
}

export class JjPlatform implements PlatformAdapter {
  readonly id = 'jj' as const
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

  /**
   * HI-3115: where the card's cycle (its last Started) stands with its slot's preparation, for a submit's `unbound`
   * advice: `pending` (no `SlotPrepared` yet: end the turn, the slot is prepared once the builder is idle), `held` (its
   * preparation waits on what the slot holds: the hold's own sentence, its last `SlotPrepareHeld`), else `other` (bound
   * to another card since: today's advice). Unreadable: `other`.
   */
  private slotState(card: CardRecord): { state: 'pending' | 'held' | 'other'; told: string } {
    try {
      const facts = this.wf?.store.facts(card.id) ?? []
      const at = facts.findLastIndex((f) => f.kind === 'Started')
      if (at < 0) return { state: 'other', told: '' }
      const since = facts.slice(at + 1)
      if (since.some((f) => f.kind === 'SlotPrepared')) return { state: 'other', told: '' }
      const held = since.findLast((f) => f.kind === 'SlotPrepareHeld')
      return held ? { state: 'held', told: (held.data as FactData['SlotPrepareHeld']).told } : { state: 'pending', told: '' }
    } catch {
      return { state: 'other', told: '' }
    }
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
    const r = await this.resolveTarget(card, o)
    return isUnknown(r) ? r : r.target
  }

  /**
   * HI-3129 (decision (a): a card keeps the bookmark it started on): a start's target. No kept slot (a
   * fresh start): the card's own, else the project's (a lane's: its Merges into). A kept slot (its committed work from
   * before it was put back, HI-2995): the target its binding names, proved (the slot's identity read, its binding this
   * card's at that generation), never the project's; unproved (anything unknown, missing or another card's) refused
   * `platform.keptOnTarget` `unread`, unknown never taken for fresh. Its own Merges into naming another bookmark is
   * refused (`mismatch`), and a lane card whose lane merges into another (`platform.keptLine`, as HI-3112's Git), both
   * before any slot is lent. `kept`: what the lend checks again before it records the target on the slot (`slotFor`).
   */
  private async resolveTarget(card: CardRecord, o: WorkflowOptions): Promise<Maybe<{ target: string | null; kept?: { slot: string; generation: string; target: string } }>> {
    const follows = card.target || o.target || null
    const kept = card.kind === 'no-code' || !this.wf ? null : await this.wf.cfg.keptHere?.(card)
    if (!kept) return { target: follows }
    const refuse = (why: 'unread' | 'mismatch', target = '', now = ''): Unknown => ({ ...unknown(UNREADABLE.target, { target: target || follows || '' }), rule: 'platform.keptOnTarget', ruleValues: { why, slot: kept.slot, target, now } })
    const proved = await this.provedKept(card, kept.folder)
    if (!proved) return refuse('unread')
    const { b, identity } = proved
    if (card.target && card.target !== b.target) return refuse('mismatch', b.target, card.target)
    const lane = card.lane ? this.wf!.lane(card.lane) : null
    if (lane && !lane.ended && o.target && o.target !== b.target) return { ...unknown(UNREADABLE.target, { target: b.target }), rule: 'platform.keptLine', ruleValues: { kept: b.target, target: o.target } }
    return { target: b.target, kept: { slot: kept.slot, generation: identity.generation, target: b.target } }
  }

  /** A kept slot's binding, proved for `card`: the slot's identity read and its binding this card's at that generation, with a target. */
  private async provedKept(card: CardRecord, folder: string): Promise<{ b: { target: string }; identity: { generation: string } } | null> {
    const port = this.deps?.port() ?? null
    const identity = port ? await port.identity!(folder) : null
    const b = port && identity && !isUnknown(identity) ? await port.binding(folder) : null
    if (!identity || isUnknown(identity) || !b || isUnknown(b) || b.card !== card.id || b.generation !== identity.generation || !b.target) return null
    return { b: { target: b.target }, identity: { generation: identity.generation } }
  }

  async keptWork(card: CardRecord): Promise<KeptWork> {
    if (card.kind === 'no-code' || !this.wf) return null
    const kept = await this.wf.cfg.keptHere?.(card)
    if (!kept) return null
    const proved = await this.provedKept(card, kept.folder)
    return proved ? { slot: kept.slot, target: proved.b.target } : { unproved: true, slot: kept.slot }
  }

  async start(card: CardRecord, o: WorkflowOptions, builder?: string, dry = false): Promise<Maybe<StartPlan>> {
    const d = this.deps
    if (!this.wf) return notYet()
    // A no-code card changes nothing: it starts where its agent is, with no line (as under Git).
    if (card.kind === 'no-code') return { folder: 'project', line: null, base: null, target: card.target || o.target || null }
    // HI-3129: its kept slot's bookmark, proved, before any slot is lent; else the card's or the project's.
    const resolved = await this.resolveTarget(card, o)
    if (isUnknown(resolved)) return resolved
    const target = resolved.target
    if (o.folder !== 'slots' || !this.wf.cfg.slotFor) return withDetail(unknown(UNREADABLE.folderFor, { branch: card.key }), say(START_TEXT.slots))
    // HI-3106: no target bookmark chosen (jj resolves no default): refused saying so, never "couldn't read" a blank name.
    // Asked before jj's card work is needed: what the project's options lack is said first.
    if (!target) return { ...withDetail(unknown(UNREADABLE.target, { target: '' }), say(START_TEXT.target)), rule: 'platform.noTarget' }
    if (!d) return notYet()
    const got = builder ? await this.wf.cfg.slotFor(card, builder, { dry, target, ...(resolved.kept ? { kept: resolved.kept } : {}) }) : null
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
      // Its own binding on another bookmark than the start's (changed since it was resolved): refused as that, never "couldn't read".
      if (b.target !== target) return { ...withDetail(unknown(UNREADABLE.target, { target }), say(START_TEXT.carryTarget, { slot: got.slot, target: b.target ?? '?' })), rule: 'platform.keptOnTarget', ruleValues: { why: 'mismatch', slot: got.slot, target: b.target ?? '', now: target ?? '' } } // i18n-ignore: a select's value, not text
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
    if (!s.started || s.stage === 'todo') {
      // HI-3129: the target the start will take (a kept slot's bookmark), else what it would follow; refused: as before.
      const r = card.kind === 'no-code' ? null : await this.resolveTarget(card, o)
      const target = r && !isUnknown(r) ? r.target : card.target || o.target || null
      return { view: null, folder: null, lease: null, holder: null, target, project: await this.ctxOf(this.wf.cfg.project) } satisfies Primed
    }
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
      const target = p.target ? refSync(this.H, p.project.store, `refs/heads/${p.target}`) : ''
      if (target === null) return null
      parts.push(`head:${head}`, p.target ? `target:${target}` : '')
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
    if (p.target) {
      const target = refSync(this.H, p.view.store, `refs/heads/${p.target}`)
      if (target === null) return null
      parts.push(`target:${target}`)
    }
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
      if (!owner) return { ok: false, refusal: this.refused(card, 'unbound', this.slotState(card)) }
      const b = await jjBoundary({ ...ctx, folder }, owner, { lock: d.lock(ctx.store) }, this.runner())
      // New files jj left out for its size limit (HI-2973): the work isn't all recorded, named for the agent to commit
      // (raising the limit) or ignore.
      if (boundaryRefused(b) && b.refused === 'tooLarge') return { ok: false, refusal: this.refused(card, 'tooLarge', { files: (b.files ?? []).slice(0, 10).join(', '), count: (b.files ?? []).length }) }
      // The user's snapshot.auto-track narrowed (HI-3096): new files aren't recorded by themselves, so the boundary
      // can't vouch the work is all recorded. Said as that, naming the setting, never "couldn't read the folder".
      if (boundaryRefused(b) && b.refused === 'autoTrack') return { ok: false, refusal: this.refused(card, 'autoTrack', { setting: b.detail ?? '' }) }
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
    if (!bound || bound.key !== s.started.line) return { ok: false, refusal: this.refused(card, 'unbound', this.slotState(card)) }
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
    // Recover…'s copies in any commit of the chain, not only its net change (HR1's HI-2996 round 1): a copy added and
    // deleted later is still in the history the integration takes. Every path a commit adds or changes, from the store;
    // a merge's against each of its parents (HR2's round 2: git log shows no merge's diff by default).
    const touched = await d.git(ctx.store, ['log', '--no-renames', '--diff-merges=separate', '--format=', '--name-only', '--diff-filter=d', '-z', `${base0}..${P.commit}`])
    if (!touched.ok) return { ok: false, refusal: this.unknownRefusal(card, unknown(UNREADABLE.commitsSince, { revision: P.commit.slice(0, 7), base: base0.slice(0, 7) }), 'submit') }
    const copies = [...new Set(touched.out.split('\0').map((x) => x.trim()).filter((x) => x && RECOVERY_COPY.test(x)))]
    if (copies.length) return { ok: false, refusal: this.refused(card, 'recovered', { files: copies.slice(0, 5).join(', ') + (copies.length > 5 ? ', …' : '') }) }
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

  /** jj's finishes went with HI-3483: nothing to read for a finish. */
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

  /** Nothing to reconcile: jj's finishes are gone (HI-3483), and the rest of this adapter goes with HI-3486. */
  async reconcile(): Promise<void> {}

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
