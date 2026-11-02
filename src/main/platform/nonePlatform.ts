// The None platform behind the adapter interface (SPEC §16.3.3): no version control, not no workflow. A card's revision
// is the hash of its declared paths, a change is their manifests, integration is acceptance, and nothing is contained
// by ancestry (an `Accepted` fact says what was accepted).
//
// P2 spike (#1118): not wired into the app yet.

import type { CardState } from '../../shared/workflow/facts'
import type { GuardRefusal } from '../../shared/workflow/guards'
import type { CardRecord } from '../workflow/factStore'
import { reconcileNone, type ReconcileHooks } from '../workflow/reconcile'
import { snapshot } from '../workflow/checks'
import type { Workflow } from '../workflow/runtime'
import type { CheckBracket, FinishInputs, HeadMove, PlatformAdapter, RunRevision, StartPlan, SubmitPlan } from './adapter'
import { NoneAdapter } from './none'
import { readBaseline, readCheckPoint } from '../noneBaseline'
import { observer, type Disposable, type ObserveEvent } from './observe'
import { isUnknown, type Containment, type Maybe } from './types'

export class NonePlatform implements PlatformAdapter {
  readonly id = 'none' as const

  constructor(
    private wf: Workflow,
    readonly hashing: NoneAdapter
  ) {}

  async start(card: CardRecord, _o?: unknown, _builder?: string, dry = false): Promise<Maybe<StartPlan>> {
    // A no-code card has no content revision (HI-2340): nothing of the project is read for it, its declared paths
    // either (a kind changed later keeps them), and nothing reads its base, manifest or baseline.
    if (card.kind === 'no-code') return { folder: 'project', line: null, base: null, target: null, manifest: {} }
    const rev = this.hashing.revision(card.paths ?? [])
    if (isUnknown(rev)) return rev
    if (dry) return { folder: 'project', line: null, base: rev.revision, target: null, manifest: rev.manifest }
    // Every deliverable's hash at the start, kept in Started: what unclaimed changes are found against. Read whole off
    // main's thread (HI-2340); the generation it was read under is checked again at the write. Unreadable, or no
    // answer (its worker ended, the read too long): no baseline, as before.
    const baselineGen = this.hashing.generation
    const deliverables = await readBaseline(this.hashing)
    return { folder: 'project', line: null, base: rev.revision, target: null, manifest: rev.manifest, baselineGen, ...(deliverables && !isUnknown(deliverables) ? { deliverables } : {}) }
  }

  async prime(): Promise<unknown> {
    return null
  }

  /** None has no target: its evidence is its paths. */
  planCovered(): boolean {
    return true
  }

  /** None's fingerprint is already its paths' content hash: nothing more to ask. */
  async content(): Promise<string | null> {
    return null
  }

  /**
   * The card's paths' hash now (the hash cache follows writes and file times, so an edit since shows). A no-code card
   * has no content to hash (HI-2340): its kind, as the board has it now, so a kind changed meanwhile is evidence changed.
   */
  evidence(card: CardRecord): string | null {
    const now = this.wf.store.card(card.id)
    if (now.kind === 'no-code') return 'no-code'
    const r = this.hashing.revision(now.paths ?? [])
    return isUnknown(r) ? null : r.revision
  }

  async revisionNow(card: CardRecord): Promise<Maybe<string | null>> {
    if (card.kind === 'no-code') return null
    const r = this.hashing.revision(card.paths ?? [])
    return isUnknown(r) ? r : r.revision
  }

  /**
   * The card's paths' hash: what the run is for and what it is tested on (its content is its revision); a name is a hash
   * as given. Read off main's thread (HI-2358, HR3's round 1): a progress run's link resolves it before its check starts,
   * and for a card declaring `.` or a big folder it is the project read whole. A no-code card has none; no answer (its
   * worker ended, or the read took too long) is none, as an unreadable one was.
   */
  async runRevision(card: CardRecord, _s: CardState, _folder: string | null, named: string | null): Promise<RunRevision> {
    const p = card.kind === 'no-code' ? null : await readCheckPoint({ project: this.hashing.project, excluded: this.hashing.excludedNames, caseless: this.hashing.caseless, paths: card.paths ?? [], snapshot: false })
    const revision = p?.revision ?? null
    return { revision, tested: revision, testedIs: 'content', ...(named !== null ? { named } : {}) }
  }

  /** None's submission: the card's declared paths (pre-filled from what its agents changed if it has none yet). */
  async submission(card: CardRecord, s: CardState): Promise<SubmitPlan> {
    const paths = card.paths ?? []
    const rev = this.hashing.revision(paths)
    if (isUnknown(rev)) return { ok: false, refusal: { rule: 'platform.unknown', values: { card: card.key, what: rev.whatText ?? rev.what, rule: 'submit' } } }
    // A starting manifest recorded before #1511 may hold a path now left out: left out of the change too.
    const files = NoneAdapter.diff(this.hashing.covering(s.started!.manifest ?? {}), rev.manifest)
    if (!files.length && rev.revision === s.started!.base) return { ok: false, refusal: { rule: 'submit.unchanged', values: { card: card.key } } }
    // Paths stored from before #1511 under an excluded folder: left out of the revision, and said so.
    const left = this.hashing.leftOut(paths)
    const warnings = left.length ? [`left out of ${card.key}'s revision: ${left.join(', ')} (under .hive, .git or a folder the project excludes, never part of a card's work); declare its paths again without them`] : [] // i18n-ignore: agent-facing warning in the submit's reply
    return { ok: true, revision: rev.revision, base: s.started!.base, key: rev.revision, files, paths, inputs: {}, warnings }
  }

  async finishInputs(card: CardRecord): Promise<FinishInputs> {
    if (card.kind === 'no-code') return {}
    // The paths the submission sets (a drag's, not written yet), else the card's as stored.
    const now = this.hashing.revision(card.paths ?? this.wf.store.card(card.id).paths ?? [])
    return { currentRevision: isUnknown(now) ? now : now.revision }
  }

  /** None has no head to move: an edit is a new revision, found at acceptance or by reconciliation. */
  async headMoved(): Promise<HeadMove | null> {
    return null
  }

  async contains(): Promise<Maybe<Containment | null>> {
    return null
  }

  async targetHead(): Promise<Maybe<string | null>> {
    return null
  }

  reconcile(card: CardRecord, hooks: ReconcileHooks): Promise<void> {
    void hooks
    return reconcileNone(this.wf, card, this.wf.state(card))
  }

  /** None's check (§16.13): the card's revision from its declared paths at the start and the end, and no deliverable written between. */
  async checkRun(card: CardRecord, _s: CardState, run: { command: string | undefined; exec: (command: string, folder: string) => Promise<{ ok: boolean }> }): Promise<CheckBracket | GuardRefusal> {
    const project = this.wf.cfg.project
    const paths = card.paths ?? []
    const before = this.hashing.revision(paths)
    const all = this.hashing.deliverables()
    const files = isUnknown(all) ? [] : all
    const snapA = await snapshot(project, files, null)
    const t0 = Date.now()
    const ok = run.command ? (await run.exec(run.command, project)).ok : false
    // The watcher's write log, its deliverables only; where it has no complete record of the run, the stat snapshots.
    const seen = await observer.changedBetween(project, t0, Date.now(), (written) => written.filter((f) => this.hashing.isDeliverable(f)))
    for (const f of files) this.hashing.invalidate(f)
    const after = this.hashing.revision(paths)
    const snapB = await snapshot(project, files, null)
    let whyNot: CheckBracket['whyNot']
    if (!run.command) whyNot = 'notCheck'
    else if (isUnknown(before) || isUnknown(after) || before.revision !== after.revision) whyNot = 'revisionChanged'
    else if (isUnknown(seen) ? snapA !== snapB : seen.changed) whyNot = 'changed'
    return { revision: isUnknown(before) ? '' : before.revision, tested: isUnknown(after) ? '' : after.revision, ok, ...(whyNot ? { whyNot } : {}) }
  }

  /** The watcher's events; a deliverable written loses its cached hash first (§16.3.3), even if its size and time didn't change. */
  observe(onChange: (e: ObserveEvent) => void): Disposable {
    return observer.subscribe(this.wf.cfg.project, (e) => {
      if (e.kind === 'written') for (const p of e.paths) this.hashing.invalidate(p)
      onChange(e)
    })
  }

  /** No check copies: no isolation in 1.0 (OP-16); the remedy is running again when the deliverables are quiet. */
  async checkCopy(): Promise<string | null> {
    return null
  }

  async perform(kind: string): Promise<boolean> {
    // Nothing to pin or prepare: the content is the revision, and everyone works in the project folder (OP-16).
    return kind === 'pin' || kind === 'prepareSlot'
  }
}
