// HI-2754: a stall's agent whose latest turn was stopped by its provider's safety filter, said beside the stall's own
// reason. On 8 Nov OpenAI's filter stopped CB2's turn on CL-133 and the lane's stall said only "CB2 only watches CL-133",
// which the Assistant took for the usual wait. The reason stays (the stall's cause as found, for the agent it is about:
// cardStallCause); this adds the fact, for that agent only, while it is idle with its latest turn stopped
// (SafeguardNote.latest, cleared by its next prompt). Agent-facing English (the Agent API's `stalled`, lane watches).

import { agentMsg, say } from './agentText'
import { providerName } from './providers'
import { safeguardTime, type SafeguardNote } from './safeguards'
import type { ProviderId } from './types'

const T = {
  stopped: agentMsg({
    id: 'stall.safeguard.stopped',
    text: "{agent}'s latest turn was stopped by {provider}'s safety filter at {time} ({stops, plural, one {# stop} other {# stops}} this session). Look at its pane before nudging it, and tell the user.",
    note: "HI-2754: said after a stall's reason when the agent it is about is idle and its latest turn was stopped by its CLI's safety filter. agent: its name; provider: the coding agent's name (Codex); time: \"18:54\"; stops: how many this launch."
  })
}

/** A stall's cause (cardStallCause): its reason, and the agent it is about as it is live in the card's project, if any. */
export interface StallCause {
  why: string
  agent?: StallCauseAgent
}

export interface StallCauseAgent {
  name: string
  status: string
  provider?: ProviderId
  safeguard?: SafeguardNote
}

/** The statuses with no turn going: the agent is idle (watching too). */
const IDLE = ['ready', 'finished', 'watching']

/**
 * Whether the cause's agent is idle with its latest turn stopped by a safety filter (HI-2754): its note's `latest` (a
 * stop no older than its latest prompt; a newer prompt clears it, so a turn since never counts), and no turn going now.
 */
export function stoppedIdle(a: StallCauseAgent | undefined): a is StallCauseAgent & { safeguard: SafeguardNote & { latest: { at: string } } } {
  return !!a?.safeguard?.latest && IDLE.includes(a.status)
}

/**
 * The safeguard of a stall's cause as the user's lane notice says it (HI-2754), carried with the stall from where it was
 * found to the notice's dispatch: the agent's name, its provider (id), the latest turn's stop (ISO) and the stops this session.
 */
export interface StallSafeguard {
  agent: string
  provider: ProviderId | null
  at: string
  stops: number
}

/** The cause's agent's stop, for the notice (stoppedIdle), else undefined. */
export function stallSafeguardOf(a: StallCauseAgent | undefined): StallSafeguard | undefined {
  return stoppedIdle(a) ? { agent: a.name, provider: a.provider ?? null, at: a.safeguard.latest.at, stops: a.safeguard.stops } : undefined
}

/** The sentence said after the stall's reason for such an agent (stoppedIdle), else null. Agent-facing English. */
export function safeguardContext(a: StallCauseAgent | undefined): string | null {
  if (!stoppedIdle(a)) return null
  return say(T.stopped, { agent: a.name, provider: providerName(a.provider ?? null), time: safeguardTime(a.safeguard.latest.at), stops: a.safeguard.stops })
}
