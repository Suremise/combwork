import type { PlanLimit, UsageMoveLimit } from './types'
import { limitDue, ruleLimits } from './usageMoves'

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

const LIMIT_TEXT = { weekly: 'its weekly limit', fiveHour: 'its 5-hour limit', any: 'either limit' } as const

/** What a usage watch waits for, for its label: "Anthropic-1 at 98% of its weekly limit". */
export const usageWatchLabel = (u: readonly UsageWatch[]): string => u.map((x) => `${x.name} at ${x.percent}% of ${LIMIT_TEXT[x.limit]}`).join(', ')

/** A watched account's limits that reached its share now (in their current period), as a hit tells them. */
export function usageHits(u: readonly UsageWatch[], limitsOf: (account: string) => readonly PlanLimit[] | undefined, now: number): string[] {
  const out: string[] = []
  for (const x of u) {
    const due = ruleLimits(x, limitsOf(x.account) ?? []).filter((l) => limitDue(l, x.percent, now))
    if (due.length) out.push(`${x.name}: ${due.map((l) => `${l.label} ${Math.round(l.usedPercent * 10) / 10}% (resets ${new Date(l.resetsAt!).toISOString().slice(0, 16)}Z)`).join(', ')}`)
  }
  return out
}

/** The line a usage watch's hit types. */
export const usageWakeLine = (hits: readonly string[]): string => `[Hive] Usage reached: ${hits.join('; ')}. Your watch has ended: carry on (hive_connection list for every account's usage).`

/** The line typed when its limit passes first. */
export const usageLimitLine = (u: readonly UsageWatch[], minutes: number): string => `[Hive] No account reached its share in ${minutes} minutes (${usageWatchLabel(u)}). Your watch has ended: watch again if you still need to.`

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
