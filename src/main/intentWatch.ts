import { join } from 'path'
import type { LaneInfo, TaskCard } from '../shared/types'
import { readCondition, WATCH_MAX_LIMIT_MINUTES, type WatchCondition } from '../shared/watch'
import { cardName } from '../shared/projectKeys'
import { shortDuration } from '../shared/progress'
import { listLanes } from './lanes'
import { createLogger } from './logger'
import { loadedWatchFor, registerWatch } from './watches'
import type { WorkspaceService } from './workspace'
import { agentMsg, say } from '../shared/agentText'

const log = createLogger('loops')

const T = {
  ownCovers: agentMsg({ id: 'notice.intent.ownCovers', text: 'You already watch {card} ({label}): end your turn.', note: '#1639: an intent\'s reply (a submit, a failed review) in a running lane, when the agent\'s own watch already covers its card. card: the card ("HI-12 (title)"); label: the watch\'s label.' }),
  ownStays: agentMsg({ id: 'notice.intent.ownStays', text: 'Your watch ({label}) stays: Combwork\'s loop wake tells you when {card} comes back.', note: '#1639: an intent\'s reply in a running lane, when the agent has another watch of its own (kept, not replaced). label: that watch\'s label; card: the card.' }),
  already: agentMsg({ id: 'notice.intent.already', text: '{card} is already {column}: carry on.', note: '#1639: an intent\'s reply in a running lane, when the card already reached the column its watch would wait for (a quick reviewer). column: the column\'s id ("passed").' }),
  armed: agentMsg({ id: 'notice.intent.armed', text: 'Combwork watches {card} for you, for {what, select, review {its review (a verdict, a move or a comment)} other {its next round in Review}}, up to {limit}: end your turn, and it wakes you.', note: '#1639: an intent\'s reply in a running lane: the card watch Hive armed for the agent. what: review after a builder\'s submit, round after a reviewer\'s failed verdict; limit: the lane\'s wait ("2h").' })
}

/**
 * The card watch Hive arms for an agent in a running lane after its handoff (#1639): a builder that submits its lane's
 * card watches it for the review (its verdict, a move on, a comment such as the reviewer's request), and a reviewer that
 * fails it watches for its next round in Review, each for the lane's wait. Twice on 25 Oct builders submitted and ended
 * their turn with no watch, and their lanes showed as stalled (loopCheck.ts): the step is Hive's, not the skill's.
 *
 * Armed only where the agent has no watch of its own: one that already includes the card is kept as it is (a watch
 * started before the step), and one on other cards, an agent or lane watch, isn't replaced (it keeps the agent from
 * showing as stalled, and Hive's loop wakes tell it of the verdict). The watch starts from the card as the intent left it,
 * so a verdict given before it is armed still wakes the agent. Never refusing what was done: a failure is logged.
 *
 * Returns what the intent's reply says of it (agent-facing), or null when the intent arms none.
 */
export async function armIntentWatch(ws: WorkspaceService, agentId: string, card: TaskCard, did: { submit: boolean; failed: boolean }): Promise<string | null> {
  if (!ws.path || !card.project || (!did.submit && !did.failed)) return null
  const name = cardName(card)
  const arm = async (): Promise<string | null> => {
    const lane = (await listLanes(ws, { project: card.project })).find((l) => running(l) && l.cards.some((c) => c.number === card.number) && (did.submit ? l.builder.id === agentId : l.reviewer?.id === agentId))
    if (!lane) return null
    // A builder's submission that left the card in Review; a reviewer's failure that sent it back from Review.
    if (did.submit ? card.column !== 'review' : card.column === 'review' || card.column === 'passed' || card.column === 'done') return null
    const projectPath = join(ws.path!, card.project)
    const own = await loadedWatchFor(ws, projectPath, agentId)
    if (own && !own.agents && !own.lanes && own.cards.includes(card.number)) return say(T.ownCovers, { card: name, label: own.label })
    if (own) return say(T.ownStays, { label: own.label, card: name })
    const cond = (did.submit ? readCondition({ cards: [card.number], changes: ['verdict', 'column', 'comment'], column: 'passed' }) : readCondition({ cards: [card.number], column: 'review', fresh: true })) as WatchCondition
    const r = await registerWatch(ws, projectPath, agentId, cond, lane.waitMinutes, { card, at: card.updatedAt })
    // Already: it passed before the watch was in place (a quick reviewer); its wake has told it, or tells it now.
    if ('already' in r) return say(T.already, { card: name, column: r.already.column })
    return say(T.armed, { card: name, what: did.submit ? 'review' : 'round', limit: shortDuration(Math.min(lane.waitMinutes, WATCH_MAX_LIMIT_MINUTES) * 60_000) })
  }
  return arm().catch((e) => {
    log.warn(`Arming the watch after #${card.number}'s ${did.submit ? 'submission' : 'failed review'}`, e)
    return null
  })
}

const running = (l: LaneInfo): boolean => l.state === 'active' || l.state === 'paused'
