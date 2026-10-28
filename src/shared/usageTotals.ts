import { fmt, msg, tr } from './i18n'
import type { SessionListItem } from './types'
import { dayOffset, localDay, usageFrom } from './usageDays'

/**
 * Totals for a period, shared by the project Overview, the Assistant's summary and the Workspace Overview, so they
 * all count the same way: by calendar day, each session only for what it did in the period.
 */

export type Period = 'today' | 'week' | 'month' | 'all'
const M = {
  today: msg({ id: 'project.period.today', defaultMessage: 'Today', description: 'A period of the usage figures (Overview tabs, the Assistant).' }),
  week: msg({ id: 'project.period.week', defaultMessage: '{days, plural, one {# day} other {# days}}', description: 'A period of the usage figures: the last seven days ({days} is 7), today included.' }),
  month: msg({ id: 'project.period.month', defaultMessage: '{days, plural, one {# day} other {# days}}', description: 'A period of the usage figures: the last thirty days ({days} is 30), today included.' }),
  all: msg({ id: 'project.period.all', defaultMessage: 'All time', description: 'A period of the usage figures: everything recorded.' }),
  unknown: msg({ id: 'project.cost.unknown', defaultMessage: 'Unknown', description: 'A cost Hive cannot work out: no price is known for the model.' }),
  belowCent: msg({ id: 'project.cost.belowCent', defaultMessage: '< {cent}', description: 'A cost under one cent. {cent} is one cent in dollars, such as "$0.01".' }),
  other: msg({ id: 'project.chart.other', defaultMessage: 'Other ({count})', description: 'In the usage chart by project: the projects not shown on their own. {count} is how many.' }),
  withFree: msg({ id: 'project.cost.withFree', defaultMessage: '{cost} + free (local)', description: 'A total cost ("$1.20") that also covers sessions run only on a model server on this PC (Ollama, for example), which cost nothing (HI-1772).' })
}

/** A cost of sessions run only on servers on this PC (HI-1772, Darren 27 Oct): free, its tokens counted. */
export const FREE_LOCAL = msg({ id: 'project.cost.freeLocal', defaultMessage: 'free (local)', description: 'The cost of sessions run only on a model server on this PC (Ollama, for example): nothing (HI-1772). Lower case, short: it stands where a cost such as "$1.20" would.' })

/** How many calendar days the week and month periods take, today included. */
const PERIOD_DAYS = { week: 7, month: 30 }

/** The periods, with their labels in the window's language when read (a getter: each render reads it again). */
export const PERIODS: { value: Period; readonly label: string }[] = [
  { value: 'today', get label() { return tr(M.today) } },
  { value: 'week', get label() { return tr(M.week, { days: PERIOD_DAYS.week }) } },
  { value: 'month', get label() { return tr(M.month, { days: PERIOD_DAYS.month }) } },
  { value: 'all', get label() { return tr(M.all) } }
]

/** A period's first local day (calendar days: "7 days" is today and the six before); null for all time. */
export function periodFrom(p: Period, now: number): string | null {
  if (p === 'all') return null
  return dayOffset(now, p === 'today' ? 0 : 1 - PERIOD_DAYS[p])
}

/** Sessions with activity in a period (on or after its first day). */
export function activeIn(list: SessionListItem[], fromDay: string | null): SessionListItem[] {
  if (!fromDay) return list
  return list.filter((s) => (s.usage ? usageFrom(s.usage, fromDay).active : localDay(s.lastActivity ?? s.lastActiveAt) >= fromDay))
}

export interface Totals {
  sessions: number
  prompts: number
  compactions: number
  input: number
  cached: number
  cacheWrite: number
  output: number
  cost: number
  /** Some of the cost is Hive's estimate. */
  estimated: boolean
  /** Sessions with a cost (reported or estimated). */
  priced: number
  /** Sessions with no cost at all (no price known for their model). */
  unpriced: number
  /** Sessions run only on servers on this PC (HI-1772): free, neither priced nor unpriced. */
  free?: number
}

/**
 * A total cost as the window shows it: "≈ $1.20" when every session in it has a cost, "≈ $1.20 + ?" when some have none (a known
 * subtotal, incomplete), "Unknown" when none has: sessions Hive couldn't price never count as $0.
 */
export function costText(t: { cost: number; estimated: boolean; priced: number; unpriced: number; free?: number }, label: (n: number) => string = moneyLabel): string {
  // Only free sessions (HI-1772): free (local); free ones beside others: said after the others' cost.
  if (t.free && !t.priced && !t.unpriced) return tr(FREE_LOCAL)
  if (t.free) return tr(M.withFree, { cost: costText({ ...t, free: 0 }, label) })
  if (t.unpriced && !t.priced) return tr(M.unknown)
  // Non-breaking spaces: "≈ $1.00 + ?" is one value, never split over lines (#241).
  return `${t.estimated ? '≈ ' : ''}${label(t.cost)}${t.unpriced ? ' + ?' : ''}`
}

/**
 * Dollars as the window shows them, in its language (Intl): "$1.20", "1,20 USD"; whole dollars from $100; under a
 * cent, "< $0.01". money() is the same in fixed English, for what agents read (card costs in the Agent API).
 */
export function moneyLabel(n: number): string {
  if (n >= 100) return fmt.number(n, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  if (n > 0 && n < 0.01) return tr(M.belowCent, { cent: fmt.usd(0.01) })
  return fmt.usd(n)
}

/** The unit moneyLabel shows an amount in: a cent, or a dollar from $100. */
export const moneyUnit = (n: number): number => (n >= 100 ? 1 : 0.01)

// Rounding as moneyLabel's currency formatting rounds (Intl's, on the amount's decimal form: $2.405 is $2.41), whatever
// the window's language: only the digits are read back.
const CENTS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })
const DOLLARS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0, useGrouping: false })

/** An amount in whole moneyUnits, as moneyLabel rounds it (HI-1906: a table whose total must match the card's line). */
export function moneyUnits(n: number): number {
  return n >= 100 ? Number(DOLLARS.format(n)) : Math.round(Number(CENTS.format(n)) * 100)
}

/**
 * A number of `unit`s (moneyUnit's) as the window shows money, always in that unit's precision, so amounts shown together
 * add up as shown (HI-1906: a table of parts); none of them, for an amount that isn't nothing, "< $0.01" (or "< $1").
 */
export function unitMoneyLabel(units: number, unit: number, exact: number): string {
  const label = (n: number): string => (unit >= 1 ? fmt.number(n, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : fmt.usd(n))
  if (units === 0 && exact > 0) return tr(M.belowCent, { cent: label(unit) })
  return label(units * unit)
}

/** Every token counted: new input, cache writes, input read from cache, and output. */
export const totalTokens = (t: Totals): number => t.input + t.cached + t.cacheWrite + t.output

/** What sessions used, all of it or from a day on (only what happened then, a day at a time). */
export function sumUsage(list: SessionListItem[], fromDay: string | null = null): Totals {
  const t: Totals = { sessions: 0, prompts: 0, compactions: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, cost: 0, estimated: false, priced: 0, unpriced: 0, free: 0 }
  for (const s of activeIn(list, fromDay)) {
    t.sessions++
    if (!s.usage) continue
    const u = usageFrom(s.usage, fromDay)
    t.prompts += u.prompts
    t.compactions += u.compactions
    t.input += u.inputTokens
    t.cached += u.cacheReadTokens
    t.cacheWrite += u.cacheWriteTokens
    t.output += u.outputTokens
    // Free (HI-1772): neither priced nor unpriced; its tokens counted above.
    if (s.usage.costFree) t.free = (t.free ?? 0) + 1
    else if (u.costUsd === null) t.unpriced++
    else {
      t.priced++
      t.cost += u.costUsd
      if (u.costEstimated) t.estimated = true
    }
  }
  return t
}

export interface DayTotal {
  day: string
  tokens: number
  cost: number
  estimated: boolean
  /** Sessions that used something that day with a cost, and without one (see costText). */
  priced: number
  unpriced: number
  /** Sessions run only on servers on this PC that day (HI-1772): free. */
  free?: number
  prompts: number
}

/** The days from `fromDay` to today, each empty. */
function emptyDays(fromDay: string, now: number): DayTotal[] {
  const out: DayTotal[] = []
  for (let i = 0; ; i++) {
    const day = dayOffset(Date.parse(`${fromDay}T12:00:00`), i)
    if (day > localDay(now)) break
    out.push({ day, tokens: 0, cost: 0, estimated: false, priced: 0, unpriced: 0, prompts: 0 })
  }
  return out
}

/** Each day's tokens, cost and prompts across sessions, from `fromDay` to today (days without use included). */
export function dailyTotals(list: SessionListItem[], fromDay: string, now: number): DayTotal[] {
  const out = emptyDays(fromDay, now)
  const byDay = new Map(out.map((d) => [d.day, d]))
  for (const s of list) {
    for (const [day, d] of Object.entries(s.usage?.days ?? {})) {
      const o = byDay.get(day)
      if (!o) continue
      o.tokens += d.inputTokens + d.outputTokens + d.cacheWriteTokens + d.cacheReadTokens
      o.prompts += d.prompts
      // Free (HI-1772): neither priced nor unpriced.
      if (s.usage?.costFree) o.free = (o.free ?? 0) + 1
      else if (d.costUsd !== null) {
        o.cost += d.costUsd
        o.priced++
      } else o.unpriced++
      if (d.costEstimated) o.estimated = true
    }
  }
  return out
}

/** A group of sessions for a stacked chart: a project, or the Assistant. */
export interface UsageGroup {
  key: string
  label: string
  items: SessionListItem[]
}

/**
 * Each day's totals split by group, for a chart stacked by project. The `top` groups that used the most tokens in
 * the period keep their own series, the rest add up to "Other". Series are in name order, so a group keeps its
 * place (and colour) while the set of top groups stays the same.
 */
export function stackedDaily(groups: UsageGroup[], fromDay: string, now: number, top = 6): { series: { key: string; label: string }[]; days: (DayTotal & { parts: number[] })[] } {
  const perGroup = groups.map((g) => ({ g, days: dailyTotals(g.items, fromDay, now) }))
  const sum = (days: DayTotal[]): number => days.reduce((n, d) => n + d.tokens, 0)
  const used = perGroup.filter((x) => sum(x.days) > 0).sort((a, b) => sum(b.days) - sum(a.days))
  const kept = used.slice(0, top).sort((a, b) => a.g.label.localeCompare(b.g.label))
  const rest = used.slice(top)
  const series = kept.map((x) => ({ key: x.g.key, label: x.g.label }))
  if (rest.length) series.push({ key: '', label: tr(M.other, { count: rest.length }) })
  const days = emptyDays(fromDay, now).map((d, i) => {
    const parts = kept.map((x) => x.days[i].tokens)
    if (rest.length) parts.push(rest.reduce((n, x) => n + x.days[i].tokens, 0))
    const all = perGroup.map((x) => x.days[i])
    return {
      ...d,
      tokens: parts.reduce((a, b) => a + b, 0),
      cost: all.reduce((n, x) => n + x.cost, 0),
      estimated: all.some((x) => x.estimated),
      priced: all.reduce((n, x) => n + x.priced, 0),
      unpriced: all.reduce((n, x) => n + x.unpriced, 0),
      prompts: all.reduce((n, x) => n + x.prompts, 0),
      parts
    }
  })
  return { series, days }
}

/** A dollar amount: "$12.34", "$140", "< $0.01". */
export const money = (n: number): string => (n >= 100 ? `$${Math.round(n)}` : n > 0 && n < 0.01 ? '< $0.01' : `$${n.toFixed(2)}`)
