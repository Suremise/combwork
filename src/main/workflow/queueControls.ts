// The merge queue's controls (#1353, SPEC §16.9.3 User controls): the queue's model (what each target's queue is doing,
// one model for the window, the Agent API and the Assistant's cw_queue), and Pause queue / Resume per project and
// target. A card's Remove from queue and Retry merge are intents on the board's intent path (cardIntents.ts). Who may:
// the user (the window), the Assistant within Settings → Assistant → Control (the Agent API, through assistantChange),
// never a project agent. The callers check it; this module does what they allowed.
//
// A pause is saved (the pause tables, reason `user` and who), so it holds across a restart and in every Hive on the
// workspace. The queue stops before its next entry; an entry mid-check finishes its checks and waits, open, without
// advancing (mergeQueue.ts). Resume clears any pause, Hive's own included, once the user says its cause is fixed: one
// whose cause Hive can see (§16.9.2's conditions, the rules off, a process or folder of an earlier runner) is checked
// first, and paused again, saying so, when it still holds.

import { app } from 'electron'
import { basename, join } from 'path'
import { existsSync } from 'original-fs'
import { boardRevision } from '../boardStore'
import { runCardIntent } from '../cardIntents'
import { onCombworkEvent } from '../events'
import { git } from '../git'
import type { TaskActor } from '../tasks'
import type { TaskCard } from '../../shared/types'
import type { IntentDone } from '../../shared/toolReplies'
import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import { processAlive } from '../progressService'
import type { WorkspaceService } from '../workspace'
import { MergeQueue } from './mergeQueue'
import { kickQueue, queueChanged, queueHostsStamp, queueLive } from './queueHost'
import { queueOrder } from './queueState'
import { entryTook, pushLogKey, pushLogOf, pushPendingKey, pushPendingOf } from './queueLogs'
import { workflowEnforced, workflowFor } from './service'
import type { Workflow } from './runtime'
import type { CardRecord, QueuePause } from './factStore'
import { MERGE_CHOICE_KEY, QUEUE_ADVANCE_GATE, type Fact, type FactData } from '../../shared/workflow/facts'
import { HISTORY_MAX, RECENT_MAX, RETURN_SEEN_SHOWN_MS, RETURNS_MAX, type BranchQueueCard, type QueueRecent, type QueueResumed, type QueueView } from '../../shared/workflow/queue'

/**
 * The targets of a project's queues: every target a card was queued for, and any paused one, in that order; for the
 * window (`also`), then the targets its cards in flight merge into under their own rules and the one its current options
 * have Hive merge into (#1356: the panel decides from these which queues show).
 */
export function queueTargets(wf: Workflow, also: Iterable<string> = []): string[] {
  const out = new Set<string>()
  for (const f of wf.store.factsOfKind('IntegrationRequested')) out.add((f.data as FactData['IntegrationRequested']).target)
  for (const t of wf.store.pausedTargets()) out.add(t)
  for (const t of also) out.add(t)
  return [...out].filter(Boolean)
}

/** Where a project's queues stand beyond their entries (#1356): its cards in flight by target, and its current target. */
interface QueueScope {
  /** Per target, the cards in flight whose own ruleset has Hive merge into it, in number order. */
  inFlight: Map<string, number[]>
  /** The target the project's current options have Hive merge into (null: they don't, or it can't be read). */
  current: string | null
}

/**
 * A project's queues (one target's, or every one's), as the window, the Agent API and cw_queue read them. `window`: the
 * window's listing (#1356), which also lists the targets that only have cards in flight under Hive merges, or are the
 * current options' target, so the panel can decide which show.
 */
export function queueViews(ws: WorkspaceService, projectPath: string, target?: string, window = false): Promise<QueueView[]> {
  const stamp = viewsStamp(ws, projectPath)
  if (stamp === null) return makeViews(ws, projectPath, target, window)
  const key = [ws.path!.toLowerCase(), projectPath.toLowerCase(), target ?? '', window ? 'window' : ''].join('\n') // i18n-ignore: a key, never shown
  const now = Date.now()
  for (const [k, e] of viewsKept) if (e.until <= now) viewsKept.delete(k)
  const had = viewsKept.get(key)
  if (had && had.stamp === stamp) return had.views
  const entry: KeptViews = { stamp, until: now + VIEWS_KEPT_MS, views: makeViews(ws, projectPath, target, window) }
  viewsKept.set(key, entry)
  entry.views.then(
    // A return seen leaves the listing RETURN_SEEN_SHOWN_MS after it was seen (recentOutcomes): kept until the first does.
    (views) => (entry.until = Math.min(entry.until, ...views.flatMap((v) => v.returns.flatMap((r) => (r.seen ? [Date.parse(r.seen) + RETURN_SEEN_SHOWN_MS] : []))))),
    () => void (viewsKept.get(key) === entry && viewsKept.delete(key))
  )
  return entry.views
}

/**
 * Queue listings worked out once per state (HI-1683): the window reads them as the board changes, in bursts (each
 * project's, the Version Control tab's, a card's), and each listing read the board's facts on main. A listing is kept,
 * and one being made shared, while what it was made from is unchanged (viewsStamp); until its first seen return folds;
 * and at most VIEWS_KEPT_MS, since its default branch is read from git.
 */
interface KeptViews {
  stamp: string
  until: number
  views: Promise<QueueView[]>
}
const viewsKept = new Map<string, KeptViews>()
const VIEWS_KEPT_MS = 5000

/** Bumped as a project's workflow is written (its options: which queues show, and its target). */
let optionsWritten = 0
onCombworkEvent((e) => {
  if (e.type === 'workflow-changed' || e.type === 'workspace-changed') optionsWritten++
})

/**
 * What a project's queue listings are made from, as a token: the board's revision (its facts, pauses, leases and seen
 * returns, committed here or by another process), this Hive's hosts of the project's queues, its options written, the
 * rules switch and the test seam. Null when the board can't say (no listing is kept then).
 */
function viewsStamp(ws: WorkspaceService, projectPath: string): string | null {
  if (!ws.path) return null
  try {
    return [boardRevision(ws), queueHostsStamp(ws, projectPath), optionsWritten, workflowEnforced(), process.env.CW_TEST_QUEUE_RETURNS ?? ''].join('\n')
  } catch {
    return null
  }
}

async function makeViews(ws: WorkspaceService, projectPath: string, target: string | undefined, window: boolean): Promise<QueueView[]> {
  const wf = await workflowFor(ws, projectPath)
  if (!wf) return []
  const scope = window ? await queueScope(wf, projectPath) : undefined
  const also = scope ? [...scope.inFlight.keys(), ...(scope.current ? [scope.current] : [])] : []
  return (target ? [target] : queueTargets(wf, also)).map((t) => queueView(ws, wf, projectPath, t, scope))
}

/**
 * Which of a project's cards are in flight under Hive merges, by target (started, not Done: a card keeps the ruleset it
 * started with, so after a switch to "The agent merges" its queue stays until its last entry has an outcome), and the
 * target its current options merge into.
 */
async function queueScope(wf: Workflow, projectPath: string): Promise<QueueScope> {
  const inFlight = new Map<string, number[]>()
  // Only the cards past Todo and not Done are read (#1629: the window polls this, and a board keeps every card it had).
  for (const card of wf.store.cardsInFlight()) {
    const s = wf.state(card)
    if (!s.started || s.stage === 'todo' || s.stage === 'done') continue
    const o = wf.rulesetOf(card, s).options
    const t = s.started.target
    if (o.platform !== 'git' || o.finish !== 'combworkMerges' || !t) continue
    inFlight.set(t, [...(inFlight.get(t) ?? []), card.id])
  }
  const o = wf.currentRuleset(false).options
  let current: string | null = null
  if (o.platform === 'git' && o.finish === 'combworkMerges') {
    const def = o.target ? o.target : await G.defaultBranch(projectPath).catch(() => null)
    current = def && !isUnknown(def) ? def : null
  }
  return { inFlight, current }
}

/** One target's queue: what tests now, what waits in order, the latest outcomes, the pause and who runs it. */
export function queueView(ws: WorkspaceService, wf: Workflow, projectPath: string, target: string, scope?: QueueScope): QueueView {
  const store = wf.store
  // The entries for this target in the order queued, the one testing now and those waiting (queueState.ts: the order
  // card reads and refusals give agents too).
  const live = queueLive(ws, projectPath, target)
  const { open, entries, cards, testing, queued } = queueOrder(wf, target, live)
  const lease = store.queueLease(target)
  // The cards in the queue again (queued or testing): their older returns aren't the panel's to show (HR3's #1356 round 3).
  const again = new Set([...open.map((o) => o.card.id), ...(testing ? [testing.card] : [])])
  const outcomes = recentOutcomes(wf, target, entries, cards, (id) => store.card(id), store.queueSeen(), again, scope ? testSize('CW_TEST_QUEUE_RETURNS', RETURNS_MAX) : RETURNS_MAX)
  const { returns, returnsMore } = outcomes
  const recent = historyOf(wf, target, outcomes.recent)
  const p = store.queuePause(target)
  return {
    project: basename(projectPath),
    projectPath,
    target,
    paused: p ? { reason: p.reason, card: p.card || null, files: p.files ?? [], by: p.by ?? null, at: p.at ?? null, ...(p.message ? { message: p.message } : {}), ...(p.stuck ? { stuck: p.stuck } : {}) } : null,
    runBy: lease?.profile ?? null,
    runHere: live.running,
    testing,
    queued,
    recent,
    returns,
    returnsMore,
    pauses: store.queuePauseLog(target),
    combworkMerges: scope?.current === target,
    inFlight: scope?.inFlight.get(target) ?? []
  }
}

/**
 * The history's own detail for the latest outcomes (HI-1924, the Progress panel's Recent merges): how long the queue took
 * over each (entryTook) and, for a merge by Hive, its push as recorded (G18). Only these few cards' facts are read.
 */
export function historyOf(wf: Workflow, target: string, recent: QueueRecent[]): QueueRecent[] {
  const facts = new Map<number, Fact[]>()
  const of = (card: number): Fact[] => facts.get(card) ?? (facts.set(card, wf.store.facts(card)), facts.get(card)!)
  const pending = new Set(pushPendingOf(wf.store.meta(pushPendingKey(target))).map((p) => p.entry))
  const settled = new Map(pushLogOf(wf.store.meta(pushLogKey(target))).map((p) => [p.entry, p.state]))
  const o = wf.cfg.options()
  const pushesNow = o.platform === 'git' && o.finish === 'combworkMerges' && o.pushTarget === true
  return recent.map((r) => {
    const took = r.entry ? entryTook(of(r.card), r.entry) : null
    const push: QueueRecent['push'] = r.outcome !== 'merged' || r.by !== 'combwork' || !r.entry ? undefined : pending.has(r.entry) ? 'pending' : (settled.get(r.entry) ?? (pushesNow ? 'unknown' : undefined))
    return { ...r, ...(took !== null ? { tookMs: took } : {}), ...(push ? { push } : {}) }
  })
}

/**
 * The latest outcomes of a target's entries, newest first (merged, returned to the builder, cancelled), and the returns
 * the panel shows (#1356's returns policy, HR3's rounds 1 to 4): every return not seen reachable, a return shown and seen
 * usable for RETURN_SEEN_SHOWN_MS, the read bounded. A return is its card's newest outcome, the card not in the queue
 * again (`again`: queued or testing), left out before anything is filled or counted. `returns` holds at most `bound`:
 * first those seen less than RETURN_SEEN_SHOWN_MS ago (kept: by seen time, newest first, then the newer outcome, then
 * the entry), then those not seen, newest first, in the slots the kept ones leave; `returnsMore` counts the unseen rest
 * exactly. Only rows the panel shows get seen, and it shows only `returns`, so kept rows never outnumber the bound and
 * nothing displaces them: the next unseen ones come as they fold (the window reads again then).
 */
function recentOutcomes(wf: Workflow, target: string, entries: Set<string>, cards: Set<number>, card: (id: number) => CardRecord, seen: Map<string, string>, again: Set<number>, bound: number, latest = RECENT_MAX): Pick<QueueView, 'recent' | 'returns' | 'returnsMore'> {
  const out: (QueueRecent & { seq: number })[] = []
  const named = (f: Fact) => {
    const c = card(f.card)
    return { card: c.id, key: c.key, title: c.title, at: f.at, seq: f.seq }
  }
  for (const f of wf.store.factsOfKind('Integrated')) { // i18n-ignore: a fact's kind, not text
    const d = f.data as FactData['Integrated']
    // A card of this queue merged into its target (by the queue, or seen merged outside it).
    if (d.target !== target || !cards.has(f.card) || (d.entry && !entries.has(d.entry))) continue
    out.push({ ...named(f), entry: d.entry ?? '', outcome: 'merged', revision: d.revision, result: d.result, by: d.by })
  }
  for (const f of wf.store.factsOfKind('IntegrationFailed')) {
    const d = f.data as FactData['IntegrationFailed']
    // A target that moved is tested again (a new entry), never returned.
    if (d.target !== target || !entries.has(d.entry) || d.reason === 'targetMoved') continue
    const at = seen.get(d.entry)
    out.push({ ...named(f), entry: d.entry, outcome: 'returned', revision: d.revision, reason: d.reason, transient: d.transient, ...(d.files?.length ? { files: d.files } : {}), ...(d.check ? { check: d.check } : {}), ...(d.logPath ? { logPath: d.logPath } : {}), ...(d.log ? { log: d.log } : {}), ...(at ? { seen: at } : {}) })
  }
  for (const f of wf.store.factsOfKind('IntegrationCancelled')) {
    const d = f.data as FactData['IntegrationCancelled']
    if (!entries.has(d.entry)) continue
    out.push({ ...named(f), entry: d.entry, outcome: 'cancelled', reason: d.reason })
  }
  // Newest first: by time; within one instant, the later card, then each card's own order (a fixed order across reads).
  const newer = (a: QueueRecent & { seq: number }, b: QueueRecent & { seq: number }): number => (a.at === b.at ? (a.card === b.card ? b.seq - a.seq : b.card - a.card) : a.at < b.at ? 1 : -1)
  out.sort(newer)
  const strip = ({ seq: _seq, ...r }: QueueRecent & { seq: number }): QueueRecent => r
  const newest = new Set<number>()
  const since = Date.now() - RETURN_SEEN_SHOWN_MS
  const kept: (QueueRecent & { seq: number })[] = []
  const unseen: (QueueRecent & { seq: number })[] = []
  for (const r of out) {
    const first = !newest.has(r.card)
    newest.add(r.card)
    if (!first || r.outcome !== 'returned' || again.has(r.card)) continue
    if (!r.seen) unseen.push(r)
    else if (Date.parse(r.seen) > since) kept.push(r)
  }
  // Kept by seen time, newest first; equal times (a page seen at once) by the newer outcome, as above.
  kept.sort((a, b) => (a.seen === b.seen ? newer(a, b) : a.seen! < b.seen! ? 1 : -1))
  const shownKept = kept.slice(0, bound)
  const slots = bound - shownKept.length
  return { recent: out.slice(0, latest).map(strip), returns: [...shownKept, ...unseen.slice(0, slots)].map(strip), returnsMore: Math.max(0, unseen.length - slots) }
}

/**
 * A test seam (unpackaged builds only, as CW_TEST_SLOW_IPC): the window model's bound on returns made smaller, so an
 * e2e reaches it with a few cards. Read at each listing (a suite sets it in main as it goes); a packaged build, or no
 * value, has the real bound.
 */
function testSize(name: string, real: number): number {
  if (app.isPackaged) return real
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 && n < real ? n : real
}

/**
 * The user saw these returned entries of a target's queue (#1356: the Progress panel's Merges tab, open in a focused
 * window): marked once, for every window and Hive, and the queue's windows told. Entries not returned in this target's
 * queue are ignored.
 */
export async function markQueueSeen(ws: WorkspaceService, projectPath: string, target: string, entries: readonly string[]): Promise<void> {
  const wf = await needWorkflow(ws, projectPath)
  const returned = new Set(wf.store.factsOfKind('IntegrationFailed').filter((f) => (f.data as FactData['IntegrationFailed']).target === target).map((f) => (f.data as FactData['IntegrationFailed']).entry))
  const marked = await wf.locked(() => wf.store.markQueueSeen(entries.filter((e) => returned.has(e))))
  if (marked) queueChanged(ws, projectPath, target)
}

/**
 * Pause queue: the target's queue stops before its next entry (one mid-check finishes its checks and waits). Saved, with
 * who; a queue paused already (by Hive, for its reason) keeps that pause, which says more.
 */
export async function pauseQueue(ws: WorkspaceService, projectPath: string, target: string, by: 'user' | 'assistant', guard?: () => void): Promise<QueueView> {
  const wf = await needWorkflow(ws, projectPath)
  await wf.locked(() => {
    // The caller's authority as it is now, in the write (the Assistant's change boundary: Control, its session).
    guard?.()
    wf.store.setQueuePause(target, { reason: 'user', card: '', by }, true) // i18n-ignore: a pause reason's code, not text
  })
  queueChanged(ws, projectPath, target)
  return queueView(ws, wf, projectPath, target)
}

/**
 * Resume: the pause cleared and the queue run, once its cause, where Hive can see it, is gone; else paused again, as
 * it is now (`resumed` false). A queue not paused is just run.
 */
export async function resumeQueue(ws: WorkspaceService, projectPath: string, target: string, guard?: () => void): Promise<QueueResumed> {
  const wf = await needWorkflow(ws, projectPath)
  const p = wf.store.queuePause(target)
  const still = p ? await stillPaused(ws, wf, projectPath, target, p) : null
  await wf.locked(() => {
    // The caller's authority as it is now, in the write: refused, nothing is cleared and the queue isn't run.
    guard?.()
    const now = wf.store.queuePause(target)
    // Changed meanwhile (another Resume, the queue pausing for something else): left as it is, said as it is.
    if (!now || !p || now.reason !== p.reason || now.at !== p.at) return
    wf.store.setQueuePause(target, still ? { ...p, ...still, at: undefined } : null)
  })
  queueChanged(ws, projectPath, target)
  if (!still) void kickQueue(ws, projectPath, target)
  return { resumed: !still, view: queueView(ws, wf, projectPath, target) }
}

/**
 * The user's answer to a stuck advance's request (#1351, For you): its needs-you pause looked at again, as Resume does,
 * and lifted once recovery can carry on. Any other pause (Pause queue, say) stays as it is.
 */
export async function recheckStuck(ws: WorkspaceService, projectPath: string, target: string): Promise<void> {
  const wf = await workflowFor(ws, projectPath)
  if (wf?.store.queuePause(target)?.reason === 'needsYou') await resumeQueue(ws, projectPath, target)
}

/**
 * A target's queue history (#1357, the Git tab's Merge queue section): its latest HISTORY_MAX outcomes, newest first
 * (merged with the result, returned with why, cancelled), each with its card. The window's only.
 */
export async function queueHistory(ws: WorkspaceService, projectPath: string, target: string): Promise<QueueRecent[]> {
  const wf = await workflowFor(ws, projectPath)
  if (!wf) return []
  const { entries, cards } = queueOrder(wf, target, queueLive(ws, projectPath, target))
  return recentOutcomes(wf, target, entries, cards, (id) => wf.store.card(id), wf.store.queueSeen(), new Set(), 0, HISTORY_MAX).recent
}

/**
 * The card an agent's worktree branch is for, when Hive merges it (#1357, the Merge dialog, OP-13): a card in flight
 * (started, not Done) on that line whose own ruleset has Hive merge it, with the rules enforced; and where it stands in
 * the queue. Null: no such card (the dialog merges as ever).
 */
export async function branchQueueCard(ws: WorkspaceService, projectPath: string, branch: string): Promise<BranchQueueCard | null> {
  const wf = await workflowFor(ws, projectPath)
  if (!wf || !workflowEnforced() || !branch) return null
  for (const card of wf.store.cardsInFlight()) {
    const s = wf.state(card)
    if (!s.started || s.started.line !== branch || s.stage === 'todo' || s.stage === 'done') continue
    const o = wf.rulesetOf(card, s).options
    if (o.platform !== 'git' || o.finish !== 'combworkMerges') continue
    const target = s.entries.at(-1)?.target ?? s.started.target ?? ''
    const v = target ? queueView(ws, wf, projectPath, target) : null
    const at = v?.queued.findIndex((q) => q.card === card.id) ?? -1
    const where: BranchQueueCard['where'] = v?.testing?.card === card.id ? 'testing' : at >= 0 ? 'queued' : s.stage === 'merging' ? 'queued' : 'notYet'
    return { card: card.id, key: card.key, title: card.title, target, where, ...(at >= 0 ? { position: at + 1 + (v?.testing ? 1 : 0) } : {}), paused: !!v?.paused }
  }
  return null
}

/**
 * The user merged a Hive-merges card's branch from the Merge dialog anyway (#1357, OP-13): an override on the card, its
 * reason given. The merge itself is observed as one done outside Hive (§16.4.4), which cancels its queue entry.
 */
export async function mergedOutsideQueue(ws: WorkspaceService, projectPath: string, n: number, reason: string): Promise<void> {
  const wf = await needWorkflow(ws, projectPath)
  await wf.mergedOutsideQueue(n, reason)
}

/**
 * A card's Remove from queue or Retry merge, by the user or the Assistant (an agent is refused by the intent path),
 * with its reason: the card's intent (cardIntents.ts), then its target's queue told of it (Retry's requeue runs it).
 */
export async function queueCardChange(ws: WorkspaceService, n: number, actor: TaskActor, kind: 'removeFromQueue' | 'retryMerge', reason: string, guard?: () => void): Promise<{ done: IntentDone; card: TaskCard }> {
  const r = await runCardIntent({ n, plain: false }, actor, { kind, reason, ...(guard ? { guard } : {}) })
  const projectPath = ws.path && r.card.project ? join(ws.path, r.card.project) : null
  const wf = projectPath ? await workflowFor(ws, projectPath).catch(() => null) : null
  const target = wf ? wf.state(wf.store.card(n)).entries.at(-1)?.target : undefined
  if (projectPath && target) queueChanged(ws, projectPath, target)
  return r
}

async function needWorkflow(ws: WorkspaceService, projectPath: string): Promise<Workflow> {
  const wf = await workflowFor(ws, projectPath)
  if (!wf) throw new Error('no workflow for this project') // i18n-ignore: callers check the project has one first
  return wf
}

/**
 * Whether a pause's cause still holds, as far as Hive can see it now: the rules still off; §16.9.2's conditions on its
 * folder; the user's answer to "update it now" still awaited (For you: Resume doesn't stand in for it); a begun advance
 * still in its terminal state; an earlier runner's process still running or its folder still there. What it finds (the
 * files named now), or null when it is gone or Hive can't tell (Pause queue, targetMovesFast…: the user's word). A
 * `checkedOut` pause is from before #1351: Hive merges into a checked-out target now.
 */
async function stillPaused(ws: WorkspaceService, wf: Workflow, projectPath: string, target: string, p: QueuePause): Promise<Partial<QueuePause> | null> {
  switch (p.reason) {
    case 'rulesOff':
      return workflowEnforced() ? null : {}
    case 'approval': {
      const card = p.card ? wf.store.cardByKey(p.card) : null
      return card && wf.state(card).requests.some((r) => r.gate === QUEUE_ADVANCE_GATE) ? {} : null
    }
    // HI-1697: the merge style and commit message still to be chosen (the For you answer, or a save of the options).
    case 'mergeChoice':
      return (await ws.projectConfig(projectPath).catch(() => null))?.workflow?.mergeAsk && !wf.store.meta(MERGE_CHOICE_KEY) ? {} : null
    case 'wrongBranch':
    case 'staged':
    case 'unstagedChanges': {
      const where = await G.checkouts(projectPath)
      if (isUnknown(where)) return {}
      const folder = where[target]
      if (!folder) return null
      if (p.reason === 'wrongBranch') return (await G.branch(folder)) === target ? null : {}
      if (p.reason === 'staged') return (await git(folder, ['diff', '--cached', '--quiet'])).code === 0 ? null : {}
      if (!p.files?.length) return null
      const st = await git(folder, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...p.files])
      const busy = st.out.split('\0').filter(Boolean).map((l) => l.slice(3))
      return !st.ok || busy.length ? { files: busy.length ? busy : p.files } : null
    }
    case 'needsYou': {
      // An earlier runner's process or folder (#1360): the next runner settles it again, and pauses again if it can't.
      if (!p.card) return (p.pid && processAlive(p.pid)) || (p.files?.[0] && existsSync(p.files[0])) ? {} : null
      const q = new MergeQueue(wf, { folder: '', runCheck: async () => ({ ok: false, output: '' }) })
      const files = await q.stillStuck(target)
      return files ? { files } : null
    }
    default:
      return null
  }
}
