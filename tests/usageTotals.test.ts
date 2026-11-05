// Period totals shared by the project Overview and the Workspace Overview, and the chart stacked by project.
import { describe, expect, it } from 'vitest'
import type { DayUsage, SessionListItem } from '../src/shared/types'
import { emptyDay } from '../src/shared/usageDays'
import { costText, dailyTotals, periodFrom, stackedDaily, sumUsage, totalTokens } from '../src/shared/usageTotals'

const NOW = Date.parse('2026-10-01T15:00:00')

/** A session with `tokens` input tokens on each of the given days. */
function session(days: Record<string, number>, provider: 'claude-code' | 'codex' = 'claude-code'): SessionListItem {
  const byDay: Record<string, DayUsage> = {}
  for (const [day, n] of Object.entries(days)) byDay[day] = { ...emptyDay(), inputTokens: n, prompts: 1, costUsd: n / 1000, costEstimated: true }
  const total = Object.values(days).reduce((a, b) => a + b, 0)
  const last = Object.keys(days).sort().at(-1)!
  return {
    id: `s-${Math.random()}`,
    provider,
    source: 'hive',
    title: null,
    lastActivity: `${last}T12:00:00.000Z`,
    hasTranscript: true,
    hasBackup: false,
    recache: null,
    usage: {
      provider,
      sessionId: 'x',
      title: null,
      model: null,
      cliVersion: null,
      inputTokens: total,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      requests: 1,
      reasoningTokens: 0,
      contextTokens: 0,
      contextWindow: null,
      compactions: [],
      cacheTtlSeconds: 300,
      firstActivity: null,
      lastActivity: `${last}T12:00:00.000Z`,
      userMessages: Object.keys(days).length,
      lastPrompt: null,
      costUsd: total / 1000,
      costEstimated: true,
      days: byDay
    }
  }
}

describe('free sessions (HI-1772, Darren 27 Oct)', () => {
  /** A session run only on a server on this PC: a known $0, marked free. */
  const free = (days: Record<string, number>): SessionListItem => {
    const s = session(days)
    for (const d of Object.values(s.usage!.days!)) Object.assign(d, { costUsd: 0, costEstimated: false })
    Object.assign(s.usage!, { costUsd: 0, costEstimated: false, costFree: true })
    return s
  }
  it('only free: free (local); beside priced ones: their cost, + free (local); tokens counted either way', () => {
    const all = periodFrom('all', NOW)
    const only = sumUsage([free({ '2026-10-01': 1000 })], all)
    expect(only).toMatchObject({ free: 1, priced: 0, unpriced: 0, input: 1000 })
    expect(costText(only)).toBe('free (local)')
    const mixed = sumUsage([free({ '2026-10-01': 1000 }), session({ '2026-10-01': 2000 })], all)
    expect(costText(mixed)).toBe('≈ $2.00 + free (local)')
    const [day] = dailyTotals([free({ '2026-10-01': 1000 })], '2026-10-01', NOW)
    expect(costText(day)).toBe('free (local)')
  })
})

describe('period totals', () => {
  it('counts only the days in the period', () => {
    const s = session({ '2026-09-20': 500, '2026-09-30': 200, '2026-10-01': 100 })
    expect(totalTokens(sumUsage([s], periodFrom('week', NOW)))).toBe(300)
    expect(totalTokens(sumUsage([s], periodFrom('today', NOW)))).toBe(100)
    expect(totalTokens(sumUsage([s], periodFrom('all', NOW)))).toBe(800)
    expect(sumUsage([session({ '2026-09-01': 5 })], periodFrom('week', NOW)).sessions).toBe(0)
  })

  it("never shows sessions without a price as $0: Unknown when none has one, a subtotal + ? when some don't", () => {
    /** A session Combwork had no price for (its model unknown): no cost, in total or on its days. */
    const unpriced = (days: Record<string, number>): SessionListItem => {
      const s = session(days, 'codex')
      for (const d of Object.values(s.usage!.days!)) Object.assign(d, { costUsd: null, costEstimated: false })
      Object.assign(s.usage!, { costUsd: null, costEstimated: false })
      return s
    }
    const all = periodFrom('all', NOW)
    // All priced: the cost, estimated.
    const priced = sumUsage([session({ '2026-10-01': 1000 }), session({ '2026-10-01': 2000 })], all)
    expect(priced).toMatchObject({ priced: 2, unpriced: 0 })
    expect(costText(priced)).toBe('≈ $3.00')
    // None priced: unknown, not $0.00.
    const none = sumUsage([unpriced({ '2026-10-01': 1000 })], all)
    expect(none).toMatchObject({ priced: 0, unpriced: 1, cost: 0 })
    expect(costText(none)).toBe('Unknown')
    // Mixed: the known subtotal, marked incomplete.
    const mixed = sumUsage([session({ '2026-10-01': 1000 }), unpriced({ '2026-10-01': 1000 })], all)
    expect(costText(mixed)).toBe('≈ $1.00 + ?')
    // Nothing at all is still $0.00 (the views show — for no sessions).
    expect(costText(sumUsage([], all))).toBe('$0.00')
    // The same by day, and in the chart stacked by project.
    const [day] = dailyTotals([unpriced({ '2026-10-01': 1000 })], '2026-10-01', NOW)
    expect(costText(day)).toBe('Unknown')
    const stacked = stackedDaily([{ key: 'a', label: 'a', items: [session({ '2026-10-01': 1000 })] }, { key: 'b', label: 'b', items: [unpriced({ '2026-10-01': 500 })] }], '2026-10-01', NOW)
    expect(costText(stacked.days[0])).toBe('≈ $1.00 + ?')
  })
})

describe('chart stacked by project', () => {
  const groups = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta', 'theta'].map((name, i) => ({ key: name, label: name, items: [session({ '2026-09-30': (i + 1) * 100, '2026-10-01': 10 })] }))

  it('keeps the six biggest in name order and adds up the rest as Other', () => {
    const { series, days } = stackedDaily(groups, periodFrom('week', NOW)!, NOW)
    // The two smallest (alpha 100, beta 200) go to Other.
    expect(series.map((s) => s.label)).toEqual(['delta', 'eps', 'eta', 'gamma', 'theta', 'zeta', 'Other (2)'])
    expect(days).toHaveLength(7)
    const sep30 = days.find((d) => d.day === '2026-09-30')!
    expect(sep30.parts.at(-1)).toBe(300)
    expect(sep30.tokens).toBe(groups.reduce((n, _, i) => n + (i + 1) * 100, 0))
    expect(days.find((d) => d.day === '2026-10-01')!.prompts).toBe(8)
  })

  it('leaves out groups with nothing in the period, and needs no Other for six or fewer', () => {
    const few = [...groups.slice(0, 3), { key: 'idle', label: 'idle', items: [session({ '2026-08-01': 999 })] }]
    const { series } = stackedDaily(few, periodFrom('week', NOW)!, NOW)
    expect(series.map((s) => s.key)).toEqual(['alpha', 'beta', 'gamma'])
  })
})
