import { join } from 'path'
import { projectAgents } from '../shared/defaults'
import { pendingDesign } from '../shared/tasks'
import type { TaskCard, TaskHistoryEntry } from '../shared/types'
import { HISTORY, storedText } from '../shared/taskHistory'
import { cardChange, LOOP_WAKE_KINDS, loopStepWords, loopWakeLine, wakeAbout, type LoopWakeKind } from '../shared/watch'
import { onHiveEvent } from './events'
import { onLanesWritten } from './lanes'
import { loopReviewerOf } from './loopReviewer'
import { createLogger, userText } from './logger'
import { getTask, noteOnCard } from './tasks'
import { actionsRunning, actionsSettled, onAction } from './workflow/actionWorker'
import type { ActionRow } from './workflow/factStore'
import { cardFacts } from './workflow/recorder'
import { inFlightNow as watchesInFlight, settled as watchesSettled, watchCovers, watchTold } from './watches'
import { actionDelivered, cancelFromSource, createDelivery, everyFromSource, offerNow, registerSource } from './deliveries'
import { isWaiting, type DeliveryRecord } from '../shared/deliveries'
import { workspaceFor, type WorkspaceService } from './workspace'
import { scopeOfHost, withCardNames } from './projectKeys'

/**
 * Hive's loop wakes (#405): a card loop's routine handoffs, delivered by Hive whether or not the agent set a card watch.
 * A card arriving in Review wakes its reviewer; a verdict, the card moved into Passed or Done, and the reviewer's request
 * mid-review (#912) wake its builder (the card's agent). Only for cards with a reviewer (the reviewer of a running lane
 * with the card, else the agent that last reviewed it), so a solo user never sees one; never for the agent that made the
 * change; left to the agent's own watch when one tells it of the change; and off for a project whose Project Settings →
 * Card loops → Wake reviewers and builders is off.
 *
 * From the facts (#1266): each handoff is a durable `wake` action written with the fact that causes it (recorder.ts for
 * the board's changes, the runtime for its own), run by the actions worker once the change commits. Its delivery carries
 * the action's id, so a wake is made once however often the action runs (a restart, another Hive).
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
/** Work its caller waits for (an action's handler: its failure is the action's), counted as in flight meanwhile. */
function track<T>(what: string, work: Promise<T>): Promise<T> {
  inBackground(what, work)
  return work
}

/**
 * Resolves once loop wakes and watches have nothing in flight: every handoff so far is made, kept or dropped (its `wake`
 * action run by the actions worker too).
 */
export async function settled(): Promise<void> {
  while (inFlight.size || watchesInFlight() || actionsRunning()) {
    await actionsSettled()
    await Promise.allSettled([...inFlight])
    await watchesSettled()
  }
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Whether a project lets Hive wake its loops' agents (Project Settings → Card loops; on unless turned off). */
export async function wakesOn(ws: WorkspaceService, projectPath: string): Promise<boolean> {
  return (await ws.projectConfig(projectPath).catch(() => null))?.loopWakes !== false
}

/** A card's reviewer's id: loopReviewerOf, the one rule a design's answer is checked by too (#1382). Null: none (no wakes). */
async function reviewerOf(ws: WorkspaceService, card: TaskCard): Promise<string | null> {
  return (await loopReviewerOf(ws, card))?.id ?? null
}

/** A card's reviewer (loopReviewerOf) by its id and board name, among its project's agents: null when it has none. */
export async function cardReviewer(ws: WorkspaceService, _projectPath: string, card: TaskCard): Promise<{ id: string; name: string } | null> {
  return loopReviewerOf(ws, card)
}

/**
 * Whose wake a handoff is, as the lane and the card are now, while the card has a reviewer: the card's reviewer for an
 * arrival in Review (not a builder reviewing its own card), else its builder (the card's agent, or `agent` when the
 * action named one: the runtime's builder); an agent of the project. Null: no one's.
 */
async function targetOf(ws: WorkspaceService, projectPath: string, card: TaskCard, kind: LoopWakeKind, agent?: string): Promise<{ id: string; name: string } | null> {
  const agents = projectAgents(await ws.projectConfig(projectPath)).map((a) => ({ id: a.id, name: a.name }))
  // The user's answer reaches the agent waiting on it in or out of a loop (#1269); a loop's handoffs need a reviewer.
  const reviewer = kind === 'answer' ? null : await reviewerOf(ws, card)
  if (!reviewer && kind !== 'answer') return null
  const target = kind === 'review' || toReviewer(kind) ? (agent ?? reviewer) : (agent ?? card.agent)
  if (!target || ((kind === 'review' || toReviewer(kind)) && target === card.agent)) return null
  const found = agents.find((a) => a.id === target)
  return found ? { id: found.id, name: `${found.name} (${card.project})` } : null
}

/** A loop wake as its delivery says it: the card, what it is about, the agent's board name, the handoff, what it says. */
interface Wake {
  n: number
  kind: LoopWakeKind
  agentName: string
  since: TaskHistoryEntry | null
  text?: string
}
const wakeOf = (r: DeliveryRecord): Wake | null => {
  const m = r.meta ?? {}
  if (typeof m.n !== 'number' || !LOOP_WAKE_KINDS.includes(m.kind as LoopWakeKind) || typeof m.agentName !== 'string') return null
  const since = typeof m.sinceAt === 'string' && m.sinceAt ? ({ at: m.sinceAt, ...(typeof m.sinceId === 'string' && m.sinceId ? { id: m.sinceId } : {}) } as TaskHistoryEntry) : null
  return { n: m.n, kind: m.kind as LoopWakeKind, agentName: m.agentName, since, ...(typeof m.text === 'string' && m.text ? { text: m.text } : {}) }
}

/**
 * The card changes a wake's line tells, and the watch kind that would tell the same (none: a note, an answer). A
 * reviewer's request is told by a watch that counts it (#1272): then the watch's line is its only wake.
 */
const kindsOf = (kind: LoopWakeKind): ('column' | 'verdict')[] => (kind === 'review' || kind === 'approved' || kind === 'done' ? ['column'] : isStep(kind) ? [] : ['verdict'])
/** A card loop's step (#1382): the builder's, to its reviewer, or the reviewer's answer, to its builder. Told by a watch that counts it, as a request. */
const isStep = (kind: LoopWakeKind): boolean => kind === 'step' || kind === 'stepAnswer' || kind === 'stepNotice'
/** A builder's step, for its reviewer: a design to check, or its going ahead unchecked (a notice). */
const toReviewer = (kind: LoopWakeKind): boolean => kind === 'step' || kind === 'stepNotice'
const covered = (projectPath: string, agentId: string, card: TaskCard, kind: LoopWakeKind): boolean =>
  kind !== 'note' && kind !== 'answer' && watchCovers(projectPath, agentId, card.number, kind === 'review' ? 'review' : kind === 'verdict' ? 'verdict' : kind === 'request' || isStep(kind) ? 'request' : 'moved', card.column)

/**
 * Queues a wake for an agent (the latest per agent and card: a newer handoff of the same card replaces one still
 * waiting), unless its own watch tells it; made, and offered. `action`: the durable action making it (its delivery
 * carries the id: made once).
 */
async function enqueue(ws: WorkspaceService, projectPath: string, card: TaskCard, w: Pick<Wake, 'kind' | 'since' | 'text'>, to: { id: string; name: string }, action?: number): Promise<void> {
  if (covered(projectPath, to.id, card, w.kind)) return
  // Its line names cards by key, its workspace's (#1219).
  await withCardNames(ws, async () => {
    if (!ws.path || !ws.isProjectPath(projectPath)) return
    const kinds = kindsOf(w.kind)
    const meta = { n: card.number, kind: w.kind, agentName: to.name, sinceAt: w.since?.at ?? '', sinceId: w.since?.id ?? '', ...(w.text ? { text: w.text.slice(0, 600) } : {}) }
    await createDelivery(projectPath, { agentId: to.id, agentName: to.name, kind: 'card-event', from: HIVE, card: card.number, body: loopWakeLine({ ...cardChange(card.number, card, kinds), about: wakeAbout(card, kinds, to.id) }, w.kind, w.text), expiresMs: KEEP_MS, source: 'loop', ref: `#${card.number}`, replace: true, meta, ...(action ? { action } : {}) })
    await offerNow(projectPath, to.id)
  }, scopeOfHost(projectPath))
}

/**
 * What a `wake` action is about: as it says (`about`, the recorder's), else from the fact that caused it (the runtime's:
 * a reviewer's request, a verdict, an arrival in Review, a move on), else a note in its own words (`why`).
 */
function aboutOf(ws: WorkspaceService, a: ActionRow): { kind: LoopWakeKind; text?: string } {
  const p = a.payload
  if (LOOP_WAKE_KINDS.includes(p.about as LoopWakeKind)) return { kind: p.about as LoopWakeKind, ...(typeof p.why === 'string' && p.why ? { text: p.why } : {}) }
  const f = a.fact !== null ? cardFacts(ws, a.card).find((x) => x.seq === a.fact) : undefined
  const data = (f?.data ?? {}) as Record<string, unknown>
  if (f?.kind === 'ReviewerRequest') return { kind: 'request', text: String(data.text ?? '') }
  // A design asks its reviewer for a check; going ahead only tells it; an answer is its builder's.
  if (f?.kind === 'LoopStep') return { kind: data.step === 'ok' || data.step === 'gaps' ? 'stepAnswer' : data.step === 'proceed' ? 'stepNotice' : 'step', text: loopStepWords(String(data.step ?? ''), String(data.text ?? ''), typeof data.design === 'string' ? data.design : undefined) }
  if (f?.kind === 'Verdict') return { kind: 'verdict' }
  if (f?.kind === 'Submitted' || (f?.kind === 'Moved' && data.to === 'review')) return { kind: 'review' }
  if (f?.kind === 'Moved' && (data.to === 'approved' || data.to === 'done')) return { kind: data.to }
  return { kind: 'note', ...(typeof p.why === 'string' && p.why ? { text: p.why } : {}) }
}

/**
 * A `wake` action (the actions worker, once its change has committed): whose wake it is, if anyone's, queued with the
 * action's id and tried. `agent`: `reviewers` (the card's reviewer), `builder` (the card's agent), or an agent's id;
 * `by`: who made the change (never woken by its own change); `since`: the history entry the handoff left.
 */
async function wakeFromAction(a: ActionRow, from: WorkspaceService): Promise<void> {
  await testHooks.beforeHandoff?.()
  if (!from.path) return
  const card = await getTask(a.card, from).catch(() => null)
  if (!card?.project || card.archived) return
  const projectPath = join(from.path, card.project)
  // The service itself, not the stand-in (tasks.ts's `workspace`): the wake is tried later, outside this change's call.
  const ws = workspaceFor(projectPath)
  if (!ws?.isProjectPath(projectPath) || !(await wakesOn(ws, projectPath))) return
  // Made already (a run before a restart, another Hive's): never a second.
  if (actionDelivered(projectPath, a.id)) return
  const p = a.payload
  // The reviewer's (the runtime names the pool, `reviewers`, or a lane's reviewer: whoever reviews the card now), else the builder's.
  const about = aboutOf(ws, a)
  // A builder's loop step (#1382) goes to the reviewer too, as itself; `named`: a lane's reviewer the runtime named.
  const kind: LoopWakeKind = toReviewer(about.kind) ? about.kind : p.agent === 'reviewers' ? 'review' : about.kind
  const named = kind !== 'review' && typeof p.agent === 'string' && p.agent !== 'builder' && p.agent !== 'reviewers' ? p.agent : undefined
  const to = await targetOf(ws, projectPath, card, kind, named)
  if (!to || p.by === `agent:${to.id}`) return
  const since = p.since && typeof p.since === 'object' ? (p.since as TaskHistoryEntry) : (card.history.at(-1) ?? null)
  try {
    await enqueue(ws, projectPath, card, { kind, since, ...(about.text ? { text: about.text } : {}) }, to, a.id)
  } catch (e) {
    // Another Hive made it meanwhile (the unique row refused this one's): delivered.
    if (!actionDelivered(projectPath, a.id)) throw e
  }
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
 * since: a round reviewed and failed meanwhile is the builder's now, #405 round 2 finding); a builder's (a verdict, a
 * move into Passed or Done, a request, a note) while the card is still its own and, since the handoff, neither it acted
 * on the card nor another round started. A later arrival queues a wake of its own.
 */
function stillDue(p: Wake & { agentId: string }, card: TaskCard | null): boolean {
  if (!card || card.archived) return false
  const since = historySince(card, p.since)
  if (p.kind === 'review') return card.column === 'review' && !card.review && !since.some((h) => /^(Started reviewing|Review (passed|failed))$/.test(h.what))
  // The user's answer, to whoever waits on it (the card's agent or the one that asked): due until that agent acts on it.
  if (p.kind === 'answer') return !since.some((h) => same(h.by, p.agentName))
  // A builder's loop step (#1382), to its reviewer: due until the reviewer acts on the card; a design to check, only
  // while one still waits (answered by someone else, or the card moved on: nothing left to check).
  if (toReviewer(p.kind)) return !since.some((h) => same(h.by, p.agentName)) && (p.kind !== 'step' || !!pendingDesign(card))
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
    const told = !!card && !!p.since && watchTold(host, r.agentId, card, p.since, p.kind === 'request' || isStep(p.kind))
    if (!card || !stillDue({ ...p, agentId: r.agentId }, card) || covered(host, r.agentId, card, p.kind) || told || !(await wakesOn(ws, host))) return { cancel: 'no longer due' }
    // Only to whose wake it is now: another reviewer given the lane meanwhile gets it instead (#405 round 1 finding).
    const to = await targetOf(ws, host, card, p.kind)
    if (to?.id !== r.agentId) {
      if (to) inBackground('a loop wake', enqueue(ws, host, card, p, to))
      return { cancel: 'it is another agent\'s wake now' }
    }
    const v = ++versions
    madeFrom.set(madeKey(host, r.id, v), { seq, column: card.column })
    if (madeFrom.size > 1000) madeFrom.delete(madeFrom.keys().next().value!)
    const kinds = kindsOf(p.kind)
    return { body: loopWakeLine({ ...cardChange(p.n, card, kinds), about: wakeAbout(card, kinds, r.agentId) }, p.kind, p.text), meta: { ...r.meta, v } }
  },
  holds: (r, host) => {
    const p = wakeOf(r)
    const m = madeFrom.get(madeKey(host, r.id, r.meta?.v))
    return !!p && !!m && m.seq === rolesSeq && !covered(host, r.agentId, { number: p.n, column: m.column } as TaskCard, p.kind)
  },
  received: (r, host) => {
    madeFrom.delete(madeKey(host, r.id, r.meta?.v))
    const p = wakeOf(r)
    const ws = workspaceFor(host)
    if (!p || !ws) return
    inBackground(`noting a loop wake on #${p.n}`, noteOnCard(p.n, p.kind === 'answer' ? storedText(HISTORY.answerTold, { agent: p.agentName }) : storedText(HISTORY.loopWake, { agent: p.agentName, kind: p.kind === 'review' ? 'review' : isStep(p.kind) ? 'step' : 'verdict' }), ws))
    log.info(`Loop wake: #${p.n} to ${userText(p.agentName)}`)
  },
  ended: (r, host) => {
    madeFrom.delete(madeKey(host, r.id, r.meta?.v))
  }
})

let started = false
/** Wires loop wakes into the board's handoffs, its `wake` actions (once, at start); the delivery service offers them. */
export function initLoopWakes(): void {
  if (started) return
  started = true
  // Its delivery carries the action's id: run until marked, made once.
  onAction('wake', (a, ws) => track('a loop handoff', wakeFromAction(a, ws)), 'delivered')
  // A lane written counts at once: its settled lanes-changed event comes 300 ms later (#578 round 2).
  onLanesWritten(() => rolesSeq++)
  onHiveEvent((e) => {
    if (e.type === 'tasks-changed' || e.type === 'lanes-changed') rolesSeq++
  })
}

/** The wakes waiting now (agent and card), for tests. */
export const pendingLoopWakes = (): { agentId: string; n: number; kind: LoopWakeKind }[] =>
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
