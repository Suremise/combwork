import type { Account, Connection, ConnectionDefaults, LaunchValues, ProviderId, WorkspaceConnections, WorkspaceConfig } from './types'
import { permissionLabel, providerDescriptor } from './providers'

/**
 * Hive's accounts (HI-980) and connections (HI-2106): what an account's state is from its two identities, which accounts
 * share a login, a workspace's choice of them per provider, and the connections on them that agents choose. Pure, for
 * main and the window alike.
 */

/**
 * A connection's trust of the asking window's workspace's folders (HI-1870), for one on there: the projects whose folder
 * (its main repository root) its CLI doesn't trust yet, where Set Up opens; `unknown`, some couldn't be told.
 */
export interface ConnectionTrust {
  /** The folders still to trust; `git`: a Git root, which a trusted folder above it never covers (HI-2520). */
  pending: { project: string; folder: string; git: boolean }[]
  unknown: boolean
  /**
   * Where Set Up asks the trust question next (HI-1871): the workspace's folder (`workspace`), which covers the
   * projects without Git in it for a CLI whose trust is inherited, else the first pending project's main root.
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

/** One item of the status bar's plan usage (HI-2119): an account's own limits, or a CLI's for one without accounts here. */
export type PlanUsageItem = { kind: 'account'; id: string; provider: ProviderId; name: string } | { kind: 'cli'; provider: ProviderId }

/**
 * The status bar's plan usage items (HI-2107, HI-2119; decision A): one per account a session of the window's workspace
 * runs on, in the one order of accounts across every CLI (one not in it, last), by its name now; then, in `clis`' order,
 * one for each CLI turned on whose accounts don't apply here (`byAccounts` leaves it out), its CLI-wide limits.
 */
export function planUsageItems(clis: readonly ProviderId[], byAccounts: ReadonlySet<ProviderId>, inUse: readonly { id: string; name: string; provider: ProviderId }[], order: readonly string[], nameNow: (id: string) => string | undefined): PlanUsageItem[] {
  const place = (id: string): number => (order.includes(id) ? order.indexOf(id) : order.length)
  const seen = new Set<string>()
  const accounts = inUse
    .filter((c) => byAccounts.has(c.provider) && clis.includes(c.provider) && !seen.has(c.id) && !!seen.add(c.id))
    .sort((a, b) => place(a.id) - place(b.id))
    .map((c): PlanUsageItem => ({ kind: 'account', id: c.id, provider: c.provider, name: nameNow(c.id) ?? c.name }))
  return [...accounts, ...clis.filter((p) => !byAccounts.has(p)).map((p): PlanUsageItem => ({ kind: 'cli', provider: p }))]
}

/** Who uses a connection (HI-2107): an agent of an open workspace's project, or its Assistant (`assistant`). */
export interface ConnectionUser {
  projectPath: string
  project: string
  agentId: string
  agent: string
  assistant?: true
}

/**
 * A connection as Settings → Accounts & Connections shows it (HI-2107): who uses it in the open workspaces, and
 * `effortUnusable` when its effort is one its model no longer takes (decision E: left by a CLI's later catalogue, not
 * passed at launch).
 */
export type ConnectionRow = Connection & { users: ConnectionUser[]; effortUnusable?: true }

/** A connection's values as a patch sets them (HI-2107): each null or '' leaves it to the CLI. */
export type ConnectionPatch = { name?: string } & { [K in keyof LaunchValues]?: LaunchValues[K] | null }

/** A patch as a caller sent it (IPC, the Agent API), with only its known fields of the right types kept. */
export function connectionInput(raw: unknown): ConnectionPatch {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of ['name', 'model', 'effort', 'permissionMode', 'extraArgs'] as const) if (typeof r[k] === 'string' || r[k] === null) out[k] = r[k]
  if (typeof r.use200kContext === 'boolean' || r.use200kContext === null) out.use200kContext = r.use200kContext
  return out as ConnectionPatch
}

/** What Settings → Accounts shows (accounts:list): the connections, and the asking window's workspace's choice of them. */
export interface ConnectionsView {
  /** The providers that can have connections (capabilities.connections) and are on in Settings. */
  providers: ProviderId[]
  /** `key`: a server connection's key is set (HI-1772), its last 4 characters and when; never the key. */
  /** `setUp` (HI-1870): its CLI's first-run setup done in its folder, as last read; null, can't be told; absent, not read yet. */
  /**
   * The accounts (HI-2106; Hive's folders only, not the CLI's own homes), as today's screens show them until HI-2107:
   * `defaults`, its base connection's model, effort and context.
   */
  connections: (Account & { defaults?: ConnectionDefaults; defaultsFrom?: 'cli'; signingIn: boolean; folder: string; key?: { last4: string; at: string }; setUp?: boolean | null; trust?: ConnectionTrust })[]
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
  /**
   * Every account in the one order (HI-2107, decision A), the CLI's own homes too (Copilot's sign-in: decision C), by
   * id; `connections` has Hive's folders only, and `homes` the rest.
   */
  order: string[]
  homes: Account[]
  /** The connections (HI-2106), in their accounts' order and then their own, with who uses each. */
  connectionRows: ConnectionRow[]
}

/** An account as today's screens show it (ConnectionsView's). */
export type AccountView = ConnectionsView['connections'][number]

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

export function accountState(a: Pick<Account, 'accepted' | 'observed'>): ConnectionState {
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
export function duplicateLogins(connections: readonly Account[]): Map<string, string[]> {
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
export function acceptable(o: Account['observed'], orgs = true): { email: string; orgId: string } | null {
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
export function workspaceAccounts(cfg: Pick<WorkspaceConfig, 'connections'> | null | undefined, provider: ProviderId, connections: readonly Account[]): WorkspaceConnections | undefined {
  const w = cfg?.connections?.[provider]
  if (!w) return undefined
  const on = connections.filter((a) => a.provider === provider && w.on.includes(a.id)).map((a) => a.id)
  return { on, default: firstOn(on, connections) }
}

/**
 * The connection new launches use (HI-1875): the first in the preference order (each CLI's connections in the list's
 * order, Hive-wide) that's on; else none.
 */
export function firstOn(on: readonly string[], connections: readonly Account[]): string | null {
  return connections.find((a) => on.includes(a.id))?.id ?? null
}

/** The top of a CLI's preference order (HI-1875): the connection wearing the Default hint, on or not; else none. */
export function topOfOrder(provider: ProviderId, connections: readonly Account[]): string | null {
  return connections.find((a) => a.provider === provider)?.id ?? null
}

/**
 * A workspace's connections for a provider after turning one on or off, from how they apply now (`current`;
 * undefined: not set up yet, so this sets it up). Only `on` changes (HI-1875): which is used follows the order.
 */
export function switchedOn(current: WorkspaceConnections | undefined, id: string, on: boolean, connections: readonly Account[]): WorkspaceConnections {
  const was = current ?? { on: [], default: null }
  const ids = on ? (was.on.includes(id) ? was.on : [...was.on, id]) : was.on.filter((x) => x !== id)
  const ordered = connections.filter((a) => ids.includes(a.id)).map((a) => a.id)
  return { on: ordered, default: firstOn(ordered, connections) }
}

/**
 * Connections with one moved to `index` among its own CLI's (HI-1875: the preference order), the other CLIs' left
 * where they are. An index past the end puts it last; the list unchanged when it is already there.
 */
export function movedConnection<T extends Pick<Account, 'id' | 'provider'>>(connections: readonly T[], id: string, index: number): T[] {
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
 * A list with one item moved to `index` among those of its group (HI-2107: an account in the one order, all one group;
 * a connection among its account's), the others left in their places. An index past the end puts it last.
 */
export function movedInGroup<T extends { id: string }>(items: readonly T[], id: string, index: number, group: (t: T) => string = () => ''): T[] {
  const c = items.find((a) => a.id === id)
  if (!c) return [...items]
  const g = group(c)
  const own = items.filter((a) => group(a) === g && a.id !== id)
  const to = Math.max(0, Math.min(index, own.length))
  const order = [...own.slice(0, to), c, ...own.slice(to)]
  let i = 0
  return items.map((a) => (group(a) === g ? order[i++] : a))
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

export function resolveConnection(cfg: Pick<WorkspaceConfig, 'connections'> | null | undefined, provider: ProviderId, wanted: string | null | undefined, connections: readonly Account[]): ConnectionChoice {
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

export function connectionRef(ref: string, connections: readonly Pick<Account | Connection, 'id' | 'name'>[], onHere: readonly string[]): ConnectionRef {
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

export function connectionShown(c: Account, ws: Partial<Record<ProviderId, WorkspaceConnections>>, wide: boolean, all: readonly Account[] = [c]): ConnectionShownApi {
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
export function connectionsFor(connections: readonly Account[], ws: Partial<Record<ProviderId, WorkspaceConnections>>, wide: boolean): ConnectionShownApi[] {
  return connections.filter((c) => wide || !!ws[c.provider]?.on.includes(c.id)).map((c) => connectionShown(c, ws, wide, connections))
}

// ---------------------------------------------------------------------------
// Connections (HI-2106): the setups on an account that agents and the Assistant choose.
// ---------------------------------------------------------------------------

const VALUE_KEYS = ['model', 'effort', 'use200kContext', 'permissionMode', 'extraArgs'] as const

/**
 * Launch values as a connection keeps them: each one that is what the CLI would do anyway left out (an empty model or
 * effort or arguments, a 1M context, the CLI's own default mode), and what its kind can't take dropped (a server
 * account's effort and context; context where the CLI has no choice of it). Two setups are the same when these are.
 */
export function launchValues(v: LaunchValues | null | undefined, cli: ProviderId, server = false): LaunchValues {
  const d = providerDescriptor(cli)
  const out: LaunchValues = {}
  if (v?.model?.trim()) out.model = v.model.trim()
  if (v?.effort && !server) out.effort = v.effort
  if (v?.use200kContext === true && !server && d.capabilities.contextLimit) out.use200kContext = true
  if (v?.permissionMode && v.permissionMode !== d.defaultPermissionMode) out.permissionMode = v.permissionMode
  if (v?.extraArgs?.trim()) out.extraArgs = v.extraArgs.trim()
  return out
}

/** Whether two connections' values (as launchValues keeps them) are the same setup. */
export function sameValues(a: LaunchValues, b: LaunchValues): boolean {
  return VALUE_KEYS.every((k) => (a[k] ?? undefined) === (b[k] ?? undefined))
}

/** A connection's values alone (its id, account and name left out). */
export const valuesOf = (c: LaunchValues): LaunchValues => Object.fromEntries(VALUE_KEYS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]])) as LaunchValues

/** An account's connections, in their order. */
export const connectionsOn = <C extends Pick<Connection, 'account'>>(account: string, connections: readonly C[]): C[] => connections.filter((c) => c.account === account)

/** An account's base connection (HI-2106): its first, made with it; none while it has none. */
export const baseConnection = (account: string, connections: readonly Connection[]): Connection | undefined => connections.find((c) => c.account === account)

/** The connection on an account whose values are these (as launchValues keeps them), the earliest; none if no such one. */
export function matchingConnection(account: Pick<Account, 'id' | 'provider' | 'kind'>, values: LaunchValues, connections: readonly Connection[]): Connection | undefined {
  const want = launchValues(values, account.provider, account.kind === 'server')
  return connectionsOn(account.id, connections).find((c) => sameValues(launchValues(c, account.provider, account.kind === 'server'), want))
}

/** An effort level's name in a connection's name: "High", "Xhigh". */
const effortWord = (e: string): string => e.charAt(0).toUpperCase() + e.slice(1)

/**
 * A new connection's name (HI-2106): its account's when its values are its base connection's (or it is the base), else
 * the account's followed by what differs ("Personal · opus · High · Plan"), or by `label` ("Personal · Assistant"); never
 * one the account's connections have already (a number added). A connection's name is the user's data once made, in
 * English as made; the user renames it.
 */
export function connectionName(account: Pick<Account, 'name' | 'provider'>, values: LaunchValues, base: LaunchValues | undefined, taken: readonly string[], label?: string): string {
  const parts: string[] = []
  if (base && !sameValues(values, base)) {
    if (label) parts.push(label)
    else {
      // The model by its name ("Haiku", as the row's summary says it), a server's or an unknown one as its id.
      if ((values.model ?? '') !== (base.model ?? '')) parts.push(values.model ? providerDescriptor(account.provider).modelLabel(values.model) : 'Default model') // i18n-ignore: a connection's name, the user's data once made
      if ((values.effort ?? '') !== (base.effort ?? '')) parts.push(values.effort ? effortWord(values.effort) : 'Default effort') // i18n-ignore: a connection's name, the user's data once made
      if (!!values.use200kContext !== !!base.use200kContext) parts.push(values.use200kContext ? '200K' : '1M') // i18n-ignore: a connection's name (token counts)
      if ((values.permissionMode ?? '') !== (base.permissionMode ?? '')) parts.push(permissionLabel(account.provider, values.permissionMode ?? providerDescriptor(account.provider).defaultPermissionMode))
      if ((values.extraArgs ?? '') !== (base.extraArgs ?? '')) parts.push(values.extraArgs ? values.extraArgs : 'No extra arguments') // i18n-ignore: a connection's name, the user's data once made
    }
  }
  const name = [account.name, ...parts].join(' · ')
  const used = new Set(taken.map((t) => t.trim().toLowerCase()))
  if (!used.has(name.toLowerCase())) return name
  for (let n = 2; ; n++) if (!used.has(`${name} (${n})`.toLowerCase())) return `${name} (${n})`
}

/** Whether an account can be used in a workspace: on there, or the CLI's own home (Copilot's sign-in, a test home), on everywhere. */
export function accountOnIn(cfg: Pick<WorkspaceConfig, 'connections'> | null | undefined, a: Account, accounts: readonly Account[]): boolean {
  return a.home === 'cli' || !!workspaceAccounts(cfg, a.provider, accounts)?.on.includes(a.id)
}

/**
 * Which connection a launch uses (HI-2106, decision H), from the agent's (or the Assistant's) connection and the
 * workspace's accounts:
 * - its connection, on an account of its CLI that's on here: that one;
 * - its account off here, or the connection removed (or another CLI's), or none: its CLI's first usable connection here
 *   (the base connection of the first account in the order that's on here and has one), noted when it named one
 *   (`offFallback`, `missing`);
 * - none usable: refused (`none`: nothing named; `offNoDefault`: named, but none to fall back to).
 */
export type AgentConnection = { ok: true; connection: Connection; account: Account; note?: 'offFallback' | 'missing' } | { ok: false; why: 'none' | 'offNoDefault'; wanted?: string }

export function resolveAgentConnection(cfg: Pick<WorkspaceConfig, 'connections'> | null | undefined, cli: ProviderId, wanted: string | null | undefined, accounts: readonly Account[], connections: readonly Connection[]): AgentConnection {
  const c = wanted ? connections.find((x) => x.id === wanted) : undefined
  const a = c ? accounts.find((x) => x.id === c.account) : undefined
  if (c && a && a.provider === cli && accountOnIn(cfg, a, accounts)) return { ok: true, connection: c, account: a }
  for (const x of accounts) {
    if (x.provider !== cli || !accountOnIn(cfg, x, accounts)) continue
    const base = baseConnection(x.id, connections)
    if (base) return { ok: true, connection: base, account: x, ...(wanted ? { note: c && a && a.provider === cli ? ('offFallback' as const) : ('missing' as const) } : {}) }
  }
  return wanted ? { ok: false, why: 'offNoDefault', wanted } : { ok: false, why: 'none' } // i18n-ignore: a reason's code, not text
}

/**
 * The connections usable in a workspace (HI-2108): those on accounts usable there (on in it, or the CLI's own home), in the
 * order (accounts', then each account's own); only `cli`'s when given. What Add Agent, Agent Settings, the Assistant dialog
 * and the Agent API offer, and the first of which a new agent gets (decision A).
 */
export function usableConnections<C extends Pick<Connection, 'account'>>(cfg: Pick<WorkspaceConfig, 'connections'> | null | undefined, accounts: readonly Account[], connections: readonly C[], cli?: ProviderId): C[] {
  const usable = accounts.filter((a) => (!cli || a.provider === cli) && accountOnIn(cfg, a, accounts))
  return usable.flatMap((a) => connectionsOn(a.id, connections))
}

/**
 * Extra arguments joined (HI-2106): the launch's parts (Settings → the CLI's, then the project's, as
 * typed) as one string that splits (splitArgs) into exactly their arguments: joined by a space when that already does,
 * else each argument quoted as needed.
 */
export function joinArgs(parts: readonly string[], split: (s: string) => string[]): string {
  const kept = parts.filter((p) => p && p.trim())
  const want = kept.flatMap((p) => split(p))
  const plain = kept.map((p) => p.trim()).join(' ')
  const same = (s: string): boolean => JSON.stringify(split(s)) === JSON.stringify(want)
  if (same(plain)) return plain
  const quoted = want.map((t) => (!/[\s"']/.test(t) && t ? t : !t.includes('"') ? `"${t}"` : `'${t}'`)).join(' ')
  return same(quoted) ? quoted : plain
}
