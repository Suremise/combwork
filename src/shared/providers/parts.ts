import type { ProviderDescriptor } from '.'
import type { ModelPrice } from '../types'
import type { Tip } from '../tips'
import type { AdvancedSource } from '../advancedDef'

/**
 * A provider's shared half (HI-3201): everything the window, the shared settings logic and main read about one provider
 * without its adapter. Each provider's folder under src/shared/providers exports one, and the registry lists them. It is
 * renderer-safe: no Node, no Electron, nothing from src/main.
 */
export interface ProviderModule {
  descriptor: ProviderDescriptor
  /** Its shipped API prices (shared/prices.ts). */
  prices: ProviderPrices
  /** Tips about it, listed with Combwork's own (shared/tips.ts). */
  tips?: readonly Tip[]
  /** What Combwork spots its safeguard stops by (#606), named defaults (shared/safeguards.ts gathers them). */
  safeguards?: Readonly<Record<string, string | readonly string[]>>
  /** Its advanced values (#367), in the order Settings lists them (advanced.ts gathers them). */
  advanced?: readonly AdvancedSource[]
  /** The address Combwork checks for its connection (HI-1612): a value of Combwork's own, listed under Combwork. */
  outageCheck?: AdvancedSource
}

/**
 * A provider's shipped API prices, in USD per million tokens, for estimating a session's cost (shared/prices.ts): editable
 * defaults the user can change in Settings. `checked`: the day they were last checked against the provider's published
 * ones. `key`: how a model (trimmed, in lower case) is named in the table, where the CLI uses other names for it (an
 * alias, a dated id); without it, as it is.
 */
export interface ProviderPrices {
  checked: string
  shipped: Record<string, ModelPrice>
  key?: (model: string) => string
}

/** A provider's shared half, typed: what each provider's index.ts exports as its default. */
export const defineProvider = (m: ProviderModule): ProviderModule => m
