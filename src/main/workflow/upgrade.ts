// Cards at the upgrade to 1.0 (SPEC §16.17): evidence, never an invented history. Done, On Hold and Todo cards get no
// facts (before 1.0); cards in flight get an `Adopted` fact, a Review card an adopted submission at its line's head,
// and a Passed card no verdict (a pass can't be tied to a revision history doesn't prove).
//
// P2 spike (#1118), split for P3 (#1218): what a card's adoption reads of the platform (`adoptionInputs`, git, slow:
// outside the board's transaction) and what it writes (`writeAdoption`, inside it). adoption.ts runs them over a
// workspace after the migration; `adopt` is the spike runtime's one-card form.

import { join } from 'path'
import type { FactData, StageId } from '../../shared/workflow/facts'
import type { Ruleset } from '../../shared/workflow/compile'
import { allOff, type WorkflowOptions } from '../../shared/workflow/options'
import type { PlatformId } from '../../shared/platform/descriptors'
import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import type { CardRecord, Tx } from './factStore'
import type { Workflow } from './runtime'

/**
 * The options at the upgrade (§16.17, OP-22): matching how the project works today. Git: Not checked, the folder as its
 * agents work, every check off, and a reviewer agent if the project has reviewer agents or a lane.
 */
export function upgradeOptions(platform: PlatformId, has: { reviewers: boolean; worktrees: boolean }): WorkflowOptions {
  const o = allOff(platform)
  return { ...o, review: has.reviewers ? 'agent' : 'none', noSelfReview: has.reviewers, folder: platform === 'git' && has.worktrees ? 'slots' : 'project' }
}

/** The column a card in flight was in at the upgrade. */
export type InFlight = 'doing' | 'review' | 'passed'

/** Where a card in flight works: its agent (its id), its worktree if it has one, and the line it merges into. */
export interface AdoptionAt {
  agent: string
  worktree?: string
  target: string | null
}

/** What a card's adoption read of the platform: each null when unknown (never a failure: the fact says it). */
export interface AdoptionInputs {
  line: string | null
  head: string | null
  base: string | null
  files: FactData['Submitted']['files']
  key: string | null
}

const NONE_READ: AdoptionInputs = { line: null, head: null, base: null, files: [], key: null }

/**
 * What a card in flight's adoption needs of the platform (slow: git; outside the board's transaction): its folder's line
 * and head, the merge base with its target, and for a Review card the change submitted (its files and key). None, or a
 * folder git can't read: unknown (null), never a failure.
 */
export async function adoptionInputs(project: string, platform: PlatformId, column: InFlight, at: AdoptionAt): Promise<AdoptionInputs> {
  if (platform !== 'git') return NONE_READ
  const folder = at.worktree ?? project
  const line = await G.branch(folder)
  const h = await G.head(folder)
  const th = at.target ? await G.lineHead(project, at.target) : null
  const mb = !isUnknown(h) && th && !isUnknown(th) ? await G.mergeBase(project, th, h) : null
  const head = isUnknown(h) ? null : h
  const base = mb && !isUnknown(mb) ? mb : null
  let files: AdoptionInputs['files'] = []
  let key: string | null = null
  if (column === 'review' && head && base) {
    const c = await G.change(project, base, head)
    if (!isUnknown(c)) ({ files, key } = c)
  }
  return { line: isUnknown(line) ? null : line, head, base, files, key }
}

/**
 * Writes a card's adoption (inside the board's transaction): `Adopted`, a Review card's adopted `Submitted`, and the move
 * to the stage its column stands for. Once per card (the dedupe `adopted`): false when it already was, by a rerun or
 * another Combwork, and nothing is written.
 */
export function writeAdoption(tx: Tx, card: CardRecord, ruleset: Ruleset, column: InFlight, at: AdoptionAt, inp: AdoptionInputs, move: (to: StageId) => void): boolean {
  const data: FactData['Adopted'] = { folder: at.worktree ? join(at.worktree) : 'project', line: inp.line, base: inp.base, head: inp.head, target: at.target, builder: at.agent, cardKind: card.kind, adoptedFrom: column, ...(column === 'passed' ? { passedBefore1_0: true } : {}) }
  if (!tx.appendObserved(card.id, { kind: 'Adopted', actor: 'combwork', source: 'observed', ruleset: ruleset.id, dedupe: 'adopted', data })) return false // i18n-ignore: a fact's kind and codes, not text
  if (column === 'review') tx.appendObserved(card.id, { kind: 'Submitted', actor: `agent:${at.agent}`, source: 'observed', ruleset: ruleset.id, dedupe: 'adopted', data: { revision: inp.head, base: inp.base, head: inp.head, key: inp.key, files: inp.files, round: 1, generation: 0, sameRevision: false, summary: '', adopted: true } }) // i18n-ignore: a fact's kind and codes, not text
  move(column === 'doing' ? 'active' : column === 'review' ? 'review' : 'approved')
  return true
}

/** Adopts one card in flight through the spike's runtime (its folder: a worktree, or the project). */
export async function adopt(wf: Workflow, card: CardRecord, column: InFlight, at: { agent: string; worktree?: string; target: string }): Promise<void> {
  const inp = await adoptionInputs(wf.cfg.project, 'git', column, at)
  const r = wf.currentRuleset()
  wf.store.saveRuleset(r)
  await wf.write(card, r, 'combwork', (w) => {
    writeAdoption(w.tx, card, r, column, at, inp, (to) => w.move(to, 'derived'))
  })
}
