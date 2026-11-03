import type { Account, LiveSessionState, ProviderId } from './types'
import { connectionsApply, resolveAgentConnection, usableConnections, type ConnectionsView } from './accounts'
import { isProviderEnabled } from './providers'

/**
 * Which connection an agent's rows name (HI-1769; HI-2108: connections, not accounts), by the launch's own rule
 * (resolveAgentConnection, decision H), so the window and a start never disagree:
 * - `desired`: its connection as it resolves now: its own when its account is on here; its own off here or removed, its
 *   CLI's first usable one (`note`: offFallback, missing); else why none can run it (none usable).
 * - `shown`: what a row names: the desired connection; while it runs on another than the desired one, the one it runs
 *   on (it keeps it until it restarts: launchedName); null when none can run it.
 * - `other`: running on another connection than the desired one (HI-2397: another on the same account too; a launch
 *   from before it, on another account), or the desired is now unusable: the ⟳ mark.
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

/** The connection a run launched on, as the window names it (HI-2397): the named connection, else (a launch from before it) its account. */
export function launchedName(launched: NonNullable<LiveSessionState['launchedConnection']>): { id: string; name: string } {
  return launched.connection ?? { id: launched.id, name: launched.name }
}

/**
 * Whether a running agent is due a switch to the connection it would launch on now (HI-1755; HI-2413: by connection, as
 * connectionOf's `other`, not by account, so another connection on the same account counts too). `now` is what it would
 * launch on: `connection` its account (`!<why>`: none usable), `connectionId` the connection. A launch from before
 * HI-2397, which kept only its account, is compared by account. Its own connection chosen again is no change.
 */
export function connectionSwitchDue(launched: NonNullable<LiveSessionState['launchedConnection']>, now: { connection: string | null; connectionId?: string }): boolean {
  return launched.connection && now.connectionId ? now.connectionId !== launched.connection.id : now.connection !== launched.id
}

export function connectionOf(own: string | undefined, provider: ProviderId, launched: LiveSessionState['launchedConnection'] | undefined, view: ConnectionsView | null): ConnectionShown | null {
  if (!view || !connectionsApply(view, provider)) return null
  const r = resolveAgentConnection({ connections: view.workspace }, provider, own, orderedAccounts(view), view.connectionRows ?? [])
  const wantedName = own ? view.connectionRows?.find((c) => c.id === own)?.name : undefined
  const desired: ConnectionShown['desired'] = r.ok ? { ok: true, id: r.connection.id, name: r.connection.name, account: r.account.id, ...(r.note ? { note: r.note } : {}) } : { ok: false, why: r.why, ...(wantedName ? { wantedName } : {}) }
  const other = !!launched && (!desired.ok || (launched.connection ? desired.id !== launched.connection.id : desired.account !== launched.id))
  const shown = other ? launchedName(launched!) : desired.ok ? { id: desired.id, name: desired.name } : null
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

/**
 * Whether a CLI can run a new agent now, as Hive's detection says (decision A: on and installed): `yes`, installed;
 * `no`, not found; `checking`, not known yet (detection under way).
 */
export type CliReady = (cli: ProviderId) => 'yes' | 'no' | 'checking'

/** A CliReady from the window's providers (their detection): installed, not found, or not known yet. */
export const cliReadyOf = (providers: Partial<Record<ProviderId, { found?: boolean; checking?: boolean }>>): CliReady => (cli) => {
  const i = providers[cli]
  return i?.found ? 'yes' : !i || i.checking ? 'checking' : 'no'
}

/**
 * The connection a new agent gets (decision A, HI-2108 round 1), as main's firstUsableAccount picks it: the first offered
 * whose CLI is installed (`ready`), skipping one whose CLI isn't. `checking` while a CLI earlier in the order isn't known
 * yet: the answer may still change, so a caller waits (quick add) or keeps looking (a dialog's preselection).
 */
export function firstReadyConnection(view: ConnectionsView | null, settings: Parameters<typeof isProviderEnabled>[0], ready: CliReady, cli?: ProviderId): { id?: string; checking: boolean } {
  if (!view) return { checking: true }
  const cliOf = cliOfConnections(view)
  for (const c of offeredConnections(view, settings, cli)) {
    const r = ready(cliOf(c.account) ?? '')
    if (r === 'checking') return { checking: true }
    if (r === 'yes') return { id: c.id, checking: false }
  }
  return { checking: false }
}

/** The first connection a new agent gets (firstReadyConnection), for preselecting one; undefined while none is (yet). */
export const firstUsableConnection = (view: ConnectionsView | null, settings: Parameters<typeof isProviderEnabled>[0], ready: CliReady, cli?: ProviderId): string | undefined => firstReadyConnection(view, settings, ready, cli).id

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
