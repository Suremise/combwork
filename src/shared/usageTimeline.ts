import type { UsageTokens } from './types'

/**
 * A session's usage over time (#602), so it can be split by when it happened: a card's cost is what its agents used
 * while they held it. Kept in the usage history with the session's rows (#1106), never sent to the window with the
 * session's usage. Rows of `step` seconds with any use, oldest first: [their start (seconds since the epoch, a multiple
 * of step), input, output, cache write, cache read, requests, the cost report covering them, flags, and the model they
 * ran on (an index into `models`; absent or -1: the session's model)]. A second each (about a row per request), so a
 * card's hold ends where its agent's request did; a session with more rows than MAX_ROWS has them merged into longer
 * steps (10 s, 100 s…), each step's charges into one (boundTimeline).
 *
 * `reports` are the charges the provider reported, each with the requests it covers (a row's report: its index, or -1
 * for none): Claude Code's running total, each increase covering the requests since the last; Copilot's credits at each
 * turn's checkpoint, covering the requests since the one before. A charge is split only between the requests it covers,
 * so a later one never changes what an earlier card cost. Rows with no report are Hive's estimate (≈).
 */
export type UsageRow = [start: number, input: number, output: number, cacheWrite: number, cacheRead: number, requests: number, report: number, flags: number, model?: number]

/** A row's tokens are a share Hive worked out of a total the provider gave for several requests (Copilot's, at exit). */
export const TOKENS_SPREAD = 1
/** A row's tokens aren't known yet (Copilot's, until the launch exits): unknown, never 0. */
export const TOKENS_UNKNOWN = 2

export interface UsageTimeline {
  /** Each row's length in seconds: 1, or 10, 100… for a session with very many requests. */
  step: number
  rows: UsageRow[]
  /** Each report's charge (USD), by index. */
  reports: number[]
  /** The models rows ran on, by index (#1106: a session that switched models has rows of each). */
  models?: string[]
}

/**
 * The most rows a session keeps (about 0.8 MB in the usage history): more are merged into longer steps, and their charges
 * with them, so it never keeps more charges than rows either.
 */
export const MAX_ROWS = 20_000

/** A timestamp's second since the epoch; null for a missing or invalid one. */
export function secondOf(t: string | number | null | undefined): number | null {
  if (t === null || t === undefined || t === '') return null
  const ms = typeof t === 'number' ? t : Date.parse(t)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

const rowKey = (start: number, report: number, flags: number, model = -1): string => `${start}|${report}|${flags}|${model}`
const modelOf = (r: UsageRow): number => r[8] ?? -1
/** A row with its model (none: no ninth field). */
const withModel = (r: UsageRow, model: number): UsageRow => (model >= 0 ? [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], model] : [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]])

/** Sums usage by second (and report, flags and model) as a parser reads it. */
export class TimelineBuilder {
  private rows = new Map<string, UsageRow>()
  private models: string[] = []

  /** A model by its index in the timeline (null for -1: the session's). */
  modelName(i: number): string | null {
    return this.models[i] ?? null
  }

  /** A model's index in the timeline (-1 for none: the session's model). */
  modelIndex(model: string | null | undefined): number {
    if (!model) return -1
    const i = this.models.indexOf(model)
    return i >= 0 ? i : this.models.push(model) - 1
  }

  /** Adds tokens and requests at a time, covered by a report (-1: none), on a model; a missing or invalid time is left out. */
  add(t: string | number | null | undefined, tokens: Partial<UsageTokens>, requests = 0, report = -1, flags = 0, model: string | null = null): void {
    const s = secondOf(t)
    if (s === null) return
    const m = this.modelIndex(model)
    const key = rowKey(s, report, flags, m)
    let r = this.rows.get(key)
    if (!r) this.rows.set(key, (r = withModel([s, 0, 0, 0, 0, 0, report, flags], m)))
    r[1] += tokens.inputTokens ?? 0
    r[2] += tokens.outputTokens ?? 0
    r[3] += tokens.cacheWriteTokens ?? 0
    r[4] += tokens.cacheReadTokens ?? 0
    r[5] += requests
  }

  /**
   * The timeline so far with the reports (copies: the parser keeps reading), and `extra` rows not kept (requests whose
   * tokens aren't known yet, their models this builder's indexes), merged into longer steps past MAX_ROWS.
   */
  timeline(reports: number[] = [], extra: UsageRow[] = []): UsageTimeline {
    const t = boundTimeline({ step: 1, rows: [...this.rows.values(), ...extra].sort((a, b) => a[0] - b[0]).map((r) => [...r] as UsageRow), reports: [...reports] })
    return this.models.length ? { ...t, models: [...this.models] } : t
  }
}

/**
 * A timeline within MAX_ROWS rows: merged into steps of 10, 100… seconds until it fits (step grows to the session's
 * length at most, when all of it is one step). Charges that land in one step are merged with it into one charge, their
 * sum: no charge is lost or counted twice, only its attribution is coarser (a hold that takes part of a merged charge
 * gets an estimated share, ≈). Charges no row refers to (a report that covered no request) are left out, so a
 * timeline never has more charges than rows.
 */
export function boundTimeline(t: UsageTimeline): UsageTimeline {
  let { step, rows, reports } = t
  while (rows.length > MAX_ROWS) {
    step *= 10
    ;({ rows, reports } = mergeRows(rows, reports, step))
  }
  return { ...usedReports({ step, rows, reports }), ...(t.models ? { models: t.models } : {}) }
}

/** The step an ended session's timeline is kept in once it is older than Settings → Advanced says (HI-1648): an hour. */
export const COARSE_STEP = 3600

/**
 * A timeline in steps of `step` seconds at least (HI-1648: an old session's, in an hour's), merged as boundTimeline
 * merges them: tokens, requests and the charges' sum unchanged, only when inside a step each happened is lost. One
 * already that coarse is returned as it is.
 */
export function coarsenTimeline(t: UsageTimeline, step = COARSE_STEP): UsageTimeline {
  if (t.step >= step) return t
  const { rows, reports } = mergeRows(t.rows, t.reports, step)
  return { ...usedReports({ step, rows, reports }), ...(t.models ? { models: t.models } : {}) }
}

/** Rows merged into steps of `step` seconds, each step's charges merged into one (flags and models kept apart). */
function mergeRows(rows: UsageRow[], reports: number[], step: number): { rows: UsageRow[]; reports: number[] } {
  const startOf = (r: UsageRow): number => Math.floor(r[0] / step) * step
  // Charges that share a step become one: a union of report indexes, by step.
  const parent = reports.map((_, i) => i)
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const firstIn = new Map<number, number>()
  for (const r of rows) {
    if (r[6] < 0) continue
    const start = startOf(r)
    const first = firstIn.get(start)
    if (first === undefined) firstIn.set(start, r[6])
    else {
      const [a, b] = [root(first), root(r[6])]
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
    }
  }
  const merged: number[] = []
  const index = new Map<number, number>()
  reports.forEach((usd, i) => {
    const g = root(i)
    if (!index.has(g)) index.set(g, merged.push(0) - 1)
    merged[index.get(g)!] += usd
  })
  const by = new Map<string, UsageRow>()
  for (const r of rows) {
    const start = startOf(r)
    const report = r[6] < 0 ? -1 : index.get(root(r[6]))!
    const key = rowKey(start, report, r[7], modelOf(r))
    const m = by.get(key)
    if (m) for (let i = 1; i <= 5; i++) m[i] = (m[i] ?? 0) + (r[i] ?? 0)
    else by.set(key, withModel([start, r[1], r[2], r[3], r[4], r[5], report, r[7]], modelOf(r)))
  }
  return { rows: [...by.values()].sort((a, b) => a[0] - b[0]), reports: merged }
}

/** Only the charges rows refer to, numbered in order (a row naming a charge there isn't has none). */
function usedReports(t: UsageTimeline): UsageTimeline {
  const index = new Map<number, number>()
  const reports: number[] = []
  const rows = t.rows.map((r): UsageRow => {
    if (r[6] < 0) return r
    if (t.reports[r[6]] === undefined) return withModel([r[0], r[1], r[2], r[3], r[4], r[5], -1, r[7]], modelOf(r))
    if (!index.has(r[6])) index.set(r[6], reports.push(t.reports[r[6]]) - 1)
    return withModel([r[0], r[1], r[2], r[3], r[4], r[5], index.get(r[6])!, r[7]], modelOf(r))
  })
  return { step: t.step, rows, reports }
}

/** A request whose tokens aren't known yet: its second, the report covering it, and its model's index (-1: none). */
export interface PendingRequest {
  second: number
  report: number
  model?: number
}

/**
 * Requests whose tokens the provider gives only as a total later (Copilot's, at exit), as rows of their second, report
 * and model: `count` requests each.
 */
export function pendingRows(requests: PendingRequest[]): UsageRow[] {
  const by = new Map<string, UsageRow>()
  for (const q of requests) {
    const key = rowKey(q.second, q.report, TOKENS_UNKNOWN, q.model ?? -1)
    const r = by.get(key)
    if (r) r[5]++
    else by.set(key, withModel([q.second, 0, 0, 0, 0, 1, q.report, TOKENS_UNKNOWN], q.model ?? -1))
  }
  return [...by.values()]
}

/**
 * Spreads tokens given as one total over the requests they were for, in proportion to each (second, report, model)'s
 * requests (whole tokens, the remainder on the last), as TOKENS_SPREAD rows; with no requests, at time `t`. `models`:
 * the builder's models, by the requests' indexes.
 */
export function spreadTokens(b: TimelineBuilder, requests: PendingRequest[], tokens: UsageTokens, t: string | number | null | undefined, models: (i: number) => string | null = () => null): void {
  if (!requests.length) return b.add(t, tokens, 0, -1, TOKENS_SPREAD)
  const groups = pendingRows(requests).sort((x, y) => x[0] - y[0])
  const keys = ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens'] as const
  const given = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
  groups.forEach((g, i) => {
    const last = i === groups.length - 1
    const part = Object.fromEntries(keys.map((k) => [k, last ? tokens[k] - given[k] : Math.floor((tokens[k] * g[5]) / requests.length)])) as unknown as UsageTokens
    for (const k of keys) given[k] += part[k]
    b.add(g[0] * 1000, part, g[5], g[6], TOKENS_SPREAD, models(modelOf(g)))
  })
}

/** The model a row ran on: its own, else the session's (`model`). */
export const rowModel = (t: Pick<UsageTimeline, 'models'>, r: UsageRow, model: string | null): string | null => {
  const m = modelOf(r)
  return (m >= 0 ? t.models?.[m] : undefined) ?? model
}

/**
 * Each row's share of the charge covering it (USD; 0 for a row no charge covers): a charge is split only between the rows
 * it covers, by Hive's estimate for their tokens (`est`), else their tokens, their requests, or equally (one measure for
 * all of a charge's rows), so a later charge never changes an earlier row's.
 */
export function chargeShares(t: UsageTimeline, est: (r: UsageRow) => number | null): number[] {
  const { rows, reports } = t
  const measures: ((r: UsageRow) => number)[] = [(r) => est(r) ?? 0, (r) => r[1] + r[2] + r[3] + r[4], (r) => r[5], () => 1]
  const groups = new Map<number, number[]>()
  rows.forEach((r, i) => {
    if (r[6] < 0) return
    const g = groups.get(r[6])
    if (g) g.push(i)
    else groups.set(r[6], [i])
  })
  const out = rows.map(() => 0)
  for (const [report, idx] of groups) {
    for (const m of measures) {
      const total = idx.reduce((n, i) => n + m(rows[i]), 0)
      if (total > 0) {
        for (const i of idx) out[i] = (reports[report] ?? 0) * (m(rows[i]) / total)
        break
      }
    }
  }
  return out
}

/** A timeline read back from the usage history (or an old usage-cache.json), if it is one (anything else: none). */
export function readTimeline(v: unknown): UsageTimeline | null {
  if (!v || typeof v !== 'object') return null
  const { step, rows, reports, models } = v as { step?: unknown; rows?: unknown; reports?: unknown; models?: unknown }
  if (typeof step !== 'number' || !(step >= 1) || !Array.isArray(rows) || !Array.isArray(reports)) return null
  if (!reports.every((x) => typeof x === 'number' && Number.isFinite(x))) return null
  if (models !== undefined && !(Array.isArray(models) && models.every((m) => typeof m === 'string'))) return null
  const known = Array.isArray(models) ? models.length : 0
  const ok = rows.every((r) => Array.isArray(r) && (r.length === 8 || r.length === 9) && r.every((x) => typeof x === 'number' && Number.isFinite(x)) && r[6] < reports.length && (r.length === 8 || r[8] < known))
  return ok ? { step, rows: rows as UsageRow[], reports: reports as number[], ...(Array.isArray(models) ? { models: models as string[] } : {}) } : null
}
