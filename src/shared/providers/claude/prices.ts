import type { ModelPrice } from '../../types'
import type { ProviderPrices } from '../parts'
import { baseModel } from './modelIds'

/** Anthropic's prices: cache writes 1.25× input and cache reads 0.1× input unless listed (the Claude API docs' model table). */
const claude = (input: number, output: number, cachedInput = input / 10): ModelPrice => ({ input, output, cachedInput, cacheWrite: input * 1.25 })

/** Claude Code's aliases, and the dated ids its transcripts show, map to the table's ids. */
const CLAUDE_ALIASES: Record<string, string> = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }

/** Claude Code's shipped API prices (prices.ts says how they are used), checked against Anthropic's model table. */
export const CLAUDE_PRICES: ProviderPrices = {
  checked: '2026-09-30',
  shipped: {
    'claude-fable-5-1': claude(10, 50, 0.25),
    'claude-fable-5': claude(10, 50),
    'claude-opus-5-5': claude(4, 20, 0.2),
    'claude-opus-5': claude(5, 25),
    'claude-opus-4-8': claude(5, 25),
    'claude-opus-4-7': claude(5, 25),
    'claude-opus-4-6': claude(5, 25),
    // Sonnet 5.5's cache reads are 0.05× input, $0.10 (#435): Anthropic's pricing page, checked 8 Oct 2026. Claude Code
    // agrees from 2.1.296 (its tier_2_10_cache_read_0_10 table, #442).
    'claude-sonnet-5-5': claude(2, 10, 0.1),
    'claude-sonnet-5': claude(2, 10),
    'claude-sonnet-4-6': claude(3, 15),
    // Haiku 5.5 (released 7 Oct 2026): Anthropic's pricing page, checked 8 Oct 2026, and the Claude Code 2.1.294 model catalog's
    // haiku_55 table (both agree). Prompts over 100,000 tokens cost more ($0.50 in, $2.50 out); not modelled, as Codex's
    // 272K prompts aren't.
    'claude-haiku-5-5': claude(0.1, 0.5),
    'claude-haiku-4-5': claude(1, 5)
  },
  key: (m) => {
    const base = baseModel(m)
    return CLAUDE_ALIASES[base] ?? base.replace(/-\d{8}$/, '')
  }
}
