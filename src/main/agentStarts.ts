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
  /** Why its last start failed: kept until a start of it succeeds, or a new Start begins. */
  failed?: string
}

const entries = new Map<string, Entry>()
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
  if (e && !e.holds.size && !e.failed) entries.delete(key)
}

/** A start of the agent begins (or goes on) under `tag`. `fresh`: a new Start, whose agent's earlier failure is over. */
export function startBegun(projectPath: string, agentId: string, tag: string, o: { fresh?: boolean } = {}): void {
  const e = entryOf(projectPath, agentId)
  e.holds.set(tag, Date.now())
  if (o.fresh) e.failed = undefined
}

/** The start under `tag` has ended: `ok`, its agent given its work (an earlier failure over); `failed`, why it couldn't start. */
export function startEnded(projectPath: string, agentId: string, tag: string, outcome?: { ok: true } | { failed: string }): void {
  const e = entries.get(keyOf(projectPath, agentId))
  if (!e && !(outcome && 'failed' in outcome)) return
  const entry = e ?? entryOf(projectPath, agentId)
  entry.holds.delete(tag)
  if (outcome && 'failed' in outcome) entry.failed = oneLine(outcome.failed)
  else if (outcome) entry.failed = undefined
  tidy(projectPath, agentId)
}

/** The agent's CLI exited before its session started (sessions.ts): its start failed, for this reason. */
export function startFailed(projectPath: string, agentId: string, why: string): void {
  entryOf(projectPath, agentId).failed = oneLine(why)
}

/** A session of the agent started: an earlier failure is over. */
export function startSucceeded(projectPath: string, agentId: string): void {
  const e = entries.get(keyOf(projectPath, agentId))
  if (!e) return
  e.failed = undefined
  tidy(projectPath, agentId)
}

/** The agent's start as the stall check reads it: failed (why), else starting (a hold not older than START_HOLD_MS). */
export function startNow(projectPath: string, agentId: string, now = Date.now()): { starting: boolean; failed: string | null } {
  const e = entries.get(keyOf(projectPath, agentId))
  if (!e) return { starting: false, failed: null }
  if (e.failed) return { starting: false, failed: e.failed }
  return { starting: [...e.holds.values()].some((at) => now - at < START_HOLD_MS), failed: null }
}

/** A CLI's error lines as one line, for a stall's reason. */
const oneLine = (why: string): string => why.replace(/\s*\n\s*/g, ' | ').trim()

/** Tests: everything forgotten. */
export function resetAgentStartsForTests(): void {
  entries.clear()
}
