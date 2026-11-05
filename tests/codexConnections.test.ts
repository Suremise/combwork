// Codex connections (HI-1757): a CODEX_HOME per connection, its rollouts shared through junctions to sessions\ and
// archived_sessions\, who it's signed in as read from the app server's account answer (the recorded fixture), the
// variables Codex would read as a login left out wherever it runs on a connection, and its launch on the connection's
// folder (its own login store and config, the PC's sandbox). All in this file's temp folders: Codex is never run (its
// status is faked), nothing signs in, and no real home is touched.
import { spawn } from 'child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { CODEX_DESCRIPTOR } from '../src/shared/codex'
import { acceptable } from '../src/shared/accounts'
import type { Account } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-codex-connections-')
const home = join(base, 'codex-home')
const userHome = join(base, 'user-profile')
process.env.CW_USER_DATA = join(base, 'profile')
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
const { codexCheckHeld, codexCheckSeams, resetCodexChecksForTests, stopCodexChecks } = await import('../src/main/codexChecks')
const { queueHost } = await import('../src/main/workflow/queueJobs')
const { windowsProbe } = await import('../src/main/workflow/queueProcs')
type Listed = import('../src/main/workflow/queueProcs').Listed

// Child processes get the run context's allowlisted environment (tests/e2e/runContext.cjs), never this shell's.
const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 30_000
// Codex's checks run on a real process supervisor of the tests' own (as the merge queue's tests), in this file's folder.
const sharedHost = queueHost()
codexCheckSeams.host = sharedHost

const FIX = join(__dirname, 'fixtures', 'advanced', 'account-read-codex-0.164.0.jsonl')
const FIELDS = { account: 'account', email: 'email', plan: 'planType' }
const kept = join(home, 'sessions', '2026', '10', '24', 'rollout-2026-10-24T03-58-35-01a16bd8-8aa4-7253-ad14-d111a099496e.jsonl')
const folderOf = (a: Account): string => accounts.accountFolder(a.id)
/** The environment each faked status check was given, by account folder. */
const checked = new Map<string, NodeJS.ProcessEnv>()
let statusSpy: { mockRestore(): void }

beforeAll(async () => {
  advanced.load(join(base, 'profile'))
  mkdirSync(join(kept, '..'), { recursive: true })
  writeFileSync(kept, '{"kept":true}\n')
  config.settings.providers.codex.enabled = true
  providerService.info = ((id: string) => ({ provider: id, found: true, path: 'codex.exe' })) as never
  statusSpy = vi.spyOn(provider('codex'), 'accountStatus').mockImplementation(async (_exe, env) => {
    checked.set(env.CODEX_HOME!, env)
    return { ok: true, loggedIn: true, email: 'one@example.com', plan: 'plus' }
  })
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
    // Its Set Up wording (HI-1870's setUp) aside; no trustInherits: a trusted folder above a repository doesn't cover it (HI-1871).
    expect(CODEX_DESCRIPTOR.capabilities.connections).toMatchObject({ homeEnv: 'CODEX_HOME', shared: ['sessions', 'archived_sessions'], userHome: '.codex', orgs: false })
    expect(CODEX_DESCRIPTOR.capabilities.connections?.trustInherits).toBeUndefined()
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
  const env = (o: Record<string, string | undefined>) => ({ CW_USER_DATA: 'x', CW_TEST_CLI_HOME_CONNECTION: '1', ...o })
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
/** Each process a helper started, with when it said it started (pidsFiles), and each identified while running: the teardown's. */
const pidsFiles: string[] = []
const identified: Listed[] = []
async function identify(pid: number): Promise<Listed> {
  const p = await vi.waitFor(
    async () => {
      const found = (await windowsProbe.list())?.find((x) => x.pid === pid)
      if (!found) throw new Error(`process ${pid} isn't listed yet`)
      return found
    },
    { timeout: HUNG_MS, interval: 200 }
  )
  identified.push(p)
  return p
}
const running = (p: Listed): Promise<boolean | null> => windowsProbe.alive(p.pid, p.started)
/** A process that sleeps (detached, hidden, the tests' allowlisted environment). */
async function sleeper(): Promise<Listed> {
  const k = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', detached: true, windowsHide: true, env: baseEnv() })
  k.unref()
  return identify(k.pid!)
}
/** Waits for a condition, bounded only against a hang. */
const until = (fn: () => Promise<boolean> | boolean): Promise<void> => vi.waitFor(async () => expect(await fn()).toBe(true), { timeout: HUNG_MS, interval: 200 })

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
  it("runs each in the launch's own environment and with the connection's overrides, never Combwork's home or token", async () => {
    const conn = join(base, 'profile', 'accounts', 'a-preflight')
    mkdirSync(conn, { recursive: true })
    const cwd = join(base, 'preflight-project')
    mkdirSync(cwd, { recursive: true })
    // The launch's environment as Combwork makes it: the allowlist, the connection's home, the login variables left out.
    const env = withoutAccountEnv(codex, { ...baseEnv(), CODEX_HOME: conn, CODEX_ACCESS_TOKEN: 'made-up' })
    // And a token in Combwork's own, which none of them may get.
    const before = process.env.CODEX_ACCESS_TOKEN
    process.env.CODEX_ACCESS_TOKEN = 'made-up-in-hive'
    try {
      await codex.prepareLaunch({ projectPath: cwd, agentId: 'a-1', executable: cmd, cwd, workspacePath: cwd, runId: 'r-pre', sessionId: '00000000-0000-4000-8000-000000000001', resume: false, name: '', skills: [], mcpServers: {}, model: null, effort: null, permissionMode: null, extraArgs: [], hookUrl: 'http://127.0.0.1:1/hook?run=r', hookAuthFile: join(cwd, 'auth.txt'), privateDir: cwd, guidance: 'Combwork guidance', env, allowBackgroundSessions: false, use200kContext: false, connectionHome: conn } as never)
    } finally {
      if (before === undefined) delete process.env.CODEX_ACCESS_TOKEN
      else process.env.CODEX_ACCESS_TOKEN = before
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
  it("with Advanced's non-admin sandbox on (HI-1893): the hooks' check and the prompt's render pass it too", async () => {
    const conn = join(base, 'profile', 'accounts', 'a-preflight-unelevated')
    mkdirSync(conn, { recursive: true })
    const cwd = join(base, 'preflight-project-unelevated')
    mkdirSync(cwd, { recursive: true })
    await advanced.set('codex.accounts.unelevatedSandbox', true)
    try {
      await codex.prepareLaunch({ projectPath: cwd, agentId: 'a-1', executable: cmd, cwd, workspacePath: cwd, runId: 'r-pre-u', sessionId: '00000000-0000-4000-8000-000000000002', resume: false, name: '', skills: [], mcpServers: {}, model: null, effort: null, permissionMode: null, extraArgs: [], hookUrl: 'http://127.0.0.1:1/hook?run=r', hookAuthFile: join(cwd, 'auth.txt'), privateDir: cwd, guidance: 'Combwork guidance', env: withoutAccountEnv(codex, { ...baseEnv(), CODEX_HOME: conn }), allowBackgroundSessions: false, use200kContext: false, connectionHome: conn } as never)
    } finally {
      await advanced.set('codex.accounts.unelevatedSandbox', false)
    }
    const calls = readFileSync(log, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l)).filter((c) => c.home === conn && c.args[0] !== '--version')
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.args.includes('windows.sandbox="unelevated"'), JSON.stringify(c.args)).toBe(process.platform === 'win32')
  })
})

describe("Codex's checks owned from before they run until their end is confirmed (round 4: s91, s93)", () => {
  /**
   * A server that answers who it is signed in as (`answers`: else never) and starts a child; `stubborn`: it ignores its
   * stdin closing. Its and its child's pids and starts go to a file the teardown reads.
   */
  const server = (name: string, o: { stubborn?: boolean; answers?: boolean } = {}) => {
    const pids = join(base, `${name}-pids.json`)
    pidsFiles.push(pids)
    const cmd = fakeCli(name, `
const fs = require('fs')
const { spawn } = require('child_process')
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true, env: { SystemRoot: process.env.SystemRoot || '', PATH: process.env.PATH || '' } })
fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify([{ pid: process.pid, at: Date.now() }, { pid: child.pid, at: Date.now() }]))
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n')
    else if (m.id === 2 && ${o.answers !== false}) process.stdout.write(JSON.stringify({ id: 2, result: { account: { type: 'chatgpt', email: 'one@example.com', planType: 'plus' } } }) + '\\n')
  }
})
process.stdin.on('end', () => { if (!${!!o.stubborn}) { child.kill(); process.exit(0) } })
`)
    return {
      cmd,
      started: () => existsSync(pids),
      /** Its server's and child's pids still running, from one listing. */
      left: async (): Promise<number[]> => {
        if (!existsSync(pids)) return []
        const ps = JSON.parse(readFileSync(pids, 'utf8')) as { pid: number; at: number }[]
        const list = (await windowsProbe.list()) ?? []
        return ps.filter((x) => list.some((p) => p.pid === x.pid && Math.abs(p.started - x.at) < 3000)).map((x) => x.pid)
      }
    }
  }
  const homeOf = (n: string): string => join(base, 'profile', 'accounts', n)
  const status = (cmd: string, folder: string) => codex.accountStatus(cmd, { ...baseEnv(), CODEX_HOME: folder })
  const ID = { ok: true, loggedIn: true, email: 'one@example.com', plan: 'plus' }
  /** The test supervisor, with its `hasjob` answer replaced while `unknown` is set (a supervisor that can't tell), and slowed by `slow` ms. */
  const flaky = { unknown: false, slow: 0 }
  const doubtful = new Proxy(sharedHost, {
    get(target, prop) {
      if (prop === 'request')
        return async (command: string, ...rest: (number | string | undefined)[]) => {
          if (command === 'hasjob' && flaky.slow) await new Promise((res) => setTimeout(res, flaky.slow))
          if (command === 'hasjob' && flaky.unknown) return 'unknown: 5'
          return target.request(command as never, ...(rest as [string]))
        }
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
  beforeAll(async () => {
    // The real status check (the file's earlier tests fake it), with a short time to close.
    statusSpy.mockRestore()
    await advanced.set('codex.appServer.closeSeconds', 1)
  })
  afterEach(async () => {
    Object.assign(flaky, { unknown: false, slow: 0 })
    for (const k of ['beforeStart', 'afterAssign', 'beforeConfirm', 'onEnd'] as const) codexCheckSeams[k] = undefined
    codexCheckSeams.host = sharedHost
    // Each test ends with nothing held and Combwork not quitting, as a new start.
    await stopCodexChecks()
    resetCodexChecksForTests()
  })

  it('one that ends by itself: the identity, its child gone with it, nothing held', async () => {
    const s = server('willing-cli')
    expect(await status(s.cmd, homeOf('a-willing'))).toEqual(ID)
    expect(await s.left()).toEqual([])
    expect(codexCheckHeld(homeOf('a-willing'))).toBe(false)
  }, 60_000)

  it("with Advanced's non-admin sandbox on (HI-1893): the status check passes it, with the connection's login store", async () => {
    const argsLog = join(base, 'status-args.json')
    const cmd = fakeCli('status-args-cli', `
require('fs').writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)))
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n')
    else if (m.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { account: null } }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
`)
    await advanced.set('codex.accounts.unelevatedSandbox', true)
    try {
      expect(await status(cmd, homeOf('a-status-args'))).toEqual({ ok: true, loggedIn: false })
    } finally {
      await advanced.set('codex.accounts.unelevatedSandbox', false)
    }
    const args = JSON.parse(readFileSync(argsLog, 'utf8')) as string[]
    expect(args.join(' ')).toContain(CONNECTION_STORE.join(' '))
    expect(args.includes('windows.sandbox="unelevated"')).toBe(process.platform === 'win32')
  }, 60_000)

  it('one that ignores its stdin closing, behind a .cmd launcher: its job ends it and its child; the identity only then', async () => {
    const s = server('stubborn-cli', { stubborn: true })
    expect(await status(s.cmd, homeOf('a-stubborn'))).toEqual(ID)
    expect(await s.left()).toEqual([])
    expect(codexCheckHeld(homeOf('a-stubborn'))).toBe(false)
  }, 60_000)

  it("its supervisor ended between the job's end and its confirmation: confirmed only once no job by its name is left (kill on close), on a new supervisor", async () => {
    const s = server('replaced-cli', { stubborn: true })
    await sharedHost.ensure()
    const before = sharedHost.instance
    // After the job's end: its supervisor ends, as a crash would (Windows closes its jobs, kill on close).
    codexCheckSeams.beforeConfirm = async () => {
      const sup = await identify(sharedHost.pid!)
      await windowsProbe.end([sup])
      await until(async () => (await running(sup)) === false)
    }
    expect(await status(s.cmd, homeOf('a-replaced'))).toEqual(ID)
    expect(await s.left()).toEqual([])
    expect(sharedHost.instance).not.toBe(before)
    expect(codexCheckHeld(homeOf('a-replaced'))).toBe(false)
  }, 90_000)

  it("an end its supervisor can't confirm: a failed check, the connection held (sign-in, removal and checks refused); a later check confirms it, then runs", async () => {
    const a = await accounts.addAccount('codex', 'Held')
    const folder = accounts.accountFolder(a.id)
    const s = server('held-cli')
    codexCheckSeams.host = doubtful
    flaky.unknown = true
    expect(await status(s.cmd, folder)).toEqual({ ok: false, error: "couldn't end Codex's check" })
    expect(codexCheckHeld(folder)).toBe(true)
    await expect(accounts.removeAccount(a.id)).rejects.toThrow(/is being checked/)
    await expect(accounts.signInAccount(a.id)).rejects.toThrow(/is being checked/)
    // Still can't be told: refused, nothing spawned.
    expect(await status(s.cmd, folder)).toEqual({ ok: false, error: "its last check of Codex hasn't ended yet" })
    // Once it can: the old end is confirmed (no job by its name left), and the check runs.
    flaky.unknown = false
    expect(await status(s.cmd, folder)).toEqual(ID)
    expect(codexCheckHeld(folder)).toBe(false)
    expect(await s.left()).toEqual([])
    await accounts.removeAccount(a.id)
  }, 90_000)

  it('a process of the check that leaves its job (ended by the supervisor, unconfirmed): a failed check, held until Combwork restarts', async () => {
    const s = server('escaped-cli')
    const k = await sleeper()
    // The supervisor told to follow a process for the check's job, which has no journal: it ends it and says "unowned".
    codexCheckSeams.afterAssign = async (job) => void expect(await job.follow(k.pid)).toBe(false)
    const escaped = { ok: false, error: "a process Codex started left Combwork's job: its end can't be confirmed" }
    expect(await status(s.cmd, homeOf('a-escaped'))).toEqual(escaped)
    expect(codexCheckHeld(homeOf('a-escaped'))).toBe(true)
    await until(async () => (await running(k)) === false)
    // Its job's own end confirmed, yet never released: the next check is refused the same way.
    codexCheckSeams.afterAssign = undefined
    expect(await status(s.cmd, homeOf('a-escaped'))).toEqual(escaped)
    expect(await s.left()).toEqual([])
    // A restart releases the hold: not a confirmation that the escaped branch ended (the preview limit accepted on HI-1757/r94).
    resetCodexChecksForTests()
    expect(codexCheckHeld(homeOf('a-escaped'))).toBe(false)
  }, 90_000)

  it('a check held before its supervisor starts, then quit: nothing is launched after the quit', async () => {
    const s = server('paused-cli')
    let go!: () => void
    const gate = new Promise<void>((res) => (go = res))
    codexCheckSeams.beforeStart = () => gate
    const check = status(s.cmd, homeOf('a-paused'))
    // The quit sets its guard at once; the check, let go after it, must start nothing.
    const stopping = stopCodexChecks()
    go()
    await stopping
    expect(await check).toMatchObject({ ok: false })
    expect(s.started()).toBe(false)
    expect(codexCheckHeld(homeOf('a-paused'))).toBe(false)
  }, 60_000)

  it('a check waiting for its answer, then quit: the quit ends it and its child before it returns', async () => {
    const s = server('waiting-cli', { stubborn: true, answers: false })
    const check = status(s.cmd, homeOf('a-waiting'))
    await until(() => s.started())
    await until(async () => (await s.left()).length === 2)
    await stopCodexChecks()
    expect(await s.left()).toEqual([])
    expect(await check).toEqual({ ok: false, error: 'Combwork is quitting' })
    expect(codexCheckHeld(homeOf('a-waiting'))).toBe(false)
  }, 60_000)

  it("a held check's retry under way when Combwork quits: the quit's end runs after it, never beside it", async () => {
    const s = server('retry-cli')
    codexCheckSeams.host = doubtful
    flaky.unknown = true
    expect(await status(s.cmd, homeOf('a-retry'))).toMatchObject({ ok: false })
    let inFlight = 0
    let most = 0
    codexCheckSeams.onEnd = (phase) => {
      inFlight += phase === 'in' ? 1 : -1
      most = Math.max(most, inFlight)
    }
    // A later check retries the old end, slowly (the supervisor slow to answer); Combwork quits meanwhile.
    flaky.slow = 1500
    const retry = status(s.cmd, homeOf('a-retry'))
    await until(() => inFlight === 1)
    await stopCodexChecks()
    await retry
    expect(most).toBe(1)
  }, 90_000)

  it('no supervisor, or a launcher whose command is missing: a failed check, nothing held', async () => {
    codexCheckSeams.host = { ensure: async () => false } as never
    expect(await status(fakeCli('unused-cli', ''), homeOf('a-nohost'))).toEqual({ ok: false, error: "Combwork can't own Codex's check here (its process tracking is off)" })
    expect(codexCheckHeld(homeOf('a-nohost'))).toBe(false)
    codexCheckSeams.host = sharedHost
    const r = await status(join(base, 'no-such-codex.exe'), homeOf('a-nostart'))
    expect(r.ok).toBe(false)
    expect(codexCheckHeld(homeOf('a-nostart'))).toBe(false)
  }, 60_000)
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
  it("Advanced's non-admin sandbox (HI-1893): on, every launch on a connection and its Set Up pass it over the PC's; never on Codex's own home, nor over the connection's own; off, the PC's again", async () => {
    writeFileSync(join(home, 'config.toml'), '[windows]\nsandbox = "elevated"\n')
    const win = process.platform === 'win32'
    try {
      expect(sandboxArg(codex.buildCommand(ctx.executable, { ...ctx, connectionHome: conn }).args)).toBe(win ? 'windows.sandbox="elevated"' : undefined)
      await advanced.set('codex.accounts.unelevatedSandbox', true)
      expect(sandboxArg(codex.buildCommand(ctx.executable, { ...ctx, connectionHome: conn }).args)).toBe(win ? 'windows.sandbox="unelevated"' : undefined)
      expect(codex.connectionSetUpArgs(conn)).toEqual([...CONNECTION_STORE, ...(win ? ['-c', 'windows.sandbox="unelevated"'] : [])])
      expect(await codex.connectionSetUp(conn)).toBe(true)
      // Codex's own home: as it is configured, nothing passed.
      expect(sandboxArg(codex.buildCommand(ctx.executable, ctx).args)).toBeUndefined()
      // The connection's own choice wins.
      writeFileSync(join(conn, 'config.toml'), '[windows]\nsandbox = "elevated"\n')
      expect(sandboxArg(codex.buildCommand(ctx.executable, { ...ctx, connectionHome: conn }).args)).toBeUndefined()
      expect(codex.connectionSetUpArgs(conn)).toEqual(CONNECTION_STORE)
      rmSync(join(conn, 'config.toml'))
      // Nothing is written to either config.
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('[windows]\nsandbox = "elevated"\n')
      expect(existsSync(join(conn, 'config.toml'))).toBe(false)
      await advanced.set('codex.accounts.unelevatedSandbox', false)
      expect(sandboxArg(codex.buildCommand(ctx.executable, { ...ctx, connectionHome: conn }).args)).toBe(win ? 'windows.sandbox="elevated"' : undefined)
    } finally {
      await advanced.set('codex.accounts.unelevatedSandbox', false)
      writeFileSync(join(home, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
    }
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

// The file's one teardown, run however its tests ended (an assertion or a check that threw included): Codex's checks
// stopped and forgotten; every process a helper started ended exactly (those identified, and each fake server and its
// child by the pid and start it wrote) and seen gone; the test supervisor closed; then the temp tree removed.
afterAll(async () => {
  await stopCodexChecks().catch(() => undefined)
  resetCodexChecksForTests()
  const list = (await windowsProbe.list()) ?? []
  const fromFiles = pidsFiles.filter((f) => existsSync(f)).flatMap((f) => JSON.parse(readFileSync(f, 'utf8')) as { pid: number; at: number }[])
  const helpers = [...identified, ...fromFiles.flatMap((x) => list.filter((p) => p.pid === x.pid && Math.abs(p.started - x.at) < 3000))].filter((p) => list.some((q) => q.pid === p.pid && q.started === p.started))
  await windowsProbe.end(helpers)
  await sharedHost.close()
  await vi.waitFor(async () => {
    for (const p of helpers) expect(await running(p), `helper ${p.pid} still running`).toBe(false)
  }, { timeout: HUNG_MS, interval: 200 })
  vi.restoreAllMocks()
  rmSync(base, { recursive: true, force: true })
}, 90_000)
