import type { ModelPrice } from '../../types'
import type { ProviderPrices } from '../parts'

/** OpenAI's prices: its API pricing page (developers.openai.com/api/docs/pricing), standard tier. */
const openai = (input: number, cachedInput: number, output: number, cacheWrite?: number): ModelPrice => ({ input, cachedInput, output, ...(cacheWrite !== undefined ? { cacheWrite } : {}) })

/**
 * Codex's shipped API prices (prices.ts says how they are used). A model with no published price (Codex's own
 * `codex-auto-review`, its approval reviewer) has no row: its sessions show as unpriced, never $0.
 */
export const CODEX_PRICES: ProviderPrices = {
  checked: '2026-11-22',
  shipped: {
    // All checked against OpenAI's pricing page on 7 Nov 2026 (HI-2675): unchanged but for gpt-6.1-terra, added. Prompts
    // over 272K input tokens cost more (2× input and cached, 1.5× output); not modelled. GPT-5.6 Sol's is a promotional
    // price, to 30 Nov 2026 by that page.
    // Codex's default from 0.160 (Oct 2026): OpenAI's model page (developers.openai.com/api/docs/models/gpt-6.1-sol),
    // checked 5 Oct 2026, with cache writes at $2.50 (Codex reports none today).
    // Codex's default from 0.169 (Nov 2026, HI-3492): OpenAI's pricing page and model page
    // (developers.openai.com/api/docs/models/gpt-6.2-sol), checked 21 Nov 2026, standard tier, the same as gpt-6.1-sol's;
    // its cache write is the 30-minute one.
    'gpt-6.2-sol': openai(2, 0.1, 10, 2.5),
    // HI-3497: OpenAI's pricing page and model page (developers.openai.com/api/docs/models/gpt-6.2-astra), checked
    // 22 Nov 2026, standard tier, short context; its cache write is the 30-minute one. No row for gpt-6.2-astra-law: the
    // pricing page marks its price as promotional, and it has no model page.
    'gpt-6.2-astra': openai(8, 0.4, 40, 10),
    'gpt-6.1-sol': openai(2, 0.1, 10, 2.5),
    'gpt-6.1-terra': openai(1, 0.05, 5),
    'gpt-6-astra': openai(10, 1, 50),
    'gpt-6-sol': openai(2, 0.2, 10),
    'gpt-6-luna': openai(0.1, 0.01, 0.5),
    'gpt-5.6-sol': openai(4, 0.4, 20),
    'gpt-5.6-terra': openai(2, 0.2, 12),
    'gpt-5.6-luna': openai(0.2, 0.02, 1.2),
    'gpt-5.5': openai(5, 0.5, 30),
    'gpt-5.3-codex': openai(1.75, 0.175, 14)
  }
}
