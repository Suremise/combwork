import type { AppSettings, ModelCatalog, ModelPrice, ProviderId, SessionUsage } from './types'
import { CLAUDE_CODE, baseModel } from './claude'
import { CODEX } from './codex'
import { COPILOT } from './copilot'
import { ANTIGRAVITY } from './antigravity'
import { OPENCODE } from './opencode'
import { providerDescriptor, providerSettings } from './providers'
import { msg, tr } from './i18n'

/**
 * API prices Combwork ships, in USD per million tokens, for estimating what a session would have cost at
 * API rates (the Overview's "≈ cost"). They are editable defaults, never fetched (#125): in Settings → <provider> → API
 * prices the user can change, add and remove models, and Reset to defaults; only their changes are stored, so a later
 * Combwork's prices still reach models they never edited. Claude Code reports its own cost, so its table is only a fallback
 * for sessions without one, unless the user chooses their prices over the report (`costSource`, #436). Each table also
 * lists the models the CLI has (its model list), priced or not, so a model a CLI update adds shows without a Combwork release.
 *
 * Sources, each provider's checked on its date in PRICES_CHECKED: Anthropic's model table (Claude API docs; cache writes
 * 1.25× input and cache reads 0.1× input unless listed) and OpenAI's API pricing page (developers.openai.com/api/docs/pricing,
 * standard tier). A model with no published price (Codex's own `codex-auto-review`, its approval reviewer) has no row:
 * its sessions show as unpriced, never $0.
 */
const claude = (input: number, output: number, cachedInput = input / 10): ModelPrice => ({ input, output, cachedInput, cacheWrite: input * 1.25 })
const openai = (input: number, cachedInput: number, output: number, cacheWrite?: number): ModelPrice => ({ input, cachedInput, output, ...(cacheWrite !== undefined ? { cacheWrite } : {}) })

/** When each provider's shipped prices were last checked against its published ones (Settings → <provider> → API prices says so). */
export const PRICES_CHECKED: Record<ProviderId, string> = { [CLAUDE_CODE]: '2026-09-30', [CODEX]: '2026-11-07', [COPILOT]: '2026-09-30', [ANTIGRAVITY]: '2026-11-07', [OPENCODE]: '2026-11-09' }

export const SHIPPED_PRICES: Record<ProviderId, Record<string, ModelPrice>> = {
  [CLAUDE_CODE]: {
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
  [CODEX]: {
    // All checked against OpenAI's pricing page on 7 Nov 2026 (HI-2675): unchanged but for gpt-6.1-terra, added. Prompts
    // over 272K input tokens cost more (2× input and cached, 1.5× output); not modelled. GPT-5.6 Sol's is a promotional
    // price, to 30 Nov 2026 by that page.
    // Codex's default from 0.160 (Oct 2026): OpenAI's model page (developers.openai.com/api/docs/models/gpt-6.1-sol),
    // checked 5 Oct 2026, with cache writes at $2.50 (Codex reports none today).
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
  },
  // GitHub Copilot reports each session's cost itself, in AI credits ($0.01 each, charged at each model's API rate):
  // no table ships. Prices a user adds are used for sessions without a reported cost.
  [COPILOT]: {},
  // Antigravity runs against the user's Google plan and publishes no per-token prices (checked 7 Nov 2026, HI-2544): no
  // table ships, and its sessions show as unpriced. Prices a user adds are used.
  [ANTIGRAVITY]: {},
  // OpenCode reaches many vendors' models through the account's own sign-ins and keys, each priced by its vendor (checked
  // 9 Nov 2026, HI-2759): no table ships, and its sessions show as unpriced. Prices a user adds are used.
  [OPENCODE]: {}
}

/** Claude Code's aliases, and the dated ids its transcripts show, map to the table's ids. */
const CLAUDE_ALIASES: Record<string, string> = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }

function priceKey(provider: ProviderId, model: string): string {
  const m = model.trim().toLowerCase()
  if (provider !== CLAUDE_CODE) return m
  const base = baseModel(m)
  return CLAUDE_ALIASES[base] ?? base.replace(/-\d{8}$/, '')
}

/** The price for a model: the user's override, else the shipped one (unless they removed it); null when unknown. */
export function modelPrice(provider: ProviderId, model: string | null | undefined, settings?: Pick<AppSettings, 'providers'> | null): ModelPrice | null {
  if (!model) return null
  const key = priceKey(provider, model)
  const ps = settings?.providers?.[provider]
  const own = ps?.prices ?? {}
  const removed = ps?.pricesRemoved ?? []
  return own[key] ?? own[model] ?? (removed.includes(key) ? null : (SHIPPED_PRICES[provider]?.[key] ?? null))
}

/** The models a CLI lists (#436), as its price table names them (an alias by the id it stands for); null without a list. */
export function listedPriceModels(provider: ProviderId, catalog: Pick<ModelCatalog, 'models'> | null | undefined): string[] | null {
  if (!catalog?.models.length) return null
  return [...new Set(catalog.models.map((m) => priceKey(provider, m.resolved ?? m.value)).filter(Boolean))]
}

export interface PriceRow {
  model: string
  /** Null: no price yet ("No price: enter one"), a model only the CLI's list has. */
  price: ModelPrice | null
  shipped: boolean
  edited: boolean
  /** Whether the CLI lists it; null when there is no list to tell (the CLI couldn't be asked). */
  listed: boolean | null
}

/**
 * A provider's price table as Settings shows it: the shipped models not removed, then the user's own, then the models
 * the CLI lists (`listed`, from listedPriceModels) that have no price, each with its price. A priced model the CLI no
 * longer lists stays (for older sessions), marked.
 */
export function priceRows(provider: ProviderId, settings?: Pick<AppSettings, 'providers'> | null, listed?: readonly string[] | null): PriceRow[] {
  const ps = settings?.providers?.[provider]
  const own = ps?.prices ?? {}
  const removed = new Set(ps?.pricesRemoved ?? [])
  const shipped = SHIPPED_PRICES[provider] ?? {}
  const models = [...Object.keys(shipped).filter((m) => !removed.has(m) || own[m]), ...Object.keys(own).filter((m) => !shipped[m])]
  const known = new Set(models.map((m) => priceKey(provider, m)))
  const unpriced = (listed ?? []).filter((m) => !known.has(m) && !modelPrice(provider, m, settings))
  const inList = listed ? new Set(listed) : null
  return [
    ...models.map((m) => ({ model: m, price: own[m] ?? shipped[m], shipped: !!shipped[m], edited: !!own[m], listed: inList ? inList.has(priceKey(provider, m)) : null })),
    ...unpriced.map((m) => ({ model: m, price: null, shipped: false, edited: false, listed: true }))
  ]
}

/**
 * Whether a provider's session costs come from Combwork's price table rather than the CLI's own report (#436): only for a
 * provider that reports one (capabilities.reportsCost), when the user chose their prices. Combwork never recomputes a
 * reported cost otherwise, even when the CLI's own price table lags a price change (#442).
 */
export function usesOwnPrices(provider: ProviderId, settings?: Pick<AppSettings, 'providers'> | null): boolean {
  return providerDescriptor(provider).capabilities.reportsCost && providerSettings(settings, provider).costSource === 'prices'
}

/**
 * The model when Combwork can't estimate its sessions' cost because it has no price for it (shipped or the user's), so the
 * cost shows as unknown rather than missing or $0; null when it has a price or there is no model to price.
 */
export function unpricedModel(provider: ProviderId, model: string | null | undefined, settings?: Pick<AppSettings, 'providers'> | null): string | null {
  return model && !modelPrice(provider, model, settings) ? model : null
}

const UNPRICED = msg({
  id: 'project.cost.unpriced',
  defaultMessage: "Combwork has no API price for {model}, so it can't estimate this session's cost. Add one in Settings → {provider} → API prices.",
  description: 'Tooltip on a cost shown as Unknown. {model} is the model; {provider} the provider (Claude Code, Codex…). Settings → {provider} → API prices is where prices are set: name it as Settings does.'
})

/** What to say about a cost that is unknown because the model has no price: where to add one. */
export const unpricedText = (model: string, providerName: string): string => tr(UNPRICED, { model, provider: providerName })

const ZERO_REPORTED = msg({
  id: 'project.cost.zeroReported',
  defaultMessage: '{provider} reported this session’s cost as $0. A subscription, a free model or a model on this PC can still use your plan’s allowance: $0 isn’t a measure of it.',
  description: "Added to the hover of a session's cost when the coding agent itself reported $0 for a session that used tokens (HI-2762: OpenCode gives $0 for a model it has no price for). {provider} is the coding agent (OpenCode…). $0 is the amount as shown: keep it."
})

/**
 * A reported cost of $0 for a session that used tokens (HI-2762): said as such, never a price (a subscription's or a local
 * model's use isn't free of allowance). Null when it doesn't apply: an estimate, a cost above 0, or no tokens.
 */
export function zeroCostNote(cost: number | null, estimated: boolean, tokens: number, providerName: string): string | null {
  return cost === 0 && !estimated && tokens > 0 ? tr(ZERO_REPORTED, { provider: providerName }) : null
}

/** A session's API-equivalent cost from its token counts; null when the model's price is unknown. */
export function estimateCost(usage: Pick<SessionUsage, 'provider' | 'model' | 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens'>, settings?: Pick<AppSettings, 'providers'> | null): number | null {
  const p = modelPrice(usage.provider, usage.model, settings)
  if (!p) return null
  const perM = (tokens: number, price: number): number => (tokens / 1_000_000) * price
  return perM(usage.inputTokens, p.input) + perM(usage.cacheReadTokens, p.cachedInput) + perM(usage.cacheWriteTokens, p.cacheWrite ?? p.input) + perM(usage.outputTokens, p.output)
}
