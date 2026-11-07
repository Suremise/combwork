// Launching on a connection (HI-1755): which connection a launch uses (resolveConnection), the test seam's bounds, the
// launch's outcomes (refused, noted, claimed and released), the safe-point switch's steps, and what is read from a
// connection's home instead of the CLI's own (memory, files). HI-1769: what an agent's rows name (connectionOf), an
// agent's own choice checked with the write that saves it (Add Agent, Agent Settings), and templates' connections (the
// load dialog's flagged agents, inherited versus pinned, a stale choice, one agent added). HI-1770: model, effort and
// context from the connection (the resolver's layers, the Assistant's own), a project's own moved onto its agents once
// (kept explicit values, a launch waiting on the move, interrupted, a later CLI), the notice from the move's record
// (scoped to a workspace, dismissed for good) and connections' defaults (copied once, edited). HI-1771: a connection named
// in the Agent API (id, unique name, ambiguous, unknown), what each caller sees of them (never storage), and an agent's
// change of connection (kept, cleared, a change of CLI resetting what was the old one's, decided again under the lock).
// In this file's temp folders
// only: the CLI is never run (its status is faked) and nothing signs in.
import { writesAt } from '../src/main/dbWrites'
import { AsyncResource } from 'async_hooks'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { connectionRef, connectionsFor, connectionShown, resolveConnection, type ConnectionsView } from '../src/shared/accounts'
import { cliReadyOf, connectionCli, connectionOf, connectionSwitchDue, firstReadyConnection, firstUsableConnection, launchedName, offeredConnections, offHereChoice } from '../src/shared/connectionLabel'
import type { Account, LiveSessionState } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('cw-connections-')
const home = join(base, 'claude-home')
const userHome = join(base, 'user-profile')
process.env.CW_USER_DATA = join(base, 'profile')
process.env.CLAUDE_CONFIG_DIR = home
// No test seam here: the real rule (a test copy's own run context sets it; this file decides per test).
delete process.env.CW_TEST_CLI_HOME_CONNECTION
;(electron.app as unknown as { getPath: (n: string) => string }).getPath = (n: string) => (n === 'home' ? userHome : join(base, 'profile'))

const accounts = await import('../src/main/accounts')
const seam = await import('../src/main/connectionSeam')
const { config } = await import('../src/main/config')
const { advanced } = await import('../src/main/advanced')
const { provider } = await import('../src/main/providers')
const { providerService } = await import('../src/main/providerService')
const { configTestHooks, createWorkspaceService, disposeWorkspaceService, inWorkspace, setConnectionGuard } = await import('../src/main/workspace')
const { runSwitch } = await import('../src/main/connectionSwitch')
const { authScope, sessions } = await import('../src/main/sessions')
const moves = await import('../src/main/connectionMoves')
const { atTheChange, connectionValuesArg, refuseOldFields } = await import('../src/main/servers')
const control = await import('../src/main/assistantControl')
const { assistantOwn, cliDefaults, legacyLaunchSettings: agentLaunchSettings, moveProjectOverrides } = await import('../src/shared/connectionDefaults')
const { addAgent, updateAgent } = await import('../src/main/projectAgents')
const templates = await import('../src/main/templates')
const { TEMPLATE_VERSION } = await import('../src/shared/templates')
const { fileLockDepth, withFileLock } = await import('../src/main/fsutil')
const { listSkills, invalidateSkillCache, machineSkillCacheSize } = await import('../src/main/skills')
const { encodeProjectPath } = await import('../src/main/providers/claude/usage')

const status = new Map<string, () => Promise<{ ok: true; loggedIn: boolean; email?: string; orgId?: string } | { ok: false; error: string }>>()
const signedIn = (email: string) => async () => ({ ok: true as const, loggedIn: true, email, orgId: 'org-1' })
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10_000
const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)

const wsPath = join(base, 'ws')
let w: ReturnType<typeof createWorkspaceService>
const here = <T>(fn: () => T): T => inWorkspace(w, fn)

beforeAll(async () => {
  advanced.load(join(base, 'profile'))
  mkdirSync(join(home, 'projects'), { recursive: true })
  mkdirSync(join(userHome, '.claude'), { recursive: true })
  mkdirSync(join(wsPath, 'alpha', '.combwork'), { recursive: true })
  writeFileSync(join(wsPath, 'alpha', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One' }] }))
  // A project templates are loaded into (HI-1769), its agents replaced each time.
  mkdirSync(join(wsPath, 'gamma', '.combwork'), { recursive: true })
  writeFileSync(join(wsPath, 'gamma', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  // Projects whose own model, effort and context move onto their agents (HI-1770), each test its own.
  // A project whose agents change connection (HI-1771).
  mkdirSync(join(wsPath, 'api1', '.combwork'), { recursive: true })
  writeFileSync(join(wsPath, 'api1', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'k', name: 'Api K', provider: 'claude-code', model: 'opus', effort: 'high', use200kContext: true, lastSessionId: 's-1' }] }))
  for (const name of ['mv1', 'mv2', 'mv3', 'mv4', 'mv5', 'mv6', 'mv7', 'mv8', 'mv9']) {
    mkdirSync(join(wsPath, name, '.combwork'), { recursive: true })
    writeFileSync(join(wsPath, name, '.combwork', 'project.json'), JSON.stringify({ version: 2, providers: { 'claude-code': { model: 'haiku', effort: 'high', permissionMode: 'inherit', extraArgs: '', use200kContext: 'on' }, codex: { model: 'gpt-5', effort: 'low', permissionMode: 'inherit', extraArgs: '', use200kContext: 'inherit' } }, agents: [{ id: 'own', name: `${name} Own`, provider: 'claude-code', model: 'opus', use200kContext: false }, { id: 'none', name: `${name} None`, provider: 'claude-code' }, { id: 'cx', name: `${name} Codex`, provider: 'codex' }] }))
  }
  config.settings.providers['claude-code'].enabled = true
  providerService.info = ((id: string) => ({ provider: id, found: true, path: 'claude.exe' })) as never
  vi.spyOn(provider('claude-code'), 'accountStatus').mockImplementation(async (_exe, env) => {
    const s = [...status].find(([k]) => k.toLowerCase() === env.CLAUDE_CONFIG_DIR!.toLowerCase())?.[1]
    return s ? s() : { ok: true, loggedIn: false }
  })
  // Codex's accounts (HI-2106's tests add some): signed out, never its CLI run.
  vi.spyOn(provider('codex'), 'accountStatus').mockImplementation(async () => ({ ok: true, loggedIn: false }))
  w = createWorkspaceService()
  await w.open(wsPath)
})
beforeEach(() => status.clear())
afterEach(async () => {
  for (const a of [...(config.get().accounts ?? [])]) await accounts.removeAccount(a.id).catch(() => undefined)
  config.update((c) => {
    c.accounts = (c.accounts ?? []).filter((a) => a.home)
    c.connections = (c.connections ?? []).filter((x) => c.accounts!.some((a) => a.id === x.account))
    c.lastUsedConnection = {}
    delete c.connectionDefaultsTaken
    delete c.ui.connectionsIntroShown
  })
  await w.saveWorkspaceConfigWith(() => ({ connections: undefined, assistantConnection: undefined }))
})

/** Adds a connection signed in as `email`, on here; the first one on becomes the default. */
async function signedInConnection(name: string, email: string): Promise<Account> {
  const a = await accounts.addAccount('claude-code', name)
  status.set(accounts.accountFolder(a.id), signedIn(email))
  await accounts.checkAccount(a.id)
  accounts.keepNewLogin(a.id)
  await here(() => accounts.setAccountOn(a.id, true))
  return accounts.getAccount(a.id)!
}
const launch = (wanted?: string | null) => accounts.connectionForLaunch({ provider: 'claude-code', workspaceConfig: w.config, wanted, agentName: 'Builder' })
/** An account's base connection's id (HI-2106): what an agent on it with nothing of its own chooses. */
const baseOf = (account: string): string => accounts.allConnections().find((c) => c.account === account)!.id

describe("the Agent API's connection arguments (HI-2108)", () => {
  it('refuses provider, model, effort, mode and context200k on an agent, naming the connections on the account concerned', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    accounts.addConnection(a.id, { name: 'Personal · High', effort: 'high' })
    expect(() => refuseOldFields({ name: 'X', connection: 'Personal', mcpServers: [] }, a.id)).not.toThrow()
    for (const body of [{ provider: 'codex' }, { model: '' }, { effort: 'high' }, { mode: 'plan' }, { context200k: 'on' }, { model: 'opus', effort: 'high' }]) {
      let message = ''
      try {
        refuseOldFields(body, a.id)
      } catch (e) {
        message = `${(e as { status?: number }).status} ${(e as Error).message}`
      }
      expect(message, JSON.stringify(body)).toMatch(new RegExp(`^400 An agent no longer takes ${Object.keys(body).join(', ')}: it runs on a connection`))
      expect(message).toContain('On Personal: Personal, Personal · High.')
    }
    // No account here to name: says where the user adds one.
    expect(() => refuseOldFields({ model: 'opus' }, undefined)).toThrow(/No account is on in this workspace: the user adds one in Settings → Accounts & Connections/)
  })
  it("reads cw_connection's values: each '' or null back to the CLI's, a name never empty, context200k on or off", () => {
    expect(connectionValuesArg({ name: ' Fast ', model: 'haiku', effort: 'low', mode: 'plan', context200k: 'on', extraArgs: ' --verbose ' })).toEqual({ name: 'Fast', model: 'haiku', effort: 'low', permissionMode: 'plan', use200kContext: true, extraArgs: '--verbose' })
    expect(connectionValuesArg({ model: '', effort: null, context200k: 'off', extraArgs: '' })).toEqual({ model: null, effort: null, use200kContext: null, extraArgs: null })
    expect(connectionValuesArg({})).toEqual({})
    expect(() => connectionValuesArg({ name: '  ' })).toThrow(/A connection needs a name/)
    expect(() => connectionValuesArg({ context200k: 'maybe' })).toThrow(/context200k is "on"/)
  })
})

describe("cw_connection's change, checked at the moment of it (HI-2108 round 1)", () => {
  /** The Assistant's current launch token for the workspace, from its file (a new one each launch). */
  const tokenNow = (): string => readFileSync(control.assistantTokenFile(wsPath), 'utf8').match(/"token":\s*"([0-9a-f]+)"/)![1]
  const act = { kind: 'add-connection' as const }
  it("refuses once the Assistant's session that asked ended or restarted, or Change settings went off, nothing changed; else changes", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const was = config.settings.assistant.changeSettings
    config.settings.assistant.changeSettings = true
    try {
      await control.newAssistantToken(wsPath)
      // Admitted for its session, which then restarts (a new token) before the change.
      const stale = control.admit(wsPath, tokenNow(), 'look', [{ id: 'test.what', text: 'make a connection' }], act)
      await control.newAssistantToken(wsPath)
      const before = structuredClone(accounts.allConnections())
      let made = false
      expect(() => atTheChange(stale, () => ((made = true), accounts.addConnection(a.id, { name: 'Stale' })))).toThrow(/session that asked for this ended/)
      expect([made, accounts.allConnections()]).toEqual([false, before])
      // Change settings turned off meanwhile: refused the same, before the session is even looked at.
      const current = control.admit(wsPath, tokenNow(), 'look', [{ id: 'test.what', text: 'make a connection' }], act)
      config.settings.assistant.changeSettings = false
      expect(() => atTheChange(current, () => accounts.addConnection(a.id, { name: 'Off' }))).toThrow(/Change settings is off/)
      expect(accounts.allConnections()).toEqual(before)
      // Its session current and the switch on: changed.
      config.settings.assistant.changeSettings = true
      const c = atTheChange(current, () => accounts.addConnection(a.id, { name: 'Made' }))
      expect(accounts.getConnection(c.id)).toMatchObject({ account: a.id, name: 'Made' })
    } finally {
      config.settings.assistant.changeSettings = was
    }
  })
})

describe('which connection a launch uses (resolveConnection)', () => {
  const c = (id: string, p: Account['provider'] = 'claude-code'): Account => ({ id, provider: p, name: id, createdAt: '' })
  const all = [c('a'), c('b'), c('x', 'codex')]
  const cfg = { connections: { 'claude-code': { on: ['a'], default: 'a' } } }
  it('its own when on here; the default when it asks for none', () => {
    expect(resolveConnection(cfg, 'claude-code', 'a', all)).toEqual({ ok: true, id: 'a' })
    expect(resolveConnection(cfg, 'claude-code', undefined, all)).toEqual({ ok: true, id: 'a' })
  })
  it('its own off here: the same provider’s default, noted; no default: refused', () => {
    expect(resolveConnection(cfg, 'claude-code', 'b', all)).toEqual({ ok: true, id: 'a', note: 'offFallback' })
    expect(resolveConnection({ connections: { 'claude-code': { on: [], default: null } } }, 'claude-code', 'b', all)).toEqual({ ok: false, why: 'offNoDefault', wanted: 'b' })
  })
  it('gone, or another provider’s: refused, never another in its place; none at all: refused', () => {
    expect(resolveConnection(cfg, 'claude-code', 'gone', all)).toEqual({ ok: false, why: 'deleted', wanted: 'gone' })
    expect(resolveConnection(cfg, 'claude-code', 'x', all)).toEqual({ ok: false, why: 'otherProvider', wanted: 'x' })
    expect(resolveConnection({}, 'claude-code', undefined, all)).toEqual({ ok: false, why: 'none' })
  })
})

describe('the test seam (testHomeSeam)', () => {
  const env = (o: Record<string, string | undefined>) => ({ CW_USER_DATA: 'x', CW_TEST_CLI_HOME_CONNECTION: '1', CLAUDE_CONFIG_DIR: home, ...o })
  const user = join(userHome, '.claude')
  it('only for an unpackaged test copy given it and an explicit CLI test home', () => {
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({}), false, user)).toBe(true)
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({}), true, user)).toBe(false)
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({ CW_USER_DATA: undefined }), false, user)).toBe(false)
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({ CW_TEST_CLI_HOME_CONNECTION: '0' }), false, user)).toBe(false)
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({ CLAUDE_CONFIG_DIR: undefined }), false, user)).toBe(false)
  })
  it('never on the user’s own home, however it is spelt (a junction to it too)', () => {
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({ CLAUDE_CONFIG_DIR: user }), false, user)).toBe(false)
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({ CLAUDE_CONFIG_DIR: user.toUpperCase() + '\\' }), false, user)).toBe(false)
    const alias = join(base, 'alias-of-user-home')
    rmSync(alias, { force: true, recursive: true })
    symlinkSync(user, alias, 'junction')
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({ CLAUDE_CONFIG_DIR: alias }), false, user)).toBe(false)
  })
})

describe('a launch on a connection (connectionForLaunch)', () => {
  it('none on here: refused, never the CLI’s own home', async () => {
    expect(await outcome(launch())).toMatch(/No Claude Code account is on in this workspace/)
  })

  it('accounts there but all off here: refused saying they are off here, never to add one (HI-2650)', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    await here(() => accounts.setAccountOn(a.id, false))
    expect(await outcome(launch())).toBe("Claude Code's account, Personal, is off in this workspace. Turn one on with On here in Settings → Accounts & Connections, then start Builder again.")
    const b = await signedInConnection('Work', 'work@example.com')
    await here(() => accounts.setAccountOn(b.id, false))
    expect(await outcome(launch())).toMatch(/^Claude Code's accounts, Personal and Work, are off in this workspace\./)
  })

  it('with the seam on and none on here, the old launch (null: the CLI test home), and only then', async () => {
    process.env.CW_TEST_CLI_HOME_CONNECTION = '1'
    try {
      expect(await launch()).toBeNull()
      const a = await signedInConnection('Personal', 'me@example.com')
      const c = await launch()
      expect(c?.id).toBe(a.id)
      c?.release()
    } finally {
      delete process.env.CW_TEST_CLI_HOME_CONNECTION
    }
  })

  it('gives its folder as the home, claimed until released (removal refused meanwhile)', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const c = (await launch())!
    expect(c).toMatchObject({ id: a.id, name: 'Personal', folder: accounts.accountFolder(a.id), homeEnv: 'CLAUDE_CONFIG_DIR' })
    expect(c.note).toBeUndefined()
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/has agents running on it/)
    c.release()
    c.release()
    await accounts.removeAccount(a.id)
  })

  it('its own off here, removed or another CLI’s: its CLI’s first usable here, noted (HI-2106, decision H)', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    await here(() => accounts.setAccountOn(b.id, false))
    // Off here: offFallback; removed (HI-2108): missing.
    for (const [wanted, note] of [[baseOf(b.id), 'offFallback'], ['gone', 'missing']]) {
      const c = (await launch(wanted))!
      expect(c).toMatchObject({ id: a.id, note })
      c.release()
    }
    config.update((x) => {
      x.accounts!.push({ id: 'x-codex', provider: 'codex', name: 'ChatGPT', createdAt: '' })
      x.connections!.push({ id: 'c-codex', account: 'x-codex', name: 'ChatGPT' })
    })
    const c = (await launch('c-codex'))!
    expect(c).toMatchObject({ id: a.id, note: 'missing' })
    c.release()
    // None of its CLI on here: refused.
    await here(() => accounts.setAccountOn(a.id, false))
    expect(await outcome(launch(baseOf(b.id)))).toMatch(/off in this workspace|isn't on/)
  })

  it('signed out, or its login still changing: refused, and its claim released', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    status.set(accounts.accountFolder(a.id), async () => ({ ok: true, loggedIn: false }))
    expect(await outcome(launch())).toMatch(/Personal is signed out/)
    status.set(accounts.accountFolder(a.id), async () => {
      accounts.accountChanged(a.id)
      return { ok: true, loggedIn: true, email: 'me@example.com', orgId: 'org-1' }
    })
    expect(await outcome(launch())).toMatch(/kept changing/)
    // Nothing still holds it: removal goes ahead.
    await accounts.removeAccount(a.id)
  })

  it('its folder replaced by a link: refused before its check, never another home', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const folder = accounts.accountFolder(a.id)
    rmSync(join(folder, 'projects'))
    renameSync(folder, `${folder}-real`)
    symlinkSync(home, folder, 'junction')
    expect(await outcome(launch())).toMatch(/isn't the one Combwork made/)
    rmSync(folder)
  })

  it('a check that couldn’t tell goes ahead, noted; a changed login goes ahead, noted', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    status.set(accounts.accountFolder(a.id), async () => ({ ok: false, error: 'timed out' }))
    const c1 = (await launch())!
    expect(c1.note).toBe('unknownLogin')
    c1.release()
    status.set(accounts.accountFolder(a.id), signedIn('other@example.com'))
    const c2 = (await launch())!
    expect(c2.note).toBe('loginChanged')
    c2.release()
  })

  it("waits for the order's one-time move at start (HI-1875 round 1): no launch on the order from before it; a new workspace starts with none on (HI-2650)", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    // The most recently opened workspace's recorded default was Work, though Personal is first in the list.
    const recent = join(base, 'order-recent')
    mkdirSync(join(recent, '.combwork'), { recursive: true })
    writeFileSync(join(recent, '.combwork', 'workspace.json'), JSON.stringify({ version: 1, connections: { 'claude-code': { on: [a.id, b.id], default: b.id } } }))
    const was = config.get().recentWorkspaces
    config.update((c) => {
      c.recentWorkspaces = [recent]
      delete c.connectionOrderMigrated
    })
    // The move held while it reads the recent workspaces, as a slow disk would.
    let release: () => void = () => undefined
    let reached = false
    accounts.accountTestHooks.beforeOrderRead = () => new Promise<void>((r) => ((reached = true), (release = r)))
    const fresh = join(base, 'order-new-ws')
    let w2: ReturnType<typeof createWorkspaceService> | null = null
    try {
      const ready = accounts.initConnections()
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: HUNG_MS })
      // Asked for while held: a launch with no connection of its own, and a new workspace made.
      const launched = launch()
      mkdirSync(fresh, { recursive: true })
      w2 = createWorkspaceService()
      const opened = w2.open(fresh)
      release()
      await ready
      // Not the old first in the list (Personal): the moved top, Work.
      const c = (await launched)!
      expect(c.id).toBe(b.id)
      c.release()
      await opened
      // Nothing is turned on by itself (Darren, 6 Nov): the new workspace has no connections on.
      expect(JSON.parse(readFileSync(join(fresh, '.combwork', 'workspace.json'), 'utf8')).connections).toBeUndefined()
      expect(accounts.combworkAccounts().map((x) => x.id)).toEqual([b.id, a.id])
    } finally {
      accounts.accountTestHooks.beforeOrderRead = undefined
      release()
      if (w2) await disposeWorkspaceService(w2)
      config.update((c) => void (c.recentWorkspaces = was))
    }
  })

  it('stillValid: false once another connection is chosen meanwhile, or it is removed', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    const c = (await launch())!
    expect(c.id).toBe(a.id)
    expect(c.stillValid(undefined)).toBe(true)
    accounts.moveConnection(b.id, 0)
    expect(c.stillValid(undefined)).toBe(false)
    expect(c.stillValid(baseOf(a.id))).toBe(true)
    // The launch was given the workspace's config as it was: a fresh resolve now picks Work.
    const fresh = await accounts.connectionForLaunch({ provider: 'claude-code', workspaceConfig: w.config, wanted: undefined, agentName: 'Builder' })
    expect(fresh?.id).toBe(b.id)
    fresh?.release()
    c.release()
  })
})

describe('what is read from a connection’s home', () => {
  it('user memory: each connection’s on here, never the CLI’s own home', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const homes = here(() => accounts.connectionHomes('claude-code', w.config))!
    expect(homes.map((h) => h.home)).toEqual([accounts.accountFolder(a.id)])
    const sources = await provider('claude-code').memorySources(wsPath, homes)
    const users = sources.filter((s) => s.id.startsWith('user'))
    expect(users.map((s) => s.path)).toEqual([join(accounts.accountFolder(a.id), 'CLAUDE.md')])
    expect(users[0].label).toContain('Personal')
  })

  it('files: a connection’s memory and skills allowed, never its login or settings, never another home', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const f = accounts.accountFolder(a.id)
    const allowed = (p: string, write = false) => provider('claude-code').fileAllowed(p, write, [f])
    expect(allowed(join(f, 'CLAUDE.md'))).toBe(true)
    expect(allowed(join(f, '.credentials.json'))).toBe(false)
    expect(allowed(join(f, 'settings.json'), true)).toBe(false)
    expect(allowed(join(home, 'CLAUDE.md'))).toBe(false)
  })

  it('auto memory: every file the Memory tab lists opens and saves, by either path, and nothing else of the CLI’s home (HI-1999)', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const f = accounts.accountFolder(a.id)
    // The connection's projects is Combwork's junction to the CLI home's, where the list reads auto memory from.
    expect(lstatSync(join(f, 'projects')).isSymbolicLink()).toBe(true)
    const project = join(wsPath, 'alpha')
    const key = encodeProjectPath(realpathSync(project))
    mkdirSync(join(home, 'projects', key, 'memory', 'sub'), { recursive: true })
    for (const name of ['MEMORY.md', 'note.md']) writeFileSync(join(home, 'projects', key, 'memory', name), '# memory\n')
    const homes = here(() => accounts.connectionHomes('claude-code', w.config))!
    const autos = (await provider('claude-code').memorySources(project, homes)).filter((s) => s.kind === 'auto-memory')
    expect(autos.map((s) => s.label)).toEqual(['MEMORY.md', 'note.md'])
    const allowed = (p: string, write = false) => provider('claude-code').fileAllowed(p, write, homes.map((h) => h.home))
    for (const s of autos) {
      expect(allowed(s.path)).toBe(true)
      expect(allowed(s.path, true)).toBe(true)
    }
    // The same file through the connection's junction.
    expect(allowed(join(f, 'projects', key, 'memory', 'note.md'), true)).toBe(true)
    // The rest of the CLI's own home stays refused: its settings, user memory, transcripts and deeper files.
    expect(allowed(join(home, 'settings.json'))).toBe(false)
    expect(allowed(join(home, 'CLAUDE.md'), true)).toBe(false)
    expect(allowed(join(home, 'projects', key, 'abc.jsonl'))).toBe(false)
    expect(allowed(join(home, 'projects', key, 'notes.md'))).toBe(false)
    expect(allowed(join(home, 'projects', key, 'memory', 'sub', 'x.md'))).toBe(false)
    expect(allowed(join(home, 'projects', key, 'memory', 'MEMORY.txt'))).toBe(false)
  })

  it('its settings’ default model: the connection’s own', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    writeFileSync(join(accounts.accountFolder(a.id), 'settings.json'), JSON.stringify({ model: 'claude-own-model' }))
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'claude-home-model' }))
    expect(provider('claude-code').configuredDefaultModel(accounts.accountFolder(a.id))).toBe('claude-own-model')
  })
})

describe('sign-in, per connection (authScope)', () => {
  it('two connections’ agents are apart; a provider without one is its provider', () => {
    const st = (conn?: string): Pick<LiveSessionState, 'provider' | 'launchedConnection'> => ({ provider: 'claude-code', ...(conn ? { launchedConnection: { id: conn, name: conn } } : {}) })
    expect(authScope(st('a'))).toBe('claude-code:a')
    expect(authScope(st('b'))).not.toBe(authScope(st('a')))
    expect(authScope(st())).toBe('claude-code')
  })
})

describe('a switch at the next safe point (runSwitch)', () => {
  /** A fake agent: its turn, its quit's answers, its run, and the changes it sends. */
  function agent() {
    const looks = new Set<() => void>()
    const a = {
      held: 'it is in a turn' as string | null,
      running: true,
      quits: [] as string[],
      quitAnswer: 'sent' as 'sent' | 'held' | 'gone',
      resumes: 0,
      change: () => {
        for (const l of looks) l()
      }
    }
    const op = runSwitch({
      running: () => a.running,
      heldNow: () => a.held,
      quit: async () => {
        a.quits.push(a.quitAnswer)
        return a.quitAnswer
      },
      resume: async () => {
        a.resumes++
      },
      watch: (look) => {
        looks.add(look)
        return () => looks.delete(look)
      },
      log: () => undefined
    })
    return { a, op }
  }

  it('waits for its turn to be over; types its exit once; resumes once, only after that run exits', async () => {
    const { a, op } = agent()
    a.change()
    expect(a.quits).toEqual([])
    a.held = null
    a.change()
    await vi.waitFor(() => expect(a.quits).toEqual(['sent']), { timeout: HUNG_MS })
    a.change()
    a.change()
    expect(a.quits).toEqual(['sent'])
    expect(a.resumes).toBe(0)
    a.running = false
    a.change()
    expect(await op.done).toBe('resumed')
    a.change()
    expect(a.resumes).toBe(1)
  })

  it('a quit held (a draft, a prompt) typed nothing: asked again at the next change, still never twice once sent', async () => {
    const { a, op } = agent()
    a.held = null
    a.quitAnswer = 'held'
    a.change()
    await vi.waitFor(() => expect(a.quits).toEqual(['held']), { timeout: HUNG_MS })
    expect(op.typed).toBe(false)
    a.quitAnswer = 'sent'
    a.change()
    await vi.waitFor(() => expect(a.quits).toEqual(['held', 'sent']), { timeout: HUNG_MS })
    expect(op.typed).toBe(true)
    a.running = false
    a.change()
    expect(await op.done).toBe('resumed')
  })

  it('cancelled (stopped by hand, its workspace closing) before or after its exit: no resume', async () => {
    const first = agent()
    first.op.cancel('stopped')
    first.a.held = null
    first.a.change()
    expect(await first.op.done).toBe('cancelled')
    expect(first.a.quits).toEqual([])
    const second = agent()
    second.a.held = null
    second.a.change()
    await vi.waitFor(() => expect(second.op.typed).toBe(true), { timeout: HUNG_MS })
    second.op.cancel('its workspace closed')
    second.a.running = false
    second.a.change()
    expect(await second.op.done).toBe('cancelled')
    expect(second.a.resumes).toBe(0)
  })

  it('its run ended some other way before it was switched: nothing typed, nothing resumed', async () => {
    const { a, op } = agent()
    a.running = false
    a.change()
    expect(await op.done).toBe('gone')
    expect(a.quits).toEqual([])
    expect(a.resumes).toBe(0)
  })
})

describe('a choice saved while starting: the last look at its own choice, skills per workspace, the switch off', () => {
  const alpha = join(wsPath, 'alpha')
  const deferred = () => {
    let done!: () => void
    const p = new Promise<void>((r) => (done = r))
    return { p, done }
  }
  /** Agent One's connection as saved now, read as a launch reads it (under the lock its saves take). */
  const oneChose = () => w.savedAgent(alpha, 'a-one').then((a) => a?.connection)
  // The Assistant's (HI-2106): its agent's connection, as a launch reads it.
  const assistantChose = () => w.savedAgent(w.assistantHome, 'assistant').then((a) => a?.connection)

  /**
   * A launch on `chosen` whose first `holds` runs wait, before their last look, until let go: `entered(i)` once run i
   * waits there, `go(i)` lets it on. What each run was prepared on, and what spawned (after the last look).
   */
  function heldRun(chosen: () => Promise<string | null | undefined>, holds = 1) {
    const at = Array.from({ length: holds }, deferred)
    const gates = Array.from({ length: holds }, deferred)
    const prepared: (string | null)[] = []
    const spawned: (string | null)[] = []
    const done = accounts.launchOnChosen({ provider: 'claude-code', workspaceConfig: w.config, agentName: 'One', chosen }, async (conn, lastLook) => {
      const i = prepared.push(conn?.id ?? null) - 1
      if (i < holds) {
        at[i].done()
        await gates[i].p
      }
      await lastLook()
      spawned.push(conn?.id ?? null)
    })
    // Settled here too, so a refusal a test expects isn't unhandled while it waits.
    done.catch(() => undefined)
    return { done, prepared, spawned, entered: (i: number) => at[i].p, go: (i: number) => gates[i].done() }
  }

  it("launch first, save second: the last look sees the new choice, the first claim is let go, and it starts on the new one", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    await here(() => updateAgent(alpha, 'a-one', { connection: a.id }))
    const run = heldRun(oneChose)
    await run.entered(0)
    await here(() => updateAgent(alpha, 'a-one', { connection: b.id }))
    run.go(0)
    await run.done
    expect(run.prepared).toEqual([a.id, b.id])
    expect(run.spawned).toEqual([b.id])
    // Nothing still holds either (removal is refused while a launch's claim is held).
    expect(await outcome(accounts.removeAccount(a.id))).toBe('ok')
    expect(await outcome(accounts.removeAccount(b.id))).toBe('ok')
  })

  it('save first, launch second: a launch begun while the save waits on its lock reads the saved choice, never the old one', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    await here(() => updateAgent(alpha, 'a-one', { connection: a.id }))
    // The project's lock held, so the save of Work waits on it (queued), not yet written.
    const file = join(alpha, '.combwork', 'project.json')
    const lock = deferred()
    const holding = withFileLock(file, () => lock.p)
    const saving = here(() => updateAgent(alpha, 'a-one', { connection: b.id }))
    await vi.waitFor(() => expect(fileLockDepth(file)).toBe(2), { timeout: HUNG_MS })
    const run = heldRun(oneChose, 0)
    await vi.waitFor(() => expect(fileLockDepth(file)).toBe(3), { timeout: HUNG_MS })
    lock.done()
    await holding
    await saving
    await run.done
    expect(run.prepared).toEqual([b.id])
    expect(run.spawned).toEqual([b.id])
  })

  it("the Assistant's choice saved while it starts: it starts on the new one", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    const run = heldRun(assistantChose)
    await run.entered(0)
    await here(() => updateAgent(w.assistantHome, 'assistant', { connection: baseOf(b.id) }))
    run.go(0)
    await run.done
    expect(run.prepared).toEqual([a.id, b.id])
    expect(run.spawned).toEqual([b.id])
  })

  it("others' saves never end it: the Assistant's here, and another workspace's agent, chosen meanwhile", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    await here(() => updateAgent(alpha, 'a-one', { connection: a.id }))
    const ws2Path = join(base, 'ws-others')
    mkdirSync(join(ws2Path, 'beta', '.combwork'), { recursive: true })
    writeFileSync(join(ws2Path, 'beta', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b-one', name: 'Beta One' }] }))
    const w2 = createWorkspaceService()
    await w2.open(ws2Path)
    try {
      await inWorkspace(w2, () => accounts.setAccountOn(b.id, true))
      const run = heldRun(oneChose)
      await run.entered(0)
      await here(() => updateAgent(w.assistantHome, 'assistant', { connection: baseOf(b.id) }))
      await inWorkspace(w2, () => updateAgent(join(ws2Path, 'beta'), 'b-one', { connection: b.id }))
      run.go(0)
      await run.done
      expect(run.prepared).toEqual([a.id])
      expect(run.spawned).toEqual([a.id])
    } finally {
      await disposeWorkspaceService(w2)
    }
  })

  it('changed again while it starts once more: refused, saying so, both claims let go', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    await here(() => updateAgent(alpha, 'a-one', { connection: a.id }))
    const run = heldRun(oneChose, 2)
    await run.entered(0)
    await here(() => updateAgent(alpha, 'a-one', { connection: b.id }))
    run.go(0)
    await run.entered(1)
    await here(() => updateAgent(alpha, 'a-one', { connection: a.id }))
    run.go(1)
    expect(await outcome(run.done)).toMatch(/changed again while it was starting/)
    expect(run.prepared).toEqual([a.id, b.id])
    expect(run.spawned).toEqual([])
    expect(await outcome(accounts.removeAccount(a.id))).toBe('ok')
    expect(await outcome(accounts.removeAccount(b.id))).toBe('ok')
  })

  it("machine skills: each workspace's own connections' only; a connection turned on shows its skills at once, the cache warm", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await accounts.addAccount('claude-code', 'Work')
    for (const [conn, name] of [[a, 'shared-skill'], [b, 'private-b'], [b, 'shared-skill']] as const) {
      const dir = join(accounts.accountFolder(conn.id), 'skills', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} of ${conn.name}\n---\n`)
    }
    // A second workspace with Work alone on.
    const ws2Path = join(base, 'ws2')
    mkdirSync(ws2Path, { recursive: true })
    const w2 = createWorkspaceService()
    await w2.open(ws2Path)
    try {
      await inWorkspace(w2, () => accounts.setAccountOn(b.id, true))
      invalidateSkillCache()
      const names = async (ws: typeof w) => (await inWorkspace(ws, () => listSkills())).filter((s) => s.level === 'machine').map((s) => s.path)
      const inA = await names(w)
      expect(inA.some((p) => p.includes('private-b'))).toBe(false)
      expect(inA.some((p) => p.startsWith(accounts.accountFolder(a.id)))).toBe(true)
      const inB = await names(w2)
      expect(inB.some((p) => p.includes('private-b'))).toBe(true)
      expect(inB.some((p) => p.startsWith(accounts.accountFolder(a.id)))).toBe(false)
      // Work turned on in the first workspace too: its skills there at once (no stale cache).
      await here(() => accounts.setAccountOn(b.id, true))
      expect((await names(w)).some((p) => p.includes('private-b'))).toBe(true)
    } finally {
      await disposeWorkspaceService(w2)
    }
  })

  it('machine skills: many sets of homes in turn keep only a few cached, expired ones let go, the current set right (HI-1782)', async () => {
    invalidateSkillCache()
    const names = async () => (await here(() => listSkills())).filter((s) => s.level === 'machine').map((s) => s.name)
    // Each connection turned on makes a set of homes not asked for before.
    for (let i = 0; i < 12; i++) {
      const c = await accounts.addAccount('claude-code', `Cycle ${i}`)
      const dir = join(accounts.accountFolder(c.id), 'skills', `cycle-${i}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: cycle-${i}\ndescription: cycle ${i}\n---\n`)
      await here(() => accounts.setAccountOn(c.id, true))
      const got = await names()
      for (let j = 0; j <= i; j++) expect(got).toContain(`cycle-${j}`)
      expect(machineSkillCacheSize()).toBeLessThanOrEqual(8)
    }
    expect(machineSkillCacheSize()).toBe(8)
    // Past the freshness window, a lookup lets every expired set go and keeps only the current one.
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31_000)
    try {
      const got = await names()
      expect(got).toEqual(expect.arrayContaining(Array.from({ length: 12 }, (_, j) => `cycle-${j}`)))
      expect(machineSkillCacheSize()).toBe(1)
    } finally {
      clock.mockRestore()
    }
  })

  it('on for everyone (S8, HI-1774): nothing to turn on; a CLI without connections (Copilot) launches on its own login, never asked', async () => {
    // No switch: an add works with no advanced setting set, and the view lists the CLI.
    const a = await accounts.addAccount('claude-code', 'Fresh')
    expect(here(() => accounts.accountsView()).providers).toContain('claude-code')
    expect(seam.connectionsManaged('claude-code')).toBe(true)
    // Copilot: no connections, its own login (HI-1758): no choice read, nothing refused.
    expect(seam.connectionsManaged('copilot')).toBe(false)
    expect(await accounts.connectionForLaunch({ provider: 'copilot', workspaceConfig: w.config, wanted: undefined, agentName: 'Builder' })).toBeNull()
    let ran = false
    await accounts.launchOnChosen({ provider: 'copilot', workspaceConfig: w.config, agentName: 'Builder', chosen: async () => a.id }, async (conn) => void (ran = conn === null))
    expect(ran).toBe(true)
    await accounts.removeAccount(a.id)
  })
})

describe('what a banner offers where none is on here (offHereChoice, HI-2650)', () => {
  const acc = (id: string, cli: Account['provider'] = 'claude-code'): ConnectionsView['connections'][number] => ({ id, provider: cli, name: `Account ${id}`, createdAt: '', signingIn: false, folder: '' })
  const view = (over: Partial<ConnectionsView> = {}): ConnectionsView => ({ providers: ['claude-code', 'codex'], connections: [], workspace: {}, testHome: [], order: [], homes: [], connectionRows: [], ...over })
  const all: ReturnType<typeof cliReadyOf> = () => 'yes'
  it('none at all: add one', () => {
    expect(offHereChoice(view(), all)).toEqual({ kind: 'none' })
    expect(offHereChoice(view(), all, 'claude-code')).toEqual({ kind: 'none', cli: 'claude-code' })
  })
  it('one off here: Turn On Here on it; on here, it is offered no more', () => {
    expect(offHereChoice(view({ connections: [acc('a')], order: ['a'] }), all)).toEqual({ kind: 'one', id: 'a', name: 'Account a', cli: 'claude-code' })
    expect(offHereChoice(view({ connections: [acc('a')], order: ['a'], workspace: { 'claude-code': { on: ['a'], default: 'a' } } }), all)).toEqual({ kind: 'none' })
  })
  it('several off here: Choose in Settings, named in the order; one CLI named only when all are its', () => {
    expect(offHereChoice(view({ connections: [acc('a'), acc('b')], order: ['b', 'a'] }), all)).toEqual({ kind: 'several', names: ['Account b', 'Account a'], cli: 'claude-code' })
    expect(offHereChoice(view({ connections: [acc('a'), acc('x', 'codex')], order: ['a', 'x'] }), all)).toEqual({ kind: 'several', names: ['Account a', 'Account x'] })
  })
  it("one per CLI, one CLI not installed: the installed one's, unless a CLI is asked for", () => {
    const v = view({ connections: [acc('x', 'codex'), acc('a')], order: ['x', 'a'] })
    const claudeOnly: ReturnType<typeof cliReadyOf> = (c) => (c === 'claude-code' ? 'yes' : 'no')
    expect(offHereChoice(v, claudeOnly)).toMatchObject({ kind: 'one', id: 'a' })
    expect(offHereChoice(v, claudeOnly, 'codex')).toMatchObject({ kind: 'one', id: 'x' })
    // None installed: all of them.
    expect(offHereChoice(v, () => 'no')).toMatchObject({ kind: 'several' })
  })
  it("never a CLI's own home, a CLI turned off in Settings, or a test copy's CLI on its test home", () => {
    const cliHome = { ...acc('copilot', 'copilot'), home: 'cli' as const }
    expect(offHereChoice(view({ connections: [acc('x', 'codex')], providers: ['claude-code'], order: ['x'] }), all)).toEqual({ kind: 'none' })
    expect(offHereChoice(view({ connections: [acc('a')], testHome: ['claude-code'], order: ['a'] }), all)).toEqual({ kind: 'none' })
    expect(offHereChoice(view({ homes: [cliHome], providers: ['claude-code', 'copilot'], order: ['copilot'] }), all)).toEqual({ kind: 'none' })
  })
})

describe('what an agent row names (connectionOf, HI-1769; HI-2108: connections)', () => {
  const acc = (id: string, cli: Account['provider'] = 'claude-code'): ConnectionsView['connections'][number] => ({ id, provider: cli, name: `Account ${id}`, createdAt: '', signingIn: false, folder: '' })
  const row = (id: string, account: string): ConnectionsView['connectionRows'][number] => ({ id, account, name: `Name ${id}`, users: [] })
  // Accounts a (on here), b (off), x (Codex); connections a1, a2 on a, b1 on b, x1 on x.
  const view = (over: Partial<ConnectionsView> = {}): ConnectionsView => ({ providers: ['claude-code'], connections: [acc('a'), acc('b'), acc('x', 'codex')], workspace: { 'claude-code': { on: ['a'], default: 'a' } }, testHome: [], order: ['a', 'b', 'x'], homes: [], connectionRows: [row('a1', 'a'), row('a2', 'a'), row('b1', 'b'), row('x1', 'x')], ...over })
  const ran = (id: string) => ({ id, name: `Account ${id}` })
  it('its own, its account on here', () => {
    expect(connectionOf('a2', 'claude-code', undefined, view())).toMatchObject({ shown: { id: 'a2', name: 'Name a2' }, other: false, desired: { ok: true, id: 'a2', account: 'a' } })
  })
  it("its account off here, or removed, or another CLI's: its CLI's first usable connection, noted; none usable: none shown, never made up", () => {
    expect(connectionOf('b1', 'claude-code', undefined, view())).toMatchObject({ shown: { id: 'a1' }, desired: { ok: true, id: 'a1', note: 'offFallback' } })
    expect(connectionOf('gone', 'claude-code', undefined, view())).toMatchObject({ shown: { id: 'a1' }, desired: { ok: true, id: 'a1', note: 'missing' } })
    expect(connectionOf('x1', 'claude-code', undefined, view())).toMatchObject({ shown: { id: 'a1' }, desired: { ok: true, id: 'a1', note: 'missing' } })
    const none = view({ workspace: { 'claude-code': { on: [], default: null } } })
    expect(connectionOf('b1', 'claude-code', undefined, none)).toMatchObject({ shown: null, desired: { ok: false, why: 'offNoDefault', wantedName: 'Name b1' } })
    expect(connectionOf(undefined, 'claude-code', undefined, none)).toMatchObject({ shown: null, desired: { ok: false, why: 'none' } })
  })
  it('running: its connection while it runs on its account; the account it runs on, ⟳, when that is another', () => {
    expect(connectionOf('a2', 'claude-code', ran('a'), view())).toMatchObject({ shown: { id: 'a2' }, other: false })
    expect(connectionOf('a2', 'claude-code', ran('b'), view())).toMatchObject({ shown: { id: 'b', name: 'Account b' }, other: true, desired: { ok: true, id: 'a2' } })
    const none = view({ workspace: { 'claude-code': { on: [], default: null } } })
    expect(connectionOf('b1', 'claude-code', ran('a'), none)).toMatchObject({ shown: { id: 'a' }, other: true, desired: { ok: false } })
  })
  it("HI-2397: running, it names the connection it launched with, not its account: ⟳ when another on the same account is chosen now", () => {
    const on = (account: string, id: string) => ({ ...ran(account), connection: { id, name: `Name ${id}` } })
    // Two connections on one account: each agent names its own, the account never.
    expect(connectionOf('a1', 'claude-code', on('a', 'a1'), view())).toMatchObject({ shown: { id: 'a1', name: 'Name a1' }, other: false })
    expect(connectionOf('a2', 'claude-code', on('a', 'a2'), view())).toMatchObject({ shown: { id: 'a2', name: 'Name a2' }, other: false })
    // Switched to a2 while it runs on a1 (the same account): a1, ⟳, until it restarts.
    expect(connectionOf('a2', 'claude-code', on('a', 'a1'), view())).toMatchObject({ shown: { id: 'a1', name: 'Name a1' }, other: true, desired: { ok: true, id: 'a2' } })
    // Fallback (its own off here): it runs on its CLI's first usable connection, which it names, noted.
    expect(connectionOf('b1', 'claude-code', on('a', 'a1'), view())).toMatchObject({ shown: { id: 'a1', name: 'Name a1' }, other: false, desired: { note: 'offFallback' } })
    // On another account: the connection it launched with there.
    expect(connectionOf('a2', 'claude-code', on('b', 'b1'), view())).toMatchObject({ shown: { id: 'b1', name: 'Name b1' }, other: true })
    // A launch from before HI-2397 (no connection kept): its account, as before.
    expect(launchedName(ran('a'))).toEqual({ id: 'a', name: 'Account a' })
    expect(launchedName(on('a', 'a2'))).toEqual({ id: 'a2', name: 'Name a2' })
  })
  it('HI-2413: Switch Them switches by connection, as ⟳ marks it: another on the same account too; its own chosen again, no change', () => {
    const on = (account: string, id: string) => ({ ...ran(account), connection: { id, name: `Name ${id}` } })
    // Runs on a1; a2 (the same account) chosen now: due, as the window's ⟳ says.
    expect(connectionSwitchDue(on('a', 'a1'), { connection: 'a', connectionId: 'a2' })).toBe(true)
    expect(connectionOf('a2', 'claude-code', on('a', 'a1'), view())?.other).toBe(true)
    // a1 chosen again (or another account's connection chosen, then a1 back): nothing to switch.
    expect(connectionSwitchDue(on('a', 'a1'), { connection: 'a', connectionId: 'a1' })).toBe(false)
    // Another account: due, as before.
    expect(connectionSwitchDue(on('a', 'a1'), { connection: 'b', connectionId: 'b1' })).toBe(true)
    // None usable now (`!<why>`): due, as before.
    expect(connectionSwitchDue(on('a', 'a1'), { connection: '!none' })).toBe(true)
    // A launch from before HI-2397 kept only its account: compared by account.
    expect(connectionSwitchDue(ran('a'), { connection: 'a', connectionId: 'a2' })).toBe(false)
    expect(connectionSwitchDue(ran('a'), { connection: 'b', connectionId: 'b1' })).toBe(true)
  })
  it('nothing where connections aren’t shown: a CLI without them (or turned off), no view yet', () => {
    expect(connectionOf('a1', 'claude-code', undefined, view({ providers: [] }))).toBeNull()
    expect(connectionOf('x1', 'codex', undefined, view())).toBeNull()
    expect(connectionOf('a1', 'claude-code', undefined, null)).toBeNull()
  })
  it('what the choices offer: connections on accounts usable here, of CLIs turned on, in the order; the first is what a new agent gets (decision A)', () => {
    const v = view({ providers: ['claude-code', 'codex'], workspace: { 'claude-code': { on: ['a'], default: 'a' }, codex: { on: ['x'], default: 'x' } }, order: ['x', 'a', 'b'] })
    const s = { providers: { 'claude-code': { enabled: true }, codex: { enabled: true } } } as never
    expect(offeredConnections(v, s).map((c) => c.id)).toEqual(['x1', 'a1', 'a2'])
    expect(offeredConnections(v, s, 'claude-code').map((c) => c.id)).toEqual(['a1', 'a2'])
    const installed = cliReadyOf({ 'claude-code': { found: true }, codex: { found: true } })
    expect(firstUsableConnection(v, s, installed)).toBe('x1')
    // Decision A (HI-2108 round 1): on and installed, as main's firstUsableAccount; Codex first in the order but not
    // installed: Claude Code's first connection; still being looked for: none yet (a caller waits).
    expect(firstReadyConnection(v, s, cliReadyOf({ 'claude-code': { found: true }, codex: { found: false } }))).toEqual({ id: 'a1', checking: false })
    expect(firstReadyConnection(v, s, cliReadyOf({ 'claude-code': { found: true }, codex: { found: false, checking: true } }))).toEqual({ checking: true })
    expect(firstReadyConnection(v, s, cliReadyOf({ 'claude-code': { found: true } }))).toEqual({ checking: true })
    expect(firstReadyConnection(v, s, cliReadyOf({ 'claude-code': { found: false }, codex: { found: false } }))).toEqual({ checking: false })
    expect(firstUsableConnection(v, s, cliReadyOf({ 'claude-code': { found: true }, codex: { found: false } }), 'codex')).toBeUndefined()
    expect(connectionCli(v, 'a2')).toBe('claude-code')
    expect(connectionCli(v, 'gone')).toBeUndefined()
  })
})

describe('an agent’s own connection, checked with the write that saves it (HI-1769)', () => {
  const alpha = join(wsPath, 'alpha')
  const projectJson = join(alpha, '.combwork', 'project.json')
  const agentsOf = async (p: string) => (await w.projectConfig(p)).agents
  const deferred = () => {
    let done!: () => void
    const p = new Promise<void>((r) => (done = r))
    return { p, done }
  }

  it('Add Agent: one on here is kept; off, removed or another CLI’s is refused, saying why, and nothing is added', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await accounts.addAccount('claude-code', 'Work')
    const added = await here(() => addAgent(alpha, { name: 'On Personal', connection: a.id }))
    // An account named (today's screens, the adapter until HI-2108): its base connection.
    expect(added.connection).toBe(baseOf(a.id))
    expect(await outcome(here(() => addAgent(alpha, { name: 'On Work', connection: b.id })))).toMatch(/Work isn't on in this workspace/)
    expect(await outcome(here(() => addAgent(alpha, { name: 'On Gone', connection: 'a-gone' })))).toMatch(/no longer exists/)
    config.update((c) => void (c.accounts = (c.accounts ?? []).map((x) => (x.id === b.id ? { ...x, provider: 'codex' } : x))))
    expect(await outcome(here(() => addAgent(alpha, { name: 'On Codex', provider: 'claude-code', connection: b.id })))).toMatch(/for another CLI/)
    expect((await agentsOf(alpha)).map((x) => x.name)).not.toEqual(expect.arrayContaining(['On Work', 'On Gone', 'On Codex']))
    await here(() => import('../src/main/projectAgents').then((m) => m.removeAgent(alpha, added.id, { deleteWorktree: false })))
  })

  it('Add Agent: a connection turned off while it waits on its write is refused then, nothing added', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    await signedInConnection('Work', 'work@example.com')
    const lock = deferred()
    const holding = withFileLock(projectJson, () => lock.p)
    const adding = here(() => addAgent(alpha, { name: 'Stale', connection: a.id }))
    await vi.waitFor(() => expect(fileLockDepth(projectJson)).toBe(2), { timeout: HUNG_MS })
    await here(() => accounts.setAccountOn(a.id, false))
    lock.done()
    await holding
    expect(await outcome(adding)).toMatch(/Personal isn't on in this workspace/)
    expect((await agentsOf(alpha)).some((x) => x.name === 'Stale')).toBe(false)
  })

  it('Agent Settings: a new choice off, removed or another CLI’s is refused; the one already saved may stay (off here); checked under the lock', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    await here(() => updateAgent(alpha, 'a-one', { connection: b.id }))
    await here(() => accounts.setAccountOn(b.id, false))
    // Saved before it went off: saving the agent again keeps it (the default runs it meanwhile).
    expect((await here(() => updateAgent(alpha, 'a-one', { connection: b.id, role: 'kept' }))).connection).toBe(baseOf(b.id))
    // Cleared: its CLI's first usable here (HI-2106, decision H).
    expect((await here(() => updateAgent(alpha, 'a-one', { connection: null }))).connection).toBe(baseOf(a.id))
    expect(await outcome(here(() => updateAgent(alpha, 'a-one', { connection: b.id })))).toMatch(/Work isn't on in this workspace/)
    expect(await outcome(here(() => updateAgent(alpha, 'a-one', { connection: 'a-gone' })))).toMatch(/no longer exists/)
    // On when asked, off by the time its write runs: refused then.
    await here(() => accounts.setAccountOn(b.id, true))
    const lock = deferred()
    const holding = withFileLock(projectJson, () => lock.p)
    const saving = here(() => updateAgent(alpha, 'a-one', { connection: b.id }))
    await vi.waitFor(() => expect(fileLockDepth(projectJson)).toBe(2), { timeout: HUNG_MS })
    await here(() => accounts.setAccountOn(b.id, false))
    lock.done()
    await holding
    expect(await outcome(saving)).toMatch(/Work isn't on in this workspace/)
    expect((await agentsOf(alpha)).find((x) => x.id === 'a-one')?.connection).toBe(baseOf(a.id))
    await here(() => updateAgent(alpha, 'a-one', { role: null as unknown as string }))
  })

  it('Agent Settings: the saved connection removed since, or now another CLI’s, is refused even unchanged', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    await here(() => updateAgent(alpha, 'a-one', { connection: a.id }))
    await accounts.removeAccount(a.id)
    expect(await outcome(here(() => updateAgent(alpha, 'a-one', { connection: a.id, role: 'unchanged choice' })))).toMatch(/no longer exists/)
    await here(() => updateAgent(alpha, 'a-one', { connection: b.id }))
    config.update((c) => void (c.accounts = (c.accounts ?? []).map((x) => (x.id === b.id ? { ...x, provider: 'codex' } : x))))
    expect(await outcome(here(() => updateAgent(alpha, 'a-one', { connection: b.id, role: 'unchanged choice' })))).toMatch(/for another CLI/)
    // Cleared, it saves (the default again).
    await here(() => updateAgent(alpha, 'a-one', { connection: null, role: null as unknown as string }))
  })
})

describe('templates’ connections (HI-1769; HI-2106: dropped as they are read; HI-2109: chosen when loaded)', () => {
  const gamma = join(wsPath, 'gamma')
  const tplDir = join(wsPath, '.combwork', 'templates')
  /** A template from before HI-2106: T1 on Personal (its id), T2 on a connection this machine never had, T3 on none of its own. */
  function writeTemplate(file: string, personal: string) {
    mkdirSync(tplDir, { recursive: true })
    writeFileSync(join(tplDir, file), JSON.stringify({ version: TEMPLATE_VERSION, name: file, savedAt: '', layout: 'auto', agents: [
      { name: 'T1', role: 'builder', provider: 'claude-code', connection: personal, connectionName: 'Personal' },
      { name: 'T2', role: 'reviewer', provider: 'claude-code', connection: 'a-elsewhere', connectionName: 'Max 2' },
      { name: 'T3', role: 'builder', provider: 'claude-code' }
    ] }))
  }
  const ids = async () => (await w.projectConfig(gamma)).agents.map((a) => a.id)
  const byName = async (n: string) => (await w.projectConfig(gamma)).agents.find((a) => a.name === n)

  it('the plan offers the connections on here, in the order; with no answers every agent gets the first on the CLI it suggests', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    writeTemplate('flags.json', a.id)
    const plan = await here(() => templates.templatePlan(gamma, 'workspace', 'flags.json'))
    expect(plan.options.map((o) => [o.id, o.accountName, o.cli])).toEqual([[baseOf(a.id), 'Personal', 'claude-code'], [baseOf(b.id), 'Work', 'claude-code']])
    expect(plan.create.some((x) => 'connection' in x || 'connectionName' in x)).toBe(false)
    const before = await ids()
    await here(() => templates.loadTemplate(gamma, 'workspace', 'flags.json', before))
    for (const n of ['T1', 'T2', 'T3']) expect((await byName(n))?.connection).toBe(baseOf(a.id))
  })

  it('one agent added from a template: its CLI’s first usable connection', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    writeTemplate('one.json', a.id)
    const t2 = await here(() => templates.addAgentFromTemplate(gamma, 'workspace', 'one.json', 1, undefined, 'One T2'))
    expect(t2.connection).toBe(baseOf(a.id))
  })

  it('saved: no connection, nor its name', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    await here(() => updateAgent(join(wsPath, 'alpha'), 'a-one', { connection: a.id }))
    await here(() => templates.saveTemplate(join(wsPath, 'alpha'), 'workspace', 'Saved'))
    const saved = JSON.parse(readFileSync(join(tplDir, 'saved.json'), 'utf8'))
    expect(saved.agents[0]).not.toHaveProperty('connection')
    expect(saved.agents[0]).not.toHaveProperty('connectionName')
  })
})

describe('model, effort and context from the connection (HI-1770)', () => {
  const settings = { defaultProvider: 'claude-code', providers: { 'claude-code': { defaultModel: 'sonnet', defaultEffort: 'medium', use200kContext: true } } } as never
  const cfg = { defaultProvider: 'inherit', providers: { 'claude-code': { model: 'haiku', effort: 'high', permissionMode: 'inherit', extraArgs: '--x', use200kContext: 'on' } } } as never
  const conn = { defaults: { model: 'opus', effort: 'low', use200kContext: false } }

  it('the resolver at 16e8d6129, the migration’s reading: legacy reads the project then the CLI; with a connection, its own then the connection’s', () => {
    expect(agentLaunchSettings({ provider: 'claude-code' }, cfg, settings)).toMatchObject({ model: 'haiku', effort: 'high', use200kContext: true })
    expect(agentLaunchSettings({ provider: 'claude-code' }, cfg, settings, { kind: 'connection', conn })).toMatchObject({ model: 'opus', effort: 'low', use200kContext: false, extraArgs: ['--x'] })
    expect(agentLaunchSettings({ provider: 'claude-code', model: 'sonnet', use200kContext: true }, cfg, settings, { kind: 'connection', conn })).toMatchObject({ model: 'sonnet', effort: 'low', use200kContext: true })
    // None usable: the agent's own alone; an explicit false context kept.
    expect(agentLaunchSettings({ provider: 'claude-code', use200kContext: false }, cfg, settings, { kind: 'connection', conn: null })).toMatchObject({ model: null, effort: null, use200kContext: false })
    expect(agentLaunchSettings({ provider: 'claude-code' }, cfg, settings, { kind: 'connection', conn: { defaults: {} } })).toMatchObject({ model: null, effort: null, use200kContext: false })
  })

  it("the Assistant's own: its agent's, else Settings → Assistant's; its connection's after", () => {
    expect(assistantOwn({ model: undefined, use200kContext: undefined }, { model: 'haiku', effort: 'low', use200kContext: 'off' })).toMatchObject({ model: 'haiku', effort: 'low', use200kContext: false })
    expect(assistantOwn({ model: 'opus', use200kContext: true }, { model: 'haiku', effort: '', use200kContext: 'off' })).toMatchObject({ model: 'opus', use200kContext: true })
  })

  it("the move: only where an agent has none of its own (an explicit off kept), only its CLI's agents, once", () => {
    const project = { version: 2, providers: { 'claude-code': { model: 'haiku', effort: 'high', permissionMode: 'inherit', extraArgs: '', use200kContext: 'on' } }, agents: [{ id: 'own', name: 'Own', provider: 'claude-code', model: 'opus', use200kContext: false }, { id: 'none', name: 'None', provider: 'claude-code' }, { id: 'cx', name: 'Cx', provider: 'codex' }] } as never
    const r = moveProjectOverrides(project, 'claude-code', (a) => a.provider!, 'now')!
    expect(r.agents.find((a) => a.id === 'own')).toMatchObject({ model: 'opus', effort: 'high', use200kContext: false })
    expect(r.agents.find((a) => a.id === 'none')).toMatchObject({ model: 'haiku', effort: 'high', use200kContext: true })
    expect(r.agents.find((a) => a.id === 'cx')).toEqual({ id: 'cx', name: 'Cx', provider: 'codex' })
    expect(r.migrations?.connections1?.['claude-code']?.moved.map((m) => m.id).sort()).toEqual(['claude-code:none:effort', 'claude-code:none:model', 'claude-code:none:use200kContext', 'claude-code:own:effort'])
    expect(moveProjectOverrides({ ...(project as object), ...r } as never, 'claude-code', (a) => a.provider!, 'later')).toBeNull()
    // A project that set nothing gives nothing.
    const plain = moveProjectOverrides({ version: 2, agents: [{ id: 'n', name: 'N', provider: 'claude-code' }] } as never, 'claude-code', (a) => a.provider!, 'now')!
    expect(plain.agents[0]).toEqual({ id: 'n', name: 'N', provider: 'claude-code' })
    expect(plain.migrations?.connections1?.['claude-code']?.moved).toEqual([])
  })

  /** An agent's connection as saved (HI-2106). */
  const savedConnection = async (p: string, id: string) => accounts.getConnection((await w.projectConfig(p)).agents.find((a) => a.id === id)?.connection)

  it('migrated once, in one write with its record: agents on their connections, the project’s and their own launch settings gone (HI-2106)', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const p = join(wsPath, 'mv1')
    await here(() => moves.ensureMigrated(p))
    const once = await w.projectConfig(p)
    const file = JSON.parse(readFileSync(join(p, '.combwork', 'project.json'), 'utf8'))
    expect('providers' in file || 'defaultProvider' in file || 'model' in file).toBe(false)
    for (const x of file.agents) expect(Object.keys(x).filter((k) => ['model', 'effort', 'permissionMode', 'use200kContext'].includes(k))).toEqual([])
    // HI-1770's move as its launch would have made it, then the connection with what it launched with.
    expect(await savedConnection(p, 'none')).toMatchObject({ account: a.id, model: 'haiku', effort: 'high', use200kContext: true })
    expect(await savedConnection(p, 'own')).toMatchObject({ account: a.id, model: 'opus', effort: 'high' })
    expect((await savedConnection(p, 'own'))?.use200kContext).toBeUndefined()
    // No Codex account: kept without one, with what it would launch with, until it has one.
    expect(once.agents.find((x) => x.id === 'cx')?.connection).toBeUndefined()
    expect(once.migrations?.accounts1?.unplaced?.cx).toMatchObject({ model: 'gpt-5', effort: 'low' })
    expect(Object.keys(once.migrations?.connections1 ?? {}).sort()).toEqual(['claude-code', 'codex'])
    await here(() => moves.ensureMigrated(p))
    expect(await w.projectConfig(p)).toEqual(once)
  })

  it('an agent kept without a connection gets one once its CLI has an account here, with its values over that account’s', async () => {
    await signedInConnection('Personal', 'me@example.com')
    const p = join(wsPath, 'mv6')
    await here(() => moves.ensureMigrated(p))
    expect((await w.projectConfig(p)).migrations?.accounts1?.unplaced?.cx).toBeTruthy()
    const x = await accounts.addAccount('codex', 'Codex')
    await here(() => accounts.setAccountOn(x.id, true))
    await here(() => moves.ensureMigrated(p))
    expect((await w.projectConfig(p)).migrations?.accounts1?.unplaced).toBeUndefined()
    expect(await savedConnection(p, 'cx')).toMatchObject({ account: x.id, model: 'gpt-5', effort: 'low' })
  })

  it('interrupted before its write: nothing migrated, nothing recorded, and the next run migrates it', async () => {
    await signedInConnection('Personal', 'me@example.com')
    const p = join(wsPath, 'mv2')
    const spy = vi.spyOn(w, 'mutateProjectConfig').mockRejectedValueOnce(new Error('disk full'))
    try {
      expect(await outcome(here(() => moves.ensureMigrated(p)))).toMatch(/disk full/)
    } finally {
      spy.mockRestore()
    }
    const before = await w.projectConfig(p)
    expect(before.migrations).toBeUndefined()
    expect(before.agents.find((a) => a.id === 'own')?.model).toBe('opus')
    await here(() => moves.ensureMigrated(p))
    expect(await savedConnection(p, 'none')).toMatchObject({ model: 'haiku' })
  })

  it("a launch waits on the migration held on the project's lock, then starts with the agent's connection", async () => {
    await signedInConnection('Personal', 'me@example.com')
    const p = join(wsPath, 'mv3')
    const file = join(p, '.combwork', 'project.json')
    let release!: () => void
    const held = withFileLock(file, () => new Promise<void>((r) => (release = r)))
    const agent = (await w.projectConfig(p)).agents.find((a) => a.id === 'none')!
    const eff = sessions.effective(p, agent)
    await vi.waitFor(() => expect(fileLockDepth(file)).toBe(2), { timeout: HUNG_MS })
    release()
    await held
    expect(await eff).toMatchObject({ model: 'haiku', effort: 'high', use200kContext: true })
    expect((await w.projectConfig(p)).migrations?.accounts1).toBeTruthy()
  })

  it('a migration another caller made after the launch read its agent: the agent as saved now is used, not the one read before', async () => {
    await signedInConnection('Personal', 'me@example.com')
    const p = join(wsPath, 'mv7')
    const before = (await w.projectConfig(p)).agents.find((a) => a.id === 'own')!
    await here(() => moves.ensureMigrated(p))
    expect(await sessions.effective(p, before)).toMatchObject({ model: 'opus', effort: 'high', use200kContext: false })
  })

  it('a launch whose migration fails is refused, saying so; the next one migrates and starts', async () => {
    await signedInConnection('Personal', 'me@example.com')
    const p = join(wsPath, 'mv4')
    const agent = (await w.projectConfig(p)).agents.find((a) => a.id === 'none')!
    const spy = vi.spyOn(w, 'mutateProjectConfig').mockRejectedValueOnce(new Error('locked by an editor'))
    try {
      expect(await outcome(sessions.effective(p, agent))).toMatch(/couldn't move mv4's model settings to its agents: locked by an editor/)
    } finally {
      spy.mockRestore()
    }
    expect(await sessions.effective(p, agent)).toMatchObject({ model: 'haiku' })
  })

  it("the notice: from HI-1770's record, kept by the migration (the value now its connection's), this workspace's only, dismissed for good", async () => {
    await signedInConnection('Personal', 'me@example.com')
    // Haiku takes no effort here: the moved "high" is kept on its connection, not used, and listed.
    const info = providerService.info
    providerService.info = ((id: string) => ({ provider: id, found: true, path: 'claude.exe', catalog: { source: 'cli', version: '1', models: [{ value: 'haiku', label: 'Haiku', efforts: [] }, { value: 'opus', label: 'Opus', efforts: ['low', 'high'] }] } })) as never
    try {
      const p = join(wsPath, 'mv5')
      await here(() => moves.ensureMigrated(p))
      const shown = await moves.movedNotice(w)
      const mine = shown.filter((n) => n.project === 'mv5')
      expect(mine).toEqual([{ key: `${p.toLowerCase()}|claude-code:none:effort`, project: 'mv5', agent: 'mv5 None', field: 'effort', value: 'high' }])
      expect(moves.effortUsable('claude-code', 'opus', null, 'high')).toBe(true)
      // Another workspace's reply never has this one's projects.
      const ws2 = join(base, 'ws-notice')
      mkdirSync(ws2, { recursive: true })
      const w2 = createWorkspaceService()
      await w2.open(ws2)
      try {
        expect(await moves.movedNotice(w2)).toEqual([])
        await moves.dismissMovedNotice(w2, [mine[0].key])
        expect((await moves.movedNotice(w)).some((n) => n.key === mine[0].key)).toBe(true)
      } finally {
        await disposeWorkspaceService(w2)
      }
      await moves.dismissMovedNotice(w, [mine[0].key])
      expect((await moves.movedNotice(w)).some((n) => n.key === mine[0].key)).toBe(false)
    } finally {
      providerService.info = info
    }
  })

  it('a project is written only once every connection it names is on disk: its config.json saved first (HR1, round 1)', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const p = join(wsPath, 'mv8')
    const configFile = join(base, 'profile', 'config.json')
    let seen: { names: number; on: boolean } | null = null
    configTestHooks.beforeConfigWrite = async (written) => {
      if (written.toLowerCase() !== p.toLowerCase()) return
      // As config.json is on disk when project.json is about to name its connections.
      const onDisk = JSON.parse(readFileSync(configFile, 'utf8')).connections ?? []
      seen = { names: onDisk.length, on: onDisk.some((c: { account: string; model?: string; effort?: string }) => c.account === a.id && c.model === 'haiku' && c.effort === 'high') }
    }
    try {
      await here(() => moves.ensureMigrated(p))
    } finally {
      configTestHooks.beforeConfigWrite = undefined
    }
    expect(seen).toMatchObject({ on: true })
    expect(await savedConnection(p, 'none')).toMatchObject({ account: a.id, model: 'haiku', effort: 'high' })
  })

  it("config.json that can't be saved: nothing published, the project's old fields kept and unmarked; the next run migrates", async () => {
    await signedInConnection('Personal', 'me@example.com')
    const p = join(wsPath, 'mv9')
    const before = readFileSync(join(p, '.combwork', 'project.json'), 'utf8')
    const save = vi.spyOn(config, 'saveNow').mockResolvedValue(false)
    try {
      expect(await outcome(here(() => moves.ensureMigrated(p)))).toMatch(/config\.json couldn't be saved/)
    } finally {
      save.mockRestore()
    }
    expect(readFileSync(join(p, '.combwork', 'project.json'), 'utf8')).toBe(before)
    expect((await w.projectConfig(p)).migrations?.accounts1).toBeUndefined()
    await here(() => moves.ensureMigrated(p))
    expect(await savedConnection(p, 'none')).toMatchObject({ model: 'haiku', effort: 'high' })
  })

  it('decision E at every save: a model and effort that don\'t go together are refused, the connection unchanged', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const info = providerService.info
    providerService.info = ((id: string) => ({ provider: id, found: true, path: 'claude.exe', catalog: { source: 'cli', version: '1', models: [{ value: 'haiku', label: 'Haiku', efforts: [] }, { value: 'opus', label: 'Opus', efforts: ['low', 'high'] }] } })) as never
    try {
      // Settings → Accounts & Connections' connection dialog (its base connection).
      accounts.updateConnection(baseOf(a.id), { model: 'opus', effort: 'high' })
      const baseBefore = structuredClone(accounts.allConnections().find((c) => c.account === a.id))
      expect(() => accounts.updateConnection(baseOf(a.id), { model: 'haiku' })).toThrow(/haiku doesn't take high effort/)
      expect(accounts.allConnections().find((c) => c.account === a.id)).toEqual(baseBefore)
    } finally {
      providerService.info = info
      await here(() => updateAgent(join(wsPath, 'alpha'), 'a-one', { connection: null }))
    }
  })

  it("decision E for GitHub Copilot's connections: refused when saved, nothing made (HR1, round 2; HI-2107)", async () => {
    await signedInConnection('Personal', 'me@example.com')
    const info = providerService.info
    providerService.info = ((id: string) => ({ provider: id, found: true, path: 'claude.exe', catalog: { source: 'cli', version: '1', models: [{ value: 'haiku', label: 'Haiku', efforts: [] }, { value: 'opus', label: 'Opus', efforts: ['low', 'high'] }] } })) as never
    try {
      // Its sign-in's account, as config.json's migration makes it at a start (this file's profile never started).
      if (!accounts.accountById('copilot'))
        config.update((c) => {
          c.accounts = [...(c.accounts ?? []), { id: 'copilot', provider: 'copilot', kind: 'signIn', home: 'cli', name: 'GitHub Copilot', createdAt: '' }]
          c.connections = [...(c.connections ?? []), { id: 'c-copilot1', account: 'copilot', name: 'GitHub Copilot' }]
        })
      expect(() => accounts.addConnection('copilot', { name: 'Fast', model: 'haiku', effort: 'high' })).toThrow(/haiku doesn't take high effort/)
      expect(accounts.allConnections().filter((c) => c.account === 'copilot').map((c) => c.name)).toEqual(['GitHub Copilot'])
    } finally {
      providerService.info = info
    }
  })

  it("a new account's base connection: the CLI's old defaults for its CLI's first sign-in account only, and the CLI's mode and arguments; the connection dialog edits it", async () => {
    const g = config.settings.providers['claude-code']
    const was = { defaultModel: g.defaultModel, defaultEffort: g.defaultEffort, extraArgs: g.extraArgs }
    Object.assign(g, { defaultModel: 'sonnet', defaultEffort: 'medium', extraArgs: '--verbose' })
    try {
      expect(cliDefaults(config.settings, 'claude-code')).toMatchObject({ model: 'sonnet', effort: 'medium' })
      const a = await accounts.addAccount('claude-code', 'Copied')
      expect(accounts.allConnections().find((c) => c.account === a.id)).toMatchObject({ name: 'Copied', model: 'sonnet', effort: 'medium', extraArgs: '--verbose' })
      expect(config.get().connectionDefaultsTaken).toEqual(['claude-code'])
      // Taken once: a second account of the CLI has none of them.
      const second = await accounts.addAccount('claude-code', 'Second')
      expect(accounts.allConnections().find((c) => c.account === second.id)).toEqual({ id: baseOf(second.id), account: second.id, name: 'Second', extraArgs: '--verbose' })
      // Its base connection, edited in the connection dialog (HI-2107).
      accounts.updateConnection(baseOf(a.id), { model: null, effort: null })
      expect(accounts.allConnections().find((c) => c.account === a.id)?.model).toBeUndefined()
      accounts.updateConnection(baseOf(a.id), { model: 'opus', use200kContext: true })
      expect(here(() => accounts.accountsView()).connections.find((c) => c.id === a.id)?.defaults).toEqual({ model: 'opus', use200kContext: true })
      // Removed, its connections go with it.
      await accounts.removeAccount(a.id)
      expect(accounts.allConnections().some((c) => c.account === a.id)).toBe(false)
    } finally {
      Object.assign(g, was)
    }
  })

  it('the one-time notice that agents run on connections: while none was ever added; a connection added or a dismissal ends it for good (HI-1774)', async () => {
    expect(here(() => accounts.accountsView()).intro).toEqual(['claude-code'])
    const a = await accounts.addAccount('claude-code', 'First')
    expect(config.get().ui.connectionsIntroShown).toBe(true)
    await accounts.removeAccount(a.id)
    expect(here(() => accounts.accountsView()).intro).toBeUndefined()
    // Dismissed, before any was added: the same, once.
    config.update((c) => void delete c.ui.connectionsIntroShown)
    expect(here(() => accounts.accountsView()).intro).toEqual(['claude-code'])
    accounts.dismissConnectionsIntro()
    expect(here(() => accounts.accountsView()).intro).toBeUndefined()
    // Not for a test copy on its CLI test home (the seam): nothing to set up there.
    config.update((c) => void delete c.ui.connectionsIntroShown)
    process.env.CW_TEST_CLI_HOME_CONNECTION = '1'
    try {
      expect(here(() => accounts.accountsView()).intro).toBeUndefined()
    } finally {
      delete process.env.CW_TEST_CLI_HOME_CONNECTION
    }
  })
})

describe('the Agent API and connections (HI-1771)', () => {
  const c = (id: string, name: string, cli: Account['provider'] = 'claude-code', extra: Partial<Account> = {}): Account => ({ id, provider: cli, name, createdAt: '', ...extra })

  it('a reference: an exact id; else a name (any case) unique among those on here; ambiguous and unknown refused', () => {
    const all = [c('a-1', 'Max'), c('a-2', 'max'), c('a-3', 'Work'), c('a-4', 'Hidden')]
    expect(connectionRef('a-4', all, ['a-1'])).toEqual({ ok: true, id: 'a-4' })
    expect(connectionRef('work', all, ['a-1', 'a-3'])).toEqual({ ok: true, id: 'a-3' })
    expect(connectionRef('MAX', all, ['a-1', 'a-2'])).toEqual({ ok: false, why: 'ambiguous', ids: ['a-1', 'a-2'] })
    // Only those on here count for a name: one of the two off, the other binds.
    expect(connectionRef('max', all, ['a-2'])).toEqual({ ok: true, id: 'a-2' })
    expect(connectionRef('Hidden', all, ['a-1'])).toEqual({ ok: false, why: 'unknown' })
    expect(connectionRef('nothing', all, [])).toEqual({ ok: false, why: 'unknown' })
  })

  it('what each caller sees: a project agent only those on here, four fields; the token and the Assistant all, with on, default and identity; never storage', () => {
    const all = [c('a-1', 'Max 1', 'claude-code', { accepted: { email: 'one@example.com', orgId: 'o' }, observed: { at: '', loggedIn: true, email: 'one@example.com', orgId: 'o', plan: 'max' } }), c('a-2', 'Elsewhere')]
    const ws = { 'claude-code': { on: ['a-1'], default: 'a-1' } }
    const narrow = connectionsFor(all, ws, false)
    expect(narrow).toEqual([{ id: 'a-1', name: 'Max 1', cli: 'claude-code', kind: 'signIn', signedIn: true }])
    const wide = connectionsFor(all, ws, true)
    expect(wide).toEqual([
      { id: 'a-1', name: 'Max 1', cli: 'claude-code', kind: 'signIn', signedIn: true, on: true, default: true, order: 1, email: 'one@example.com', plan: 'max' },
      { id: 'a-2', name: 'Elsewhere', cli: 'claude-code', kind: 'signIn', signedIn: false, on: false, default: false, order: 2 }
    ])
    // Its place in its CLI's preference order (HI-1875), whoever asks for one alone.
    expect(connectionShown(all[1], ws, true, all).order).toBe(2)
    // The detail projection is the same, per caller; nothing of where its login is kept, its settings or defaults.
    for (const shown of [connectionShown(all[0], ws, true), connectionShown(all[0], ws, false), ...wide, ...narrow]) {
      expect(Object.keys(shown).sort()).not.toEqual(expect.arrayContaining(['folder']))
      expect(JSON.stringify(shown)).not.toMatch(/folder|accounts|defaults|observed|accepted|orgId|opus/)
    }
  })

  it("a change of connection: kept when left out; cleared with null, its CLI's first usable here; on another CLI it is that change of CLI (only what it gives), refused while it runs", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const p = join(wsPath, 'api1')
    // Its own model, effort and context (migrated): the connection on Personal with them.
    const mine = (await here(() => updateAgent(p, 'k', { connection: a.id }))).connection
    expect(accounts.getConnection(mine)).toMatchObject({ account: a.id, model: 'opus', effort: 'high', use200kContext: true })
    // An unrelated change keeps it.
    expect((await here(() => updateAgent(p, 'k', { role: 'notes' }))).connection).toBe(mine)
    expect((await here(() => updateAgent(p, 'k', { connection: null }))).connection).toBe(baseOf(a.id))
    const enabled = config.settings.providers.codex.enabled
    config.settings.providers.codex.enabled = true
    try {
      const x = await accounts.addAccount('codex', 'ChatGPT')
      await here(() => accounts.setAccountOn(x.id, true))
      // Running: refused, nothing changed.
      const live = vi.spyOn(sessions, 'liveFor').mockReturnValue({} as never)
      try {
        expect(await outcome(here(() => updateAgent(p, 'k', { provider: 'codex', connection: x.id })))).toMatch(/Stop the agent before changing its provider/)
      } finally {
        live.mockRestore()
      }
      expect((await w.projectConfig(p)).agents[0]).toMatchObject({ provider: 'claude-code', connection: baseOf(a.id) })
      const switched = await here(() => updateAgent(p, 'k', { provider: 'codex', connection: x.id }))
      expect(switched).toMatchObject({ provider: 'codex', connection: baseOf(x.id) })
      for (const k of ['model', 'effort', 'use200kContext', 'lastSessionId'] as const) expect(switched[k]).toBeUndefined()
      // Back by provider alone: its CLI's first usable connection here, never the Codex one.
      const back = await here(() => updateAgent(p, 'k', { provider: 'claude-code' }))
      expect(back).toMatchObject({ provider: 'claude-code', connection: baseOf(a.id) })
    } finally {
      config.settings.providers.codex.enabled = enabled
    }
  })

  it('a change of CLI racing a start (by provider alone, and by a connection on another CLI): refused under the lock, the agent unchanged', async () => {
    await signedInConnection('Personal', 'me@example.com')
    const p = join(wsPath, 'api1')
    const file = join(p, '.combwork', 'project.json')
    const enabled = config.settings.providers.codex.enabled
    config.settings.providers.codex.enabled = true
    try {
      const x = await accounts.addAccount('codex', 'ChatGPT 2')
      await here(() => accounts.setAccountOn(x.id, true))
      await here(() => moves.ensureMigrated(p))
      const before = (await w.projectConfig(p)).agents[0]
      expect(before.provider).toBe('claude-code')
      for (const patch of [{ provider: 'codex' as const }, { provider: 'codex' as const, connection: x.id }]) {
        let release!: () => void
        const held = withFileLock(file, () => new Promise<void>((r) => (release = r)))
        const saving = here(() => updateAgent(p, 'k', patch))
        await vi.waitFor(() => expect(fileLockDepth(file)).toBe(2), { timeout: HUNG_MS })
        // It starts (on Claude Code) while the change waits on the project's lock.
        const live = vi.spyOn(sessions, 'liveFor').mockReturnValue({} as never)
        try {
          release()
          await held
          expect(await outcome(saving)).toMatch(/Stop the agent before changing its provider/)
        } finally {
          live.mockRestore()
        }
        expect((await w.projectConfig(p)).agents[0]).toEqual(before)
      }
    } finally {
      config.settings.providers.codex.enabled = enabled
    }
  })

  it('a change of CLI decided from the agent read before the write: changed meanwhile, refused whole', async () => {
    const p = join(wsPath, 'api1')
    await here(() => moves.ensureMigrated(p))
    const file = join(p, '.combwork', 'project.json')
    let release!: () => void
    const held = withFileLock(file, () => new Promise<void>((r) => (release = r)))
    const saving = here(() => updateAgent(p, 'k', { provider: 'codex' }))
    await vi.waitFor(() => expect(fileLockDepth(file)).toBe(2), { timeout: HUNG_MS })
    // Meanwhile something else moves it to Codex (written while the change waits on the lock).
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const was = raw.agents[0].connection
    raw.agents[0].provider = 'codex'
    writeFileSync(file, JSON.stringify(raw))
    release()
    await held
    expect(await outcome(saving)).toMatch(/provider was changed meanwhile: nothing was changed/)
    expect((await w.projectConfig(p)).agents[0].connection).toBe(was)
    raw.agents[0].provider = 'claude-code'
    writeFileSync(file, JSON.stringify(raw))
  })
})

describe('connections as Settings → Accounts & Connections changes them (HI-2107)', () => {
  const opus = { provider: 'claude-code', found: true, path: 'claude.exe', catalog: { source: 'cli', version: '1', models: [{ value: 'haiku', label: 'Haiku', efforts: [] }, { value: 'opus', label: 'Opus', efforts: ['low', 'high'] }] } }
  const names = (account: string): string[] => accounts.allConnections().filter((c) => c.account === account).map((c) => c.name)

  it('add: after its account’s others, values kept as chosen; no name, a name taken, a mode its CLI lacks and a model and effort that don’t go together refused (decision E)', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    const info = providerService.info
    providerService.info = ((id: string) => ({ ...opus, provider: id })) as never
    try {
      const high = accounts.addConnection(a.id, { name: 'Claude · High', model: 'opus', effort: 'high', permissionMode: 'plan', extraArgs: ' --verbose ' })
      expect(high).toMatchObject({ account: a.id, name: 'Claude · High', model: 'opus', effort: 'high', permissionMode: 'plan', extraArgs: '--verbose' })
      // After Personal's base, before Work's: each account's connections stay together, its base first.
      expect(accounts.allConnections().filter((c) => c.account === a.id || c.account === b.id).map((c) => c.name)).toEqual(['Personal', 'Claude · High', 'Work'])
      expect(await outcome(Promise.resolve().then(() => accounts.addConnection(a.id, { name: '  ' })))).toMatch(/Give the connection a name/)
      expect(await outcome(Promise.resolve().then(() => accounts.addConnection(a.id, { name: 'claude · high' })))).toMatch(/Personal already has a connection named claude · high/)
      // Another account may use the same name.
      expect(accounts.addConnection(b.id, { name: 'Claude · High' }).account).toBe(b.id)
      expect(await outcome(Promise.resolve().then(() => accounts.addConnection(a.id, { name: 'X', permissionMode: 'nope' as never })))).toMatch(/Claude Code has no permission mode nope/)
      expect(await outcome(Promise.resolve().then(() => accounts.addConnection(a.id, { name: 'X', model: 'haiku', effort: 'high' })))).toMatch(/haiku doesn't take high effort/)
      expect(names(a.id)).toEqual(['Personal', 'Claude · High'])
    } finally {
      providerService.info = info
    }
  })

  it('update clears a value with null and checks the pair it makes with what it keeps; duplicate names the copy; a server account’s take no effort or context', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const info = providerService.info
    providerService.info = ((id: string) => ({ ...opus, provider: id })) as never
    try {
      const c = accounts.addConnection(a.id, { name: 'High', model: 'opus', effort: 'high', use200kContext: true })
      // Haiku with the High it keeps: refused, nothing changed.
      expect(await outcome(Promise.resolve().then(() => accounts.updateConnection(c.id, { model: 'haiku' })))).toMatch(/haiku doesn't take high effort/)
      expect(accounts.getConnection(c.id)).toMatchObject({ model: 'opus', effort: 'high' })
      expect(accounts.updateConnection(c.id, { model: 'haiku', effort: null, use200kContext: null, name: 'Fast' })).toEqual({ id: c.id, account: a.id, name: 'Fast', model: 'haiku' })
      const copy = accounts.duplicateConnection(c.id)
      expect(copy).toMatchObject({ account: a.id, name: 'Fast (2)', model: 'haiku' })
      expect(accounts.duplicateConnection(c.id).name).toBe('Fast (3)')
      expect(names(a.id)).toEqual(['Personal', 'Fast', 'Fast (3)', 'Fast (2)'])
      // Moved within its account; 0 makes it the base.
      accounts.moveConnectionInAccount(copy.id, 0)
      expect(names(a.id)).toEqual(['Fast (2)', 'Personal', 'Fast', 'Fast (3)'])
    } finally {
      providerService.info = info
    }
    config.update((c) => void (c.accounts = [...(c.accounts ?? []), { id: 'a-srv1', provider: 'claude-code', kind: 'server', server: { baseUrl: 'http://127.0.0.1:9', models: [{ id: 'm1' }], modelsFrom: 'typed' }, name: 'Server', createdAt: '' }]))
    const s = accounts.addConnection('a-srv1', { name: 'Srv', model: 'm1', effort: 'high', use200kContext: true, permissionMode: 'manual' })
    expect(s).toEqual({ id: s.id, account: 'a-srv1', name: 'Srv', model: 'm1', permissionMode: 'manual' })
  })

  it('remove: refused while an agent or the Assistant of an open workspace uses it, naming them; the one order of accounts across CLIs', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const c = accounts.addConnection(a.id, { name: 'Used' })
    const p = join(wsPath, 'cr1')
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, migrations: { accounts1: { at: '' } }, agents: [{ id: 'u1', name: 'Builder', provider: 'claude-code', connection: c.id }] }))
    try {
      await w.refresh()
      expect(accounts.connectionUsers().get(c.id)).toEqual([{ projectPath: expect.any(String), project: 'cr1', agentId: 'u1', agent: 'Builder' }])
      const row = here(() => accounts.accountsView()).connectionRows.find((r) => r.id === c.id)
      expect(row?.users.map((u) => u.agent)).toEqual(['Builder'])
      expect(await outcome(Promise.resolve().then(() => accounts.removeConnection(c.id)))).toMatch(/Still in use, so Used was kept: Builder \(cr1\)/)
      writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, migrations: { accounts1: { at: '' } }, agents: [] }))
      await w.refresh()
      await accounts.removeConnection(c.id)
      expect(accounts.getConnection(c.id)).toBeUndefined()
    } finally {
      writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    }
    // One order for every CLI (decision A): a Codex account moved above Claude Code's.
    const x = await accounts.addAccount('codex', 'Codex One')
    expect(accounts.allAccounts().filter((y) => !y.home).map((y) => y.name)).toEqual(['Personal', 'Codex One'])
    accounts.moveConnection(x.id, 0)
    expect(accounts.allAccounts().filter((y) => !y.home).map((y) => y.name)).toEqual(['Codex One', 'Personal'])
    expect(here(() => accounts.accountsView()).order.filter((id) => id === x.id || id === a.id)).toEqual([x.id, a.id])
  })

  describe("remove reads each project's agents as saved, under the lock their writes take (HR1, round 1)", () => {
    const p = join(wsPath, 'cr2')
    const file = join(p, '.combwork', 'project.json')
    // Its own project id in every write (HI-2130): one written without it is given one by the workspace's id check (the
    // root watch's, or any projectIds read), which takes this file's lock, a third waiter in the queue these cases count.
    const id = 'p-2130c0ffee02'
    const agentOn = (connection?: string) => ({ version: 2, id, migrations: { accounts1: { at: '' } }, agents: [{ id: 'g1', name: 'Gamma', provider: 'claude-code', ...(connection ? { connection } : {}) }] })
    beforeAll(async () => {
      mkdirSync(join(p, '.combwork'), { recursive: true })
      writeFileSync(file, JSON.stringify(agentOn()))
      await w.refresh()
      // As Combwork's start sets it (initConnections).
      setConnectionGuard(accounts.connectionAssignable)
    })
    afterAll(() => writeFileSync(file, JSON.stringify({ version: 2, id, agents: [] })))
    afterEach(() => {
      accounts.accountTestHooks.beforeUsersRead = undefined
      writeFileSync(file, JSON.stringify(agentOn()))
    })
    const saved = (): string | undefined => JSON.parse(readFileSync(file, 'utf8')).agents[0].connection

    it("an agent given it just before, the window's snapshot not read again: refused, the connection kept", async () => {
      const a = await signedInConnection('Personal', 'me@example.com')
      const c = accounts.addConnection(a.id, { name: 'Fresh' })
      // Saved through the write every assignment takes (project:updateConfig's), with no refresh of the window's view.
      await w.mutateProjectConfig(p, (now) => ({ agents: now.agents.map((x) => ({ ...x, connection: c.id })) }))
      expect(await outcome(accounts.removeConnection(c.id))).toMatch(/Still in use, so Fresh was kept: Gamma \(cr2\)/)
      expect(accounts.getConnection(c.id)).toBeDefined()
      expect(saved()).toBe(c.id)
    })

    it('a write holding the lock as the removal starts: the removal waits for it, then reads it and refuses', async () => {
      const a = await signedInConnection('Personal', 'me@example.com')
      const c = accounts.addConnection(a.id, { name: 'Held' })
      let release!: () => void
      const held = withFileLock(file, () => new Promise<void>((r) => (release = r)))
      // Let go however the case ends: a hold left by a failed check would stall every later write to the file.
      try {
        await vi.waitFor(() => expect(fileLockDepth(file)).toBe(1), { timeout: HUNG_MS })
        const removal = outcome(accounts.removeConnection(c.id))
        await vi.waitFor(() => expect(fileLockDepth(file)).toBe(2), { timeout: HUNG_MS })
        // The write under way finishes giving it to Gamma, then lets go.
        writeFileSync(file, JSON.stringify(agentOn(c.id)))
        release()
        await held
        expect(await removal).toMatch(/Still in use, so Held was kept: Gamma/)
        expect(accounts.getConnection(c.id)).toBeDefined()
      } finally {
        release()
        await held
      }
    })

    it('a write giving it to an agent while the removal reads: refused, nothing written; the removal goes through', async () => {
      const a = await signedInConnection('Personal', 'me@example.com')
      const c = accounts.addConnection(a.id, { name: 'Going' })
      let go!: () => void
      let reached!: () => void
      const atRead = new Promise<void>((r) => (reached = r))
      accounts.accountTestHooks.beforeUsersRead = () => {
        reached()
        return new Promise<void>((r) => (go = r))
      }
      const removal = accounts.removeConnection(c.id)
      try {
        await atRead
        expect(await outcome(w.mutateProjectConfig(p, (now) => ({ agents: now.agents.map((x) => ({ ...x, connection: c.id })) })))).toMatch(/The connection chosen for Gamma was removed, or is being removed/)
        expect(saved()).toBeUndefined()
      } finally {
        // The removal held at its read goes on however the case ends, so it leaves no connection marked as being removed.
        go?.()
      }
      await removal
      expect(accounts.getConnection(c.id)).toBeUndefined()
      // Gone: still refused afterwards; an agent keeping a connection it already has is never refused.
      expect(await outcome(w.mutateProjectConfig(p, (now) => ({ agents: now.agents.map((x) => ({ ...x, connection: c.id })) })))).toMatch(/was removed, or is being removed/)
      writeFileSync(file, JSON.stringify(agentOn('c-gone0000')))
      expect(await outcome(w.mutateProjectConfig(p, (now) => ({ agents: now.agents.map((x) => ({ ...x, name: 'Gamma' })) })))).toBe('ok')
    })
  })

  it('extra arguments with a bare "--" are refused before anything is saved; --option=-- is kept (HR1, round 1)', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    expect(await outcome(Promise.resolve().then(() => accounts.addConnection(a.id, { name: 'Dashes', extraArgs: '--verbose -- task' })))).toMatch(/Combwork passes the task after "--"/)
    expect(accounts.allConnections().some((c) => c.name === 'Dashes')).toBe(false)
    const first = baseOf(a.id)
    const was = structuredClone(accounts.getConnection(first))
    expect(await outcome(Promise.resolve().then(() => accounts.updateConnection(first, { extraArgs: '--' })))).toMatch(/Combwork passes the task after "--"/)
    expect(accounts.getConnection(first)).toEqual(was)
    expect(accounts.updateConnection(first, { extraArgs: '--append-system-prompt=--' }).extraArgs).toBe('--append-system-prompt=--')
  })
})

afterAll(async () => {
  accounts.stopAccountWatches()
  advanced.stop()
  await disposeWorkspaceService(w)
})

describe("HI-2670 (HR3 on s45): an agent's change to Independent is checked at its file's save, under the board's lock", () => {
  // Another caller's board write: run in the test's own context, never inside the change's own write (whose board lock
  // a write there would join, as a change made inside another is part of it).
  const outside = AsyncResource.bind(<T>(fn: () => T): T => fn())
  it('a change that looked like none is refused when the agent was made a builder meanwhile (and given a card)', async () => {
    const p = join(wsPath, 'api1')
    await here(() => w.updateAgent(p, 'k', { workflowRole: 'independent' }))
    const actualUpdate = w.updateAgent.bind(w)
    const tasks = await import('../src/main/tasks')
    let carding: Promise<unknown> | null = null
    const spy = vi.spyOn(w, 'updateAgent').mockImplementationOnce(async (host, id, patch, check) => {
      // Another save makes it a builder, and a card is given to it, while this change waits for its project's lock.
      await actualUpdate(host, id, { workflowRole: 'builder' })
      carding = outside(() => here(() => tasks.createTask({ title: 'Given meanwhile', project: 'api1', agent: 'k', column: 'doing' }, { kind: 'user' })))
      return actualUpdate(host, id, patch, check)
    })
    try {
      await expect(here(() => updateAgent(p, 'k', { workflowRole: 'independent' }))).rejects.toThrow(/changed meanwhile/)
      expect((await w.projectConfig(p)).agents?.find((x) => x.id === 'k')?.workflowRole).toBe('builder')
    } finally {
      spy.mockRestore()
      await carding
    }
  })

  it('no card is given to it while its file is saved: the board waits for the save', async () => {
    const p = join(wsPath, 'alpha')
    await here(() => w.updateAgent(p, 'a-one', { workflowRole: 'builder' }))
    const tasks = await import('../src/main/tasks')
    let carding: Promise<unknown> | null = null
    // The role saved in project.json when the card was given: Independent only if the board waited for the save.
    let roleWhenGiven: unknown = null
    configTestHooks.beforeConfigWrite = async (written) => {
      if (written !== p || carding) return
      const state = { given: false }
      carding = outside(() => here(() => tasks.createTask({ title: 'Given during the save', project: 'alpha', agent: 'a-one', column: 'doing' }, { kind: 'user' }))).then(() => {
        state.given = true
        roleWhenGiven = (JSON.parse(readFileSync(join(p, '.combwork', 'project.json'), 'utf8')) as { agents: { id: string; workflowRole?: string }[] }).agents.find((x) => x.id === 'a-one')?.workflowRole
      })
      // The save goes on once the card is given, or once its write waits for the board's lock (counted with this
      // change's own): HR3's probe, which gave it during the save, without waiting on a lock the save holds.
      const until = Date.now() + HUNG_MS
      while (!state.given && writesAt(wsPath) < 2 && Date.now() < until) await new Promise((r) => setImmediate(r))
    }
    try {
      await here(() => updateAgent(p, 'a-one', { workflowRole: 'independent' }))
      await carding
      // Given once the save was in place, never while it was being made with nothing to confirm.
      expect(roleWhenGiven).toBe('independent')
    } finally {
      configTestHooks.beforeConfigWrite = undefined
      await here(() => w.updateAgent(p, 'a-one', { workflowRole: 'builder' }))
    }
  })
})

describe('HI-2670 (HR3 on s46): lock order, and what a change affects read as the file is', () => {
  it('a rename with a role change takes the names lock before the board lock', async () => {
    const p = join(wsPath, 'api1')
    const names = await import('../src/main/agentNames')
    const boards = await import('../src/main/boardStore')
    const actual = names.withAgentNames
    let boardHeldAtNames: boolean | null = null
    const spy = vi.spyOn(names, 'withAgentNames').mockImplementationOnce(async (host, fn) => {
      boardHeldAtNames = boards.inBoardWrite(wsPath)
      return actual(host, fn)
    })
    try {
      await here(() => updateAgent(p, 'k', { name: 'Renamed K', workflowRole: 'reviewer' }))
      expect(boardHeldAtNames).toBe(false)
      expect((await w.projectConfig(p)).agents?.find((x) => x.id === 'k')).toMatchObject({ name: 'Renamed K', workflowRole: 'reviewer' })
    } finally {
      spy.mockRestore()
      await here(() => updateAgent(p, 'k', { name: 'Api K' }))
    }
  })

  it("a project.json being written (its .bak older) refuses turning a connection's tools off, never reading its agents as gone", async () => {
    const account = await signedInConnection('Probe', 'probe@example.com')
    const conn = baseOf(account.id)
    const p = join(wsPath, 'alpha')
    const file = join(p, '.combwork', 'project.json')
    await here(() => w.updateAgent(p, 'a-one', { connection: conn, workflowRole: 'builder' }))
    const tasks = await import('../src/main/tasks')
    const launch = await import('../src/main/connectionLaunch')
    await here(() => tasks.createTask({ title: 'Held while config is unsettled', project: 'alpha', agent: 'a-one', column: 'doing' }, { kind: 'user' }))
    const original = readFileSync(file, 'utf8')
    writeFileSync(`${file}.bak`, JSON.stringify({ version: 2, agents: [] }))
    writeFileSync(file, '{')
    try {
      await expect(launch.setConnectionLaunch(conn, { tools: false })).rejects.toThrow(/couldn't read which agents, lanes and cards/)
      expect(accounts.getConnection(conn)?.launch).toBeUndefined()
    } finally {
      writeFileSync(file, original)
    }
    // Readable again: it names a-one's card, and asks for confirmation.
    await expect(launch.setConnectionLaunch(conn, { tools: false })).rejects.toThrow(/One \(.*doing\).*confirm: [0-9a-f]+/)
  })
})
