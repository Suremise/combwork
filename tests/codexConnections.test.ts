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
let statusSpy: { mockRestore(): void }

beforeAll(async () => {
  advanced.load(join(base, 'profile'))
  await advanced.set(ACCOUNTS_PREVIEW, true)
  mkdirSync(join(kept, '..'), { recursive: true })
  writeFileSync(kept, '{"kept":true}\n')
  config.settings.providers.codex.enabled = true
  providerService.info = ((id: string) => ({ provider: id, found: true, path: 'codex.exe' })) as never
  statusSpy = vi.spyOn(provider('codex'), 'accountStatus').mockImplementation(async (_exe, env) => {
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

/** A stand-in for Codex in a folder of its own: a .cmd launcher (run through cmd.exe, as a non-shim .cmd is) for a script. */
function fakeCli(name: string, script: string): string {
  const dir = join(base, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'fake.cjs'), script)
  const cmd = join(dir, 'codex.cmd')
  writeFileSync(cmd, `@"${process.execPath}" "${join(dir, 'fake.cjs')}" %*\r\n`)
  return cmd
}
/** Whether a process is still running (signal 0 asks, it ends nothing). */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("a Codex launch's preflights on a connection (HR6's round 1, finding 1)", () => {
  // Each call recorded: its arguments, its CODEX_HOME, and whether it got a login variable.
  const log = join(base, 'preflight-calls.jsonl')
  const cmd = fakeCli('preflight-cli', `
const fs = require('fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, home: process.env.CODEX_HOME || null, token: !!process.env.CODEX_ACCESS_TOKEN }) + '\\n')
if (args[0] === '--version') { console.log('codex-cli 0.164.0-preflight'); process.exit(0) }
if (args.includes('prompt-input')) { process.stdout.write(JSON.stringify([{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'base' }] }])); process.exit(0) }
if (args[0] === 'app-server') {
  let buf = ''
  process.stdin.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
      if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n')
      else if (m.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { data: [] } }) + '\\n')
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
`)
  it("runs each in the launch's own environment and with the connection's overrides, never Hive's home or token", async () => {
    const conn = join(base, 'profile', 'accounts', 'a-preflight')
    mkdirSync(conn, { recursive: true })
    const cwd = join(base, 'preflight-project')
    mkdirSync(cwd, { recursive: true })
    const env = withoutAccountEnv(codex, { ...(process.env as Record<string, string>), CODEX_HOME: conn, CODEX_ACCESS_TOKEN: 'made-up' })
    process.env.CODEX_ACCESS_TOKEN = 'made-up-in-hive'
    try {
      await codex.prepareLaunch({ projectPath: cwd, agentId: 'a-1', executable: cmd, cwd, workspacePath: cwd, runId: 'r-pre', sessionId: '00000000-0000-4000-8000-000000000001', resume: false, name: '', skills: [], mcpServers: {}, model: null, effort: null, permissionMode: null, extraArgs: [], hookUrl: 'http://127.0.0.1:1/hook?run=r', hookAuthFile: join(cwd, 'auth.txt'), privateDir: cwd, guidance: 'Hive guidance', env, allowBackgroundSessions: false, use200kContext: false, connectionHome: conn } as never)
    } finally {
      delete process.env.CODEX_ACCESS_TOKEN
    }
    const calls = readFileSync(log, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l))
    // The version, the hooks' check and the prompt's render: each on the connection, none with a token.
    expect(calls.map((c) => (c.args[0] === '--version' ? 'version' : c.args[0] === 'app-server' ? 'hooks' : 'prompt'))).toEqual(expect.arrayContaining(['version', 'hooks', 'prompt']))
    for (const c of calls) {
      expect(c.home, JSON.stringify(c.args)).toBe(conn)
      expect(c.token, JSON.stringify(c.args)).toBe(false)
    }
    for (const c of calls.filter((x) => x.args[0] !== '--version')) expect(c.args.join(' '), JSON.stringify(c.args)).toContain(CONNECTION_STORE.join(' '))
  })
})

describe("closing Codex's app server (HR6's round 1, finding 2)", () => {
  /** A server that answers who it is signed in as, starts a child that sleeps, and ignores its stdin closing (`stubborn`). */
  const server = (name: string, stubborn: boolean) => {
    const pids = join(base, `${name}-pids.json`)
    const cmd = fakeCli(name, `
const fs = require('fs')
const { spawn } = require('child_process')
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ server: process.pid, child: child.pid }))
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n')
    else if (m.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { account: { type: 'chatgpt', email: 'one@example.com', planType: 'plus' } } }) + '\\n')
  }
})
process.stdin.on('end', () => { if (!${stubborn}) { child.kill(); process.exit(0) } })
// Its own end, whatever happens, so a failed test leaves nothing running for long.
setTimeout(() => { child.kill(); process.exit(0) }, 60000)
`)
    return { cmd, pids: () => JSON.parse(readFileSync(pids, 'utf8')) as { server: number; child: number } }
  }
  beforeAll(async () => {
    // The real status check (the file's earlier tests fake it), with a short time to close.
    statusSpy.mockRestore()
    await advanced.set('codex.appServer.closeSeconds', 1)
  })
  afterAll(async () => {
    await advanced.set('codex.appServer.closeSeconds', null)
  })
  it('one that ignores its stdin closing, behind a .cmd launcher: ended with its child before the check returns', async () => {
    const s = server('stubborn-cli', true)
    const r = await codex.accountStatus(s.cmd, { ...process.env, CODEX_HOME: join(base, 'stubborn-home') })
    expect(r).toEqual({ ok: true, loggedIn: true, email: 'one@example.com', plan: 'plus' })
    const { server: pid, child } = s.pids()
    expect(alive(pid)).toBe(false)
    expect(alive(child)).toBe(false)
  })
  it('one that ends by itself once its stdin closes: let end, with its child', async () => {
    const s = server('willing-cli', false)
    const r = await codex.accountStatus(s.cmd, { ...process.env, CODEX_HOME: join(base, 'willing-home') })
    expect(r.ok).toBe(true)
    const { server: pid, child } = s.pids()
    expect(alive(pid)).toBe(false)
    expect(alive(child)).toBe(false)
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
