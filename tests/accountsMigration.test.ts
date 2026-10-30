import { describe, expect, it } from 'vitest'
import type { Account, AgentDef, AppSettings, Connection, LegacyConnection, ProjectConfig, ProviderId, WorkspaceConfig } from '../src/shared/types'
import { DEFAULT_APP_CONFIG, DEFAULT_PROJECT_CONFIG, DEFAULT_SETTINGS, mergeDefaults, migrateConfig, migrateProjectConfig, withLegacyProjectFields } from '../src/shared/defaults'
import { agentLaunchSettings, autoProvider, setInstalledCheck, splitArgs } from '../src/shared/providers'
import { connectionName, joinArgs, launchValues, matchingConnection, resolveAgentConnection, sameValues } from '../src/shared/accounts'
import { type AccountStore, type LegacyInputs, COPILOT_ACCOUNT, assistantHasSetup, baseValues, connectionFor, legacyEffective, legacyLaunchSettings, migrateAccounts, migrateAssistant, migrateProject, migrateWorkspaceFile, placeUnplaced, seamAccountId } from '../src/shared/connectionDefaults'
import { ASSISTANT_AGENT_ID, assistantProjectConfig } from '../src/shared/assistant'

/**
 * The accounts migration (HI-2106): the data model, each row of HI-2105's table (s11 as revised by s13), and the full
 * upgrade of an rc.12-shaped profile, whose every agent and Assistant must launch exactly as before.
 */

setInstalledCheck(() => true)

const AT = '2026-10-30T12:00:00.000Z'
let n = 0
const newId = (): string => `c-${(++n).toString(16).padStart(8, '0')}`

const settingsOf = (patch: Record<string, unknown>): AppSettings => mergeDefaults(structuredClone(DEFAULT_SETTINGS), patch)
const projectOf = (patch: Record<string, unknown>): ProjectConfig => mergeDefaults(structuredClone(DEFAULT_PROJECT_CONFIG), migrateProjectConfig(structuredClone(patch)))
const account = (id: string, provider: ProviderId, extra: Partial<LegacyConnection> = {}): LegacyConnection => ({ id, provider, name: id, createdAt: AT, kind: 'signIn', ...extra })

/** What a launch gives the CLI, the part the migration must keep. */
interface Launched {
  cli: ProviderId
  model: string | null
  effort: string | null
  context: boolean
  mode: string
  args: string[]
  /** The account folder it runs in (its id), or null: the CLI's own home. */
  folder: string | null
}

/** A launch at 16e8d6129 (SessionManager.effective, verbatim in legacyEffective). */
function before(agent: AgentDef, pc: ProjectConfig, assistant: boolean, inp: LegacyInputs): Launched {
  const l = legacyEffective(agent, pc, assistant, inp, AT)
  return { cli: l.cli, model: l.settings.model, effort: l.settings.effort, context: l.settings.use200kContext, mode: l.settings.permissionMode, args: l.settings.extraArgs.flatMap((a) => splitArgs(a)), folder: l.seam || !l.layered ? null : l.account }
}

/** A launch now: the agent's connection only (sessions.ts effectiveHere). */
function after(agent: AgentDef, ws: Pick<WorkspaceConfig, 'connections'>, store: Pick<AccountStore, 'accounts' | 'connections'>, settings: AppSettings): Launched {
  const cli = agent.provider!
  const r = resolveAgentConnection(ws, cli, agent.connection, store.accounts, store.connections)
  if (!r.ok) throw new Error(`${agent.name}: no connection (${r.why})`)
  const l = agentLaunchSettings(cli, r.connection, settings, r.account.kind === 'server')
  return { cli, model: l.model, effort: l.effort, context: l.use200kContext, mode: l.permissionMode, args: l.extraArgs.flatMap((a) => splitArgs(a)), folder: r.account.home ? null : r.account.id }
}

describe('connections: the model (HI-2106)', () => {
  it('keeps only what the CLI would not do anyway, and what its kind can take', () => {
    expect(launchValues({ model: ' opus ', effort: 'high', use200kContext: false, permissionMode: 'auto', extraArgs: '  ' }, 'claude-code')).toEqual({ model: 'opus', effort: 'high' })
    expect(launchValues({ model: 'deepseek', effort: 'high', use200kContext: true, permissionMode: 'manual' }, 'claude-code', true)).toEqual({ model: 'deepseek', permissionMode: 'manual' })
    // Codex has no context choice.
    expect(launchValues({ use200kContext: true }, 'codex')).toEqual({})
    expect(sameValues({ model: 'opus' }, { model: 'opus', effort: undefined })).toBe(true)
    expect(sameValues({ model: 'opus' }, { model: 'sonnet' })).toBe(false)
  })

  it('names a connection after its account, or after what differs from its base', () => {
    const a = { name: 'Personal', provider: 'claude-code' as const }
    expect(connectionName(a, { model: 'opus' }, { model: 'opus' }, [])).toBe('Personal')
    expect(connectionName(a, { model: 'opus', effort: 'high', permissionMode: 'plan' }, { model: 'opus' }, [])).toBe('Personal · High · Plan')
    expect(connectionName(a, { effort: 'high' }, {}, ['Personal · High'])).toBe('Personal · High (2)')
    expect(connectionName(a, { effort: 'high' }, {}, [], 'Assistant')).toBe('Personal · Assistant')
  })

  it('makes a connection once per setup on an account, after its others', () => {
    const store: AccountStore = { accounts: [account('a1', 'claude-code'), account('a2', 'claude-code')], connections: [], newId }
    const base = connectionFor(store, 'a1', {})
    connectionFor(store, 'a2', {})
    const high = connectionFor(store, 'a1', { effort: 'high' })
    expect(connectionFor(store, 'a1', { effort: 'high', permissionMode: 'auto' })).toBe(high)
    expect(store.connections.map((c) => c.account)).toEqual(['a1', 'a1', 'a2'])
    expect(matchingConnection(store.accounts[0], {}, store.connections)).toBe(base)
  })

  it('launches from the connection only: its values, else the CLI decides', () => {
    const s = settingsOf({ providers: { 'claude-code': { defaultModel: 'sonnet', defaultPermissionMode: 'plan', extraArgs: '--global' } } })
    expect(agentLaunchSettings('claude-code', {}, s)).toMatchObject({ model: null, effort: null, permissionMode: 'auto', extraArgs: [], use200kContext: false })
    expect(agentLaunchSettings('claude-code', { model: 'opus', effort: 'max', use200kContext: true, permissionMode: 'plan', extraArgs: '--x' }, s)).toMatchObject({ model: 'opus', effort: 'max', permissionMode: 'plan', extraArgs: ['--x'], use200kContext: true })
    // A no-guardrails mode switched off since: the CLI's default; a server account: no effort or context.
    expect(agentLaunchSettings('claude-code', { permissionMode: 'bypassPermissions' }, s).permissionMode).toBe('auto')
    expect(agentLaunchSettings('claude-code', { effort: 'high', use200kContext: true }, s, true)).toMatchObject({ effort: null, use200kContext: false })
  })

  it('resolves an agent to its connection, else its CLI\'s first usable one, saying so (decision H)', () => {
    const accounts: Account[] = [account('a1', 'claude-code'), account('a2', 'claude-code'), { ...account(COPILOT_ACCOUNT, 'copilot'), home: 'cli' }]
    const connections: Connection[] = [{ id: 'c1', account: 'a1', name: 'a1' }, { id: 'c1h', account: 'a1', name: 'a1 · High', effort: 'high' }, { id: 'c2', account: 'a2', name: 'a2' }, { id: 'cp', account: COPILOT_ACCOUNT, name: 'Copilot' }]
    const ws = { connections: { 'claude-code': { on: ['a2'] } } }
    expect(resolveAgentConnection(ws, 'claude-code', 'c2', accounts, connections)).toMatchObject({ ok: true, connection: { id: 'c2' } })
    expect(resolveAgentConnection(ws, 'claude-code', 'c1h', accounts, connections)).toMatchObject({ ok: true, connection: { id: 'c2' }, note: 'offFallback' })
    expect(resolveAgentConnection(ws, 'claude-code', 'gone', accounts, connections)).toMatchObject({ ok: true, connection: { id: 'c2' }, note: 'missing' })
    expect(resolveAgentConnection(ws, 'claude-code', undefined, accounts, connections)).toEqual({ ok: true, connection: connections[2], account: accounts[1] })
    // Copilot's sign-in is on everywhere.
    expect(resolveAgentConnection({}, 'copilot', 'cp', accounts, connections)).toMatchObject({ ok: true, connection: { id: 'cp' } })
    expect(resolveAgentConnection({}, 'claude-code', 'c1', accounts, connections)).toEqual({ ok: false, why: 'offNoDefault', wanted: 'c1' })
    expect(resolveAgentConnection({}, 'codex', undefined, accounts, connections)).toEqual({ ok: false, why: 'none' })
  })

  it('joins extra arguments so they split into exactly the same', () => {
    expect(joinArgs(['--a 1', '--b'], splitArgs)).toBe('--a 1 --b')
    expect(joinArgs(['--x "foo', 'bar"'], splitArgs)).not.toBe('--x "foo bar"')
    expect(splitArgs(joinArgs(['--x "foo', 'bar"'], splitArgs))).toEqual([...splitArgs('--x "foo'), ...splitArgs('bar"')])
    expect(splitArgs(joinArgs(['--msg "a b"', "--n 'c d'"], splitArgs))).toEqual(['--msg', 'a b', '--n', 'c d'])
  })
})

describe('the accounts migration: each row (HI-2105 s11, s13)', () => {
  const settings = settingsOf({
    providers: {
      'claude-code': { enabled: true, defaultModel: 'sonnet', defaultEffort: 'low', defaultPermissionMode: 'acceptEdits', extraArgs: '--verbose', use200kContext: true },
      codex: { enabled: true, defaultPermissionMode: 'ask', extraArgs: '-c foo=1' },
      copilot: { enabled: true, defaultModel: 'gpt-5', defaultPermissionMode: 'plan', extraArgs: '--banner' }
    }
  })

  it('config.json: each connection becomes the account with its id, its defaults its base connection; Copilot becomes an account', () => {
    const old = [account('a-1', 'claude-code', { name: 'Personal', defaults: { model: 'opus' }, accepted: { email: 'd@x', orgId: 'o' } }), account('a-2', 'claude-code', { name: 'Work', defaults: {} }), account('a-3', 'codex', { name: 'Codex' })]
    const r = migrateAccounts(old, settings, AT, newId)
    expect(r.accounts.map((a) => a.id)).toEqual(['a-1', 'a-2', 'a-3', COPILOT_ACCOUNT])
    expect(r.accounts[0]).toEqual({ id: 'a-1', provider: 'claude-code', name: 'Personal', createdAt: AT, kind: 'signIn', accepted: { email: 'd@x', orgId: 'o' } })
    expect(r.accounts[3]).toMatchObject({ provider: 'copilot', home: 'cli' })
    const base = (id: string): Connection => r.connections.find((c) => c.account === id)!
    // Its defaults, the CLI's mode and arguments; never the global 200K context (the connection layer ignored it).
    expect(base('a-1')).toMatchObject({ name: 'Personal', model: 'opus', permissionMode: 'acceptEdits', extraArgs: '--verbose' })
    expect(base('a-1').use200kContext).toBeUndefined()
    expect(base('a-2').model).toBeUndefined()
    // A connection from before defaults (absent): the CLI's old per-CLI ones, as seedConnectionDefaults gave it.
    expect(base('a-3')).toMatchObject({ name: 'Codex', permissionMode: 'ask', extraArgs: '-c foo=1' })
    // Copilot's: Settings → GitHub Copilot's (its launches were the legacy layer's).
    expect(base(COPILOT_ACCOUNT)).toMatchObject({ model: 'gpt-5', permissionMode: 'plan', extraArgs: '--banner' })
    expect(r.migration.legacy[2].defaults).toEqual({})
  })

  it("an account's base connection is what an agent with nothing of its own launched with", () => {
    expect(baseValues({ provider: 'claude-code', kind: 'server' }, settings, { model: 'deepseek', effort: 'high' })).toEqual({ model: 'deepseek', permissionMode: 'acceptEdits', extraArgs: '--verbose' })
  })

  it('a global 200K context is carried where its launch read it (the legacy layer), never onto a connection', () => {
    const legacy = legacyLaunchSettings({ provider: 'claude-code' }, projectOf({}), settings, { kind: 'legacy' })
    expect(legacy.use200kContext).toBe(true)
    const values = launchValues({ ...legacy, model: legacy.model ?? undefined, effort: legacy.effort ?? undefined, extraArgs: legacy.extraArgs.join(' ') }, 'claude-code')
    expect(agentLaunchSettings('claude-code', values, settings).use200kContext).toBe(true)
    const layered = legacyLaunchSettings({ provider: 'claude-code' }, projectOf({}), settings, { kind: 'connection', conn: { defaults: {} } })
    expect(layered.use200kContext).toBe(false)
  })

  it('the Assistant has a setup for a CLI when its workspace chose one, or Settings → Assistant has any value for it', () => {
    const s = settingsOf({ assistant: { providers: { codex: { model: 'gpt-5.5' } } } })
    expect(assistantHasSetup('codex', { settings: s, ws: {}, legacy: [], seam: () => false })).toBe(true)
    expect(assistantHasSetup('copilot', { settings: s, ws: {}, legacy: [], seam: () => false })).toBe(false)
    expect(assistantHasSetup('copilot', { settings: s, ws: { assistantConnection: { copilot: 'x' } }, legacy: [], seam: () => false })).toBe(true)
  })

  it("workspace.json loses the Assistant's old choices and each CLI's stored default, once", () => {
    const ws = { version: 1, connections: { 'claude-code': { on: ['a-1'], default: 'a-1' } }, assistantConnection: { 'claude-code': 'a-1' }, mcp: { enabled: [] } } as WorkspaceConfig
    const next = migrateWorkspaceFile(ws, AT)!
    expect(next.connections).toEqual({ 'claude-code': { on: ['a-1'] } })
    expect('assistantConnection' in next).toBe(false)
    expect(migrateWorkspaceFile(next, AT)).toBeNull()
  })

  it("project.json's launch settings are never made again from 0.1's fields, nor written, once migrated", () => {
    const raw = { version: 2, agents: [], migrations: { accounts1: { at: AT } }, model: 'opus' }
    expect(migrateProjectConfig(raw).providers).toBeUndefined()
    const written = withLegacyProjectFields(projectOf({ migrations: { accounts1: { at: AT } }, providers: { 'claude-code': { model: 'opus' } } }))
    expect('providers' in written || 'defaultProvider' in written || 'model' in written).toBe(false)
  })

  it('an agent whose CLI has no account keeps its values until it has one, then gets them over the base', () => {
    const inp: LegacyInputs = { settings, ws: {}, legacy: [], seam: () => false }
    const store: AccountStore = { accounts: [], connections: [], newId }
    const pc = projectOf({ version: 2, agents: [{ id: 'x', name: 'X', provider: 'codex', effort: 'high' }] })
    const migrated = migrateProject(pc, inp, store, AT)!
    expect(migrated.agents[0].connection).toBeUndefined()
    expect(migrated.migrations?.accounts1?.unplaced).toEqual({ x: { effort: 'high', permissionMode: 'ask', extraArgs: '-c foo=1' } })
    // Nothing yet to place it on.
    expect(placeUnplaced(migrated, () => null, store)).toBeNull()
    store.accounts.push(account('a-9', 'codex'))
    connectionFor(store, 'a-9', { model: 'gpt-5.5', permissionMode: 'ask', extraArgs: '-c foo=1' })
    const placed = placeUnplaced(migrated, () => 'a-9', store)!
    const c = store.connections.find((x) => x.id === placed.cfg.agents[0].connection)!
    expect(c).toMatchObject({ account: 'a-9', model: 'gpt-5.5', effort: 'high', permissionMode: 'ask', extraArgs: '-c foo=1' })
    expect(placed.cfg.migrations?.accounts1?.unplaced).toBeUndefined()
  })

  it('a test copy on its CLI test home (the seam) gets that home as its account', () => {
    const inp: LegacyInputs = { settings, ws: {}, legacy: [], seam: (cli) => cli === 'claude-code' }
    const store: AccountStore = { accounts: [], connections: [], newId }
    const pc = projectOf({ version: 2, agents: [{ id: 'x', name: 'X', provider: 'claude-code', model: 'opus' }] })
    const migrated = migrateProject(pc, inp, store, AT)!
    expect(store.accounts).toEqual([expect.objectContaining({ id: seamAccountId('claude-code'), home: 'cli' })])
    expect(after(migrated.agents[0], {}, store, settings)).toEqual(before(pc.agents[0], pc, false, inp))
  })
})

describe('the full upgrade of an rc.12-shaped profile (HI-2106)', () => {
  // config.json as rc.12 kept it.
  const settings = settingsOf({
    defaultProvider: 'auto',
    providers: {
      'claude-code': { enabled: true, defaultModel: 'sonnet', defaultEffort: 'low', defaultPermissionMode: 'acceptEdits', extraArgs: '--verbose', use200kContext: true },
      codex: { enabled: true, defaultModel: 'gpt-5.4', defaultPermissionMode: 'ask', extraArgs: '-c model_reasoning_summary=auto' },
      copilot: { enabled: true, defaultModel: 'gpt-5', defaultPermissionMode: 'plan', extraArgs: '--banner', use200kContext: true }
    },
    assistant: {
      provider: 'claude-code',
      providers: {
        'claude-code': { model: 'opus', effort: '', permissionMode: '', extraArgs: '--assistant', use200kContext: '' },
        codex: { model: 'gpt-5.5', effort: 'high', permissionMode: '', extraArgs: '', use200kContext: '' }
      }
    }
  })
  const legacy: LegacyConnection[] = [
    account('a-personal', 'claude-code', { name: 'Personal', defaults: { model: 'opus', effort: 'medium' } }),
    // An account with no context default: a global 200K on doesn't reach its agents (they ran 1M).
    account('a-work', 'claude-code', { name: 'Work', defaults: {} }),
    account('a-deepseek', 'claude-code', { name: 'DeepSeek', kind: 'server', server: { baseUrl: 'https://api.deepseek.com/anthropic', models: [{ id: 'deepseek-v4', as: ['opus'] }], modelsFrom: 'typed' }, defaults: { model: 'deepseek-v4', effort: 'high' } }),
    account('a-codex', 'codex', { name: 'Codex', defaults: { model: 'gpt-5.5' } }),
    account('a-old', 'codex', { name: 'Old', defaults: {} })
  ]
  const wsFile = { version: 1, mcp: { enabled: [] }, connections: { 'claude-code': { on: ['a-personal', 'a-work', 'a-deepseek'], default: 'a-personal' }, codex: { on: ['a-codex'], default: 'a-codex' } }, assistantConnection: { 'claude-code': 'a-work', codex: 'a-codex' } } as unknown as WorkspaceConfig
  const projects: Record<string, ProjectConfig> = {
    hive: projectOf({
      version: 2,
      // A project's mode and extra arguments over the global ones; its own model moved onto agents by HI-1770 already.
      providers: { 'claude-code': { model: 'inherit', effort: 'inherit', permissionMode: 'plan', extraArgs: '--project', use200kContext: 'inherit' } },
      migrations: { connections1: { 'claude-code': { at: AT, moved: [] } } },
      agents: [
        { id: 'b1', name: 'HB1', provider: 'claude-code', connection: 'a-personal' },
        // Its own model, effort and mode.
        { id: 'b2', name: 'HB2', provider: 'claude-code', connection: 'a-personal', model: 'sonnet', effort: 'high', permissionMode: 'manual' },
        { id: 'b3', name: 'HB3', provider: 'claude-code', connection: 'a-personal', effort: 'high' },
        // Matching setups share one connection.
        { id: 'b4', name: 'HB4', provider: 'claude-code', connection: 'a-personal', effort: 'high' },
        // No connection of its own: the workspace's first on.
        { id: 'b5', name: 'HB5', provider: 'claude-code' },
        { id: 'w1', name: 'W1', provider: 'claude-code', connection: 'a-work' },
        { id: 's1', name: 'S1', provider: 'claude-code', connection: 'a-deepseek', effort: 'max' },
        { id: 'x1', name: 'X1', provider: 'codex', connection: 'a-codex', effort: 'xhigh' },
        // Its connection off here: it launched on the workspace's first on, and is pinned to it.
        { id: 'x2', name: 'X2', provider: 'codex', connection: 'a-old' },
        { id: 'g1', name: 'G1', provider: 'copilot', model: 'claude-sonnet-4.5' },
        { id: 'g2', name: 'G2', provider: 'copilot' }
      ]
    }),
    // A project HI-1770 hadn't moved yet: its own model and context move onto its agents as their launch would have.
    other: projectOf({
      version: 2,
      providers: { 'claude-code': { model: 'haiku', effort: 'inherit', permissionMode: 'inherit', extraArgs: '', use200kContext: 'on' } },
      agents: [
        { id: 'o1', name: 'O1', provider: 'claude-code', connection: 'a-work' },
        { id: 'o2', name: 'O2', provider: 'claude-code', connection: 'a-work', model: 'opus', use200kContext: false }
      ]
    })
  }
  const assistantRaw = projectOf({ version: 2, agents: [{ id: ASSISTANT_AGENT_ID, name: 'Assistant', effort: 'max', mode: 'coordinator' }] })

  const inp: LegacyInputs = { settings, ws: wsFile, legacy, seam: () => false }
  const was = {
    agents: Object.fromEntries(Object.entries(projects).flatMap(([p, cfg]) => cfg.agents.map((a) => [`${p}/${a.name}`, before(a, cfg, false, inp)]))),
    assistant: before(assistantProjectConfig(assistantRaw, settings).agents[0], assistantProjectConfig(assistantRaw, settings), true, inp)
  }

  n = 0x100
  const config = migrateAccounts(legacy, settings, AT, newId)
  const store: AccountStore = { accounts: config.accounts, connections: config.connections, newId }
  const assistant = migrateAssistant(assistantRaw, inp, store, AT)!
  const migrated = Object.fromEntries(Object.entries(projects).map(([p, cfg]) => [p, migrateProject(cfg, inp, store, AT)!]))
  const ws = migrateWorkspaceFile(wsFile, AT)!

  it('every agent launches exactly as before: model, effort, context, mode, extra arguments and account folder', () => {
    for (const [p, cfg] of Object.entries(migrated)) for (const a of cfg.agents) expect({ agent: `${p}/${a.name}`, ...after(a, ws, store, settings) }).toEqual({ agent: `${p}/${a.name}`, ...was.agents[`${p}/${a.name}`] })
  })

  it('so does the Assistant', () => {
    expect(after(assistant.agents[0], ws, store, settings)).toEqual(was.assistant)
    // Its mode (a file in .hive/modes) isn't a launch setting: it stays.
    expect(assistant.agents[0].mode).toBe('coordinator')
  })

  it('the cases the card names, as they launched', () => {
    // A global 200K on with an account with no context default: 1M; its project's mode and arguments over the global ones.
    expect(was.agents['hive/W1']).toMatchObject({ context: false, mode: 'plan', args: ['--verbose', '--project'], folder: 'a-work' })
    // The agent's own model, effort and mode.
    expect(was.agents['hive/HB2']).toMatchObject({ model: 'sonnet', effort: 'high', mode: 'manual' })
    // A server account: no effort or context.
    expect(was.agents['hive/S1']).toMatchObject({ model: 'deepseek-v4', effort: null, context: false, folder: 'a-deepseek' })
    // Off here: the workspace's first on.
    expect(was.agents['hive/X2'].folder).toBe('a-codex')
    // Copilot: the legacy layer, on its own home.
    expect(was.agents['hive/G2']).toMatchObject({ model: 'gpt-5', mode: 'plan', args: ['--banner'], folder: null })
    // HI-1770's move made as the launch would have: the project's model and context.
    expect(was.agents['other/O1']).toMatchObject({ model: 'haiku', context: true })
    expect(was.agents['other/O2']).toMatchObject({ model: 'opus', context: false })
    expect(was.assistant).toMatchObject({ cli: 'claude-code', model: 'opus', effort: 'max', folder: 'a-work', args: ['--verbose', '--assistant'] })
  })

  it('agents hold only their connection; matching setups share one; the project keeps no launch settings', () => {
    const hive = migrated.hive.agents
    for (const a of [...hive, ...migrated.other.agents]) expect(Object.keys(a).filter((k) => ['model', 'effort', 'permissionMode', 'use200kContext'].includes(k))).toEqual([])
    const by = (name: string): AgentDef => hive.find((a) => a.name === name)!
    expect(by('HB3').connection).toBe(by('HB4').connection)
    expect(by('HB1').connection).toBe(by('HB5').connection)
    expect(by('HB1').connection).not.toBe(by('HB3').connection)
    expect(by('X2').connection).toBe(store.connections.find((c) => c.account === 'a-codex' && c.effort === undefined)?.id)
    expect('providers' in migrated.hive || 'defaultProvider' in migrated.hive).toBe(false)
    expect(migrated.hive.migrations?.accounts1).toEqual({ at: AT })
    // HI-1770's record is kept, for its notice.
    expect(migrated.other.migrations?.connections1?.['claude-code']?.moved.map((m) => m.id)).toEqual(['claude-code:o1:model', 'claude-code:o1:use200kContext'])
  })

  it('names what it made after what differs from the base, on the account', () => {
    const named = (agent: string): string => store.connections.find((c) => c.id === migrated.hive.agents.find((a) => a.name === agent)!.connection)!.name
    expect(named('HB1')).toBe('Personal · Plan · --verbose --project')
    expect(named('HB3')).toMatch(/^Personal · High/)
  })

  it("keeps the Assistant's setup for each CLI it had one for; only the active one is its", () => {
    const rec = assistant.migrations?.accounts1?.assistant
    expect(Object.keys(rec ?? {}).sort()).toEqual(['claude-code', 'codex'])
    expect(assistant.agents[0]).toMatchObject({ provider: 'claude-code', connection: rec!['claude-code'] })
    const codex = store.connections.find((c) => c.id === rec!.codex)!
    // As its launch on Codex would have been: its dialog's own effort over Settings → Assistant's for Codex.
    expect(codex).toMatchObject({ account: 'a-codex', model: 'gpt-5.5', effort: 'max' })
    expect(codex.name).toBe('Codex · Assistant')
  })

  it('runs once: a second run changes nothing', () => {
    const count = store.connections.length
    expect(migrateProject(migrated.hive, inp, store, AT)).toBeNull()
    expect(migrateAssistant(assistant, inp, store, AT)).toBeNull()
    expect(store.connections.length).toBe(count)
  })
})

describe("0.9's providers' order, read by the migration only (HI-2139)", () => {
  // config.json as 0.9 kept it: Automatic, Codex first in the order the user set, both CLIs on (and installed: line 14).
  const raw = { version: 8, settings: { defaultProvider: 'auto', providerOrder: ['codex', 'claude-code', 'copilot'], providers: { 'claude-code': { enabled: true }, codex: { enabled: true } } } }
  const loaded = migrateConfig(mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), raw), raw)

  it('is kept as it was saved, through a load', () => {
    expect(loaded.settings.providerOrder).toEqual(['codex', 'claude-code', 'copilot'])
  })

  it('an Automatic Assistant and an agent with no provider of its own stay on the CLI they ran: Codex', () => {
    const inp: LegacyInputs = { settings: loaded.settings, ws: {}, legacy: [], seam: () => false }
    const store: AccountStore = { accounts: [], connections: [], newId }
    const assistant = migrateAssistant(projectOf({ version: 2, agents: [{ id: ASSISTANT_AGENT_ID, name: 'Assistant' }] }), inp, store, AT)!
    expect(assistant.agents[0].provider).toBe('codex')
    const project = migrateProject(projectOf({ version: 2, agents: [{ id: 'x', name: 'X' }] }), inp, store, AT)!
    expect(project.agents[0].provider).toBe('codex')
  })

  it("isn't today's: Automatic's fallback picks in Hive's order", () => {
    expect(autoProvider(loaded.settings)).toBe('claude-code')
  })
})
