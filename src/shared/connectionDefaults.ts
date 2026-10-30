import type { Account, AccountsMigration, AgentDef, AppSettings, AssistantProviderSettings, Connection, ConnectionDefaults, ConnectionsMoved, EffortLevel, LaunchValues, LegacyConnection, MovedField, ProjectAccountsMigration, ProjectConfig, ProviderId, WorkspaceConfig } from './types'
import { projectAgents } from './defaults'
import { AUTO_PROVIDER, DEFAULT_PROVIDER, PROVIDERS, installedAsHeard, isProviderEnabled, modeAllowed, projectProviderConfig, projectUse200k, providerDescriptor, providerSettings, splitArgs, type AgentLaunchSettings } from './providers'
import { baseConnection, connectionName, connectionsOn, joinArgs, launchValues, matchingConnection, resolveConnection } from './accounts'
import { ASSISTANT_AGENT_ID, assistantProjectConfig } from './assistant'

/**
 * The accounts migration (HI-2106, the design of HI-2105, s11 as revised by s13): today's connections become accounts,
 * and every agent and the Assistant point at the connection on their account that holds exactly what they launched with
 * at 16e8d6129, made if none is. One rule: what `SessionManager.effective()` launched it with, through whichever layer
 * applied (`connection` or `legacy`), kept here verbatim (legacyLaunchSettings, legacyEffective) as the migration's
 * reading of the old data, never used to launch. Also HI-1770's parts the migration still reads (the move of a project's
 * own model, effort and context onto its agents; its notice). Pure, for main and the tests.
 */

/** One value moved onto an agent that its connection can't use now (HI-1770): shown once, until dismissed. */
export interface MovedNotice {
  /** `<project path in lower case>|<moved entry's id>`: stable across opens and runs, for its dismissal. */
  key: string
  project: string
  agent: string
  field: MovedField
  value: string | boolean
}

/** The CLI's per-CLI defaults as a connection's (Settings → the CLI, before connections had them): what a legacy connection without defaults ran with. */
export function cliDefaults(settings: Pick<AppSettings, 'providers'>, provider: ProviderId): ConnectionDefaults {
  const g = providerSettings(settings, provider)
  return {
    ...(g.defaultModel ? { model: g.defaultModel } : {}),
    ...(g.defaultEffort ? { effort: g.defaultEffort } : {}),
    ...(providerDescriptor(provider).capabilities.contextLimit && g.use200kContext ? { use200kContext: true } : {})
  }
}

/**
 * The Assistant's own model, effort and context with connections, before HI-2106: its agent's (the Assistant's dialog),
 * else Settings → Assistant's for its CLI (its own settings, not a project's); its connection's defaults came after.
 */
export function assistantOwn<A extends Pick<AgentDef, 'model' | 'effort' | 'use200kContext'>>(agent: A | null | undefined, s: Partial<AssistantProviderSettings> | undefined): A | null | undefined {
  if (!s) return agent
  const context = agent?.use200kContext ?? (s.use200kContext === 'on' ? true : s.use200kContext === 'off' ? false : undefined)
  return { ...(agent ?? ({} as A)), model: agent?.model || s.model || undefined, effort: agent?.effort || s.effort || undefined, use200kContext: context }
}

/**
 * What the Assistant runs with when its own agent sets nothing (HI-1770): Settings → Assistant's for its CLI, else its
 * connection's defaults; null connection (none usable): Settings → Assistant's alone.
 */
export function assistantDefaults(s: Partial<AssistantProviderSettings> | undefined, conn: { defaults?: ConnectionDefaults } | null): ConnectionDefaults {
  const d = conn?.defaults
  const context = s?.use200kContext === 'on' ? true : s?.use200kContext === 'off' ? false : d?.use200kContext
  return { ...(s?.model || d?.model ? { model: s?.model || d?.model } : {}), ...(s?.effort || d?.effort ? { effort: (s?.effort || d?.effort) as EffortLevel } : {}), ...(context !== undefined ? { use200kContext: context } : {}) }
}

/** A project's own model, effort and context for a CLI, where it set one (not inherit): what moves onto its agents. */
export function projectOverrides(cfg: Pick<ProjectConfig, 'providers'>, provider: ProviderId): Partial<Record<MovedField, string | boolean>> {
  const pc = projectProviderConfig(cfg, provider)
  return {
    ...(pc.model && pc.model !== 'inherit' ? { model: pc.model } : {}),
    ...(pc.effort && pc.effort !== 'inherit' ? { effort: pc.effort } : {}),
    ...(providerDescriptor(provider).capabilities.contextLimit && (pc.use200kContext === 'on' || pc.use200kContext === 'off') ? { use200kContext: pc.use200kContext === 'on' } : {})
  }
}

/** Whether an agent has its own value for a field: a model or effort chosen, a context on or off (an explicit off counts). */
const hasOwn = (a: AgentDef, f: MovedField): boolean => (f === 'use200kContext' ? typeof a.use200kContext === 'boolean' : !!a[f])

/**
 * A CLI's project overrides moved onto the project's agents of that CLI (`providerOf`), each only where the agent has
 * none of its own (an explicit value is never overwritten, and nothing is given where the project set nothing), with
 * the record of it (`migrations.connections1[provider]`), as one patch. Null when it was done already. Since HI-2106 only
 * the accounts migration makes it, for a project a launch hadn't moved yet, as that launch would have.
 */
export function moveProjectOverrides(cfg: ProjectConfig, provider: ProviderId, providerOf: (a: AgentDef) => ProviderId, at: string): Pick<ProjectConfig, 'agents' | 'migrations'> | null {
  if (cfg.migrations?.connections1?.[provider]) return null
  const values = projectOverrides(cfg, provider)
  const moved: ConnectionsMoved['moved'] = []
  const agents = projectAgents(cfg).map((a) => {
    if (providerOf(a) !== provider) return a
    const next: AgentDef = { ...a }
    for (const [f, v] of Object.entries(values) as [MovedField, string | boolean][]) {
      if (hasOwn(a, f)) continue
      ;(next as Record<MovedField, unknown>)[f] = v
      moved.push({ id: `${provider}:${a.id}:${f}`, agent: a.id, field: f, value: v })
    }
    return next
  })
  return { agents, migrations: { ...cfg.migrations, connections1: { ...cfg.migrations?.connections1, [provider]: { at, moved } } } }
}

// ---------------------------------------------------------------------------
// The launch at 16e8d6129, verbatim: the migration's reading of the old data.
// ---------------------------------------------------------------------------

/** The settings a 0.9 launch is read with: the providers, the default provider and the providers' order (`providerOrder`: where a caller has it). */
type LegacySettings = Pick<AppSettings, 'providers' | 'defaultProvider'> & Partial<Pick<AppSettings, 'providerOrder'>>

/**
 * Automatic's pick at 16e8d6129 (its autoProvider over orderedProviders): the first provider turned on and installed in
 * the user's order (`providerOrder`'s first, then Hive's), else the first turned on, else Claude Code. Its own, not
 * today's autoProvider (Hive's order since HI-2139), so a 0.9 launch is read as it ran.
 */
function legacyAutoProvider(settings: LegacySettings): ProviderId {
  const order = Array.isArray(settings.providerOrder) ? settings.providerOrder : []
  const rank = (id: ProviderId): number => {
    const i = order.indexOf(id)
    return i < 0 ? order.length + PROVIDERS.findIndex((p) => p.id === id) : i
  }
  const on = [...PROVIDERS].sort((a, b) => rank(a.id) - rank(b.id)).filter((p) => isProviderEnabled(settings, p.id))
  return (on.find((p) => installedAsHeard(p.id) !== false) ?? on[0])?.id ?? DEFAULT_PROVIDER
}

/**
 * The CLI an agent ran at 16e8d6129 (its agentProvider): its own, else its project's default (the Assistant's home:
 * Settings → Assistant's, assistantProjectConfig), else Settings' default, else Automatic's pick (legacyAutoProvider).
 * Only the migration reads the 0.9 default providers and order (decision A, HI-2132, HI-2139).
 */
function legacyProvider(agent: Pick<AgentDef, 'provider'> | null | undefined, cfg: Pick<ProjectConfig, 'defaultProvider'> | null | undefined, settings: LegacySettings): ProviderId {
  if (agent?.provider) return agent.provider
  const own = cfg?.defaultProvider
  if (own && own !== 'inherit' && own !== AUTO_PROVIDER) return own
  const global = settings.defaultProvider
  return global && global !== AUTO_PROVIDER ? global : legacyAutoProvider(settings)
}

/**
 * Where model, effort and context came from after an agent's own (HI-1770): `legacy`, the project's for its CLI, then
 * the per-CLI defaults; `connection`, the connection it ran on: its defaults, never the project's or the CLI's; `conn`
 * null when none could be used (then the agent's own alone). Permission mode and extra arguments were the CLI's and the
 * project's either way.
 */
export type LaunchLayer = { kind: 'legacy' } | { kind: 'connection'; conn: Pick<LegacyConnection, 'defaults' | 'kind'> | null }

/** What an agent launched with before HI-2106 (16e8d6129's agentLaunchSettings): its own, else the project's, else the global defaults; with a connection (`layer`), else its defaults. */
export function legacyLaunchSettings(agent: Pick<AgentDef, 'provider' | 'model' | 'effort' | 'permissionMode' | 'use200kContext'> | null | undefined, cfg: Pick<ProjectConfig, 'providers' | 'defaultProvider'>, settings: LegacySettings, layer: LaunchLayer = { kind: 'legacy' }): AgentLaunchSettings {
  const provider = legacyProvider(agent, cfg, settings)
  const g = providerSettings(settings, provider)
  const pc = projectProviderConfig(cfg, provider)
  const fallbackMode = modeAllowed(provider, g.defaultPermissionMode, settings) ? g.defaultPermissionMode : providerDescriptor(provider).defaultPermissionMode
  const projectMode = pc.permissionMode === 'inherit' ? fallbackMode : pc.permissionMode
  let permissionMode = agent?.permissionMode ?? projectMode
  if (!modeAllowed(provider, permissionMode, settings)) permissionMode = modeAllowed(provider, projectMode, settings) ? projectMode : fallbackMode
  const extraArgs = [g.extraArgs, pc.extraArgs].filter((a) => a && a.trim())
  const contextLimit = providerDescriptor(provider).capabilities.contextLimit
  if (layer.kind === 'connection') {
    const d = layer.conn?.defaults
    if (layer.conn?.kind === 'server') return { provider, model: agent?.model || d?.model || null, effort: null, permissionMode, extraArgs, use200kContext: false }
    return { provider, model: agent?.model || d?.model || null, effort: agent?.effort || d?.effort || null, permissionMode, extraArgs, use200kContext: contextLimit && (agent?.use200kContext ?? d?.use200kContext ?? false) }
  }
  const model = agent?.model || (pc.model && pc.model !== 'inherit' ? pc.model : g.defaultModel || null)
  const effort = agent?.effort || (pc.effort !== 'inherit' ? pc.effort : g.defaultEffort || null)
  const use200kContext = contextLimit && (agent?.use200kContext ?? projectUse200k(pc, g))
  return { provider, model, effort, permissionMode, extraArgs, use200kContext }
}

/** What the old data is read with: the global settings (never copied in bulk), the workspace's file, the old connections, and the CLIs a test copy ran on its CLI test home where none was on (the seam). */
export interface LegacyInputs {
  settings: Pick<AppSettings, 'providers' | 'defaultProvider' | 'providerOrder' | 'assistant'>
  ws: Pick<WorkspaceConfig, 'connections' | 'assistantConnection'> | null
  legacy: readonly LegacyConnection[]
  seam: (cli: ProviderId) => boolean
}

/** One agent's launch at 16e8d6129: its CLI, values (as a connection keeps them), and the account it ran on (null: none, or the CLI's own home). */
export interface LegacyLaunch {
  cli: ProviderId
  values: LaunchValues
  /** The launch as the old code gave it, for the upgrade test. */
  settings: AgentLaunchSettings
  account: string | null
  /** Through the connection layer (a CLI with connections), not the legacy one (Copilot). */
  layered: boolean
  /** A test copy on its CLI test home (no account on, the seam): it ran on the CLI's own home. */
  seam: boolean
  /** Its own model, effort and context (an explicit off kept), for one with no account to go to yet (`unplaced`). */
  own: Pick<AgentDef, 'model' | 'effort' | 'use200kContext'>
}

/**
 * What SessionManager.effective() launched an agent (or the Assistant: `pc` its home's as workspace.projectConfig read it,
 * assistantProjectConfig) with at 16e8d6129, with the project's HI-1770 move made first as that launch would have, and
 * the account it ran on. `pick`: as if it ran on that account (an agent whose own was removed or off, decision H).
 */
export function legacyEffective(agent: AgentDef, pc: ProjectConfig, assistant: boolean, inp: LegacyInputs, at: string, pick?: string): LegacyLaunch {
  const s = inp.settings
  let cfg = pc
  let forAgent = agent
  const movedCli = legacyProvider(forAgent, cfg, s)
  const layered = !!providerDescriptor(movedCli).capabilities.connections
  if (layered && !assistant && !cfg.migrations?.connections1?.[movedCli]) {
    const patch = moveProjectOverrides(cfg, movedCli, (a) => legacyProvider(a, cfg, s), at)
    if (patch) cfg = { ...cfg, ...patch }
    const fresh = projectAgents(cfg).find((a) => a.id === forAgent.id)
    if (fresh) forAgent = { ...fresh, provider: forAgent.provider ?? fresh.provider }
  }
  const cli = legacyProvider(forAgent, cfg, s)
  const wanted = assistant ? inp.ws?.assistantConnection?.[cli] : forAgent.connection
  const choice = layered && cli === movedCli ? (pick ? ({ ok: true, id: pick } as const) : resolveConnection(inp.ws, cli, wanted, inp.legacy)) : null
  const conn = choice?.ok ? (inp.legacy.find((c) => c.id === choice.id) ?? null) : null
  const own = choice && assistant ? assistantOwn(forAgent, s.assistant?.providers?.[cli]) : forAgent
  const l = legacyLaunchSettings(own, cfg, s, choice ? { kind: 'connection', conn } : { kind: 'legacy' })
  const server = conn?.kind === 'server'
  const values = launchValues({ model: l.model ?? undefined, effort: l.effort ?? undefined, use200kContext: l.use200kContext, permissionMode: l.permissionMode, extraArgs: joinArgs(l.extraArgs, splitArgs) }, cli, server)
  const mine = { ...(own?.model ? { model: own.model } : {}), ...(own?.effort ? { effort: own.effort } : {}), ...(typeof own?.use200kContext === 'boolean' ? { use200kContext: own.use200kContext } : {}) }
  return { cli, values, settings: l, account: choice?.ok ? choice.id : null, layered: !!choice, seam: !!choice && !choice.ok && choice.why === 'none' && inp.seam(cli), own: mine }
}

// ---------------------------------------------------------------------------
// The migration: accounts, connections made by the rule, deduplicated.
// ---------------------------------------------------------------------------

/** Copilot's one PC-wide sign-in as an account (decision C): made by Hive, never removed, on the CLI's own home. */
export const COPILOT_ACCOUNT = 'copilot'

/** A test copy's CLI test home as an account (the seam, connectionSeam.ts): its id. */
export const seamAccountId = (cli: ProviderId): string => `cli-${cli}`

/** What the migration makes connections in: the accounts and connections as they are now, changed in place. */
export interface AccountStore {
  accounts: Account[]
  connections: Connection[]
  newId: () => string
}

/** An account of the CLI's own home (Copilot's sign-in, a test home): made in the store if it isn't there. */
export function homeAccount(store: AccountStore, cli: ProviderId, at: string): Account {
  const id = cli === 'copilot' ? COPILOT_ACCOUNT : seamAccountId(cli)
  let a = store.accounts.find((x) => x.id === id)
  if (!a) {
    a = { id, provider: cli, kind: 'signIn', home: 'cli', name: providerDescriptor(cli).name, createdAt: at }
    store.accounts.push(a)
  }
  return a
}

/**
 * The connection on an account with these values (HI-2106's one rule): one that has them, else one made after the
 * account's others, named after what differs from its base connection (`label` instead, for the Assistant's), or after
 * the account when it is the account's first.
 */
export function connectionFor(store: AccountStore, accountId: string, values: LaunchValues, label?: string): Connection {
  const a = store.accounts.find((x) => x.id === accountId)
  if (!a) throw new Error(`no account ${accountId}`) // i18n-ignore: a bug's message, never shown
  const found = matchingConnection(a, values, store.connections)
  if (found) return found
  const server = a.kind === 'server'
  const v = launchValues(values, a.provider, server)
  const base = baseConnection(a.id, store.connections)
  const c: Connection = { id: store.newId(), account: a.id, name: connectionName(a, v, base && launchValues(base, a.provider, server), connectionsOn(a.id, store.connections).map((x) => x.name), label), ...v }
  // After the account's last connection, so each account's stay together and its first stays its base.
  const last = store.connections.map((x) => x.account).lastIndexOf(a.id)
  store.connections.splice(last < 0 ? store.connections.length : last + 1, 0, c)
  return c
}

/** A project without settings of its own: an account's base connection is what an agent with nothing of its own on it launched with. */
const NO_PROJECT = { providers: {}, defaultProvider: 'inherit' } as unknown as Pick<ProjectConfig, 'providers' | 'defaultProvider'>

/**
 * The connections as config.json had them, as a launch read them at 16e8d6129: those made before they had defaults given
 * the CLI's old per-CLI ones (seedConnectionDefaults, which ran at every start before anything launched).
 */
export function seededLegacy(connections: readonly LegacyConnection[], settings: Pick<AppSettings, 'providers'>): LegacyConnection[] {
  return connections.map((a) => (a.defaults === undefined ? { ...a, defaults: cliDefaults(settings, a.provider), defaultsFrom: 'cli' as const } : a))
}

/**
 * config.json's migration (once, at start): each old connection becomes the account with its id (its folder, key and
 * usage stay), with its base connection, named after it, holding what an agent with nothing of its own on it launched
 * with (its defaults, the CLI's mode and extra arguments, no project's); Copilot's sign-in becomes its account (decision
 * C), its base connection Settings → GitHub Copilot's values (its launches were the legacy layer's). The old connections
 * are kept in the record, read-only, for each workspace's migration.
 */
export function migrateAccounts(old: readonly LegacyConnection[], settings: Pick<AppSettings, 'providers' | 'defaultProvider'>, at: string, newId: () => string): { accounts: Account[]; connections: Connection[]; migration: AccountsMigration } {
  const legacy = seededLegacy(old, settings)
  const store: AccountStore = { accounts: legacy.map(({ defaults: _d, defaultsFrom: _f, ...a }) => a), connections: [], newId }
  homeAccount(store, 'copilot', at)
  for (const a of store.accounts) connectionFor(store, a.id, baseValues(a, settings, legacy.find((c) => c.id === a.id)?.defaults ?? {}))
  return { accounts: store.accounts, connections: store.connections, migration: { at, legacy } }
}

/**
 * An account's base connection's values (HI-2106): what an agent with nothing of its own on it launched with before
 * connections were setups: `defaults` (its old connection's), then the CLI's mode and extra arguments, and no project's;
 * the legacy layer's for a CLI without connections (Copilot: Settings → GitHub Copilot's).
 */
export function baseValues(a: Pick<Account, 'provider' | 'kind'>, settings: Pick<AppSettings, 'providers' | 'defaultProvider'>, defaults: ConnectionDefaults): LaunchValues {
  const layered = !!providerDescriptor(a.provider).capabilities.connections
  const l = legacyLaunchSettings({ provider: a.provider }, NO_PROJECT, settings, layered ? { kind: 'connection', conn: { kind: a.kind, defaults } } : { kind: 'legacy' })
  return launchValues({ model: l.model ?? undefined, effort: l.effort ?? undefined, use200kContext: l.use200kContext, permissionMode: l.permissionMode, extraArgs: joinArgs(l.extraArgs, splitArgs) }, a.provider, a.kind === 'server')
}

/**
 * The account an agent's old launch goes to: the one it ran on; for the legacy layer (Copilot) or a test home, the CLI's
 * own home's; one removed since, or none it could use (decision H: it resolves as the workspace would, then is pinned):
 * the first of its CLI on in the workspace, else its CLI's first; none at all: null.
 */
function accountOf(l: LegacyLaunch, inp: LegacyInputs, store: AccountStore, at: string): string | null {
  if (!l.layered && !providerDescriptor(l.cli).capabilities.connections) return homeAccount(store, l.cli, at).id
  if (l.account && store.accounts.some((a) => a.id === l.account && a.provider === l.cli)) return l.account
  if (l.seam) return homeAccount(store, l.cli, at).id
  const here = resolveConnection(inp.ws, l.cli, undefined, store.accounts.filter((a) => !a.home))
  if (here.ok) return here.id
  return store.accounts.find((a) => a.provider === l.cli && !a.home)?.id ?? null
}

/** An agent without its own launch settings (HI-2106: its connection holds them). */
function withoutOwn(a: AgentDef): AgentDef {
  const { model: _m, effort: _e, permissionMode: _p, use200kContext: _c, connection: _x, ...rest } = a
  return rest
}

/**
 * One agent pointed at its connection: its launch at 16e8d6129 (on the account it falls back to when its own was removed
 * or unusable, as if it ran there), the connection with those values on that account, made if none is.
 */
function placeAgent(a: AgentDef, pc: ProjectConfig, assistant: boolean, inp: LegacyInputs, store: AccountStore, at: string, label?: string): { agent: AgentDef; connection: Connection | null; values: LaunchValues } {
  let l = legacyEffective(a, pc, assistant, inp, at)
  const account = accountOf(l, inp, store, at)
  // No account of its CLI at all (an upgrade from 0.9 before one was added): its own values and the mode and arguments it
  // would launch with are kept, for the account it gets later (placeUnplaced), as a launch then would have used them.
  if (!account) return { agent: { ...withoutOwn(a), provider: l.cli }, connection: null, values: { ...l.own, permissionMode: l.settings.permissionMode, ...(l.settings.extraArgs.length ? { extraArgs: joinArgs(l.settings.extraArgs, splitArgs) } : {}) } }
  if (l.layered && account !== l.account && inp.legacy.some((c) => c.id === account)) l = legacyEffective(a, pc, assistant, inp, at, account)
  const c = connectionFor(store, account, l.values, label)
  return { agent: { ...withoutOwn(a), provider: l.cli, connection: c.id }, connection: c, values: l.values }
}

/**
 * A project's migration (when its workspace opens, or before anything launches there): each agent pointed at the
 * connection it launched with (connections made in `store`), its own launch settings removed, and the project's own
 * (`providers`, `defaultProvider`) removed, with HI-1770's moves recorded as a launch would have made them and the
 * record of this one (`unplaced`: an agent whose CLI has no account at all keeps no connection, its values recorded).
 * Null when it was migrated already.
 */
export function migrateProject(cfg: ProjectConfig, inp: LegacyInputs, store: AccountStore, at: string): ProjectConfig | null {
  if (cfg.migrations?.accounts1) return null
  let pc = cfg
  // HI-1770's move for each CLI with connections its agents run, as their launch would have made it: its record kept for the notice.
  for (const cli of new Set(projectAgents(pc).map((a) => legacyProvider(a, pc, inp.settings)))) {
    if (!providerDescriptor(cli).capabilities.connections) continue
    const patch = moveProjectOverrides(pc, cli, (a) => legacyProvider(a, pc, inp.settings), at)
    if (patch) pc = { ...pc, ...patch }
  }
  const unplaced: Record<string, LaunchValues> = {}
  const agents = projectAgents(pc).map((a) => {
    const r = placeAgent(a, pc, false, inp, store, at)
    if (!r.connection) unplaced[a.id] = r.values
    return r.agent
  })
  const record: ProjectAccountsMigration = { at, ...(Object.keys(unplaced).length ? { unplaced } : {}) }
  const { providers: _p, defaultProvider: _d, ...rest } = pc
  return { ...(rest as ProjectConfig), agents, migrations: { ...pc.migrations, accounts1: record } }
}

/** Whether the Assistant had a setup for a CLI in a workspace (s13): its connection chosen there, or any value of Settings → Assistant's for it. */
export function assistantHasSetup(cli: ProviderId, inp: LegacyInputs): boolean {
  if (inp.ws?.assistantConnection?.[cli]) return true
  const s = inp.settings.assistant?.providers?.[cli]
  return !!s && Object.values(s).some((v) => v !== '' && v !== undefined && v !== null)
}

/**
 * The Assistant's home's migration (`raw`: its project.json as kept, not as read): for each CLI it had a setup for in the
 * workspace (and the one it runs), its launch on that CLI as it would have run it then becomes a connection on the account
 * it resolved to ("<account> · Assistant" where it differs from the base); the active one's is its agent's. Null when
 * it was migrated already.
 */
export function migrateAssistant(raw: ProjectConfig, inp: LegacyInputs, store: AccountStore, at: string): ProjectConfig | null {
  if (raw.migrations?.accounts1) return null
  const pc = assistantProjectConfig(raw, inp.settings as AppSettings)
  const agent = projectAgents(pc)[0] ?? { id: ASSISTANT_AGENT_ID, name: '' }
  const active = legacyProvider(agent, pc, inp.settings)
  const made: Partial<Record<ProviderId, string>> = {}
  const unplaced: Record<string, LaunchValues> = {}
  let placed: AgentDef = { ...withoutOwn(agent), provider: active }
  for (const p of PROVIDERS) {
    if (p.id !== active && !assistantHasSetup(p.id, inp)) continue
    const r = placeAgent({ ...agent, provider: p.id }, pc, true, inp, store, at, 'Assistant') // i18n-ignore: a connection's name, the user's data once made
    if (r.connection) made[p.id] = r.connection.id
    if (p.id !== active) continue
    placed = r.agent
    if (!r.connection) unplaced[agent.id] = r.values
  }
  const record: ProjectAccountsMigration = { at, assistant: made, ...(Object.keys(unplaced).length ? { unplaced } : {}) }
  const { providers: _p, defaultProvider: _d, ...rest } = raw
  // Its agent keeps what it had besides (its mode, its id).
  return { ...(rest as ProjectConfig), agents: [{ ...placed, id: ASSISTANT_AGENT_ID }], migrations: { ...raw.migrations, accounts1: record } }
}

/** A workspace.json without its own launch sources (HI-2106): the Assistant's old choices, and each provider's stored default. */
export function migrateWorkspaceFile(cfg: WorkspaceConfig, at: string): WorkspaceConfig | null {
  if (cfg.migrations?.accounts1) return null
  const { assistantConnection: _a, ...rest } = cfg
  const connections = cfg.connections ? Object.fromEntries(Object.entries(cfg.connections).map(([p, w]) => [p, { on: w?.on ?? [] }])) : undefined
  return { ...rest, ...(connections ? { connections } : {}), migrations: { ...cfg.migrations, accounts1: { at } } }
}

/**
 * Whether an agent waits for a connection (HI-2106): it has none, and the migration kept its values (`unplaced`), or it
 * keeps its own model, effort, mode or context (set while its CLI had no account: today's screens' adapter).
 */
export function waitsForConnection(a: AgentDef, cfg: Pick<ProjectConfig, 'migrations'>): boolean {
  return !a.connection && (!!cfg.migrations?.accounts1?.unplaced?.[a.id] || hasOwnLaunch(a))
}

const hasOwnLaunch = (a: AgentDef): boolean => !!a.model || !!a.effort || !!a.permissionMode || typeof a.use200kContext === 'boolean'

/**
 * A project's agents waiting for a connection (waitsForConnection) pointed at one once their CLI has an account
 * (`accountFor`): the connection with their own values (the record's, then the agent's own over them) over the account's
 * base connection's, and the mode and extra arguments they would have launched with, as a launch then would have run
 * them; their own fields and record entries go. `label`: the Assistant's. Null when none could be placed; with `placed`,
 * which agent got which connection.
 */
export function placeUnplaced(cfg: ProjectConfig, accountFor: (cli: ProviderId) => string | null, store: AccountStore, label?: string): { cfg: ProjectConfig; placed: Record<string, Connection> } | null {
  const record = cfg.migrations?.accounts1
  if (!record) return null
  const u = record.unplaced ?? {}
  const left = { ...u }
  const placed: Record<string, Connection> = {}
  let changed = false
  const agents = projectAgents(cfg).map((a) => {
    if (a.connection) {
      // Given one since (by its settings): nothing left to place.
      if (u[a.id]) {
        delete left[a.id]
        changed = true
      }
      return a
    }
    if (!waitsForConnection(a, cfg)) return a
    const account = a.provider ? accountFor(a.provider) : null
    if (!account) return a
    const v: LaunchValues = { ...u[a.id], ...(a.model ? { model: a.model } : {}), ...(a.effort ? { effort: a.effort } : {}), ...(a.permissionMode ? { permissionMode: a.permissionMode } : {}), ...(typeof a.use200kContext === 'boolean' ? { use200kContext: a.use200kContext } : {}) }
    const base = baseConnection(account, store.connections)
    const c = connectionFor(store, account, { model: v.model ?? base?.model, effort: v.effort ?? base?.effort, use200kContext: v.use200kContext ?? base?.use200kContext, permissionMode: v.permissionMode ?? base?.permissionMode, extraArgs: u[a.id] ? v.extraArgs : base?.extraArgs }, label)
    delete left[a.id]
    placed[a.id] = c
    changed = true
    return { ...withoutOwn(a), connection: c.id }
  })
  if (!changed) return null
  const { unplaced: _u, ...rest } = record
  return { cfg: { ...cfg, agents, migrations: { ...cfg.migrations, accounts1: { ...rest, ...(Object.keys(left).length ? { unplaced: left } : {}) } } }, placed }
}
