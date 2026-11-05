import type { AppSettings, SessionUsage, TaskCard, TaskColumn, TaskHold, UsageTokens } from './types'
import { estimateCost, usesOwnPrices } from './prices'
import { fmt, msg, tr } from './i18n'
import { TASK_COLUMNS } from './tasks'
import { reviewRounds } from './laneBar'
import { costText, money, moneyUnit, moneyUnits, unitMoneyLabel } from './usageTotals'
import { TOKENS_SPREAD, TOKENS_UNKNOWN, chargeShares, rowModel, type UsageRow, type UsageTimeline } from './usageTimeline'
import type { Fact, FactData, StageId } from './workflow/facts'

/**
 * Cost per card and per lane (#602, Darren's decision of 11 Oct). Usage is the card's while an agent held it: its
 * builder while it is in Doing, its reviewer from its review's start to its verdict (TaskCard.held). What a lane's agents
 * used while holding no card is the lane's overhead (merges, watching, compactions). Each provider's usage is as it
 * reported it: Hive's estimates marked ≈, and what isn't known is unknown, never $0.
 */

/** Holds kept on a card: the newest. */
export const MAX_HOLDS = 100

// ---------------------------------------------------------------------------
// Who held a card when.
// ---------------------------------------------------------------------------

type Holder = Pick<TaskHold, 'agent' | 'name' | 'role'>

/** Who holds a card now: its agent while it is in Doing, its reviewer while it is reviewed. */
export function holdersNow(card: Pick<TaskCard, 'column' | 'agent' | 'agentName' | 'review'>): Holder[] {
  const out: Holder[] = []
  if (card.column === 'doing' && card.agent) out.push({ agent: card.agent, name: card.agentName ?? card.agent, role: 'build' })
  if (card.column === 'review' && card.review) out.push({ agent: card.review.agent, name: card.review.agentName, role: 'review' })
  return out
}

const sameHolder = (a: Holder, b: Holder): boolean => a.role === b.role && (a.agent && b.agent ? a.agent === b.agent : a.name.toLowerCase() === b.name.toLowerCase())

/** Ends the holds that no longer are and starts the new ones, at `at`. Returns the holds (does not change `held`). */
function moveHolds(held: TaskHold[], now: Holder[], at: string): TaskHold[] {
  const out = held.map((h) => ({ ...h }))
  const open = out.filter((h) => !h.to)
  for (const h of open) if (!now.some((n) => sameHolder(h, n))) h.to = at
  for (const n of now) if (!open.some((h) => sameHolder(h, n))) out.push({ ...(n.agent ? { agent: n.agent } : {}), name: n.name, role: n.role, from: at })
  return out
}

/**
 * Keeps a card's holds up to date as it is saved (tasks.ts saveCard): a hold that ended gets its end, a new one starts.
 * A card without holds yet (from before #602) gets them from its history first. Cards nobody ever held get none.
 */
export function trackHolds(card: TaskCard, at: string): void {
  const before = card.held ?? holdsFromHistory(card)
  const held = moveHolds(before, holdersNow(card), at).slice(-MAX_HOLDS)
  if (held.length || card.held) card.held = held
}

const COLUMN_BY_LABEL = new Map(TASK_COLUMNS.map((c) => [c.label.toLowerCase(), c.id]))
const MOVED = /^Moved to (?:the (?:top|bottom) of )?(On Hold|Todo|Doing|Review|Passed|Done)\b/
const CREATED = /^Created in (On Hold|Todo|Doing|Review|Passed|Done)\b/
/** "HB5 (hive)": an agent's name as history gives who did it. */
const agentNamed = (by: string): string => by.replace(/\s+\([^()]*\)$/, '')

/**
 * A card's holds as its history tells them, for a card from before Hive kept them: who it was given to and when it was
 * in Doing, who started reviewing it and their verdicts. By names (history has no ids), except where the name is the
 * card's agent's or reviewer's now. A history cut short (the oldest entries dropped) gives what it still has.
 */
export function holdsFromHistory(card: Pick<TaskCard, 'history' | 'agent' | 'agentName' | 'review'>): TaskHold[] {
  let held: TaskHold[] = []
  let column: TaskColumn | null = null
  let builder: string | null = null
  let reviewer: string | null = null
  const idOf = (name: string, role: TaskHold['role']): string | undefined => {
    const now = role === 'build' ? card.agent && { id: card.agent, name: card.agentName } : card.review && { id: card.review.agent, name: card.review.agentName }
    return now && now.name?.toLowerCase() === name.toLowerCase() ? now.id : undefined
  }
  for (const h of card.history) {
    for (const part of h.what.split('; ')) {
      const created = CREATED.exec(part)
      const moved = MOVED.exec(part)
      if (created) column = COLUMN_BY_LABEL.get(created[1].toLowerCase()) ?? column
      // Made in Doing for an agent: the card's own agent then (its history doesn't name it).
      if (created && column === 'doing' && card.agentName) builder = card.agentName
      if (moved) column = COLUMN_BY_LABEL.get(moved[1].toLowerCase()) ?? column
      if (part.startsWith('Returned for review')) column = 'review'
      if (part.startsWith('Given to ')) builder = part.slice('Given to '.length).trim() // i18n-ignore: card history, stored in English
      if (part.startsWith('Taken from ')) builder = null
      if (part.startsWith('Started reviewing')) reviewer = agentNamed(h.by)
      if (/^Review (passed|failed)/.test(part) || /^Review by .* stopped/.test(part)) reviewer = null
      if (column !== 'review') reviewer = null
    }
    const now: Holder[] = []
    if (column === 'doing' && builder) now.push({ agent: idOf(builder, 'build'), name: builder, role: 'build' })
    if (reviewer) now.push({ agent: idOf(reviewer, 'review'), name: reviewer, role: 'review' })
    held = moveHolds(held, now, h.at)
  }
  return held.slice(-MAX_HOLDS)
}

/** Reads a card's holds from its file: only well-formed ones (the files can be edited by hand). */
export function holdsOf(v: unknown): { held?: TaskHold[] } {
  if (!Array.isArray(v)) return {}
  const held = v.flatMap((h): TaskHold[] =>
    h && typeof h.name === 'string' && (h.role === 'build' || h.role === 'review') && typeof h.from === 'string' && Number.isFinite(Date.parse(h.from))
      ? [{ ...(typeof h.agent === 'string' && h.agent ? { agent: h.agent } : {}), name: h.name, role: h.role, from: h.from, ...(typeof h.to === 'string' && Number.isFinite(Date.parse(h.to)) ? { to: h.to } : {}) }]
      : []
  )
  return { held: held.slice(-MAX_HOLDS) }
}

/**
 * How many review rounds a card has had: none until it first goes to Review; then each failed review is a round, and
 * the one under way (or passed) is the next.
 */
export function cardRounds(card: Pick<TaskCard, 'history' | 'column'>): number {
  const lines = card.history.flatMap((h) => h.what.split('; '))
  const toReview = lines.some((l) => /^(Moved to (the (top|bottom) of )?Review\b|Returned for review|Started reviewing|Review (passed|failed))/.test(l))
  if (!toReview && card.column !== 'review') return 0
  const { failures, failedNow } = reviewRounds(card as TaskCard)
  return failedNow ? failures : failures + 1
}

// ---------------------------------------------------------------------------
// Usage over spans of time.
// ---------------------------------------------------------------------------

/** Spans of time in ms, [from, to): merged, so nothing is counted twice. */
export type Span = [number, number]

export function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out: Span[] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** `spans` with `minus` taken out (both merged). */
export function subtractSpans(spans: Span[], minus: Span[]): Span[] {
  const out: Span[] = []
  for (const [a0, b] of spans) {
    let a = a0
    for (const [c, d] of minus) {
      if (d <= a || c >= b) continue
      if (c > a) out.push([a, c])
      a = Math.max(a, d)
      if (a >= b) break
    }
    if (a < b) out.push([a, b])
  }
  return out
}

/**
 * An agent's spans on one card, cut where its spans on its other cards begin and end, by how many cards it held then
 * (this one and the others covering the piece): what it used while holding k cards is shared between them, 1/k each,
 * so no usage counts twice. `others` is each other card's merged spans.
 */
export function sharedSpans(spans: Span[], others: Span[][]): Map<number, Span[]> {
  const out = new Map<number, Span[]>()
  for (const [a, b] of spans) {
    const cuts = new Set([a, b])
    for (const o of others) for (const [c, d] of o) for (const x of [c, d]) if (x > a && x < b) cuts.add(x)
    const points = [...cuts].sort((x, y) => x - y)
    for (let i = 0; i + 1 < points.length; i++) {
      const [x, y] = [points[i], points[i + 1]]
      const k = 1 + others.filter((o) => overlap(o, x, y) > 0).length
      out.set(k, [...(out.get(k) ?? []), [x, y]])
    }
  }
  for (const [k, v] of out) out.set(k, mergeSpans(v))
  return out
}

/**
 * A part's usage and cost times f (its share of time an agent held several cards); how many parts were priced or not
 * stays. A share is Hive's, so it is marked ≈ (cost and tokens).
 */
export function scalePart(p: CostPart, f: number): CostPart {
  if (f === 1) return p
  const known = p.priced > 0
  return { ...p, inputTokens: p.inputTokens * f, outputTokens: p.outputTokens * f, cacheWriteTokens: p.cacheWriteTokens * f, cacheReadTokens: p.cacheReadTokens * f, requests: p.requests * f, cost: p.cost * f, estimated: p.estimated || known, tokensEstimated: true }
}

/** How much of [a, b) the spans cover, in ms. */
function overlap(spans: Span[], a: number, b: number): number {
  let n = 0
  for (const [c, d] of spans) {
    if (d <= a) continue
    if (c >= b) break
    n += Math.min(b, d) - Math.max(a, c)
  }
  return n
}

/** Usage and its cost, summed over sessions' parts. `priced` and `unpriced` count the parts with a cost and without one. */
export interface CostPart {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  requests: number
  cost: number
  /** Some of the cost is Hive's estimate (≈). */
  estimated: boolean
  priced: number
  /** Parts whose cost isn't known (no price for the model, or usage Hive can't place in time): never counted as $0. */
  unpriced: number
  /**
   * Parts whose tokens aren't known (Copilot's before its launch exits, a session Hive can't place in time): the token
   * counts are only what is known, never 0 for them.
   */
  tokensUnknown: number
  /** Some of the tokens are Hive's share of a total (Copilot's spread over its requests, a card held with others): ≈. */
  tokensEstimated: boolean
}

export const emptyPart = (): CostPart => ({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requests: 0, cost: 0, estimated: false, priced: 0, unpriced: 0, tokensUnknown: 0, tokensEstimated: false })

/** Usage nobody knows: a cost and tokens unknown. */
export const unknownPart = (): CostPart => ({ ...emptyPart(), unpriced: 1, tokensUnknown: 1 })

export function addPart(to: CostPart, p: CostPart): CostPart {
  to.inputTokens += p.inputTokens
  to.outputTokens += p.outputTokens
  to.cacheWriteTokens += p.cacheWriteTokens
  to.cacheReadTokens += p.cacheReadTokens
  to.requests += p.requests
  to.cost += p.cost
  to.estimated ||= p.estimated
  to.priced += p.priced
  to.unpriced += p.unpriced
  to.tokensUnknown += p.tokensUnknown
  to.tokensEstimated ||= p.tokensEstimated
  return to
}

const rowTokens = (r: UsageRow): UsageTokens => ({ inputTokens: r[1], outputTokens: r[2], cacheWriteTokens: r[3], cacheReadTokens: r[4] })

/** A session as the cost of cards reads it: its usage (for its provider and model), its timeline, and when it was active. */
export interface SessionSlice {
  usage: SessionUsage | null
  timeline: UsageTimeline | null
  /** When it was active, for one without usage or a timeline: whether it falls in a span at all. */
  from: number
  to: number
}

/**
 * What a session used in some spans of time: each row of its timeline (a second, mostly) by how much of it the spans
 * cover. Its cost: a reported charge (UsageTimeline.reports) is split only between the rows it covers, by Hive's
 * estimate for their tokens (else their tokens, their requests, or equally), and is exact where all of a charge's rows
 * are inside, ≈ where the spans split it; rows no charge covers are Hive's estimate (≈), and so is everything when the
 * user chose their own prices over the provider's (#436). Unknown where there is no price, or no tokens to price yet. A
 * session active in the spans whose timeline or usage Hive doesn't have is an unknown part. Null when it wasn't active
 * in them.
 */
export function sliceSession(s: SessionSlice, spans: Span[], settings?: Pick<AppSettings, 'providers'> | null): CostPart | null {
  if (!spans.length) return null
  if (!s.usage || !s.timeline) return overlap(spans, s.from, Math.max(s.to, s.from + 1)) > 0 ? unknownPart() : null
  // Not active near the spans at all (a minute's margin: its first and last activity are its main conversation's).
  if (s.to >= s.from && overlap(spans, s.from - 60_000, s.to + 60_000) === 0) return null
  const { provider, model } = s.usage
  const { rows } = s.timeline
  const step = s.timeline.step * 1000
  const covered = rows.map((r) => overlap(spans, r[0] * 1000, r[0] * 1000 + step) / step)
  if (!covered.some((f) => f > 0)) return null
  // Each row priced at its own model (#1106: a session that switched models), else the session's.
  const est = (r: UsageRow): number | null => estimateCost({ provider, model: rowModel(s.timeline!, r, model), ...rowTokens(r) }, settings)
  const own = usesOwnPrices(provider, settings)
  // Each row's share of its charge (chargeShares), and whether all of a charge's rows are inside the spans.
  const shares = own ? null : chargeShares(s.timeline, est)
  const whole = new Map<number, boolean>()
  if (!own) rows.forEach((r, i) => r[6] >= 0 && whole.set(r[6], (whole.get(r[6]) ?? true) && covered[i] === 1))
  const out = emptyPart()
  let costKnown = false
  let costUnknown = false
  let tokensUnknown = false
  rows.forEach((r, i) => {
    const f = covered[i]
    if (f <= 0) return
    if (r[7] & TOKENS_UNKNOWN) tokensUnknown = true
    else {
      out.inputTokens += r[1] * f
      out.outputTokens += r[2] * f
      out.cacheWriteTokens += r[3] * f
      out.cacheReadTokens += r[4] * f
      if (r[7] & TOKENS_SPREAD) out.tokensEstimated = true
    }
    out.requests += r[5] * f
    if (shares && r[6] >= 0) {
      costKnown = true
      out.cost += shares[i] * f
      // The spans take part of the charge: its split is Hive's.
      if (!whole.get(r[6])) out.estimated = true
      return
    }
    const e = r[7] & TOKENS_UNKNOWN ? null : est(r)
    if (e === null) costUnknown = true
    else {
      costKnown = true
      out.cost += e * f
      out.estimated = true
    }
  })
  out.priced = costKnown ? 1 : 0
  out.unpriced = costUnknown ? 1 : 0
  out.tokensUnknown = tokensUnknown ? 1 : 0
  return out
}

// ---------------------------------------------------------------------------
// Cards and lanes.
// ---------------------------------------------------------------------------

export interface CardCost {
  number: number
  title: string
  project: string
  column: TaskColumn
  rounds: number
  /** Its builders' part (while in Doing) and its reviewers' (while reviewing). */
  build: CostPart
  review: CostPart
  total: CostPart
  /** When it was last held (ISO), or now while it is. */
  lastHeld: string | null
  /** Holds whose agent has no session Hive knows of: their usage is unknown. */
  unmatched: number
}

export interface LaneCost {
  id: string
  /** What the lane's agents used from its start to its end (or now). */
  total: CostPart
  /** While holding a card. */
  onCards: CostPart
  /** While holding none: merges, watching, compactions. */
  overhead: CostPart
  /** Its cards that passed or are done. */
  finished: number
}

/**
 * One round of a card's work, from its facts (#1226, #820 item 2). Rounds follow the card's submissions: a submission's
 * round is its `Submitted.round`, and a verdict counts for the round of the submission it names (never its own `round`,
 * which counts failures). A cycle's first round begins at its start (`Started`, `Adopted`), numbered by its first
 * submission (a reopened card's runtime counts its rounds on: its new cycle may begin at round 2); round k+1 at the first failed
 * verdict on round k (its fixes begin there), or at its own first submission if no verdict failed it (a stale pass sent
 * back). A pass ends nothing by itself (a second reviewer may still review, a later verdict may fail it): the card's work
 * pauses while its stage is past Review or not yet started (Approved, Merging, Done, Hold, Todo, from its `Moved` facts)
 * and goes on, in the current round, when it comes back. So a round is the spans of time it was worked in.
 */
export interface RoundSpan {
  /** The seq of the cycle's start: a card reopened after Done starts its rounds again. */
  cycle: number
  round: number
  /** The spans it was worked in, merged, in order. */
  spans: Span[]
  /** The first span's start and the last one's end (its first submission's time when it has no span). */
  from: number
  to: number
  /** When its change was first submitted; null while it has none. */
  submitted: number | null
  /** Failed when a verdict on its submissions failed, passed when any passed and none failed. */
  verdict: 'passed' | 'failed' | null
  /** The reviewers who gave a verdict in it (as the verdicts name them: an agent's id, or `user`), in order, each once. */
  reviewers: string[]
}

/** The stages a card is worked in: its builder in Active, its reviewers in Review. */
const WORKED = new Set<StageId>(['active', 'review'])
const ADOPTED_STAGE: Record<string, StageId> = { doing: 'active', review: 'review', passed: 'approved' }

/** A card's rounds from its facts in seq order; none for a card with no cycle (from before 1.0, or never started). */
export function roundSpans(facts: readonly Fact[], now: number): RoundSpan[] {
  const out: RoundSpan[] = []
  // `numbered`: its first round has its number, from its first submission (or a verdict); until then that round is the
  // work before it, whatever number the submission gives (the runtime counts rounds on across a reopened card's cycles).
  type Cycle = { seq: number; rounds: Map<number, RoundSpan>; current: number; since: number | null; subs: Map<number, number>; numbered: boolean }
  let cyc: Cycle | null = null
  const time = (f: Fact): number => {
    const t = Date.parse(f.at)
    return Number.isFinite(t) ? t : now
  }
  const roundOf = (c: Cycle, k: number): RoundSpan => {
    let r = c.rounds.get(k)
    if (!r) c.rounds.set(k, (r = { cycle: c.seq, round: k, spans: [], from: 0, to: 0, submitted: null, verdict: null, reviewers: [] }))
    return r
  }
  // Work pauses (the span so far goes to the current round) and goes on.
  const pause = (c: Cycle, t: number): void => {
    if (c.since !== null && t > c.since) roundOf(c, c.current).spans.push([c.since, t])
    c.since = null
  }
  const resume = (c: Cycle, t: number): void => {
    if (c.since === null) c.since = t
  }
  // Round k begins at t (never an earlier one again): work under way goes on in it.
  const begin = (c: Cycle, k: number, t: number): void => {
    if (k <= c.current) return
    const working = c.since !== null
    pause(c, t)
    c.current = k
    roundOf(c, k)
    if (working) resume(c, t)
  }
  const finish = (t: number): void => {
    if (!cyc) return
    pause(cyc, t)
    for (const r of [...cyc.rounds.values()].sort((a, b) => a.round - b.round)) {
      const spans = mergeSpans(r.spans)
      if (!spans.length && r.submitted === null && !r.verdict) continue
      out.push({ ...r, spans, from: spans[0]?.[0] ?? r.submitted ?? t, to: spans.at(-1)?.[1] ?? r.submitted ?? t })
    }
    cyc = null
  }
  for (const f of facts) {
    const t = time(f)
    if (f.kind === 'Started' || f.kind === 'Adopted') {
      finish(t)
      const c: Cycle = { seq: f.seq, rounds: new Map(), current: 1, since: null, subs: new Map(), numbered: false }
      roundOf(c, 1)
      const from = f.kind === 'Started' ? 'active' : (ADOPTED_STAGE[(f.data as FactData['Adopted']).adoptedFrom ?? 'doing'] ?? 'active')
      if (WORKED.has(from)) resume(c, t)
      cyc = c
      continue
    }
    const c: Cycle | null = cyc
    if (!c) continue
    if (f.kind === 'Moved') {
      if (WORKED.has((f.data as FactData['Moved']).to)) resume(c, t)
      else pause(c, t)
    } else if (f.kind === 'Submitted') {
      const d = f.data as FactData['Submitted']
      const k = Number.isInteger(d.round) && d.round > 0 ? d.round : c.current
      c.subs.set(f.seq, k)
      if (!c.numbered && k !== c.current) {
        // The cycle's first submission numbers the work before it: one round, never an invented round 1.
        const first = roundOf(c, c.current)
        c.rounds.delete(c.current)
        c.rounds.set(k, { ...first, round: k })
        c.current = k
      }
      c.numbered = true
      begin(c, k, t)
      resume(c, t)
      const r = roundOf(c, k)
      r.submitted ??= t
    } else if (f.kind === 'Verdict') {
      const d = f.data as FactData['Verdict']
      const k = c.subs.get(d.submission) ?? c.current
      c.numbered = true
      const r = roundOf(c, k)
      if (d.reviewer && !r.reviewers.includes(d.reviewer)) r.reviewers.push(d.reviewer)
      if (d.pass) r.verdict ??= 'passed'
      else {
        r.verdict = 'failed'
        // Its fixes: the next round, from this verdict.
        begin(c, k + 1, t)
      }
    }
  }
  finish(now)
  return out
}

/** What one agent used on a card in one round, in a role (the time it held the card then, shared as cost per card shares it). */
export interface RoundAgentCost {
  /** Its id, when the hold has one (older holds name the agent only). */
  agent: string | null
  name: string
  role: 'build' | 'review'
  part: CostPart
}

export interface RoundCost {
  cycle: number
  round: number
  /** ISO times of its span. */
  from: string
  to: string
  submitted: string | null
  verdict: 'passed' | 'failed' | null
  reviewers: string[]
  /** The spans it was worked in (ISO times): its parts are what was used in them. */
  spans: [string, string][]
  build: CostPart
  review: CostPart
  /** By agent and role, in the order the card's holds name them. */
  agents: RoundAgentCost[]
}

/**
 * A card's cost per round and role (#1226; shown in the card dialog's Work section, HI-1906). `rounds` is empty for a card
 * with no rounds: `preWorkflow` says when that is because it is from before 1.0 (it has no facts to split by). Each
 * round's parts are shares of `total`, the card's cost as cost per card counts it (its ledger rows), so they add up to it.
 */
export interface CardRoundCosts {
  number: number
  preWorkflow: boolean
  rounds: RoundCost[]
  /**
   * What its agents used holding it outside all its rounds (a card adopted at the upgrade, held before its work began
   * there), so the rounds and this add up to the total; null when there is none.
   */
  outside: Pick<RoundCost, 'build' | 'review' | 'agents'> | null
  /** The card's cost, exactly as cost per card gives it; null with no rounds. */
  total: CostPart | null
}

/** One agent's use of a card in one round, as its sessions' timelines give it, and how long (ms) it held the card then. */
export interface RolePiece {
  part: CostPart
  held: number
}

const partTokenSum = (p: CostPart): number => p.inputTokens + p.outputTokens + p.cacheWriteTokens + p.cacheReadTokens

/**
 * A role's part of a card's cost (the ledger's, as the card's total counts it) shared out between the pieces of it
 * (HI-1906): by what the timelines give each (cost, else tokens), else by how long each held the card, else equally, so
 * the shares add up to the part. A share of less than all of it is Hive's (≈). What isn't known stays unknown: in the
 * pieces whose own use isn't known, or in each piece with a share when none says which.
 */
export function shareRole(ledger: CostPart, pieces: RolePiece[]): CostPart[] {
  if (!pieces.length) return []
  const weigh: (p: RolePiece) => number = pieces.some((p) => p.part.cost > 0) ? (p) => p.part.cost : pieces.some((p) => partTokenSum(p.part) > 0) ? (p) => partTokenSum(p.part) : pieces.some((p) => p.held > 0) ? (p) => p.held : () => 1
  const w = pieces.map(weigh)
  const sum = w.reduce((a, b) => a + b, 0)
  const unpricedPiece = pieces.some((p) => p.part.unpriced > 0)
  const tokensUnknownPiece = pieces.some((p) => p.part.tokensUnknown > 0)
  return pieces.map((p, i) => {
    const f = w[i] / sum
    const some = f > 0
    const part = w[i] !== sum
    return {
      inputTokens: ledger.inputTokens * f,
      outputTokens: ledger.outputTokens * f,
      cacheWriteTokens: ledger.cacheWriteTokens * f,
      cacheReadTokens: ledger.cacheReadTokens * f,
      requests: ledger.requests * f,
      cost: ledger.cost * f,
      estimated: ledger.estimated || (part && some && ledger.priced > 0),
      priced: some && ledger.priced > 0 ? 1 : 0,
      unpriced: ledger.unpriced > 0 && (unpricedPiece ? p.part.unpriced > 0 : some) ? 1 : 0,
      tokensUnknown: ledger.tokensUnknown > 0 && (tokensUnknownPiece ? p.part.tokensUnknown > 0 : some) ? 1 : 0,
      tokensEstimated: ledger.tokensEstimated || (part && some)
    }
  })
}

/** An amount in a table of costs: its whole units (moneyUnit's), as allocated, and as shown. */
export interface CostCell {
  units: number
  text: string
}

export interface CostTable {
  /** In dollars: a cent, or a dollar when the total is $100 or more (as the card's own cost line shows it). */
  unit: number
  rounds: { build: CostCell; review: CostCell; total: CostCell }[]
  build: CostCell
  review: CostCell
  total: CostCell
}

/**
 * A card's cost by round and role as shown (HI-1906): the total's whole units (as the card's cost line rounds it, none
 * under one) allocated once over every round's builder and reviewer parts, each its whole units and then those with the
 * largest remainders (ties to the earlier round, then the builder), so every round and role total is the sum of what its
 * parts show and the whole adds up to the card's cost. Exact amounts stay in the parts: only what is shown is allocated.
 * ≈, + ? and Unknown are each part's own.
 */
export function costCells(total: CostPart, rounds: { build: CostPart; review: CostPart }[]): CostTable {
  const unit = moneyUnit(total.cost)
  // Rounded as the card's line rounds it; under one unit, nothing (the line says "< $0.01").
  const whole = total.cost > 0 && total.cost < unit ? 0 : moneyUnits(total.cost)
  const parts = rounds.flatMap((r) => [r.build, r.review])
  const exact = parts.map((p) => Math.max(0, p.cost) / unit)
  const units = exact.map((e) => Math.floor(e))
  let left = whole - units.reduce((a, b) => a + b, 0)
  const order = parts.map((_, i) => i).sort((a, b) => exact[b] - units[b] - (exact[a] - units[a]) || a - b)
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) units[order[k]]++
  // Shares summed a little over the total (float error): taken from the smallest remainders.
  for (let k = order.length - 1; left < 0 && k >= 0; k--) {
    if (units[order[k]] === 0) continue
    units[order[k]]--
    left++
  }
  const cell = (p: CostPart, n: number): CostCell => ({ units: n, text: !p.priced && !p.unpriced ? '—' : costText(p, () => unitMoneyLabel(n, unit, p.cost)) })
  const sum = (list: CostPart[]): CostPart => list.reduce((a, p) => addPart(a, p), emptyPart())
  const out = rounds.map((r, i) => ({ build: cell(r.build, units[2 * i]), review: cell(r.review, units[2 * i + 1]), total: cell(sum([r.build, r.review]), units[2 * i] + units[2 * i + 1]) }))
  const col = (j: number): number => out.reduce((a, _, i) => a + units[2 * i + j], 0)
  return {
    unit,
    rounds: out,
    build: cell(sum(rounds.map((r) => r.build)), col(0)),
    review: cell(sum(rounds.map((r) => r.review)), col(1)),
    total: cell(total, col(0) + col(1))
  }
}

/** Tokens and requests as whole numbers (a row partly in a span gives fractions). */
export const roundPart = (p: CostPart): CostPart => ({
  ...p,
  inputTokens: Math.round(p.inputTokens),
  outputTokens: Math.round(p.outputTokens),
  cacheWriteTokens: Math.round(p.cacheWriteTokens),
  cacheReadTokens: Math.round(p.cacheReadTokens),
  requests: Math.round(p.requests)
})

/** A part's cost as shown: "≈ $1.84", "$1.20 + ?" (some unknown), "Unknown" (none known); "—" for nothing at all. */
export function partCost(p: CostPart): string {
  if (!p.priced && !p.unpriced) return '—'
  return costText({ cost: p.cost, estimated: p.estimated, priced: p.priced, unpriced: p.unpriced })
}

/** "cost: ≈ $1.84 · 2 rounds" (the card's own line), in the window's language (#798). */
export function cardCostLine(c: Pick<CardCost, 'total' | 'rounds'>): string {
  return tr(msg({ id: 'board.cost.cardLine', defaultMessage: 'cost: {cost}{rounds, plural, =0 {} one { · # round} other { · # rounds}}', description: "A card's cost on the board, under its title: what its agents used ({cost}: \"≈ $1.84\", \"Unknown\"), then how many review rounds it has had (none: leave that branch empty). Lower case: it reads as a note." }), { cost: partCost(c.total), rounds: c.rounds })
}

/** A token count in a few characters: "30", "12K", "1.2M" (compact, in the window's language). */
const tok = (n: number): string => fmt.number(Math.round(n), { notation: 'compact', maximumFractionDigits: 1 })

/**
 * A part's tokens in words, for a hover: "in 12K · out 3K · cache write 40K · cache read 1.2M · 31 requests"; "≈ " when
 * some are Hive's share of a total, "+ unknown" when some aren't known, "tokens unknown" when none are.
 */
export function partTokens(p: CostPart): string {
  if (!p.priced && !p.unpriced && !p.tokensUnknown) return tr(msg({ id: 'board.cost.nothingUsed', defaultMessage: 'nothing used', description: "A card's or lane's token use, in a cost hover: no tokens at all. Lower case: it follows a cost." }))
  const known = p.inputTokens + p.outputTokens + p.cacheWriteTokens + p.cacheReadTokens > 0
  const requests = Math.round(p.requests)
  if (p.tokensUnknown && !known) return tr(msg({ id: 'board.cost.tokensUnknown', defaultMessage: 'tokens unknown{requests, plural, =0 {} one { · # request} other { · # requests}}', description: "A card's or lane's token use, in a cost hover: the provider didn't say how many tokens, then how many requests (none: leave that branch empty). Lower case: it follows a cost." }), { requests })
  const values = { input: tok(p.inputTokens), output: tok(p.outputTokens), cacheWrite: tok(p.cacheWriteTokens), cacheRead: tok(p.cacheReadTokens), estimated: p.tokensEstimated ? 'yes' : 'no', unknown: p.tokensUnknown ? 'yes' : 'no', requests }
  return tr(msg({ id: 'board.cost.tokens', defaultMessage: '{estimated, select, yes {≈ } other {}}in {input} · out {output} · cache write {cacheWrite} · cache read {cacheRead}{unknown, select, yes { + unknown} other {}}{requests, plural, =0 {} one { · # request} other { · # requests}}', description: "A card's or lane's token use, in a cost hover: input, output, cache write and cache read tokens (\"12K\"); ≈ first when some are Combwork's estimate; + unknown when some aren't known; then how many requests (none: leave that branch empty). Lower case: it follows a cost." }), values)
}

/** Cost per finished card ("≈ $2.10 a finished card"), when any finished and the cost is known. */
export function perFinished(l: LaneCost): string | null {
  if (!l.finished || !l.total.priced) return null
  return tr(msg({ id: 'board.cost.perFinished', defaultMessage: '{estimated, select, yes {≈ } other {}}{cost}{unpriced, select, yes { + ?} other {}} a finished card', description: "A lane's cost per finished card ({cost}: \"$2.10\"), in its cost hover (Progress panel): ≈ first when it is an estimate, + ? when some usage couldn't be priced." }), { cost: money(l.total.cost / l.finished), estimated: l.total.estimated ? 'yes' : 'no', unpriced: l.total.unpriced ? 'yes' : 'no' })
}
