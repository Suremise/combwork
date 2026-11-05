// Cost per card and per lane (#602): who held a card when, and what their sessions used then.
import { describe, expect, it } from 'vitest'
import { cardCostLine as costLine, cardRounds, emptyPart, holdsFromHistory, holdsOf, mergeSpans, partCost, partTokens, scalePart, sharedSpans, sliceSession, subtractSpans, trackHolds, type CardCost, type SessionSlice, type Span } from '../src/shared/cardCosts'
import { MAX_ROWS, TOKENS_SPREAD, TOKENS_UNKNOWN, TimelineBuilder, pendingRows, readTimeline, spreadTokens, type UsageTimeline } from '../src/shared/usageTimeline'
import { estimateCost } from '../src/shared/prices'
import { ClaudeUsageParser } from '../src/main/providers/claude/usage'
import { parseRollout } from '../src/main/providers/codex/rollout'
import { parseEvents } from '../src/main/providers/copilot/events'
import { priceUsage } from '../src/shared/usageDays'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { SessionUsage, TaskCard, TaskHistoryEntry } from '../src/shared/types'

const T0 = Date.parse('2026-10-12T10:00:00.000Z')
const MINUTE_MS = 60_000
const iso = (minutes: number): string => new Date(T0 + minutes * MINUTE_MS).toISOString()
const h = (minutes: number, by: string, what: string): TaskHistoryEntry => ({ at: iso(minutes), by, what })

const card = (over: Partial<TaskCard>): TaskCard => ({
  number: 7,
  title: 'A card',
  description: '',
  project: 'hive',
  agent: null,
  column: 'todo',
  order: 1,
  labels: [],
  blocked: null,
  blockedBy: [],
  links: [],
  comments: [],
  history: [],
  archived: false,
  createdAt: iso(0),
  createdBy: 'You',
  updatedAt: iso(0),
  ...over
})

// #607's history as it was: built by HB5, reviewed by HR5 in three rounds.
const LOOP = [
  h(0, 'Assistant', 'Created in On Hold'),
  h(1, 'Assistant', 'Moved to the bottom of Todo'),
  h(10, 'HB5 (hive)', 'Given to HB5'),
  h(10, 'HB5 (hive)', 'Moved to Doing'),
  h(40, 'HB5 (hive)', 'Moved to Review'),
  h(41, 'HR5 (hive)', 'Started reviewing'),
  h(45, 'HR5 (hive)', 'Review failed'),
  h(52, 'HB5 (hive)', 'Returned for review, round 2'),
  h(53, 'HR5 (hive)', 'Started reviewing'),
  h(56, 'HR5 (hive)', 'Review passed'),
  h(56, 'HR5 (hive)', 'Moved to Passed'),
  h(90, 'HB5 (hive)', 'Moved to Done')
]

describe('holds', () => {
  it('reads who held a card when from its history', () => {
    const held = holdsFromHistory(card({ history: LOOP, agent: 'a-1', agentName: 'HB5', column: 'done' }))
    expect(held).toEqual([
      { agent: 'a-1', name: 'HB5', role: 'build', from: iso(10), to: iso(40) },
      { name: 'HR5', role: 'review', from: iso(41), to: iso(45) },
      { name: 'HR5', role: 'review', from: iso(53), to: iso(56) }
    ])
  })

  it('counts the time between a failed review and the return as nobody’s (a card in Review is not in Doing)', () => {
    // Moved back to Doing to fix, then returned: the builder holds it again for the fix.
    const history = [...LOOP.slice(0, 7), h(46, 'HB5 (hive)', 'Moved to Doing'), h(52, 'HB5 (hive)', 'Moved to Review; Returned for review, round 2'), h(53, 'HR5 (hive)', 'Started reviewing')]
    const held = holdsFromHistory(card({ history, agent: 'a-1', agentName: 'HB5' }))
    expect(held.filter((x) => x.role === 'build').map((x) => [x.from, x.to])).toEqual([
      [iso(10), iso(40)],
      [iso(46), iso(52)]
    ])
    expect(held.at(-1)).toMatchObject({ role: 'review', from: iso(53) })
    expect(held.at(-1)!.to).toBeUndefined()
  })

  it('keeps holds as the card changes, starting from its history', () => {
    const c = card({ history: LOOP.slice(0, 4), agent: 'a-1', agentName: 'HB5', column: 'doing' })
    trackHolds(c, iso(20))
    expect(c.held).toEqual([{ agent: 'a-1', name: 'HB5', role: 'build', from: iso(10) }])
    c.column = 'review'
    trackHolds(c, iso(40))
    c.review = { agent: 'a-2', agentName: 'HR5', since: iso(41) }
    trackHolds(c, iso(41))
    expect(c.held).toEqual([
      { agent: 'a-1', name: 'HB5', role: 'build', from: iso(10), to: iso(40) },
      { agent: 'a-2', name: 'HR5', role: 'review', from: iso(41) }
    ])
    // Saved again with nothing changed: nothing new.
    trackHolds(c, iso(42))
    expect(c.held).toHaveLength(2)
  })

  it('gives a card nobody held no holds', () => {
    const c = card({ history: LOOP.slice(0, 2) })
    trackHolds(c, iso(5))
    expect(c.held).toBeUndefined()
  })

  it('reads only well-formed holds from a file', () => {
    expect(holdsOf(undefined)).toEqual({})
    expect(holdsOf([{ name: 'B', role: 'build', from: iso(0) }, { name: 'B', role: 'boss', from: iso(0) }, { role: 'build', from: iso(0) }, { name: 'B', role: 'review', from: 'soon', to: iso(1) }])).toEqual({ held: [{ name: 'B', role: 'build', from: iso(0) }] })
  })

  it('counts review rounds', () => {
    expect(cardRounds(card({ history: LOOP, column: 'done' }))).toBe(2)
    expect(cardRounds(card({ history: LOOP.slice(0, 7), column: 'review' }))).toBe(1)
    expect(cardRounds(card({ history: LOOP.slice(0, 8), column: 'review' }))).toBe(2)
    expect(cardRounds(card({ history: LOOP.slice(0, 4), column: 'doing' }))).toBe(0)
  })
})

describe('spans', () => {
  it('merges and subtracts', () => {
    expect(mergeSpans([[5, 9], [1, 3], [2, 4], [9, 9]])).toEqual([[1, 4], [5, 9]])
    expect(subtractSpans([[0, 10]], [[2, 3], [5, 7]])).toEqual([[0, 2], [3, 5], [7, 10]])
    expect(subtractSpans([[0, 10]], [[0, 10]])).toEqual([])
  })

  it('shares time an agent held several cards between them, marked ≈', () => {
    // Held 0–10; another card 4–6 and a third 5–20: 0–4 alone, 4–5 with one other, 5–6 with two, 6–10 with one.
    const shared = sharedSpans([[0, 10]], [[[4, 6]], [[5, 20]]])
    expect(Object.fromEntries(shared)).toEqual({ 1: [[0, 4]], 2: [[4, 5], [6, 10]], 3: [[5, 6]] })
    expect(Object.fromEntries(sharedSpans([[0, 10]], []))).toEqual({ 1: [[0, 10]] })
    const part = { ...emptyPart(), inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, requests: 2, cost: 1, priced: 1 }
    expect(scalePart(part, 0.5)).toEqual({ ...part, inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, requests: 1, cost: 0.5, estimated: true, tokensEstimated: true })
    expect(scalePart(part, 1)).toBe(part)
  })
})

const S = (minutes: number, seconds = 0): number => Math.floor((T0 + minutes * MINUTE_MS) / 1000) + seconds
const tokens = (input: number, output = 0) => ({ inputTokens: input, outputTokens: output, cacheWriteTokens: 0, cacheReadTokens: 0 })

describe('timeline', () => {
  it('sums usage by second, report and flags', () => {
    const b = new TimelineBuilder()
    b.add(iso(0), { inputTokens: 10 }, 1)
    b.add(T0 + 400, { outputTokens: 5 }, 1)
    b.add(T0 + 600, { outputTokens: 1 }, 1, 0)
    b.add(undefined, { inputTokens: 99 })
    expect(b.timeline([0.5])).toEqual({
      step: 1,
      reports: [0.5],
      rows: [
        [S(0), 10, 5, 0, 0, 2, -1, 0],
        [S(0), 0, 1, 0, 0, 1, 0, 0]
      ]
    })
    expect(readTimeline(b.timeline([0.5]))).not.toBeNull()
    // A row naming a charge there isn't has none; read back, a row naming one, a row of the old shape, and no reports:
    // not a timeline (read again).
    expect(b.timeline().rows.map((r) => r[6])).toEqual([-1, -1])
    expect(readTimeline({ step: 1, rows: [[1, 2, 3, 4, 5, 6, 0, 0]], reports: [] })).toBeNull()
    expect(readTimeline({ step: 1, rows: [[1, 2, 3, 4, 5, 6]], reports: [] })).toBeNull()
    expect(readTimeline({ step: 1, rows: [] })).toBeNull()
    expect(readTimeline('x')).toBeNull()
  })

  it('spreads a total over its requests and keeps requests without tokens apart', () => {
    const b = new TimelineBuilder()
    spreadTokens(b, [{ second: S(2), report: 0 }, { second: S(3), report: 0 }, { second: S(3), report: 0 }, { second: S(3), report: -1 }], tokens(101), iso(9))
    expect(b.timeline([1]).rows).toEqual([
      [S(2), 25, 0, 0, 0, 1, 0, TOKENS_SPREAD],
      [S(3), 50, 0, 0, 0, 2, 0, TOKENS_SPREAD],
      [S(3), 26, 0, 0, 0, 1, -1, TOKENS_SPREAD]
    ])
    expect(pendingRows([{ second: S(1), report: -1 }, { second: S(1), report: -1 }])).toEqual([[S(1), 0, 0, 0, 0, 2, -1, TOKENS_UNKNOWN]])
  })

  it('merges a very long session into longer steps, keeping its totals', () => {
    const b = new TimelineBuilder()
    for (let i = 0; i <= MAX_ROWS; i++) b.add(T0 + i * 1000, { inputTokens: 1 }, 1)
    const t = b.timeline()
    expect(t.step).toBe(10)
    expect(t.rows.length).toBeLessThanOrEqual(MAX_ROWS)
    expect(t.rows.every((r) => r[0] % 10 === 0)).toBe(true)
    expect(t.rows.reduce((n, r) => n + r[1], 0)).toBe(MAX_ROWS + 1)
  })

  it('merges charges with their rows, so a session with a charge per request is bounded too (HR5 round 2)', () => {
    // A report per request, one a second, past the limit: merging rows alone could never get under it.
    const b = new TimelineBuilder()
    const n = MAX_ROWS + 1
    for (let i = 0; i < n; i++) b.add(T0 + i * 1000, { inputTokens: 10 }, 1, i)
    const t = b.timeline(Array.from({ length: n }, () => 0.01))
    expect(t.step).toBe(10)
    expect(t.rows.length).toBeLessThanOrEqual(MAX_ROWS)
    expect(t.reports.length).toBeLessThanOrEqual(t.rows.length)
    expect(readTimeline(t)).not.toBeNull()
    // Every charge kept, none twice; tokens and requests too.
    expect(t.reports.reduce((a, x) => a + x, 0)).toBeCloseTo(n * 0.01, 9)
    expect(t.rows.reduce((a, r) => a + r[1], 0)).toBe(n * 10)
    expect(t.rows.reduce((a, r) => a + r[5], 0)).toBe(n)
    // The whole session's charges are exact; a hold taking part of a merged step's charge gets an estimate.
    const slice: SessionSlice = { usage: { provider: 'claude-code', model: 'claude-sonnet-5-5' } as SessionUsage, timeline: t, from: T0, to: T0 + n * 1000 }
    const whole = sliceSession(slice, [[T0, T0 + (n + 10) * 1000]], DEFAULT_SETTINGS)!
    expect(whole.cost).toBeCloseTo(n * 0.01, 6)
    expect(whole.estimated).toBe(false)
    const part = sliceSession(slice, [[T0, T0 + 5000]], DEFAULT_SETTINGS)!
    expect(part.cost).toBeCloseTo(0.05, 6)
    expect(part.estimated).toBe(true)
  })

  it('merges charges in one second, and leaves out charges no request refers to', () => {
    const b = new TimelineBuilder()
    for (let i = 0; i <= MAX_ROWS; i++) b.add(T0, { inputTokens: 1 }, 1, i)
    const t = b.timeline([...Array.from({ length: MAX_ROWS + 1 }, () => 1), 5])
    expect(t).toEqual({ step: 10, rows: [[S(0), MAX_ROWS + 1, 0, 0, 0, MAX_ROWS + 1, 0, 0]], reports: [MAX_ROWS + 1] })
    expect(new TimelineBuilder().timeline([3])).toEqual({ step: 1, rows: [], reports: [] })
  })

  it('comes from each provider’s parser, with the charges that cover each request', () => {
    const p = new ClaudeUsageParser('s')
    const reply = (ts: string, id: string, n: number) => ({ type: 'assistant', requestId: id, timestamp: ts, message: { model: 'claude-sonnet-5-5', usage: { input_tokens: n, output_tokens: n } } })
    const cost = (ts: string, total: number) => ({ type: 'cost-state', timestamp: ts, totalCostUSD: total })
    p.feed([reply(iso(0), 'r1', 10), reply(iso(0), 'r1', 10), cost(iso(1), 10), reply(iso(5), 'r2', 20), cost(iso(6), 11), reply(iso(7), 'r3', 5)].map((l) => JSON.stringify(l)).join('\n') + '\n')
    expect(p.result().timeline).toEqual({
      step: 1,
      reports: [10, 1],
      // Each request with the model it ran on (#1106).
      models: ['claude-sonnet-5-5'],
      rows: [
        [S(0), 10, 10, 0, 0, 1, 0, 0, 0],
        [S(5), 20, 20, 0, 0, 1, 1, 0, 0],
        [S(7), 5, 5, 0, 0, 1, -1, 0, 0]
      ]
    })

    const tc = (ts: string, input: number, output: number) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output }, last_token_usage: { input_tokens: 1, output_tokens: 1 } } } })
    const codex = parseRollout([tc(iso(0), 100, 10), tc(iso(3), 250, 30)].map((l) => JSON.stringify(l)).join('\n'), 'c')
    expect(codex.timeline).toEqual({
      step: 1,
      reports: [],
      rows: [
        [S(0), 100, 10, 0, 0, 1, -1, 0],
        [S(3), 150, 20, 0, 0, 1, -1, 0]
      ]
    })

    // Copilot: two requests, a charge covering them, then a third; tokens only at exit.
    const line = (type: string, timestamp: string, data: Record<string, unknown>): string => JSON.stringify({ type, data, timestamp }) + '\n'
    const live = line('assistant.message', iso(0), {}) + line('assistant.message', iso(2), {}) + line('session.usage_checkpoint', iso(2), { totalNanoAiu: 2e9 }) + line('assistant.message', iso(3), {})
    expect(parseEvents(live, 'p').timeline).toEqual({
      step: 1,
      reports: [0.02],
      rows: [
        [S(0), 0, 0, 0, 0, 1, 0, TOKENS_UNKNOWN],
        [S(2), 0, 0, 0, 0, 1, 0, TOKENS_UNKNOWN],
        [S(3), 0, 0, 0, 0, 1, -1, TOKENS_UNKNOWN]
      ]
    })
    const ended = parseEvents(live + line('session.usage_checkpoint', iso(3), { totalNanoAiu: 2e9 }) + line('session.shutdown', iso(4), { modelMetrics: { 'gpt-4.1': { usage: { inputTokens: 90, outputTokens: 30 } } } }), 'p')
    // The second checkpoint charged nothing more: the third request is known to have cost $0.
    expect(ended.timeline).toEqual({
      step: 1,
      reports: [0.02, 0],
      rows: [
        [S(0), 30, 10, 0, 0, 1, 0, TOKENS_SPREAD],
        [S(2), 30, 10, 0, 0, 1, 0, TOKENS_SPREAD],
        [S(3), 30, 10, 0, 0, 1, 1, TOKENS_SPREAD]
      ]
    })
  })

  it('is left out of priced usage', () => {
    const p = new ClaudeUsageParser('s')
    p.feed(JSON.stringify({ type: 'assistant', requestId: 'r', timestamp: iso(0), message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 1 } } }) + '\n')
    const { timeline: _t, ...raw } = p.result()
    expect(priceUsage(raw, DEFAULT_SETTINGS).timeline).toBeUndefined()
  })
})

describe('sliceSession', () => {
  const usage = (over: Partial<SessionUsage> = {}): SessionUsage => ({ provider: 'claude-code', sessionId: 's', title: null, model: 'claude-sonnet-5-5', cliVersion: null, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requests: 0, reasoningTokens: 0, contextTokens: 0, contextWindow: null, compactions: [], cacheTtlSeconds: 0, firstActivity: iso(0), lastActivity: iso(10), userMessages: 1, lastPrompt: null, costUsd: null, costEstimated: false, ...over })
  const slice = (timeline: UsageTimeline | null, over: Partial<SessionUsage> = {}): SessionSlice => ({ usage: usage(over), timeline, from: T0, to: T0 + 11 * MINUTE_MS })
  const held = (fromMin: number, toMin: number): Span[] => [[T0 + fromMin * MINUTE_MS, T0 + toMin * MINUTE_MS]]

  it('gives each card the charges that covered its own requests, exactly (HR5 round 1)', () => {
    // Equal requests: A while card A was held, a report at $10; B while card B was, a report at $11.
    const t: UsageTimeline = { step: 1, reports: [10, 1], rows: [[S(0, 10), 100, 10, 0, 0, 1, 0, 0], [S(5, 10), 100, 10, 0, 0, 1, 1, 0]] }
    const a = sliceSession(slice(t), held(0, 4), DEFAULT_SETTINGS)!
    const b = sliceSession(slice(t), held(5, 9), DEFAULT_SETTINGS)!
    expect(a).toMatchObject({ cost: 10, estimated: false, priced: 1, unpriced: 0, inputTokens: 100, requests: 1 })
    expect(b).toMatchObject({ cost: 1, estimated: false, priced: 1 })
    // Not active in the span at all.
    expect(sliceSession(slice(t), held(2, 4), DEFAULT_SETTINGS)).toBeNull()
  })

  it('splits a charge between its requests by Combwork’s estimate where a card took only some of them, marked ≈', () => {
    const t: UsageTimeline = { step: 1, reports: [3], rows: [[S(0), 100, 0, 0, 0, 1, 0, 0], [S(1), 200, 0, 0, 0, 1, 0, 0]] }
    const first = sliceSession(slice(t), held(0, 0.5), DEFAULT_SETTINGS)!
    expect(first.cost).toBeCloseTo(1, 10)
    expect(first.estimated).toBe(true)
  })

  it('estimates what no charge covers (≈), and everything with the user’s own prices', () => {
    const t: UsageTimeline = { step: 1, reports: [10], rows: [[S(0), 1000, 0, 0, 0, 1, 0, 0], [S(5), 1000, 0, 0, 0, 1, -1, 0]] }
    const after = sliceSession(slice(t), held(4, 6), DEFAULT_SETTINGS)!
    const price = estimateCost({ provider: 'claude-code', model: 'claude-sonnet-5-5', ...tokens(1000) }, DEFAULT_SETTINGS)!
    expect(after).toMatchObject({ estimated: true, priced: 1 })
    expect(after.cost).toBeCloseTo(price, 10)
    const own = { providers: { ...DEFAULT_SETTINGS.providers, 'claude-code': { ...DEFAULT_SETTINGS.providers['claude-code'], costSource: 'prices' } } } as never
    const mine = sliceSession(slice(t), held(0, 1), own)!
    expect(mine).toMatchObject({ estimated: true, priced: 1 })
    expect(mine.cost).toBeCloseTo(price, 10)
  })

  it('says unknown where it can’t place usage in time or has no price, never $0', () => {
    expect(sliceSession(slice(null), held(0, 1), DEFAULT_SETTINGS)).toMatchObject({ unpriced: 1, priced: 0, tokensUnknown: 1 })
    const t: UsageTimeline = { step: 1, reports: [], rows: [[S(0), 100, 10, 0, 0, 1, -1, 0]] }
    const unpriced = sliceSession(slice(t, { model: 'no-such-model' }), held(0, 1), DEFAULT_SETTINGS)!
    expect(unpriced).toMatchObject({ unpriced: 1, priced: 0, inputTokens: 100, tokensUnknown: 0 })
    expect(partCost(unpriced)).toBe('Unknown')
  })

  it('keeps Copilot’s tokens unknown until it gives them, and its spread shares ≈, its charges exact (HR5 round 1)', () => {
    const copilot = { provider: 'copilot' as const, model: 'gpt-4.1' }
    const live: UsageTimeline = { step: 1, reports: [0.02], rows: [[S(0), 0, 0, 0, 0, 1, 0, TOKENS_UNKNOWN]] }
    const now = sliceSession(slice(live, copilot), held(0, 1), DEFAULT_SETTINGS)!
    expect(now).toMatchObject({ cost: 0.02, estimated: false, priced: 1, unpriced: 0, tokensUnknown: 1, inputTokens: 0, requests: 1 })
    expect(partTokens(now)).toBe('tokens unknown · 1 request')
    // A request no charge covers yet, tokens unknown: no cost either.
    const open: UsageTimeline = { step: 1, reports: [], rows: [[S(0), 0, 0, 0, 0, 1, -1, TOKENS_UNKNOWN]] }
    expect(sliceSession(slice(open, copilot), held(0, 1), DEFAULT_SETTINGS)).toMatchObject({ priced: 0, unpriced: 1, tokensUnknown: 1 })
    const ended: UsageTimeline = { step: 1, reports: [0.02], rows: [[S(0), 30, 10, 0, 0, 1, 0, TOKENS_SPREAD]] }
    const after = sliceSession(slice(ended, copilot), held(0, 1), DEFAULT_SETTINGS)!
    expect(after).toMatchObject({ cost: 0.02, estimated: false, tokensEstimated: true, tokensUnknown: 0 })
    expect(plain(partTokens(after))).toBe('≈ in 30 · out 10 · cache write 0 · cache read 0 · 1 request')
  })
})

const plain = (s: string): string => s.replace(/ /g, ' ')

describe('cost line', () => {
  it('reads as the decision says', () => {
    // costText's non-breaking spaces, as plain ones.
    const cardCostLine = (c: CardCost): string => plain(costLine(c))
    const part = { ...emptyPart(), inputTokens: 1, outputTokens: 1, requests: 1, cost: 1.84, estimated: true, priced: 2 }
    const c = { number: 1, title: 't', project: 'hive', column: 'done', rounds: 2, build: part, review: part, total: part, lastHeld: null, unmatched: 0 } satisfies CardCost
    expect(cardCostLine(c)).toBe('cost: ≈ $1.84 · 2 rounds')
    expect(cardCostLine({ ...c, rounds: 0, total: { ...part, priced: 0, unpriced: 1 } })).toBe('cost: Unknown')
    expect(cardCostLine({ ...c, rounds: 1, total: { ...part, estimated: false, unpriced: 1 } })).toBe('cost: $1.84 + ? · 1 round')
  })
})
