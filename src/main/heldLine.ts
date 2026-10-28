import type { SessionStatus } from '../shared/types'

/**
 * A line Hive typed that its CLI didn't take (#430), gone from its input since (HI-1959): Claude Code 2.1.312's offer to
 * teach auto mode about the environment came up as HB4's wake was typed, took the line, and left the input empty, while
 * Hive held the agent for a line no longer there. One look at the agent and its screen. Pure, so it is unit tested.
 */
export interface HeldLook {
  /** The CLI's own question shows (its idle question): the input is under it, unread. */
  asked: boolean
  /** What its ordinary input holds, dim hints left out ('' empty); null when none is drawn (a dialog, a redraw, a blank screen). */
  input: string | null
  status: SessionStatus
  /** Its CLI has taken a prompt since the line was marked, or one of the deliveries it rang for was read. */
  takenSince: boolean
}

/** The statuses of an agent at its prompt, between turns. */
const AT_PROMPT: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['ready', 'finished', 'background', 'watching'])

/**
 * Whether this look says the held line is lost: at its prompt (no question, no turn), its ordinary input drawn and empty,
 * nothing taken since. Anything else is no sign: a dialog or a redraw (no input drawn), the line or the user's own text
 * still in the input (theirs is never cleared or typed over), a turn begun, a prompt or delivery taken. One look is never
 * enough: Hive acts only when a second, a while later, says the same with nothing between (SessionManager).
 */
export function heldLineLost(look: HeldLook): boolean {
  return !look.asked && !look.takenSince && AT_PROMPT.has(look.status) && look.input === ''
}
