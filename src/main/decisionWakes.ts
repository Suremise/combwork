import { app } from 'electron'
import { basename, join } from 'path'
import { projectAgents } from '../shared/defaults'
import type { LiveSessionState } from '../shared/types'
import { HISTORY, storedText } from '../shared/taskHistory'
import { cardDecisions, cardReadsBy, newDecisionsOn } from './decisionNotices'
import { NOTICE_PREFIX } from '../shared/doorbell'
import { agentMsg, inDialectOf, say, type AgentMsg } from '../shared/agentText'
import { recordDecisionsReceived } from './workflow/recorder'
import { onCombworkEvent } from './events'
import { coalesced } from './coalesce'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { getTask, noteOnCard } from './tasks'
import { actionDelivered, createDelivery, fromSource, offerNow, registerSource } from './deliveries'
import { cardReviewer, wakesOn } from './loopWakes'
import { onAction } from './workflow/actionWorker'
import { watchCovers, watchToldDecisions } from './watches'
import type { ActionRow } from './workflow/factStore'
import { isWaiting } from '../shared/deliveries'
import { openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'
import { scopeOfHost, withCardNames } from './projectKeys'

/**
 * Decisions reach an agent waiting for the user (#401). An agent asks the user, and its turn ends; the user answers
 * elsewhere (through the Assistant), and the answer is recorded on its card as decisions (#357). An agent waiting makes no
 * tool calls, so the flag in its next reply never comes: Hive gives it one line, a delivery (#649: the user's answer,
 * which the agent acks), offered as a card watch's wake is (#376, #430: taken, or marked) when its turn has ended (ready
 * or finished: not working, not on background tasks, not watching, whose wake tells it, and never into a question or
 * permission prompt it shows), the user isn't typing there and no line of Hive's waits to be taken. Decisions landing
 * together are told together: after a short settle. What a line told isn't told again once it is received (in memory);
 * the card's history says whom Hive told. The Assistant's own cards aren't its: project agents only. A line is made again
 * just before it is offered, and typed only while it is still true: until Enter, nothing on the board changed and the
 * agent read no card since (else it is made again at the next try).
 */

const log = createLogger('decisions')

/** How long after a board change (or a turn's end) Hive waits before telling, so decisions recorded together are told together. */
const SETTLE_MS = 15_000
/** However the board keeps changing, it tells at most this long after the first change it waits on. */
const SETTLE_MAX_MS = 60_000
export const testHooks: { settleMs?: number } = {}
const settleMs = (): number => {
  const v = !app.isPackaged ? Number(process.env.CW_TEST_DECISION_SETTLE_MS) : NaN
  return testHooks.settleMs ?? (Number.isFinite(v) && v >= 0 ? v : SETTLE_MS)
}

/** What each agent was told, per card: the newest decision a line covered (ms). Bounded. */
const told = new Map<string, Map<number, number>>()
const keyOf = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`
/** Agents being told now (one line at a time each). */
const telling = new Set<string>()

/** Board changes per workspace (this run): a line worked out before one may be out of date (reassigned, a decision removed). */
const boardGen = new Map<string, number>()
const genOf = (ws: WorkspaceService): number => boardGen.get((ws.path ?? '').toLowerCase()) ?? 0
// Counted from the start, whether or not decision lines are wired in (initDecisionWakes), so tests see it too.
onCombworkEvent((e) => {
  if (e.type === 'tasks-changed') boardGen.set(e.workspacePath.toLowerCase(), (boardGen.get(e.workspacePath.toLowerCase()) ?? 0) + 1)
})

/** Whether an agent may be told now: its turn has ended, nobody types there, no line of Hive's waits. */
const ready = (st: LiveSessionState | null): boolean => !!st && (st.status === 'ready' || st.status === 'finished')

const T = {
  workspaceClosed: agentMsg({ id: 'inbox.decisionEnded.workspaceClosed', text: 'its workspace was closed', note: "Why a line of new decisions (#401, a delivery) was cancelled just before it was given: its workspace closed." }),
  agentGone: agentMsg({ id: 'inbox.decisionEnded.agentGone', text: 'its agent has gone', note: 'Why a line of new decisions was cancelled just before it was given: its agent was removed from the project.' }),
  nothingNew: agentMsg({ id: 'inbox.decisionEnded.nothingNew', text: 'nothing new to tell', note: 'Why a line of new decisions was cancelled just before it was given: the agent has read them meanwhile, or its watch tells them.' }),
  line: agentMsg({
    id: 'wake.decision.line',
    text: '{cards} from the user: read {one, select, yes {it} other {them}} (cw_read_task) {reviewer, select, yes {before your next verdict on {n, plural, one {it} other {them}}.} other {and carry on from where you asked.}}',
    note: '#401: the line after "[Combwork] " given to an agent waiting for the user (or a decision wake, #1266) when the user\'s decisions were recorded on its cards. cards: each card\'s decisions (notice.decision.card), joined by ", "; one: yes for a single decision on one card; reviewer: yes when the agent only reviews those cards (HI-2261: told to carry on, a reviewer that had asked nothing made the decided change itself); n: how many cards.'
  })
}

/**
 * The line: "[Hive] #392 has 4 new decisions from the user: read them (cw_read_task) and carry on." `reviewing`: the
 * cards the agent only reviews (another agent's: a loop's wake to its reviewer). When they are all of them, the line asks
 * for a read before its next verdict (HI-2261: told to "carry on from where you asked", a reviewer that had asked nothing
 * made the decided change itself), never to carry on.
 */
export function decisionLine(cards: Map<number, { count: number }>, reviewing: ReadonlySet<number> = new Set()): string {
  const parts = [...cards].map(([n, d]) => cardDecisions(n, d.count))
  const one = parts.length === 1 && [...cards.values()][0].count === 1 ? 'yes' : 'no'
  const reviewer = cards.size > 0 && [...cards.keys()].every((n) => reviewing.has(n)) ? 'yes' : 'no'
  return NOTICE_PREFIX + say(T.line, { cards: parts.join(', '), one, reviewer, n: cards.size })
}

/** The cards among `cards` that are another agent's, so `agentId` only reviews them (decisionLine's `reviewing`). */
export async function reviewingOf(ws: WorkspaceService, agentId: string, cards: Map<number, unknown>): Promise<Set<number>> {
  const out = new Set<number>()
  for (const n of cards.keys()) {
    const card = await getTask(n, ws).catch(() => null)
    if (card?.agent && card.agent !== agentId) out.add(n)
  }
  return out
}

/**
 * A line's decisions less what the agent's own card watch tells it (#1272: one wake per event): a card whose watch
 * counts them is left out; one whose watch's line told some has only those recorded or changed since counted (by their
 * history entries' places, never their times), and is left out when none is. What is left is the line's. `self`: the
 * agent's board name.
 */
async function leftToWatches<T extends { count: number }>(ws: WorkspaceService, projectPath: string, agentId: string, self: string, cards: Map<number, T>): Promise<Map<number, T>> {
  for (const [n, d] of [...cards]) {
    const card = await getTask(n, ws).catch(() => null)
    const byWatch = card ? watchToldDecisions(projectPath, agentId, card, self) : null
    if (!byWatch) continue
    if (byWatch === 'all' || !byWatch.untold) cards.delete(n)
    else cards.set(n, { ...d, count: Math.min(d.count, byWatch.untold) })
  }
  return cards
}
/** The decision line for an agent (its host and id), in its dialect. */
async function lineOf(ws: WorkspaceService, projectPath: string, agentId: string, cards: Map<number, { count: number }>): Promise<string> {
  const reviewing = await reviewingOf(ws, agentId, cards)
  return inDialectOf({ projectPath, agentId }, () => decisionLine(cards, reviewing))
}
/** Whether a watch of the agent's counts a card's decisions now (a decision has no column: any will do). */
const watchHearsDecisions = (projectPath: string, agentId: string, n: number): boolean => watchCovers(projectPath, agentId, n, 'decision', 'review')

/** The decisions are the user's: Hive relays them. */
// agent-protocol: the sender's name a delivery is labelled with (deliveries name their senders)
const USER = { kind: 'user', name: 'the user' } as const

/**
 * What each version of a line was made from (by host, delivery id and version: ids are a host's own, and a line is made
 * again before each offer or hand-out): the board's and the agent's reads then, which `holds` compares with now. What it
 * tells is saved on the delivery itself (its `meta`), so a receipt covers the version received, never a later one.
 */
const madeKey = (host: string, id: string, v: unknown): string => `${host.toLowerCase()}#${id}#${String(v)}`
const made = new Map<string, { ws: WorkspaceService; gen: number; reads: ReturnType<typeof cardReadsBy> }>()
let versions = 0

/** A line's decisions as its delivery saves them: "card:count:latest", comma-separated (as many as fit what reads back). */
const encodeCards = (cards: Map<number, { count: number; latest: number }>): string => [...cards].map(([n, d]) => `${n}:${d.count}:${d.latest}`).join(',')
const decodeCards = (v: unknown): Map<number, { count: number; latest: number }> =>
  new Map(
    (typeof v === 'string' && v ? v.split(',') : []).flatMap((x) => {
      const [n, count, latest] = x.split(':').map(Number)
      return Number.isInteger(n) && n > 0 && Number.isFinite(count) && Number.isFinite(latest) ? [[n, { count, latest }] as const] : []
    })
  )
/** The decisions of a line that fit its delivery's context (400 characters): those it says, the rest told by a next line. */
function fitting<T extends { count: number; latest: number }>(cards: Map<number, T>): Map<number, T> {
  const out = new Map<number, T>()
  for (const [n, d] of cards) {
    const next = new Map(out).set(n, d)
    if (encodeCards(next).length > 400) break
    out.set(n, d)
  }
  return out
}

async function boardSelf(ws: WorkspaceService, projectPath: string, agentId: string): Promise<string | null> {
  const def = projectAgents(await ws.projectConfig(projectPath)).find((a) => a.id === agentId)
  return def ? `${def.name} (${basename(projectPath)})` : null
}

/**
 * The decision lines' part in their deliveries (#649): made again just before each offer from the decisions new to the
 * agent then (none left: cancelled); offered only while the board and the agent's reads haven't changed since (else made
 * again at the next try); received, its decisions are told (never again) and noted on their cards.
 */
registerSource('decision', {
  refresh: async (r, host) => {
    const ws = workspaceFor(host)
    const why = (m: AgentMsg): string => inDialectOf({ projectPath: host, agentId: r.agentId }, () => say(m))
    if (!ws || !openWorkspaces().includes(ws)) return { cancel: why(T.workspaceClosed) }
    const self = await boardSelf(ws, host, r.agentId)
    if (!self) return { cancel: why(T.agentGone) }
    const agent = { projectPath: host, agentId: r.agentId }
    // What the line is worked out from: the board and the agent's reads as they are now.
    const gen = genOf(ws)
    const reads = cardReadsBy(agent)
    // A decision wake's line (#1266) also tells its cards where only their loop makes them the agent's (`loop`).
    const loop = loopOf(r)
    const cards = fitting(await leftToWatches(ws, host, r.agentId, self, await newDecisionsOn(ws, agent, self, told.get(keyOf(host, r.agentId)), loop)))
    if (!cards.size) return { cancel: why(T.nothingNew) }
    // This version: its line, and what its receipt tells (saved with it), and what its holds compares with.
    const v = ++versions
    made.set(madeKey(host, r.id, v), { ws, gen, reads })
    if (made.size > 500) made.delete(made.keys().next().value!)
    // `gens`: each card's decision generation as this line was made from it, what its receipt records as received (#1216).
    return { body: await lineOf(ws, host, r.agentId, cards), meta: { v, cards: encodeCards(cards), self, gens: [...cards].map(([n, d]) => `${n}:${d.generation}`).join(','), ...(loop.size ? { loop: [...loop].join(',') } : {}) } }
  },
  holds: (r, host) => {
    const m = made.get(madeKey(host, r.id, r.meta?.v))
    return !!m && openWorkspaces().includes(m.ws) && genOf(m.ws) === m.gen && cardReadsBy({ projectPath: host, agentId: r.agentId }) === m.reads && ![...decodeCards(r.meta?.cards).keys()].some((n) => watchHearsDecisions(host, r.agentId, n))
  },
  received: (r, host) => {
    made.delete(madeKey(host, r.id, r.meta?.v))
    // What the version received says, and nothing a later refresh prepared.
    const cards = decodeCards(r.meta?.cards)
    const self = typeof r.meta?.self === 'string' ? r.meta.self : null
    const ws = workspaceFor(host)
    if (!cards.size || !self || !ws) return
    const key = keyOf(host, r.agentId)
    const known = told.get(key) ?? new Map<number, number>()
    for (const [n, d] of cards) known.set(n, Math.max(known.get(n) ?? 0, d.latest))
    told.delete(key)
    told.set(key, known)
    if (told.size > 500) told.delete(told.keys().next().value!)
    log.info(`Told ${userText(self)} of new decisions on ${[...cards.keys()].map((n) => `#${n}`).join(', ')}`)
    // What it received, as a fact on each card (#1216): the decisions the line was made from.
    for (const x of typeof r.meta?.gens === 'string' && r.meta.gens ? r.meta.gens.split(',') : []) {
      const [n, g] = x.split(':').map(Number)
      if (Number.isInteger(n) && Number.isInteger(g) && g > 0) void recordDecisionsReceived(ws, r.agentId, n, g)
    }
    void Promise.all([...cards].map(([n, d]) => noteOnCard(n, storedText(HISTORY.decisionsTold, { agent: self, count: d.count }), ws).catch((e) => log.warn(`noting on #${n} that decisions were told`, e))))
  },
  ended: (r, host) => {
    made.delete(madeKey(host, r.id, r.meta?.v))
  }
})

/** Gives one agent a line of the decisions new to it, if it may be told now: a delivery, one per agent, offered now. */
/** Tells an agent of new decisions (tellNamed), naming cards by key, its workspace's (#1219). */
function tell(ws: WorkspaceService, projectPath: string, agentId: string): Promise<void> {
  return withCardNames(ws, () => tellNamed(ws, projectPath, agentId), scopeOfHost(projectPath))
}

async function tellNamed(ws: WorkspaceService, projectPath: string, agentId: string): Promise<void> {
  const key = keyOf(projectPath, agentId)
  if (telling.has(key) || ws.isAssistantHome(projectPath)) return
  // Not ready (working, on background tasks, watching, a prompt shown, stopped): the end of its turn checks again. Its
  // workspace closed: nothing to tell it from.
  if (!ready(sessions.liveFor(projectPath, agentId)) || !openWorkspaces().includes(ws)) return
  const agent = { projectPath, agentId }
  telling.add(key)
  try {
    // A line offered and not read yet (#650: its doorbell rang) is made again from the board when the agent reads it, so
    // it tells these decisions too: not a second line beside it.
    // A decision wake's line waiting (#1266, made by an action) is made again from the board when it is offered, with its
    // loop's card: not replaced by this one, which would lose that card.
    if (fromSource(projectPath, 'decision').some((r) => r.agentId === agentId && (r.state === 'offered' || (r.action !== undefined && isWaiting(r))))) return
    const self = await boardSelf(ws, projectPath, agentId)
    if (!self) return
    const cards = fitting(await leftToWatches(ws, projectPath, agentId, self, await newDecisionsOn(ws, agent, self, told.get(key))))
    if (!cards.size) return
    // Made again from the decisions as they are when it is offered (one waiting is that one).
    await createDelivery(projectPath, { agentId, agentName: self, kind: 'answer', from: USER, card: [...cards.keys()][0], body: await lineOf(ws, projectPath, agentId, cards), source: 'decision', ref: 'decisions', replace: true, need: 'free', meta: { cards: encodeCards(cards), self } })
    await offerNow(projectPath, agentId)
  } finally {
    telling.delete(key)
  }
}

/**
 * A `wakeOnDecision` action (#1266, S5; #587's gap): a decision recorded on a card in a loop wakes its builder (`to:
 * builder`, the card's agent) and, while the card is in Review or Passed, its reviewer (`to: reviewer`: the lane's, else
 * the last), whether or not they are waiting for the user: a watching agent too, which a decision line never reached
 * before. The line is the decision line, made with the action's id (made once), and made again from the board when it
 * is offered, as every decision line is. Not to whoever recorded it, not where the project turned loop wakes off, and
 * only when the decisions are new to that agent.
 */
async function decisionFromAction(a: ActionRow, from: WorkspaceService): Promise<void> {
  if (!from.path) return
  const card = await getTask(a.card, from).catch(() => null)
  if (!card?.project || card.archived) return
  const projectPath = join(from.path, card.project)
  const ws = workspaceFor(projectPath)
  if (!ws?.isProjectPath(projectPath) || !openWorkspaces().includes(ws) || !(await wakesOn(ws, projectPath))) return
  if (actionDelivered(projectPath, a.id)) return
  const to = a.payload.to === 'reviewer' ? await cardReviewer(ws, projectPath, card) : card.agent ? { id: card.agent, name: '' } : null
  if (!to || a.payload.by === `agent:${to.id}`) return
  await withCardNames(
    ws,
    async () => {
      const self = await boardSelf(ws, projectPath, to.id)
      if (!self) return
      // One line per agent, telling every card a decision wake waiting for it was for, this one's too: the one waiting is
      // replaced (cancelled, its action done) by this one, which carries its cards on.
      const loop = new Set([a.card, ...fromSource(projectPath, 'decision').filter((r) => r.agentId === to.id && r.action !== undefined && isWaiting(r)).flatMap((r) => [...loopOf(r)])])
      // Its own card watch's cards that tell it of their decisions (#1272) are left to that watch.
      const cards = fitting(await leftToWatches(ws, projectPath, to.id, self, await newDecisionsOn(ws, { projectPath, agentId: to.id }, self, told.get(keyOf(projectPath, to.id)), loop)))
      if (!cards.size) return
      try {
        await createDelivery(projectPath, { agentId: to.id, agentName: self, kind: 'answer', from: USER, card: a.card, body: await lineOf(ws, projectPath, to.id, cards), source: 'decision', ref: 'decisions', replace: true, meta: { cards: encodeCards(cards), self, loop: [...loop].join(',') }, action: a.id })
      } catch (e) {
        // Another Hive made it meanwhile (the unique row refused this one's): delivered.
        if (!actionDelivered(projectPath, a.id)) throw e
        return
      }
      await offerNow(projectPath, to.id)
    },
    scopeOfHost(projectPath)
  )
}

/** The cards a decision wake's line is for (`meta.loop`, comma-separated), none for another decision line. */
function loopOf(r: { meta?: Record<string, string | number | boolean> }): Set<number> {
  const v = r.meta?.loop
  return new Set((typeof v === 'number' ? [v] : typeof v === 'string' ? v.split(',').map(Number) : []).filter((n) => Number.isInteger(n) && n > 0))
}

/** Every running project agent of a workspace that may be told. */
async function tellAll(ws: WorkspaceService): Promise<void> {
  for (const st of sessions.liveStates()) if (workspaceFor(st.projectPath) === ws && ready(st)) await tell(ws, st.projectPath, st.agentId)
}

/** A settle per workspace (and per agent at its turn's end): reset by each change, never past SETTLE_MAX_MS. */
const settling = new Map<string, { timer: ReturnType<typeof setTimeout>; since: number }>()
function settle(key: string, fn: () => void): void {
  const had = settling.get(key)
  const since = had?.since ?? Date.now()
  if (had) clearTimeout(had.timer)
  const wait = Math.max(0, Math.min(settleMs(), since + SETTLE_MAX_MS - Date.now()))
  const timer = setTimeout(() => {
    settling.delete(key)
    fn()
  }, wait)
  timer.unref?.()
  settling.set(key, { timer, since })
}

let started = false
/** Wires decision lines into the board's and sessions' events (once, at start). */
export function initDecisionWakes(): void {
  if (started) return
  started = true
  // Its delivery carries the action's id: run until marked, made once.
  onAction('wakeOnDecision', (a, ws) => decisionFromAction(a, ws), 'delivered')
  onCombworkEvent((e) => {
    if (e.type === 'tasks-changed') {
      const ws = openWorkspaces().find((w) => w.path && w.path.toLowerCase() === e.workspacePath.toLowerCase())
      // One look at a time (#1011): a slow one isn't overlapped by the next.
      if (ws) settle(`ws:${e.workspacePath.toLowerCase()}`, () => void coalesced(`decisions:${e.workspacePath.toLowerCase()}`, () => tellAll(ws).catch((err) => log.warn('telling of decisions', err))))
    } else if (e.type === 'session-status' && ready(e.state)) {
      // Its turn ended: decisions recorded while it worked (and not read since) reach it now.
      const { projectPath, agentId } = e.state
      const ws = workspaceFor(projectPath)
      if (ws && !ws.isAssistantHome(projectPath)) settle(`agent:${keyOf(projectPath, agentId)}`, () => void tell(ws, projectPath, agentId).catch((err) => log.warn('telling of decisions', err)))
    }
  })
}

/** Checks now (what a settled change does): for tests. */
export const tellNow = (ws: WorkspaceService, projectPath: string, agentId: string): Promise<void> => tell(ws, projectPath, agentId)

/** For tests: nothing is left to do for an agent (no line being made or waiting to be offered, or waiting for its settle). */
export function settledFor(projectPath: string, agentId: string): boolean {
  const key = keyOf(projectPath, agentId)
  return !telling.has(key) && !settling.has(`agent:${key}`) && !fromSource(projectPath, 'decision').some((r) => r.agentId === agentId && isWaiting(r))
}
