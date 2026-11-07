import { join } from 'path'
import { projectAgents } from '../shared/defaults'
import { pendingStep } from '../shared/tasks'
import type { LaneInfo, TaskCard, TaskHistoryEntry } from '../shared/types'
import { HISTORY, storedText } from '../shared/taskHistory'
import { ANSWER_MAX, cardChange, historyMovedTo, historyReturned, reviewStep, isReturnNote, LOOP_WAKE_KINDS, laneNextWords, loopStepWords, loopWakeLine, wakeAbout, type LoopWakeKind, type WakeAbout } from '../shared/watch'
import { boardRead } from './boardStore'
import { onCombworkEvent } from './events'
import { laneNow, onLanesWritten } from './lanes'
import { laneStartDue, ownOpen } from '../shared/lanes'
import { loopReviewerOf, poolCard } from './loopReviewer'
import { createLogger, userText } from './logger'
import { getTask, noteOnCard } from './tasks'
import { actionsRunning, actionsSettled, onAction } from './workflow/actionWorker'
import type { ActionRow } from './workflow/factStore'
import { cardFacts } from './workflow/recorder'
import { inFlightNow as watchesInFlight, itsBuilder, onWatchStarted, settled as watchesSettled, watchCovers, watchTold } from './watches'
import { agentMsg, inDialectOf, say, type AgentMsg } from '../shared/agentText'
import { actionDelivered, cancelFromSource, createDelivery, everyFromSource, offerNow, registerSource } from './deliveries'
import { isWaiting, type DeliveryRecord } from '../shared/deliveries'
import { workspaceFor, type WorkspaceService } from './workspace'
import { scopeOfHost, withCardNames } from './projectKeys'
import { queueReturnOf, resubmittedOf } from './queueReturn'
import { projectPreferences } from './workflow/preferences'
import { rulesEnforced } from './workflow/recorder'
import { agentWorkflowRole, reviewsWork } from '../shared/workflow/roles'
import { sessions } from './sessions'

/**
 * Combwork's loop wakes (#405): a card loop's routine handoffs, delivered by Combwork whether or not the agent set a card watch.
 * A card arriving in Review wakes its reviewer; a verdict, the card moved into Passed or Done, and the reviewer's request
 * mid-review (#912) wake its builder (the card's agent). Only for cards with a reviewer (the reviewer of a running lane
 * with the card, else the agent that last reviewed it), so a solo user never sees one; never for the agent that made the
 * change; left to the agent's own watch when one tells it of the change; and off for a project whose Project Settings →
 * Card loops → Wake reviewers and builders is off.
 *
 * From the facts (#1266): each handoff is a durable `wake` action written with the fact that causes it (recorder.ts for
 * the board's changes, the runtime for its own), run by the actions worker once the change commits. Its delivery carries
 * the action's id, so a wake is made once however often the action runs (a restart, another Combwork).
 *
 * A delivery (#649, deliveries.ts: a card event, the latest per agent and card, at most a day), made at once and given
 * by the delivery service as everything is (#650: the doorbell when its agent is idle, a notice in its hooks while it
 * works). Made again just before it is offered or read, from the card and the lane as they are then (#652: what lands
 * with the handoff is in it, with no settle of its own): one no longer due is cancelled. Each one received (read with
 * cw_inbox) is noted in the card's history, as Combwork.
 */

const log = createLogger('loopWakes')

/** Combwork's own deliveries come from it. */
// agent-protocol: the sender's name a delivery is labelled with (deliveries name their senders)
const COMBWORK = { kind: 'combwork', name: 'Combwork' } as const
/** The user's answer comes from them, as a decision does (decisionWakes.ts). */
// agent-protocol: the sender's name a delivery is labelled with (deliveries name their senders)
const USER = { kind: 'user', name: 'the user' } as const

const T = {
  unreadable: agentMsg({ id: 'inbox.loopEnded.unreadable', text: 'not a loop wake Combwork can read', note: "Why a loop wake (#405, a delivery) was cancelled just before it was given: what it was made from can't be read back." }),
  projectClosed: agentMsg({ id: 'inbox.loopEnded.projectClosed', text: 'its project is no longer open', note: 'Why a loop wake was cancelled just before it was given: its workspace closed, or its window opened another.' }),
  notDue: agentMsg({ id: 'inbox.loopEnded.notDue', text: 'no longer due', note: 'Why a loop wake was cancelled just before it was given: the card moved on, the agent acted on it, or its own watch told it (#578).' }),
  otherAgent: agentMsg({ id: 'inbox.loopEnded.otherAgent', text: "it is another agent's wake now", note: "Why a loop wake was cancelled just before it was given: the card's roles changed (another reviewer), and that agent gets it instead." })
}
/** Why a loop wake is cancelled, in the dialect of the agent it was for (its host and id). */
const endedWhy = (host: string, agentId: string, why: AgentMsg): string => inDialectOf({ projectPath: host, agentId }, () => say(why))

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

/** Whether a project lets Combwork wake its loops' agents (its workflow option Wake reviewers and builders, HI-1766: on unless off). */
export async function wakesOn(ws: WorkspaceService, projectPath: string): Promise<boolean> {
  return projectPreferences(ws, projectPath, await ws.projectConfig(projectPath).catch(() => null)).loopWakes
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
  // A pool lane's design closed by its answer or its builder going ahead (HI-2325) leaves the card with no reviewer
  // until the pool gives out its next submission, but the handoff is still the loop's: the answer to its builder, the
  // notice to the reviewer the pool gave that design (`agent`, the runtime's, kept by its wake).
  const poolStep = (kind === 'stepAnswer' || (kind === 'stepNotice' && !!agent)) && poolCard(ws, card)
  const reviewer = kind === 'answer' || poolStep ? null : await reviewerOf(ws, card)
  if (!reviewer && kind !== 'answer' && !poolStep) return null
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
  /**
   * The user's answer's: the agent waiting on it (the one that asked, else the builder), kept whoever the card's agent is
   * now (#1626). A pool design's going ahead (HI-2325): the reviewer the pool gave that design, not whoever reviews next.
   */
  to?: string
}

/**
 * A wake's text in its delivery's meta, which keeps a value of at most 500 characters (deliveries.ts): the user's answer
 * in pieces (`text`, `text1`…), so its reply survives being made again before it is offered (#1626); the rest, a note's
 * 600 cut to the one piece.
 */
const PIECE = 500
const textMeta = (kind: LoopWakeKind, text: string | undefined): Record<string, string> => {
  if (!text) return {}
  const all = text.slice(0, kind === 'answer' ? ANSWER_MAX + 400 : PIECE)
  const out: Record<string, string> = {}
  for (let i = 0; i * PIECE < all.length; i++) out[i ? `text${i}` : 'text'] = all.slice(i * PIECE, (i + 1) * PIECE)
  return out
}
const textOf = (m: Record<string, unknown>): string => {
  let out = typeof m.text === 'string' ? m.text : ''
  for (let i = 1; typeof m[`text${i}`] === 'string'; i++) out += m[`text${i}`] as string
  return out
}

const wakeOf = (r: DeliveryRecord): Wake | null => {
  const m = r.meta ?? {}
  if (typeof m.n !== 'number' || !LOOP_WAKE_KINDS.includes(m.kind as LoopWakeKind) || typeof m.agentName !== 'string') return null
  const since = typeof m.sinceAt === 'string' && m.sinceAt ? ({ at: m.sinceAt, ...(typeof m.sinceId === 'string' && m.sinceId ? { id: m.sinceId } : {}) } as TaskHistoryEntry) : null
  const text = textOf(m)
  return { n: m.n, kind: m.kind as LoopWakeKind, agentName: m.agentName, since, ...(text ? { text } : {}), ...(typeof m.to === 'string' && m.to ? { to: m.to } : {}) }
}

/**
 * The card changes a wake's line tells, and the watch kind that would tell the same (none: a note, an answer). A
 * reviewer's request is told by a watch that counts it (#1272): then the watch's line is its only wake.
 */
const kindsOf = (kind: LoopWakeKind): ('column' | 'verdict')[] => (kind === 'review' || kind === 'approved' || kind === 'done' ? ['column'] : isStep(kind) ? [] : ['verdict'])
/** A card loop's step (#1382): the builder's, to its reviewer, or the reviewer's answer, to its builder. Told by a watch that counts it, as a request. */
const isStep = (kind: LoopWakeKind): boolean => kind === 'step' || kind === 'stepAnswer' || kind === 'stepNotice' || kind === 'reply'
/** A builder's step, for its reviewer: a design to check, its going ahead unchecked (a notice), or its reply (HI-2302). */
const toReviewer = (kind: LoopWakeKind): boolean => kind === 'step' || kind === 'stepNotice' || kind === 'reply'
const covered = (projectPath: string, agentId: string, card: TaskCard, kind: LoopWakeKind): boolean =>
  kind !== 'note' && kind !== 'answer' && watchCovers(projectPath, agentId, card.number, kind === 'review' ? 'review' : kind === 'verdict' ? 'verdict' : kind === 'request' || isStep(kind) ? 'request' : 'moved', card.column)

/**
 * What a builder's Done wake says comes next in its lane (HI-1990), when its running lane holds the card: the lane's next
 * card, which Combwork starts for it once its turn ends (rules on: laneStarts.ts) or which it starts itself (rules off),
 * one under way, or none left. Undefined: not a Done wake, or no lane of its holds the card. Read from the board without
 * waiting, as the rest of the wake is decided (an await here let the builder's own watch tell the Done first): a card
 * given to another agent is another lane's, and a paused lane says so (laneNow: the lane view's own reading).
 */
function laneNextOf(ws: WorkspaceService, card: TaskCard, agentId: string, kind: LoopWakeKind): string | undefined {
  if (kind !== 'done' || card.column !== 'done') return undefined
  let lane: LaneInfo | null
  try {
    lane = laneNow(ws, { card: card.number, builder: agentId })
  } catch {
    return undefined
  }
  if (!lane) return undefined
  const cards = lane.cards
  if (lane.state === 'paused') return laneNextWords('paused')
  const next = cards.find(ownOpen)
  if (!next) return laneNextWords('last')
  const is = next.column === 'doing' || next.column === 'review' || next.column === 'passed' ? 'started' : next.column !== 'todo' || next.blocked ? 'waits' : !rulesEnforced() ? 'start' : laneStartDue(lane)?.number === next.number ? 'combworkStarts' : 'waits'
  return laneNextWords({ card: next.number, title: next.title, is })
}

/**
 * What a wake's line adds about the card (wakeAbout); HI-2143: a reviewer's for a card submitted again after the merge
 * queue returned it leads with that (resubmittedOf), not with its own pass as the latest comment.
 */
async function wakeAboutFor(ws: WorkspaceService, projectPath: string, card: TaskCard, kind: LoopWakeKind, agentId: string): Promise<WakeAbout> {
  const about = wakeAbout(card, kindsOf(kind), agentId)
  if (kind !== 'review' || card.column !== 'review') return about
  const again = await resubmittedOf(ws, projectPath, card.number, card.agentName ?? card.agent ?? itsBuilder()).catch(() => null)
  return again ? { ...about, resubmitted: again } : about
}

/**
 * Queues a wake for an agent (the latest per agent and card: a newer handoff of the same card replaces one still
 * waiting), unless its own watch tells it; made, and offered. `action`: the durable action making it (its delivery
 * carries the id: made once).
 */
async function enqueue(ws: WorkspaceService, projectPath: string, card: TaskCard, w: Pick<Wake, 'kind' | 'since' | 'text'>, to: { id: string; name: string }, action?: number): Promise<void> {
  // Kept with the wake (HI-2325): a pool design's notice stays with that design's reviewer when it is made again.
  const keepTo = w.kind === 'answer' || (w.kind === 'stepNotice' && poolCard(ws, card))
  if (covered(projectPath, to.id, card, w.kind)) return
  // Its line names cards by key, its workspace's (#1219), in the dialect of the agent it is for.
  await inDialectOf({ projectPath, agentId: to.id }, () => withCardNames(ws, async () => {
    if (!ws.path || !ws.isProjectPath(projectPath)) return
    const kinds = kindsOf(w.kind)
    const answer = w.kind === 'answer'
    const meta = { n: card.number, kind: w.kind, agentName: to.name, sinceAt: w.since?.at ?? '', sinceId: w.since?.id ?? '', ...textMeta(w.kind, w.text), ...(keepTo ? { to: to.id } : {}), ...(isReturnNote(w.kind, w.text) ? { queueReturn: true } : {}) }
    // The user's answer is an answer from them (#1626: acked, never coalesced into the card's events), each its own (a
    // later handoff of the card, or another answer, doesn't replace it); the rest, Combwork's card events, the latest per card.
    const ref = answer ? `#${card.number}/answer${action ? `/${action}` : ''}` : `#${card.number}`
    await createDelivery(projectPath, { agentId: to.id, agentName: to.name, kind: answer ? 'answer' : 'card-event', from: answer ? USER : COMBWORK, card: card.number, body: loopWakeLine({ ...cardChange(card.number, card, kinds), about: await wakeAboutFor(ws, projectPath, card, w.kind, to.id) }, w.kind, w.text), expiresMs: KEEP_MS, source: 'loop', ref, replace: true, meta, ...(action ? { action } : {}) })
    await offerNow(projectPath, to.id)
  }, scopeOfHost(projectPath)))
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
  // A design or a follow-up asks its reviewer for a check; going ahead only tells it; an answer is its builder's.
  if (f?.kind === 'LoopStep') return { kind: data.step === 'ok' || data.step === 'gaps' ? 'stepAnswer' : data.step === 'proceed' ? 'stepNotice' : 'step', text: loopStepWords(String(data.step ?? ''), String(data.text ?? ''), typeof data.design === 'string' ? data.design : undefined, typeof data.of === 'string' ? data.of : undefined) }
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
  // Made already (a run before a restart, another Combwork's): never a second.
  if (actionDelivered(projectPath, a.id)) return
  const p = a.payload
  // The reviewer's (the runtime names the pool, `reviewers`, or a lane's reviewer: whoever reviews the card now), else the builder's.
  const about = aboutOf(ws, a)
  // A builder's loop step (#1382) goes to the reviewer too, as itself; `named`: a lane's reviewer the runtime named.
  const kind: LoopWakeKind = toReviewer(about.kind) ? about.kind : p.agent === 'reviewers' ? 'review' : about.kind
  const named = kind !== 'review' && typeof p.agent === 'string' && p.agent !== 'builder' && p.agent !== 'reviewers' ? p.agent : undefined
  // A lane reviewed by the pool (#1443): the pool gives each submission to a reviewer and tells it (reviewerPool.ts).
  if (kind === 'review' && poolCard(ws, card)) return
  const to = await targetOf(ws, projectPath, card, kind, named)
  if (!to || p.by === `agent:${to.id}`) return
  const since = p.since && typeof p.since === 'object' ? (p.since as TaskHistoryEntry) : (card.history.at(-1) ?? null)
  try {
    await enqueue(ws, projectPath, card, { kind, since, ...(about.text ? { text: about.text } : {}) }, to, a.id)
  } catch (e) {
    // Another Combwork made it meanwhile (the unique row refused this one's): delivered.
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
 * since: a round reviewed and failed meanwhile is the builder's now, #405 round 2 finding); the user's answer until it is
 * read, wherever the card is (HI-1721); a builder's (a verdict, a
 * move into Passed or Done, a request, a note) while the card is still its own and, since the handoff, neither it acted
 * on the card nor another round started; one of a card that is Done, only while a lane running holds it (`inLane`: the
 * next card follows; with its lane over, the lane's end tells the builder, and nothing is left to carry on with, HI-1687).
 * A later arrival queues a wake of its own.
 */
function stillDue(p: Wake & { agentId: string }, card: TaskCard | null, inLane: boolean): boolean {
  if (!card || card.archived) return false
  const since = historySince(card, p.since)
  // A follow-up's (HI-1832: its handoff is its "Follow-up submitted" line): to the reviewer already reviewing, until it
  // starts again (a renewed review writes no line: its mark's time) or gives a verdict.
  // (A wake made again keeps only its handoff's id and time: its line is the card's.)
  const handoff = p.since ? (p.since.whatText ?? card.history.find((h) => h.id === p.since!.id)?.whatText) : undefined
  const followUp = handoff?.id === 'tasks.history.followUpSubmitted'
  if (p.kind === 'review' && followUp) return card.column === 'review' && !(card.review && card.review.since > p.since!.at) && !since.some((h) => reviewActed(h))
  if (p.kind === 'review') return card.column === 'review' && !card.review && !since.some((h) => reviewActed(h))
  // The user's answer, to whoever waits on it (the card's agent or the one that asked): due until it reads it (its
  // receipt ends it), wherever the card is now (an answer that moved it to Done is told too, #1630). Not on the agent's
  // acting on the card meanwhile (HI-1721: HB2 submitted its next round before reading the user's answer on HI-1694).
  if (p.kind === 'answer') return true
  // A builder's loop step (#1382, #1467), to its reviewer: due until the reviewer acts on the card; a design or a
  // follow-up to check, only while one still waits (answered by someone else, or the card moved on: nothing left to check).
  // Its reply (HI-2302), while the card is still in Review.
  if (toReviewer(p.kind)) return !since.some((h) => same(h.by, p.agentName)) && (p.kind !== 'step' || !!pendingStep(card)) && (p.kind !== 'reply' || card.column === 'review')
  if (card.agent !== p.agentId || (card.column === 'done' && !inLane)) return false
  return !since.some((h) => same(h.by, p.agentName) || historyMovedTo(h) === 'review' || historyReturned(h) || reviewStep(h) === 'started')
}

/** A review started or a verdict given (by the line's message; a line from before #845 by its whole English). */
const reviewActed = (h: TaskCard['history'][number]): boolean => {
  const s = reviewStep(h, true)
  return s === 'started' || s === 'passed' || s === 'failed'
}

/** Counts board and lane changes when a wake's own card key cannot be read. */
let rolesSeq = 0

/**
 * What a wake of card n is decided from, as the board has it now (HI-1687), read without waiting: the card's row (its
 * place, builder, reviewer and when it last changed), its newest history entry and fact (a review started, a verdict,
 * the pool's reviewer, someone acting on it), the lanes holding it (their builder, reviewer and state) and Combwork's last
 * write of its project's settings (its agents, its loop wakes). Another card's change leaves it as it is. Null when it
 * can't be read (a board from before 1.0): the strict count of every change stands in.
 */
function wakeKey(ws: WorkspaceService, projectPath: string, n: number): string | null {
  try {
    return boardRead(ws, (db) => {
      // i18n-ignore: SQL, not text
      const card = db.prepare('SELECT col, stage, agent, review_agent, archived, updated_at FROM cards WHERE number = ?').get(n)
      // i18n-ignore: SQL, not text
      const history = db.prepare('SELECT max(ord) AS last, count(*) AS n FROM card_history WHERE card = ?').get(n)
      // i18n-ignore: SQL, not text
      const facts = db.prepare('SELECT max(seq) AS last, count(*) AS n FROM card_facts WHERE card = ?').get(n)
      // i18n-ignore: SQL, not text
      const lanes = db.prepare('SELECT l.id, l.builder_id, l.reviewer_id, l.state FROM lane_cards c JOIN lanes l ON l.id = c.lane WHERE c.card = ? ORDER BY l.id').all(n)
      return JSON.stringify([card ?? null, history, facts, lanes, ws.projectConfigWrites(projectPath)])
    })
  } catch {
    return null
  }
}

/** For tests: awaited as a wake is made again, once what it is decided from is read (a change while it is made). */
export const loopWakeTestHooks: { afterKey: (() => Promise<void> | void) | null } = { afterKey: null }

/** Whether a running lane holds card n (yes when the board can't say). */
function inRunningLane(ws: WorkspaceService, n: number): boolean {
  try {
    // i18n-ignore: SQL, not text
    return boardRead(ws, (db) => !!db.prepare("SELECT 1 FROM lane_cards c JOIN lanes l ON l.id = c.lane WHERE c.card = ? AND l.state = 'active' LIMIT 1").get(n))
  } catch {
    return true
  }
}

/**
 * A version of a wake here: its host, delivery id and version (ids are a host's own; a wake is made again before each
 * offer or hand-out, and an offered one keeps the version it was offered as).
 */
const madeKey = (host: string, id: string, v: unknown): string => `${host.toLowerCase()}#${id}#${String(v)}`
let versions = 0
/**
 * What each wake was made again from just before it was offered or read (by host and delivery id): the roles' count, the
 * card's column, and what it was decided from (`wakeKey`, read before anything was awaited, so a change while it was
 * made counts as one).
 */
const madeFrom = new Map<string, { seq: number; column: TaskCard['column']; key: string | null }>()

/**
 * Whether an agent can take a reviewer's handoff now (HI-2664): its role reviews (the workspace's projects as it holds
 * them: nothing is read, as `holds` is pure) and its running session has a reviewer's tools (sessions.sideAllows).
 */
function reviewsNow(ws: WorkspaceService, host: string, agentId: string): boolean {
  const a = ws.info()?.projects.find((x) => x.path.toLowerCase() === host.toLowerCase())?.config.agents?.find((x) => x.id === agentId)
  return (!a || reviewsWork(agentWorkflowRole(a))) && sessions.sideAllows(host, agentId, 'reviewer')
}

/**
 * The loop wakes' part in their deliveries (#649): made again just before each offer (the line from the card as it is
 * now; dropped if no longer due, its watch tells it, or it is someone else's wake now, who gets it instead); offered only
 * while its card, lanes and project settings haven't changed (else made again at the next try) and its watch doesn't tell it;
 * received, noted on the card.
 */
registerSource('loop', {
  refresh: async (r, host) => {
    const p = wakeOf(r)
    const ws = workspaceFor(host)
    if (!p) return { cancel: endedWhy(host, r.agentId, T.unreadable) }
    // Its workspace closed, or switched to another folder: dropped.
    if (!ws?.path || !ws.isProjectPath(host)) return { cancel: endedWhy(host, r.agentId, T.projectClosed) }
    // Roles can change while it is checked or typed (the lane's reviewer, the card's agent): then it is worked out again.
    // What it is decided from is read first, before anything is awaited (HI-1687).
    const seq = rolesSeq
    const key = wakeKey(ws, host, p.n)
    await loopWakeTestHooks.afterKey?.()
    const card = await getTask(p.n, ws).catch(() => null)
    // Its own watch told it already (#578): a watch whose line had read this handoff's own history entry, even one that
    // has ended since (a handoff slower than the watch's settle and typing found no watch to leave it to). Never a note
    // or the user's answer (HI-1721): no watch's line says what they say, and their `since` is only the card's latest
    // entry when they were made (the merge queue's return writes none of its own), which a watch begun after them has
    // read, so the return to its builder was dropped as told and the builder waited for Done for three hours.
    const told = !!card && !!p.since && p.kind !== 'note' && p.kind !== 'answer' && watchTold(host, r.agentId, card, p.since, p.kind === 'request' || isStep(p.kind))
    if (!card || !stillDue({ ...p, agentId: r.agentId }, card, inRunningLane(ws, p.n)) || covered(host, r.agentId, card, p.kind) || told || !(await wakesOn(ws, host))) return { cancel: endedWhy(host, r.agentId, T.notDue) }
    // Only to whose wake it is now: another reviewer given the lane meanwhile gets it instead (#405 round 1 finding).
    // The user's answer stays with the agent waiting on it (#1626), while it is one of the project's agents.
    // A pool design's notice stays with that design's reviewer (HI-2325).
    const to = await targetOf(ws, host, card, p.kind, p.kind === 'answer' || p.kind === 'stepNotice' ? p.to : undefined)
    if (to?.id !== r.agentId) {
      if (to) inBackground('a loop wake', enqueue(ws, host, card, p, to))
      return { cancel: endedWhy(host, r.agentId, T.otherAgent) }
    }
    const v = ++versions
    madeFrom.set(madeKey(host, r.id, v), { seq, column: card.column, key })
    if (madeFrom.size > 1000) madeFrom.delete(madeFrom.keys().next().value!)
    const kinds = kindsOf(p.kind)
    // In the dialect of the agent it is for; laneNextOf first, without waiting (HI-1990).
    return inDialectOf({ projectPath: host, agentId: r.agentId }, async () => {
      const next = laneNextOf(ws, card, r.agentId, p.kind)
      return { body: loopWakeLine({ ...cardChange(p.n, card, kinds), about: await wakeAboutFor(ws, host, card, p.kind, r.agentId) }, p.kind, p.text, next), meta: { ...r.meta, v } }
    })
  },
  // Its version made, its watch not telling it, and its own card, lanes and project settings unchanged. The same check
  // for typing and reading (HI-2486, HI-1687): unrelated board traffic must not keep cancelling its doorbell. An own-lane
  // change still stops it before the next key (#578 round 2). Asked at the locked boundary, with nothing awaited.
  holds: (r, host) => {
    const p = wakeOf(r)
    const m = madeFrom.get(madeKey(host, r.id, r.meta?.v))
    if (!p || !m || covered(host, r.agentId, { number: p.n, column: m.column } as TaskCard, p.kind)) return false
    const ws = workspaceFor(host)
    // A reviewer's handoff to an agent that can't review yet (HI-2664, HR3's round 2): its role doesn't (its lane pauses,
    // offSide), or its running session hasn't loaded a reviewer's tools (a role changed, not restarted since). Not given
    // now, but kept: the delivery stays queued, made again and given at a later try, once its tools are there.
    if ((p.kind === 'review' || toReviewer(p.kind)) && !(ws && reviewsNow(ws, host, r.agentId))) return false
    const unchanged = m.key !== null && !!ws && wakeKey(ws, host, p.n) === m.key
    return unchanged || (m.key === null && m.seq === rolesSeq)
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
  onCombworkEvent((e) => {
    if (e.type === 'tasks-changed' || e.type === 'lanes-changed') rolesSeq++
  })
  onWatchStarted((ws, projectPath, agentId, cond) => track('telling a builder of its returned card', tellReturned(ws, projectPath, agentId, cond.cards, cond.column)))
}

/**
 * A builder watching its own card while the merge queue has returned it (HI-1721): the card waits for that builder in
 * Doing, so no watch for another column can end but by its limit (HB2 waited three hours for Done on HI-1694). Told of the
 * return at once, from the card's state as it is (queueReturnOf, not a replay of the queue's wake): a loop wake as the
 * queue's own (a note, the latest per card), offered by the doorbell, its watch carrying on. Not when it watches for the
 * card to come back to Doing itself (nothing it can't reach).
 */
async function tellReturned(ws: WorkspaceService, projectPath: string, agentId: string, cards: readonly number[], column: string | undefined): Promise<void> {
  if (column === 'doing' || !ws.path || !(await wakesOn(ws, projectPath))) return
  for (const n of cards) {
    const card = await getTask(n, ws).catch(() => null)
    if (!card || card.archived || card.agent !== agentId || card.column !== 'doing') continue
    const back = await queueReturnOf(ws, projectPath, n)
    if (!back || (back.builder && back.builder !== agentId)) continue
    const agent = projectAgents(await ws.projectConfig(projectPath)).find((a) => a.id === agentId)
    if (!agent) continue
    log.info(`#${n} came back from the merge queue and ${userText(agent.name)} watches it for another column: told of the return`)
    await enqueue(ws, projectPath, card, { kind: 'note', since: card.history.at(-1) ?? null, text: back.text }, { id: agent.id, name: `${agent.name} (${card.project})` })
  }
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
  // agent-protocol: a test's own reason, never given in the app
  for (const host of new Set(everyFromSource('loop').map((x) => x.host))) await cancelFromSource(host, 'loop', null, 'cleared by a test')
}
