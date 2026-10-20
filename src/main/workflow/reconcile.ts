// Reconciliation (SPEC §16.4.4): observed facts are reconciled against recorded ones, never refused. Work done outside
// Hive counts: a commit or merge made in a terminal is observed and the rules never fight it. Observations name the
// observed fact they follow (their dedupe key), so two Hives observing one workspace write each transition once, and
// a writer that loses the race reads the platform again and writes only what is true now (§16.17).
//
// Called by the app's reconciler (reconciler.ts, #1217) on the watcher's events, and by the runtime's tests. **P3 is
// record-only**: the table's moves (Done when integrated outside, a stale card moved back), queue cancellations and wakes
// run only with the runtime's `reconcileActs`, which P4 turns on; without it, what is observed is recorded and nothing
// else changes. Every write goes through the runtime's lock (`wf.locked`: the board's change, in the app).

import { statSync } from 'original-fs'
import { join } from 'path'
import { foldCard, openEntry, passingReviewers, type CardState, type Fact, type FactData } from '../../shared/workflow/facts'
import { hasStage } from '../../shared/workflow/compile'
import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import type { CardRecord } from './factStore'
import type { Workflow, Write } from './runtime'

export interface ReconcileHooks {
  /** Called after the platform was read and before the write: where a test lets another observer act first. */
  afterRead?: () => void | Promise<void>
  /**
   * Told when a read this reconciliation needed couldn't be made (unknown): what it would have recorded is undecided, so
   * a caller keeping a checkpoint (the app's Done targets) doesn't move it past this card (HR4's #1217 round 2).
   */
  unknown?: (what: string) => void
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
  // Each card's cycle as read: attribution decided on these is written only while they are still the folder's cards.
  const cycles = new Map(cards.map((c) => [c.id, wf.state(c).cycle]))
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
      await wf.locked(() => wf.store.setMeta(seenKey, head))
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
    // The folder's record, the card's facts and the cursor in one transaction: a crash keeps all or none of them.
    const kept = await wf.locked(() =>
      wf.store.tx((tx) => {
        // The folder's cards as they are now, under the lock (HR4's #1217 round 1): one started, finished or in a new cycle
        // since they were read, and this attribution (immutable once written) waits: the next run reads from the cursor.
        const now = sharedFolderCards(wf)
        if (now.length !== cards.length || now.some((x) => cycles.get(x.id) !== wf.state(x).cycle)) return false
        if (!tx.recordFolderCommit(project, c.commit, card?.id ?? null, how)) return true
        if (card) {
          const s = foldCard(tx.facts(card.id))
          tx.appendObserved(card.id, { kind: 'CommitAttributed', actor: 'outside', source: 'observed', dedupe: `commit:${c.commit}`, data: { commit: c.commit, how: how as 'trailer' | 'onlyCard' } })
          // A shared-folder card's revision is its newest commit: working revisions, never an integration.
          const stage = tx.card(card.id).stage
          if (UNFINISHED.includes(stage) || stage === 'todo') tx.appendObserved(card.id, { kind: 'HeadMoved', actor: 'outside', source: 'observed', dedupe: `prev:${s.lastHeadFact}`, data: { line, from: s.head, to: c.commit } })
        }
        tx.setMeta(seenKey, c.commit)
        return true
      })
    )
    if (!kept) return
  }
  await wf.locked(() => wf.store.setMeta(seenKey, head))
}

/**
 * Records an observed head change once (the dedupe key names the fact it follows). When another observer already wrote
 * a fact after the same one, reads the winner and the platform now, and writes only what is true now, after it.
 */
async function observeHead(wf: Workflow, card: CardRecord, read: () => Promise<string | null | { unknown: true }>, line: string | null, hooks: ReconcileHooks): Promise<void> {
  // The view this observer read the log at (the fact it follows), then the platform.
  let s = wf.state(card)
  const cycle = s.cycle
  let now = await read()
  await hooks.afterRead?.()
  let prev = s.lastHeadFact
  let from = s.head
  for (let tries = 0; tries < 5; tries++) {
    if (isUnknown(now)) return
    if (now === from) return
    const to = now as string | null
    // Written only after the fact it was read after, in the cycle it was read in (HR4's #1217 round 1): a new cycle
    // since (the card started again) drops it; another fact since is a lost race.
    const wrote = await wf.locked(() =>
      wf.store.tx((tx) => {
        const cur = foldCard(tx.facts(card.id))
        if (cur.cycle !== cycle) return 'cycle' as const
        if (cur.lastHeadFact !== prev) return null
        return tx.appendObserved(card.id, { kind: 'HeadMoved', actor: 'outside', source: 'observed', dedupe: `prev:${prev}`, data: { line, from, to } })
      })
    )
    if (wrote === 'cycle' || wrote) return
    // Lost the race: read the winner and the platform now.
    s = wf.state(card)
    if (s.cycle !== cycle) return
    prev = s.lastHeadFact
    from = s.head
    now = await read()
  }
}

/** Reconciles one card with its platform (§16.4.4's table): the card's platform adapter observes and records. */
export async function reconcile(wf: Workflow, card: CardRecord, hooks: ReconcileHooks = {}): Promise<void> {
  const c = wf.store.card(card.id)
  const s = wf.state(c)
  if (!s.started) return
  return wf.platformOf(c, s).reconcile(c, hooks)
}

/** The Git adapter's reconciliation: observed heads, attribution in a shared folder, containment, carry-over and stale. */
export async function reconcileGit(wf: Workflow, card0: CardRecord, hooks: ReconcileHooks = {}): Promise<void> {
  let card = wf.store.card(card0.id)
  let s = wf.state(card)
  if (!s.started) return
  const r = wf.rulesetOf(card, s)
  const o = r.options
  const project = wf.cfg.project

  // Gone (§16.4.4), only for what doesn't exist (an unreadable folder is unknown, not gone): the repository, then the
  // card's own folder. Recorded once per cycle.
  const s0 = s
  if (presence(project) === 'gone' || (presence(join(project, '.git')) === 'gone' && isUnknown(await G.commonDir(project)))) {
    await wf.write(card, null, 'outside', (w) => sameCycle(w, s0) && w.tx.appendObserved(card.id, { kind: 'Gone', actor: 'outside', source: 'observed', dedupe: `gone:repository:${s0.cycle}`, data: { what: 'repository' } })) // i18n-ignore: a fact's kind and codes, not text
    return
  }
  if (wf.ownLine(s) && card.stage !== 'done' && presence(s.started.folder) === 'gone') {
    await wf.write(card, null, 'outside', (w) => sameCycle(w, s0) && w.tx.appendObserved(card.id, { kind: 'Gone', actor: 'outside', source: 'observed', dedupe: `gone:folder:${s0.cycle}`, data: { what: 'folder' } })) // i18n-ignore: a fact's kind and codes, not text
  }
  await observeTarget(wf, card, s, hooks)

  if (!wf.ownLine(s)) {
    // A shared folder: attribution; its commits are working revisions, never an integration (§16.4.4).
    await attributeFolder(wf)
    if (card.stage !== 'done') return
  } else if (card.stage !== 'done') {
    const line = s.started.line!
    await observeHead(wf, card, () => G.lineHead(project, line), line, hooks)
    s = wf.state(card)
    const lh = await G.lineHead(project, line)
    if (lh === null) await wf.write(card, null, 'outside', (w) => sameCycle(w, s) && w.tx.appendObserved(card.id, { kind: 'Gone', actor: 'outside', source: 'observed', dedupe: `gone:line:${s.cycle}`, data: { what: 'line' } })) // i18n-ignore: a fact's kind and codes, not text
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
        if (!sameCycle(w, s)) return
        // Observed once per cycle and revision (§16.17): two Hives seeing the same new revision write one fact.
        if (same) {
          observed(w, 'CarriedOver', `carried:${s.cycle}:${head}`, { from: approved.revision, to: head, toBase: b2 as string, how: 'replay' })
          return
        }
        if (!observed(w, 'Stale', `stale:${s.cycle}:${head}`, { approved: approved.revision, current: head, why: o.sameness === 'exact' ? 'exact' : 'change' })) return // i18n-ignore: a fact's kind and codes, not text
        // P4: what follows from it (#1217: P3 records only).
        if (!wf.cfg.reconcileActs) return
        if (entry) w.fact('IntegrationCancelled', { entry: entry.id, reason: 'stale' }) // i18n-ignore: a fact's kind and codes, not text
        w.move('approved', 'derived')
        wf.wake(w, s.started?.builder, `${card.key}: stale, submit again`) // i18n-ignore: a wake, agent-facing
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
    // Some of its own work in the target (a partial hand merge): a mark; the card stays where it is. Its own commits
    // are its line's first-parent history since its base: the target merged into the card (an update) isn't its work.
    const th = await G.lineHead(project, target)
    if (isUnknown(th) || !th) return
    const own = await G.firstParents(project, base, s.head)
    if (isUnknown(own)) return
    let found: string | null = null
    for (const c of own) if ((await G.isAncestor(project, c, th)) === true) found = found ?? c
    if (!found) return
    const part = found
    await wf.write(card, null, 'outside', (w) => sameCycle(w, s) && w.tx.appendObserved(card.id, { kind: 'MergedInPart', actor: 'outside', source: 'observed', dedupe: `part:${s.cycle}:${part}`, data: { revision: part, target } }))
    return
  }

  if (card.stage === 'done' && !s.integrated && !s.accepted && wf.ownLine(s)) {
    // Done with no integration (the user's override, or Not checked's report): a later merge is observed and recorded,
    // without moving the card (§16.8.4). Its change: the submitted endpoints, else its line's head from its base.
    // (A Done card's head isn't observed any more, so an unsubmitted one is read from its line now, if it still exists.)
    const lineNow = s.latest?.revision ? null : await G.lineHead(project, s.started!.line!)
    if (isUnknown(lineNow)) hooks.unknown?.(lineNow.what)
    const revision = s.latest?.revision ?? (lineNow && !isUnknown(lineNow) ? lineNow : s.head)
    const from = s.latest?.base ?? base
    if (!revision || !from || revision === from) return
    const c = await G.contains(project, target, { base: from, revision, key: s.latest?.key })
    if (isUnknown(c)) return hooks.unknown?.(c.what)
    if (!c) return
    const th = await G.lineHead(project, target)
    await wf.write(card, null, 'outside', (w) => sameCycle(w, s) && w.tx.appendObserved(card.id, { kind: 'Integrated', actor: 'outside', source: 'observed', dedupe: `cycle:${s.cycle}`, data: { revision, target, result: !isUnknown(th) && th ? th : revision, method: c.method, by: 'outside' } })) // i18n-ignore: a fact's kind and codes, not text
    return
  }

  if (card.stage === 'done' && s.integrated && s.integrated.method !== 'committed') {
    // A Done card's revision no longer in the target (the target was reset): a warning mark; it stays Done.
    const i = s.integrated
    const th = await G.lineHead(project, i.target)
    if (isUnknown(th)) return hooks.unknown?.(th.what)
    if (!th) return
    const sub = s.latest
    const c = await G.contains(project, i.target, { base: s.approved?.base ?? sub?.base ?? base ?? i.revision, revision: i.revision, key: sub?.key })
    const resultIn = await G.isAncestor(project, i.result, th)
    if (isUnknown(c)) return hooks.unknown?.(c.what)
    if (isUnknown(resultIn)) return hooks.unknown?.(resultIn.what)
    if (!c && resultIn === false && !s.marks.leftTarget) await wf.write(card, null, 'outside', (w) => sameCycle(w, s) && w.tx.appendObserved(card.id, { kind: 'LeftTarget', actor: 'outside', source: 'observed', dedupe: `left:${s.cycle}:${th}`, data: { revision: i.revision, target: i.target } }))
  }
}

async function integratedOutside(wf: Workflow, card: CardRecord, s: CardState, revision: string, method: 'merge' | 'fastForward' | 'squash' | 'sameTree', outsideRules: string[]): Promise<void> {
  const target = s.started!.target ?? ''
  const th = await G.lineHead(wf.cfg.project, target)
  const entry = openEntry(s)
  await wf.write(card, wf.rulesetOf(card, s), 'outside', (w) => {
    if (!sameCycle(w, s)) return
    // Unique per cycle: two Hives observing the same merge write one `Integrated` (§16.17).
    const f = w.tx.appendObserved(card.id, { kind: 'Integrated', actor: 'outside', source: 'observed', dedupe: `cycle:${s.cycle}`, data: { revision, target, result: !isUnknown(th) && th ? th : revision, method, by: 'outside', ...(outsideRules.length ? { outsideRules } : {}) } }) // i18n-ignore: a fact's kind and codes, not text
    if (!f) return
    w.written.push(f as Fact)
    // P4: the card Done, its queue entry and slot released, its lane told (#1217: P3 records only; the card stays).
    if (!wf.cfg.reconcileActs) return
    if (entry) w.fact('IntegrationCancelled', { entry: entry.id, reason: 'integratedOutside' }) // i18n-ignore: a fact's kind and codes, not text
    w.move('done', 'derived')
    w.action('endLaneIfDone', {})
    w.action('releaseSlot', {})
  })
}

/** None: an edit to a card's paths after a pass makes the pass stale (§16.3.3); files outside its paths never do. */
export async function reconcileNone(wf: Workflow, card: CardRecord, s: CardState): Promise<void> {
  if (card.stage !== 'review' || !passingReviewers(s).length || s.stale) return
  const now = wf.none.revision(card.paths ?? [])
  if (isUnknown(now) || now.revision === s.approved?.revision) return
  const r = wf.rulesetOf(card, s)
  await wf.write(card, r, 'outside', (w) => {
    if (!sameCycle(w, s)) return
    if (!observed(w, 'Stale', `stale:${s.cycle}:${now.revision}`, { approved: s.approved?.revision ?? null, current: now.revision, why: 'change' })) return // i18n-ignore: a fact's kind and codes, not text
    // P4: what follows from it (#1217: P3 records only).
    if (!wf.cfg.reconcileActs) return
    if (!hasStage(r, 'review')) w.move('active', 'derived')
    wf.wake(w, s.started?.builder, `${card.key}: your paths changed since the pass, submit again`) // i18n-ignore: a wake, agent-facing
  })
}

/**
 * An observed fact of a write, once (its dedupe key, unique per card and kind): null when another Hive already wrote it,
 * else the fact, counted as the write's. Under the write's ruleset, as its recorded facts are.
 */
function observed<K extends 'Stale' | 'CarriedOver'>(w: Write, kind: K, dedupe: string, data: FactData[K]): Fact<K> | null {
  const f = w.tx.appendObserved(w.card.id, { kind, actor: 'outside', source: 'observed', dedupe, ...(w.ruleset ? { ruleset: w.ruleset.id } : {}), data })
  if (f) w.written.push(f as Fact)
  return f
}

/** Whether the card is still in the cycle an observation was read in (HR4's #1217 round 1): checked under the write's lock. */
const sameCycle = (w: Write, s: CardState): boolean => w.state().cycle === s.cycle

/** Whether a path exists: `gone` only when it doesn't (ENOENT, ENOTDIR); anything else that stops a look is `unknown`. */
function presence(path: string): 'there' | 'gone' | 'unknown' {
  try {
    statSync(path)
    return 'there'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'unknown'
  }
}

/**
 * The card's target, observed (`TargetMoved`, §16.4.4): its head now against the last one recorded this cycle, read
 * again under the write's lock from the ref files (a cheap read: no git process), so what is written is the move from the
 * newest recorded head to the head now. Keyed by the fact it follows: two Hives write each move once; a run that finds
 * no move writes nothing, and one after a time closed records what changed meanwhile.
 */
async function observeTarget(wf: Workflow, card: CardRecord, s0: CardState, hooks: ReconcileHooks): Promise<void> {
  const target = s0.started?.target
  if (!target) return
  const common = await G.commonDir(wf.cfg.project)
  if (isUnknown(common)) return hooks.unknown?.(common.what)
  // Read by git first: an unreadable target is unknown (nothing recorded), where a target that doesn't exist is a value
  // of its own, null (HR4's round 2: a deleted target is recorded, X→null, and its return, null→Y).
  const seen = await G.lineHead(wf.cfg.project, target)
  if (isUnknown(seen)) return hooks.unknown?.(seen.what)
  await wf.locked(() =>
    wf.store.tx((tx) => {
      const facts = tx.facts(card.id)
      const s = foldCard(facts)
      if (s.cycle !== s0.cycle) return
      // As it is now, under the lock, from the ref files (null: the ref isn't there). Null where git read it just before:
      // gone meanwhile, or a file this read couldn't open; the next run reads again rather than record a deletion.
      const to = G.refSync(common, `refs/heads/${target}`)
      if (to === null && seen !== null) return
      const last = facts.filter((f) => f.kind === 'TargetMoved' && f.seq > s.cycle && (f.data as FactData['TargetMoved']).target === target).at(-1)
      const from = last ? (last.data as FactData['TargetMoved']).to : null
      if (from === to) return
      tx.appendObserved(card.id, { kind: 'TargetMoved', actor: 'outside', source: 'observed', dedupe: `target:${last?.seq ?? s.cycle}`, data: { target, from, to } })
    })
  )
}
