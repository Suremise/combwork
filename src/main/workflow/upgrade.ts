// Cards at the upgrade to 1.0 (SPEC §16.17): evidence, never an invented history. Done, On Hold and Todo cards get no
// facts (before 1.0); cards in flight get an `Adopted` fact, a Review card an adopted submission at its line's head,
// and a Passed card no verdict (a pass can't be tied to a revision history doesn't prove).
//
// P2 spike (#1118): the adoption step; P3's migration runs it over every card in one schema step.

import { join } from 'path'
import type { FactData, StageId } from '../../shared/workflow/facts'
import { allOff, type WorkflowOptions } from '../../shared/workflow/options'
import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import type { CardRecord } from './factStore'
import type { Workflow } from './runtime'

/**
 * The options at the upgrade (§16.17, OP-22): matching how the project works today. Git: Not checked, the folder as its
 * agents work, every check off, and a reviewer agent if the project has reviewer agents or a lane.
 */
export function upgradeOptions(platform: 'git' | 'none', has: { reviewers: boolean; worktrees: boolean }): WorkflowOptions {
  const o = allOff(platform)
  return { ...o, review: has.reviewers ? 'agent' : 'none', noSelfReview: has.reviewers, folder: platform === 'git' && has.worktrees ? 'slots' : 'project' }
}

/** Adopts one card in flight: its column at the upgrade, the agent working it and its folder (a worktree, or the project). */
export async function adopt(wf: Workflow, card: CardRecord, column: 'doing' | 'review' | 'passed', at: { agent: string; worktree?: string; target: string }): Promise<void> {
  const folder = at.worktree ?? wf.cfg.project
  const line = await G.branch(folder)
  const h = await G.head(folder)
  const th = await G.lineHead(wf.cfg.project, at.target)
  const mb = !isUnknown(h) && !isUnknown(th) && th ? await G.mergeBase(wf.cfg.project, th, h) : null
  const head = isUnknown(h) ? null : h
  const base = mb && !isUnknown(mb) ? mb : null
  const r = wf.currentRuleset()
  wf.store.saveRuleset(r)
  const stage: StageId = column === 'doing' ? 'active' : column === 'review' ? 'review' : 'approved'
  const data: FactData['Adopted'] = { folder: at.worktree ? join(at.worktree) : 'project', line: isUnknown(line) ? null : line, base, target: at.target, builder: at.agent, cardKind: card.kind, adoptedFrom: column, ...(column === 'passed' ? { passedBefore1_0: true } : {}) }
  let files: FactData['Submitted']['files'] = []
  let key: string | null = null
  if (column === 'review' && head && base) {
    const c = await G.change(wf.cfg.project, base, head)
    if (!isUnknown(c)) ({ files, key } = c)
  }
  await wf.write(card, r, 'hive', (w) => {
    // Once per card: a rerun of the upgrade, or a second Hive running it, adds nothing.
    if (!w.tx.appendObserved(card.id, { kind: 'Adopted', actor: 'hive', source: 'observed', ruleset: r.id, dedupe: 'adopted', data })) return
    if (column === 'review') w.tx.appendObserved(card.id, { kind: 'Submitted', actor: `agent:${at.agent}`, source: 'observed', ruleset: r.id, dedupe: 'adopted', data: { revision: head, base, head, key, files, round: 1, generation: 0, sameRevision: false, summary: '', adopted: true } })
    w.move(stage, 'derived')
  })
}
