// The merge queue's controls (#1353, SPEC §16.9.3 User controls): the queue's model (what each target's queue is doing,
// one model for the window, the Agent API and the Assistant's cw_queue), and Pause queue / Resume per project and
// target. A card's Remove from queue and Retry merge are intents on the board's intent path (cardIntents.ts). Who may:
// the user (the window), the Assistant within Settings → Assistant → Control (the Agent API, through assistantChange),
// never a project agent. The callers check it; this module does what they allowed.
//
// A pause is saved (the pause tables, reason `user` and who), so it holds across a restart and in every Combwork on the
// workspace. The queue stops before its next entry; an entry mid-check finishes its checks and waits, open, without
// advancing (mergeQueue.ts). Resume clears any pause, Combwork's own included, once the user says its cause is fixed: one
// whose cause Combwork can see (§16.9.2's conditions, the rules off, a process or folder of an earlier runner) is checked
// first, and paused again, saying so, when it still holds.

import { queueIntegration } from '../platform/integrationPorts'
import { app } from 'electron'
import { CombworkError, combworkError } from '../combworkError'
import type { OpsFor } from '../platform/repoOps'
import { fmt, msg, tr } from '../../shared/i18n'
import { withValues } from '../../shared/advanced'
import { forwardOf } from '../../shared/workflow/compile'
import { merges } from '../../shared/platform/descriptors'
import { branchExists, defaultBranch, forwardSources, projectTargets, type ProjectTargets } from './targets'
import { forwardDirection, type ForwardDirection, type ForwardOverride } from '../../shared/workflow/forwardOrder'
import { forwardNow, type ForwardPair } from './forwardNow'
import { isRefusal } from './runtime'
import { basename, join } from 'path'
import { existsSync } from 'original-fs'
import { boardRevision } from '../boardStore'
import { runCardIntent } from '../cardIntents'
import { onCombworkEvent } from '../events'
import type { TaskActor } from '../tasks'
import type { FolderChangeAction, QueueChangesSettled, QueuePauseRef, TaskCard } from '../../shared/types'
import type { IntentDone } from '../../shared/toolReplies'
import { historyFor, lineHistory } from '../platform/historyPorts'
import { isUnknown, type Unknown } from '../platform/types'
import { workflowMessage } from '../../shared/workflow/texts'
import { processAlive } from '../progressService'
import type { WorkspaceService } from '../workspace'
import { catchUpKey, catchUpPaused, MergeQueue } from './mergeQueue'
import { kickQueue, queueChanged, queueHostsStamp, queueLive } from './queueHost'
import { queueOrder } from './queueState'
import { entryTook, pushLogKey, pushLogOf, pushPendingKey, pushPendingOf } from './queueLogs'
import { workflowEnforced, workflowFor } from './service'
import type { Workflow } from './runtime'
import type { CardRecord, QueuePause } from './factStore'
import { MERGE_CHOICE_KEY, overridableEntry, QUEUE_ADVANCE_GATE, type Fact, type FactData } from '../../shared/workflow/facts'
import { HISTORY_MAX, RECENT_MAX, RETURN_SEEN_SHOWN_MS, RETURNS_MAX, type BranchQueueCard, type QueueForward, type QueueRecent, type QueueResumed, type QueueView } from '../../shared/workflow/queue'

/**
 * The targets of a project's queues: every target a card was queued for, and any paused one, in that order; for the
 * window (`also`), then the targets its cards in flight merge into under their own rules and the one its current options
 * have Combwork merge into (#1356: the panel decides from these which queues show).
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
  /** Per target, the cards in flight whose own ruleset has Combwork merge into it, in number order. */
  inFlight: Map<string, number[]>
  /** The target the project's current options have Combwork merge into (null: they don't, or it can't be read). */
  current: string | null
  /** HI-3169: the project's cards not Done, by number, read once for the listing (each target's queue order, the open pairs). */
  open: ReadonlyMap<number, CardRecord>
}

/**
 * A project's queues (one target's, or every one's), as the window, the Agent API and cw_queue read them: the same
 * targets and the same classification for each (HI-2994), so agents see every queue the user does. Listed: the targets
 * with an entry or a pause, those with cards in flight under Combwork merges, the current options' target and the
 * project's other existing targets; the panel then decides which show (queueShown), the API leaves out past branches'.
 * `window`: the window's own detail, each target's forward merges and the returns' test seam.
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
 * returns, committed here or by another process), this Combwork's hosts of the project's queues, its options written, the
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
  // HI-2994: read for every listing, the window's or the API's: a queue's cards in flight keep it from being a past
  // branch's (markPast, HI-2927), for agents as for the user.
  const scope = await queueScope(wf, projectPath)
  // HI-2679: each of the project's targets that exists, so a destination with nothing queued yet has its card (its
  // reminder and its Bring up to date… button), and its queue is cw_queue's too.
  const targets = scope.current ? await existingTargets(ws, projectPath) : []
  const also = [...scope.inFlight.keys(), ...(scope.current ? [scope.current] : []), ...targets]
  const views = (target ? [target] : queueTargets(wf, also)).map((t) => queueView(ws, wf, projectPath, t, scope, window))
  markPast(views, await projectTargets(ws, projectPath).catch(() => null))
  // HI-2885: from the sources allowed (the default branch too), so a project with one target still brings it up to date with main.
  // HI-2892: only those in the release path's direction into it: none offered, none counted, against it.
  // The window's alone (its Bring up to date… button and how far behind): not read for the API's listing.
  const sources = window && targets.length ? await forwardSources(ws, projectPath, targets) : []
  const main = sources.length > 1 ? await defaultBranch(ws, projectPath) : null
  // HI-3000: the pairs' open work, read once for the listing (the open cards alone folded), not per pair.
  const open = sources.length ? openPairs(wf, scope.open.values()) : new Map<string, CardRecord>()
  for (const v of views) {
    if (!targets.includes(v.target)) continue
    const f = await forwardOfTarget(wf, open, projectPath, v.target, sources.filter((b) => b !== v.target && forwardDirection(b, v.target, main).dir === 'forward'))
    if (f.others.length) v.forward = f
  }
  return views
}

/**
 * HI-2893: marks `past` each queue whose target is none of the project's targets now and that holds nothing: its history
 * is Version Control's. HI-2927: nothing is no entry testing or queued, no card in flight into it, no pause (a stuck one
 * too) and no Combwork running it, so those stay controllable; and targets that can't be read (`null`: not Git now, git's
 * default unreadable) mark none past: unknown isn't "no targets".
 */
export function markPast(views: QueueView[], named: ProjectTargets | null): void {
  if (!named) return
  const current = [named.default, ...named.others]
  for (const v of views) if (!current.includes(v.target) && !v.testing && !v.queued.length && !v.inFlight.length && !v.paused && !v.runBy) v.past = true
}

/** The project's targets that exist now (HI-2679): Work merges into and the others listed; none without a Git workflow. */
async function existingTargets(ws: WorkspaceService, projectPath: string): Promise<string[]> {
  const t = await projectTargets(ws, projectPath).catch(() => null)
  if (!t) return []
  const out: string[] = []
  for (const b of [t.default, ...t.others]) if ((await branchExists(projectPath, b)) === true) out.push(b)
  return out
}

/**
 * A target's forward merges (HI-2679): the other branches it may be brought up to date with (forwardSources, HI-2892: in
 * the release path's direction), and how far behind each it is; HI-3000: and the card resolving that pair, while one is open.
 */
async function forwardOfTarget(wf: Workflow, open: ReadonlyMap<string, CardRecord>, projectPath: string, to: string, sources: readonly string[]): Promise<QueueForward> {
  const others = sources.filter((b) => b !== to)
  const behind: QueueForward['behind'] = []
  for (const from of others) {
    const r = open.get(pairKey(from, to))
    const resolving = r && wf.state(r).resolves ? { card: r.id, key: r.key } : null
    behind.push({ from, commits: await commitsBehind(projectPath, from, to), ...(resolving ? { resolving } : {}) })
  }
  // HI-3126: under follow mode the window offers every source, whatever its local count (the request reads the remotes).
  return { others, behind, ...(followsRemote(wf) ? { follows: true } : {}) }
}

const pairKey = (from: string, to: string): string => `${from}\n${to}` // i18n-ignore: a key, never shown

/**
 * The open work of each branch pair (HI-2679, HI-3000), by pairKey: its forward card, or the card resolving it (Resolve
 * on a builder: the forward Done, its resolution not yet), while that isn't Done; the first by number when there are
 * several. Only the cards not Done are read and folded (`cardsOpen`): a board's Done cards cost nothing here.
 */
export function openPairs(wf: Workflow, open: Iterable<CardRecord> = wf.store.cardsOpen()): Map<string, CardRecord> {
  const out = new Map<string, CardRecord>()
  for (const c of open) {
    const st = wf.state(c)
    const pair = st.forward ?? st.resolves
    if (!pair || st.stage === 'done') continue
    const k = pairKey(pair.from, pair.to)
    if (!out.has(k)) out.set(k, c)
  }
  return out
}

/** Counts kept by the two heads they were read at (HI-2679): at most BEHIND_KEPT, the oldest dropped. */
const behindKept = new Map<string, number>()
const BEHIND_KEPT = 64

/**
 * How many commits along `from`'s first-parent history `to` lacks (HI-2679), by `git rev-list --count --first-parent`,
 * kept by both heads (a git process only when either moved); null when a head can't be read.
 */
export async function commitsBehind(projectPath: string, from: string, to: string): Promise<number | null> {
  const [a, b] = [await lineHistory().lineHead(projectPath, from), await lineHistory().lineHead(projectPath, to)]
  if (!a || !b || isUnknown(a) || isUnknown(b)) return null
  const key = [projectPath.toLowerCase(), a, b].join('\n') // i18n-ignore: a key, never shown
  const had = behindKept.get(key)
  if (had !== undefined) return had
  const n = await lineHistory().countFirstParents(projectPath, b, a)
  if (n === null) return null
  behindKept.set(key, n)
  while (behindKept.size > BEHIND_KEPT) behindKept.delete(behindKept.keys().next().value!)
  return n
}

/**
 * Which of a project's cards are in flight under Combwork merges, by target (started, not Done: a card keeps the ruleset it
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
    if (!merges(o.platform) || o.finish !== 'combworkMerges' || !t) continue
    inFlight.set(t, [...(inFlight.get(t) ?? []), card.id])
  }
  const o = wf.currentRuleset(false).options
  let current: string | null = null
  if (merges(o.platform) && o.finish === 'combworkMerges') {
    const def = o.target ? o.target : await lineHistory().defaultTarget(projectPath).catch(() => null)
    current = def && !isUnknown(def) ? def : null
  }
  return { inFlight, current, open: new Map(wf.store.cardsOpen().map((c) => [c.id, c])) }
}

/** One target's queue: what tests now, what waits in order, the latest outcomes, the pause and who runs it. */
export function queueView(ws: WorkspaceService, wf: Workflow, projectPath: string, target: string, scope?: QueueScope, window = false): QueueView {
  const store = wf.store
  // The entries for this target in the order queued, the one testing now and those waiting (queueState.ts: the order
  // card reads and refusals give agents too).
  const live = queueLive(ws, projectPath, target)
  const { open, entries, cards, testing, queued } = queueOrder(wf, target, live, scope?.open)
  const lease = store.queueLease(target)
  // The cards in the queue again (queued or testing): their older returns aren't the panel's to show (HR3's #1356 round 3).
  const again = new Set([...open.map((o) => o.card.id), ...(testing ? [testing.card] : [])])
  const outcomes = recentOutcomes(wf, target, entries, cards, store.queueSeen(), again, window ? testSize('CW_TEST_QUEUE_RETURNS', RETURNS_MAX) : RETURNS_MAX)
  const { returns, returnsMore } = outcomes
  const recent = historyOf(wf, target, outcomes.recent)
  const p = store.queuePause(target)
  return {
    project: basename(projectPath),
    projectPath,
    target,
    paused: p ? { reason: p.reason, card: p.card || null, files: p.files ?? [], by: p.by ?? null, at: p.at ?? null, ...(p.message ? { message: p.message } : {}), ...(p.stuck ? { stuck: p.stuck } : {}), ...(catchUpPaused(store.meta(catchUpKey(target)), p) ? { catchUp: true as const } : {}) } : null,
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
 * over each (entryTook) and, for a merge by Combwork, its push as recorded (G18). Only these few cards' facts are read.
 */
export function historyOf(wf: Workflow, target: string, recent: QueueRecent[]): QueueRecent[] {
  const facts = new Map<number, Fact[]>()
  const of = (card: number): Fact[] => facts.get(card) ?? (facts.set(card, wf.store.facts(card)), facts.get(card)!)
  const pending = new Set(pushPendingOf(wf.store.meta(pushPendingKey(target))).map((p) => p.entry))
  const settled = new Map(pushLogOf(wf.store.meta(pushLogKey(target))).map((p) => [p.entry, p.state]))
  const o = wf.cfg.options()
  const pushesNow = merges(o.platform) && o.finish === 'combworkMerges' && (o.pushTarget === true || o.followRemote === true)
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
function recentOutcomes(wf: Workflow, target: string, entries: Set<string>, cards: Set<number>, seen: Map<string, string>, again: Set<number>, bound: number, latest = RECENT_MAX): Pick<QueueView, 'recent' | 'returns' | 'returnsMore'> {
  const out: (QueueRecent & { seq: number })[] = []
  // HI-3169: each outcome's card named only if it is listed (below), all in one read: never the whole history's cards.
  const named = (f: Fact) => ({ card: f.card, key: '', title: '', at: f.at, seq: f.seq })
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
  const recent = out.slice(0, latest)
  const returns = [...shownKept, ...unseen.slice(0, slots)]
  const names = wf.store.cardsNumbered([...recent, ...returns].map((r) => r.card))
  const name = (r: QueueRecent & { seq: number }): QueueRecent => {
    const c = names.get(r.card)
    return { ...strip(r), key: c?.key ?? '', title: c?.title ?? '' }
  }
  return { recent: recent.map(name), returns: returns.map(name), returnsMore: Math.max(0, unseen.length - slots) }
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
 * window): marked once, for every window and Combwork, and the queue's windows told. Entries not returned in this target's
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
 * who; a queue paused already (by Combwork, for its reason) keeps that pause, which says more.
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
 * Resume: the pause cleared and the queue run, once its cause, where Combwork can see it, is gone; else paused again, as
 * it is now (`resumed` false). A queue not paused is just run.
 */
export async function resumeQueue(ws: WorkspaceService, projectPath: string, target: string, guard?: () => void, expected?: QueuePauseRef): Promise<QueueResumed> {
  const wf = await needWorkflow(ws, projectPath)
  const p = wf.store.queuePause(target)
  // HI-2944: only the pause a Commit or Set aside acted on; another one now stays as it is, shown.
  if (expected && !samePause(p, expected)) return { resumed: false, view: queueView(ws, wf, projectPath, target) }
  const still = p ? await stillPaused(ws, wf, projectPath, target, p) : null
  let cleared = false
  await wf.locked(() => {
    // The caller's authority as it is now, in the write: refused, nothing is cleared and the queue isn't run.
    guard?.()
    const now = wf.store.queuePause(target)
    // Changed meanwhile (another Resume, the queue pausing for something else): left as it is, said as it is.
    if (!now || !p || now.reason !== p.reason || now.at !== p.at) return
    wf.store.setQueuePause(target, still ? { ...p, ...still, at: undefined } : null)
    cleared = !still
  })
  queueChanged(ws, projectPath, target)
  if (!still) void kickQueue(ws, projectPath, target)
  return { resumed: expected ? cleared : !still, view: queueView(ws, wf, projectPath, target) }
}

/** HI-2944: a pause as stored is the one the window showed (its reason, card and time). */
const samePause = (p: QueuePause | null | undefined, ref: QueuePauseRef): boolean => !!p && p.reason === ref.reason && p.card === ref.card && (p.at ?? '') === ref.at

const PAUSE_NO_FOLDER = msg({ id: 'service.queue.pauseNoFolder', defaultMessage: "Combwork doesn't know which folder these changes were in. Resume the queue: it looks again and says where.", description: 'HI-2944: an error from Commit or Set aside on a paused merge from before Combwork recorded the folder of such a pause: Resume makes the queue look again, and its new pause names the folder.' })

const PAUSE_CATCH_UP_COMMIT = msg({ id: 'service.queue.catchUpNoCommit', defaultMessage: '{card} is merged and on {target}’s remote already: a commit here would put one on {target} that its remote doesn’t have. Set the changes aside instead, and {target} catches up.', description: 'HI-2988: an error from Commit on a paused merge queue whose target follows its remote: the card ({card}: its key) is already merged and published, and the pause is the local branch ({target}) catching up with it; only Set Aside (a button’s name: as translated there) is offered.' })

const PAUSE_CHANGED = msg({ id: 'service.queue.pauseChanged', defaultMessage: "The merge queue's pause changed meanwhile: nothing was committed or set aside. Look again.", description: 'HI-2944: an error from Commit or Set aside on a paused merge: the pause shown is no longer the current one (resumed, or paused for something else).' })

/**
 * HI-2944: Commit or Set aside exactly the files shown, in the folder `target` is checked out in (port 5's folderChanges,
 * which finds it and checks it again under the repository lock and its fence). From a paused merge, the pause shown must
 * still be the current one there, before anything is touched; then the queue is resumed only if that same pause still
 * stands and its condition is gone (Resume's own check, git read again). From a start's warning (no pause): only done.
 */
export async function settleQueueChanges(ws: WorkspaceService, projectPath: string, target: string, action: FolderChangeAction, shown: unknown, pause: QueuePauseRef | null, shownFolder: string | null, ops: OpsFor<'folderChanges'>): Promise<QueueChangesSettled> {
  const wf = pause ? await needWorkflow(ws, projectPath) : null
  // The folder the changes were seen in: the pause's own record (never the window's word), else the start warning's.
  const stored = wf && pause ? wf.store.queuePause(target) : null
  if (pause && !samePause(stored, pause)) throw combworkError(PAUSE_CHANGED)
  const seen = pause ? (stored?.folder ?? null) : shownFolder
  if (!seen) throw combworkError(PAUSE_NO_FOLDER)
  const current = wf && pause ? () => void (samePause(wf.store.queuePause(target), pause) || (() => { throw combworkError(PAUSE_CHANGED) })()) : undefined
  // HI-2988: the owed catch-up's pause (the card merged and published): set aside only, never committed on the local target.
  const catchUp = !!wf && catchUpPaused(wf.store.meta(catchUpKey(target)), stored)
  if (catchUp && action === 'commit') throw combworkError(PAUSE_CATCH_UP_COMMIT, { card: pause!.card, target })
  // i18n-ignore: the commit's or stash's message (in the repository, English as Combwork's other commits)
  const label = catchUp ? `before bringing ${target} up to date with ${pause!.card}` : pause ? `before merging ${pause.card}` : `before starting work on ${target}`
  const done = await ops.settleChanges(projectPath, target, seen, action, Array.isArray(shown) ? shown : [], label, current)
  if (!pause) return { done, resumed: false }
  return { done, resumed: (await resumeQueue(ws, projectPath, target, undefined, pause)).resumed }
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
  return recentOutcomes(wf, target, entries, cards, wf.store.queueSeen(), new Set(), 0, HISTORY_MAX).recent
}

/**
 * The card an agent's worktree branch is for, when Combwork merges it (#1357, the Merge dialog, OP-13): a card in flight
 * (started, not Done) on that line whose own ruleset has Combwork merge it, with the rules enforced; and where it stands in
 * the queue. Null: no such card (the dialog merges as ever).
 */
export async function branchQueueCard(ws: WorkspaceService, projectPath: string, branch: string): Promise<BranchQueueCard | null> {
  const wf = await workflowFor(ws, projectPath)
  if (!wf || !workflowEnforced() || !branch) return null
  for (const card of wf.store.cardsInFlight()) {
    const s = wf.state(card)
    if (!s.started || s.started.line !== branch || s.stage === 'todo' || s.stage === 'done') continue
    const o = wf.rulesetOf(card, s).options
    if (!merges(o.platform) || o.finish !== 'combworkMerges') continue
    const target = s.entries.at(-1)?.target ?? s.started.target ?? ''
    const v = target ? queueView(ws, wf, projectPath, target) : null
    const at = v?.queued.findIndex((q) => q.card === card.id) ?? -1
    const where: BranchQueueCard['where'] = v?.testing?.card === card.id ? 'testing' : at >= 0 ? 'queued' : s.stage === 'merging' ? 'queued' : 'notYet'
    return { card: card.id, key: card.key, title: card.title, target, where, ...(at >= 0 ? { position: at + 1 + (v?.testing ? 1 : 0) } : {}), paused: !!v?.paused }
  }
  return null
}

/**
 * The user merged a Combwork-merges card's branch from the Merge dialog anyway (#1357, OP-13): an override on the card, its
 * reason given. The merge itself is observed as one done outside Combwork (§16.4.4), which cancels its queue entry.
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
  // A forward merge's Retry (HI-2679): its source frozen again, at its head now, for the new attempt; HI-2892: refused
  // against the release path's direction, unless its own request recorded the user's override.
  const forward = kind === 'retryMerge' ? await forwardSourceNow(ws, n) : null
  const r = await runCardIntent({ n, plain: false }, actor, { kind, reason, ...(guard ? { guard } : {}), ...(forward ? { forward } : {}) })
  const projectPath = ws.path && r.card.project ? join(ws.path, r.card.project) : null
  const wf = projectPath ? await workflowFor(ws, projectPath).catch(() => null) : null
  const target = wf ? wf.state(wf.store.card(n)).entries.at(-1)?.target : undefined
  if (projectPath && target) queueChanged(ws, projectPath, target)
  return r
}

/**
 * A forward merge card's source head now (HI-2679), for its Retry; null for any other card, or one that can't be read.
 * HI-2892: throws ForwardRefused for one against the release path's direction with no override recorded.
 */
async function forwardSourceNow(ws: WorkspaceService, n: number): Promise<{ source: string } | null> {
  for (const p of ws.info()?.projects ?? []) {
    const wf = await workflowFor(ws, p.path).catch(() => null)
    const rec = wf?.store.cards().find((c) => c.id === n)
    const f = rec ? wf!.state(rec).forward : null
    if (!f) continue
    await mayGoNow(wf!, rec!, p.path, f)
    const head = await lineHistory().lineHead(p.path, f.from)
    if (!head || isUnknown(head)) return null
    // HI-3126: under follow mode, the remote's head of its source, fetched now, as the request reads it (refused, saying
    // why, when it can't be read).
    return { source: (await forwardEnds(wf!, p.path, f.from, null)).source }
  }
  return null
}

/**
 * HI-3085: Retry merge's and Resolve on a builder's direction check, the queue's own (forwardNow, HI-3049): throws
 * ForwardRefused when forward `f` can't go now, saying why. Against the release path's direction it never goes without
 * the user's override; the project folder switched to another branch (no main or master) or a default branch that can't
 * be read is only for now, and says what to do, never to remove the card.
 */
async function mayGoNow(wf: Workflow, rec: CardRecord, projectPath: string, f: ForwardPair): Promise<void> {
  const now = await forwardNow(historyFor(wf.rulesetOf(rec).options.platform), projectPath, f)
  if (now.ok) return
  if (now.is === 'direction') throw new ForwardRefused(withValues(FORWARD_TEXT.directionRetry, { card: rec.key, from: f.from, to: f.to, ...directionValues(now.d) }), { kind: 'invalid' })
  if (now.is === 'switched') throw new ForwardRefused(withValues(FORWARD_TEXT.folderSwitched, { card: rec.key, now: now.now, was: now.was }), { kind: 'conflict' })
  throw new ForwardRefused(withValues(FORWARD_TEXT.defaultUnread, { card: rec.key, from: f.from, to: f.to }), { kind: 'conflict' })
}

/** What a forward request did (HI-2679): the card it made or found already open for that pair, or nothing to do. */
export type ForwardDone = ({ upToDate: true; from: string; to: string } | { card: TaskCard; queued: boolean; from: string; to: string; overridden?: true }) & {
  /** HI-3126: under follow mode, the commits of the local `from` its remote lacks (along its first parents), not brought in. */
  localAhead?: number
}

/** Thrown for a forward request that can't be made: why, as a message (the caller's window or tool says it). */
export class ForwardRefused extends CombworkError {}

const FORWARD_TEXT = {
  title: msg({ id: 'service.forward.title', defaultMessage: 'Bring {to} up to date with {from}', description: 'HI-2679: the title of the card Combwork makes for a forward merge: it merges branch {from} into branch {to} through {to}’s merge queue. Branch names.' }),
  description: msg({ id: 'service.forward.description', defaultMessage: 'Combwork merges {from} ({source}) into {to} through {to}’s merge queue, with its merge checks, as a merge commit. Asked by {by}. If it comes back (a conflict or a red check), Retry merge tries again with {from} as it is then; Remove from queue ends it, nothing merged.', description: 'HI-2679: the description of the card Combwork makes for a forward merge. {from} and {to} are branch names, {source} a short commit id, {by} who asked (you, or the Assistant). Retry merge and Remove from queue are the card’s commands: as translated there.' }),
  byUser: msg({ id: 'service.forward.byUser', defaultMessage: 'you', description: 'HI-2679: who asked for a forward merge, in its card’s description: the user.' }),
  byAssistant: msg({ id: 'service.forward.byAssistant', defaultMessage: 'the Assistant', description: 'HI-2679: who asked for a forward merge, in its card’s description: the Combwork Assistant.' }),
  notTargets: msg({ id: 'service.forward.notTargets', defaultMessage: '{from} can’t be brought into {to}: {to} must be a branch this project merges work into ({targets}), and {from} another branch of {sources}.', description: 'HI-2679, HI-2885: a forward merge refused: {to} isn’t one of the project’s branches (Work merges into, Other branches work can merge into: {targets}, a list), {from} isn’t one of those or the repository’s default branch ({sources}, a list), or the two are the same branch.' }),
  missing: msg({ id: 'service.forward.missing', defaultMessage: '{unknown, select, yes {Combwork can’t read the branch {branch}, so nothing was queued.} other {There is no branch {branch} in this repository, so nothing was queued.}}', description: 'HI-2679: a forward merge refused: one of its branches doesn’t exist (or git couldn’t say). Keep the select keys.' }),
  raced: msg({ id: 'service.forward.raced', defaultMessage: 'The forward merge’s card changed while it was being queued, so nothing more was done: look at the card, then ask again if needed.', description: 'HI-2679: a forward merge whose new card was changed (started, moved) before it could be queued; rare.' }),
  direction: msg({ id: 'service.forward.direction', defaultMessage: '{to} isn’t brought up to date with {from}: {why, select, older {{to} is an older version than {from}, and forward merges go from a release into the next version} default {{to} is the repository’s default branch, which a release reaches through its pull request} sameVersion {{from} and {to} name the same version, so which comes first can’t be told} other {Combwork can’t tell which of {from} and {to} comes first on the release path}}. Nothing was queued. {dir, select, backward {Bring {from} up to date with {to} instead, or, if you mean it, ask the Assistant with your explicit override.} other {If you mean it, ask the Assistant with your explicit override.}}', description: 'HI-2892: a forward merge refused: it would bring branch {to} up to date with branch {from} against the release path’s direction (forward merges go from a release, or main, into the next version). {why} says why (select: translate each; keep the keys): {to} is an older version, {to} is the repository’s default branch (main), the two names are the same version, or Combwork can’t order them. {dir}: backward (the reverse is the right way) or other. Branch names stay as they are.' }),
  directionRetry: msg({ id: 'service.forward.directionRetry', defaultMessage: '{card} isn’t merged again: its request recorded no override, and {why, select, older {{to} is an older version than {from}, and forward merges go from a release into the next version} default {{to} is the repository’s default branch, which a release reaches through its pull request} sameVersion {{from} and {to} name the same version, so which comes first can’t be told} other {Combwork can’t tell which of {from} and {to} comes first on the release path}}. Remove it from the queue; to merge it anyway, ask the Assistant with your explicit override.', description: 'HI-2892: Retry merge refused on a forward-merge card ({card}: its key, such as HI-12) that brings branch {to} up to date with branch {from} against the release path’s direction, its request made without the user’s override. {why} as in the refused request (select: translate each; keep the keys). Remove from queue is the card’s command: as translated there.' }),
  folderSwitched: msg({ id: 'service.forward.folderSwitched', defaultMessage: '{card} waits: the project folder has {now} checked out, so git names {now} the default branch (this repository has no main or master), and it was {was} when {card}’s direction was checked. Check out {was} in the project folder, then try again.', description: 'HI-3085: Retry merge or Resolve on a builder held back on a forward-merge card ({card}: its key, such as HI-12): in a repository with no main or master, git names the project folder’s checked-out branch as the default, and the folder was switched from {was} to {now} since the card’s direction was checked. Nothing changed. Branch names stay as they are.' }),
  defaultUnread: msg({ id: 'service.forward.defaultUnread', defaultMessage: '{card} waits: Combwork can’t read which branch is this repository’s default now (with no main or master, it is the branch the project folder has checked out), so it can’t tell whether {from} into {to} goes the release path’s way. Put the project folder on its branch, then try again.', description: 'HI-3085: Retry merge or Resolve on a builder held back on a forward-merge card ({card}: its key) bringing branch {to} up to date with {from}: git couldn’t name the default branch (the project folder on no branch, say). Nothing changed. Branch names stay as they are.' }),
  openNoOverride: msg({ id: 'service.forward.openNoOverride', defaultMessage: '{card} is bringing {to} up to date with {from} already, without an override, so the override wasn’t applied to it: remove it from the queue first, then ask again.', description: 'HI-2892: a forward merge asked with the user’s explicit override while a card ({card}: its key) for the same pair of branches ({from} into {to}) is open already, made without one: nothing changed.' }),
  unreadable: msg({ id: 'service.forward.unreadable', defaultMessage: '{to} isn’t brought up to date with {from}: Combwork couldn’t read {what}, so nothing was queued.{detail, select, none {} other { Git said: {detail}}}', description: 'HI-3126: a forward merge (bringing branch {to} up to date with branch {from}) refused under “The target branch follows its remote”: Combwork reads both branches’ remote heads first, and one couldn’t be read. {what} says what (a phrase of its own, already translated); {detail} is Git’s own words in English, or “none” (keep the select keys). Branch names stay as they are.' }),
  noGit: msg({ id: 'service.forward.noGit', defaultMessage: 'This project merges no work through Combwork’s merge queue, so it has nothing to bring up to date.', description: 'HI-2679: a forward merge asked of a project that isn’t a Git project merging through the queue.' })
}

/** HI-3126: how long a forward request waits for each remote branch it fetches (the window or the Assistant waits for it). */
const FORWARD_FETCH_MS = 60_000

/** Whether the project's targets follow their remotes now (G21: the options as they are, as the queue reads them). */
function followsRemote(wf: Workflow): boolean {
  const o = wf.cfg.options()
  return merges(o.platform) && o.finish === 'combworkMerges' && o.followRemote === true && !!historyFor(o.platform).trackedHead
}

/** A remote read's refusal of a forward: what couldn't be read, in the window's language, and git's words. */
function unreadableForward(from: string, to: string, u: Unknown): ForwardRefused {
  const m = u.whatText ? workflowMessage(u.whatText.id) : null
  const what = m ? withValues(m, (u.whatText!.values ?? {}) as Record<string, string | number>) : u.what
  return new ForwardRefused(withValues(FORWARD_TEXT.unreadable, { from, to, what, detail: u.detail || 'none' }), { kind: 'conflict' }) // i18n-ignore: a select key
}

/**
 * HI-3126 (SPEC §16.9.4): a forward's two ends. Under follow mode the source is the head of the remote branch `from`
 * tracks, fetched now and frozen (never the local `from`, which may lack what others published or hold what was never
 * published: `localAhead` counts those, along its first parents, left out), and the destination "up to date" is read
 * against is the head of the remote branch `to` tracks, fetched too (a local `to` holding the source unpublished doesn't
 * count). A branch that tracks none: its local head. Off follow mode: both local, as before. Anything unreadable
 * (tracking set up another way, a fetch that fails): ForwardRefused, nothing queued. `to` null: the source alone (Retry).
 */
async function forwardEnds(wf: Workflow, projectPath: string, from: string, to: string | null): Promise<{ source: string; dest: string | null; localAhead: number }> {
  const H = lineHistory()
  const localHead = async (branch: string): Promise<string> => {
    const h = await H.lineHead(projectPath, branch)
    if (!h || isUnknown(h)) throw new ForwardRefused(withValues(FORWARD_TEXT.missing, { branch, unknown: isUnknown(h) ? 'yes' : 'no' }), { kind: 'conflict' }) // i18n-ignore: select keys
    return h
  }
  const local = await localHead(from)
  const localTo = to ? await localHead(to) : null
  if (!followsRemote(wf)) return { source: local, dest: localTo, localAhead: 0 }
  const P = historyFor(wf.cfg.options().platform)
  const pin = (branch: string): string => `refs/cw/forward/${branch.replace(/[^A-Za-z0-9._-]/g, '-')}`
  const remoteHead = async (branch: string, own: string): Promise<string> => {
    const r = await P.trackedHead!(projectPath, branch, pin(branch), FORWARD_FETCH_MS)
    if (isUnknown(r)) throw unreadableForward(from, to ?? from, r)
    return r === 'untracked' ? own : r
  }
  const source = await remoteHead(from, local)
  const dest = to && localTo ? await remoteHead(to, localTo) : null
  const localAhead = source === local ? 0 : ((await H.countFirstParents(projectPath, source, local)) ?? 0)
  return { source, dest, localAhead }
}

/**
 * Brings `to` up to date with `from` (HI-2679, SPEC §16.9): a forward merge, the user's or the Assistant's alone (`actor`;
 * the Assistant's guard checked again inside each write). `to` must be one of the project's existing targets, `from` another
 * of them or the repository's default branch (HI-2885: main into the next version, after a release).
 * Already contained: nothing is made. One open for the pair already: that card. Else a card of Combwork's, started on its
 * forward rules (`forwardOf`) and queued in `to`'s queue with `from`'s head frozen.
 * HI-2892: only in the release path's direction (forwardOrder.ts), unless `override` (the user's explicit choice, through
 * the Agent API alone), recorded in the card's request; an open card without one is never given it.
 */
export async function forwardMerge(ws: WorkspaceService, projectPath: string, from: string, to: string, actor: TaskActor, guard?: () => void, opts: { override?: boolean } = {}): Promise<ForwardDone> {
  if (actor.kind !== 'user' && actor.kind !== 'assistant') throw new ForwardRefused(M_FORWARD_AGENTS, { kind: 'forbidden' })
  const t = await projectTargets(ws, projectPath)
  const wf = await workflowFor(ws, projectPath)
  if (!t || !wf || wf.currentRuleset(false).options.finish !== 'combworkMerges') throw new ForwardRefused(FORWARD_TEXT.noGit, { kind: 'invalid' })
  const all = [t.default, ...t.others]
  // HI-2885: from one of them or the repository's default branch (main, after a release), into one of them.
  const sources = await forwardSources(ws, projectPath, all)
  if (from === to || !sources.includes(from) || !all.includes(to)) throw new ForwardRefused(withValues(FORWARD_TEXT.notTargets, { from, to, sources: fmt.list(sources), targets: fmt.list(all) }), { kind: 'invalid' })
  // HI-2892: the release path's direction, or the user's explicit override (bypassing the direction alone). HI-3049: the
  // default branch it read with, recorded on the request.
  const main = await defaultBranch(ws, projectPath)
  const d = forwardDirection(from, to, main)
  if (d.dir !== 'forward' && opts.override !== true) throw new ForwardRefused(withValues(FORWARD_TEXT.direction, { from, to, ...directionValues(d) }), { kind: 'invalid' })
  const override: ForwardOverride | undefined = d.dir !== 'forward' ? { by: actor.kind === 'assistant' ? 'assistant' : 'user', dir: d.dir, why: d.why } : undefined
  // Git's answers first, outside the board's lock: the heads (HI-3126: the remotes' under follow mode), whether there is
  // anything to bring in, the base.
  const ends = await forwardEnds(wf, projectPath, from, to)
  const { source } = ends
  const dest = ends.dest as string
  const ahead = ends.localAhead ? { localAhead: ends.localAhead } : {}
  const contained = await lineHistory().isAncestor(projectPath, source, dest)
  if (contained === true) return { upToDate: true, from, to, ...ahead }
  const base = await lineHistory().mergeBase(projectPath, source, dest)
  const { cardBatch, readTask, createTask, runIntent } = await import('../tasks')
  const by = actor.kind === 'assistant' ? 'assistant' : 'user'
  // One board change (HR3's round 1): the open card for the pair looked for, the caller's authority checked, the card made
  // and started with its facts and entry, all in one transaction under the board's lock, which another Combwork on the
  // board takes too. Refused or stopped part way, none of it is kept: no card without its forward facts, none twice.
  const done = await cardBatch(ws, async (): Promise<ForwardDone> => {
    // One open for this pair: that one (not Done: queued, advancing, or back for a Retry), or HI-3000 the card resolving it.
    const open = openPairs(wf).get(pairKey(from, to))
    // HI-3040: a resolution the queue returned for its direction takes the request's explicit override (recorded in its
    // own write, which checks it again, and wakes its builder to submit the same revision again); nothing else made. Its
    // direction reading forward again, no override is needed to merge: the request then only lets that revision back in.
    if (open && opts.override === true && overridableEntry(wf.state(open), from, to, !!override)) {
      const r = await runIntent(wf, open.id, actor, (x) => x.overrideResolution(open.id, { from, to, ...(override ? { override } : {}) }, by, guard), undefined, guard)
      if (isRefusal(r.reply)) throw new ForwardRefused(withValues(FORWARD_TEXT.openNoOverride, { card: open.key, from, to }), { kind: 'conflict' })
      return { card: r.saved ?? (await readTask(open.id, { kind: 'user' })), queued: false, from, to, overridden: true, ...ahead }
    }
    if (open && override && !(wf.state(open).forward ?? wf.state(open).resolves)?.override) throw new ForwardRefused(withValues(FORWARD_TEXT.openNoOverride, { card: open.key, from, to }), { kind: 'conflict' })
    if (open) return { card: await readTask(open.id, { kind: 'user' }), queued: false, from, to, ...ahead }
    guard?.()
    const made = await createTask({ title: tr(FORWARD_TEXT.title, { from, to }), description: tr(FORWARD_TEXT.description, { from, to, source: source.slice(0, 12), by: tr(by === 'user' ? FORWARD_TEXT.byUser : FORWARD_TEXT.byAssistant) }), project: basename(projectPath), labels: ['forward'] }, actor, { ...(guard ? { commit: guard } : {}) })
    // Stored by the start's own write, which records it.
    const ruleset = forwardOf(wf.currentRuleset(false), to)
    const r = await runIntent(wf, made.number, actor, (x) => x.forwardStart(made.number, { from, to, source, base: base && !isUnknown(base) ? base : dest, ...(override ? { override } : {}), ...(main ? { defaultBranch: main } : {}) }, by, ruleset, guard), undefined, guard)
    // Refused (only in a race): thrown, so the card made just now goes with the rest of this change.
    if (isRefusal(r.reply)) throw new ForwardRefused(FORWARD_TEXT.raced, { kind: 'conflict' })
    // HI-2892: `overridden`, the user's override recorded on it (a pair against the release path's direction).
    return { card: r.saved ?? made, queued: true, from, to, ...(override ? { overridden: true as const } : {}), ...ahead }
  })
  if ('card' in done && done.queued) queueChanged(ws, projectPath, to)
  return done
}

const RESOLVE_TEXT = {
  title: msg({ id: 'service.forward.resolveTitle', defaultMessage: 'Resolve: bring {to} up to date with {from}', description: 'HI-2959: the title of the card Resolve on a builder makes from a forward merge that came back with a conflict: an agent merges branch {from} into branch {to} by hand and resolves the conflict. Branch names.' }),
  description: msg({
    id: 'service.forward.resolveDescription',
    defaultMessage:
      '{forward} tried to merge {from} ({source}) into {to} and came back{why, select, conflict {{files, select, none {: a conflict.} other {: a conflict in {files}.}}} checks {{check, select, none {: a merge check failed.} other {: the merge check {check} failed.}}} other {.}} Resolve on a builder ended it and made this card, so a builder does that merge.\n\nIn this card’s branch (made from {to}): `git merge {source}`{why, select, conflict {, resolve the conflict} checks {, fix what made the check fail} other {}}, commit the merge and submit it for review, even when the merge changes no file. It merges into {to} as a merge commit, whatever the project’s merge style, so {to} keeps {from}’s history.',
    description: 'HI-2959: the description of the card Resolve on a builder makes. {forward}: the forward merge card’s key (HI-12); {from}, {to}: branch names; {source}: the commit id to merge (keep it); {why} (select): conflict when it came back with a conflict, checks when a merge check failed (HI-3082), other for anything else; {files}: the files in conflict, a list (none: leave that part out); {check}: the failed check’s name (none: not known). Keep the select keys, and the git command in backticks as it is. The merge commit is submitted even when it changes no file (it brings {from}’s history).'
  }),
  notReturned: msg({ id: 'service.forward.notReturned', defaultMessage: '{card} isn’t a forward merge the merge queue sent back, so there is nothing to resolve on a builder.', description: 'HI-2959: Resolve on a builder refused: the card ({card}: its key) isn’t a forward merge card waiting after a conflict or a red check (it is queued, merging, Done, or an ordinary card).' }),
  raced: msg({ id: 'service.forward.resolveRaced', defaultMessage: '{card} changed while it was being handed to a builder (a Retry, a Remove or another Resolve), so nothing was made: look at the card, then ask again if needed.', description: 'HI-2959: Resolve on a builder stopped part way because the forward merge card ({card}: its key) changed meanwhile; nothing was kept.' })
}

/** What Resolve on a builder did (HI-2959): the card made for a builder, and the forward merge it ended. */
export interface ForwardResolved {
  card: TaskCard
  forward: string
  from: string
  to: string
  source: string
}

/**
 * HI-2959 (SPEC §16.9): Resolve on a builder, on a forward merge the queue returned, the user's or the Assistant's alone
 * (`actor`; the Assistant's guard checked again inside each write). One board change: an ordinary code card made on the
 * forward's destination, pinned to it even when it is Work merges into now (HI-2985), linked to it, saying what came back and how to resolve it; marked its forward resolution
 * (`ForwardResolution`: its rules merge it as a merge commit); and the forward ended (Done, nothing merged). The returned
 * attempt's frozen source is what the card merges, not the source's head now. Refused or stopped part way, none of it is
 * kept: a Retry, a Remove or another Resolve meanwhile leaves no card.
 */
export async function resolveForward(ws: WorkspaceService, n: number, actor: TaskActor, reason: string, guard?: () => void): Promise<ForwardResolved> {
  if (actor.kind !== 'user' && actor.kind !== 'assistant') throw new ForwardRefused(M_FORWARD_AGENTS, { kind: 'forbidden' })
  const found = await forwardCard(ws, n)
  if (!found) throw new ForwardRefused(withValues(RESOLVE_TEXT.notReturned, { card: `#${n}` }), { kind: 'invalid' })
  const { wf, rec, projectPath } = found
  // HI-2892, as Retry: only in the release path's direction as it reads now, unless its own request recorded the user's
  // override; one returned for its direction is ended by Remove from queue alone, never handed to a builder.
  const f = wf.state(rec).forward!
  await mayGoNow(wf, rec, projectPath, f)
  // HI-3049: the default branch as it reads now, recorded on the resolution with the direction it gave.
  const main = await defaultBranch(ws, projectPath)
  const back = wf.returnedForward(rec)
  if (!back) throw new ForwardRefused(withValues(RESOLVE_TEXT.notReturned, { card: rec.key }), { kind: 'conflict' })
  const by = actor.kind === 'assistant' ? 'assistant' : 'user'
  const files = back.failed?.files?.length ? fmt.list(back.failed.files.slice(0, 20)) : ''
  // HI-3082: what it came back for, so the card asks to resolve a conflict only when there was one.
  const came = back.failed?.reason
  const why = came === 'conflict' ? 'conflict' : came === 'checks' || came === 'focused' ? 'checks' : 'other' // i18n-ignore: select keys
  const { cardBatch, createTask, runIntent } = await import('../tasks')
  const done = await cardBatch(ws, async (): Promise<ForwardResolved> => {
    guard?.()
    const made = await createTask({ title: tr(RESOLVE_TEXT.title, { from: back.from, to: back.to }), description: tr(RESOLVE_TEXT.description, { forward: rec.key, from: back.from, to: back.to, source: back.source, why, files: files || 'none', check: back.failed?.check || 'none' }), project: basename(projectPath), target: back.to, links: [rec.id] }, actor, { pinTarget: true, ...(guard ? { commit: guard } : {}) }) // i18n-ignore: a select key
    const marked = await runIntent(wf, made.number, actor, (x) => x.markForwardResolution(made.number, { forward: rec.key, from: back.from, to: back.to, source: back.source, ...(f.override ? { override: f.override } : {}), ...(main ? { defaultBranch: main } : {}) }, by, guard), undefined, guard)
    if (isRefusal(marked.reply)) throw new ForwardRefused(withValues(RESOLVE_TEXT.raced, { card: rec.key }), { kind: 'conflict' })
    // Refused (a Retry, a Remove or another Resolve since it was read): thrown, so the card made just now goes too.
    const ended = await runIntent(wf, rec.id, actor, (x) => x.resolveForward(rec.id, { entry: back.entry, resolver: wf.store.card(made.number).key }, reason, by, guard), undefined, guard)
    if (isRefusal(ended.reply)) throw new ForwardRefused(withValues(RESOLVE_TEXT.raced, { card: rec.key }), { kind: 'conflict' })
    return { card: marked.saved ?? made, forward: rec.key, from: back.from, to: back.to, source: back.source }
  })
  queueChanged(ws, projectPath, back.to)
  return done
}

/** The forward merge card `n` (HI-2679) with its project's workflow; null for any other card. */
async function forwardCard(ws: WorkspaceService, n: number): Promise<{ wf: Workflow; rec: CardRecord; projectPath: string } | null> {
  for (const p of ws.info()?.projects ?? []) {
    const wf = await workflowFor(ws, p.path).catch(() => null)
    const rec = wf?.store.cards().find((c) => c.id === n)
    if (wf && rec && wf.state(rec).forward) return { wf, rec, projectPath: p.path }
  }
  return null
}

/** A direction's values for its refusals (HI-2892): why, and whether the reverse is the release path's way. */
const directionValues = (d: ForwardDirection): { why: string; dir: string } => (d.dir === 'forward' ? { why: 'other', dir: 'other' } : { why: d.why, dir: d.dir === 'backward' ? 'backward' : 'other' }) // i18n-ignore: select keys

/** HI-2679: a forward merge asked by a project agent (or a script): the user's and the Assistant's alone. */
const M_FORWARD_AGENTS = msg({ id: 'service.forward.notAgents', defaultMessage: 'Only the user or the Assistant brings one branch up to date with another.', description: 'HI-2679: a forward merge refused: asked by a project agent or a script.' })

async function needWorkflow(ws: WorkspaceService, projectPath: string): Promise<Workflow> {
  const wf = await workflowFor(ws, projectPath)
  if (!wf) throw new Error('no workflow for this project') // i18n-ignore: callers check the project has one first
  return wf
}

/**
 * Whether a pause's cause still holds, as far as Combwork can see it now: the rules still off; §16.9.2's conditions on its
 * folder; the user's answer to "update it now" still awaited (For you: Resume doesn't stand in for it); a begun advance
 * still in its terminal state; an earlier runner's process still running or its folder still there. What it finds (the
 * files named now), or null when it is gone or Combwork can't tell (Pause queue, targetMovesFast…: the user's word). A
 * `checkedOut` pause is from before #1351: Combwork merges into a checked-out target now.
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
    case 'unstagedChanges':
      // The checked-out target's condition read again (HI-2791: the port's).
      return queueIntegration().pausedCondition(projectPath, target, p.reason, p.files)
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
