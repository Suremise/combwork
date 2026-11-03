import type { DeliverySender, DeliveryState } from '../shared/deliveries'
import { createDelivery, cancelDeliveries, deliveryNow, offerNow, roundNow, TooManyWaiting, waitingCount } from './deliveries'
import { sessions } from './sessions'

/**
 * Messages left for an agent (#530: hive_message_agent), now deliveries (#647, deliveries.ts): a re-brief for the work it
 * is on, saved in its workspace's database (#1018: its project's deliveries) and given by the delivery service like everything else (#650): a
 * busy agent is told of it at its next tool call or before its turn ends, an idle or watching one by the doorbell (a
 * watching agent is woken by it, and its watch carries on), each as the carrying-on switches leave on (#1432; all off,
 * it waits in its inbox until read or the user's Deliver Now), and it reads it with hive_inbox, labelled with its sender,
 * then acks it. On 10 Oct the user pasted about ten of the Assistant's messages into agents' panes because
 * hive_prompt_agent refused every agent of a running card loop; a message goes in whatever the agent is doing.
 *
 * Its sender's permission is worked out again at every step, until the agent reads it: one no longer allowed is refused.
 * At most MAX_QUEUED waiting per agent, each at most MESSAGE_MAX_CHARS. They survive the agent's stops and Hive's
 * restarts; the Assistant's are refused once the launch that left them has ended (#645). One tied to a card's round
 * (`card`, #652) is stale, never given, once that card has moved on: passed, out of Doing and Review, or in a new round.
 */

export const MESSAGE_MAX_CHARS = 4000
export const MAX_QUEUED = 5

/** What became of a message by the time leaveMessage returns: typed (offered or received), queued, or an end. */
export type MessageFate = 'typed' | 'queued' | 'cancelled' | 'refused' | 'expired' | 'stale'

const fateOf = (s: DeliveryState): MessageFate => (s === 'offered' || s === 'received' || s === 'acked' ? 'typed' : s === 'queued' || s === 'uncertain' ? 'queued' : s === 'cancelled' || s === 'refused' || s === 'stale' ? s : 'expired')

/**
 * Leaves a message for a running agent (from: its sender, whose name the line gives). Offered now when it can be, else
 * queued. `card`: tied to that card's round under way (#652), stale once the card has moved on. What became of it by the
 * time this returns, with its id (and the round it is tied to); refused (an Error) when it isn't running, the text is
 * empty or too long, the card isn't in Doing or Review, its sender may not send it, or MAX_QUEUED are already waiting.
 */
export async function leaveMessage(projectPath: string, agentId: string, agentName: string, from: DeliverySender, text: string, card?: number): Promise<{ id: string; fate: MessageFate; queued: number; detail?: string; round?: number }> {
  const st = sessions.liveFor(projectPath, agentId)
  if (!st) throw new Error(`${agentName} isn't running.`)
  const t = text.trim()
  if (!t) throw new Error('text is required')
  if (t.length > MESSAGE_MAX_CHARS) throw new Error(`A message is at most ${MESSAGE_MAX_CHARS} characters (this one has ${t.length}).`)
  const round = card ? await roundNow(projectPath, card) : undefined
  const r = await createDelivery(projectPath, { agentId, agentName, conversation: st.sessionId || null, kind: 'rebrief', from, ...(card ? { card, round } : {}), body: t, maxWaiting: MAX_QUEUED }).catch((e) => {
    if (e instanceof TooManyWaiting) throw new Error(`${agentName} already has ${MAX_QUEUED} messages waiting, the most Hive keeps for an agent: wait until they are delivered (hive_agent_activity), or cancel them.`)
    throw e
  })
  await offerNow(projectPath, agentId)
  const now = deliveryNow(projectPath, r.id) ?? r
  return { id: r.id, fate: fateOf(now.state), queued: waitingCount(projectPath, agentId, 'rebrief'), ...(now.detail && fateOf(now.state) !== 'typed' ? { detail: now.detail } : {}), ...(round ? { round } : {}) }
}

/** Cancels an agent's messages waiting (by: who cancelled). How many there were. */
// `commit`: a revocable caller's check (HI-2420, the Assistant's guard), made in the deliveries' transaction (cancelDeliveries).
export const cancelMessages = (projectPath: string, agentId: string, by: string, commit?: () => void): Promise<number> => cancelDeliveries(projectPath, agentId, by, ['rebrief'], undefined, commit)

/** Deliver Now (#1432): what waits for the agent, every kind, offered once as the user asks, whatever Wake an idle agent says. Whether its line was typed. */
export const deliverWaiting = (projectPath: string, agentId: string): Promise<boolean> => offerNow(projectPath, agentId, undefined, true)
