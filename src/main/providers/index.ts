import type { ProviderId } from '../../shared/types'
import { BUILT_IN_PROVIDERS, PROVIDER_MODULES } from '../../shared/providers/registry'
import type { CliDescription } from '../../shared/providers/cliDescription'
import type { ProviderModule } from '../../shared/providers/parts'
import { CliAdapter } from './cliAdapter'
import type { ProviderAdapter } from './types'
import { msg } from '../../shared/i18n/msg'
import { combworkError } from '../combworkError'

/** The generic adapter for a module that is a description (HI-3196): a built-in data-only provider's, or a user's own CLI's. */
export const genericAdapter = (m: ProviderModule & { cli: CliDescription }): ProviderAdapter => new CliAdapter(m)

/**
 * Each provider's adapter (HI-3201), in the registry's order (shared/providers/registry.ts, which lists each provider
 * once): a full provider's found in its folder here (<folder>/adapter.ts, its default export); a data-only one's (its
 * shared half a description, HI-3196: no main folder) the generic adapter. Adding a provider is its folders and the
 * registry's line, with no list here.
 */
export function orderedAdapters(found: readonly ProviderAdapter[], modules: readonly ProviderModule[], generic: (m: ProviderModule & { cli: CliDescription }) => ProviderAdapter = genericAdapter): ProviderAdapter[] {
  const ids = modules.map((m) => m.descriptor.id)
  const seen = new Set<ProviderId>()
  for (const a of found) {
    if (seen.has(a.id)) throw new Error(`Two adapters for the provider "${a.id}"`) // i18n-ignore: a build mistake, for the developer
    seen.add(a.id)
    if (!ids.includes(a.id)) throw new Error(`The adapter for "${a.id}" has no line in shared/providers/registry.ts`) // i18n-ignore: a build mistake, for the developer
  }
  return modules.map((m) => {
    const id = m.descriptor.id
    const a = found.find((x) => x.id === id)
    if (m.cli) {
      if (a) throw new Error(`The provider "${id}" is a description (data-only) and has an adapter in src/main/providers too: one or the other`) // i18n-ignore: a build mistake, for the developer
      return generic({ ...m, cli: m.cli })
    }
    if (!a) throw new Error(`The provider "${id}" has no adapter in src/main/providers/<folder>/adapter.ts`) // i18n-ignore: a build mistake, for the developer
    return a
  })
}

const ADAPTERS: ProviderAdapter[] = orderedAdapters(
  Object.values(import.meta.glob<ProviderAdapter>('./*/adapter.ts', { eager: true, import: 'default' })),
  PROVIDER_MODULES.slice(0, BUILT_IN_PROVIDERS)
)

/**
 * The user's own CLIs' adapters (HI-3196: the generic adapter, one per description), after the built-in ones: a reload's
 * snapshot replaces them whole, in the same step as the shared registry's tail (main/clis.ts). A launch takes its own copy
 * at its start (forLaunch), so a reload never reaches it.
 */
export function registerCliAdapters(adapters: readonly ProviderAdapter[]): void {
  ADAPTERS.splice(BUILT_IN_PROVIDERS, ADAPTERS.length - BUILT_IN_PROVIDERS, ...adapters)
}

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
