import type { ProviderId } from '../../shared/types'
import { PROVIDERS } from '../../shared/providers'
import type { ProviderAdapter } from './types'
import { msg } from '../../shared/i18n/msg'
import { combworkError } from '../combworkError'

/**
 * Each provider's adapter (HI-3201), found in its folder here (<folder>/adapter.ts, its default export) and put in the
 * registry's order (shared/providers/registry.ts, which lists each provider once): adding a provider is its two folders and
 * the registry's line, with no list here.
 */
export function orderedAdapters(found: readonly ProviderAdapter[], ids: readonly ProviderId[]): ProviderAdapter[] {
  const seen = new Set<ProviderId>()
  for (const a of found) {
    if (seen.has(a.id)) throw new Error(`Two adapters for the provider "${a.id}"`) // i18n-ignore: a build mistake, for the developer
    seen.add(a.id)
    if (!ids.includes(a.id)) throw new Error(`The adapter for "${a.id}" has no line in shared/providers/registry.ts`) // i18n-ignore: a build mistake, for the developer
  }
  return ids.map((id) => {
    const a = found.find((x) => x.id === id)
    if (!a) throw new Error(`The provider "${id}" has no adapter in src/main/providers/<folder>/adapter.ts`) // i18n-ignore: a build mistake, for the developer
    return a
  })
}

const ADAPTERS: ProviderAdapter[] = orderedAdapters(
  Object.values(import.meta.glob<ProviderAdapter>('./*/adapter.ts', { eager: true, import: 'default' })),
  PROVIDERS.map((d) => d.id)
)

export function allProviders(): ProviderAdapter[] {
  return ADAPTERS
}

export function hasProvider(id: unknown): id is ProviderId {
  return ADAPTERS.some((a) => a.id === id)
}

/** A provider id this version doesn't know (#842): read by the window and agents alike, so a CombworkError. */
const UNKNOWN = msg({ id: 'providers.unknown', defaultMessage: 'Unknown provider "{provider}". It may need a newer version of Combwork.', description: 'An agent or a setting names a coding-agent CLI this version of Combwork doesn\'t know, as when a newer Combwork wrote it. {provider} is the id.' })

/** The adapter for a provider id; throws for an unknown one (e.g. a config written by a newer Combwork). */
export function provider(id: ProviderId): ProviderAdapter {
  const a = ADAPTERS.find((x) => x.id === id)
  if (!a) throw combworkError(UNKNOWN, { provider: String(id) }, { kind: 'invalid' })
  return a
}
