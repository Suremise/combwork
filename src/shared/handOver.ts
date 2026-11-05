/**
 * A long conversation's hand-over (#1057; Darren's choice for 0.9.0, a queued one is #1067). Past Settings → Sessions →
 * Warn when a transcript is over, the notice and the footer's size say so, and offer Hand Over to… only while the agent
 * may end its conversation now: idle, not on a running lane's card, not merging. That is checked again when it is
 * clicked (a notice can be old by then), and by the hand-over itself. Otherwise they only say it can hand over when it
 * has finished.
 */
import { msg } from './i18n/msg'
import { laneRunning } from './laneBar'
import { tasksWillWake } from './providers'
import type { LaneInfo, LiveSessionState } from './types'

/** Whether an agent is the builder or reviewer of a running lane of its project (`project`: the folder's name). */
export const onRunningLane = (lanes: readonly LaneInfo[], project: string, agentId: string): boolean =>
  lanes.some((l) => laneRunning(l.state) && l.project.toLowerCase() === project.toLowerCase() && (l.builder.id === agentId || l.reviewer?.id === agentId))

/**
 * Whether the agent may hand over to a new conversation of its own now, ending this one: its turn over (ready or
 * finished, no background tasks that will start another), no merge slot held or waited for, and on no running lane.
 * Not running: yes (nothing is ended; Hand Over to… goes on from the latest handover).
 */
export function handOverNow(st: Pick<LiveSessionState, 'status' | 'provider' | 'backgroundTasks' | 'mergeSlot'> | null | undefined, inLane: boolean): boolean {
  if (!st || st.status === 'stopped') return true
  return !inLane && (st.status === 'ready' || st.status === 'finished') && !tasksWillWake(st) && !st.mergeSlot
}

export const HAND_OVER_TEXT = {
  /** The long-transcript notice's text (and the notification's): what can be done, without pushing. */
  notice: msg({
    id: 'session.long.noticeText',
    defaultMessage: 'Its transcript is {size} (over {limit, number} MB): it may slow down. {when, select, now {It can hand over to a new conversation: Hand Over to… lets you choose.} assistant {It can start a new conversation (⋯ → New Conversation) once it is idle.} other {It can hand over to a new conversation when it has finished.}}',
    description: "The notice that an agent's conversation is long. {size}: its transcript's size (\"24 MB\"); {limit}: the size it is flagged over, in MB (Settings → Sessions). Then what can be done: now (it is idle: Hand Over to… is a command), assistant (the Combwork Assistant: ⋯ → New Conversation is its menu command), other (it is working, merging or on a card loop's card)."
  }),
  /** A click on Hand Over to… (the notice's, the footer's size) when the agent may no longer hand over now. */
  notNow: msg({ id: 'session.long.notNow', defaultMessage: '{agent} is busy', description: "A notice's title: Hand Over to… was clicked, but the agent ({agent}) is working, merging or on a card loop's card now." }),
  notNowText: msg({ id: 'session.long.notNowText', defaultMessage: "It is working, merging or on a card loop's card, so its conversation isn't ended now. It can hand over to a new conversation when it has finished.", description: 'Under the notice that Hand Over to… was clicked while the agent is busy: why nothing happened, and when it can.' }),
  /** The footer's advice for a long transcript (its size's hover), as the notice says it. */
  advice: msg({ id: 'panes.footer.handOverWhen', defaultMessage: "{when, select, now {Hand it over to a new conversation: click for Hand Over to…, and choose the agent itself.} other {It can hand over to a new conversation when it has finished: not while it works, merges or is on a card loop's card.}}", description: "What to do about a long transcript, in its hover (pane footer): now (the agent is idle: \"Hand Over to…\" is the agent menu's item, use its translation); other (it is working, merging or on a card loop's card)." })
}
