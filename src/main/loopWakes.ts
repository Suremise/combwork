import { join } from 'path'
import { projectAgents } from '../shared/defaults'
import type { TaskCard, TaskHistoryEntry } from '../shared/types'
import { HISTORY, storedText } from '../shared/taskHistory'
import { cardChange, loopWakeLine, wakeAbout } from '../shared/watch'
import { onHiveEvent } from './events'
import { listLanes, onLanesWritten } from './lanes'
import { createLogger, userText } from './logger'
import { getTask, noteOnCard, onLoopEvent, type LoopEvent, type TaskActor } from './tasks'
import { inFlightNow as watchesInFlight, settled as watchesSettled, watchCovers, watchTold } from './watches'
import { cancelFromSource, createDelivery, everyFromSource, offerNow, registerSource } from './deliveries'
import { isWaiting, type DeliveryRecord } from '../shared/deliveries'
import { workspaceFor, type WorkspaceService } from './workspace'
import { scopeOfHost, withCardNames } from './projectKeys'

/**
 * Hive's loop wakes (#405): a card loop's routine handoffs, delivered by Hive whether or not the agent set a card watch.
 * A card arriving in Review wakes its reviewer; a verdict wakes its builder (the card's agent). Only for cards with a
 * reviewer (the reviewer of a running lane with the card, else the agent that last reviewed it), so a solo user never
 * sees one; never for the agent that made the change; left to the agent's own watch when one tells it of the change; and
 * off for a project whose Project Settings → Card loops → Wake reviewers and builders is off.
 *
 * A delivery (#649, deliveries.ts: a card event, the latest per agent and card, at most a day), made at once and given
 * by the delivery service as everything is (#650: the doorbell when its agent is idle, a notice in its hooks while it
 * works). Made again just before it is offered or read, from the card and the lane as they are then (#652: what lands
 * with the handoff is in it, with no settle of its own): one no longer due is cancelled. Each one received (read with
 * hive_inbox) is noted in the card's history, as Hive.
 */

const log = createLogger('loopWakes')

/** Hive's own deliveries come from it. */
const HIVE = { kind: 'hive', name: 'Hive' } as const

const keyOf = (projectPath: string, agentId: string, n: number): string => `${projectPath.toLowerCase()}#${agentId}#${n}`
/** How long a wake waits for its agent to be idle (its session running) before it is dropped. */
const KEEP_MS = 24 * 60 * 60_000
/** For unit tests: a pause before a handoff is worked out (#578: a handoff later than the watch that tells the same change). */
export const testHooks: { beforeHandoff?: () => Promise<void> } = {}

/**
 * What loop wakes are doing in the background (#570): handoffs being worked out, and their wakes being made and tried.
 * `settled()` resolves once none is left, nor any of the watches' work they lead to. A wake waiting for its agent to be
 * idle isn't in flight: it is a delivery waiting (`pendingLoopWakes()`).
 */
const inFlight = new Set<Promise<unknown>>()
function inBackground(what: string, work: Promise<unknown>): void {
  const p = work.catch((e) => log.warn(what, e))
  inFlight.add(p)
  void p.finally(() => inFlight.delete(p))
}

/** Resolves once loop wakes and watches have nothing in flight: every handoff so far is made, kept or dropped. */
export async function settled(): Promise<void> {
  while (inFlight.size || watchesInFlight()) {
    await Promise.allSettled([...inFlight])
    await watchesSettled()
  }
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const selfOf = (actor: TaskActor): string | null => (actor.kind === 'agent' && actor.self ? actor.self.agentId : null)

/** Whether a project lets Hive wake its loops' agents (Project Settings → Card loops; on unless turned off). */
async function wakesOn(ws: WorkspaceService, projectPath: string): Promise<boolean> {
  return (await ws.projectConfig(projectPath).catch(() => null))?.loopWakes !== false
}

/**
 * A card's reviewer: the reviewer of a running lane that has the card, else the project's agent that last started
 * reviewing it (by its board name). Null: the card has none (no wakes for it).
 */
async function reviewerOf(ws: WorkspaceService, card: TaskCard, agents: { id: string; name: string }[]): Promise<string | null> {
  const lanes = await listLanes(ws, { project: card.project }).catch(() => [])
  const lane = lanes.find((l) => (l.state === 'active' || l.state === 'paused') && l.reviewer && l.cards.some((c) => c.number === card.number))
  if (lane?.reviewer) return lane.reviewer.id
  const last = card.history.findLast((h) => h.what === 'Started reviewing')
  return (last && agents.find((a) => same(`${a.name} (${card.project})`, last.by))?.id) || null
}

/**
 * Whose wake a handoff is, as the lane and the card are now: the card's reviewer for `review` (not a builder reviewing
 * its own card), its builder for `verdict`, while the card has a reviewer; an agent of the project. Null: no one's.
 */
async function targetOf(ws: WorkspaceService, projectPath: string, card: TaskCard, kind: LoopEvent['kind']): Promise<{ id: string; name: string } | null> {
  const agents = projectAgents(await ws.projectConfig(projectPath)).map((a) => ({ id: a.id, name: a.name }))
  const reviewer = await reviewerOf(ws, card, agents)
  if (!reviewer) return null
  const target = kind === 'review' ? reviewer : card.agent
  if (!target || (kind === 'review' && target === card.agent)) return null
  const agent = agents.find((a) => a.id === target)
  return agent ? { id: agent.id, name: `${agent.name} (${card.project})` } : null
}

/** A loop wake as its delivery says it: the card, whose wake (review or verdict), the agent's board name, the handoff. */
interface Wake {
  n: number
  kind: LoopEvent['kind']
  agentName: string
  since: TaskHistoryEntry | null
}
const wakeOf = (r: DeliveryRecord): Wake | null => {
  const m = r.meta ?? {}
  if (typeof m.n !== 'number' || (m.kind !== 'review' && m.kind !== 'verdict') || typeof m.agentName !== 'string') return null
  const since = typeof m.sinceAt === 'string' && m.sinceAt ? ({ at: m.sinceAt, ...(typeof m.sinceId === 'string' && m.sinceId ? { id: m.sinceId } : {}) } as TaskHistoryEntry) : null
  return { n: m.n, kind: m.kind, agentName: m.agentName, since }
}

/**
 * Queues a wake for an agent (the latest per agent and card: a newer handoff of the same card replaces one still
 * waiting), unless its own watch tells it; made, and offered.
 */
function enqueue(ws: WorkspaceService, projectPath: string, card: TaskCard, kind: LoopEvent['kind'], to: { id: string; name: string }, since: TaskHistoryEntry | null): void {
  if (watchCovers(projectPath, to.id, card.number, kind, card.column)) return
  // Its line names cards by key, its workspace's (#1219).
  inBackground('a loop wake', withCardNames(ws, async () => {
    if (!ws.path || !ws.isProjectPath(projectPath)) return
    const kinds: ('column' | 'verdict')[] = kind === 'review' ? ['column'] : ['verdict']
    const meta = { n: card.number, kind, agentName: to.name, sinceAt: since?.at ?? '', sinceId: since?.id ?? '' }
    await createDelivery(projectPath, { agentId: to.id, agentName: to.name, kind: 'card-event', from: HIVE, card: card.number, body: loopWakeLine({ ...cardChange(card.number, card, kinds), about: wakeAbout(card, kinds, to.id) }, kind), expiresMs: KEEP_MS, source: 'loop', ref: `#${card.number}`, replace: true, meta })
    await offerNow(projectPath, to.id)
  }, scopeOfHost(projectPath)))
}

/** A handoff saved (tasks.ts): whose wake it is, if anyone's, queued and tried. */
async function handoff(e: LoopEvent): Promise<void> {
  await testHooks.beforeHandoff?.()
  const { card, kind, actor } = e
  if (!e.ws.path || !card.project || card.archived) return
  const projectPath = join(e.ws.path, card.project)
  // The service itself, not the stand-in (tasks.ts's `workspace`): the wake is tried later, outside this change's call.
  const ws = workspaceFor(projectPath)
  if (!ws?.isProjectPath(projectPath) || !(await wakesOn(ws, projectPath))) return
  const to = await targetOf(ws, projectPath, card, kind)
  if (to && to.id !== selfOf(actor)) enqueue(ws, projectPath, card, kind, to, card.history.at(-1) ?? null)
}

/** The card's history since a handoff (after the entry it left; that entry trimmed off since: by its time). */
function historySince(card: TaskCard, since: TaskHistoryEntry | null): TaskHistoryEntry[] {
  if (!since) return card.history
  const i = since.id ? card.history.findIndex((h) => h.id === since.id) : -1
  return i >= 0 ? card.history.slice(i + 1) : card.history.filter((h) => h.at > since.at)
}

/**
 * Whether a waiting wake still has something to tell, from the card as it is now and what was done since its handoff:
 * a reviewer's while the card is in Review and nobody has reviewed that round (no review started nor verdict given
 * since: a round reviewed and failed meanwhile is the builder's now, #405 round 2 finding); a builder's while the card
 * is still its own and, since the verdict, neither it acted on the card nor another round started. A later arrival
 * queues a wake of its own.
 */
function stillDue(p: Wake & { agentId: string }, card: TaskCard | null): boolean {
  if (!card || card.archived) return false
  const since = historySince(card, p.since)
  if (p.kind === 'review') return card.column === 'review' && !card.review && !since.some((h) => /^(Started reviewing|Review (passed|failed))$/.test(h.what))
  if (card.agent !== p.agentId) return false
  return !since.some((h) => same(h.by, p.agentName) || /^(Moved to (the (top|bottom) of )?Review\b|Returned for review|Started reviewing)/.test(h.what))
}

/** Counts the board's and lanes' changes: a wake checked or typed while one lands is stopped and worked out again. */
let rolesSeq = 0

/**
 * A version of a wake here: its host, delivery id and version (ids are a host's own; a wake is made again before each
 * offer or hand-out, and an offered one keeps the version it was offered as).
 */
const madeKey = (host: string, id: string, v: unknown): string => `${host.toLowerCase()}#${id}#${String(v)}`
let versions = 0
/** What each wake was made again from just before it was offered (by host and delivery id): the roles' count, the card's column. */
const madeFrom = new Map<string, { seq: number; column: TaskCard['column'] }>()

/**
 * The loop wakes' part in their deliveries (#649): made again just before each offer (the line from the card as it is
 * now; dropped if no longer due, its watch tells it, or it is someone else's wake now, who gets it instead); offered only
 * while the board and lanes haven't changed since (else made again at the next try) and its watch doesn't tell it;
 * received, noted on the card.
 */
registerSource('loop', {
  refresh: async (r, host) => {
    const p = wakeOf(r)
    const ws = workspaceFor(host)
    if (!p) return { cancel: 'not a loop wake Hive can read' }
    // Its workspace closed, or switched to another folder: dropped.
    if (!ws?.path || !ws.isProjectPath(host)) return { cancel: 'its project is no longer open' }
    // Roles can change while it is checked or typed (the lane's reviewer, the card's agent): then it is worked out again.
    const seq = rolesSeq
    const card = await getTask(p.n, ws).catch(() => null)
    // Its own watch told it already (#578): a watch whose line had read this handoff's own history entry, even one that
    // has ended since (a handoff slower than the watch's settle and typing found no watch to leave it to).
    const told = !!card && !!p.since && watchTold(host, r.agentId, card, p.since)
    if (!card || !stillDue({ ...p, agentId: r.agentId }, card) || watchCovers(host, r.agentId, p.n, p.kind, card.column) || told || !(await wakesOn(ws, host))) return { cancel: 'no longer due' }
    // Only to whose wake it is now: another reviewer given the lane meanwhile gets it instead (#405 round 1 finding).
    const to = await targetOf(ws, host, card, p.kind)
    if (to?.id !== r.agentId) {
      if (to) enqueue(ws, host, card, p.kind, to, p.since)
      return { cancel: 'it is another agent\'s wake now' }
    }
    const v = ++versions
    madeFrom.set(madeKey(host, r.id, v), { seq, column: card.column })
    if (madeFrom.size > 1000) madeFrom.delete(madeFrom.keys().next().value!)
    const kinds: ('column' | 'verdict')[] = p.kind === 'review' ? ['column'] : ['verdict']
    return { body: loopWakeLine({ ...cardChange(p.n, card, kinds), about: wakeAbout(card, kinds, r.agentId) }, p.kind), meta: { ...r.meta, v } }
  },
  holds: (r, host) => {
    const p = wakeOf(r)
    const m = madeFrom.get(madeKey(host, r.id, r.meta?.v))
    return !!p && !!m && m.seq === rolesSeq && !watchCovers(host, r.agentId, p.n, p.kind, m.column)
  },
  received: (r, host) => {
    madeFrom.delete(madeKey(host, r.id, r.meta?.v))
    const p = wakeOf(r)
    const ws = workspaceFor(host)
    if (!p || !ws) return
    inBackground(`noting a loop wake on #${p.n}`, noteOnCard(p.n, storedText(HISTORY.loopWake, { agent: p.agentName, kind: p.kind === 'review' ? 'review' : 'verdict' }), ws))
    log.info(`Loop wake: #${p.n} to ${userText(p.agentName)}`)
  },
  ended: (r, host) => {
    madeFrom.delete(madeKey(host, r.id, r.meta?.v))
  }
})

let started = false
/** Wires loop wakes into the board's handoffs (once, at start); the delivery service offers them. */
export function initLoopWakes(): void {
  if (started) return
  started = true
  onLoopEvent((e) => inBackground('a loop handoff', handoff(e)))
  // A lane written counts at once: its settled lanes-changed event comes 300 ms later (#578 round 2).
  onLanesWritten(() => rolesSeq++)
  onHiveEvent((e) => {
    if (e.type === 'tasks-changed' || e.type === 'lanes-changed') rolesSeq++
  })
}

/** The wakes waiting now (agent and card), for tests. */
export const pendingLoopWakes = (): { agentId: string; n: number; kind: LoopEvent['kind'] }[] =>
  everyFromSource('loop')
    .filter(({ r }) => isWaiting(r))
    .flatMap(({ r }) => {
      const p = wakeOf(r)
      return p ? [{ agentId: r.agentId, n: p.n, kind: p.kind }] : []
    })
/** Tries every waiting wake now (what the delivery service's tick does), for tests. */
export const tryLoopWakes = async (): Promise<void> => {
  await Promise.all([...new Map(everyFromSource('loop').filter(({ r }) => isWaiting(r)).map(({ host, r }) => [keyOf(host, r.agentId, 0), { host, agentId: r.agentId }])).values()].map((x) => offerNow(x.host, x.agentId)))
}
/** Forgets every waiting wake, for tests. */
export const clearLoopWakes = async (): Promise<void> => {
  for (const host of new Set(everyFromSource('loop').map((x) => x.host))) await cancelFromSource(host, 'loop', null, 'cleared by a test')
}
