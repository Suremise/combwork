import type { ProviderId } from '../../shared/types'
import { claudeCode } from './claude/adapter'
import { codex } from './codex/adapter'
import { copilot } from './copilot/adapter'
import type { ProviderAdapter } from './types'
import { msg } from '../../shared/i18n/msg'
import { hiveError } from '../combworkError'

/** Every provider adapter, in display order. Adding a provider: its descriptor in shared/providers.ts and its adapter here. */
const ADAPTERS: ProviderAdapter[] = [claudeCode, codex, copilot]

export function allProviders(): ProviderAdapter[] {
  return ADAPTERS
}

export function hasProvider(id: unknown): id is ProviderId {
  return ADAPTERS.some((a) => a.id === id)
}

/** A provider id this version doesn't know (#842): read by the window and agents alike, so a HiveError. */
const UNKNOWN = msg({ id: 'providers.unknown', defaultMessage: 'Unknown provider "{provider}". It may need a newer version of Combwork.', description: 'An agent or a setting names a coding-agent CLI this version of Combwork doesn\'t know, as when a newer Combwork wrote it. {provider} is the id.' })

/** The adapter for a provider id; throws for an unknown one (e.g. a config written by a newer Hive). */
export function provider(id: ProviderId): ProviderAdapter {
  const a = ADAPTERS.find((x) => x.id === id)
  if (!a) throw hiveError(UNKNOWN, { provider: String(id) }, { kind: 'invalid' })
  return a
}
