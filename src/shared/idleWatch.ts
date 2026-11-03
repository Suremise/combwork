// HI-2285: a lane's builder watching its own card while nothing on it waits on anyone. Agent-facing English throughout
// (the card watch's reply, the Agent API's and lane watches' `stalled`): agent messages (shared/agentText).
//
// On 1 Nov CB1 committed CL-5's plan, watched CL-5 for a comment and ended its turn: no question to the user, no design
// step for the reviewer, the card in Doing and not submitted. Watching counted as waiting, so nothing told anyone, and
// the user found it idle. Hive's reply to such a watch says so (a warning, not a refusal: card-loop's waiting rules let a
// builder watch its card for a comment it asked for, which Hive doesn't track), and a builder that keeps only watching is
// stalled after IDLE_WATCH_STALL_MS.

import { cardName } from './projectKeys'
import { shortDuration } from './progress'
import { pendingStep } from './tasks'
import type { TaskCard } from './types'
import { agentMsg, say } from './agentText'

const T = {
  reply: agentMsg({
    id: 'wake.idle.reply',
    text: "Nothing waits on {card}: it is in Doing and not submitted, with no question open for the user and no design step out for the reviewer, so nobody will change it for you. Carry on with its work now rather than end your turn; if you need someone, ask: hive_ask_user for the user, hive_loop_step with a design for the reviewer, or hive_submit once it is ready. Keep this watch only for something you asked for that Hive doesn't track (a comment you requested): if you only watch it, {card} shows as stalled after {after}.",
    note: "HI-2285: hive_wait_for_tasks's warning to a lane's builder watching only its own card while nothing on it waits on anyone (CB1 watched CL-5 for a comment and ended its turn). card: its name (HI-12); after: how long until it shows as stalled (5 min)."
  }),
  stalled: agentMsg({ id: 'wake.idle.stalled', text: '{agent} only watches {card} ({since}), and nothing waits on it: no question for the user, no design step, not submitted.', note: "HI-2285: why a lane's card is stalled (the Agent API, lane watches): its builder (agent) only watches it. card: its name; since: for how long (7 min)." })
}

/** How long a lane's builder may only watch its own card with nothing waiting on it before the card is stalled. */
export const IDLE_WATCH_STALL_MS = 5 * 60_000

type IdleCard = Pick<TaskCard, 'number' | 'key' | 'column' | 'archived' | 'blocked' | 'agent' | 'history'>

/**
 * Whether nothing on the builder's own card waits on anyone else: in Doing (not submitted, so not in Review or later),
 * not blocked, the builder's, no design or follow-up posted for its reviewer's check still open (pendingStep), and no
 * request open for the user (`forYouOpen`: the card's For you items, any asker's). Hive's existing state only.
 */
export function nothingWaitsOn(card: IdleCard, builder: string, forYouOpen: boolean): boolean {
  return !card.archived && !card.blocked && card.column === 'doing' && card.agent === builder && !forYouOpen && !pendingStep(card)
}

/** The card watch's reply when the builder watches only such a card: what's wrong and what to do instead. */
export function idleWatchText(card: Pick<TaskCard, 'number' | 'key'>): string {
  const name = cardName(card)
  return say(T.reply, { card: name, after: shortDuration(IDLE_WATCH_STALL_MS) })
}

/**
 * Why a running lane's card is stalled by its builder only watching it with nothing waiting on it (`nothingWaitsOn`
 * already true), or null: the lane active (a paused one parks its agents), the card the lane's and its builder's, the
 * builder's turn over (status watching) with a card watch on this card alone (`watchesMore`: usage, lanes or agents beside
 * it, a wait on more than the card), for IDLE_WATCH_STALL_MS since the watch began. Agent-facing.
 */
export function idleWatchReason(card: IdleCard, lane: { builder: string; state?: string; cards: { number: number }[] } | null | undefined, watcher: { name: string; agentId: string; cards: number[]; watchesMore?: boolean; status?: string; watchSince?: string } | undefined, now = Date.now()): string | null {
  if (!lane || lane.state !== 'active' || !watcher || card.agent !== lane.builder || watcher.agentId !== lane.builder) return null
  if (!lane.cards.some((c) => c.number === card.number)) return null
  if (watcher.status !== 'watching' || watcher.watchesMore || watcher.cards.length !== 1 || watcher.cards[0] !== card.number) return null
  const since = Date.parse(watcher.watchSince ?? '')
  if (!Number.isFinite(since) || now - since < IDLE_WATCH_STALL_MS) return null
  return say(T.stalled, { agent: watcher.name, card: cardName(card), since: shortDuration(now - since) })
}
