// The merge queue's controls (#1353, SPEC §16.9.3 User controls): the queue's model (what each target's queue is doing,
// one model for the window, the Agent API and the Assistant's hive_queue), and Pause queue / Resume per project and
// target. A card's Remove from queue and Retry merge are intents on the board's intent path (cardIntents.ts). Who may:
// the user (the window), the Assistant within Settings → Assistant → Control (the Agent API, through assistantChange),
// never a project agent. The callers check it; this module does what they allowed.
//
// A pause is saved (the pause tables, reason `user` and who), so it holds across a restart and in every Hive on the
// workspace. The queue stops before its next entry; an entry mid-check finishes its checks and waits, open, without
// advancing (mergeQueue.ts). Resume clears any pause, Hive's own included, once the user says its cause is fixed: one
// whose cause Hive can see (§16.9.2's conditions, the rules off, a process or folder of an earlier runner) is checked
// first, and paused again, saying so, when it still holds.

import { basename, join } from 'path'
import { existsSync } from 'original-fs'
import { runCardIntent } from '../cardIntents'
import { git } from '../git'
import type { TaskActor } from '../tasks'
import type { TaskCard } from '../../shared/types'
import type { IntentDone } from '../../shared/toolReplies'
import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import { processAlive } from '../progressService'
import type { WorkspaceService } from '../workspace'
import { MergeQueue } from './mergeQueue'
import { kickQueue, queueChanged, queueLive } from './queueHost'
import { workflowEnforced, workflowFor } from './service'
import type { Workflow } from './runtime'
import type { CardRecord, QueuePause } from './factStore'
import { QUEUE_ADVANCE_GATE, type CardState, type Fact, type FactData } from '../../shared/workflow/facts'
import { PENDING_MAX, RECENT_MAX, type QueueQueued, type QueueRecent, type QueueResumed, type QueueTesting, type QueueView } from '../../shared/workflow/queue'

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
 * A project's queues (one target's, or every one's), as the window, the Agent API and hive_queue read them. `window`: the
 * window's listing (#1356), which also lists the targets that only have cards in flight under Hive merges, or are the
 * current options' target, so the panel can decide which show.
 */
export async function queueViews(ws: WorkspaceService, projectPath: string, target?: string, window = false): Promise<QueueView[]> {
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
  for (const card of wf.store.cards()) {
    const s = wf.state(card)
    if (!s.started || s.stage === 'todo' || s.stage === 'done') continue
    const o = wf.rulesetOf(card, s).options
    const t = s.started.target
    if (o.platform !== 'git' || o.finish !== 'hiveMerges' || !t) continue
    inFlight.set(t, [...(inFlight.get(t) ?? []), card.id])
  }
  const o = wf.currentRuleset(false).options
  let current: string | null = null
  if (o.platform === 'git' && o.finish === 'hiveMerges') {
    const def = o.target ? o.target : await G.defaultBranch(projectPath).catch(() => null)
    current = def && !isUnknown(def) ? def : null
  }
  return { inFlight, current }
}

/** One target's queue: what tests now, what waits in order, the latest outcomes, the pause and who runs it. */
export function queueView(ws: WorkspaceService, wf: Workflow, projectPath: string, target: string, scope?: QueueScope): QueueView {
  const store = wf.store
  const states = new Map<number, { card: CardRecord; s: CardState }>()
  const of = (id: number): { card: CardRecord; s: CardState } => {
    let x = states.get(id)
    if (!x) {
      const card = store.card(id)
      states.set(id, (x = { card, s: wf.state(card) }))
    }
    return x
  }
  // The entries for this target, in the order queued: those still to merge, and every entry's card (for the outcomes).
  const open: { f: Fact; card: CardRecord; state: 'open' | 'started' }[] = []
  const entries = new Set<string>()
  const cards = new Set<number>()
  for (const f of store.factsOfKind('IntegrationRequested')) {
    const d = f.data as FactData['IntegrationRequested']
    if (d.target !== target) continue
    entries.add(d.entry)
    cards.add(f.card)
    const { card, s } = of(f.card)
    const e = s.entries.find((x) => x.id === d.entry)
    if (e && (e.state === 'open' || e.state === 'started')) open.push({ f, card, state: e.state })
  }
  const live = queueLive(ws, projectPath, target)
  const lease = store.queueLease(target)
  const named = (card: CardRecord): { card: number; key: string; title: string } => ({ card: card.id, key: card.key, title: card.title })
  // Testing now: this Hive's entry at its step; else an advance begun (its recovery finishes it), or, when another
  // Hive runs the queue, its first entry (its step isn't known here).
  let testing: QueueTesting | null = null
  if (live.now) {
    const n = live.now
    testing = { ...named(store.card(n.number)), entry: n.entry, revision: n.revision, expected: n.expected, step: n.step, started: n.started, run: live.run }
  } else {
    const begun = open.find((o) => o.state === 'started') ?? (lease && !live.running ? open[0] : undefined)
    if (begun) {
      const d = begun.f.data as FactData['IntegrationRequested']
      const st = of(begun.card.id).s.entries.find((x) => x.id === d.entry)?.started
      testing = { ...named(begun.card), entry: d.entry, revision: d.revision, expected: st?.expected ?? null, step: st ? 'advance' : null, started: null, run: null }
    }
  }
  const queued: QueueQueued[] = open
    .filter((o) => (o.f.data as FactData['IntegrationRequested']).entry !== testing?.entry)
    .map((o) => {
      const d = o.f.data as FactData['IntegrationRequested']
      return { ...named(o.card), entry: d.entry, revision: d.revision, at: o.f.at }
    })
  const { recent, pending, pendingMore, pendingSeen } = recentOutcomes(wf, target, entries, cards, (id) => of(id).card, store.queueSeen())
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
    pending,
    pendingMore,
    pendingSeen,
    hiveMerges: scope?.current === target,
    inFlight: scope?.inFlight.get(target) ?? []
  }
}

/**
 * The latest outcomes of a target's entries, newest first (merged, returned to the builder, cancelled), and the returns
 * older than those still waiting to be seen (#1356; HR3's round 1 finding 2 and round 2's: every return not seen stays
 * reachable, however many outcomes came after it). Those are each their card's newest outcome: a page of the newest
 * PENDING_MAX not seen, the exact count of the rest (`pendingMore`: the panel says it, and seeing the page brings the
 * next, since a seen return leaves the page at once), and up to PENDING_MAX seen in the last minute (`pendingSeen`, so
 * a row just seen still folds in the panel).
 */
function recentOutcomes(wf: Workflow, target: string, entries: Set<string>, cards: Set<number>, card: (id: number) => CardRecord, seen: Map<string, string>): Pick<QueueView, 'recent' | 'pending' | 'pendingMore' | 'pendingSeen'> {
  const out: (QueueRecent & { seq: number })[] = []
  const named = (f: Fact) => {
    const c = card(f.card)
    return { card: c.id, key: c.key, title: c.title, at: f.at, seq: f.seq }
  }
  for (const f of wf.store.factsOfKind('Integrated')) { // i18n-ignore: a fact's kind, not text
    const d = f.data as FactData['Integrated']
    // A card of this queue merged into its target (by the queue, or seen merged outside it).
    if (d.target !== target || !cards.has(f.card) || (d.entry && !entries.has(d.entry))) continue
    out.push({ ...named(f), entry: d.entry ?? '', outcome: 'merged', result: d.result, by: d.by })
  }
  for (const f of wf.store.factsOfKind('IntegrationFailed')) {
    const d = f.data as FactData['IntegrationFailed']
    // A target that moved is tested again (a new entry), never returned.
    if (d.target !== target || !entries.has(d.entry) || d.reason === 'targetMoved') continue
    const at = seen.get(d.entry)
    out.push({ ...named(f), entry: d.entry, outcome: 'returned', reason: d.reason, transient: d.transient, ...(d.files?.length ? { files: d.files } : {}), ...(d.log ? { log: d.log } : {}), ...(at ? { seen: at } : {}) })
  }
  for (const f of wf.store.factsOfKind('IntegrationCancelled')) {
    const d = f.data as FactData['IntegrationCancelled']
    if (!entries.has(d.entry)) continue
    out.push({ ...named(f), entry: d.entry, outcome: 'cancelled', reason: d.reason })
  }
  // Newest first: by time, and by each card's own order within one instant.
  out.sort((a, b) => (a.at === b.at ? b.seq - a.seq : a.at < b.at ? 1 : -1))
  const strip = ({ seq: _seq, ...r }: QueueRecent & { seq: number }): QueueRecent => r
  const newest = new Set<number>()
  const since = Date.now() - 60_000
  const pending: QueueRecent[] = []
  const pendingSeen: QueueRecent[] = []
  let pendingMore = 0
  out.forEach((r, i) => {
    const first = !newest.has(r.card)
    newest.add(r.card)
    if (i < RECENT_MAX || !first || r.outcome !== 'returned') return
    if (!r.seen) {
      if (pending.length < PENDING_MAX) pending.push(strip(r))
      else pendingMore++
    } else if (Date.parse(r.seen) > since && pendingSeen.length < PENDING_MAX) pendingSeen.push(strip(r))
  })
  return { recent: out.slice(0, RECENT_MAX).map(strip), pending, pendingMore, pendingSeen }
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
  const still = p ? await stillPaused(wf, projectPath, target, p) : null
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
async function stillPaused(wf: Workflow, projectPath: string, target: string, p: QueuePause): Promise<Partial<QueuePause> | null> {
  switch (p.reason) {
    case 'rulesOff':
      return workflowEnforced() ? null : {}
    case 'approval': {
      const card = p.card ? wf.store.cardByKey(p.card) : null
      return card && wf.state(card).requests.some((r) => r.gate === QUEUE_ADVANCE_GATE) ? {} : null
    }
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
