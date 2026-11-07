import type { Account, Connection, PlanLimit, PlanUsage, UsageMoveLimit, UsageMoveRecord, UsageMoveRule } from './types'
import { cleanTag, connectionsOn, sameTag } from './accounts'

/**
 * Usage moves (HI-2195, SPEC §11.2): an account's rule moves its agents to another account's connections when one of its
 * limits reaches a share. What is decided here is pure (main's usageMoves.ts reads and writes): which limits a rule
 * watches, when one is due, the period's record, the connection an agent moves to, and why a target can't take them.
 */

const WEEK_MINUTES = 7 * 24 * 60
const FIVE_HOURS = 5 * 60

/** The limit kind a rule can watch, from its window: the weekly one, the 5-hour one, else none. */
export function limitKind(l: Pick<PlanLimit, 'windowMinutes'>): Exclude<UsageMoveLimit, 'any'> | null {
  return l.windowMinutes === WEEK_MINUTES ? 'weekly' : l.windowMinutes === FIVE_HOURS ? 'fiveHour' : null
}

/** The limits a rule watches: of its kind, or (`any`) the weekly and 5-hour ones, each on its own. */
export function ruleLimits<L extends Pick<PlanLimit, 'windowMinutes'>>(rule: Pick<UsageMoveRule, 'limit'>, limits: readonly L[]): L[] {
  return limits.filter((l) => {
    const k = limitKind(l)
    return !!k && (rule.limit === 'any' || rule.limit === k)
  })
}

/**
 * Whether a limit's reading reaches a share in its current period: only a reading whose reset is still ahead counts (an
 * expired one, or one with no reset time to tell its period by, never does).
 */
export function limitDue(l: Pick<PlanLimit, 'usedPercent' | 'resetsAt' | 'unlimited'>, percent: number, now: number): boolean {
  // Unlimited (HI-2734): never due.
  return !l.unlimited && !!l.resetsAt && Date.parse(l.resetsAt) > now && l.usedPercent >= percent
}

/** Reset times wobble by seconds between reports; a new period moves them by hours (planUsage.ts reads them the same). */
export function samePeriod(a: string | null, b: string | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return Math.abs(Date.parse(a) - Date.parse(b)) < 30 * 60 * 1000
}

/** The record for a limit's period: the one kept when it is the same period, else a new one, firing with `rule`. */
export function periodRecord(kept: UsageMoveRecord | undefined, l: Pick<PlanLimit, 'resetsAt'>, rule: UsageMoveRule, firing: string): UsageMoveRecord {
  if (kept && samePeriod(kept.resetsAt, l.resetsAt)) return kept
  return { resetsAt: l.resetsAt!, firing, rule: { ...rule }, handled: {} }
}

/** Whether a rule is the one a record fired with (HR1: a rule changed since drops what that firing queued). */
export const sameRule = (a: UsageMoveRule | undefined, b: UsageMoveRule | undefined): boolean => !!a && !!b && a.percent === b.percent && a.limit === b.limit && a.to === b.to

/** Which rule matched an agent's connection on the target (HI-2530), said in the move's notice. */
export type MatchedBy = 'tag' | 'name' | 'default'

/**
 * The connection an agent moves to (HI-2530): the first on the target account with the same tag as the one it is on
 * (any case and spacing; an untagged connection skips this), else the same name (any case), else the target's first
 * connection, its default. Undefined only when the target has none.
 */
export function matchConnection(from: Pick<Connection, 'name' | 'tag'>, target: string, connections: readonly Connection[]): { connection: Connection; by: MatchedBy } | undefined {
  const on = connectionsOn(target, connections)
  const byTag = cleanTag(from.tag) ? on.find((c) => sameTag(c.tag, from.tag)) : undefined
  if (byTag) return { connection: byTag, by: 'tag' }
  const key = from.name.trim().toLowerCase()
  const byName = on.find((c) => c.name.trim().toLowerCase() === key)
  if (byName) return { connection: byName, by: 'name' }
  return on[0] ? { connection: on[0], by: 'default' } : undefined
}

/** Why a usage move's target can't take an account's agents anywhere (an account off in one workspace is that workspace's). */
export type UsageMoveProblem = 'missing' | 'signedOut' | 'noConnections' | 'full' | 'off' | 'failed'

/**
 * Why the target can't take the agents now, or null: removed or another CLI's, signed out, without connections, or
 * (HR1: no bouncing between full accounts) already at the rule's share of a limit it watches.
 */
export function targetProblem(source: Pick<Account, 'provider'>, rule: UsageMoveRule, accounts: readonly Account[], connections: readonly Connection[], targetUsage: Pick<PlanUsage, 'limits'> | undefined, now: number): UsageMoveProblem | null {
  const t = accounts.find((a) => a.id === rule.to)
  if (!t || t.provider !== source.provider) return 'missing'
  if (t.kind !== 'server' && t.observed?.loggedIn === false) return 'signedOut'
  if (!connectionsOn(t.id, connections).length) return 'noConnections'
  if (ruleLimits(rule, targetUsage?.limits ?? []).some((l) => limitDue(l, rule.percent, now))) return 'full'
  return null
}

/**
 * Whether a rule moved this agent off `account` in a period that hasn't reset: then no rule moves it back onto it (HR1's
 * guard against reciprocal rules; a manual return is the user's).
 */
export function movedOffWithinPeriod(key: string, account: string, records: Record<string, Record<string, UsageMoveRecord>> | undefined, now: number): boolean {
  return Object.values(records?.[account] ?? {}).some((r) => r.handled[key] === 'moved' && Date.parse(r.resetsAt) > now)
}

/** The records whose period hasn't reset (the others say nothing any more). */
export function liveRecords(records: Record<string, Record<string, UsageMoveRecord>> | undefined, now: number): Record<string, Record<string, UsageMoveRecord>> {
  const out: Record<string, Record<string, UsageMoveRecord>> = {}
  for (const [acc, byLimit] of Object.entries(records ?? {})) {
    const kept = Object.fromEntries(Object.entries(byLimit).filter(([, r]) => Date.parse(r.resetsAt) > now))
    if (Object.keys(kept).length) out[acc] = kept
  }
  return out
}

/** Failed writes an agent gets per period before it is given up on (and noticed once). */
export const USAGE_MOVE_TRIES = 3
