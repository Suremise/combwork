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
import type { HistoryPort } from '../platform/history'
import { lineHistory } from '../platform/historyPorts'
import { isUnknown, type Maybe } from '../platform/types'
import { samePath } from '../../shared/movePaths'
import type { CardRecord } from './factStore'
import type { Workflow, Write } from './runtime'
import { staleWake } from './queueState'
import { catchUpKey, catchUpOf } from './mergeQueue'
import { inTargetNow } from '../../shared/workflow/workView'
import { sameFingerprint, type JjCandidateFingerprint, type JjCandidateOffer, type JjCandidateStep } from '../platform/jjCandidateStep'
import { jjCandidateEntry, jjReturnedComment, jjReturnedWake } from './jjCandidateReturn'
import { checksKeyOf } from './jjCandidateChecks'

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
export async function attributeFolder(wf: Workflow, hooks: ReconcileHooks = {}, H: HistoryPort = lineHistory()): Promise<void> {
  for (let tries = 0; tries < 5; tries++) if ((await attributeOnce(wf, hooks, H)) !== 'raced') return
}

/** One attribution run: `raced` when the folder's cards changed between its read and its write (nothing written then). */
async function attributeOnce(wf: Workflow, hooks: ReconcileHooks, H: HistoryPort): Promise<'done' | 'raced'> {
  const project = wf.cfg.project
  const cards = sharedFolderCards(wf)
  // Each card's cycle as read: attribution decided on these is written only while they are still the folder's cards.
  const cycles = new Map(cards.map((c) => [c.id, wf.state(c).cycle]))
  const line = await H.line(project)
  if (isUnknown(line) || !line) return 'done'
  const head = await H.lineHead(project, line)
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
    for (const b of bases.slice(1)) if ((await H.isAncestor(project, b, from)) === true) from = b
  }
  if (from === head) return 'done'
  // The line's own commits (HI-2382, Darren): a branch merged in keeps its commits on their own cards; the merge is
  // attributed like any commit of the line.
  const list = await H.commits(project, `${from}..${head}`, { firstParent: true })
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
async function followRename(wf: Workflow, H: HistoryPort, card: CardRecord, s: CardState): Promise<Followed> {
  const line = s.started?.line
  if (!line || !wf.cfg.pendingRename) return 'unchanged'
  const to = await wf.cfg.pendingRename(line)
  if (!to) return 'unchanged'
  const old = await H.lineHead(wf.cfg.project, line)
  if (isUnknown(old)) return 'unknown'
  if (old !== null) return 'unchanged'
  const head = await H.lineHead(wf.cfg.project, to)
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
async function followFolder(wf: Workflow, H: HistoryPort, card: CardRecord, s: CardState): Promise<'moved' | 'pending' | 'gone'> {
  const folder = s.started!.folder
  const line = s.started!.line
  const now = await wf.cfg.agentFolder?.(s.started!.builder)
  if (now && !samePath(now.path, folder)) {
    const there = line ? presence(now.path) : 'gone'
    const on = there === 'there' ? await H.line(now.path) : null
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

/**
 * A platform with history's reconciliation (its adapter's: Git's), read through its history port: observed heads,
 * attribution in a shared folder, containment, carry-over and stale.
 */
export async function reconcileHistory(wf: Workflow, H: HistoryPort, card0: CardRecord, hooks: ReconcileHooks = {}): Promise<void> {
  let card = wf.store.card(card0.id)
  let s = wf.state(card)
  if (!s.started) return
  const r = wf.rulesetOf(card, s)
  const o = r.options
  const project = wf.cfg.project

  // Gone (§16.4.4), only for what doesn't exist (an unreadable folder is unknown, not gone): the repository, then the
  // card's own folder. Recorded once per cycle.
  const s0 = s
  if (presence(project) === 'gone' || (presence(join(project, '.git')) === 'gone' && isUnknown(await H.store(project)))) {
    await wf.write(card, null, 'outside', (w) => sameCycle(w, s0) && w.tx.appendObserved(card.id, { kind: 'Gone', actor: 'outside', source: 'observed', dedupe: `gone:repository:${s0.cycle}`, data: { what: 'repository' } })) // i18n-ignore: a fact's kind and codes, not text
    return
  }
  if (wf.ownLine(s) && card.stage !== 'done' && presence(s.started.folder) === 'gone' && (await followFolder(wf, H, card, s)) === 'gone') {
    const folder = s.started.folder
    // Not if the card's folder moved meanwhile (Repair's FolderMoved, another observer's).
    await wf.write(card, null, 'outside', (w) => sameCycle(w, s0) && w.state().started?.folder === folder && w.tx.appendObserved(card.id, { kind: 'Gone', actor: 'outside', source: 'observed', dedupe: `gone:folder:${s0.cycle}`, data: { what: 'folder' } })) // i18n-ignore: a fact's kind and codes, not text
  }
  s = wf.state(card)
  // The target's head as observed (#1462: the partial-merge check below reads it from here, not from git again).
  const seenTarget = await observeTarget(wf, H, card, s, hooks)

  if (!wf.ownLine(s)) {
    // A shared folder: attribution; its commits are working revisions, never an integration (§16.4.4).
    await attributeFolder(wf, {}, H)
    if (card.stage !== 'done') return
  } else if (card.stage !== 'done') {
    // A rename Repair began and was cut short after git's step (#1305: a crash, a file it couldn't write): the card
    // follows it now, before its line is read, rather than take it for gone. Read again whatever it found: another
    // observer may have followed it first.
    const followed = await followRename(wf, H, card, s)
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
      const lh = await observeHead(wf, card, () => H.lineHead(project, line), line, hooks)
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
      const c = await H.contains(project, target, approved)
      if (!isUnknown(c) && c) {
        await hooks.afterRead?.()
        return integratedOutside(wf, H, card, s, approved.revision, c.method, [])
      }
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
      const th = await H.lineHead(project, target)
      const b2 = !isUnknown(th) && th ? await H.mergeBase(project, th, s.head) : null
      const same = o.sameness === 'change' && !!b2 && !isUnknown(b2) && (await H.sameChange(project, approved, { base: b2, revision: s.head }))
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
    // HI-2709: its change found in its target before its review passed (merged by hand, or carried in another card's
    // merge: HI-2684 carried HI-2682's) never closes it: a mark, and it stays in Review. Its review decides; once that
    // passes, the queue (or the merge's report) finds the change in the target and closes it as merged. Marked once per
    // submission, for the submission it was read for.
    if (inTargetNow(s)) return
    const sub = s.latest
    const c = await H.contains(project, target, { base: sub.base!, revision: sub.revision!, key: sub.key })
    if (isUnknown(c) || !c) return
    await hooks.afterRead?.()
    await wf.write(card, null, 'outside', (w) => {
      const now = w.state()
      if (!sameCycle(w, s) || now.stage !== 'review' || now.latest?.id !== sub.id || (now.started?.target ?? '') !== target) return
      const f = w.tx.appendObserved(card.id, { kind: 'InTarget', actor: 'outside', source: 'observed', dedupe: `intarget:${s.cycle}:${sub.id}`, data: { revision: sub.revision!, target, submission: sub.id } }) // i18n-ignore: a fact's kind and codes, not text
      if (f) w.written.push(f as Fact)
    })
    return
  }

  if (card.stage === 'active' && wf.ownLine(s) && s.head && base && s.head !== base) {
    // Some of its own work in the target (a partial hand merge): a mark; the card stays where it is. Its own commits
    // are its line's first-parent history since its base: the target merged into the card (an update) isn't its work.
    const th = seenTarget?.target === target ? seenTarget.head : await H.lineHead(project, target)
    if (isUnknown(th) || !th) return
    const own = await H.firstParents(project, base, s.head)
    if (isUnknown(own)) return
    let found: string | null = null
    for (const c of own) if ((await H.isAncestor(project, c, th)) === true) found = found ?? c
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
    const lineNow = read ? await H.lineHead(project, read) : null
    if (isUnknown(lineNow)) hooks.unknown?.(lineNow.what)
    const revision = s.latest?.revision ?? (lineNow && !isUnknown(lineNow) ? lineNow : s.head)
    const from = s.latest?.base ?? base
    if (!revision || !from || revision === from) return
    const c = await H.contains(project, target, { base: from, revision, key: s.latest?.key })
    if (isUnknown(c)) return hooks.unknown?.(c.what)
    if (!c) return
    const th = await H.lineHead(project, target)
    await wf.write(card, null, 'outside', (w) => sameCycle(w, s) && (!read || w.state().started?.line === read) && w.tx.appendObserved(card.id, { kind: 'Integrated', actor: 'outside', source: 'observed', dedupe: `cycle:${s.cycle}`, data: { revision, target, result: !isUnknown(th) && th ? th : revision, method: c.method, by: 'outside' } })) // i18n-ignore: a fact's kind and codes, not text
    return
  }

  if (card.stage === 'done' && s.integrated && s.integrated.method !== 'committed') {
    // A Done card's revision no longer in the target (the target was reset): a warning mark; it stays Done.
    const i = s.integrated
    const th = await H.lineHead(project, i.target)
    if (isUnknown(th)) return hooks.unknown?.(th.what)
    if (!th) return
    // The result still in the target settles it with the history alone (kept between passes: HI-2182); only once it
    // isn't is the change looked for, in the same head.
    const resultIn = await H.isAncestor(project, i.result, th)
    if (isUnknown(resultIn)) return hooks.unknown?.(resultIn.what)
    // In it again (HI-2988: caught up, or merged back): a mark it had cleared.
    if (resultIn) {
      if (s.marks.leftTarget) await wf.write(card, null, 'outside', (w) => sameCycle(w, s) && !!w.state().marks.leftTarget && w.tx.appendObserved(card.id, { kind: 'BackInTarget', actor: 'outside', source: 'observed', dedupe: `back:${s.cycle}:after:${lastSeq(w, card.id, LEFT)}`, data: { revision: i.revision, target: i.target } }))
      return
    }
    // HI-2988: published to its remote (follow mode, G21), the card's result is the remote's: a local target whose
    // catch-up to it is still owed, or merely behind it, hasn't left it.
    if (catchUpOf(wf.store.meta(catchUpKey(i.target)))?.card === card.key) return
    if (published(wf, card, s)) {
      const behind = await H.isAncestor(project, th, i.result)
      if (isUnknown(behind)) return hooks.unknown?.(behind.what)
      if (behind) return
    }
    const sub = s.latest
    const c = await H.contains(project, i.target, { base: s.approved?.base ?? sub?.base ?? base ?? i.revision, revision: i.revision, key: sub?.key }, th)
    if (isUnknown(c)) return hooks.unknown?.(c.what)
    if (!c && !s.marks.leftTarget) await wf.write(card, null, 'outside', (w) => sameCycle(w, s) && !w.state().marks.leftTarget && w.tx.appendObserved(card.id, { kind: 'LeftTarget', actor: 'outside', source: 'observed', dedupe: `left:${s.cycle}:after:${lastSeq(w, card.id, BACK)}`, data: { revision: i.revision, target: i.target } }))
  }
}

/**
 * HI-2988: a Done card's leaving its target and coming back, each observation keyed to the transition it follows (the
 * latest fact of the opposite kind, read in its write): two Combworks observing one transition write one fact, and the
 * same heads visited again (reset away and back, twice) make new ones. `LeftTarget` follows the integration or the last
 * `BackInTarget`; `BackInTarget` follows the last `LeftTarget`.
 */
const LEFT: ReadonlySet<string> = new Set(['LeftTarget'])
const BACK: ReadonlySet<string> = new Set(['Integrated', 'BackInTarget'])
const lastSeq = (w: Write, card: number, kinds: ReadonlySet<string>): number => w.tx.facts(card).findLast((f) => kinds.has(f.kind))?.seq ?? 0

/**
 * HI-2988: whether a Done card's integration was published to its target's remote (follow mode): its advance's
 * `IntegrationStarted` recorded the publication, or the queue found it published by someone else while following.
 */
function published(wf: Workflow, card: CardRecord, s: CardState): boolean {
  const i = s.integrated
  if (!i?.entry) return false
  if (wf.store.facts(card.id).some((f) => f.kind === 'IntegrationStarted' && (f.data as FactData['IntegrationStarted']).entry === i.entry && !!(f.data as FactData['IntegrationStarted']).publish)) return true
  return i.by === 'outside' && wf.cfg.options().followRemote === true
}

async function integratedOutside(wf: Workflow, H: HistoryPort, card: CardRecord, s: CardState, revision: string, method: 'merge' | 'fastForward' | 'squash' | 'sameTree', outsideRules: string[]): Promise<void> {
  const target = s.started!.target ?? ''
  const th = await H.lineHead(wf.cfg.project, target)
  await wf.write(card, wf.rulesetOf(card, s), 'outside', (w) => {
    if (!sameCycle(w, s)) return
    // HI-2709: never while a card it depends on isn't Done, read in this write (a dependency added while containment was
    // read counts): nothing written; it waits, as the queue does, and is looked at again once they are Done.
    if (wf.closeWaitsFor(w).length) return
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

/**
 * What jj's adapter answers for its reconciliation (HI-2882's J9b2): the card's head in its slot now (J2's head), whether
 * a later head carries the approved pass (J3's `jjSameRevision`, with the merge base it found), and J5's proof for the
 * approved submission (`jjContains`: its containment, its provenance and its retained bundle, or why not).
 */
export interface JjReconcilePorts {
  headNow(card: CardRecord, s: CardState): Promise<Maybe<string | null>>
  /** Unknown (a read that couldn't be made, a view that moved): never taken for "not the same" (HR1's round 1). */
  same(card: CardRecord, s: CardState, approved: { base: string; revision: string; key?: string | null }, head: string): Promise<{ same: boolean; base: string | null } | { unknown: string }>
  prove(card: CardRecord, s: CardState, approved: { base: string; revision: string; key?: string | null }): Promise<JjProved>
  /** The rows an Integrated fact's transaction writes beside it (its obligation and retained bundle). */
  record(w: Write, row: { card: string; cycle: number; bundle: string; target: string; result: string; since: number }): void
  /** The project's canonical id: the containment record's scope (HI-2869). */
  projectId(): string
  /**
   * HI-2871: J4's pre-integration candidate for the approval its fingerprint names (built, answered again, or why not);
   * `still`: whether that fingerprint is the card's now, read from the board (the attempt's owner). Absent: none is built.
   */
  candidate?(card: CardRecord, s: CardState, fp: JjCandidateFingerprint, still: () => boolean): Promise<JjCandidateStep>
  /** HI-2871: whether the target's head is still `expected`, read just before a candidate's answer is published. */
  headIs?(target: string, expected: string): Promise<boolean>
  /**
   * HI-2871 (HR3's round 2): whether a published offer is still current: the target still at its head, and its candidate
   * still the visible commit J4 recorded (`jjCandidateNow`: not superseded or gone). False when either can't be read.
   */
  offerCurrent?(target: string, offer: JjCandidateOffer): Promise<boolean>
  /** HI-2871: the cycle integrated: its candidates dropped (the one the target reaches kept). */
  candidatesDone?(card: CardRecord, cycle: number): Promise<void>
  /** HI-2938: the project's merge checks for a candidate now: their names and key (checksKeyOf); none: none configured. */
  checksNow?(card: CardRecord, s: CardState): Promise<{ key: string; names: string[] }>
  /** HI-2938: a candidate waits for its checks: the project's checks runner asked to look. */
  checksWanted?(): void
}

/**
 * HI-2938: a candidate's merge checks as the window shows them, bound to the checks key they run under (s11 §2):
 * running (`done` of `names`, `current` the one running), passed (adoptable), waiting for a check copy, stopped (Stop:
 * waits for Run Checks Again), or failing transiently (`misses` in a row, `why`).
 */
export interface JjCandidateChecksShown {
  key: string
  names: string[]
  state: 'running' | 'passed' | 'waiting' | 'stopped' | 'failing'
  done?: number
  current?: string
  why?: string
  misses?: number
}

/**
 * The window's record of a jj card's candidate (HI-2871/s21), board_meta, by the project's canonical id: the fingerprint
 * it was made for (shown only while that is the card's), and what it is: a candidate ready, none (the repository signs),
 * or why it couldn't be built (`misses` in a row: shown from CANDIDATE_MISSES on).
 */
export interface JjCandidateShown {
  gen: number
  fp: JjCandidateFingerprint
  state: 'ready' | 'signing' | 'unknown'
  offer?: JjCandidateOffer
  /** HI-2938: its merge checks (absent: none configured, so it is offered after its conflict check alone). */
  checks?: JjCandidateChecksShown
  why?: string
  misses?: number
  at: number
}

/** Unknown candidate steps in a row before the window says why (s13 §3). */
export const CANDIDATE_MISSES = 3

export const candidateKey = (project: string, card: string, cycle: number): string => `jj_candidate:${project.toLowerCase()}:${card.toLowerCase()}:${cycle}`

/**
 * A jj card's candidate fingerprint now (null: not an approval a candidate is built for): Approved, its pass holding (no
 * Stale recorded, and its slot's observed head the approved revision: HR3's round 1). The one predicate for reuse, J4's
 * owner, publication and display.
 */
export function candidateFingerprint(wf: Workflow, card: CardRecord, s: CardState): JjCandidateFingerprint | null {
  const snap = approvalOf(card, s)
  if (!snap || snap.stage !== 'approved' || !s.approved || !snap.target) return null
  if (s.stale || (s.head && s.head !== snap.revision)) return null
  // HI-2938/s11: the approval's own identity: the move into Approved it came from, in this cycle (the stage is Approved,
  // so the latest such move is the one the card stands on), and the decision generation.
  const approval = wf.store.facts(card.id).findLast((f) => f.kind === 'Moved' && f.seq > s.cycle && (f.data as FactData['Moved']).to === 'approved')?.seq
  if (approval === undefined) return null
  const r = wf.rulesetOf(card, s)
  return { cycle: snap.cycle, submission: snap.submission, revision: snap.revision, base: snap.base, key: snap.key, commit: snap.commit, target: snap.target, ruleset: r.id, style: r.options.style, strict: r.options.strict, generation: s.generation, approval }
}

/**
 * The card's candidate record, only while it was made for its fingerprint now (a stale row, a crash's, shows nothing);
 * a ready one only while `headNow` (the target's head as just read; undefined: not read) is the head it was built on
 * (HR3's round 1): a target that moved hides it at once, whatever its rebuild does, across restarts too.
 */
export function candidateShown(wf: Workflow, card: CardRecord, s: CardState, project: string, headNow?: string | null, anyHead = false): JjCandidateShown | null {
  // The record first: a card with none (most) needs no fingerprint read.
  const raw = wf.store.boardMeta(candidateKey(project, card.key, s.cycle))
  const fp = raw ? candidateFingerprint(wf, card, s) : null
  if (!fp || !raw) return null
  try {
    const rec = JSON.parse(raw) as JjCandidateShown
    if (!sameFingerprint(rec.fp, fp)) return null
    return rec.state !== 'ready' || anyHead || (!!headNow && rec.offer?.expected === headNow) ? rec : null
  } catch {
    return null
  }
}

/**
 * Whether a card's cycle has ended without Integrated (HI-2950/s10): an earlier cycle than its current one (put back and
 * restarted), or its current one while it is in Todo (put back) or Done with no Integrated fact (the user's own Done, or
 * one while the rules were off). An Approved, Review or Active card's current cycle never has.
 */
export const cycleEnded = (card: Pick<CardRecord, 'stage'>, s: Pick<CardState, 'cycle' | 'integrated'>, cycle: number): boolean => cycle < s.cycle || (cycle === s.cycle && (card.stage === 'todo' || (card.stage === 'done' && !s.integrated)))

/**
 * An ended cycle's rows for the window and its checks (HI-2950/s10) deleted, only in a write that finds the cycle still
 * ended in its own transaction (the card reopened or re-approved meanwhile: nothing deleted). `checks`: the checks
 * journals' keys whose leases are freed. Whether it deleted.
 */
export async function clearEndedCycle(wf: Workflow, card: CardRecord, project: string, cycle: number, checks: readonly string[]): Promise<boolean> {
  let done = false
  await wf.write(card, null, 'combwork', (w) => {
    if (!cycleEnded(wf.store.card(card.id), w.state(), cycle)) return
    w.tx.sql((db) => {
      const del = db.prepare('DELETE FROM board_meta WHERE key = ?') // i18n-ignore: SQL
      del.run(candidateKey(project, card.key, cycle))
      for (const k of checks) del.run(k)
    })
    done = true
  })
  return done
}

/** What a candidate's checks run came to, as the runner publishes it (HI-2938). */
export type JjChecksUpdate =
  | { progress: { done: number; current?: string } }
  /** The checks' key changed (other checks, commands, install or setup): they start anew under it (HR1's round 1 finding 3). */
  | { restart: string[] }
  | { passed: string[] }
  | { waiting: string }
  | { stopped: string }
  | { failing: string }
  | { red: { check: string; output: string; logPath?: string; expected: string } }

/**
 * Publishes a candidate's checks' progress or outcome (HI-2938/s11 §2), only in a write that finds, in its own
 * transaction, the card's fingerprint still `fp`, its record still this attempt's with checks under `key`, and `key` the
 * one the card's options give now with the project's setup command (`setup`, read just before). `current`: the target
 * still at the candidate's head and the candidate still its recorded commit (read just before; false fails closed).
 * A red check returns the card to its builder (`IntegrationFailed`, as the queue's red check does). Whether it wrote.
 */
export async function publishCandidateChecks(wf: Workflow, card: CardRecord, project: string, at: { fp: JjCandidateFingerprint; attempt: string; key: string; setup: string; setupStill?: () => boolean }, u: JjChecksUpdate, current: boolean): Promise<boolean> {
  if (!current) return false
  const key = candidateKey(project, card.key, at.fp.cycle)
  let wrote = false
  await wf.write(card, 'red' in u ? wf.rulesetOf(card) : null, 'outside', (w) => {
    const now = wf.store.card(card.id)
    const st = w.state()
    if (!sameFingerprint(candidateFingerprint(wf, now, st), at.fp)) return
    if (checksKeyOf(wf.rulesetOf(now, st).options, at.setup) !== at.key) return
    // The setup command still the one the key was made with (finding 3): project.json unchanged since it was read.
    if (at.setupStill && !at.setupStill()) return
    let rec: JjCandidateShown | null = null
    w.tx.sql((db) => {
      const had = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value: string } | undefined // i18n-ignore: SQL
      try {
        rec = had ? (JSON.parse(had.value) as JjCandidateShown) : null
      } catch {
        rec = null
      }
    })
    const r = rec as JjCandidateShown | null
    if (!r || r.state !== 'ready' || r.offer?.attempt !== at.attempt || !r.checks || (!('restart' in u) && r.checks.key !== at.key)) return
    if ('red' in u) {
      const failed: FactData['IntegrationFailed'] = { entry: jjCandidateEntry(at.attempt), revision: at.fp.revision, target: at.fp.target, reason: 'checks', transient: false, check: u.red.check, ...(u.red.logPath ? { logPath: u.red.logPath } : {}), ...(u.red.output ? { log: u.red.output.slice(-4000) } : {}) } // i18n-ignore: a failure's code, not text
      w.fact('IntegrationFailed', failed)
      w.tx.sql((db) => void db.prepare('DELETE FROM board_meta WHERE key = ?').run(key)) // i18n-ignore: SQL
      wrote = true
      if (!wf.cfg.reconcileActs) return
      w.move('active', 'derived')
      wf.wake(w, st.started?.builder, jjReturnedWake(card.key, failed))
      w.action('comment', { ...jjReturnedComment(card.key, failed) })
      return
    }
    const c = r.checks!
    const next: JjCandidateChecksShown =
      'restart' in u
        ? { key: at.key, names: u.restart, state: 'running', done: 0 }
        : 'progress' in u
        ? { key: c.key, names: c.names, state: 'running', done: u.progress.done, ...(u.progress.current ? { current: u.progress.current } : {}) }
        : 'passed' in u
          ? { key: c.key, names: c.names, state: 'passed', done: c.names.length }
          : 'waiting' in u
            ? { ...c, state: 'waiting', why: u.waiting }
            : 'stopped' in u
              ? { ...c, state: 'stopped', why: u.stopped }
              : { ...c, state: 'failing', why: u.failing, misses: (c.state === 'failing' ? (c.misses ?? 1) : 0) + 1 }
    const row: JjCandidateShown = { ...r, checks: next, at: Date.now() }
    w.tx.sql((db) => void db.prepare('UPDATE board_meta SET value = ? WHERE key = ?').run(JSON.stringify(row), key)) // i18n-ignore: SQL
    wrote = true
  })
  return wrote
}

/** HI-2938's Run Checks Again: a stopped or failing candidate's checks running again, under the same validity (s11 §1). */
export async function checksAgain(wf: Workflow, card: CardRecord, project: string, setup: string, current: boolean): Promise<boolean> {
  const s = wf.state(card)
  const rec = candidateShown(wf, card, s, project, undefined, true)
  if (!rec?.offer || !rec.checks || (rec.checks.state !== 'stopped' && rec.checks.state !== 'failing')) return false
  const fp = candidateFingerprint(wf, card, s)
  if (!fp) return false
  return publishCandidateChecks(wf, card, project, { fp, attempt: rec.offer.attempt, key: rec.checks.key, setup }, { progress: { done: 0 } }, current)
}

/**
 * HI-2871's step (design HI-2871/s21): J4's candidate for the card's exact approval, answered only while the card is
 * still that approval under the same rules and its target still at the head it was built on, each checked in the write
 * that publishes it. A candidate: its record for the window. A conflict or not up to date: the card back to its
 * builder (`IntegrationFailed`, as the queue returns one). The repository signs: a record saying so. Unknown: nothing
 * offered or returned; counted, and said once it has happened CANDIDATE_MISSES times in a row.
 */
async function candidateFor(wf: Workflow, card: CardRecord, s: CardState, ports: JjReconcilePorts, hooks: ReconcileHooks): Promise<void> {
  const fp = candidateFingerprint(wf, card, s)
  if (!fp || !ports.candidate) return
  const project = ports.projectId()
  const stillIn = (c: CardRecord, st: CardState): boolean => sameFingerprint(candidateFingerprint(wf, c, st), fp)
  const still = (): boolean => {
    const c = wf.store.card(card.id)
    return stillIn(c, wf.state(c))
  }
  const key = candidateKey(project, card.key, fp.cycle)
  const prior = (db: { prepare(sql: string): { get(...a: string[]): unknown } }): JjCandidateShown | null => {
    const had = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value: string } | undefined // i18n-ignore: SQL
    try {
      return had ? (JSON.parse(had.value) as JjCandidateShown) : null
    } catch {
      return null
    }
  }
  // HR3's rounds 1 and 2: a ready offer that isn't current any more (its head not the target's, its candidate superseded
  // or gone, or either unreadable) is withdrawn before anything is recovered, dropped or rebuilt, so an interrupted or
  // failed rebuild never leaves it offered. Only that exact row.
  const raw = wf.store.boardMeta(key)
  let had: JjCandidateShown | null = null
  try {
    had = raw ? (JSON.parse(raw) as JjCandidateShown) : null
  } catch {
    had = null
  }
  if (had?.state === 'ready' && had.offer && !(ports.offerCurrent && (await ports.offerCurrent(fp.target, had.offer)))) {
    const seen = had
    await wf.write(card, null, 'outside', (w) => {
      w.tx.sql((db) => {
        const now = prior(db)
        if (now && now.gen === seen.gen && now.offer?.attempt === seen.offer?.attempt) db.prepare('DELETE FROM board_meta WHERE key = ?').run(key) // i18n-ignore: SQL
      })
    })
  }
  const gen = await reserveContained(wf, project)
  const step = await ports.candidate(card, s, fp, still)
  const put = (rec: Omit<JjCandidateShown, 'gen' | 'fp' | 'at'>) => async (): Promise<void> => {
    await wf.write(card, null, 'outside', (w) => {
      if (!sameCycle(w, s) || !stillIn(wf.store.card(card.id), w.state())) return
      w.tx.sql((db) => {
        const was = prior(db)
        if (was && was.gen >= gen) return
        const misses = rec.state === 'unknown' ? (was?.state === 'unknown' && sameFingerprint(was.fp, fp) ? (was.misses ?? 1) + 1 : 1) : undefined
        const row: JjCandidateShown = { gen, fp, ...rec, ...(misses ? { misses } : {}), at: Date.now() }
        db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(row)) // i18n-ignore: SQL
      })
    })
  }
  if ('unknown' in step) {
    await put({ state: 'unknown', why: step.unknown })()
    return hooks.unknown?.(`candidate: ${step.unknown}`)
  }
  if ('none' in step) return put({ state: 'signing' })()
  // A candidate or a return is published only while the target is still at the head it was built on.
  const expected = 'offer' in step ? step.offer.expected : step.returned.expected
  if (!ports.headIs || !(await ports.headIs(fp.target, expected))) return
  await hooks.afterRead?.()
  if ('offer' in step) {
    // HI-2938: with merge checks configured, offered only once they pass: until then running, its progress kept for
    // exactly this attempt and checks key (a new attempt or key starts them anew).
    const cn = ports.checksNow ? await ports.checksNow(card, s) : { key: '', names: [] }
    const offer = step.offer
    await wf.write(card, null, 'outside', (w) => {
      if (!sameCycle(w, s) || !stillIn(wf.store.card(card.id), w.state())) return
      w.tx.sql((db) => {
        const was = prior(db)
        if (was && was.gen >= gen) return
        const kept = was?.offer?.attempt === offer.attempt && was.checks?.key === cn.key ? was.checks : undefined
        const checks: JjCandidateChecksShown | undefined = cn.names.length ? (kept ?? { key: cn.key, names: cn.names, state: 'running', done: 0 }) : undefined
        const row: JjCandidateShown = { gen, fp, state: 'ready', offer, ...(checks ? { checks } : {}), at: Date.now() }
        db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(row)) // i18n-ignore: SQL
      })
    })
    if (cn.names.length) ports.checksWanted?.()
    return
  }
  const f = step.returned
  await wf.write(card, wf.rulesetOf(card, s), 'outside', (w) => {
    if (!sameCycle(w, s) || !stillIn(wf.store.card(card.id), w.state())) return
    const failed: FactData['IntegrationFailed'] = { entry: jjCandidateEntry(f.attempt), revision: fp.revision, target: fp.target, reason: f.reason === 'conflict' ? 'conflict' : 'notUpToDate', transient: false, ...(f.files?.length ? { files: f.files } : {}), ...(f.log ? { log: f.log.slice(-4000) } : {}), ...(f.conflicts?.files.length ? { conflicts: f.conflicts } : {}) } // i18n-ignore: a failure's code, not text
    w.fact('IntegrationFailed', failed)
    w.tx.sql((db) => void db.prepare('DELETE FROM board_meta WHERE key = ?').run(key)) // i18n-ignore: SQL
    if (!wf.cfg.reconcileActs) return
    w.move('active', 'derived')
    wf.wake(w, w.state().started?.builder, jjReturnedWake(card.key, failed))
    w.action('comment', { ...jjReturnedComment(card.key, failed) })
  })
}

/** J5's answer for an approved submission: contained (with what to record), not contained, or why it couldn't say. */
export type JjProved =
  | { contained: true; method: 'merge' | 'fastForward' | 'squash' | 'sameTree'; result: string; bundle: string; platform: Record<string, unknown> }
  | { contained: false }
  | { unknown: string }

/** The window's containment record of a jj card's cycle (HI-2869/s13, s16), board_meta, by the project's canonical id. */
export const containedKey = (project: string, card: string, cycle: number): string => `jj_contained:${project.toLowerCase()}:${card.toLowerCase()}:${cycle}`
const containedGenKey = (project: string): string => `jj_contained_gen:${project.toLowerCase()}`

/** A containment record as the window reads it: the exact approval it was observed for, and what was observed. */
export interface JjContained {
  gen: number
  submission: number
  revision: string
  base: string
  key: string | null
  commit: string | null
  target: string
  state: 'notYet' | 'unknown'
  why?: string
  at: number
}

/** A new observation's generation, from the project's counter, moved in its own board write (monotonic, never a clock). */
async function reserveContained(wf: Workflow, project: string): Promise<number> {
  let gen = 0
  await wf.locked(async () =>
    wf.store.tx((tx) =>
      tx.sql((db) => {
        db.prepare("INSERT INTO board_meta (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run(containedGenKey(project)) // i18n-ignore: SQL
        gen = Number((db.prepare('SELECT value FROM board_meta WHERE key = ?').get(containedGenKey(project)) as { value: string }).value) // i18n-ignore: SQL
      })
    )
  )
  return gen
}

/**
 * The observation recorded for the window (HI-2869/s13, s16): only while the card is still exactly the approval observed
 * (its cycle, stage, approved submission, endpoints, jj commit and target, checked in the write), and only over no record
 * or a lower generation's (an older observation finishing later writes nothing).
 */
async function noteContained(wf: Workflow, card: CardRecord, s: CardState, snap: ApprovalSnapshot, project: string, gen: number, seen: { state: 'notYet' | 'unknown'; why?: string }): Promise<void> {
  await wf.write(card, null, 'outside', (w) => {
    if (!sameCycle(w, s) || !sameApproval(snap, approvalOf(wf.store.card(card.id), w.state()))) return
    w.tx.sql((db) => {
      const k = containedKey(project, card.key, s.cycle)
      const had = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(k) as { value: string } | undefined // i18n-ignore: SQL
      let stored = 0
      try {
        stored = had ? Number((JSON.parse(had.value) as { gen?: number }).gen ?? 0) : 0
      } catch {
        stored = 0
      }
      if (had && stored >= gen) return
      const rec: JjContained = { gen, submission: snap.submission, revision: snap.revision, base: snap.base, key: snap.key, commit: snap.commit, target: snap.target, state: seen.state, ...(seen.why ? { why: seen.why } : {}), at: Date.now() }
      db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(rec)) // i18n-ignore: SQL
    })
  })
}

/** What a jj proof was made for: the card's exact approval, rechecked in the Integrated write (HI-2882/s10 §2). */
interface ApprovalSnapshot {
  cycle: number
  stage: StageId
  submission: number
  revision: string
  base: string
  key: string | null
  /** The approved submission's jj commit id as recorded (its `platform.jj`), or null. */
  commit: string | null
  target: string
}

const jjCommitOf = (platform: unknown): string | null => {
  const j = platform && typeof platform === 'object' ? (platform as { jj?: { commitId?: unknown } }).jj : null
  return j && typeof j.commitId === 'string' ? j.commitId : null
}

function approvalOf(card: CardRecord, s: CardState): ApprovalSnapshot | null {
  if (!s.approved?.revision || !s.approved.base || !s.latest) return null
  return { cycle: s.cycle, stage: card.stage, submission: s.latest.id, revision: s.approved.revision, base: s.approved.base, key: s.latest.key ?? null, commit: jjCommitOf(s.latest.platform), target: s.started?.target ?? '' }
}

const sameApproval = (a: ApprovalSnapshot, b: ApprovalSnapshot | null): boolean => !!b && a.cycle === b.cycle && a.stage === b.stage && a.submission === b.submission && a.revision === b.revision && a.base === b.base && a.key === b.key && a.commit === b.commit && a.target === b.target

/**
 * A jj card's reconciliation (HI-2882's J9b2, design HI-2882/s7–s22; SPEC §16.4.4's table for a platform whose user
 * integrates, option A): Gone for the repository or the slot folder; its head observed (HeadMoved); in Approved, J5's
 * proof first (contained: `Integrated` by outside, recorded only while the card is still exactly the approval proved, its
 * obligation and retained bundle in the same write, then Done), else Git's stale and carry-over rules on the jj head. A
 * proof refused or unknown is told to `hooks.unknown` and writes nothing: never "not integrated". Not offered for jj in
 * 1.5.0: InTarget, MergedInPart and LeftTarget (each would need a containment decision outside J5's proof).
 */
export async function reconcileJj(wf: Workflow, card0: CardRecord, hooks: ReconcileHooks, ports: JjReconcilePorts): Promise<void> {
  let card = wf.store.card(card0.id)
  let s = wf.state(card)
  if (!s.started) return
  const r = wf.rulesetOf(card, s)
  const o = r.options
  const project = wf.cfg.project
  const s0 = s
  if (presence(project) === 'gone') {
    await wf.write(card, null, 'outside', (w) => sameCycle(w, s0) && w.tx.appendObserved(card.id, { kind: 'Gone', actor: 'outside', source: 'observed', dedupe: `gone:repository:${s0.cycle}`, data: { what: 'repository' } })) // i18n-ignore: a fact's kind and codes, not text
    return
  }
  if (card.stage !== 'done' && wf.ownLine(s) && presence(s.started.folder) === 'gone') {
    const folder = s.started.folder
    await wf.write(card, null, 'outside', (w) => sameCycle(w, s0) && w.state().started?.folder === folder && w.tx.appendObserved(card.id, { kind: 'Gone', actor: 'outside', source: 'observed', dedupe: `gone:folder:${s0.cycle}`, data: { what: 'folder' } })) // i18n-ignore: a fact's kind and codes, not text
    return
  }
  // Its head, once its slot is prepared (#1551: until then there is nothing of its to observe).
  if (card.stage !== 'done' && s.started.line && !slotPreparationOwed(wf, card, s)) await observeHead(wf, card, () => ports.headNow(card, s), s.started.line, hooks)
  card = wf.store.card(card.id)
  s = wf.state(card)
  if (card.stage !== 'approved') return
  // Integrated already recorded this cycle (the rules off then, or another Combwork's): its effects applied once the rules
  // act, with no new proof or rows (HR1's round 1), as Git's integration does.
  if (s.integrated) {
    if (wf.cfg.reconcileActs) await wf.write(card, r, 'outside', (w) => sameCycle(w, s) && !!w.state().integrated && w.current !== 'done' && !wf.closeWaitsFor(w).length && void w.move('done', 'derived'))
    return
  }
  const snap = approvalOf(card, s)
  if (!snap) return
  const approved = { base: snap.base, revision: snap.revision, key: snap.key }
  if (approved.revision !== s.started!.base) {
    // HI-2869: this observation's generation, reserved before anything is read (the window's containment record is
    // ordered by it, never by a clock).
    const gen = await reserveContained(wf, ports.projectId())
    const p = await ports.prove(card, s, approved)
    if ('unknown' in p) {
      await noteContained(wf, card, s, snap, ports.projectId(), gen, { state: 'unknown', why: p.unknown })
      return hooks.unknown?.(p.unknown)
    }
    if (!p.contained) await noteContained(wf, card, s, snap, ports.projectId(), gen, { state: 'notYet' })
    // HI-2871: not in its target yet, its pass holding at its slot's head: J4's candidate before the user integrates it
    // (with the rules enforced: a candidate may return the card).
    if (!p.contained && wf.cfg.reconcileActs && !s.stale && (!s.head || s.head === approved.revision)) await candidateFor(wf, card, s, ports, hooks)
    if (p.contained) {
      await hooks.afterRead?.()
      await wf.write(card, r, 'outside', (w) => {
        // Only while the card is still exactly the approval proved (its cycle, stage, approved submission and its
        // endpoints, its recorded jj ids and its target), and nothing it depends on is undone.
        const now = wf.store.card(card.id)
        if (!sameCycle(w, s) || !sameApproval(snap, approvalOf(now, w.state())) || wf.closeWaitsFor(w).length) return
        const f = w.tx.appendObserved(card.id, { kind: 'Integrated', actor: 'outside', source: 'observed', dedupe: `cycle:${s.cycle}`, data: { revision: snap.revision, target: snap.target, result: p.result, method: p.method, by: 'outside', platform: p.platform } }) // i18n-ignore: a fact's kind and codes, not text
        if (!f) return
        w.written.push(f as Fact)
        ports.record(w, { card: card.key, cycle: s.cycle, bundle: p.bundle, target: snap.target, result: p.result, since: Date.now() })
        // Integrated: its containment record goes with it (the card leaves "Waiting for you to integrate").
        w.tx.sql((db) => void db.prepare('DELETE FROM board_meta WHERE key = ?').run(containedKey(ports.projectId(), card.key, s.cycle))) // i18n-ignore: SQL
        // HI-2871: and its candidate record: nothing waits to be integrated any more.
        w.tx.sql((db) => void db.prepare('DELETE FROM board_meta WHERE key = ?').run(candidateKey(ports.projectId(), card.key, s.cycle))) // i18n-ignore: SQL
        if (wf.cfg.reconcileActs && w.current !== 'done') w.move('done', 'derived')
      })
      // HI-2871: integrated (by its candidate or the user's own way): the cycle's other candidates dropped from the
      // user's log, the one the target reaches kept.
      if (wf.state(wf.store.card(card.id)).integrated) await ports.candidatesDone?.(card, s.cycle)
      return
    }
  }
  // Not in its target: the pass follows the newest observed head, as under Git (#1623).
  const back = 'approved'
  const newest = (w: Write): boolean => sameCycle(w, s) && w.state().lastHeadFact === s.lastHeadFact && w.state().head === s.head
  if (s.head === approved.revision && s.stale) {
    const from = s.stale.current ?? approved.revision
    await wf.write(card, r, 'combwork', (w) => {
      if (!newest(w) || !w.state().stale) return
      if (observed(w, 'CarriedOver', `back:${s.cycle}:${s.lastHeadFact}`, { from, to: approved.revision, toBase: approved.base, how: 'sameRevision' }) && wf.cfg.reconcileActs) holdsAgain(wf, w)
    })
    return
  }
  if (s.stale && wf.cfg.reconcileActs && !staleApplied(wf, card, s)) {
    await wf.write(card, r, 'outside', (w) => sameCycle(w, s) && staleEffects(w, back, staleWake(card.key, approved.revision, s.stale?.current)))
    return
  }
  if (s.head && s.head !== approved.revision && !s.stale) {
    const head = s.head
    const sm = o.sameness === 'change' ? await ports.same(card, s, approved, head) : { same: false, base: null }
    if ('unknown' in sm) return hooks.unknown?.(sm.unknown)
    const { same, base } = sm
    await wf.write(card, r, 'combwork', (w) => {
      if (!sameCycle(w, s) || w.state().lastHeadFact !== s.lastHeadFact) return
      if (same && base) {
        observed(w, 'CarriedOver', `carried:${s.cycle}:${s.lastHeadFact}`, { from: approved.revision, to: head, toBase: base, how: 'replay' })
        return
      }
      observed(w, 'Stale', `stale:${s.cycle}:${s.lastHeadFact}`, { approved: approved.revision, current: head, why: o.sameness === 'exact' ? 'exact' : 'change' }) // i18n-ignore: a fact's kind and codes, not text
      if (wf.cfg.reconcileActs) staleEffects(w, back, staleWake(card.key, approved.revision, head))
    })
  }
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
async function observeTarget(wf: Workflow, H: HistoryPort, card: CardRecord, s0: CardState, hooks: ReconcileHooks): Promise<{ target: string; head: string | null } | undefined> {
  const target = s0.started?.target
  if (!target) return
  const common = await H.storeFast(wf.cfg.project)
  if (isUnknown(common)) {
    hooks.unknown?.(common.what)
    return
  }
  // Read by git first: an unreadable target is unknown (nothing recorded), where a target that doesn't exist is a value
  // of its own, null (HR4's round 2: a deleted target is recorded, X→null, and its return, null→Y).
  const seen = await H.lineHead(wf.cfg.project, target)
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
      const to = H.refSync(common, `refs/heads/${target}`)
      if (to === null && seen !== null) return
      const last = facts.filter((f) => f.kind === 'TargetMoved' && f.seq > s.cycle && (f.data as FactData['TargetMoved']).target === target).at(-1)
      const from = last ? (last.data as FactData['TargetMoved']).to : null
      if (from === to) return
      tx.appendObserved(card.id, { kind: 'TargetMoved', actor: 'outside', source: 'observed', dedupe: `target:${last?.seq ?? s.cycle}`, data: { target, from, to } })
    })
  )
  return { target, head: seen }
}
