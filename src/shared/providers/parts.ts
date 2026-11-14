import type { ProviderDescriptor } from '.'

/**
 * A provider's shared half (HI-3201): everything the window, the shared settings logic and main read about one provider
 * without its adapter. Each provider's folder under src/shared/providers exports one, and the registry lists them. It is
 * renderer-safe: no Node, no Electron, nothing from src/main.
 */
export interface ProviderModule {
  descriptor: ProviderDescriptor
}

/** A provider's shared half, typed: what each provider's index.ts exports as its default. */
export const defineProvider = (m: ProviderModule): ProviderModule => m
