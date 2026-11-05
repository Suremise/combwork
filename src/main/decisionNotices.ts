import { basename } from 'path'
import { workStartedAt } from '../shared/tasks'
import type { TaskCard } from '../shared/types'
import { onHiveEvent } from './events'
import { liveDecisionCards } from './tasks'
import type { WorkspaceService } from './workspace'
import { cardRef } from '../shared/projectKeys'
import { historyBlocked, historyWholeVerdict } from '../shared/watch'
import { NOTICE_PREFIX } from '../shared/doorbell'
import { agentMsg, say } from '../shared/agentText'

const T = {
  card: agentMsg({ id: 'notice.decision.card', text: '{card} has {count} new {n, plural, one {decision} other {decisions}}', note: '#357, #401: a card in a line about new decisions (a reply\'s flag, a decision wake), joined by ", ". card: its key ("HI-12"); count and n: how many.' }),
  flag: agentMsg({ id: 'notice.decision.flag', text: '{cards} since you last read {n, plural, one {it} other {them}}: read {n, plural, one {the card} other {each card}} (cw_read_task) at your next checkpoint.', note: '#357: the flag after "[Combwork] " in a hive tool\'s reply, when decisions were recorded or changed on the agent\'s cards since it last read them. cards: each card\'s decisions (notice.decision.card); n: how many cards.' })
}

/** "HI-12 has 2 new decisions": a card in a line about new decisions (here and decisionWakes.ts). */
export const cardDecisions = (n: number, count: number): string => say(T.card, { card: cardRef(n), count: String(count), n: count })

/**
 * The "new decision" flag (#357): a hive tool's reply to an agent working on a card (in Doing, its agent), asking the
 * user about one (blocked, its agent) or reviewing one says when a decision was recorded or changed on it since the agent last read the card in full, or since its work
 * (or review) began. Only a flag: the skills say when to act on it (at the next checkpoint). Reads are kept in memory;
 * after a restart the start of the work is the baseline.
 */

/** When each agent last read each card in full: `<project path>#<agent id>` → card → ms. */
const reads = new Map<string, Map<number, number>>()
const keyOf = (agent: { projectPath: string; agentId: string }): string => `${agent.projectPath.toLowerCase()}#${agent.agentId}`

/** The agent read the card in full (cw_read_task): what it saw isn't new any more. */
export function noteCardRead(agent: { projectPath: string; agentId: string }, n: number, at = Date.now()): void {
  const key = keyOf(agent)
  const m = reads.get(key) ?? new Map<number, number>()
  m.set(n, at)
  reads.set(key, m)
  // Bounded: an agent that reads thousands of cards keeps its latest ones.
  if (m.size > 500) m.delete(m.keys().next().value!)
  readSeq.set(key, (readSeq.get(key) ?? 0) + 1)
}

/** How many full reads an agent has made (this run): a line about its decisions, worked out before one, is out of date (#401). */
const readSeq = new Map<string, number>()
export const cardReadsBy = (agent: { projectPath: string; agentId: string }): number => readSeq.get(keyOf(agent)) ?? 0

// The board's live cards with decisions as last read, per workspace, until it changes: an agent's every board call shouldn't read every
// card, and never the archived ones (#1107: 945 of them, 13 MB, on a busy board), which have no decisions to tell.
const boards = new Map<string, Promise<{ cards: TaskCard[]; generations: Map<number, number> }>>()
let changes = 0
let listening = false
function board(ws: WorkspaceService): Promise<{ cards: TaskCard[]; generations: Map<number, number> }> {
  if (!listening) {
    listening = true
    onHiveEvent((e) => {
      if (e.type !== 'tasks-changed') return
      changes++
      boards.delete(e.workspacePath.toLowerCase())
    })
  }
  const key = ws.path!.toLowerCase()
  let p = boards.get(key)
  if (!p) {
    const at = changes
    // With each card's decision generation read with it (#1216): what a line tells, its receipt records. Only the cards
    // changed since the last read are read again (HI-1789).
    p = liveDecisionCards(ws)
    boards.set(key, p)
    // A read the board changed under isn't kept for the next call.
    void p.then(
      () => at !== changes && boards.get(key) === p && boards.delete(key),
      () => boards.delete(key)
    )
  }
  return p
}

/** A review verdict this agent gave on the card (its name on the board), the latest: when it last finished reviewing it. */
const lastVerdict = (c: TaskCard, self: string): number => Date.parse(c.history.findLast((h) => h.by === self && historyWholeVerdict(h))?.at ?? '') || 0

/** When the card was last blocked (ms), or 0. */
const blockedAt = (c: TaskCard): number => Date.parse(c.history.findLast((h) => historyBlocked(h))?.at ?? '') || 0

/**
 * Where an agent's view of a card's decisions starts (ms), or null when the card isn't one of its: a card it works on (in
 * Doing, its agent: since it last read the card in full, or since the work began); one it asked the user about out of
 * Doing (blocked, its agent: a builder's question at its lane's end, on its card in Passed or Review, #877: since its last
 * full read, or since it was blocked); one it reviews (since its last full read, else its last verdict on it, else the
 * review's start: starting another round doesn't make unread decisions read); and one back in Review that it reviewed
 * before (its next round: since its last read or verdict).
 */
function baseline(c: TaskCard, agentId: string, self: string, read: number | undefined, loop = false): number | null {
  if (c.column === 'doing' && c.agent === agentId) return Math.max(read ?? 0, workStartedAt(c))
  // A card of its loop that a decision woke it for (#1266, S5: wakeOnDecision): its builder's in Review or Passed too,
  // and its reviewer's in Passed (since its verdict). Only for that wake's line, never a reply's flag.
  if (loop && (c.column === 'review' || c.column === 'passed') && c.agent === agentId) return Math.max(read ?? 0, workStartedAt(c))
  if (loop && c.column === 'passed' && lastVerdict(c, self)) return Math.max(read ?? 0, lastVerdict(c, self))
  if (c.blocked && c.agent === agentId && c.column !== 'done') return Math.max(read ?? 0, blockedAt(c))
  const verdict = lastVerdict(c, self)
  if (c.review?.agent === agentId) return read ?? (verdict || Date.parse(c.review.since) || 0)
  if (c.column === 'review' && !c.review && verdict) return Math.max(read ?? 0, verdict)
  return null
}

/**
 * The agent's cards (baseline) with decisions new to it, and how many each: recorded by someone else, or changed by the
 * user, since its view of the card starts. `self` is the agent's name on the board: a decision it recorded itself isn't
 * news to it, but the user's change to one (the user alone edits them) always is.
 */
export async function newDecisions(ws: WorkspaceService, agent: { projectPath: string; agentId: string }, self: string): Promise<Map<number, number>> {
  return new Map([...(await newDecisionsOn(ws, agent, self)).entries()].map(([n, d]) => [n, d.count]))
}

/**
 * newDecisions, each card with when its newest such decision was made (ms): for a line that tells them (#401). `told`:
 * per card, what an earlier line already told (the latest decision time it covered): only later ones count. `loop`: the cards
 * decision wakes are for (#1266), whose builders and reviewers hear of them in Review and Passed too (baseline).
 */
export async function newDecisionsOn(ws: WorkspaceService, agent: { projectPath: string; agentId: string }, self: string, told?: Map<number, number>, loop?: ReadonlySet<number>): Promise<Map<number, { count: number; latest: number; generation: number }>> {
  const out = new Map<number, { count: number; latest: number; generation: number }>()
  if (!ws.path) return out
  const project = basename(agent.projectPath).toLowerCase()
  const seen = reads.get(keyOf(agent))
  const t = (iso: string | undefined): number => Date.parse(iso ?? '') || 0
  const { cards, generations } = await board(ws)
  for (const c of cards) {
    if (!c.decisions?.length || c.project.toLowerCase() !== project) continue
    const base = baseline(c, agent.agentId, self, seen?.get(c.number), !!loop?.has(c.number))
    if (base === null) continue
    const since = Math.max(base, told?.get(c.number) ?? 0)
    const fresh = c.decisions.filter((d) => t(d.editedAt) > since || (d.recordedBy !== self && t(d.at) > since))
    // The card's decision generation, read with its decisions: what a receipt of this line records (#1216).
    if (fresh.length) out.set(c.number, { count: fresh.length, latest: Math.max(...fresh.map((d) => Math.max(t(d.at), t(d.editedAt)))), generation: generations.get(c.number) ?? 0 })
  }
  return out
}

/** When the agent last read the card in full (ms), or 0. */
export const lastCardRead = (agent: { projectPath: string; agentId: string }, n: number): number => reads.get(keyOf(agent))?.get(n) ?? 0

/** The line for a reply, or null when nothing is new. */
export function noticeText(cards: Map<number, number>): string | null {
  if (!cards.size) return null
  const parts = [...cards].map(([n, k]) => cardDecisions(n, k))
  return NOTICE_PREFIX + say(T.flag, { cards: parts.join(', '), n: parts.length })
}

/** The flag for an agent's reply, or null (newDecisions as a line). */
export async function decisionNotice(ws: WorkspaceService, agent: { projectPath: string; agentId: string }, self: string): Promise<string | null> {
  return noticeText(await newDecisions(ws, agent, self))
}
