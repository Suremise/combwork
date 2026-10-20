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
import type { CheckBracket, FinishInputs, HeadMove, PlatformAdapter, StartPlan, SubmitPlan } from './adapter'
import { NoneAdapter } from './none'
import { isUnknown, type Containment, type Maybe } from './types'

export class NonePlatform implements PlatformAdapter {
  readonly id = 'none' as const

  constructor(
    private wf: Workflow,
    readonly hashing: NoneAdapter
  ) {}

  async start(card: CardRecord): Promise<Maybe<StartPlan>> {
    const rev = this.hashing.revision(card.paths ?? [])
    if (isUnknown(rev)) return rev
    // Every deliverable's hash at the start, kept in Started: what unclaimed changes are found against.
    const all = this.hashing.deliverables()
    const deliverables = isUnknown(all) ? undefined : this.hashing.manifest(all)
    return { folder: 'project', line: null, base: rev.revision, target: null, manifest: rev.manifest, ...(deliverables && !isUnknown(deliverables) ? { deliverables } : {}) }
  }

  async prime(): Promise<unknown> {
    return null
  }

  /** The card's paths' hash now (the hash cache follows writes and file times, so an edit since shows). */
  evidence(card: CardRecord): string | null {
    const r = this.hashing.revision(this.wf.store.card(card.id).paths ?? [])
    return isUnknown(r) ? null : r.revision
  }

  async revisionNow(card: CardRecord): Promise<Maybe<string | null>> {
    if (card.kind === 'no-code') return null
    const r = this.hashing.revision(card.paths ?? [])
    return isUnknown(r) ? r : r.revision
  }

  /** None's submission: the card's declared paths (pre-filled from what its agents changed if it has none yet). */
  async submission(card: CardRecord, s: CardState): Promise<SubmitPlan> {
    const paths = card.paths ?? []
    const rev = this.hashing.revision(paths)
    if (isUnknown(rev)) return { ok: false, refusal: { rule: 'platform.unknown', values: { card: card.key, what: rev.what, rule: 'submit' } } }
    const files = NoneAdapter.diff(s.started!.manifest ?? {}, rev.manifest)
    if (!files.length && rev.revision === s.started!.base) return { ok: false, refusal: { rule: 'submit.empty', values: { card: card.key } } }
    return { ok: true, revision: rev.revision, base: s.started!.base, key: rev.revision, files, paths, inputs: {}, warnings: [] }
  }

  async finishInputs(card: CardRecord): Promise<FinishInputs> {
    if (card.kind === 'no-code') return {}
    const now = this.hashing.revision(this.wf.store.card(card.id).paths ?? [])
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
    const ok = run.command ? (await run.exec(run.command, project)).ok : false
    for (const f of files) this.hashing.invalidate(f)
    const after = this.hashing.revision(paths)
    const snapB = await snapshot(project, files, null)
    let whyNot: CheckBracket['whyNot']
    if (!run.command) whyNot = 'notCheck'
    else if (isUnknown(before) || isUnknown(after) || before.revision !== after.revision) whyNot = 'revisionChanged'
    else if (snapA !== snapB) whyNot = 'changed'
    return { revision: isUnknown(before) ? '' : before.revision, tested: isUnknown(after) ? '' : after.revision, ok, ...(whyNot ? { whyNot } : {}) }
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
