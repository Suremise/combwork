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
import { queueOrder } from './queueState'
import { workflowEnforced, workflowFor } from './service'
import type { Workflow } from './runtime'
import type { CardRecord, QueuePause } from './factStore'
import { QUEUE_ADVANCE_GATE, type Fact, type FactData } from '../../shared/workflow/facts'
import { RECENT_MAX, type QueueRecent, type QueueResumed, type QueueView } from '../../shared/workflow/queue'

/** The targets of a project's queues: every target a card was queued for, and any paused one, in that order. */
export function queueTargets(wf: Workflow): string[] {
  const out = new Set<string>()
  for (const f of wf.store.factsOfKind('IntegrationRequested')) out.add((f.data as FactData['IntegrationRequested']).target)
  for (const t of wf.store.pausedTargets()) out.add(t)
  return [...out].filter(Boolean)
}

/** A project's queues (one target's, or every one's), as the window, the Agent API and hive_queue read them. */
export async function queueViews(ws: WorkspaceService, projectPath: string, target?: string): Promise<QueueView[]> {
  const wf = await workflowFor(ws, projectPath)
  if (!wf) return []
  return (target ? [target] : queueTargets(wf)).map((t) => queueView(ws, wf, projectPath, t))
}

/** One target's queue: what tests now, what waits in order, the latest outcomes, the pause and who runs it. */
export function queueView(ws: WorkspaceService, wf: Workflow, projectPath: string, target: string): QueueView {
  const store = wf.store
  // The entries for this target in the order queued, the one testing now and those waiting (queueState.ts: the order
  // card reads and refusals give agents too).
  const live = queueLive(ws, projectPath, target)
  const { entries, cards, testing, queued } = queueOrder(wf, target, live)
  const lease = store.queueLease(target)
  const recent = recentOutcomes(wf, target, entries, cards, (id) => store.card(id))
  const p = store.queuePause(target)
  return {
    project: basename(projectPath),
    projectPath,
    target,
    paused: p ? { reason: p.reason, card: p.card || null, files: p.files ?? [], by: p.by ?? null, at: p.at ?? null, ...(p.stuck ? { stuck: p.stuck } : {}) } : null,
    runBy: lease?.profile ?? null,
    runHere: live.running,
    testing,
    queued,
    recent
  }
}

/** The latest outcomes of a target's entries, newest first: merged, returned to the builder, cancelled. */
function recentOutcomes(wf: Workflow, target: string, entries: Set<string>, cards: Set<number>, card: (id: number) => CardRecord): QueueRecent[] {
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
    out.push({ ...named(f), entry: d.entry, outcome: 'returned', reason: d.reason, transient: d.transient, ...(d.files?.length ? { files: d.files } : {}), ...(d.log ? { log: d.log } : {}) })
  }
  for (const f of wf.store.factsOfKind('IntegrationCancelled')) {
    const d = f.data as FactData['IntegrationCancelled']
    if (!entries.has(d.entry)) continue
    out.push({ ...named(f), entry: d.entry, outcome: 'cancelled', reason: d.reason })
  }
  // Newest first: by time, and by each card's own order within one instant.
  out.sort((a, b) => (a.at === b.at ? b.seq - a.seq : a.at < b.at ? 1 : -1))
  return out.slice(0, RECENT_MAX).map(({ seq: _seq, ...r }) => r)
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
