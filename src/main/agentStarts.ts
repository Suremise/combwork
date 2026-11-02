import { resolve } from 'path'

/**
 * Starts of agents under way, and the last one that failed (HI-1976), for the stall check: an agent whose start is in
 * progress (a Start giving it its card, its slot being prepared and its builder placed there) is starting, not stalled,
 * and one whose start failed is stalled with the reason. A leaf: taskStart.ts, slotCards.ts and sessions.ts write it,
 * cardStall.ts reads it, and nothing here brings those in.
 *
 * Each start holds the agent under a tag (`#<card>`: the Start and its card's placement share it, so the placement takes
 * the Start's hold over). A hold counts for at most START_HOLD_MS, so one never ended (a placement that never came)
 * can't hide a stall for good.
 */

/** How long a start's hold keeps its agent from being stalled, at most. */
export const START_HOLD_MS = 10 * 60_000

interface Entry {
  /** Each start under way, by tag: when it began. */
  holds: Map<string, number>
  /**
   * Why its last start failed, and what recorded it (`by`: a start's tag, or `cli` for its CLI exiting before its session
   * started). Cleared only as a new attempt begins (a new Start, a new launch of its session), and by a start's success
   * only where that start recorded it itself: a completion never clears a CLI's failure, which may land while a placement
   * or a launch is still finishing (HR6's rounds 1 and 2).
   */
  failed?: { why: string; by: string }
  /** Why a start under way waits (HI-2304: its slot held by what a run left there), and whose: until it goes on or ends. */
  waiting?: { why: string; by: string }
}

const entries = new Map<string, Entry>()

/** Told of each change to an agent's start (HI-1977: the window's agent info carries it, and is told at once). */
const listeners = new Set<(projectPath: string, agentId: string) => void>()

/** Calls `fn` with the agent of each change to its start, and of a hold running out. Returns its removal. */
export function onAgentStartChange(fn: (projectPath: string, agentId: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Counts the changes (HR6's round 1): what a project's info read carries, so the window keeps a change told after it. */
let seq = 0

/** The count of changes so far: a read of the starts made now has every change up to it. */
export function startSeq(): number {
  return seq
}

function changed(projectPath: string, agentId: string): void {
  seq++
  for (const fn of listeners) fn(projectPath, agentId)
}

const keyOf = (projectPath: string, agentId: string): string => `${resolve(projectPath).toLowerCase()}|${agentId}`

function entryOf(projectPath: string, agentId: string): Entry {
  const key = keyOf(projectPath, agentId)
  let e = entries.get(key)
  if (!e) entries.set(key, (e = { holds: new Map() }))
  return e
}

/** Forgets an entry with nothing in it. */
function tidy(projectPath: string, agentId: string): void {
  const key = keyOf(projectPath, agentId)
  const e = entries.get(key)
  if (e && !e.holds.size && !e.failed && !e.waiting) entries.delete(key)
}

/** A start of the agent begins (or goes on) under `tag`. `fresh`: a new Start, whose agent's earlier failure is over. */
export function startBegun(projectPath: string, agentId: string, tag: string, o: { fresh?: boolean } = {}): void {
  const e = entryOf(projectPath, agentId)
  e.holds.set(tag, Date.now())
  if (o.fresh) e.failed = undefined
  changed(projectPath, agentId)
  // A hold never ended stops counting after START_HOLD_MS: the window is told then too.
  if (listeners.size) setTimeout(() => changed(projectPath, agentId), START_HOLD_MS + 1000).unref?.()
}

/**
 * The start under `tag` has ended: `ok`, its agent given its work (a failure of its own earlier tries over, never another's);
 * `failed`, why it couldn't start.
 */
export function startEnded(projectPath: string, agentId: string, tag: string, outcome?: { ok: true } | { failed: string }): void {
  const e = entries.get(keyOf(projectPath, agentId))
  if (!e && !(outcome && 'failed' in outcome)) return
  const entry = e ?? entryOf(projectPath, agentId)
  entry.holds.delete(tag)
  if (entry.waiting?.by === tag) entry.waiting = undefined
  if (outcome && 'failed' in outcome) entry.failed = { why: oneLine(outcome.failed), by: tag }
  else if (outcome && entry.failed?.by === tag) entry.failed = undefined
  tidy(projectPath, agentId)
  changed(projectPath, agentId)
}

/**
 * The start under `tag` waits (HI-2304), for `why` (English: what holds its slot), or goes on (null). Told only on a
 * change, so a placement looking again with the same reason tells nothing.
 */
export function startWaits(projectPath: string, agentId: string, tag: string, why: string | null): void {
  const e = why === null ? entries.get(keyOf(projectPath, agentId)) : entryOf(projectPath, agentId)
  if (!e) return
  if (why === null) {
    if (e.waiting?.by !== tag) return
    e.waiting = undefined
    tidy(projectPath, agentId)
  } else {
    if (e.waiting?.by === tag && e.waiting.why === why) return
    e.waiting = { why: oneLine(why), by: tag }
  }
  changed(projectPath, agentId)
}

/** The agent's CLI exited before its session started (sessions.ts): its start failed, for this reason. */
export function startFailed(projectPath: string, agentId: string, why: string): void {
  entryOf(projectPath, agentId).failed = { why: oneLine(why), by: 'cli' }
  changed(projectPath, agentId)
}

/**
 * A session of the agent is being started (sessions.ts, before its launch runs): an earlier failure is over. Never once
 * the start settles: its CLI may have exited meanwhile, a failure that stands.
 */
export function startBegins(projectPath: string, agentId: string): void {
  const e = entries.get(keyOf(projectPath, agentId))
  if (!e?.failed) return
  e.failed = undefined
  tidy(projectPath, agentId)
  changed(projectPath, agentId)
}

/** The agent's start as the stall check reads it: failed (why), else starting (a hold not older than START_HOLD_MS). */
export function startNow(projectPath: string, agentId: string, now = Date.now()): { starting: boolean; failed: string | null; waiting: string | null } {
  const e = entries.get(keyOf(projectPath, agentId))
  if (!e) return { starting: false, failed: null, waiting: null }
  if (e.failed) return { starting: false, failed: e.failed.why, waiting: null }
  return { starting: [...e.holds.values()].some((at) => now - at < START_HOLD_MS), failed: null, waiting: e.waiting?.why ?? null }
}

/** A CLI's error lines as one line, for a stall's reason. */
const oneLine = (why: string): string => why.replace(/\s*\n\s*/g, ' | ').trim()

/** Tests: everything forgotten. */
export function resetAgentStartsForTests(): void {
  entries.clear()
}
