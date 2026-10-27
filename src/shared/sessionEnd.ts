/**
 * Why and when an agent's session ended (HI-1881): what its pane, header and tile say while it is stopped ("Stopped ·
 * 20:46 · stopped by you"). Presentation only, never an agent state: worked out in main as its CLI exits, from the cause
 * the caller that stopped it gave, and sent with `session-exit`.
 */

/** Who or what asked a session to stop, as its caller knows it; `stopped` when the caller doesn't say. */
export type StopCause = 'you' | 'assistant' | 'agent' | 'lane' | 'closed' | 'stopped'

/** Why a session ended, as shown: a stop's cause, Hive quitting, or its CLI ending by itself (cleanly or not). */
export type EndWhy = StopCause | 'quit' | 'exited' | 'crashed'

/** An ended run, as the window keeps it: the run, when it started (ordering only) and ended, why, and a crash's code. */
export interface SessionEnd {
  runId: string
  startedAt: string
  at: string
  why: EndWhy
  code?: number
}

/**
 * Why a run ended, or null for a launch that failed (it keeps its own failed presentation). Hive shutting down comes
 * first, then a stop asked for, by its cause (none: `stopped`), then the CLI's own exit: 0 is `exited`, any
 * other code `crashed`. A stop is never "by you" unless its caller said so.
 */
export function endReason(o: { failed: boolean; shuttingDown: boolean; stopRequested: boolean; cause?: StopCause; code: number }): EndWhy | null {
  if (o.failed) return null
  if (o.shuttingDown) return 'quit'
  // A cause only while a stop is asked for: one left from a stop called off never names a later exit.
  if (o.stopRequested) return o.cause ?? 'stopped'
  return o.code === 0 ? 'exited' : 'crashed'
}

/**
 * The end kept for an agent once another arrives: the new one, unless it is an older run's (its run started before the
 * kept one's) or the same run's again. Runs are told apart by id; start times only order different runs.
 */
export function newerEnd(kept: SessionEnd | undefined, next: SessionEnd): SessionEnd {
  if (!kept) return next
  if (kept.runId === next.runId) return kept
  return next.startedAt < kept.startedAt ? kept : next
}
