// Reconciliation (SPEC §16.4.4): observed facts are reconciled against recorded ones, never refused. Work done outside
// Combwork counts: a commit or merge made in a terminal is observed and the rules never fight it. Observations name the
// observed fact they follow (their dedupe key), so two Combworks observing one workspace write each transition once, and
// a writer that loses the race reads the platform again and writes only what is true now (§16.17).
//
// Called by the app's reconciler (reconciler.ts, #1217) on the watcher's events, and by the runtime's tests. The table's
// moves (Done when integrated outside, a stale card moved back), queue cancellations and wakes run only with the
// runtime's `reconcileActs` (in the app, Settings → Advanced → Workflow rules are enforced, #1263); without it, what is
// observed is recorded and nothing else changes (P3's record-only). An observation is recorded once (its dedupe key),
// and what follows from it is applied apart from that, once (HR2's #1263 round 1): an integration until the card is
// Done, a stale pass once per Stale fact, so one recorded while the rules were off is acted on once they're on again.
// Every write goes through the runtime's lock (`wf.locked`: the board's change, in the app).

import { statSync } from 'original-fs'
import { join } from 'path'
import { foldCard, openEntry, passingReviewers, type CardState, type Fact, type FactData, type StageId } from '../../shared/workflow/facts'
import { awaitsAgentMerge, hasStage, type Ruleset } from '../../shared/workflow/compile'
import { notApproved } from '../../shared/workflow/guards'
import * as G from '../platform/git'
import { isUnknown, type Maybe } from '../platform/types'
import { samePath } from '../../shared/movePaths'
import type { CardRecord } from './factStore'
import type { Workflow, Write } from './runtime'
import { staleWake } from './queueState'
import { carriedProvenance, walkStillHolds } from './carriedWalk'
import { carriedInNow } from '../../shared/workflow/workView'

export interface ReconcileHooks {
  /** Called after the platform was read and before the write: where a test lets another observer act first. */
  afterRead?: () => void | Promise<void>
  /**
   * Told when a read this reconciliation needed couldn't be made (unknown): what it would have recorded is undecided, so
   * a caller keeping a checkpoint (the app's Done targets) doesn't move it past this card (HR4's #1217 round 2).
   */
  unknown?: (what: string) => void
  /**
   * HI-2709: told when a card's carried-code walk deferred (more merges to read, a read that couldn't be made, a merge
   * in flight): the caller runs another bounded pass later, without waiting for an event.
   */
  again?: (why: 'more' | 'unknown' | 'busy') => void
}

const UNFINISHED = ['active', 'review', 'approved', 'merging']
/** A shared folder's new commits attributed in one transaction at most (HI-2379): main's thread given back between. */
export const ATTRIBUTE_BATCH = 100

/** Cards working in the project folder that aren't finished (Active, Review, Approved). */
function sharedFolderCards(wf: Workflow): CardRecord[] {
  return wf.store.cards().filter((c) => UNFINISHED.includes(c.stage) && wf.state(c).started?.folder === 'project')
}

/**
 * Attribution in a shared folder (§16.3.2), recorded once when a commit is seen and never recomputed: a commit with a
 * card's trailer is that card's; else, if exactly one card of the folder is unfinished, that card's; else no card's,
 * listed for the user. A run whose write finds the folder's cards changed since it read them (one started or finished
 * meanwhile) reads them again and goes on from the cursor, a few times (HI-2287): a submit attributes its card's own
 * commits this way, and one that gave up there was refused as having nothing committed while the lane started its next
 * card in the folder.
 */
export async function attributeFolder(wf: Workflow, hooks: ReconcileHooks = {}): Promise<void> {
  for (let tries = 0; tries < 5; tries++) if ((await attributeOnce(wf, hooks)) !== 'raced') return
}

/** One attribution run: `raced` when the folder's cards changed between its read and its write (nothing written then). */
async function attributeOnce(wf: Workflow, hooks: ReconcileHooks): Promise<'done' | 'raced'> {
  const project = wf.cfg.project
  const cards = sharedFolderCards(wf)
  // Each card's cycle as read: attribution decided on these is written only while they are still the folder's cards.
  const cycles = new Map(cards.map((c) => [c.id, wf.state(c).cycle]))
  const line = await G.branch(project)
  if (isUnknown(line) || !line) return 'done'
  const head = await G.lineHead(project, line)
  if (isUnknown(head) || !head) return 'done'
  const seenKey = `seen:${line}`
  let from = wf.store.meta(seenKey)
  if (!from) {
    // The first look: from the earliest base of the folder's unfinished cards.
    const bases = cards.map((c) => wf.state(c).started?.base).filter((b): b is string => !!b)
    if (!bases.length) {
      await wf.locked(() => wf.store.setMeta(seenKey, head))
      return 'done'
    }
    from = bases[0]
    for (const b of bases.slice(1)) if ((await G.isAncestor(project, b, from)) === true) from = b
  }
  if (from === head) return 'done'
  // The line's own commits (HI-2382, Darren): a branch merged in keeps its commits on their own cards; the merge is
  // attributed like any commit of the line.
  const list = await G.commits(project, `${from}..${head}`, { firstParent: true })
  if (isUnknown(list)) return 'done'
  await hooks.afterRead?.()
  const decided = list.map((c) => {
    const byTrailer = c.cards.map((k) => wf.store.cardByKey(k)).find((x): x is CardRecord => !!x)
    const card = byTrailer ?? (cards.length === 1 ? cards[0] : null)
    return { commit: c.commit, card, how: byTrailer ? 'trailer' : card ? 'onlyCard' : 'unattributed' }
  })
  // HI-2379: in batches, main's thread given back between them. A merge brings thousands of commits into the folder's
  // line at once (the release merge, 3,536): one transaction each, every one checking the folder's cards and folding
  // its card's whole log again, held main for 40 s. A batch checks and folds once, then follows what it appends.
  for (let at = 0; at < decided.length; at += ATTRIBUTE_BATCH) {
    if (at) await new Promise((r) => setImmediate(r))
    const batch = decided.slice(at, at + ATTRIBUTE_BATCH)
    // The folder's records, the cards' facts and the cursor in one transaction: a crash keeps all or none of them.
    const kept = await wf.locked(() =>
      wf.store.tx((tx) => {
        // The folder's cards as they are now, under the lock (HR4's #1217 round 1): one started, finished or in a new cycle
        // since they were read, and this attribution (immutable once written) waits: read again, from the cursor.
        const now = sharedFolderCards(wf)
        if (now.length !== cards.length || now.some((x) => cycles.get(x.id) !== wf.state(x).cycle)) return false
        // Each card's head as its facts say, read once in the batch and moved on by the HeadMoved facts it appends.
        const heads = new Map<number, { lastHeadFact: number; head: string | null; moves: boolean }>()
        for (const { commit, card, how } of batch) {
          if (!tx.recordFolderCommit(project, commit, card?.id ?? null, how)) continue
          if (card) {
            let h = heads.get(card.id)
            if (!h) {
              const s = foldCard(tx.facts(card.id))
              // A shared-folder card's revision is its newest commit: working revisions, never an integration.
              const stage = tx.card(card.id).stage
              heads.set(card.id, (h = { lastHeadFact: s.lastHeadFact, head: s.head, moves: UNFINISHED.includes(stage) || stage === 'todo' }))
            }
            tx.appendObserved(card.id, { kind: 'CommitAttributed', actor: 'outside', source: 'observed', dedupe: `commit:${commit}`, data: { commit, how: how as 'trailer' | 'onlyCard' } })
            if (h.moves) {
              const moved = tx.appendObserved(card.id, { kind: 'HeadMoved', actor: 'outside', source: 'observed', dedupe: `prev:${h.lastHeadFact}`, data: { line, from: h.head, to: commit } })
              // Already observed (another Combwork's): its log says where the head is now, read again at its next commit.
              if (moved) Object.assign(h, { lastHeadFact: moved.seq, head: commit })
              else heads.delete(card.id)
            }
          }
        }
        tx.setMeta(seenKey, batch[batch.length - 1].commit)
        return true
      })
    )
    if (!kept) return 'raced'
  }
  await wf.locked(() => wf.store.setMeta(seenKey, head))
  return 'done'
}

/**
 * What following a card's pending rename found (#1305): `renamed`, the card follows it (this observer wrote LineRenamed,
 * or another did first, or its cycle changed meanwhile: the caller reads the card again either way); `unchanged`, no
 * rename covers its line, or git still has the old name (its line is read as it is); `unknown`, a rename points away
 * from its line but git's names can't both be read: its line isn't observed this time, and never taken for gone.
 */
type Followed = 'renamed' | 'unchanged' | 'unknown'

/**
 * A card whose line is the old name of a rename Repair began and hasn't finished (#1305, `pendingRename`): when the
 * old name is gone and the new one is there (git's step done), the card follows it (LineRenamed, as Repair writes it),
 * once: the write checks, under its lock, that the card is still in the cycle and on the line this observer read.
 */
async function followRename(wf: Workflow, card: CardRecord, s: CardState): Promise<Followed> {
  const line = s.started?.line
  if (!line || !wf.cfg.pendingRename) return 'unchanged'
  const to = await wf.cfg.pendingRename(line)
  if (!to) return 'unchanged'
  const old = await G.lineHead(wf.cfg.project, line)
  if (isUnknown(old)) return 'unknown'
  if (old !== null) return 'unchanged'
  const head = await G.lineHead(wf.cfg.project, to)
  if (head === null || isUnknown(head)) return 'unknown'
  await wf.write(card, null, 'combwork', (w) => {
    if (!sameCycle(w, s) || w.state().started?.line !== line) return
    w.fact('LineRenamed', { from: line, to, why: 'repair' }) // i18n-ignore: a fact's kind and codes, not text
  })
  return 'renamed'
}

/**
 * A card whose folder is gone, read again before it is taken for gone (#1343): `moved`, its builder's worktree is now
 * elsewhere on the card's line, or on the new name of its line's pending rename (Repair, or Recreate, cut short before
 * the card's FolderMoved), so the card follows it
 * (FolderMoved, as Repair writes it), once: the write checks, under its lock, that the card is still in the cycle and
 * folder this observer read; `pending`, its builder's record still names the folder and a move Repair hasn't recorded
 * covers the project, so Repair moves it (or its new place's branch can't be read now: the next run looks again);
 * `gone`, neither.
 */
async function followFolder(wf: Workflow, card: CardRecord, s: CardState): Promise<'moved' | 'pending' | 'gone'> {
  const folder = s.started!.folder
  const line = s.started!.line
  const now = await wf.cfg.agentFolder?.(s.started!.builder)
  if (now && !samePath(now.path, folder)) {
    const there = line ? presence(now.path) : 'gone'
    const on = there === 'there' ? await G.branch(now.path) : null
    // Unreadable (the folder, or its branch): undecided, so not taken for gone this time either.
    if (there === 'unknown' || isUnknown(on)) return 'pending'
    // Its line may be the old name of a rename Repair began (#1305): the worktree is on the new name then, and the card
    // follows both (followRename moves its line after). A rename pending to another name: undecided too.
    const renamed = on && line ? await wf.cfg.pendingRename?.(line) : null
    if (on && (on.toLowerCase() === line!.toLowerCase() || on.toLowerCase() === renamed?.toLowerCase())) {
      await wf.write(card, null, 'combwork', (w) => {
        if (!sameCycle(w, s) || w.state().started?.folder !== folder) return
        w.fact('FolderMoved', { from: folder, to: now.path, why: 'repair' }) // i18n-ignore: a fact's kind and codes, not text
      })
      return 'moved'
    }
    return renamed ? 'pending' : 'gone'
  }
  // The workspace or project moved and Repair hasn't run yet: undecided, for an agent's worktree and a slot alike (#1447:
  // Repair relinks the slot and writes the card's FolderMoved).
  return (await wf.cfg.movePending?.()) ? 'pending' : 'gone'
}

/**
 * Records an observed head change once (the dedupe key names the fact it follows). When another observer already wrote
 * a fact after the same one, reads the winner and the platform now, and writes only what is true now, after it. Replies
 * with the platform as it last read it (#1462: the caller's Gone check reads no line again).
 */
async function observeHead(wf: Workflow, card: CardRecord, read: () => Promise<Maybe<string | null>>, line: string | null, hooks: ReconcileHooks): Promise<Maybe<string | null>> {
  // The view this observer read the log at (the fact it follows), then the platform.
  let s = wf.state(card)
  const cycle = s.cycle
  let now = await read()
  await hooks.afterRead?.()
  let prev = s.lastHeadFact
  let from = s.head
  for (let tries = 0; tries < 5; tries++) {
    if (isUnknown(now) || now === from) return now
    const to = now
    // Written only after the fact it was read after, in the cycle it was read in (HR4's #1217 round 1): a new cycle
    // since (the card started again) drops it; another fact since is a lost race.
    const wrote = await wf.locked(() =>
      wf.store.tx((tx) => {
        const cur = foldCard(tx.facts(card.id))
        // A new cycle since, or its line renamed since (#1305: LineRenamed): what this observer read is no longer the
        // card's, and is dropped.
        if (cur.cycle !== cycle || (line !== null && cur.started?.line !== line)) return 'cycle' as const
        if (cur.lastHeadFact !== prev) return null
        return tx.appendObserved(card.id, { kind: 'HeadMoved', actor: 'outside', source: 'observed', dedupe: `prev:${prev}`, data: { line, from, to } })
      })
    )
    if (wrote === 'cycle' || wrote) return now
    // Lost the race: read the winner and the platform now.
    s = wf.state(card)
    if (s.cycle !== cycle || (line !== null && s.started?.line !== line)) return now
    prev = s.lastHeadFact
    from = s.head
    now = await read()
  }
  return now
}

/**
 * Whether a slot card's cycle still owes its slot's preparation (#1551): started with a lease, and no `SlotPrepared`
 * of that lease since its `Started`.
 */
export function slotPreparationOwed(wf: Workflow, card: CardRecord, s: CardState): boolean {
  const lease = s.started?.lease
  if (!lease || !s.started?.slot) return false
  const facts = wf.store.facts(card.id)
  const at = facts.findLastIndex((f) => f.kind === 'Started')
  return !facts.slice(at + 1).some((f) => f.kind === 'SlotPrepared' && (f.data as FactData['SlotPrepared']).lease === lease)
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
  if (wf.ownLine(s) && card.stage !== 'done' && presence(s.started.folder) === 'gone' && (await followFolder(wf, card, s)) === 'gone') {
    const folder = s.started.folder
    // Not if the card's folder moved meanwhile (Repair's FolderMoved, another observer's).
    await wf.write(card, null, 'outside', (w) => sameCycle(w, s0) && w.state().started?.folder === folder && w.tx.appendObserved(card.id, { kind: 'Gone', actor: 'outside', source: 'observed', dedupe: `gone:folder:${s0.cycle}`, data: { what: 'folder' } })) // i18n-ignore: a fact's kind and codes, not text
  }
  s = wf.state(card)
  // The target's head as observed (#1462: the partial-merge check below reads it from here, not from git again).
  const seenTarget = await observeTarget(wf, card, s, hooks)

  if (!wf.ownLine(s)) {
    // A shared folder: attribution; its commits are working revisions, never an integration (§16.4.4).
    await attributeFolder(wf)
    if (card.stage !== 'done') return
  } else if (card.stage !== 'done') {
    // A rename Repair began and was cut short after git's step (#1305: a crash, a file it couldn't write): the card
    // follows it now, before its line is read, rather than take it for gone. Read again whatever it found: another
    // observer may have followed it first.
    const followed = await followRename(wf, card, s)
    s = wf.state(card)
    const line = s.started?.line
    // A slot card's line is made by its slot's preparation (#1438): until then it doesn't exist and isn't gone, nor has
    // its head moved (#1551). Read before the line, so a preparation that lands meanwhile still counts as owed here.
    const owed = slotPreparationOwed(wf, card, s)
    // Every observation below writes only while the card is still on this line in this cycle (checked under the write's
    // lock): a rename since stops it.
    if (followed !== 'unknown' && line && !owed) {
      // The cycle the line was read in, which passed the check above: what it read is that cycle's only (HR6's #1551
      // round 1: started again meanwhile, an old null read would mark the new cycle, its preparation still owed).
      const read = s
      const lh = await observeHead(wf, card, () => G.lineHead(project, line), line, hooks)
      s = wf.state(card)
      // Never gone while a rename points away from it: the next run follows it once git's names can be read.
      if (lh === null && !(await wf.cfg.pendingRename?.(line))) await wf.write(card, null, 'outside', (w) => sameCycle(w, read) && w.state().started?.line === line && w.tx.appendObserved(card.id, { kind: 'Gone', actor: 'outside', source: 'observed', dedupe: `gone:line:${read.cycle}`, data: { what: 'line' } })) // i18n-ignore: a fact's kind and codes, not text
    }
  }

  card = wf.store.card(card.id)
  s = wf.state(card)
  const target = s.started!.target ?? ''
  const base = s.started!.base
  const entry = openEntry(s)
  // The queue is mid-advance: its own recovery settles the entry (§16.4.5).
  if (entry?.state === 'started') return

  // Approved, merging, or waiting for the agent's merge in Active where the rules have no Approved (§16.5.2, #1417).
  const waits = card.stage === 'approved' || card.stage === 'merging' || (!!r && awaitsAgentMerge(r, s))
  if (waits && s.approved?.revision && s.approved.base) {
    const back = card.stage === 'active' ? null : 'approved'
    const approved = { base: s.approved.base, revision: s.approved.revision, key: s.latest?.key }
    // Found in the target, not by Combwork → Done (outside); the queue drops the entry; the lane counts it.
    if (approved.revision !== base) {
      const c = await G.contains(project, target, approved)
      if (!isUnknown(c) && c) return integratedOutside(wf, card, s, approved.revision, c.method, [])
    }
    // The pass follows the newest observed head (#1623, the Assistant's call after HR2's round 2): at exactly the approved
    // revision it holds; elsewhere it is the same change (carried over) or stale. Facts record each transition, as
    // history; what is done is decided from the head as it is now. Each write checks under its lock that the head
    // observation it read is still the newest: a newer one wins, and the next run decides from it.
    const newest = (w: Write): boolean => sameCycle(w, s) && w.state().lastHeadFact === s.lastHeadFact && w.state().head === s.head
    if (wf.ownLine(s) && s.head === approved.revision && s.stale) {
      // Back at exactly the approved revision: the reviewer passed that commit. The return is recorded once per head
      // observation (it clears the stale pass), before any effects of the stale pass not applied yet.
      const from = s.stale.current ?? approved.revision
      await wf.write(card, r, 'combwork', (w) => {
        if (!newest(w) || !w.state().stale) return
        // What follows from it, with the rules enforced (P3 records only).
        if (observed(w, 'CarriedOver', `back:${s.cycle}:${s.lastHeadFact}`, { from, to: approved.revision, toBase: approved.base, how: 'sameRevision' }) && wf.cfg.reconcileActs) holdsAgain(wf, w)
      })
      return
    }
    // At the approved revision with its pass holding, a card the queue let go of for a stale pass is queued again:
    // idempotent, so a return recorded while the rules were off is acted on once they're on, from the head as it is then.
    if (wf.ownLine(s) && s.head === approved.revision && !s.stale && wf.cfg.reconcileActs && requeueable(s, r, card.stage, card.labels)) {
      await wf.write(card, r, 'combwork', (w) => newest(w) && ensureQueued(wf, w))
      return
    }
    // A stale pass whose effects weren't applied (recorded while the rules weren't enforced): applied now, once.
    if (s.stale && wf.cfg.reconcileActs && !staleApplied(wf, card, s)) {
      await wf.write(card, r, 'outside', (w) => sameCycle(w, s) && staleEffects(w, back, `${staleWake(card.key, approved.revision, s.stale?.current)} Or put its branch back at ${approved.revision.slice(0, 7)}.`)) // i18n-ignore: a wake, agent-facing
      return
    }
    // A new revision after a pass: the same change carries over, another goes stale (§16.4.4).
    if (wf.ownLine(s) && s.head && s.head !== approved.revision && !s.stale) {
      const th = await G.lineHead(project, target)
      const b2 = !isUnknown(th) && th ? await G.mergeBase(project, th, s.head) : null
      const same = o.sameness === 'change' && !!b2 && !isUnknown(b2) && (await G.sameChange(project, approved, { base: b2, revision: s.head }))
      const head = s.head
      await wf.write(card, r, 'combwork', (w) => {
        // Only while the head observation it follows is still the newest (a newer one is read by the next run).
        if (!sameCycle(w, s) || w.state().lastHeadFact !== s.lastHeadFact) return
        // Observed once per head observation (§16.17): two Combworks seeing the same new revision write one fact, and a line
        // that comes back to a revision it had before (#1623: away, back, away again) is observed each time.
        if (same) {
          observed(w, 'CarriedOver', `carried:${s.cycle}:${s.lastHeadFact}`, { from: approved.revision, to: head, toBase: b2 as string, how: 'replay' })
          return
        }
        observed(w, 'Stale', `stale:${s.cycle}:${s.lastHeadFact}`, { approved: approved.revision, current: head, why: o.sameness === 'exact' ? 'exact' : 'change' }) // i18n-ignore: a fact's kind and codes, not text
        // What follows from it, once, with the rules enforced (P3 records only).
        if (wf.cfg.reconcileActs) staleEffects(w, back, `${staleWake(card.key, approved.revision, head)} Or put its branch back at ${approved.revision.slice(0, 7)}.`) // i18n-ignore: a wake, agent-facing
      })
    }
    return
  }

  if (card.stage === 'review' && wf.ownLine(s) && s.latest?.revision && s.latest.base && s.latest.revision !== base) {
    // HI-2709: carried into its target by another card's merge (marked for this submission and target): its review
    // still decides, on every pass, before anything is read.
    if (carriedInNow(s)) return
    // Merged by hand before its review passed: Done, marked outside the rules (OP-25); never moved back. Only once the
    // walk proves no queue merge carried it there (carriedWalk.ts); not proved yet, nothing is written.
    const p = await carriedProvenance(wf, card, s)
    if (p.kind === 'notContained') return
    if (p.kind === 'defer') return hooks.again?.(p.why)
    await hooks.afterRead?.()
    // The head the walk was bound to, read again after the last await before the write.
    const head = await G.lineHead(project, target)
    if (isUnknown(head) || head !== p.snap.head) return hooks.again?.('unknown')
    const sub = { revision: s.latest.revision, base: s.latest.base, key: s.latest.key }
    if (p.kind === 'carried') {
      await wf.write(card, null, 'outside', (w) => {
        if (!walkStillHolds(wf, w, s, p.snap)) return
        const f = w.tx.appendObserved(card.id, { kind: 'CarriedIn', actor: 'outside', source: 'observed', dedupe: `carried:${s.cycle}:${sub.revision}:${target}:${p.entry}`, data: { revision: sub.revision, target, by: p.by, entry: p.entry } }) // i18n-ignore: a fact's kind and codes, not text
        if (f) w.written.push(f as Fact)
      })
      return
    }
    const c = await G.contains(project, target, { base: sub.base, revision: sub.revision, key: sub.key }, p.snap.head)
    if (isUnknown(c) || !c) return hooks.again?.('unknown')
    return integratedOutside(wf, card, s, sub.revision, c.method, ['review'], (w) => walkStillHolds(wf, w, s, p.snap))
  }

  if (card.stage === 'active' && wf.ownLine(s) && s.head && base && s.head !== base) {
    // Some of its own work in the target (a partial hand merge): a mark; the card stays where it is. Its own commits
    // are its line's first-parent history since its base: the target merged into the card (an update) isn't its work.
    const th = seenTarget?.target === target ? seenTarget.head : await G.lineHead(project, target)
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
    // A submitted revision is the card's record (history: it keeps the names it had); an unsubmitted one is read from
    // the line as it is now, so its write checks the card is still on that line (#1305: renamed since, it's dropped).
    const read = s.latest?.revision ? null : s.started!.line!
    const lineNow = read ? await G.lineHead(project, read) : null
    if (isUnknown(lineNow)) hooks.unknown?.(lineNow.what)
    const revision = s.latest?.revision ?? (lineNow && !isUnknown(lineNow) ? lineNow : s.head)
    const from = s.latest?.base ?? base
    if (!revision || !from || revision === from) return
    const c = await G.contains(project, target, { base: from, revision, key: s.latest?.key })
    if (isUnknown(c)) return hooks.unknown?.(c.what)
    if (!c) return
    const th = await G.lineHead(project, target)
    await wf.write(card, null, 'outside', (w) => sameCycle(w, s) && (!read || w.state().started?.line === read) && w.tx.appendObserved(card.id, { kind: 'Integrated', actor: 'outside', source: 'observed', dedupe: `cycle:${s.cycle}`, data: { revision, target, result: !isUnknown(th) && th ? th : revision, method: c.method, by: 'outside' } })) // i18n-ignore: a fact's kind and codes, not text
    return
  }

  if (card.stage === 'done' && s.integrated && s.integrated.method !== 'committed') {
    // A Done card's revision no longer in the target (the target was reset): a warning mark; it stays Done.
    const i = s.integrated
    const th = await G.lineHead(project, i.target)
    if (isUnknown(th)) return hooks.unknown?.(th.what)
    if (!th) return
    // The result still in the target settles it with the history alone (kept between passes: HI-2182); only once it
    // isn't is the change looked for, in the same head.
    const resultIn = await G.isAncestor(project, i.result, th)
    if (isUnknown(resultIn)) return hooks.unknown?.(resultIn.what)
    if (resultIn) return
    const sub = s.latest
    const c = await G.contains(project, i.target, { base: s.approved?.base ?? sub?.base ?? base ?? i.revision, revision: i.revision, key: sub?.key }, th)
    if (isUnknown(c)) return hooks.unknown?.(c.what)
    if (!c && !s.marks.leftTarget) await wf.write(card, null, 'outside', (w) => sameCycle(w, s) && w.tx.appendObserved(card.id, { kind: 'LeftTarget', actor: 'outside', source: 'observed', dedupe: `left:${s.cycle}:${th}`, data: { revision: i.revision, target: i.target } }))
  }
}

async function integratedOutside(wf: Workflow, card: CardRecord, s: CardState, revision: string, method: 'merge' | 'fastForward' | 'squash' | 'sameTree', outsideRules: string[], holds?: (w: Write) => boolean): Promise<void> {
  const target = s.started!.target ?? ''
  const th = await G.lineHead(wf.cfg.project, target)
  await wf.write(card, wf.rulesetOf(card, s), 'outside', (w) => {
    if (!sameCycle(w, s) || (holds && !holds(w))) return
    // Unique per cycle: two Combworks observing the same merge write one `Integrated` (§16.17).
    const f = w.tx.appendObserved(card.id, { kind: 'Integrated', actor: 'outside', source: 'observed', dedupe: `cycle:${s.cycle}`, data: { revision, target, result: !isUnknown(th) && th ? th : revision, method, by: 'outside', ...(outsideRules.length ? { outsideRules } : {}) } }) // i18n-ignore: a fact's kind and codes, not text
    if (f) w.written.push(f as Fact)
    // With the rules enforced: the card Done, its queue entry and slot released, its lane told (P3 records only; the
    // card stays). Also for an integration recorded before (the rules off then, or another Combwork's): applied once, until
    // the card is Done.
    if (!wf.cfg.reconcileActs || w.current === 'done') return
    const open = openEntry(w.state())
    if (open) w.fact('IntegrationCancelled', { entry: open.id, reason: 'integratedOutside' }) // i18n-ignore: a fact's kind and codes, not text
    w.move('done', 'derived')
  })
}

/** None: an edit to a card's paths after a pass makes the pass stale (§16.3.3); files outside its paths never do. */
export async function reconcileNone(wf: Workflow, card: CardRecord, s: CardState): Promise<void> {
  // In Review, or in Approved waiting for your OK after the reviewer agent (N1, #1417).
  if (card.stage !== 'review' && card.stage !== 'approved') return
  const r = wf.rulesetOf(card, s)
  // From Approved it goes back to Review, as an approval that finds it changed sends it; in Review it stays, with the
  // stale mark; without a Review stage of its own, back to Active.
  const back = card.stage === 'approved' ? 'review' : hasStage(r, 'review') ? null : 'active'
  const why = `${card.key}: your paths changed since the pass, submit again` // i18n-ignore: a wake, agent-facing
  if (s.stale) {
    // Recorded while the rules weren't enforced: what follows from it, now, once.
    if (wf.cfg.reconcileActs && !staleApplied(wf, card, s)) await wf.write(card, r, 'outside', (w) => sameCycle(w, s) && staleEffects(w, back, why))
    return
  }
  if (!passingReviewers(s).length) return
  const now = wf.none.revision(card.paths ?? [])
  if (isUnknown(now) || now.revision === s.approved?.revision) return
  await wf.write(card, r, 'outside', (w) => {
    if (!sameCycle(w, s)) return
    observed(w, 'Stale', `stale:${s.cycle}:${now.revision}`, { approved: s.approved?.revision ?? null, current: now.revision, why: 'change' }) // i18n-ignore: a fact's kind and codes, not text
    // What follows from it, once, with the rules enforced (P3 records only).
    if (wf.cfg.reconcileActs) staleEffects(w, back, why)
  })
}

/** The card's content-stale pass this cycle (§16.4.4: not a decision's), as the log has it. */
const staleFact = (facts: Fact[], cycle: number): Fact | undefined => facts.findLast((f) => f.kind === 'Stale' && f.seq > cycle && (f.data as FactData['Stale']).why !== 'decision')

/** The builder a stale pass wakes: an agent (the user isn't woken). */
const wakes = (s: CardState): string | null => (s.started?.builder && s.started.builder !== 'user' ? s.started.builder : null)

/**
 * Whether a stale pass's effects were applied: its builder's wake was written for its Stale fact. With no builder to
 * wake, its effects are moves and a cancellation that write nothing once made, so it is applied when there is nothing
 * left to cancel.
 */
function staleApplied(wf: Workflow, card: CardRecord, s: CardState): boolean {
  const f = staleFact(wf.store.facts(card.id), s.cycle)
  if (!f) return true
  return wakes(s) ? wf.store.hasAction(card.id, 'wake', f.seq) : !openEntry(s)
}

/**
 * What follows a content-stale pass (§16.4.4), once per Stale fact, in the write's transaction: its queue entry
 * cancelled, the card moved `back` (Git: Approved; None without Review: Active; null: it stays), and its builder woken
 * with the wake tied to the Stale fact, which records that it was applied.
 */
function staleEffects(w: Write, back: StageId | null, why: string): void {
  const cur = w.state()
  const f = staleFact(w.tx.facts(w.card.id), cur.cycle)
  if (!f || !cur.stale) return
  const builder = wakes(cur)
  if (builder && w.tx.hasAction(w.card.id, 'wake', f.seq)) return
  const open = openEntry(cur)
  if (open) w.fact('IntegrationCancelled', { entry: open.id, reason: 'stale' }) // i18n-ignore: a fact's kind and codes, not text
  if (back) w.move(back, 'derived')
  if (builder) w.action('wake', { agent: builder, why }, f.seq)
}

/**
 * Where Combwork merges, an Approved card the queue let go of because its pass went stale (its newest entry cancelled so),
 * with no follow-up waiting and approved now: one to queue again (#1623). One taken out otherwise (Remove from queue, a
 * follow-up, On Hold) is left for what took it out.
 */
function requeueable(s: CardState, r: Ruleset | null, stage: StageId, labels: string[]): boolean {
  const last = s.entries.at(-1)
  return !!r && r.options.finish === 'combworkMerges' && stage === 'approved' && last?.state === 'cancelled' && last.cancelled === 'stale' && !s.step && !notApproved(s, r, labels)
}

/** Queues a requeueable card again, in the write's transaction, and tells its builder it needn't submit again. */
function ensureQueued(wf: Workflow, w: Write): boolean {
  const s = w.state()
  if (s.stale || !requeueable(s, w.ruleset, w.current, w.card.labels)) return false
  wf.enqueue(w)
  wf.wake(w, s.started?.builder, `${w.card.key}: back at its approved revision, so its pass holds again; it is queued again; don't submit it again`) // i18n-ignore: a wake, agent-facing
  return true
}

/**
 * What follows a return to the approved revision (#1623), in its write: queued again where it can be (`ensureQueued`);
 * else the OK it still waits for asked again, and its builder told what comes next. While a follow-up waits for its
 * reviewer's check, it isn't queued: the check's ok queues it.
 */
function holdsAgain(wf: Workflow, w: Write): void {
  const r = w.ruleset
  if (!r || ensureQueued(wf, w)) return
  const s = w.state()
  if (!s.step) wf.reask(w)
  const o = r.options
  const next = s.step ? 'it waits for the reviewer to check your follow-up' : openEntry(s) ? 'it stays in the merge queue' : o.finish === 'agentMerges' || o.finish === 'notChecked' ? 'merge it and report the merge' : "it waits for the user's OK" // i18n-ignore: a wake, agent-facing
  wf.wake(w, s.started?.builder, `${w.card.key}: back at its approved revision, so its pass holds again; ${next}`) // i18n-ignore: a wake, agent-facing
}

/**
 * An observed fact of a write, once (its dedupe key, unique per card and kind): null when another Combwork already wrote it,
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
 * newest recorded head to the head now. Keyed by the fact it follows: two Combworks write each move once; a run that finds
 * no move writes nothing, and one after a time closed records what changed meanwhile. Replies with the head git read
 * (none when it couldn't be read, or there's no target).
 */
async function observeTarget(wf: Workflow, card: CardRecord, s0: CardState, hooks: ReconcileHooks): Promise<{ target: string; head: string | null } | undefined> {
  const target = s0.started?.target
  if (!target) return
  const common = await G.commonDirFast(wf.cfg.project)
  if (isUnknown(common)) {
    hooks.unknown?.(common.what)
    return
  }
  // Read by git first: an unreadable target is unknown (nothing recorded), where a target that doesn't exist is a value
  // of its own, null (HR4's round 2: a deleted target is recorded, X→null, and its return, null→Y).
  const seen = await G.lineHead(wf.cfg.project, target)
  if (isUnknown(seen)) {
    hooks.unknown?.(seen.what)
    return
  }
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
  return { target, head: seen }
}
