import type { Connection, ProviderId, WorkspaceConnections, WorkspaceConfig } from './types'

/**
 * Hive's connections (HI-980): what an account's state is from its two identities, which connections share a login, and a
 * workspace's choice of them per provider. Pure, for main and the window alike.
 */

/**
 * A connection's trust of the asking window's workspace's folders (HI-1870), for one on there: the projects whose folder
 * (its main repository root) its CLI doesn't trust yet, where Set Up opens; `unknown`, some couldn't be told.
 */
export interface ConnectionTrust {
  pending: { project: string; folder: string }[]
  unknown: boolean
  /**
   * Where Set Up asks the trust question next (HI-1871): the workspace's folder (`workspace`), which covers every
   * project in it for a CLI whose trust is inherited, else the first pending project's main root.
   */
  setUpIn?: { folder: string; project?: string; workspace?: true }
  /** Its answer for the workspace's current projects isn't in yet (HI-1870 round 3): shown as Checking…, never set up. */
  checking?: true
}

/**
 * Whether a connection is set up (HI-1870), one rule wherever it shows: its CLI's first-run setup done (`setUp`) and,
 * where it is on, the workspace's folders trusted (`trust`). Anything definitely not done wins (`needed`), then
 * anything that can't be told (`unknown`: neither said), else `done`.
 */
export function connectionReadiness(c: { setUp?: boolean | null; trust?: ConnectionTrust }): 'needed' | 'unknown' | 'done' {
  if (c.setUp === false || (c.trust?.pending.length ?? 0) > 0) return 'needed'
  if (c.setUp == null || c.trust?.unknown) return 'unknown'
  return 'done'
}

/** What Settings → Accounts shows (accounts:list): the connections, and the asking window's workspace's choice of them. */
export interface ConnectionsView {
  /** The providers that can have connections (capabilities.connections) and are on in Settings. */
  providers: ProviderId[]
  /** `key`: a server connection's key is set (HI-1772), its last 4 characters and when; never the key. */
  /** `setUp` (HI-1870): its CLI's first-run setup done in its folder, as last read; null, can't be told; absent, not read yet. */
  connections: (Connection & { signingIn: boolean; folder: string; key?: { last4: string; at: string }; setUp?: boolean | null; trust?: ConnectionTrust })[]
  /** Per provider, as it applies (workspaceAccounts); absent: not set up in this workspace. */
  workspace: Partial<Record<ProviderId, WorkspaceConnections>>
  /** Providers a test copy runs on its CLI test home where nothing is on (the test seam, HI-1755): no setup is asked for. */
  testHome: ProviderId[]
  /**
   * The CLIs the one-time notice that agents run on connections names (HI-1774): those with connections, on and not on
   * a test home, while no connection was ever added and it wasn't dismissed. Absent: no notice.
   */
  intro?: ProviderId[]
  /**
   * Server connections' key masking (HI-1772): `unavailable`, its data can't be read (strict, exports refused: Reset
   * Masking Data); `gap`, a reset lost some (strict for good, since `gapSince`); `full`, near the most keys it keeps.
   */
  masking?: { state: 'none' | 'pending' | 'ready' | 'unavailable'; gap: boolean; gapSince?: string; full: boolean }
}

/**
 * Whether a CLI's agents run on connections here, for what the window shows (HI-1774): it has them and is on (the view
 * lists it), unless this is a test copy on its CLI test home with none on in the workspace, which launches as before
 * connections (the seam, HI-1755) and so shows none of them (no Connection column, the CLI's own plan limits).
 */
export function connectionsApply<V extends Pick<ConnectionsView, 'providers' | 'testHome' | 'workspace'>>(view: V | null | undefined, cli: ProviderId): view is V {
  return !!view && view.providers.includes(cli) && !(view.testHome.includes(cli) && !view.workspace[cli]?.default)
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

/**
 * The identity a successful check gives, to accept: only signed in, with its email and, for a CLI whose sign-in names
 * one (`orgs`, its descriptor's connections.orgs: Claude Code's does, Codex's doesn't, HI-1757), its organisation.
 */
export function acceptable(o: Connection['observed'], orgs = true): { email: string; orgId: string } | null {
  if (!o || o.missing || o.loggedIn !== true || !o.email) return null
  if (orgs && !o.orgId) return null
  return { email: o.email, orgId: o.orgId ?? '' }
}

/**
 * A workspace's connections for a provider as they apply: ids of connections that no longer exist (or are another
 * provider's) dropped, in the preference order, and its `default` **derived** (HI-1875, Darren 27 Oct): the first
 * connection in the order that's on here (`firstOn`), never a stored choice (one left in workspace.json is ignored).
 * `undefined`: not set up yet.
 */
export function workspaceAccounts(cfg: Pick<WorkspaceConfig, 'connections'> | null | undefined, provider: ProviderId, connections: readonly Connection[]): WorkspaceConnections | undefined {
  const w = cfg?.connections?.[provider]
  if (!w) return undefined
  const on = connections.filter((a) => a.provider === provider && w.on.includes(a.id)).map((a) => a.id)
  return { on, default: firstOn(on, connections) }
}

/**
 * The connection new launches use (HI-1875): the first in the preference order (each CLI's connections in the list's
 * order, Hive-wide) that's on; else none.
 */
export function firstOn(on: readonly string[], connections: readonly Connection[]): string | null {
  return connections.find((a) => on.includes(a.id))?.id ?? null
}

/** The top of a CLI's preference order (HI-1875): the connection wearing the Default hint, on or not; else none. */
export function topOfOrder(provider: ProviderId, connections: readonly Connection[]): string | null {
  return connections.find((a) => a.provider === provider)?.id ?? null
}

/**
 * A workspace's connections for a provider after turning one on or off, from how they apply now (`current`;
 * undefined: not set up yet, so this sets it up). Only `on` changes (HI-1875): which is used follows the order.
 */
export function switchedOn(current: WorkspaceConnections | undefined, id: string, on: boolean, connections: readonly Connection[]): WorkspaceConnections {
  const was = current ?? { on: [], default: null }
  const ids = on ? (was.on.includes(id) ? was.on : [...was.on, id]) : was.on.filter((x) => x !== id)
  const ordered = connections.filter((a) => ids.includes(a.id)).map((a) => a.id)
  return { on: ordered, default: firstOn(ordered, connections) }
}

/**
 * Connections with one moved to `index` among its own CLI's (HI-1875: the preference order), the other CLIs' left
 * where they are. An index past the end puts it last; the list unchanged when it is already there.
 */
export function movedConnection<T extends Pick<Connection, 'id' | 'provider'>>(connections: readonly T[], id: string, index: number): T[] {
  const c = connections.find((a) => a.id === id)
  if (!c) return [...connections]
  const own = connections.filter((a) => a.provider === c.provider && a.id !== id)
  const to = Math.max(0, Math.min(index, own.length))
  const order = [...own.slice(0, to), c, ...own.slice(to)]
  let i = 0
  // Each slot its CLI held keeps holding one of its connections, in the new order.
  return connections.map((a) => (a.provider === c.provider ? order[i++] : a))
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
    if (!c) return { ok: false, why: 'deleted', wanted } // i18n-ignore: a reason's code, not text
    if (c.provider !== provider) return { ok: false, why: 'otherProvider', wanted } // i18n-ignore: a reason's code, not text
    if (ws?.on.includes(wanted)) return { ok: true, id: wanted }
    return ws?.default ? { ok: true, id: ws.default, note: 'offFallback' } : { ok: false, why: 'offNoDefault', wanted } // i18n-ignore: a reason's code, not text
  }
  return ws?.default ? { ok: true, id: ws.default } : { ok: false, why: 'none' } // i18n-ignore: a reason's code, not text
}

/**
 * A connection named in the Agent API (HI-1771): an exact id, else a name (any case) among those on in the caller's
 * workspace (`onHere`): one, its id; several, ambiguous (use its id); none, unknown. A name binds only when unique.
 */
export type ConnectionRef = { ok: true; id: string } | { ok: false; why: 'ambiguous' | 'unknown'; ids?: string[] }

export function connectionRef(ref: string, connections: readonly Connection[], onHere: readonly string[]): ConnectionRef {
  const r = ref.trim()
  if (connections.some((c) => c.id === r)) return { ok: true, id: r }
  const named = connections.filter((c) => onHere.includes(c.id) && c.name.trim().toLowerCase() === r.toLowerCase())
  if (named.length === 1) return { ok: true, id: named[0].id }
  return named.length ? { ok: false, why: 'ambiguous', ids: named.map((c) => c.id) } : { ok: false, why: 'unknown' } // i18n-ignore: a reason's code, not text
}

/**
 * What the Agent API shows of a connection (HI-1771), by who asks: never a token, a key, where its login is kept (its
 * folder), its settings or its defaults. `wide` (the user's token, the Hive Assistant): with whether it is on and the
 * default in the caller's workspace, and who it is signed in as; a project agent sees the four fields alone, and only
 * for those on in its workspace (connectionsFor).
 */
export interface ConnectionShownApi {
  id: string
  name: string
  cli: ProviderId
  kind: 'signIn' | 'server'
  /** A sign-in connection's: signed in. A server connection's (HI-1772): there is no sign-in, so false. */
  signedIn: boolean
  on?: boolean
  /** The first in its CLI's order that's on in the caller's workspace: what a provider-only call uses there (HI-1875). */
  default?: boolean
  /** Its place in its CLI's preference order, from 1 (HI-1875: Hive-wide; 1 wears the Default hint). */
  order?: number
  email?: string
  plan?: string
  /** A server connection's server, its host only (`wide`): never its key, nor whether it has one. */
  host?: string
}

export function connectionShown(c: Connection, ws: Partial<Record<ProviderId, WorkspaceConnections>>, wide: boolean, all: readonly Connection[] = [c]): ConnectionShownApi {
  const state = accountState(c)
  const server = c.kind === 'server'
  const base: ConnectionShownApi = { id: c.id, name: c.name, cli: c.provider, kind: c.kind ?? 'signIn', signedIn: !server && (state === 'signedIn' || state === 'changed') }
  if (!wide) return base
  const w = ws[c.provider]
  const email = c.observed?.email ?? c.accepted?.email
  const host = server ? hostOf(c.server?.baseUrl ?? '') : null
  const order = all.filter((x) => x.provider === c.provider).findIndex((x) => x.id === c.id) + 1
  return { ...base, on: !!w?.on.includes(c.id), default: w?.default === c.id, ...(order ? { order } : {}), ...(email && !server ? { email } : {}), ...(c.observed?.plan && !server ? { plan: c.observed.plan } : {}), ...(host ? { host } : {}) }
}

/** A base URL's host (with its port), or null. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

/** The connections a caller may see (HI-1771): `wide`, every one; else only those on in its workspace. */
export function connectionsFor(connections: readonly Connection[], ws: Partial<Record<ProviderId, WorkspaceConnections>>, wide: boolean): ConnectionShownApi[] {
  return connections.filter((c) => wide || !!ws[c.provider]?.on.includes(c.id)).map((c) => connectionShown(c, ws, wide, connections))
}
