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

/** Every account in the one order (decision A): Combwork's folders and the CLI's own homes alike. */
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
 * What to offer where nothing can start here for want of a connection (HI-2650, Darren 6 Nov: nothing is turned on by
 * itself): the accounts that are off in this workspace, never turned on until the user clicks.
 * - Eligible: Combwork's accounts (not a CLI's own home) whose CLI the view lists (on in Settings, with connections), not
 *   a test copy's CLI on its test home, and not on here. `cli`: that CLI's only (a project's agents' CLI).
 * - With no `cli`, those of an installed CLI first (`ready`), so the offer is one that can start; else all of them.
 * - `one`: exactly one: Turn On Here on it. `several`: Choose in Settings. `none`: none at all, add one (as before).
 */
export type OffHereChoice = { kind: 'one'; id: string; name: string; cli: ProviderId } | { kind: 'several'; names: string[]; cli?: ProviderId } | { kind: 'none'; cli?: ProviderId }

export function offHereChoice(view: Pick<ConnectionsView, 'connections' | 'homes' | 'order' | 'providers' | 'testHome' | 'workspace'>, ready: CliReady, cli?: ProviderId): OffHereChoice {
  const eligible = orderedAccounts(view).filter((a) => !a.home && view.providers.includes(a.provider) && !view.testHome.includes(a.provider) && (!cli || a.provider === cli) && !view.workspace[a.provider]?.on.includes(a.id))
  const installed = eligible.filter((a) => ready(a.provider) === 'yes')
  const offer = !cli && installed.length ? installed : eligible
  if (!offer.length) return { kind: 'none', ...(cli ? { cli } : {}) }
  if (offer.length === 1) return { kind: 'one', id: offer[0].id, name: offer[0].name, cli: offer[0].provider }
  const clis = [...new Set(offer.map((a) => a.provider))]
  return { kind: 'several', names: offer.map((a) => a.name), ...(clis.length === 1 ? { cli: clis[0] } : {}) }
}

/**
 * Whether a CLI can run a new agent now, as Combwork's detection says (decision A: on and installed): `yes`, installed;
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

/**
 * The Assistant's CLI as its launch picks it (sessions.ts, decision A, HI-2108): its own (`provider`) when it names one or
 * a connection; one that names neither (a new workspace's) runs the CLI of the first usable connection here, Automatic's
 * pick (`fallback`) only where none is. Running, the CLI it runs.
 */
export function assistantCli(a: { provider?: string; connection?: string; live?: { provider: ProviderId } | null }, view: ConnectionsView | null, settings: Parameters<typeof isProviderEnabled>[0], ready: CliReady, fallback: ProviderId): ProviderId {
  if (a.live?.provider) return a.live.provider
  if (a.provider || a.connection) return fallback
  return connectionCli(view, firstUsableConnection(view, settings, ready)) ?? fallback
}

/**
 * What the Assistant panel says while the Assistant can't start for want of an account (HI-2899): nothing (`ok`: it can,
 * or connections don't apply to its CLI here); its connection's account signed out (`signedOut`, named); accounts off in
 * this workspace that would do (`off`, as offHereChoice: one to turn on, or several); none added that would do: for an
 * Assistant that names no CLI, any CLI's (`noneAny`), else its own CLI's (`noneFor`, `others` when another CLI's
 * connection is usable here, to choose in its settings). `cli`: assistantCli's.
 */
export type AssistantNeed = { kind: 'ok' } | { kind: 'signedOut'; name: string; cli: ProviderId } | { kind: 'off'; choice: Exclude<OffHereChoice, { kind: 'none' }> } | { kind: 'noneAny' } | { kind: 'noneFor'; cli: ProviderId; others: boolean }

export function assistantNeed(a: { provider?: string; connection?: string }, cli: ProviderId, view: ConnectionsView | null, settings: Parameters<typeof isProviderEnabled>[0], ready: CliReady, signedOut: (account: Account) => boolean): AssistantNeed {
  const shown = connectionOf(a.connection, cli, undefined, view)
  if (!view || !shown || view.testHome.includes(cli)) return { kind: 'ok' }
  if (shown.desired.ok) {
    const id = shown.desired.account
    const account = view.connections.find((x) => x.id === id)
    return account && account.kind !== 'server' && signedOut(account) ? { kind: 'signedOut', name: shown.desired.name, cli } : { kind: 'ok' }
  }
  const automatic = !a.provider && !a.connection
  // One that names no CLI, while Combwork still looks for the CLIs, or with an account on here whose CLI isn't installed:
  // no account is missing (a missing CLI is the CLI warnings' to say), so nothing here.
  if (automatic && (firstReadyConnection(view, settings, ready).checking || offeredConnections(view, settings).length)) return { kind: 'ok' }
  const choice = offHereChoice(view, ready, automatic ? undefined : cli)
  if (choice.kind !== 'none') return { kind: 'off', choice }
  return automatic ? { kind: 'noneAny' } : { kind: 'noneFor', cli, others: offeredConnections(view, settings).some((c) => cliOfConnections(view)(c.account) !== cli) }
}
