// Codex connections (HI-1757): a CODEX_HOME per connection, its rollouts shared through junctions to sessions\ and
// archived_sessions\, who it's signed in as read from the app server's account answer (the recorded fixture), the
// variables Codex would read as a login left out wherever it runs on a connection, and its launch on the connection's
// folder (its own login store and config, the PC's sandbox). All in this file's temp folders: Codex is never run (its
// status is faked), nothing signs in, and no real home is touched.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { CODEX_DESCRIPTOR } from '../src/shared/codex'
import { acceptable } from '../src/shared/accounts'
import { ACCOUNTS_PREVIEW } from '../src/shared/advanced'
import type { Connection } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-codex-connections-')
const home = join(base, 'codex-home')
const userHome = join(base, 'user-profile')
process.env.HIVE_USER_DATA = join(base, 'profile')
process.env.CODEX_HOME = home
;(electron.app as unknown as { getPath: (n: string) => string }).getPath = (n: string) => (n === 'home' ? userHome : join(base, 'profile'))

const accounts = await import('../src/main/accounts')
const { config } = await import('../src/main/config')
const { advanced } = await import('../src/main/advanced')
const { provider } = await import('../src/main/providers')
const { providerService } = await import('../src/main/providerService')
const { withoutAccountEnv } = await import('../src/main/providers/common')
const seam = await import('../src/main/connectionSeam')
const { CONNECTION_STORE, codex, codexAccountStatus } = await import('../src/main/providers/codex/adapter')

const FIX = join(__dirname, 'fixtures', 'advanced', 'account-read-codex-0.164.0.jsonl')
const FIELDS = { account: 'account', email: 'email', plan: 'planType' }
const kept = join(home, 'sessions', '2026', '10', '24', 'rollout-2026-10-24T03-58-35-01a16bd8-8aa4-7253-ad14-d111a099496e.jsonl')
const folderOf = (a: Connection): string => accounts.accountFolder(a.id)
/** The environment each faked status check was given, by account folder. */
const checked = new Map<string, NodeJS.ProcessEnv>()

beforeAll(async () => {
  advanced.load(join(base, 'profile'))
  await advanced.set(ACCOUNTS_PREVIEW, true)
  mkdirSync(join(kept, '..'), { recursive: true })
  writeFileSync(kept, '{"kept":true}\n')
  config.settings.providers.codex.enabled = true
  providerService.info = ((id: string) => ({ provider: id, found: true, path: 'codex.exe' })) as never
  vi.spyOn(provider('codex'), 'accountStatus').mockImplementation(async (_exe, env) => {
    checked.set(env.CODEX_HOME!, env)
    return { ok: true, loggedIn: true, email: 'one@example.com', plan: 'plus' }
  })
})

afterAll(() => {
  vi.restoreAllMocks()
  rmSync(base, { recursive: true, force: true })
})

describe("what Codex's app server says of a connection's sign-in (the recorded fixture)", () => {
  const [, signedIn, signedOut] = readFileSync(FIX, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l))
  it('signed in: its email and plan, never the account id', () => {
    const s = codexAccountStatus({ ok: true, result: signedIn }, FIELDS)
    expect(s).toEqual({ ok: true, loggedIn: true, email: 'user@example.com', plan: 'prolite' })
    expect(JSON.stringify(s)).not.toContain('00000000-0000-4000-8000-000000000001')
  })
  it('signed out: its account null', () => {
    expect(codexAccountStatus({ ok: true, result: signedOut }, FIELDS)).toEqual({ ok: true, loggedIn: false })
  })
  it('no answer, an error, or an answer without the field: a failed check, never signed out', () => {
    expect(codexAccountStatus({ ok: false, error: 'no answer in 20 s' }, FIELDS)).toEqual({ ok: false, error: 'no answer in 20 s' })
    expect(codexAccountStatus({ ok: true, result: { requiresOpenaiAuth: true } }, FIELDS).ok).toBe(false)
    expect(codexAccountStatus({ ok: true, result: { account: 'x' } }, FIELDS).ok).toBe(false)
    expect(codexAccountStatus({ ok: true, result: null }, FIELDS).ok).toBe(false)
  })
})

describe('the variables Codex would read as a login (withoutAccountEnv)', () => {
  it("are left out on a connection, however they're spelt; the rest kept", () => {
    const env = { PATH: 'C:\\bin', CODEX_HOME: 'C:\\c', CODEX_ACCESS_TOKEN: 't', codex_api_key: 'k', OPENAI_API_KEY: 'o', OPENAI_BASE_URL: 'u' }
    expect(withoutAccountEnv(codex, env)).toEqual({ PATH: 'C:\\bin', CODEX_HOME: 'C:\\c', OPENAI_BASE_URL: 'u' })
    expect(env.CODEX_ACCESS_TOKEN).toBe('t')
  })
  it('kept when not on a connection, or for a CLI without any', () => {
    const env = { CODEX_ACCESS_TOKEN: 't' }
    expect(withoutAccountEnv(null, env)).toBe(env)
    expect(withoutAccountEnv({}, env)).toBe(env)
  })
  it("are left out of a connection's status check", async () => {
    const a = await accounts.addAccount('codex', 'Checked')
    process.env.CODEX_ACCESS_TOKEN = 'made-up'
    try {
      await accounts.checkAccount(a.id)
    } finally {
      delete process.env.CODEX_ACCESS_TOKEN
    }
    const env = checked.get(folderOf(a))
    expect(env?.CODEX_HOME).toBe(folderOf(a))
    expect(Object.keys(env ?? {}).some((k) => /^CODEX_ACCESS_TOKEN$/i.test(k))).toBe(false)
    expect(accounts.getAccount(a.id)?.observed).toMatchObject({ loggedIn: true, email: 'one@example.com', plan: 'plus' })
    await accounts.removeAccount(a.id)
  })
})

describe("a Codex connection's folder", () => {
  it('has CODEX_HOME as its home, and sessions and archived_sessions shared', () => {
    expect(CODEX_DESCRIPTOR.capabilities.connections).toEqual({ homeEnv: 'CODEX_HOME', shared: ['sessions', 'archived_sessions'], userHome: '.codex', orgs: false })
  })
  it('takes on a sign-in by its email alone (Codex names no organisation); Claude Code still needs both', () => {
    const o = { at: 'now', loggedIn: true as const, email: 'one@example.com', plan: 'plus' }
    expect(acceptable(o, false)).toEqual({ email: 'one@example.com', orgId: '' })
    expect(acceptable(o)).toBeNull()
    expect(acceptable({ ...o, email: undefined }, false)).toBeNull()
    expect(acceptable({ ...o, loggedIn: false }, false)).toBeNull()
  })
  it("links both to the CLI home's (a missing archived_sessions made, empty); its rollouts read through the link", async () => {
    rmSync(join(home, 'archived_sessions'), { recursive: true, force: true })
    const a = await accounts.addAccount('codex', 'ChatGPT · Work')
    expect(a).toMatchObject({ provider: 'codex', kind: 'signIn', name: 'ChatGPT · Work' })
    for (const name of ['sessions', 'archived_sessions']) expect(lstatSync(join(folderOf(a), name)).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(home, 'archived_sessions')).isDirectory()).toBe(true)
    expect(readFileSync(join(folderOf(a), 'sessions', '2026', '10', '24', 'rollout-2026-10-24T03-58-35-01a16bd8-8aa4-7253-ad14-d111a099496e.jsonl'), 'utf8')).toContain('kept')
    await accounts.removeAccount(a.id)
  })
  it('removed: both junctions first, then the folder with its login; the rollouts stay', async () => {
    const a = await accounts.addAccount('codex', 'Gone')
    writeFileSync(join(folderOf(a), 'auth.json'), '{}')
    writeFileSync(join(home, 'archived_sessions', 'archived.jsonl'), 'archived\n')
    await accounts.removeAccount(a.id)
    expect(existsSync(folderOf(a))).toBe(false)
    expect(readFileSync(kept, 'utf8')).toContain('kept')
    expect(readFileSync(join(home, 'archived_sessions', 'archived.jsonl'), 'utf8')).toBe('archived\n')
  })
  it('watches auth.json as its login file, never reading it', () => {
    expect(codex.accountLoginFile('auth.json')).toBe(true)
    expect(codex.accountLoginFile('config.toml')).toBe(false)
  })
})

describe('the test seam for Codex', () => {
  const env = (o: Record<string, string | undefined>) => ({ HIVE_USER_DATA: 'x', HIVE_TEST_CLI_HOME_CONNECTION: '1', ...o })
  it("is never on the user's own ~/.codex (the CLI's home the variable is), on a test home it is", () => {
    expect(seam.testHomeSeam('CODEX_HOME', env({ CODEX_HOME: join(userHome, '.codex') }), false)).toBe(false)
    expect(seam.testHomeSeam('CODEX_HOME', env({ CODEX_HOME: home }), false)).toBe(true)
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({ CLAUDE_CONFIG_DIR: join(userHome, '.claude') }), false)).toBe(false)
  })
})

describe('a Codex launch on a connection', () => {
  const conn = join(base, 'profile', 'accounts', 'a-launch')
  const ctx = {
    projectPath: base, agentId: 'a-1', executable: 'C:\\bin\\codex.exe', cwd: base, workspacePath: base, runId: 'r', sessionId: '00000000-0000-4000-8000-000000000000',
    resume: false, name: '', skills: [], mcpServers: {}, model: null, effort: null, permissionMode: null, extraArgs: [], hookUrl: 'http://127.0.0.1:1/hook?run=r', hookAuthFile: 'C:/hive/hook-auth/r.txt', privateDir: 'C:/hive/launches/r', guidance: '', env: {}, allowBackgroundSessions: false, use200kContext: false
  }
  beforeAll(() => {
    mkdirSync(conn, { recursive: true })
    writeFileSync(join(home, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  })
  const sandboxArg = (args: string[]): string | undefined => args.find((a) => a.startsWith('windows.sandbox='))
  it("keeps its login in its own folder, and takes the PC's Windows sandbox", () => {
    const { args } = codex.buildCommand(ctx.executable, { ...ctx, connectionHome: conn })
    expect(args.join(' ')).toContain(CONNECTION_STORE.join(' '))
    if (process.platform === 'win32') expect(sandboxArg(args)).toBe('windows.sandbox="unelevated"')
  })
  it("the connection's own config naming a sandbox: that one, nothing passed", () => {
    writeFileSync(join(conn, 'config.toml'), 'model = "gpt-own"\n\n[windows]\nsandbox = "elevated"\n')
    expect(sandboxArg(codex.buildCommand(ctx.executable, { ...ctx, connectionHome: conn }).args)).toBeUndefined()
    // Its own default model, not ~/.codex's.
    expect(codex.configuredDefaultModel(conn)).toBe('gpt-own')
    rmSync(join(conn, 'config.toml'))
  })
  it("on Codex's own home: as before, no store or sandbox passed", () => {
    const { args } = codex.buildCommand(ctx.executable, ctx)
    expect(args.join(' ')).not.toContain('cli_auth_credentials_store')
    expect(sandboxArg(args)).toBeUndefined()
  })
  it("signs in with Codex's own login, kept in the connection's folder", () => {
    expect(codex.accountLoginCommand('C:\\bin\\codex.exe').args).toEqual(['login', ...CONNECTION_STORE])
    expect(codex.loginCommand('C:\\bin\\codex.exe').args).toEqual(['login'])
  })
  it("opens a connection's AGENTS.md and skills, as Codex's own home's, and nothing else of it", () => {
    expect(codex.fileAllowed(join(conn, 'AGENTS.md'), true, [conn])).toBe(true)
    expect(codex.fileAllowed(join(conn, 'skills', 'x', 'SKILL.md'), false, [conn])).toBe(true)
    expect(codex.fileAllowed(join(conn, 'auth.json'), false, [conn])).toBe(false)
    expect(codex.fileAllowed(join(home, 'AGENTS.md'), true, [conn])).toBe(false)
    expect(codex.skillRoots(conn).machine).toEqual([join(conn, 'skills')])
  })
})
