// Reconciliation (SPEC §16.4.4): observed facts are reconciled against recorded ones, never refused. Work done outside
// Hive counts: a commit or merge made in a terminal is observed and the rules never fight it. Observations name the
// observed fact they follow (their dedupe key), so two Hives observing one workspace write each transition once, and
// a writer that loses the race reads the platform again and writes only what is true now (§16.17).
//
// P2 spike (#1118): called by the tests where P3's watcher (refs, HEAD, packed-refs, the deliverables) will call it.

import { openEntry, passingReviewers, type CardState, type Fact } from '../../shared/workflow/facts'
import { hasStage } from '../../shared/workflow/compile'
import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import type { CardRecord } from './factStore'
import type { Workflow } from './runtime'

export interface ReconcileHooks {
  /** Called after the platform was read and before the write: where a test lets another observer act first. */
  afterRead?: () => void | Promise<void>
}

const UNFINISHED = ['active', 'review', 'approved', 'merging']

/** Cards working in the project folder that aren't finished (Active, Review, Approved). */
function sharedFolderCards(wf: Workflow): CardRecord[] {
  return wf.store.cards().filter((c) => UNFINISHED.includes(c.stage) && wf.state(c).started?.folder === 'project')
}

/**
 * Attribution in a shared folder (§16.3.2), recorded once when a commit is seen and never recomputed: a commit with a
 * card's trailer is that card's; else, if exactly one card of the folder is unfinished, that card's; else no card's,
 * listed for the user.
 */
export async function attributeFolder(wf: Workflow): Promise<void> {
  const project = wf.cfg.project
  const cards = sharedFolderCards(wf)
  const line = await G.branch(project)
  if (isUnknown(line) || !line) return
  const head = await G.lineHead(project, line)
  if (isUnknown(head) || !head) return
  const seenKey = `seen:${line}`
  let from = wf.store.meta(seenKey)
  if (!from) {
    // The first look: from the earliest base of the folder's unfinished cards.
    const bases = cards.map((c) => wf.state(c).started?.base).filter((b): b is string => !!b)
    if (!bases.length) {
      wf.store.setMeta(seenKey, head)
      return
    }
    from = bases[0]
    for (const b of bases.slice(1)) if ((await G.isAncestor(project, b, from)) === true) from = b
  }
  if (from === head) return
  const list = await G.commits(project, `${from}..${head}`)
  if (isUnknown(list)) return
  for (const c of list) {
    const byTrailer = c.cards.map((k) => wf.store.cardByKey(k)).find((x): x is CardRecord => !!x)
    const card = byTrailer ?? (cards.length === 1 ? cards[0] : null)
    const how = byTrailer ? 'trailer' : card ? 'onlyCard' : 'unattributed'
    if (!wf.store.recordFolderCommit(project, c.commit, card?.id ?? null, how)) continue
    if (!card) continue
    const s = wf.state(card)
    await wf.write(card, null, 'outside', (w) => {
      w.tx.appendObserved(card.id, { kind: 'CommitAttributed', actor: 'outside', source: 'observed', dedupe: `commit:${c.commit}`, data: { commit: c.commit, how: how as 'trailer' | 'onlyCard' } })
      // A shared-folder card's revision is its newest commit: working revisions, never an integration.
      if (UNFINISHED.includes(card.stage) || card.stage === 'todo') w.tx.appendObserved(card.id, { kind: 'HeadMoved', actor: 'outside', source: 'observed', dedupe: `prev:${s.lastHeadFact}`, data: { line, from: s.head, to: c.commit } })
    })
  }
  wf.store.setMeta(seenKey, head)
}

/**
 * Records an observed head change once (the dedupe key names the fact it follows). When another observer already wrote
 * a fact after the same one, reads the winner and the platform now, and writes only what is true now, after it.
 */
async function observeHead(wf: Workflow, card: CardRecord, read: () => Promise<string | null | { unknown: true }>, line: string | null, hooks: ReconcileHooks): Promise<void> {
  // The view this observer read the log at (the fact it follows), then the platform.
  let s = wf.state(card)
  let now = await read()
  await hooks.afterRead?.()
  let prev = s.lastHeadFact
  let from = s.head
  for (let tries = 0; tries < 5; tries++) {
    if (isUnknown(now)) return
    if (now === from) return
    const wrote = wf.store.tx((tx) => tx.appendObserved(card.id, { kind: 'HeadMoved', actor: 'outside', source: 'observed', dedupe: `prev:${prev}`, data: { line, from, to: now as string | null } }))
    if (wrote) return
    // Lost the race: read the winner and the platform now.
    s = wf.state(card)
    prev = s.lastHeadFact
    from = s.head
    now = await read()
  }
}

/** Reconciles one card with the platform (§16.4.4's table). */
export async function reconcile(wf: Workflow, card0: CardRecord, hooks: ReconcileHooks = {}): Promise<void> {
  let card = wf.store.card(card0.id)
  let s = wf.state(card)
  if (!s.started) return
  const r = wf.rulesetOf(card, s)
  const o = r.options
  const project = wf.cfg.project

  if (o.platform === 'none') return reconcileNone(wf, card, s)

  if (!wf.ownLine(s)) {
    // A shared folder: attribution; its commits are working revisions, never an integration (§16.4.4).
    await attributeFolder(wf)
    if (card.stage !== 'done') return
  } else if (card.stage !== 'done') {
    const line = s.started.line!
    await observeHead(wf, card, () => G.lineHead(project, line), line, hooks)
    s = wf.state(card)
    const lh = await G.lineHead(project, line)
    if (lh === null) await wf.write(card, null, 'outside', (w) => w.tx.appendObserved(card.id, { kind: 'Gone', actor: 'outside', source: 'observed', dedupe: `gone:line:${s.cycle}`, data: { what: 'line' } }))
  }

  card = wf.store.card(card.id)
  s = wf.state(card)
  const target = s.started!.target ?? ''
  const base = s.started!.base
  const entry = openEntry(s)
  // The queue is mid-advance: its own recovery settles the entry (§16.4.5).
  if (entry?.state === 'started') return

  if ((card.stage === 'approved' || card.stage === 'merging') && s.approved?.revision && s.approved.base) {
    const approved = { base: s.approved.base, revision: s.approved.revision, key: s.latest?.key }
    // Found in the target, not by Hive → Done (outside); the queue drops the entry; the lane counts it.
    if (approved.revision !== base) {
      const c = await G.contains(project, target, approved)
      if (!isUnknown(c) && c) return integratedOutside(wf, card, s, approved.revision, c.method, [])
    }
    // A new revision after a pass: the same change carries over, another goes stale (§16.4.4).
    if (wf.ownLine(s) && s.head && s.head !== approved.revision && !s.stale) {
      const th = await G.lineHead(project, target)
      const b2 = !isUnknown(th) && th ? await G.mergeBase(project, th, s.head) : null
      const same = o.sameness === 'change' && !!b2 && !isUnknown(b2) && (await G.sameChange(project, approved, { base: b2, revision: s.head }))
      const head = s.head
      await wf.write(card, r, 'hive', (w) => {
        if (same) {
          w.fact('CarriedOver', { from: approved.revision, to: head, toBase: b2 as string, how: 'replay' })
          return
        }
        w.fact('Stale', { approved: approved.revision, current: head, why: o.sameness === 'exact' ? 'exact' : 'change' })
        if (entry) w.fact('IntegrationCancelled', { entry: entry.id, reason: 'stale' })
        w.move('approved', 'derived')
        wf.wake(w, s.started?.builder, `${card.key}: stale, submit again`)
      })
    }
    return
  }

  if (card.stage === 'review' && wf.ownLine(s) && s.latest?.revision && s.latest.base && s.latest.revision !== base) {
    // Merged by hand before its review passed: Done, marked outside the rules (OP-25); never moved back.
    const c = await G.contains(project, target, { base: s.latest.base, revision: s.latest.revision, key: s.latest.key })
    if (!isUnknown(c) && c) return integratedOutside(wf, card, s, s.latest.revision, c.method, ['review'])
    return
  }

  if (card.stage === 'active' && wf.ownLine(s) && s.head && base && s.head !== base) {
    // Some of its work in the target (a partial hand merge): a mark; the card stays where it is.
    const th = await G.lineHead(project, target)
    if (isUnknown(th) || !th) return
    const mb = await G.mergeBase(project, th, s.head)
    if (isUnknown(mb) || !mb || mb === base) return
    if ((await G.isAncestor(project, base, mb)) !== true) return
    await wf.write(card, null, 'outside', (w) => w.tx.appendObserved(card.id, { kind: 'MergedInPart', actor: 'outside', source: 'observed', dedupe: `part:${s.cycle}:${mb}`, data: { revision: mb, target } }))
    return
  }

  if (card.stage === 'done' && s.integrated && s.integrated.method !== 'committed') {
    // A Done card's revision no longer in the target (the target was reset): a warning mark; it stays Done.
    const i = s.integrated
    const th = await G.lineHead(project, i.target)
    if (isUnknown(th) || !th) return
    const sub = s.latest
    const c = await G.contains(project, i.target, { base: s.approved?.base ?? sub?.base ?? base ?? i.revision, revision: i.revision, key: sub?.key })
    const resultIn = await G.isAncestor(project, i.result, th)
    if (!isUnknown(c) && !c && resultIn === false && !s.marks.leftTarget) await wf.write(card, null, 'outside', (w) => w.tx.appendObserved(card.id, { kind: 'LeftTarget', actor: 'outside', source: 'observed', dedupe: `left:${s.cycle}:${th}`, data: { revision: i.revision, target: i.target } }))
  }
}

async function integratedOutside(wf: Workflow, card: CardRecord, s: CardState, revision: string, method: 'merge' | 'fastForward' | 'squash' | 'sameTree', outsideRules: string[]): Promise<void> {
  const target = s.started!.target ?? ''
  const th = await G.lineHead(wf.cfg.project, target)
  const entry = openEntry(s)
  await wf.write(card, wf.rulesetOf(card, s), 'outside', (w) => {
    // Unique per cycle: two Hives observing the same merge write one `Integrated` (§16.17).
    const f = w.tx.appendObserved(card.id, { kind: 'Integrated', actor: 'outside', source: 'observed', dedupe: `cycle:${s.cycle}`, data: { revision, target, result: !isUnknown(th) && th ? th : revision, method, by: 'outside', ...(outsideRules.length ? { outsideRules } : {}) } })
    if (!f) return
    w.written.push(f as Fact)
    if (entry) w.fact('IntegrationCancelled', { entry: entry.id, reason: 'integratedOutside' })
    w.move('done', 'derived')
    w.action('endLaneIfDone', {})
    w.action('releaseSlot', {})
  })
}

/** None: an edit to a card's paths after a pass makes the pass stale (§16.3.3); files outside its paths never do. */
async function reconcileNone(wf: Workflow, card: CardRecord, s: CardState): Promise<void> {
  if (card.stage !== 'review' || !passingReviewers(s).length || s.stale) return
  const now = wf.none.revision(card.paths ?? [])
  if (isUnknown(now) || now.revision === s.approved?.revision) return
  const r = wf.rulesetOf(card, s)
  await wf.write(card, r, 'outside', (w) => {
    w.fact('Stale', { approved: s.approved?.revision ?? null, current: now.revision, why: 'change' })
    if (!hasStage(r, 'review')) w.move('active', 'derived')
    wf.wake(w, s.started?.builder, `${card.key}: your paths changed since the pass, submit again`)
  })
}
