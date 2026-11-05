import { describe, expect, it } from 'vitest'
import { estimateCost, modelPrice, unpricedModel, unpricedText } from '../src/shared/prices'

const usage = (provider: string, model: string) => ({ provider, model, inputTokens: 1_000_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000, outputTokens: 100_000 })

describe('estimated cost', () => {
  it('prices Codex sessions from the table', () => {
    // gpt-6-luna: $0.10 input, $0.01 cached input, $0.50 output per million.
    expect(estimateCost({ ...usage('codex', 'gpt-6-luna'), cacheWriteTokens: 0 })).toBeCloseTo(0.1 + 0.02 + 0.05, 6)
  })
  it("prices GPT-6.1 Sol, Codex's default from 0.160, at OpenAI's published rates", () => {
    // OpenAI's model page (developers.openai.com, 5 Oct 2026).
    // $2 input, $0.10 cached input, $2.50 cache writes, $10 output per million.
    expect(modelPrice('codex', 'gpt-6.1-sol')).toEqual({ input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 })
    expect(modelPrice('codex', 'GPT-6.1-Sol')?.input).toBe(2)
    expect(estimateCost({ ...usage('codex', 'gpt-6.1-sol'), cacheWriteTokens: 0 })).toBeCloseTo(2 + 0.2 + 1, 6)
    // Cache writes at their own rate, not input's: 1M of them is $2.50.
    expect(estimateCost({ ...usage('codex', 'gpt-6.1-sol'), inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 })).toBeCloseTo(2.5, 6)
    // The others keep no cache-write price (input's applies).
    expect(modelPrice('codex', 'gpt-6-sol')?.cacheWrite).toBeUndefined()
  })
  it('a model without a price has an unknown cost, never $0, and says where to add one', () => {
    expect(estimateCost(usage('codex', 'gpt-9-nova'))).toBeNull()
    expect(unpricedModel('codex', 'gpt-9-nova')).toBe('gpt-9-nova')
    expect(unpricedModel('codex', 'gpt-6.1-sol')).toBeNull()
    expect(unpricedModel('codex', null)).toBeNull()
    // A price of the user's own counts.
    const settings = { providers: { codex: { prices: { 'gpt-9-nova': { input: 1, cachedInput: 0, output: 0 } } } } } as never
    expect(unpricedModel('codex', 'gpt-9-nova', settings)).toBeNull()
    expect(unpricedText('gpt-9-nova', 'Codex')).toMatch(/no API price for gpt-9-nova.*Settings → Codex → API prices/)
  })
  it('knows Claude aliases, 1M suffixes and dated ids', () => {
    expect(modelPrice('claude-code', 'opus')?.input).toBe(4)
    expect(modelPrice('claude-code', 'claude-sonnet-5-5[1m]')?.cachedInput).toBe(0.1)
    expect(modelPrice('claude-code', 'claude-haiku-4-5-20251001')?.cacheWrite).toBe(1.25)
    // Haiku 5.5, and the haiku alias now on it: Anthropic's $0.10 in, $0.50 out (prompts up to 100,000 tokens).
    expect(modelPrice('claude-code', 'haiku')).toEqual({ input: 0.1, output: 0.5, cachedInput: 0.01, cacheWrite: 0.125 })
    expect(modelPrice('claude-code', 'claude-haiku-5-5')?.output).toBe(0.5)
    expect(modelPrice('claude-code', 'claude-haiku-4-5')?.input).toBe(1)
    expect(modelPrice('claude-code', 'claude-unknown-9')).toBeNull()
  })
  it("prices Sonnet 5.5's cache reads at Anthropic's $0.10, 0.05× input (#435)", () => {
    // Anthropic's pricing page (platform.claude.com/docs/en/about-claude/pricing, 8 Oct 2026): $2 input, $2.50 five-minute
    // cache writes, $0.10 cache hits, $10 output per million.
    const sonnet55 = { input: 2, output: 10, cachedInput: 0.1, cacheWrite: 2.5 }
    expect(modelPrice('claude-code', 'claude-sonnet-5-5')).toEqual(sonnet55)
    expect(modelPrice('claude-code', 'sonnet')).toEqual(sonnet55)
    expect(modelPrice('claude-code', 'claude-sonnet-5-5-20260901')).toEqual(sonnet55)
    // 1M input, 2M cache reads, 100K cache writes, 100K output: 2 + 0.2 + 0.25 + 1.
    expect(estimateCost(usage('claude-code', 'sonnet'))).toBeCloseTo(3.45, 6)
    expect(estimateCost({ ...usage('claude-code', 'claude-sonnet-5-5'), inputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.1, 6)
    // The older models keep 0.1× input.
    expect(modelPrice('claude-code', 'claude-sonnet-5')?.cachedInput).toBe(0.2)
    expect(modelPrice('claude-code', 'claude-sonnet-4-6')?.cachedInput).toBeCloseTo(0.3, 9)
    // A price the user set for Sonnet 5.5 still wins, by its id or the alias.
    const own = { input: 2, output: 10, cachedInput: 0.2 }
    const settings = { providers: { 'claude-code': { prices: { 'claude-sonnet-5-5': own } } } } as never
    expect(modelPrice('claude-code', 'sonnet', settings)).toEqual(own)
    expect(estimateCost({ ...usage('claude-code', 'claude-sonnet-5-5'), inputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, settings)).toBeCloseTo(0.4, 6)
  })
  it("uses the user's prices over Combwork's", () => {
    const settings = { providers: { codex: { prices: { 'gpt-6-luna': { input: 1, cachedInput: 0, output: 0 } } } } } as never
    expect(estimateCost({ ...usage('codex', 'gpt-6-luna'), cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, settings)).toBeCloseTo(1, 6)
    expect(estimateCost(usage('codex', 'no-such-model'))).toBeNull()
  })
})
