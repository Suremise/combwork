import type { AppSettings, DayUsage, ProviderId, SessionUsage, TaskCard, TaskHold, UsageTokens } from './types'
import { estimateCost, usesOwnPrices } from './prices'
import { localDay } from './usageDays'
import { TOKENS_SPREAD, TOKENS_UNKNOWN, chargeShares, rowModel, type UsageRow, type UsageTimeline } from './usageTimeline'
import { emptyPart, holdsFromHistory, mergeSpans, sharedSpans, type CostPart, type Span } from './cardCosts'

/**
 * Usage history (#1106, Darren's decisions of 19 Oct): what each session used, recorded once as it happens and only ever
 * added to, so the Overview and every usage view read it rather than the CLIs' transcripts. A session's **rows**, one per
 * local day, model and card it worked on (and its role on it): tokens by kind, requests, prompts, compactions, and the
 * part of the cost known as an amount (the provider's charges, split between the requests they cover) with the tokens it
 * covers; the rest is priced when shown, with the prices of the time, so a price change needs nothing more. A card's
 * rows are its share of the session's use while the session's agent held it (TaskCard.held; shared equally while it held
 * several, ≈); the rest of the day is card 0. Pure: the usage worker makes rows from a parser's result, main prices them.
 */

/** A row's role: on a card (`build`, `review`), on none (''), or what a day's baseline adds (`kept`: counted before, applyBaseline). */
export type LedgerRole = '' | 'build' | 'review' | 'kept'

export interface LedgerRow {
  day: string
  model: string
  /** The card it was used on (0: none). */
  card: number
  role: LedgerRole
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  requests: number
  prompts: number
  compactions: number
  /** The cost known as an amount: the provider's charges' share, or a kept usage's cost as it was priced when kept. */
  fixedUsd: number
  /** That amount is Combwork's estimate (a kept usage's estimate). */
  fixedEstimated: boolean
  /** The tokens `fixedUsd` covers: the rest get Combwork's estimate when priced. */
  covered: UsageTokens
  /** Requests whose tokens aren't known yet (Copilot's, until its launch exits). */
  tokensUnknown: number
  /** Its tokens are Combwork's share of a total (spread over requests; a part of a step, a card held with others): ≈. */
  shared: boolean
}

/** One card an agent held while its session ran, in a role: its spans, each with how many cards it held then (k: shared 1/k). */
export interface SessionHold {
  card: number
  role: 'build' | 'review'
  parts: [k: number, spans: Span[]][]
}

const ZERO = (): UsageTokens => ({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 })
const KINDS = ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens'] as const
const rowTokens = (r: UsageRow): UsageTokens => ({ inputTokens: r[1], outputTokens: r[2], cacheWriteTokens: r[3], cacheReadTokens: r[4] })
const tokenSum = (t: UsageTokens): number => t.inputTokens + t.outputTokens + t.cacheWriteTokens + t.cacheReadTokens

export const emptyRow = (day: string, model: string, card = 0, role: LedgerRole = ''): LedgerRow => ({ day, model, card, role, ...ZERO(), requests: 0, prompts: 0, compactions: 0, fixedUsd: 0, fixedEstimated: false, covered: ZERO(), tokensUnknown: 0, shared: false })

/** How much of [a, b) spans cover, in ms. */
function overlap(spans: Span[], a: number, b: number): number {
  let n = 0
  for (const [c, d] of spans) {
    if (d <= a) continue
    if (c >= b) break
    n += Math.min(b, d) - Math.max(a, c)
  }
  return n
}

const rowKey = (day: string, model: string, card: number, role: LedgerRole): string => `${day}|${model}|${card}|${role}`

/**
 * A session's rows from its parser's result (before costs: `days`, `costReports` and `timeline` as the parser gives
 * them) and the cards its agent held. Each day's totals are the parser's, split between the models its requests ran on
 * and the cards its agent held then in the proportions the timeline shows for that day (a timeline row's part on a card:
 * how much of it the card's holds cover, shared 1/k while it held k cards); what the day's timeline doesn't account for
 * goes to card 0 on the day's main model, with its prompts and compactions, so a day's rows always add up to the day, in
 * whole tokens and requests. A charge's share stays with the rows it covers.
 */
export function ledgerRows(raw: SessionUsage, holds: SessionHold[], settings?: Pick<AppSettings, 'providers'> | null): LedgerRow[] {
  const fallback = raw.model ?? ''
  const t = raw.timeline
  const modelAt = (r: UsageRow): string => (t ? rowModel(t, r, raw.model) : raw.model) ?? ''
  const est = (model: string, tk: UsageTokens): number | null => estimateCost({ provider: raw.provider, model: model || null, ...tk }, settings)
  // The timeline's rows by day, then model, card and role: fractions of tokens, requests, charges and what they cover.
  const parts = new Map<string, Map<string, LedgerRow>>()
  const part = (day: string, model: string, card: number, role: LedgerRole): LedgerRow => {
    let m = parts.get(day)
    if (!m) parts.set(day, (m = new Map()))
    const k = rowKey(day, model, card, role)
    let r = m.get(k)
    if (!r) m.set(k, (r = emptyRow(day, model, card, role)))
    return r
  }
  if (t?.rows.length) {
    const shares = chargeShares(t, (r) => est(modelAt(r), rowTokens(r)))
    const step = t.step * 1000
    t.rows.forEach((r, i) => {
      const day = localDay(r[0] * 1000)
      if (!day) return
      const model = modelAt(r)
      const on: [number, LedgerRole, number][] = []
      let held = 0
      for (const h of holds) {
        let w = 0
        for (const [k, spans] of h.parts) w += overlap(spans, r[0] * 1000, r[0] * 1000 + step) / step / k
        if (w <= 0) continue
        on.push([h.card, h.role, w])
        held += w
      }
      // Never more than all of it (holds of one agent share each moment, so they don't add up past 1 but for rounding).
      const scale = held > 1 ? 1 / held : 1
      on.push([0, '', Math.max(0, 1 - held * scale)])
      for (const [card, role, w0] of on) {
        const w = card ? w0 * scale : w0
        if (w <= 0) continue
        const p = part(day, model, card, role)
        if (r[7] & TOKENS_UNKNOWN) p.tokensUnknown += r[5] * w
        else for (const k of KINDS) p[k] += rowTokens(r)[k] * w
        p.requests += r[5] * w
        if (r[6] >= 0) {
          p.fixedUsd += shares[i] * w
          for (const k of KINDS) p.covered[k] += rowTokens(r)[k] * w
        }
        if ((card && w < 1) || r[7] & TOKENS_SPREAD) p.shared = true
      }
    })
  }
  const out: LedgerRow[] = []
  const days = new Set([...Object.keys(raw.days ?? {}), ...parts.keys()])
  for (const day of days) {
    if (!day) continue
    const d = raw.days?.[day]
    const rows = [...(parts.get(day)?.values() ?? [])]
    // The day's main model: the one it used most (else the session's), whose card 0 takes what is left.
    const used = new Map<string, number>()
    for (const r of rows) used.set(r.model, (used.get(r.model) ?? 0) + tokenSum(r) + r.requests)
    const mainModel = [...used].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback
    let main = rows.find((r) => r.model === mainModel && r.card === 0)
    if (!main) rows.push((main = emptyRow(day, mainModel)))
    if (d) {
      // The parser's day, in the timeline's proportions (per kind of token, and for requests).
      const total = (f: (r: LedgerRow) => number): number => rows.reduce((n, r) => n + f(r), 0)
      for (const k of KINDS) {
        const tk = total((r) => r[k])
        for (const r of rows) {
          const share = tk > 0 ? r[k] / tk : 0
          r.covered[k] = tk > 0 ? Math.min(d[k], d[k] * (r.covered[k] / tk)) : 0
          r[k] = d[k] * share
        }
      }
      const tq = total((r) => r.requests)
      for (const r of rows) r.requests = tq > 0 ? d.requests * (r.requests / tq) : 0
    }
    // Whole numbers that add up to the day (round 2 of #1106: rounding each row on its own counted a shared request
    // twice): each kind shared out by largest remainder, what no row has (a kind the day's timeline didn't show) on main.
    const at = rows.indexOf(main)
    for (const k of KINDS) {
      const whole = wholeShares(rows.map((r) => r[k]), d ? d[k] : Math.round(rows.reduce((n, r) => n + r[k], 0)), at)
      const covered = wholeShares(rows.map((r) => r.covered[k]), Math.round(rows.reduce((n, r) => n + r.covered[k], 0)), at)
      rows.forEach((r, i) => {
        r[k] = whole[i]
        r.covered[k] = Math.min(whole[i], covered[i])
      })
    }
    const requests = wholeShares(rows.map((r) => r.requests), d ? d.requests : Math.round(rows.reduce((n, r) => n + r.requests, 0)), at)
    const unknown = wholeShares(rows.map((r) => r.tokensUnknown), Math.round(rows.reduce((n, r) => n + r.tokensUnknown, 0)), at)
    rows.forEach((r, i) => {
      r.requests = requests[i]
      r.tokensUnknown = unknown[i]
    })
    if (d) {
      main.prompts = d.prompts
      main.compactions = d.compactions
    }
    out.push(...rows)
  }
  // No timeline (a result from before #602): each charge shared between the days it covers, by Combwork's estimate (else tokens).
  if (!t?.rows.length && raw.costReports?.length) {
    const byDay = new Map(out.filter((r) => r.card === 0).map((r) => [r.day, r]))
    for (const rep of raw.costReports) {
      const entries = Object.entries(rep.days).filter(([day]) => byDay.has(day))
      const weights = entries.map(([, tk]) => est(fallback, tk) ?? 0)
      const byTokens = weights.every((w) => w === 0)
      const total = byTokens ? entries.reduce((n, [, tk]) => n + tokenSum(tk), 0) : weights.reduce((a, b) => a + b, 0)
      entries.forEach(([day, tk], i) => {
        const r = byDay.get(day)!
        for (const k of KINDS) r.covered[k] = Math.min(r[k], r.covered[k] + tk[k])
        if (total > 0) r.fixedUsd += rep.costUsd * ((byTokens ? tokenSum(tk) : weights[i]) / total)
      })
    }
  }
  return out.filter(hasUse)
}

/**
 * Fractions as whole numbers adding up to `total` (largest remainder: each its whole part, then one more to those with
 * the largest fractions until the total is reached); with nothing to share it out by, all of it to `fallback`.
 */
export function wholeShares(values: number[], total: number, fallback: number): number[] {
  const sum = values.reduce((n, v) => n + Math.max(0, v), 0)
  if (sum <= 0) return values.map((_, i) => (i === fallback ? total : 0))
  const exact = values.map((v) => (Math.max(0, v) * total) / sum)
  const out = exact.map(Math.floor)
  let rest = total - out.reduce((n, v) => n + v, 0)
  const order = exact.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (let j = 0; rest > 0; j = (j + 1) % order.length, rest--) out[order[j][1]]++
  return out
}

/** Whether a row records anything. */
const hasUse = (r: LedgerRow): boolean => tokenSum(r) > 0 || r.requests > 0 || r.prompts > 0 || r.compactions > 0 || r.fixedUsd > 0 || r.tokensUnknown > 0

/**
 * A kept usage's rows (#1106's backfill: a deleted session's, or one whose transcript Clean Up let go): already priced,
 * with no timeline, so each day's cost is kept as it was worked out then (estimated where it was), and a card its agent
 * held while it was active gets an unknown part (`tokensUnknown`, no tokens), never $0.
 */
export function keptRows(usage: SessionUsage, holds: SessionHold[]): LedgerRow[] {
  const model = usage.model ?? ''
  const days: [string, DayUsage][] = usage.days && Object.keys(usage.days).length ? Object.entries(usage.days) : [[localDay(usage.lastActivity ?? usage.firstActivity), { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheWriteTokens: usage.cacheWriteTokens, cacheReadTokens: usage.cacheReadTokens, requests: usage.requests, prompts: usage.userMessages, compactions: usage.compactions.length, costUsd: usage.costUsd, costEstimated: usage.costEstimated }]]
  const out: LedgerRow[] = []
  for (const [day, d] of days) {
    if (!day) continue
    const r = emptyRow(day, model)
    for (const k of KINDS) r[k] = d[k]
    r.requests = d.requests
    r.prompts = d.prompts
    r.compactions = d.compactions
    if (d.costUsd !== null) {
      r.fixedUsd = d.costUsd
      r.fixedEstimated = d.costEstimated
      r.covered = { inputTokens: d.inputTokens, outputTokens: d.outputTokens, cacheWriteTokens: d.cacheWriteTokens, cacheReadTokens: d.cacheReadTokens }
    }
    if (hasUse(r)) out.push(r)
  }
  return [...out, ...unknownOnCards(usage, holds)]
}

/**
 * A usage without a timeline (a kept one) on the cards its agent held while it was active (its first and last activity,
 * with a minute's margin): a row each, its use there unknown (`tokensUnknown`, no tokens), never $0.
 */
export function unknownOnCards(usage: Pick<SessionUsage, 'model' | 'firstActivity' | 'lastActivity'>, holds: SessionHold[]): LedgerRow[] {
  const out: LedgerRow[] = []
  const from = Date.parse(usage.firstActivity ?? usage.lastActivity ?? '')
  const to = Date.parse(usage.lastActivity ?? usage.firstActivity ?? '')
  if (!Number.isFinite(from) || !Number.isFinite(to)) return out
  for (const h of holds) {
    const at = h.parts.flatMap(([, s]) => s).find(([a, b]) => b > from - 60_000 && a < Math.max(to, from + 1) + 60_000)
    if (!at) continue
    const r = emptyRow(localDay(Math.max(at[0], from)), usage.model ?? '', h.card, h.role)
    r.tokensUnknown = 1
    out.push(r)
  }
  return out
}

/**
 * A session's rows shared out again by its cards' holds now (they changed since it was recorded), from what is stored:
 * each day's totals as its rows have them, split by the stored timeline (a kept usage, without one: its days as they
 * are, and its cards' unknown parts again). Its totals never change, only which card each part is on.
 */
export function reshareRows(summary: UsageSummary, timeline: UsageTimeline | null, all: LedgerRow[], holds: SessionHold[], settings?: Pick<AppSettings, 'providers'> | null): LedgerRow[] {
  // Without what a baseline added (`kept` rows), which the caller applies again (sessionRows), coverage included.
  const rows = all.filter((r) => r.role !== 'kept')
  if (!timeline?.rows.length) return [...rows.filter((r) => r.card === 0), ...unknownOnCards(summary, holds)]
  const days: Record<string, DayUsage> = {}
  const usage: SessionUsage = { ...summary, ...ZERO(), requests: 0, costUsd: null, costEstimated: false, days, timeline }
  for (const r of rows) {
    const d = (days[r.day] ??= { ...ZERO(), requests: 0, prompts: 0, compactions: 0, costUsd: null, costEstimated: false })
    for (const k of KINDS) {
      d[k] += r[k]
      usage[k] += r[k]
    }
    d.requests += r.requests
    usage.requests += r.requests
    d.prompts += r.prompts
    d.compactions += r.compactions
  }
  return ledgerRows(usage, holds, settings)
}

/**
 * A session's rows as they are recorded, whichever way they were made (round 6: every write goes through this): its base
 * rows (read from its file by ledgerRows, or shared out again from what is stored by reshareRows, never with `kept`
 * rows) with its baseline applied, charges and the tokens they covered together. So re-sharing cards, importing a kept
 * usage or reading the file again never changes what a session counted or cost, only which card each part is on.
 */
export function sessionRows(base: LedgerRow[], baseline: BaselineDay[], provider: ProviderId, settings?: Pick<AppSettings, 'providers'> | null): LedgerRow[] {
  return applyBaseline(base, baseline, provider, settings)
}

// ---------------------------------------------------------------------------
// What was counted before: a session's baseline.
// ---------------------------------------------------------------------------

/**
 * A day of what was counted for a session before (a kept usage's day, or what its rows had when a later read of its file
 * didn't match them): a session's rows never go below it, in any of these (#1106 round 3: history is only added to, and
 * one snapshot never wins over another by a sum). `costUsd`: its known cost then (null: none).
 */
export interface BaselineDay {
  day: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  requests: number
  prompts: number
  compactions: number
  costUsd: number | null
  costEstimated: boolean
  /**
   * The tokens that cost covers (round 5: a charge and what it paid for are one record, restored together, so the same
   * tokens are never estimated again on top of it).
   */
  covered: UsageTokens
}

/**
 * Rows without the CLI's reported charges (HI-1772: a session that ran on a server connection): their counts kept, each
 * priced by Combwork's estimate from its model when shown. A charge Combwork estimated is kept as it is (it follows the prices).
 */
export function rowsWithoutReports(rows: LedgerRow[]): LedgerRow[] {
  return rows.map((r) => (r.fixedEstimated || (r.fixedUsd === 0 && tokenSum(r.covered) === 0) ? r : { ...r, fixedUsd: 0, fixedEstimated: false, covered: ZERO() }))
}

/**
 * Rows of a free session (HI-1772: it ran only on servers on this PC): each a known $0 charge covering all its tokens,
 * so every cost made from them (the history, card costs, metrics) is $0 known, never unpriced; its counts kept.
 */
export function rowsAsFree(rows: LedgerRow[]): LedgerRow[] {
  return rows.map((r) => ({ ...r, fixedUsd: 0, fixedEstimated: false, covered: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheWriteTokens: r.cacheWriteTokens, cacheReadTokens: r.cacheReadTokens } }))
}

/** A free session's baseline (HI-1772): each day a known $0 covering its tokens. */
export function baselineAsFree(days: BaselineDay[]): BaselineDay[] {
  return days.map((d) => ({ ...d, costUsd: 0, costEstimated: false, covered: { inputTokens: d.inputTokens, outputTokens: d.outputTokens, cacheWriteTokens: d.cacheWriteTokens, cacheReadTokens: d.cacheReadTokens } }))
}

/** A baseline without the CLI's reported charges (HI-1772), its counts kept. */
export function baselineWithoutReports(days: BaselineDay[]): BaselineDay[] {
  return days.map((d) => (d.costEstimated || (d.costUsd === null && tokenSum(d.covered) === 0) ? d : { ...d, costUsd: null, costEstimated: false, covered: ZERO() }))
}

/** What a baseline day holds that rows add up to (cost apart). */
const COUNTS = ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'requests', 'prompts', 'compactions'] as const

/** A kept usage's days as a baseline (its totals on its last day when it has none by day). */
export function baselineOfUsage(usage: SessionUsage): BaselineDay[] {
  const model = usage.model ?? ''
  const days: [string, DayUsage][] = usage.days && Object.keys(usage.days).length ? Object.entries(usage.days) : [[localDay(usage.lastActivity ?? usage.firstActivity), { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheWriteTokens: usage.cacheWriteTokens, cacheReadTokens: usage.cacheReadTokens, requests: usage.requests, prompts: usage.userMessages, compactions: usage.compactions.length, costUsd: usage.costUsd, costEstimated: usage.costEstimated }]]
  return days.filter(([day]) => !!day).map(([day, d]) => ({ day, model, inputTokens: d.inputTokens, outputTokens: d.outputTokens, cacheWriteTokens: d.cacheWriteTokens, cacheReadTokens: d.cacheReadTokens, requests: d.requests, prompts: d.prompts, compactions: d.compactions, costUsd: d.costUsd, costEstimated: d.costEstimated, covered: d.costUsd === null ? ZERO() : { inputTokens: d.inputTokens, outputTokens: d.outputTokens, cacheWriteTokens: d.cacheWriteTokens, cacheReadTokens: d.cacheReadTokens } }))
}

/** What of a row's cost the provider reported (a charge it was given; never Combwork's estimate, which follows the prices). */
const reported = (r: LedgerRow): number => (r.fixedEstimated ? 0 : r.fixedUsd)

/**
 * Rows' days as a baseline: their counts, and the charges the provider reported for them (round 4: a charge once recorded
 * is never erased by a read that lacks its report; estimates aren't kept, they are priced again when shown).
 */
export function baselineOfRows(rows: LedgerRow[]): BaselineDay[] {
  const by = new Map<string, BaselineDay & { most: number }>()
  for (const r of rows) {
    let b = by.get(r.day)
    if (!b) by.set(r.day, (b = { day: r.day, model: r.model, ...ZERO(), requests: 0, prompts: 0, compactions: 0, costUsd: null, costEstimated: false, covered: ZERO(), most: -1 }))
    for (const k of COUNTS) b[k] += r[k]
    if (reported(r) > 0) b.costUsd = (b.costUsd ?? 0) + reported(r)
    // The tokens the reported charges paid for (on the charge's own rows, or rows a restored charge covers).
    if (!r.fixedEstimated) for (const k of KINDS) b.covered[k] += r.covered[k]
    // The day's model: the one with the most tokens.
    if (tokenSum(r) > b.most) {
      b.most = tokenSum(r)
      b.model = r.model
    }
  }
  return [...by.values()].map(({ most: _most, ...b }) => b)
}

/** Two baselines as one: each day the larger of each (its cost too), so neither loses anything it had. */
export function mergeBaselines(a: BaselineDay[], b: BaselineDay[]): BaselineDay[] {
  const by = new Map(a.map((d) => [d.day, { ...d, covered: { ...d.covered } }]))
  for (const d of b) {
    const was = by.get(d.day)
    if (!was) {
      by.set(d.day, { ...d, covered: { ...d.covered } })
      continue
    }
    for (const k of COUNTS) was[k] = Math.max(was[k], d[k])
    // A cost with the tokens it covers: the larger record whole, never one's amount with the other's coverage.
    if (d.costUsd !== null && (was.costUsd === null || d.costUsd > was.costUsd)) {
      was.costUsd = d.costUsd
      was.costEstimated = d.costEstimated
      was.covered = { ...d.covered }
    }
  }
  return [...by.values()].sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0))
}

/**
 * Rows with what a baseline counted that they don't (a `kept` row a day, on card 0): each day, each count the rows have
 * less of, and the known cost they're short of (priced now), so a day never shows less than was counted before. Rows'
 * own `kept` rows (an earlier baseline's) are replaced.
 */
export function applyBaseline(all: LedgerRow[], baseline: BaselineDay[], provider: ProviderId, settings?: Pick<AppSettings, 'providers'> | null): LedgerRow[] {
  // Copies: a restored charge marks tokens of these rows covered.
  const rows = all.filter((r) => r.role !== 'kept').map((r) => ({ ...r, covered: { ...r.covered } }))
  const out = [...rows]
  for (const b of baseline) {
    const day = rows.filter((r) => r.day === b.day)
    const r = emptyRow(b.day, b.model, 0, 'kept')
    for (const k of COUNTS) r[k] = Math.max(0, b[k] - day.reduce((n, x) => n + x[k], 0))
    if (b.costUsd !== null && b.costEstimated) {
      // A kept usage's cost, estimated when it was kept, against what the rows cost now; what they're short of covers
      // the tokens they lack (the rows' own are priced as they are).
      const has = day.reduce((n, x) => n + (rowCost(x, provider, settings).usd ?? 0), 0)
      if (b.costUsd > has) {
        r.fixedUsd = b.costUsd - has
        r.fixedEstimated = true
        r.covered = { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheWriteTokens: r.cacheWriteTokens, cacheReadTokens: r.cacheReadTokens }
      }
    } else if (b.costUsd !== null) {
      // A reported charge and the tokens it paid for, as one record (round 5): what the rows' own reported charges lack of
      // it, with the tokens they lack coverage for. Those are marked covered on the day's rows first (the same tokens,
      // read again without their report: not estimated a second time), the rest on the `kept` row's own tokens; and the
      // amount goes with them (round 7), shared between the rows that took them as any charge is (by Combwork's estimate for
      // the tokens each took, else their number), so a card has the charge for its tokens, never them for free. Only an
      // amount no row's tokens took stays on the `kept` row (card 0).
      const has = day.reduce((n, x) => n + reported(x), 0)
      if (b.costUsd > has) {
        const took = new Map<LedgerRow, UsageTokens>()
        const tookOf = (x: LedgerRow): UsageTokens => {
          let t = took.get(x)
          if (!t) took.set(x, (t = ZERO()))
          return t
        }
        for (const k of KINDS) {
          let need = Math.max(0, b.covered[k] - day.reduce((n, x) => n + (x.fixedEstimated ? 0 : x.covered[k]), 0))
          for (const x of day) {
            if (need <= 0) break
            const free = x[k] - x.covered[k]
            if (free <= 0 || x.fixedEstimated) continue
            const take = Math.min(free, need)
            x.covered[k] += take
            tookOf(x)[k] += take
            need -= take
          }
          r.covered[k] = Math.min(r[k], need)
          if (r.covered[k] > 0) tookOf(r)[k] += r.covered[k]
        }
        const amount = b.costUsd - has
        const takers = [...took.entries()].filter(([, t]) => tokenSum(t) > 0)
        const weights = takers.map(([x, t]) => estimateCost({ provider, model: x.model || null, ...t }, settings) ?? 0)
        const byTokens = weights.every((w) => w === 0)
        const total = byTokens ? takers.reduce((n, [, t]) => n + tokenSum(t), 0) : weights.reduce((n, w) => n + w, 0)
        if (total > 0) takers.forEach(([x, t], i) => (x.fixedUsd += amount * ((byTokens ? tokenSum(t) : weights[i]) / total)))
        else r.fixedUsd = amount
      }
    }
    if (hasUse(r)) out.push(r)
  }
  return out
}

/**
 * Whether rows count at least what other rows did, every day, in each count and in the charges the provider reported
 * (what replacing them would keep).
 */
export function dominates(rows: LedgerRow[], before: LedgerRow[]): boolean {
  type Sums = Record<(typeof COUNTS)[number] | 'reported', number>
  const sums = (list: LedgerRow[]): Map<string, Sums> => {
    const m = new Map<string, Sums>()
    for (const r of list) {
      const s = m.get(r.day) ?? { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requests: 0, prompts: 0, compactions: 0, reported: 0 }
      for (const k of COUNTS) s[k] += r[k]
      s.reported += reported(r)
      m.set(r.day, s)
    }
    return m
  }
  const now = sums(rows)
  for (const [day, s] of sums(before)) {
    const n = now.get(day)
    if (!n || COUNTS.some((k) => n[k] < s[k]) || n.reported < s.reported - 1e-9) return false
  }
  return true
}

/** A row's cost with today's prices: its known amount, and Combwork's estimate for the tokens it doesn't cover (null: none known). */
export function rowCost(r: LedgerRow, provider: ProviderId, settings?: Pick<AppSettings, 'providers'> | null): { usd: number | null; estimated: boolean } {
  const model = r.model || null
  const est = (t: UsageTokens): number | null => estimateCost({ provider, model, ...t }, settings)
  const all: UsageTokens = { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheWriteTokens: r.cacheWriteTokens, cacheReadTokens: r.cacheReadTokens }
  const fixed = r.fixedUsd > 0 || tokenSum(r.covered) > 0
  // The user's own prices (#436): Combwork's estimate for all of it, where it has a price.
  if (usesOwnPrices(provider, settings)) {
    const e = est(all)
    if (e !== null) return { usd: e, estimated: true }
  }
  const rest: UsageTokens = { inputTokens: Math.max(0, r.inputTokens - r.covered.inputTokens), outputTokens: Math.max(0, r.outputTokens - r.covered.outputTokens), cacheWriteTokens: Math.max(0, r.cacheWriteTokens - r.covered.cacheWriteTokens), cacheReadTokens: Math.max(0, r.cacheReadTokens - r.covered.cacheReadTokens) }
  if (!fixed) {
    // A row with no use but prompts or compactions: as a day without tokens is priced (0 where the model has a price).
    const e = est(rest)
    return { usd: e, estimated: e !== null && tokenSum(rest) > 0 }
  }
  if (tokenSum(rest) <= 0) return { usd: r.fixedUsd, estimated: r.fixedEstimated }
  const e = est(rest)
  return { usd: r.fixedUsd + (e ?? 0), estimated: r.fixedEstimated || (e !== null && e > 0) }
}

/** The fields of a session's usage that aren't sums of its rows: what the history keeps beside them. */
export type UsageSummary = Omit<SessionUsage, 'inputTokens' | 'outputTokens' | 'cacheWriteTokens' | 'cacheReadTokens' | 'requests' | 'costUsd' | 'costEstimated' | 'costUnreported' | 'days' | 'costReports' | 'timeline'>

/** What the history keeps of a parser's result beside its rows. */
export function summaryOf(u: SessionUsage): UsageSummary {
  const { inputTokens: _i, outputTokens: _o, cacheWriteTokens: _w, cacheReadTokens: _r, requests: _q, costUsd: _c, costEstimated: _e, costUnreported: _u, days: _d, costReports: _cr, timeline: _t, ...summary } = u
  return summary
}

/**
 * A session's usage from its history, priced now: its summary with the rows' sums, each day's tokens, prompts and cost,
 * and the session's cost (each day's, added up: null when no day has one).
 */
export function usageFromRows(summary: UsageSummary, rows: LedgerRow[], settings?: Pick<AppSettings, 'providers'> | null): SessionUsage {
  const days: Record<string, DayUsage> = {}
  const usage: SessionUsage = { ...summary, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requests: 0, costUsd: null, costEstimated: false, days }
  for (const r of rows) {
    const d = (days[r.day] ??= { ...ZERO(), requests: 0, prompts: 0, compactions: 0, costUsd: null, costEstimated: false })
    for (const k of KINDS) {
      d[k] += r[k]
      usage[k] += r[k]
    }
    d.requests += r.requests
    usage.requests += r.requests
    d.prompts += r.prompts
    d.compactions += r.compactions
    const c = rowCost(r, summary.provider, settings)
    if (c.usd !== null) {
      d.costUsd = (d.costUsd ?? 0) + c.usd
      if (c.estimated) d.costEstimated = true
    }
  }
  for (const d of Object.values(days)) {
    if (d.costUsd === null) continue
    usage.costUsd = (usage.costUsd ?? 0) + d.costUsd
    if (d.costEstimated) usage.costEstimated = true
  }
  return usage
}

/**
 * A session's rows on one card, as a cost part (shared/cardCosts.ts): their tokens and requests, their cost now (≈ where
 * a share), unknown where a row's tokens or cost aren't known. Null when it has none.
 */
export function rowsPart(rows: LedgerRow[], provider: ProviderId, settings?: Pick<AppSettings, 'providers'> | null): CostPart | null {
  if (!rows.length) return null
  const out = emptyPart()
  let known = false
  let unknown = false
  let tokensUnknown = false
  for (const r of rows) {
    for (const k of KINDS) out[k] += r[k]
    out.requests += r.requests
    if (r.tokensUnknown > 0) tokensUnknown = true
    if (r.shared) out.tokensEstimated = true
    if (tokenSum(r) === 0 && r.fixedUsd === 0) {
      if (r.tokensUnknown > 0) unknown = true
      continue
    }
    const c = rowCost(r, provider, settings)
    if (c.usd === null) unknown = true
    else {
      known = true
      out.cost += c.usd
      if (c.estimated || r.shared) out.estimated = true
    }
  }
  out.priced = known ? 1 : 0
  out.unpriced = unknown ? 1 : 0
  out.tokensUnknown = tokensUnknown ? 1 : 0
  return out
}

// ---------------------------------------------------------------------------
// The cards a session's agent held.
// ---------------------------------------------------------------------------

/** Who a session was: its agent's id and name as its record has them. */
export interface SessionWho {
  agentId?: string
  agentName?: string
}

/** A card's holds: kept on it, or (a card no change has saved since #602) from its history. */
/** What of a card its holds are worked out from (#1107: the board reads only these for costs). */
export type CardHoldFields = Pick<TaskCard, 'number' | 'project' | 'held' | 'history' | 'agent' | 'agentName' | 'review'>

export const holdsOfCard = (c: Omit<CardHoldFields, 'number' | 'project'>): TaskHold[] => c.held ?? holdsFromHistory(c)

/**
 * Whether a hold is a session's agent's: by the agent's id; a hold from history with only a name, by the agents named so
 * now (`named`: their ids) or, for a session whose record has no id, the name it kept.
 */
export function holdIsSessions(h: Pick<TaskHold, 'agent' | 'name'>, s: SessionWho, named: (name: string) => string[]): boolean {
  if (h.agent) return s.agentId === h.agent
  if (s.agentId) return named(h.name).includes(s.agentId)
  return !!s.agentName && s.agentName.toLowerCase() === h.name.toLowerCase()
}

/** A hold with its times read (NaN: none, or not a time; it is then `now`, as `ms` gives). */
interface TimedHold {
  hold: TaskHold
  from: number
  to: number
}

/**
 * A project's cards' holds worked out once (HI-1748): each card's, with their times read, and the cards each agent name
 * held. Working them out (from history, for a card no change has saved since #602) is most of what sharing a session's
 * use out costs; the sessions of a project's agents, each read with `sessionHolds`, share one.
 */
export interface HoldIndex {
  cards: { number: number; holds: TimedHold[] }[]
  /** By agent name in lower case: each card's holds of that name. */
  byName: Map<string, Map<number, TimedHold[]>>
}

const parsed = (iso: string | undefined | null): number => (iso ? Date.parse(iso) : NaN)
const at = (t: number, now: number): number => (Number.isFinite(t) ? t : now)
const spanOf = (h: TimedHold, now: number): Span => [at(h.from, now), at(h.to, now)]

/** Each card's holds as holdsOfCard works them out, kept by the card's object (one the board read keeps until it changes). */
const derived = new WeakMap<CardHoldFields, TaskHold[]>()
const derivedOf = (c: CardHoldFields): TaskHold[] => {
  let own = derived.get(c)
  if (!own) derived.set(c, (own = holdsOfCard(c)))
  return own
}

/** Each card's holdsKey, kept by the card's object as `derived` is. */
const keyed = new WeakMap<CardHoldFields, string>()

/**
 * A card's holds as text (whose, which role, from when to when): equal for two reads of a card whose holds didn't change,
 * whatever else of it did (HI-1887: a comment), so a project's cards' keys tell whether its holdIndex is as it was.
 */
export function cardHoldsKey(c: CardHoldFields): string {
  let key = keyed.get(c)
  if (key === undefined) keyed.set(c, (key = JSON.stringify([c.number, derivedOf(c).map((h) => [h.agent ?? null, h.name, h.role, h.from, h.to ?? null])])))
  return key
}

export function holdIndex(cards: CardHoldFields[]): HoldIndex {
  const index: HoldIndex = { cards: [], byName: new Map() }
  for (const c of cards) {
    const own = derivedOf(c)
    const holds = own.map((hold) => ({ hold, from: parsed(hold.from), to: parsed(hold.to) }))
    index.cards.push({ number: c.number, holds })
    for (const h of holds) {
      const name = h.hold.name.toLowerCase()
      let m = index.byName.get(name)
      if (!m) index.byName.set(name, (m = new Map()))
      const list = m.get(c.number)
      if (list) list.push(h)
      else m.set(c.number, [h])
    }
  }
  return index
}

/** Whether a session's agent held any card at some time up to `now`: whether its sessionHolds at `now` has any, without working them out. */
export function heldAt(index: HoldIndex, s: SessionWho, named: (name: string) => string[], now: number): boolean {
  for (const c of index.cards) for (const h of c.holds) if (at(h.to, now) > at(h.from, now) && holdIsSessions(h.hold, s, named)) return true
  return false
}

/**
 * The cards a session's agent held in its project (`cards`: the project's, archived ones too, or their holdIndex), each
 * role apart, with how many cards it held at each time (by the holds' agent name, as cost per card has always shared
 * them): what it used while holding k cards is 1/k each's.
 */
export function sessionHolds(cards: CardHoldFields[] | HoldIndex, s: SessionWho, named: (name: string) => string[], now: number): SessionHold[] {
  const index = Array.isArray(cards) ? holdIndex(cards) : cards
  // Each name's cards, their spans merged at `now`: only for the names this session's holds have.
  const merged = new Map<string, [number, Span[]][]>()
  const spansOfName = (name: string): [number, Span[]][] => {
    let m = merged.get(name)
    if (!m) merged.set(name, (m = [...(index.byName.get(name) ?? [])].map(([n, holds]) => [n, mergeSpans(holds.map((h) => spanOf(h, now)))])))
    return m
  }
  const out: SessionHold[] = []
  for (const c of index.cards) {
    const groups = new Map<string, { role: 'build' | 'review'; name: string; spans: Span[] }>()
    for (const h of c.holds) {
      if (!holdIsSessions(h.hold, s, named)) continue
      const g = groups.get(h.hold.role) ?? { role: h.hold.role, name: h.hold.name, spans: [] }
      g.spans.push(spanOf(h, now))
      groups.set(h.hold.role, g)
    }
    for (const g of groups.values()) {
      const spans = mergeSpans(g.spans)
      if (!spans.length) continue
      const others = spansOfName(g.name.toLowerCase()).filter(([n]) => n !== c.number).map(([, sp]) => sp)
      out.push({ card: c.number, role: g.role, parts: [...sharedSpans(spans, others).entries()] })
    }
  }
  return out
}
