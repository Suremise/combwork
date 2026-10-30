import type { Account, LiveSessionState, ProviderId } from './types'
import { connectionsApply, resolveAgentConnection, usableConnections, type ConnectionsView } from './accounts'
import { isProviderEnabled } from './providers'

/**
 * Which connection an agent's rows name (HI-1769; HI-2108: connections, not accounts), by the launch's own rule
 * (resolveAgentConnection, decision H), so the window and a start never disagree:
 * - `desired`: its connection as it resolves now: its own when its account is on here; its own off here or removed, its
 *   CLI's first usable one (`note`: offFallback, missing); else why none can run it (none usable).
 * - `shown`: what a row names: the desired connection; while it runs on another account than the desired one's, that
 *   account (it keeps it until it restarts); null when none can run it.
 * - `other`: running on another account than the desired one's, or the desired is now unusable: the ⟳ mark.
 * Null where connections aren't shown: a CLI without them, a test copy on its CLI test home.
 */
export interface ConnectionShown {
  desired: { ok: true; id: string; name: string; account: string; note?: 'offFallback' | 'missing' } | { ok: false; why: 'none' | 'offNoDefault'; wantedName?: string }
  shown: { id: string; name: string } | null
  other: boolean
}

/** Every account in the one order (decision A): Hive's folders and the CLI's own homes alike. */
export function orderedAccounts(view: Pick<ConnectionsView, 'connections' | 'homes' | 'order'>): Account[] {
  const all: Account[] = [...view.connections, ...(view.homes ?? [])]
  const order = view.order ?? all.map((a) => a.id)
  return [...order.flatMap((id) => all.filter((a) => a.id === id)), ...all.filter((a) => !order.includes(a.id))]
}

/** The connections usable in the window's workspace (accounts on in it, the CLI's own homes), in the order; `cli`'s only when given. */
export function connectionsHere(view: ConnectionsView, cli?: ProviderId): ConnectionsView['connectionRows'] {
  return usableConnections({ connections: view.workspace }, orderedAccounts(view), view.connectionRows ?? [], cli)
}

export function connectionOf(own: string | undefined, provider: ProviderId, launched: LiveSessionState['launchedConnection'] | undefined, view: ConnectionsView | null): ConnectionShown | null {
  if (!view || !connectionsApply(view, provider)) return null
  const r = resolveAgentConnection({ connections: view.workspace }, provider, own, orderedAccounts(view), view.connectionRows ?? [])
  const wantedName = own ? view.connectionRows?.find((c) => c.id === own)?.name : undefined
  const desired: ConnectionShown['desired'] = r.ok ? { ok: true, id: r.connection.id, name: r.connection.name, account: r.account.id, ...(r.note ? { note: r.note } : {}) } : { ok: false, why: r.why, ...(wantedName ? { wantedName } : {}) }
  const other = !!launched && (!desired.ok || desired.account !== launched.id)
  const shown = other ? { id: launched!.id, name: launched!.name } : desired.ok ? { id: desired.id, name: desired.name } : null
  return { desired, shown, other }
}

/**
 * The connections a choice offers here (HI-2108): usable in this workspace, of CLIs turned on; `cli`'s only when given.
 * The first is what a new agent gets (decision A: the first usable in the order of accounts).
 */
export function offeredConnections(view: ConnectionsView | null, settings: Parameters<typeof isProviderEnabled>[0], cli?: ProviderId): ConnectionsView['connectionRows'] {
  if (!view) return []
  const cliOf = cliOfConnections(view)
  return connectionsHere(view, cli).filter((c) => isProviderEnabled(settings, cliOf(c.account) ?? ''))
}

/** The first connection a choice offers (decision A), for preselecting one; undefined when none is usable here. */
export const firstUsableConnection = (view: ConnectionsView | null, settings: Parameters<typeof isProviderEnabled>[0], cli?: ProviderId): string | undefined => offeredConnections(view, settings, cli)[0]?.id

/** Each account's CLI, by its id. */
const cliOfConnections = (view: ConnectionsView): ((account: string) => ProviderId | undefined) => {
  const accounts = orderedAccounts(view)
  return (account) => accounts.find((a) => a.id === account)?.provider
}

/** A connection's CLI (its account's), or undefined for one gone. */
export const connectionCli = (view: ConnectionsView | null, id: string | null | undefined): ProviderId | undefined => {
  const c = id && view ? view.connectionRows?.find((x) => x.id === id) : undefined
  return c && view ? cliOfConnections(view)(c.account) : undefined
}
