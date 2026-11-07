import type { AppSettings, DayUsage, SessionUsage, UsageTokens } from './types'
import { estimateCost, usesOwnPrices } from './prices'

/**
 * Usage by day, so the Overview's periods count what happened in them: a session that runs over several days
 * puts each day's tokens, prompts and cost on that day. Days are local calendar days (YYYY-MM-DD in this
 * computer's time zone): "Today" is since midnight, "7 days" is today and the six days before.
 */

/** A timestamp's local calendar day, as YYYY-MM-DD; '' for a missing or invalid one. */
export function localDay(t: string | number | Date | null | undefined): string {
  if (t === null || t === undefined || t === '') return ''
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The local day `n` days after (or before, when negative) a given time's day. */
export function dayOffset(from: number, n: number): string {
  const d = new Date(from)
  d.setDate(d.getDate() + n)
  return localDay(d)
}

export function emptyDay(): DayUsage {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requests: 0, prompts: 0, compactions: 0, costUsd: null, costEstimated: false }
}

export function addTokens(to: UsageTokens, t: Partial<UsageTokens>): void {
  to.inputTokens += t.inputTokens ?? 0
  to.outputTokens += t.outputTokens ?? 0
  to.cacheWriteTokens += t.cacheWriteTokens ?? 0
  to.cacheReadTokens += t.cacheReadTokens ?? 0
}

const tokenCount = (t: UsageTokens): number => t.inputTokens + t.outputTokens + t.cacheWriteTokens + t.cacheReadTokens

/**
 * Works out each day's API-equivalent cost and removes the parser's cost reports from the usage. A provider that
 * reports its cost now and then (Claude Code) has each report's increase shared between the days its requests
 * ran on, in proportion to Combwork's estimate for them (or their tokens, without a price), so the days add up to
 * the reported total; tokens after the last report get Combwork's estimate. Otherwise each day is Combwork's estimate.
 */
export function withDayCosts(usage: SessionUsage, settings?: Pick<AppSettings, 'providers'> | null): SessionUsage {
  const days = usage.days ?? {}
  const estimate = (t: UsageTokens): number | null => estimateCost({ provider: usage.provider, model: usage.model, ...t }, settings)
  const reports = usage.costReports
  if (!reports?.length) {
    for (const d of Object.values(days)) {
      d.costUsd = estimate(d)
      d.costEstimated = d.costUsd !== null
    }
  } else {
    const covered: Record<string, UsageTokens> = {}
    for (const day of Object.keys(days)) {
      covered[day] = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
      days[day].costUsd = 0
      days[day].costEstimated = false
    }
    for (const r of reports) {
      const entries = Object.entries(r.days).filter(([day]) => days[day])
      const weights = entries.map(([, t]) => estimate(t) ?? 0)
      const byTokens = weights.every((w) => w === 0)
      const total = byTokens ? entries.reduce((n, [, t]) => n + tokenCount(t), 0) : weights.reduce((a, b) => a + b, 0)
      entries.forEach(([day, t], i) => {
        addTokens(covered[day], t)
        if (total > 0) days[day].costUsd! += r.costUsd * ((byTokens ? tokenCount(t) : weights[i]) / total)
      })
    }
    // What came after the last report: Combwork's estimate.
    for (const [day, d] of Object.entries(days)) {
      const c = covered[day]
      const rest = { inputTokens: d.inputTokens - c.inputTokens, outputTokens: d.outputTokens - c.outputTokens, cacheWriteTokens: d.cacheWriteTokens - c.cacheWriteTokens, cacheReadTokens: d.cacheReadTokens - c.cacheReadTokens }
      if (tokenCount(rest) <= 0) continue
      const est = estimate(rest)
      if (est) {
        d.costUsd! += est
        d.costEstimated = true
      }
    }
  }
  delete usage.costReports
  return usage
}

/**
 * A session's usage without the CLI's own cost reports (HI-1772: a session that ran on a server connection, whose CLI
 * prices the server's model as a Claude model): priced then by Combwork's estimate from its real model id alone, unpriced
 * where Combwork has no price for it.
 */
export function withoutCostReports<T extends SessionUsage>(raw: T): T {
  const t = raw.timeline
  if (raw.costUsd === null && !raw.costReports && !raw.costUnreported && !t?.reports.length) return raw
  const out = { ...raw, costUsd: null, costEstimated: false }
  delete out.costReports
  delete out.costUnreported
  // Its timeline's charges too (the usage history's rows are made from them): every row then priced by its model.
  if (t) out.timeline = { ...t, reports: [], rows: t.rows.map((r) => (r[6] >= 0 ? (Object.assign([...r], { 6: -1 }) as typeof r) : r)) }
  return out
}

/**
 * A free session's usage (HI-1772: it ran only on servers on this PC): a known $0, its days too, whatever prices are set;
 * its tokens as they are.
 */
export function withCostFree<T extends SessionUsage>(raw: T): T {
  const out = { ...withoutCostReports(raw), costUsd: 0, costEstimated: false, costFree: true as const }
  if (out.days) out.days = Object.fromEntries(Object.entries(out.days).map(([d, u]) => [d, { ...u, costUsd: 0, costEstimated: false }]))
  return out
}

/**
 * A session's usage with costs from the current prices: the provider's report, else (or on top, for what came after
 * it) Combwork's estimate; or, when the user chose their own prices over the report (usesOwnPrices, #436), Combwork's estimate
 * alone wherever it has a price. Then each day's share (withDayCosts).
 */
export function priceUsage(raw: SessionUsage, settings?: Pick<AppSettings, 'providers'> | null): SessionUsage {
  const usage = structuredClone(raw)
  const mine = usesOwnPrices(usage.provider, settings) ? estimateCost(usage, settings) : null
  if (mine !== null) {
    Object.assign(usage, { costUsd: mine, costEstimated: true })
    // Each day is then priced the same way, not shared out from the reports.
    delete usage.costReports
  } else if (usage.costUsd === null) {
    // Providers that don't report a cost get Combwork's estimate from their token counts (prices: Settings → provider).
    const est = estimateCost(usage, settings)
    if (est !== null) Object.assign(usage, { costUsd: est, costEstimated: true })
  } else if (usage.costUnreported) {
    // The provider reports its cost only now and then: the tokens since get Combwork's estimate on top.
    const est = estimateCost({ ...usage, ...usage.costUnreported }, settings)
    if (est) Object.assign(usage, { costUsd: usage.costUsd + est, costEstimated: true })
  }
  return withDayCosts(usage, settings)
}

/** A session's usage from a day on (null: all of it), and whether it was active then at all. */
export function usageFrom(usage: SessionUsage, fromDay: string | null): (UsageTokens & { requests: number; prompts: number; compactions: number; costUsd: number | null; costEstimated: boolean; costUnpriced?: true; active: boolean }) {
  if (!fromDay || !usage.days) {
    const active = !fromDay || localDay(usage.lastActivity) >= fromDay
    return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheWriteTokens: usage.cacheWriteTokens, cacheReadTokens: usage.cacheReadTokens, requests: usage.requests, prompts: usage.userMessages, compactions: usage.compactions.length, costUsd: usage.costUsd, costEstimated: usage.costEstimated, ...(usage.costUnpriced && usage.costUsd !== null ? { costUnpriced: true as const } : {}), active }
  }
  const out: DayUsage & { active: boolean } = { ...emptyDay(), costUsd: 0, active: false }
  let priced = false
  // Tokens in the period with no price (HI-2675): a day without one, or one priced only in part.
  let unpriced = false
  for (const [day, d] of Object.entries(usage.days)) {
    if (day < fromDay) continue
    out.active = true
    addTokens(out, d)
    out.requests += d.requests
    out.prompts += d.prompts
    out.compactions += d.compactions
    if (d.costUsd !== null) {
      priced = true
      out.costUsd! += d.costUsd
      if (d.costEstimated) out.costEstimated = true
      if (d.costUnpriced) unpriced = true
    } else if (tokenCount(d) > 0) unpriced = true
  }
  if (!priced && tokenCount(out) > 0) out.costUsd = null
  else if (unpriced && out.costUsd !== null) out.costUnpriced = true
  return out
}
