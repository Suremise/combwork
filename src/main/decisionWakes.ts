import { app } from 'electron'
import { basename } from 'path'
import { projectAgents } from '../shared/defaults'
import type { LiveSessionState } from '../shared/types'
import { HISTORY, storedText } from '../shared/taskHistory'
import { cardReadsBy, newDecisionsOn } from './decisionNotices'
import { recordDecisionsReceived } from './workflow/recorder'
import { onHiveEvent } from './events'
import { coalesced } from './coalesce'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { noteOnCard } from './tasks'
import { createDelivery, fromSource, offerNow, registerSource } from './deliveries'
import { isWaiting } from '../shared/deliveries'
import { openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'

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
  const v = !app.isPackaged ? Number(process.env.HIVE_TEST_DECISION_SETTLE_MS) : NaN
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
onHiveEvent((e) => {
  if (e.type === 'tasks-changed') boardGen.set(e.workspacePath.toLowerCase(), (boardGen.get(e.workspacePath.toLowerCase()) ?? 0) + 1)
})

/** Whether an agent may be told now: its turn has ended, nobody types there, no line of Hive's waits. */
const ready = (st: LiveSessionState | null): boolean => !!st && (st.status === 'ready' || st.status === 'finished')

/** The line: "[Hive] #392 has 4 new decisions from the user: read them (hive_read_task) and carry on." */
export function decisionLine(cards: Map<number, { count: number }>): string {
  const parts = [...cards].map(([n, d]) => `#${n} has ${d.count} new decision${d.count === 1 ? '' : 's'}`)
  const them = parts.length === 1 && [...cards.values()][0].count === 1 ? 'it' : 'them'
  return `[Hive] ${parts.join(', ')} from the user: read ${them} (hive_read_task) and carry on from where you asked.`
}

/** The decisions are the user's: Hive relays them. */
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
    if (!ws || !openWorkspaces().includes(ws)) return { cancel: 'its workspace was closed' }
    const self = await boardSelf(ws, host, r.agentId)
    if (!self) return { cancel: 'its agent has gone' }
    const agent = { projectPath: host, agentId: r.agentId }
    // What the line is worked out from: the board and the agent's reads as they are now.
    const gen = genOf(ws)
    const reads = cardReadsBy(agent)
    const cards = fitting(await newDecisionsOn(ws, agent, self, told.get(keyOf(host, r.agentId))))
    if (!cards.size) return { cancel: 'nothing new to tell' }
    // This version: its line, and what its receipt tells (saved with it), and what its holds compares with.
    const v = ++versions
    made.set(madeKey(host, r.id, v), { ws, gen, reads })
    if (made.size > 500) made.delete(made.keys().next().value!)
    // `gens`: each card's decision generation as this line was made from it, what its receipt records as received (#1216).
    return { body: decisionLine(cards), meta: { v, cards: encodeCards(cards), self, gens: [...cards].map(([n, d]) => `${n}:${d.generation}`).join(',') } }
  },
  holds: (r, host) => {
    const m = made.get(madeKey(host, r.id, r.meta?.v))
    return !!m && openWorkspaces().includes(m.ws) && genOf(m.ws) === m.gen && cardReadsBy({ projectPath: host, agentId: r.agentId }) === m.reads
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
async function tell(ws: WorkspaceService, projectPath: string, agentId: string): Promise<void> {
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
    if (fromSource(projectPath, 'decision').some((r) => r.agentId === agentId && r.state === 'offered')) return
    const self = await boardSelf(ws, projectPath, agentId)
    if (!self) return
    const cards = fitting(await newDecisionsOn(ws, agent, self, told.get(key)))
    if (!cards.size) return
    // Made again from the decisions as they are when it is offered (one waiting is that one).
    await createDelivery(projectPath, { agentId, agentName: self, kind: 'answer', from: USER, card: [...cards.keys()][0], body: decisionLine(cards), source: 'decision', ref: 'decisions', replace: true, need: 'free', meta: { cards: encodeCards(cards), self } })
    await offerNow(projectPath, agentId)
  } finally {
    telling.delete(key)
  }
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
  onHiveEvent((e) => {
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
