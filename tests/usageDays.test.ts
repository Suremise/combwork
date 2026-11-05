// Usage by calendar day: the Overview's periods count only what happened in them.
import { describe, expect, it } from 'vitest'
import { ClaudeUsageParser, parseTranscript } from '../src/main/providers/claude/usage'
import { parseRollout } from '../src/main/providers/codex/rollout'
import { dayOffset, localDay, priceUsage, usageFrom, withDayCosts } from '../src/shared/usageDays'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import { estimateCost } from '../src/shared/prices'

// Local times, so the days are this machine's whatever its time zone.
const at = (day: number, hour: number): string => new Date(2026, 8, day, hour, 30).toISOString()
const usage = (n: number) => ({ input_tokens: n, output_tokens: n, cache_read_input_tokens: 10 * n, cache_creation_input_tokens: 0 })
const user = (ts: string, text: string) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
const reply = (ts: string, id: string, n: number) => ({ type: 'assistant', requestId: id, timestamp: ts, message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], usage: usage(n) } })

// A session over three days: Claude Code reports its running cost twice, once covering the 28th and 29th.
const lines = [
  user(at(28, 22), 'start'),
  reply(at(28, 22), 'r1', 100),
  user(at(29, 1), 'go on'),
  reply(at(29, 1), 'r2', 300),
  { type: 'cost-state', timestamp: at(29, 2), totalCostUSD: 1 },
  user(at(30, 9), 'more'),
  reply(at(30, 9), 'r3', 200),
  { type: 'cost-state', timestamp: at(30, 10), totalCostUSD: 1.5 },
  { type: 'system', subtype: 'compact_boundary', timestamp: at(30, 11), compactMetadata: { trigger: 'manual', preTokens: 1000, postTokens: 100 } },
  user(at(30, 12), 'last'),
  reply(at(30, 12), 'r4', 50)
]
const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

describe('usage by day', () => {
  it('puts each request, prompt and compaction on its own day', () => {
    const u = parseTranscript(text, 's')
    expect(Object.keys(u.days!).sort()).toEqual([localDay(at(28, 22)), localDay(at(29, 1)), localDay(at(30, 9))])
    expect(u.days![localDay(at(28, 22))].inputTokens).toBe(100)
    expect(u.days![localDay(at(29, 1))].prompts).toBe(1)
    expect(u.days![localDay(at(30, 9))]).toMatchObject({ requests: 2, prompts: 2, compactions: 1, inputTokens: 250 })
    expect(u.inputTokens).toBe(650)
  })

  it("shares each cost report between the days it covered, and the days add up to the session's cost", () => {
    const u = withDayCosts(parseTranscript(text, 's'), DEFAULT_SETTINGS)
    const d28 = u.days![localDay(at(28, 22))].costUsd!
    const d29 = u.days![localDay(at(29, 1))].costUsd!
    // The first report ($1) covered 100 then 300 tokens' worth: shared 1 : 3.
    expect(d28 + d29).toBeCloseTo(1, 6)
    expect(d29 / d28).toBeCloseTo(3, 6)
    // The 30th: the second report's $0.50, plus Combwork's estimate for r4 (after the last report).
    const d30 = u.days![localDay(at(30, 9))]
    expect(d30.costUsd!).toBeGreaterThan(0.5)
    expect(d30.costEstimated).toBe(true)
    expect(u.costReports).toBeUndefined()
  })

  it("Claude Code's reported cost by default; with the user's prices chosen, Combwork's estimate, each day too (#436)", () => {
    const raw = parseTranscript(text, 's')
    const reported = priceUsage(raw, DEFAULT_SETTINGS)
    // The last report ($1.50) plus Combwork's estimate for r4, after it.
    expect(reported.costUsd!).toBeGreaterThan(1.5)
    expect(reported.costUsd!).toBeLessThan(1.6)
    const mine = { providers: { ...DEFAULT_SETTINGS.providers, 'claude-code': { ...DEFAULT_SETTINGS.providers['claude-code'], costSource: 'prices' as const, prices: { 'claude-sonnet-5-5': { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 } } } } }
    const own = priceUsage(raw, mine)
    expect(own.costUsd).toBeCloseTo(estimateCost(raw, mine)!, 9)
    expect(own.costEstimated).toBe(true)
    const days = Object.values(own.days!)
    expect(days.reduce((n, d) => n + d.costUsd!, 0)).toBeCloseTo(own.costUsd!, 9)
    expect(days.every((d) => d.costEstimated)).toBe(true)
    // The parser's result is left as it was, for pricing again.
    expect(raw.costReports?.length).toBe(2)
    // No price for its model: the report stays.
    const unpriced = priceUsage({ ...raw, model: 'claude-unknown-9' }, mine)
    expect(unpriced.costUsd!).toBeGreaterThanOrEqual(1.5)
  })

  it('reads a growing transcript a piece at a time, the same as all at once', () => {
    const p = new ClaudeUsageParser('s')
    const cut = text.indexOf('\n', text.length / 2) + 1
    p.feed(text.slice(0, cut))
    p.feed(text.slice(cut))
    expect(p.result()).toEqual(parseTranscript(text, 's'))
  })

  it('counts what a period covers: today only, or from a day on', () => {
    const u = withDayCosts(parseTranscript(text, 's'), DEFAULT_SETTINGS)
    const today = usageFrom(u, localDay(at(30, 9)))
    expect(today).toMatchObject({ active: true, inputTokens: 250, prompts: 2, compactions: 1 })
    const all = usageFrom(u, null)
    expect(all.inputTokens).toBe(650)
    expect(usageFrom(u, localDay(at(31, 9))).active).toBe(false)
    // The days' costs add up to the session's whole cost.
    const sum = Object.values(u.days!).reduce((n, d) => n + d.costUsd!, 0)
    const tail = estimateCost({ provider: u.provider, model: u.model, inputTokens: 50, outputTokens: 50, cacheReadTokens: 500, cacheWriteTokens: 0 }, DEFAULT_SETTINGS)!
    expect(sum).toBeCloseTo(1.5 + tail, 6)
  })

  it("gives each day what Codex's running totals grew by", () => {
    const tc = (ts: string, input: number, cached: number, output: number) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }, last_token_usage: { input_tokens: 1, output_tokens: 1 } } } })
    const rollout = [
      { timestamp: at(28, 23), type: 'turn_context', payload: { model: 'gpt-5.5' } },
      { timestamp: at(28, 23), type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
      tc(at(28, 23), 1000, 400, 100),
      { timestamp: at(29, 8), type: 'event_msg', payload: { type: 'user_message', message: 'again' } },
      tc(at(29, 8), 3000, 2000, 300)
    ]
    const u = parseRollout(rollout.map((l) => JSON.stringify(l)).join('\n'), 'c')
    const first = u.days![localDay(at(28, 23))]
    const second = u.days![localDay(at(29, 8))]
    expect(first).toMatchObject({ inputTokens: 600, cacheReadTokens: 400, outputTokens: 100, prompts: 1, requests: 1 })
    expect(second).toMatchObject({ inputTokens: 400, cacheReadTokens: 1600, outputTokens: 200, prompts: 1 })
    expect(first.inputTokens + second.inputTokens).toBe(u.inputTokens)
  })

  it('counts calendar days back from today', () => {
    const noon = new Date(2026, 9, 1, 12).getTime()
    expect(dayOffset(noon, 0)).toBe('2026-10-01')
    expect(dayOffset(noon, -6)).toBe('2026-09-25')
  })
})
