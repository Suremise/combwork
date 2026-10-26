import type { Connection, ProviderId, WorkspaceConnections, WorkspaceConfig } from './types'

/**
 * Hive's connections (HI-980): what an account's state is from its two identities, which connections share a login, and a
 * workspace's choice of them per provider. Pure, for main and the window alike.
 */

/** What Settings → Accounts shows (accounts:list): the connections, and the asking window's workspace's choice of them. */
export interface ConnectionsView {
  /** The providers that can have connections (capabilities.connections) and are on in Settings. */
  providers: ProviderId[]
  connections: (Connection & { signingIn: boolean; folder: string })[]
  /** Per provider, as it applies (workspaceAccounts); absent: not set up in this workspace. */
  workspace: Partial<Record<ProviderId, WorkspaceConnections>>
  /** Providers a test copy runs on its CLI test home where nothing is on (the test seam, HI-1755): no setup is asked for. */
  testHome: ProviderId[]
}

/**
 * An account's state, from `accepted` (who the user took it on as) and `observed` (the latest check), never merged: a
 * check can't clear a change the user hasn't answered.
 * - `missing`: its folder isn't there (or was replaced by something Hive didn't make).
 * - `unchecked`: never checked yet.
 * - `failed`: the latest check couldn't tell (a timeout, output it couldn't read): never counted as signed out.
 * - `signedOut`: the CLI said it is signed out.
 * - `changed`: signed in, but not as the accepted login (a /login typed in a pane).
 * - `signedIn`: signed in as accepted (or none accepted yet, with an identity).
 */
export type ConnectionState = 'missing' | 'unchecked' | 'failed' | 'signedOut' | 'changed' | 'signedIn'

export function accountState(a: Pick<Connection, 'accepted' | 'observed'>): ConnectionState {
  const o = a.observed
  if (!o) return 'unchecked'
  if (o.missing) return 'missing'
  if (o.loggedIn === null) return 'failed'
  if (!o.loggedIn) return 'signedOut'
  if (a.accepted && !sameLogin(a.accepted, o)) return 'changed'
  return 'signedIn'
}

/** Whether two identities are the same login: the same email (any case) in the same organisation. */
export function sameLogin(a: { email?: string; orgId?: string }, b: { email?: string; orgId?: string }): boolean {
  return !!a.email && !!b.email && a.email.toLowerCase() === b.email.toLowerCase() && (a.orgId ?? '') === (b.orgId ?? '')
}

/** Per account id, the other connections of its provider signed in as the same login (from their latest checks). */
export function duplicateLogins(connections: readonly Connection[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const a of connections) {
    if (!a.observed?.loggedIn || !a.observed.email) continue
    const same = connections.filter((b) => b.id !== a.id && b.provider === a.provider && !!b.observed?.loggedIn && sameLogin(a.observed!, b.observed!)).map((b) => b.id)
    if (same.length) out.set(a.id, same)
  }
  return out
}

/** The identity a successful check gives, to accept: only signed in, with both its email and organisation. */
export function acceptable(o: Connection['observed']): { email: string; orgId: string } | null {
  return o && !o.missing && o.loggedIn === true && o.email && o.orgId ? { email: o.email, orgId: o.orgId } : null
}

/**
 * A workspace's connections for a provider as they apply: ids of connections that no longer exist (or are another
 * provider's) dropped, and its default replaced when it isn't one of those on. `undefined`: not set up yet.
 */
export function workspaceAccounts(cfg: Pick<WorkspaceConfig, 'connections'> | null | undefined, provider: ProviderId, connections: readonly Connection[]): WorkspaceConnections | undefined {
  const w = cfg?.connections?.[provider]
  if (!w) return undefined
  const ids = new Set(connections.filter((a) => a.provider === provider).map((a) => a.id))
  const on = w.on.filter((id, i) => ids.has(id) && w.on.indexOf(id) === i)
  return { on, default: w.default && on.includes(w.default) ? w.default : replacementDefault(on, connections) }
}

/** The default when the last one is off or gone: the first account of the provider that's on, in the list's order; else none. */
export function replacementDefault(on: readonly string[], connections: readonly Connection[]): string | null {
  return connections.find((a) => on.includes(a.id))?.id ?? null
}

/**
 * A workspace's connections for a provider after turning one on or off (on: it becomes the default if there is none),
 * from how they apply now (`current`; undefined: not set up yet, so this sets it up).
 */
export function switchedOn(current: WorkspaceConnections | undefined, id: string, on: boolean, connections: readonly Connection[]): WorkspaceConnections {
  const was = current ?? { on: [], default: null }
  const ids = on ? (was.on.includes(id) ? was.on : [...was.on, id]) : was.on.filter((x) => x !== id)
  // In the account list's order, so the replacement default is the same in every window.
  const ordered = connections.filter((a) => ids.includes(a.id)).map((a) => a.id)
  const keep = was.default && ordered.includes(was.default) ? was.default : null
  return { on: ordered, default: keep ?? (on && !was.default ? id : replacementDefault(ordered, connections)) }
}

/**
 * Which connection a launch uses (HI-1755), from what was asked for (an agent's own choice, the Assistant's, or none)
 * and the workspace's choice:
 * - asked for and on here: that one;
 * - asked for but off here: the workspace's default for the provider, noted (`offFallback`); none on: refused;
 * - asked for but gone, or another provider's: refused, never another in its place;
 * - nothing asked for: the workspace's default; none: refused (nothing launches from the CLI's own home).
 */
export type ConnectionChoice = { ok: true; id: string; note?: 'offFallback' } | { ok: false; why: 'none' | 'offNoDefault' | 'deleted' | 'otherProvider'; wanted?: string }

export function resolveConnection(cfg: Pick<WorkspaceConfig, 'connections'> | null | undefined, provider: ProviderId, wanted: string | null | undefined, connections: readonly Connection[]): ConnectionChoice {
  const ws = workspaceAccounts(cfg, provider, connections)
  if (wanted) {
    const c = connections.find((x) => x.id === wanted)
    if (!c) return { ok: false, why: 'deleted', wanted }
    if (c.provider !== provider) return { ok: false, why: 'otherProvider', wanted }
    if (ws?.on.includes(wanted)) return { ok: true, id: wanted }
    return ws?.default ? { ok: true, id: ws.default, note: 'offFallback' } : { ok: false, why: 'offNoDefault', wanted }
  }
  return ws?.default ? { ok: true, id: ws.default } : { ok: false, why: 'none' }
}
