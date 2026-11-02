import { app } from 'electron'
import { basename } from 'path'
import { tasksWillWake } from '../shared/providers'
import { pendingStep } from '../shared/tasks'
import type { LiveSessionState, TaskCard } from '../shared/types'
import { agentReadsInbox } from './deliveries'
import { onHiveEvent } from './events'
import { coalesced } from './coalesce'
import { createLogger, userText } from './logger'
import { loopReviewerOf, poolCard } from './loopReviewer'
import { sessions } from './sessions'
import { allTasks, liveCardHeads } from './tasks'
import { forYouOfCards } from './workflow/cardWork'
import { workspaceOf } from './workspace'
import { projectPreferences } from './workflow/preferences'
import { pausedFor } from './teamPause'

const log = createLogger('loops')

/**
 * Agents in a card loop left with no card watch (#376). An agent that has watched cards in this run of Hive is in a
 * loop; if its turn ends with no live watch while a card it was looping on is still in play, nothing will wake it when
 * that card changes, and its lane stalls (7 Oct: a wake typed into a Codex reviewer was never submitted, and it sat
 * "finished" for hours while the builder waited on it). After a short grace (a wake being taken, a watch being started)
 * those cards are marked on the agent (`notWatching`), so they show as stalled ("R6 isn't watching #333"), and the user
 * is told once. Its cards in play: the ones it last watched, in Doing or Review, and any in Review it is the agent or
 * reviewer of. The Hive Assistant isn't checked: it watches cards as it likes.
 */

/** How long an agent in a loop may sit with no watch before its cards are flagged. */
const GRACE_MS = 45_000
/** Agents remembered as in a loop; the oldest go first. */
const MAX_LOOPS = 500

interface Loop {
  projectPath: string
  agentId: string
  /** The cards of its latest watch. */
  cards: number[]
  timer?: ReturnType<typeof setTimeout>
  /** What the user was last told about (cards, and the idle spell it was in), so each spell is told once. */
  told?: string
}

const loops = new Map<string, Loop>()
const keyOf = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

/** Unpackaged test builds can shorten the grace (HIVE_TEST_LOOP_GRACE_MS). */
function graceMs(): number {
  const v = !app.isPackaged ? Number(process.env.HIVE_TEST_LOOP_GRACE_MS) : NaN
  return Number.isFinite(v) && v >= 0 ? v : GRACE_MS
}

/** An agent started a card watch: it is in a loop, on these cards. */
export function noteLoopWatch(projectPath: string, agentId: string, cards: number[]): void {
  if (workspaceOf(projectPath).isAssistantHome(projectPath)) return
  const k = keyOf(projectPath, agentId)
  const was = loops.get(k)
  if (was?.timer) clearTimeout(was.timer)
  loops.delete(k)
  loops.set(k, { projectPath, agentId, cards: [...cards], told: was?.told })
  while (loops.size > MAX_LOOPS) {
    const oldest = loops.values().next().value!
    if (oldest.timer) clearTimeout(oldest.timer)
    loops.delete(keyOf(oldest.projectPath, oldest.agentId))
  }
}

/**
 * Idle with no watch: its turn has ended and nothing is set to wake it. Background tasks still running will, where its
 * CLI is woken by them (#521: a builder that ended its turn while its e2e run went on was shown as not watching), so it
 * isn't flagged until they end; a CLI that isn't woken by them (Codex) is flagged as before.
 */
export const unwatched = (st: Pick<LiveSessionState, 'status' | 'watch' | 'backgroundTasks' | 'provider'> | null): boolean => !!st && (st.status === 'ready' || st.status === 'finished') && !st.watch && !tasksWillWake(st)

/** A session's status changed: an agent in a loop that went idle with no watch is checked after the grace. */
function statusChanged(st: LiveSessionState): void {
  const loop = loops.get(keyOf(st.projectPath, st.agentId))
  if (!loop) return
  if (!unwatched(st)) {
    if (loop.timer) clearTimeout(loop.timer)
    loop.timer = undefined
    return
  }
  if (st.notWatching) return
  schedule(loop)
}

/**
 * Its cards still in play, among its own project's (a card moved to another project isn't its any more): the ones it
 * last watched in Doing or Review, and those in Review it is the agent or reviewer of.
 */
export function cardsInPlay(cards: readonly TaskCard[], project: string, agentId: string, watched: readonly number[]): number[] {
  const ours = (c: TaskCard): boolean => c.project.toLowerCase() === project.toLowerCase()
  const mine = (c: TaskCard): boolean => c.agent === agentId || c.review?.agent === agentId
  return cards
    .filter((c) => !c.archived && ours(c) && ((watched.includes(c.number) && (c.column === 'doing' || c.column === 'review')) || (c.column === 'review' && mine(c))))
    .map((c) => c.number)
    .sort((a, b) => a - b)
}

/**
 * Of an agent's watched cards, those that are another's loop, not its own (HI-2381): a card's stall counts only its own
 * builder and reviewer. CB2, whose next card CL-10 waits on CB1's CL-8, watched CL-8 and, its watch over, flagged CL-8 as
 * stalled while CB1 and CR1 were on it. A watched card in Doing or Review that another agent builds is another's when its
 * reviewer (the review on it, else `reviewerOf`: its loop reviewer) is another agent, or, with none known, when another
 * card the agent watches, not Done, depends on it (blockedBy). A card with no reviewer yet that nothing watched waits on
 * stays: the agent may be the reviewer waiting for it to arrive in Review.
 */
export function othersCards(cards: readonly TaskCard[], agentId: string, watched: readonly number[], reviewerOf: (n: number) => string | null): number[] {
  const blockers = new Set(cards.filter((c) => watched.includes(c.number) && !c.archived && c.column !== 'done').flatMap((c) => c.blockedBy ?? []))
  return cards
    .filter((c) => {
      if (!watched.includes(c.number) || c.archived || (c.column !== 'doing' && c.column !== 'review') || !c.agent || c.agent === agentId) return false
      const reviewer = c.review?.agent ?? reviewerOf(c.number)
      return reviewer ? reviewer !== agentId : blockers.has(c.number)
    })
    .map((c) => c.number)
}

/** What reaches an agent of its cards without a watch (HI-1693): whether Hive's loop wakes can, and each card's loop reviewer. */
export interface LoopReach {
  /** The project's loop wakes are on and the agent can read its inbox (its hive tools): a loop wake reaches it. */
  wakes: boolean
  /** The card's loop reviewer's id (loopReviewerOf), or null: no reviewer, so no loop wakes for it. */
  reviewerOf: (n: number) => string | null
  /** Whether the card has an open For you request the agent asked (HI-2080): the user's answer is its loop wake. */
  asked?: (n: number) => boolean
  /** Whether the card's lane is reviewed by the pool (poolCard; HI-2321): only its builder and its reviewer now are in its loop. */
  pool?: (n: number) => boolean
}

/**
 * A pool card's loop is its builder's and the reviewer the pool has for it now (`reviewerOf`, HI-2321): a reviewer the
 * pool gave an earlier step or round to is out of it once the next goes to another (HI-2320: HR1 checked design s10, HR2
 * its revision s19, and HR1 was flagged as not watching). Its own pool, whether a loop wake reaches it or not.
 */
function inPoolLoop(card: Pick<TaskCard, 'agent'>, agentId: string, reach: Pick<LoopReach, 'pool' | 'reviewerOf'>, n: number): boolean {
  return !reach.pool?.(n) || card.agent === agentId || reach.reviewerOf(n) === agentId
}

/**
 * Of an agent's cards in play, those it owes the next move on, or that nothing would wake it for (HI-1693): flagged when
 * it sits idle with no watch. A loop wake brings it the other side's move, so these aren't, while one can reach it:
 * - its own card (the builder's) in Review, with no request of its reviewer's left to answer: the reviewer's verdict;
 * - its own card in Doing with a design or follow-up posted (`pendingStep`): the reviewer's answer;
 * - a card it reviews in the loop, in Doing with no step waiting for it: the builder's submission;
 * - a card with an open For you request it asked (`hive_ask_user`, `hive_cannot_within_rules`; HI-2080): the user's
 *   answer, whatever the card's column or reviewer. Once answered or closed, the card is owed as before.
 * The rest is its own move (a builder's card in Doing, a step its reviewer must answer, a card in Review its reviewer
 * hasn't given a verdict on), or one no loop wake tells (no reviewer, loop wakes off, no inbox). A pool card is owed
 * only by its builder and its reviewer now (inPoolLoop), loop wakes or not.
 */
export function owedCards(cards: readonly TaskCard[], project: string, agentId: string, watched: readonly number[], reach: LoopReach): number[] {
  const inPlay = cardsInPlay(cards, project, agentId, watched).filter((n) => inPoolLoop(cards.find((x) => x.number === n)!, agentId, reach, n))
  if (!reach.wakes) return inPlay
  return inPlay.filter((n) => {
    const c = cards.find((x) => x.number === n)!
    if (reach.asked?.(n)) return false
    const reviewer = reach.reviewerOf(n)
    if (!reviewer) return true
    const step = !!pendingStep(c)
    if (c.agent === agentId) return !((c.column === 'review' && !failedSinceArrival(c) && !requestOpen(c)) || (c.column === 'doing' && step))
    if (reviewer === agentId) return !(c.column === 'doing' && !step)
    return true
  })
}

/** A card in Review whose round was failed since it came in (left there for its fixes, with the rules off): its builder's move. */
function failedSinceArrival(card: Pick<TaskCard, 'history'>): boolean {
  const i = card.history.findLastIndex((h) => /^(Moved to (the (top|bottom) of )?Review\b|Created in Review\b|Returned for review\b)/.test(h.what))
  return card.history.slice(i + 1).some((h) => /^Review failed\b/.test(h.what))
}

/**
 * A request of its reviewer's to its builder (`hive_request_builder`: "Asked the builder…") on a card in Review, since it
 * came in, that the builder hasn't answered (nothing of the builder's on the card after it): the builder's move.
 */
function requestOpen(card: Pick<TaskCard, 'history' | 'comments' | 'agentName' | 'project'>): boolean {
  const arrived = card.history.findLastIndex((h) => /^(Moved to (the (top|bottom) of )?Review\b|Created in Review\b|Returned for review\b)/.test(h.what))
  const asked = card.history.findLastIndex((h) => /^Asked the builder\b/.test(h.what))
  if (asked < 0 || asked < arrived) return false
  // Its board name, as its lines and comments are signed ("B1 (alpha)"), whether the card keeps it with its project or not.
  const name = card.agentName?.toLowerCase()
  const names = name ? new Set([name, `${name} (${card.project.toLowerCase()})`]) : new Set<string>()
  const at = card.history[asked].at
  // Answered: a line of the builder's after it (a step, a move), or a comment of its own since (comments aren't lines).
  return !card.history.slice(asked + 1).some((h) => names.has(h.by.toLowerCase())) && !(card.comments ?? []).some((m) => m.at >= at && names.has(m.by.toLowerCase()))
}

/**
 * The cards an agent in a loop owes now (owedCards), read from the board, its project's settings and its reviewers: its
 * cards in play from the live cards' heads (HI-1690: no card's document for that), then only those cards in full (their
 * history and comments say whose move it is).
 */
async function owedNow(loop: Loop): Promise<number[]> {
  const ws = workspaceOf(loop.projectPath)
  const project = basename(loop.projectPath)
  const heads = await liveCardHeads(ws)
  let watched = loop.cards
  // Another's card (HI-2381): its stall is its own builder's and reviewer's. Read in full (their dependencies; heads have
  // none) with their loop reviewers, only when one of its watched cards is another agent's in Doing or Review.
  const others = heads.filter((c) => watched.includes(c.number) && (c.column === 'doing' || c.column === 'review') && !!c.agent && c.agent !== loop.agentId)
  if (others.length) {
    const full = await allTasks(ws, { numbers: [...watched] })
    const loopReviewers = new Map<number, string | null>()
    for (const c of full) if (others.some((o) => o.number === c.number)) loopReviewers.set(c.number, (await loopReviewerOf(ws, c).catch(() => null))?.id ?? null)
    const drop = new Set(othersCards(full, loop.agentId, watched, (n) => loopReviewers.get(n) ?? null))
    watched = watched.filter((n) => !drop.has(n))
  }
  const inPlay = cardsInPlay(heads, project, loop.agentId, watched)
  if (!inPlay.length) return []
  // Pool cards (HI-2321): only its builder and its reviewer now are in its loop, so their reviewer is read either way.
  const pooled = new Set(heads.filter((c) => inPlay.includes(c.number) && poolCard(ws, c)).map((c) => c.number))
  const reviewers = new Map<number, string | null>()
  const reviewerOf = (n: number): string | null => reviewers.get(n) ?? null
  // The project's loop wakes (its workflow option, HI-1766: loopWakes.ts' wakesOn, read as it reads it), and an inbox
  // to receive them (deliveries are refused without one).
  const wakes = agentReadsInbox(loop.projectPath, loop.agentId) && projectPreferences(ws, loop.projectPath, await ws.projectConfig(loop.projectPath).catch(() => null)).loopWakes
  if (!wakes) {
    for (const c of heads) if (pooled.has(c.number)) reviewers.set(c.number, (await loopReviewerOf(ws, c).catch(() => null))?.id ?? null)
    return owedCards(heads, project, loop.agentId, watched, { wakes, reviewerOf, pool: (n) => pooled.has(n) })
  }
  const cards = await allTasks(ws, { numbers: inPlay })
  for (const c of cards) reviewers.set(c.number, (await loopReviewerOf(ws, c).catch(() => null))?.id ?? null)
  // Its own questions for the user still open (HI-2080), from the board's For you as it is now.
  const open = forYouOfCards(ws, inPlay)
  const asked = (n: number): boolean => (open.get(n) ?? []).some((r) => r.asker === loop.agentId)
  return owedCards(cards, project, loop.agentId, watched, { wakes, reviewerOf, asked, pool: (n) => pooled.has(n) })
}

/** Starts an idle agent's grace before its owed cards are flagged (once: a timer running, or a flag made, waits). */
function schedule(loop: Loop): void {
  if (loop.timer) return
  loop.timer = setTimeout(() => {
    loop.timer = undefined
    void check(loop).catch((e) => log.warn('checking a card loop', e))
  }, graceMs())
  loop.timer.unref?.()
}

/**
 * For tests: how many checks and rechecks have finished (`done`), and each agent's grace checks finished (`checks`, by
 * project and agent: what decides its flag), so a test reads its own agent's outcome once that check has run.
 */
export const loopCheckRuns = { done: 0, checks: new Map<string, number>() }
/** For tests: how many grace checks of this agent have finished. */
export const loopChecksOf = (projectPath: string, agentId: string): number => loopCheckRuns.checks.get(keyOf(projectPath, agentId)) ?? 0

/**
 * The board, the lanes, the settings or the project changed: what the agent owes is worked out again (HI-1693). A mark
 * already made follows it, so a card that moved on (Passed, Done, another project, archived) or became the other side's
 * move stops showing as stalled, and one that came into play while it still waits with no watch shows. An agent idle
 * with no watch and no mark, which now owes a move (a verdict sent its card back, a step became its to answer, its
 * loop wakes stopped reaching it), starts its grace, as a turn ending does. Told once per idle spell, as before.
 */
async function recheck(loop: Loop): Promise<void> {
  try {
    // Its team paused (HI-2081): parking isn't a stall; a mark made before is cleared, and none is made until it resumes.
    if (pausedFor(loop.projectPath)) {
      if (sessions.liveFor(loop.projectPath, loop.agentId)?.notWatching) sessions.setNotWatching(loop.projectPath, loop.agentId, null)
      return
    }
    const st = sessions.liveFor(loop.projectPath, loop.agentId)
    if (!(st?.notWatching || unwatched(st)) || loops.get(keyOf(loop.projectPath, loop.agentId)) !== loop) return
    const owed = await owedNow(loop)
    // Read again after the wait: it may have started working or watching meanwhile.
    const now = sessions.liveFor(loop.projectPath, loop.agentId)
    if (loops.get(keyOf(loop.projectPath, loop.agentId)) !== loop) return
    if (now?.notWatching) sessions.setNotWatching(loop.projectPath, loop.agentId, owed.length ? owed : null)
    else if (unwatched(now) && owed.length) schedule(loop)
  } finally {
    loopCheckRuns.done++
  }
}

async function check(loop: Loop): Promise<void> {
  try {
    await checkNow(loop)
  } finally {
    loopCheckRuns.done++
    const k = keyOf(loop.projectPath, loop.agentId)
    loopCheckRuns.checks.set(k, (loopCheckRuns.checks.get(k) ?? 0) + 1)
  }
}

async function checkNow(loop: Loop): Promise<void> {
  if (pausedFor(loop.projectPath)) return
  const st = sessions.liveFor(loop.projectPath, loop.agentId)
  if (!unwatched(st) || loops.get(keyOf(loop.projectPath, loop.agentId)) !== loop) return
  const inPlay = await owedNow(loop)
  // Read again after the wait: it may have started working or watching meanwhile.
  const now = sessions.liveFor(loop.projectPath, loop.agentId)
  if (!unwatched(now) || loops.get(keyOf(loop.projectPath, loop.agentId)) !== loop) return
  if (!inPlay.length) return
  sessions.setNotWatching(loop.projectPath, loop.agentId, inPlay)
  const told = `${inPlay.join(',')}@${now!.statusSince ?? ''}`
  if (loop.told === told) return
  loop.told = told
  const which = inPlay.map((n) => `#${n}`).join(', ')
  // #777: it did watch, and its watch's wake waits untaken in its prompt (its CLI didn't take the line Hive typed): its
  // cards are stalled for that (cardStall says so), and the user was told of the untaken line already, once.
  if (now!.untakenLine) {
    log.info(`${userText(now!.agentName ?? loop.agentId)} hasn't taken the wake Hive typed for ${which}: it waits in its prompt`)
    return
  }
  log.info(`${userText(now!.agentName ?? loop.agentId)} isn't watching ${which}: its turn ended without a card watch`)
  sessions.notifyNotWatching(loop.projectPath, loop.agentId, inPlay)
}

let started = false

/** Follows session statuses for agents in card loops. Once, at startup. */
export function initLoopCheck(): void {
  if (started) return
  started = true
  // One check at a time per loop (#1011): a batch of card changes told each one.
  const recheckAll = (workspacePath: string | null): void => {
    for (const loop of loops.values()) {
      if (workspacePath !== null && workspaceOf(loop.projectPath).path?.toLowerCase() !== workspacePath.toLowerCase()) continue
      void coalesced(`loop-check:${keyOf(loop.projectPath, loop.agentId)}`, () => recheck(loop).catch((err) => log.warn('checking a card loop', err)))
    }
  }
  onHiveEvent((e) => {
    if (e.type === 'session-status') statusChanged(e.state)
    else if (e.type === 'tasks-changed' || e.type === 'lanes-changed' || e.type === 'team-pause-changed') recheckAll(e.workspacePath)
    // What reaches it may have changed (HI-1693): its hive tools (the Agent API, the built-in hive server), or its
    // project's loop wakes and agents (a project's settings written refresh the workspace).
    else if (e.type === 'settings-changed') recheckAll(null)
    else if (e.type === 'workspace-changed' && e.workspace?.path) recheckAll(e.workspace.path)
  })
}
