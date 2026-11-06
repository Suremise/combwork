import type { PlanLimit, UsageMoveLimit } from './types'
import { limitDue, ruleLimits } from './usageMoves'
import { agentMsg, say } from './agentText'
import { NOTICE_PREFIX } from './doorbell'

/**
 * A usage watch (HI-2195): an agent (the Assistant, mostly) waits for an account's limit to reach a share, alone or beside
 * the cards or lanes it watches, and is woken once it has. What it reads is agent-facing English.
 */
export interface UsageWatch {
  /** The account's id, and its name as the watch began (for the lines). */
  account: string
  name: string
  percent: number
  limit: UsageMoveLimit
}

/** At most this many accounts in one watch. */
export const USAGE_WATCH_MAX = 10

const T = {
  label: agentMsg({ id: 'wake.usage.label', text: '{name} at {percent}% of {limit, select, weekly {its weekly limit} fiveHour {its 5-hour limit} other {either limit}}', note: 'What a usage watch waits for (HI-2195), in its label and lines: an account (name), the share (percent) and which of its limits (limit: weekly, fiveHour or any).' }),
  hit: agentMsg({ id: 'wake.usage.hit', text: '{limit} {percent}% (resets {resets})', note: 'A usage watch wake: a limit that reached its share. limit: its name ("Weekly"); percent: how much is used; resets: when, UTC ("2026-11-03T10:00Z").' }),
  reached: agentMsg({ id: 'wake.usage.reached', text: "Usage reached: {hits}. Your watch has ended: carry on (cw_connection list for every account's usage).", note: 'Typed when a usage watch fires (HI-2195). hits: each account and the limits that reached their share ("Anthropic-1: Weekly 98% (resets …)"), "; " between.' }),
  limit: agentMsg({ id: 'wake.usage.limit', text: 'No account reached its share in {minutes} minutes ({watching}). Your watch has ended: watch again if you still need to.', note: "Typed when a usage watch's limit passes first. minutes: its limit; watching: what it waited for (its label)." })
}

/** What a usage watch waits for, for its label: "Anthropic-1 at 98% of its weekly limit". */
export const usageWatchLabel = (u: readonly UsageWatch[]): string => u.map((x) => say(T.label, { name: x.name, percent: String(x.percent), limit: x.limit })).join(', ')

/** A watched account's limits that reached its share now (in their current period), as a hit tells them. */
export function usageHits(u: readonly UsageWatch[], limitsOf: (account: string) => readonly PlanLimit[] | undefined, now: number): string[] {
  const out: string[] = []
  for (const x of u) {
    const due = ruleLimits(x, limitsOf(x.account) ?? []).filter((l) => limitDue(l, x.percent, now))
    if (due.length) out.push(`${x.name}: ${due.map((l) => say(T.hit, { limit: l.label, percent: String(Math.round(l.usedPercent * 10) / 10), resets: `${new Date(l.resetsAt!).toISOString().slice(0, 16)}Z` })).join(', ')}`)
  }
  return out
}

/** The line a usage watch's hit types. */
export const usageWakeLine = (hits: readonly string[]): string => NOTICE_PREFIX + say(T.reached, { hits: hits.join('; ') })

/** The line typed when its limit passes first. */
export const usageLimitLine = (u: readonly UsageWatch[], minutes: number): string => NOTICE_PREFIX + say(T.limit, { minutes: String(minutes), watching: usageWatchLabel(u) })

/** A usage watch as watches.json kept it, or null. */
export function readSavedUsage(v: unknown): UsageWatch[] | null {
  if (!Array.isArray(v) || !v.length || v.length > USAGE_WATCH_MAX) return null
  const out: UsageWatch[] = []
  for (const x of v as Record<string, unknown>[]) {
    if (!x || typeof x !== 'object' || typeof x.account !== 'string' || x.account.length > 64 || typeof x.name !== 'string' || x.name.length > 300) return null
    if (typeof x.percent !== 'number' || !Number.isInteger(x.percent) || x.percent < 1 || x.percent > 100 || !['weekly', 'fiveHour', 'any'].includes(x.limit as string)) return null
    out.push({ account: x.account, name: x.name, percent: x.percent, limit: x.limit as UsageMoveLimit })
  }
  return out
}
