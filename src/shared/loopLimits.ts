// Card loops' limits and defaults (#412, #1382), kept apart so the workflow options (HI-1766: rounds, wait and the design
// check wait are workflow options) and lanes.ts share them without importing each other.

/** At most this many cards in a lane, rounds per card, and minutes of wait (a day, as a card watch's longest). */
export const LANE_MAX_CARDS = 50
export const LANE_MAX_ROUNDS = 50
export const LANE_MAX_WAIT_MINUTES = 24 * 60

/** Card loops' rounds and wait when nothing says otherwise (#412: Darren's Rounds 10, Wait 6h). */
export const LOOP_ROUNDS = 10
export const LOOP_WAIT_HOURS = 6
/** The wait settings' range, in hours (a lane's wait is at most a day). */
export const LOOP_WAIT_MAX_HOURS = LANE_MAX_WAIT_MINUTES / 60

/**
 * How long a card loop's builder waits for its reviewer's check of a design it posted before it goes ahead as posted, and
 * a step left waiting longer is a stall (#1382), in minutes.
 */
export const LOOP_STEP_WAIT_MINUTES = 30
export const LOOP_STEP_WAIT_MAX_MINUTES = 240
