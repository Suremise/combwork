// The merge queue's logs (HI-1924): a target's latest pauses, and its merges' pushes (G18), kept in the board's meta
// (board_meta, as the owed push is) for the Progress panel's Recent merges. Each is written in the same write as the
// state it records (a pause saved or lifted, a merge owed its push, a push settled), and read with the queue's model;
// with how long the queue took over an entry, from its card's facts.

import { CW_RUNS } from '../progress'
import type { Fact, FactData } from '../../shared/workflow/facts'
import { QUEUE_LOG_MAX, type QueuePauseLogged } from '../../shared/workflow/queue'

export const pauseLogKey = (target: string): string => `queue.pauseLog:${target}`
/** The merges owed a push and not settled yet, oldest first: never trimmed (they drain as pushes settle). */
export const pushPendingKey = (target: string): string => `queue.pushPending:${target}`
/** The settled pushes, newest first, at most QUEUE_LOG_MAX: the panel's only. */
export const pushLogKey = (target: string): string => `queue.pushLog:${target}`
/**
 * HI-3177: when a past branch's queue history was purged (an ISO time): its outcomes and requests at or before it are no
 * longer the queue's (its cards keep their own facts), so the target isn't listed until a request after it.
 */
export const purgedKey = (target: string): string => `queue.purged:${target}`

/** A merge owed its push: its entry and the target's commit it made. */
export interface PushPending {
  entry: string
  result: string
}

/** A merge's push settled: pushed, or not (pushing turned off, the target no longer had it). */
export interface PushSettled {
  entry: string
  state: 'pushed' | 'off' | 'reset'
  at: string
}

/** A JSON list, each item kept only when `ok` (an unreadable value is an empty list). */
function listOf<T>(value: string | null, ok: (x: Record<string, unknown>) => boolean): T[] {
  if (!value) return []
  try {
    const v = JSON.parse(value) as unknown
    return Array.isArray(v) ? (v.filter((x) => !!x && typeof x === 'object' && ok(x as Record<string, unknown>)) as T[]) : []
  } catch {
    return []
  }
}

const str = (x: unknown): x is string => typeof x === 'string'

/** A target's pause log, newest first. */
export const pauseLogOf = (value: string | null): QueuePauseLogged[] => listOf(value, (x) => str(x.reason) && str(x.card) && str(x.at))

/**
 * The pause log after a pause is saved (`pause`) or lifted (null), `before` the pause the target had: lifted or replaced
 * by another, the open one ends now; saved again as it was (Resume finding its cause still there), it carries on.
 */
export function pauseLogged(log: QueuePauseLogged[], before: { reason: string; card: string } | null, pause: Omit<QueuePauseLogged, 'ended'> | null, now: string): QueuePauseLogged[] {
  if (pause && before && before.reason === pause.reason && before.card === pause.card) return log
  const ended = log.map((p, i) => (i === 0 && !p.ended ? { ...p, ended: now } : p))
  return (pause ? [pause, ...ended] : ended).slice(0, QUEUE_LOG_MAX)
}

export const pushPendingOf = (value: string | null): PushPending[] => listOf(value, (x) => str(x.entry) && str(x.result))
export const pushLogOf = (value: string | null): PushSettled[] => listOf(value, (x) => str(x.entry) && str(x.at) && (x.state === 'pushed' || x.state === 'off' || x.state === 'reset'))

/** The push log with these settled (newest first), bounded. */
export const pushesSettled = (log: PushSettled[], settled: PushSettled[]): PushSettled[] => [...[...settled].reverse(), ...log].slice(0, QUEUE_LOG_MAX)

/** The fact that ended an entry: merged, returned or cancelled. */
function endOf(facts: Fact[], entry: string): Fact | undefined {
  return facts.find((f) => (f.kind === 'Integrated' || f.kind === 'IntegrationFailed' || f.kind === 'IntegrationCancelled') && (f.data as { entry?: string }).entry === entry)
}

/**
 * How long the queue took over an entry, from its card's facts: from the start of its first merge check (a `CheckRan`
 * of the queue's naming the entry) to its outcome; with no check, from its merge's start (`IntegrationStarted`: no merge
 * checks). Facts from before checks named their entry: the queue's checks between the entry's own request and its
 * outcome, only when no other entry of the card was open meanwhile (another target's, say). Null: it ended before
 * anything began for it (a conflict at the test merge, a cancel), or nothing says.
 */
export function entryTook(facts: Fact[], entry: string): number | null {
  const end = endOf(facts, entry)
  const req = facts.find((f) => f.kind === 'IntegrationRequested' && (f.data as FactData['IntegrationRequested']).entry === entry)
  if (!end || !req) return null
  const queueCheck = (f: Fact): f is Fact<'CheckRan'> => f.kind === 'CheckRan' && (f.data as FactData['CheckRan']).by === CW_RUNS
  let checks = facts.filter(queueCheck).filter((f) => f.data.entry === entry)
  if (!checks.length) {
    const overlaps = facts.some((o) => o.kind === 'IntegrationRequested' && o !== req && o.seq < end.seq && (endOf(facts, (o.data as FactData['IntegrationRequested']).entry)?.seq ?? Infinity) > req.seq)
    checks = overlaps ? [] : facts.filter(queueCheck).filter((f) => !f.data.entry && f.seq > req.seq && f.seq < end.seq)
  }
  const starts = checks.map((c) => Date.parse(c.at) - c.data.durationMs)
  const merge = facts.find((f) => f.kind === 'IntegrationStarted' && (f.data as FactData['IntegrationStarted']).entry === entry)
  const start = starts.length ? Math.min(...starts) : merge ? Date.parse(merge.at) : NaN
  const took = Date.parse(end.at) - start
  return Number.isFinite(took) && took >= 0 ? took : null
}
