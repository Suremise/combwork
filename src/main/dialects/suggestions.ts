/**
 * The model IDs the Dialects view suggests for a CLI's model file (HI-2523): only a convenience, never a list the typed
 * ID must match, and nothing curated (Darren's decision on HI-2523). Each once, in this order: the real model IDs the
 * running sessions **of this workspace** launched with (what their dialect matched by; another window's workspace is
 * its own, HR2 on HI-2523 r1), then the CLI's connections' models (a connection's chosen model, a server connection's
 * listed or typed ones), which are the same in every workspace.
 */
import type { Account, Connection, ProviderId } from '../../shared/types'

/** A running session, as the suggestions need it: its CLI, the model ID its dialect matched by, its workspace's path. */
export interface LaunchSeen {
  cli: string
  modelId?: string | null
  workspace: string | null | undefined
}

export function dialectModelSuggestions(
  cli: ProviderId,
  workspace: string | null | undefined,
  live: readonly LaunchSeen[],
  accounts: readonly Pick<Account, 'id' | 'provider' | 'server'>[],
  connections: readonly Pick<Connection, 'account' | 'model'>[]
): string[] {
  const ws = workspace?.toLowerCase()
  const seen: string[] = []
  if (ws) for (const l of live) if (l.cli === cli && l.modelId && l.workspace?.toLowerCase() === ws) seen.push(l.modelId)
  const own = accounts.filter((a) => a.provider === cli)
  for (const c of connections) if (c.model && own.some((a) => a.id === c.account)) seen.push(c.model)
  for (const a of own) for (const m of a.server?.models ?? []) seen.push(m.id)
  const out: string[] = []
  for (const m of seen.map((x) => x.trim())) if (m && !out.some((o) => o.toLowerCase() === m.toLowerCase())) out.push(m)
  return out
}
