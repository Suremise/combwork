// Which CLI's memory the Assistant view shows (HI-2666): the one the Assistant runs on now, while a session of it runs,
// though Settings → Assistant may name another for its next launch; else the one its next launch uses.
import type { ProviderId } from './types'

export function assistantMemoryProvider(live: { provider: ProviderId } | null | undefined, configured: ProviderId): ProviderId {
  return live?.provider ?? configured
}

/** The scope of a load of it: a reply for another workspace or provider is never shown (nor its file kept selected). */
export const assistantMemoryScope = (workspacePath: string, provider: ProviderId): string => `${workspacePath.toLowerCase()}|${provider}`
