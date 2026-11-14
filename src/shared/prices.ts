import type { AppSettings, ModelCatalog, ModelPrice, ProviderId, SessionUsage } from './types'
import { providerDescriptor, providerModule, providerSettings } from './providers'
import { PROVIDER_MODULES } from './providers/registry'
import { msg, tr } from './i18n'

/**
 * API prices Combwork ships, in USD per million tokens, for estimating what a session would have cost at
 * API rates (the Overview's "≈ cost"). They are editable defaults, never fetched (#125): in Settings → <provider> → API
 * prices the user can change, add and remove models, and Reset to defaults; only their changes are stored, so a later
 * Combwork's prices still reach models they never edited. Claude Code reports its own cost, so its table is only a fallback
 * for sessions without one, unless the user chooses their prices over the report (`costSource`, #436). Each table also
 * lists the models the CLI has (its model list), priced or not, so a model a CLI update adds shows without a Combwork release.
 *
 * Each provider's table, its sources and the date it was checked are in its shared half (src/shared/providers/<folder>,
 * `prices`). A model with no published price has no row: its sessions show as unpriced, never $0.
 */

/** When each provider's shipped prices were last checked against its published ones (Settings → <provider> → API prices says so). */
export const PRICES_CHECKED: Record<ProviderId, string> = Object.fromEntries(PROVIDER_MODULES.map((m) => [m.descriptor.id, m.prices.checked]))

/** Each provider's shipped prices, in USD per million tokens (its shared half's). */
export const SHIPPED_PRICES: Record<ProviderId, Record<string, ModelPrice>> = Object.fromEntries(PROVIDER_MODULES.map((m) => [m.descriptor.id, m.prices.shipped]))

/** A model as its provider's price table names it: in lower case, through the provider's own key (an alias by the id it stands for). */
function priceKey(provider: ProviderId, model: string): string {
  const m = model.trim().toLowerCase()
  const key = providerModule(provider)?.prices.key
  return key ? key(m) : m
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
  return !!providerDescriptor(provider).capabilities.usage?.reportsCost && providerSettings(settings, provider).costSource === 'prices'
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
