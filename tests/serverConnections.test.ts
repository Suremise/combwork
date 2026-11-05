// Server connections (HI-1772): a connection that gets its model from a server by a base URL, with a key or none. Its key
// stored encrypted in the key store alone (one write per change, one lock for the whole file, no .bak), never in config;
// refused where it can't be kept safely or appears in another field; bound to its server's origin; decrypted for a
// launch's environment (masked while used); a keyless launch only for this PC's server; its models read from the server
// when asked (bounded, redirects refused, a stale reply dropped). Dummy keys only, in this file's temp folders; the CLI
// is never run and nothing signs in.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { createServer, type Server, type ServerResponse } from 'http'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-servers-')
const home = join(base, 'claude-home')
const userHome = join(base, 'user-profile')
const profile = join(base, 'profile')
process.env.CW_USER_DATA = profile
process.env.CLAUDE_CONFIG_DIR = home
delete process.env.CW_TEST_CLI_HOME_CONNECTION
;(electron.app as unknown as { getPath: (n: string) => string }).getPath = (n: string) => (n === 'home' ? userHome : profile)
const safe = (electron as unknown as { safeStorage: { available: boolean } }).safeStorage
// Set Up's terminal recorded, not started: its key and environment, and its end (HI-1772 round 1).
const spawned = vi.hoisted(() => [] as { key: string; env: Record<string, string | undefined>; onExit?: (code: number) => void }[])
vi.mock('../src/main/ptyHost', async (original) => ({
  ...(await original<object>()),
  spawnPty: (key: string, o: { env: Record<string, string | undefined>; onExit?: (code: number) => void }) => void spawned.push({ key, env: o.env, onExit: o.onExit })
}))

const accounts = await import('../src/main/accounts')
const servers = await import('../src/main/serverConnections')
const keys = await import('../src/main/keyStore')
const { fingerprint, maskDeep, maskKeys, maskingState, resetMaskingForTests } = await import('../src/main/keyMatcher')
const { logLine } = await import('../src/main/logger')
const { saveCapture } = await import('../src/main/consoleRecorder')
const coverage = await import('../src/main/keyCoverage')
const { config } = await import('../src/main/config')
const { advanced } = await import('../src/main/advanced')
const { provider } = await import('../src/main/providers')
const { providerService } = await import('../src/main/providerService')
const { withoutAccountEnv, withServerEnv } = await import('../src/main/providers/common')
const { createWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { providerDescriptor } = await import('../src/shared/providers')
const { legacyLaunchSettings: agentLaunchSettings } = await import('../src/shared/connectionDefaults')

// Dummy keys shaped so no other masking rule catches them: only the key matcher can.
const KEY = 'Zq!7#mP2&vL9^tR4~wX8'
const KEY2 = 'Hn%3*bQ6(kD1)yU5+eW2'
const HUNG_MS = 10_000
const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)
const keyFile = join(profile, 'connection-keys.json')

const wsPath = join(base, 'ws')
let w: ReturnType<typeof createWorkspaceService>
const here = <T>(fn: () => T): T => inWorkspace(w, fn)

beforeAll(async () => {
  advanced.load(profile)
  mkdirSync(join(home, 'projects'), { recursive: true })
  mkdirSync(join(userHome, '.claude'), { recursive: true })
  mkdirSync(join(wsPath, 'alpha', '.combwork'), { recursive: true })
  writeFileSync(join(wsPath, 'alpha', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One' }] }))
  config.settings.providers['claude-code'].enabled = true
  providerService.info = ((id: string) => ({ provider: id, found: true, path: 'claude.exe' })) as never
  vi.spyOn(provider('claude-code'), 'accountStatus').mockImplementation(async () => ({ ok: true, loggedIn: false }))
  w = createWorkspaceService()
  await w.open(wsPath)
})
afterEach(async () => {
  keys.keyStoreTestHooks.beforeWrite = undefined
  safe.available = true
  for (const a of [...(config.get().accounts ?? [])]) await accounts.removeAccount(a.id).catch(() => undefined)
  config.update((c) => {
    c.accounts = []
    c.connections = []
    c.lastUsedConnection = {}
  })
  await w.saveWorkspaceConfigWith(() => ({ connections: undefined, assistantConnection: undefined }))
})

const deepseek = { cli: 'claude-code' as const, name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', preset: 'deepseek', models: [{ id: 'deepseek-flash[1m]', as: ['opus' as const, 'sonnet' as const] }, { id: 'deepseek-flash', as: ['haiku' as const] }], modelsFrom: 'typed' as const }
async function serverOn(input: Partial<Parameters<typeof servers.addServerConnection>[0]> = {}) {
  const a = await servers.addServerConnection({ ...deepseek, ...input })
  await here(() => accounts.setAccountOn(a.id, true))
  return a
}
/** A launch on an account's base connection (HI-2106: an agent names a connection). */
const launch = (account?: string | null) => accounts.connectionForLaunch({ provider: 'claude-code', workspaceConfig: w.config, wanted: account ? (accounts.allConnections().find((c) => c.account === account)?.id ?? account) : account, agentName: 'Builder' })
const store = (): Record<string, { v: number; origin: string; last4: string; blob: string }> => (existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')) : {})
const view = () => here(() => accounts.accountsView())

/** As after a restart: the fingerprints read again from disk, nothing kept in memory. */
async function restart(): Promise<void> {
  coverage.forgetCoverageForTests()
  resetMaskingForTests('pending')
  coverage.startCoverage()
  await coverage.loadCoverage()
}
const fpFile = join(profile, 'key-fingerprints.json')
const marksFile = join(profile, 'key-coverage.json')

// First in this file: before any key is saved in its profile.
describe('a profile that never saved a key (round 2)', () => {
  it('a keyless local server only: nothing masked, no fingerprint file, no safeStorage needed', async () => {
    safe.available = false
    try {
      await serverOn({ name: 'Ollama', preset: 'ollama', baseUrl: 'http://localhost:11434', models: [{ id: 'qwen3:8b', as: ['opus'] }] })
      await restart()
      expect(maskingState()).toEqual({ state: 'none', gap: false })
      expect(existsSync(fpFile)).toBe(false)
      expect(logLine('info', 'x', `plain ${KEY} text`)).toContain(KEY)
      expect(await outcome(coverage.requireMasking())).toBe('ok')
    } finally {
      safe.available = true
    }
  })

  it("before ready, combwork.log's first lines aren't masked; a config.json that can't be read keeps them strict (HI-1855)", async () => {
    const line = "The install folder C:\\Program Files\\Combwork has an app package's entry"
    resetMaskingForTests('pending')
    coverage.startCoverageEarly()
    expect(maskingState().state).toBe('none')
    expect(logLine('warn', 'installDir', line)).toContain(line)
    // Damaged: nothing can be told of it before ready, so strict, as before.
    await config.flush()
    const cfg = join(profile, 'config.json')
    const kept = existsSync(cfg) ? readFileSync(cfg, 'utf8') : null
    writeFileSync(cfg, '{ damaged')
    try {
      resetMaskingForTests('pending')
      coverage.startCoverageEarly()
      expect(maskingState().state).toBe('pending')
      expect(logLine('warn', 'installDir', line)).toContain('<masked>')
    } finally {
      if (kept === null) unlinkSync(cfg)
      else writeFileSync(cfg, kept)
      await restart()
    }
  })
})


describe('a server connection and its key', () => {
  it('added with its key: a server connection with its folder, the key encrypted in the key store alone', async () => {
    const a = await serverOn({ key: KEY })
    expect(a).toMatchObject({ kind: 'server', server: { baseUrl: 'https://api.deepseek.com/anthropic', preset: 'deepseek' } })
    expect(existsSync(join(accounts.accountFolder(a.id), 'projects'))).toBe(true)
    // Not in config (memory or file), not in plain text in the store.
    await config.flush()
    expect(JSON.stringify(config.get())).not.toContain(KEY)
    for (const f of ['config.json', 'config.json.bak']) if (existsSync(join(profile, f))) expect(readFileSync(join(profile, f), 'utf8')).not.toContain(KEY)
    expect(readFileSync(keyFile, 'utf8')).not.toContain(KEY)
    expect(store()[a.id]).toMatchObject({ v: expect.stringMatching(/^[0-9a-f]{24}$/), origin: 'https://api.deepseek.com', last4: KEY.slice(-4) })
    // What a window sees: its last 4 characters, never the key.
    const shown = view().connections.find((c) => c.id === a.id)!
    expect(shown.key).toEqual({ last4: KEY.slice(-4), at: expect.any(String) })
    expect(JSON.stringify(view())).not.toContain(KEY)
    // A sign-in connection's things aren't asked of it.
    expect(await outcome(accounts.signInAccount(a.id))).not.toBe('ok')
    expect(await accounts.checkAccount(a.id)).toBeNull()
  })

  it("Replace: the reply has its last 4 characters only, its version moves on; Remove Key: none", async () => {
    const a = await serverOn({ key: KEY })
    const v1 = store()[a.id].v
    const r = await servers.setServerKey(a.id, KEY2)
    expect(r).toEqual({ last4: KEY2.slice(-4) })
    expect(store()[a.id].v).not.toBe(v1)
    await servers.removeServerKey(a.id)
    expect(store()[a.id]).toBeUndefined()
    expect(view().connections.find((c) => c.id === a.id)!.key).toBeUndefined()
  })

  it('refusals never carry the key: too short, spaces, in its name, URL or a model id; nothing saved', async () => {
    const a = await serverOn()
    for (const bad of ['short-key', 'has spaces in the key!']) {
      const m = await outcome(servers.setServerKey(a.id, bad))
      expect(m).not.toBe('ok')
      expect(m).not.toContain(bad)
    }
    const inName = await outcome(servers.addServerConnection({ ...deepseek, name: `DeepSeek ${KEY}`, key: KEY }))
    expect(inName).toMatch(/appears in the name/)
    expect(inName).not.toContain(KEY)
    // A plain alphanumeric key (allowed by the model ids' characters) found in a model id: refused, nothing added.
    const plain = 'abcdEFGH12345678'
    const inModel = await outcome(servers.addServerConnection({ ...deepseek, models: [{ id: `${plain}xyz` }], key: plain }))
    expect(inModel).toMatch(/appears in the model list/)
    expect(inModel).not.toContain(plain)
    expect(config.get().accounts!.some((c) => c.server?.models.some((m) => m.id === `${plain}xyz`))).toBe(false)
    const inUrl = await outcome(servers.addServerConnection({ ...deepseek, baseUrl: `https://api.example.com/${plain}`, key: plain }))
    expect(inUrl).toMatch(/appears in the base URL/)
    expect(await outcome(servers.addServerConnection({ ...deepseek, baseUrl: 'https://api.example.com/?k=1' }))).toMatch(/query/)
    expect(await outcome(servers.addServerConnection({ ...deepseek, baseUrl: 'http://api.example.com' }))).toMatch(/https/)
  })

  it("Windows' protection unavailable: the key is refused, nothing written", async () => {
    const a = await serverOn()
    safe.available = false
    expect(await outcome(servers.setServerKey(a.id, KEY))).toMatch(/can't store a key safely/)
    expect(store()[a.id]).toBeUndefined()
    // Added with a key it can't keep: added without it, said.
    const b = await servers.addServerConnection({ ...deepseek, name: 'Second', key: KEY })
    expect(b.keyFailed).toBe(true)
    expect(store()[b.id]).toBeUndefined()
  })
})

describe('the key store: one write per change, one lock, no backup', () => {
  it('two connections saving at once, held mid-write in both orders: both keys kept', async () => {
    const a = await serverOn()
    const b = await serverOn({ name: 'Other' })
    for (const order of [[a, b], [b, a]]) {
      let release!: () => void
      let entered!: () => void
      const held = new Promise<void>((r) => (release = r))
      const inWrite = new Promise<void>((r) => (entered = r))
      let first = true
      keys.keyStoreTestHooks.beforeWrite = async () => {
        if (!first) return
        first = false
        entered()
        await held
      }
      const one = servers.setServerKey(order[0].id, KEY)
      await inWrite
      const two = servers.setServerKey(order[1].id, KEY2)
      release()
      await Promise.all([one, two])
      expect(Object.keys(store()).sort()).toEqual([a.id, b.id].sort())
      keys.keyStoreTestHooks.beforeWrite = undefined
    }
  })

  it('a clean-up racing a save keeps the key saved; it drops keys of connections no longer there', async () => {
    const a = await serverOn()
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((r) => (release = r))
    const inWrite = new Promise<void>((r) => (entered = r))
    keys.keyStoreTestHooks.beforeWrite = async () => {
      keys.keyStoreTestHooks.beforeWrite = undefined
      entered()
      await held
    }
    const saving = servers.setServerKey(a.id, KEY)
    await inWrite
    const cleaning = keys.dropKeysExcept(() => new Set(config.get().accounts!.filter((c) => c.kind === 'server').map((c) => c.id)))
    release()
    await Promise.all([saving, cleaning])
    expect(store()[a.id]).toBeDefined()
    // A key whose connection is gone (a config restored from before it): dropped.
    writeFileSync(keyFile, JSON.stringify({ ...store(), 'a-gone0000': { v: '0', origin: 'https://x.example', last4: 'abcd', at: '', blob: 'x' } }))
    expect(await keys.dropKeysExcept(() => new Set([a.id]))).toEqual(['a-gone0000'])
    expect(Object.keys(store())).toEqual([a.id])
  })

  it("a write that fails leaves the store as it was, and the row says what's there", async () => {
    const a = await serverOn({ key: KEY })
    const before = readFileSync(keyFile, 'utf8')
    keys.keyStoreTestHooks.beforeWrite = async () => {
      throw new Error('disk full')
    }
    expect(await outcome(servers.setServerKey(a.id, KEY2))).toMatch(/disk full/)
    expect(await outcome(servers.removeServerKey(a.id))).toMatch(/disk full/)
    expect(readFileSync(keyFile, 'utf8')).toBe(before)
    expect(view().connections.find((c) => c.id === a.id)!.key?.last4).toBe(KEY.slice(-4))
    // Removing the connection: its key first; that failing, nothing is removed, and Remove tries again.
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/key couldn't be deleted/)
    expect(accounts.getAccount(a.id)).toBeDefined()
    keys.keyStoreTestHooks.beforeWrite = undefined
    expect(await outcome(accounts.removeAccount(a.id))).toBe('ok')
    expect(store()[a.id]).toBeUndefined()
    expect(existsSync(`${keyFile}.bak`)).toBe(false)
  })

  it('a damaged store reads as no keys (entered again), and the next save writes it whole', async () => {
    const a = await serverOn({ key: KEY })
    writeFileSync(keyFile, '{ not json')
    expect(await keys.withKey(a.id, 'https://api.deepseek.com')).toBeNull()
    await servers.setServerKey(a.id, KEY2)
    expect(store()[a.id].last4).toBe(KEY2.slice(-4))
  })
})

describe('launching on a server connection', () => {
  it("its environment: the server, its key and each alias's model, set after the variables left out; masked while used", async () => {
    const a = await serverOn({ key: KEY })
    const conn = (await launch(a.id))!
    try {
      expect(conn.server!.env).toEqual({
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: KEY,
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
        CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
        ANTHROPIC_MODEL: 'deepseek-flash[1m]'
      })
      // What this PC's environment had of its own goes first, any spelling.
      const inherited = { PATH: 'x', anthropic_api_key: 'machine-key-000000', ANTHROPIC_BASE_URL: 'https://elsewhere', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-000000000000' }
      const env = withServerEnv(conn.server!.env, withoutAccountEnv(provider('claude-code'), inherited))
      expect(env).toEqual({ PATH: 'x', ...conn.server!.env })
      expect(maskKeys(`token ${KEY}`)).toBe('token <key>')
    } finally {
      conn.release()
    }
  })

  it('no key: refused for a server on another computer; a server on this PC gets the placeholder, nothing inherited', async () => {
    const remote = await serverOn()
    expect(await outcome(launch(remote.id))).toMatch(/has no key/)
    const local = await serverOn({ name: 'Ollama', preset: 'ollama', baseUrl: 'http://localhost:11434', models: [{ id: 'qwen3:8b', as: ['opus'] }] })
    const conn = (await launch(local.id))!
    try {
      expect(conn.server!.env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_AUTH_TOKEN: 'none', ANTHROPIC_MODEL: 'qwen3:8b' })
      const env = withServerEnv(conn.server!.env, withoutAccountEnv(provider('claude-code'), { ANTHROPIC_API_KEY: 'machine-key-000000', ANTHROPIC_AUTH_TOKEN: 'machine-token-0000' }))
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('none')
    } finally {
      conn.release()
    }
  })

  it("this PC's credential, header, route and model variables never reach a launch or Set Up, any spelling (round 1)", async () => {
    const inherited = { ANTHROPIC_CUSTOM_HEADERS: 'X-Api-Key: ambient-dummy-secret', anthropic_default_sonnet_model: 'claude-x', ANTHROPIC_SMALL_FAST_MODEL: 'claude-y', CLAUDE_CODE_SUBAGENT_MODEL: 'claude-z', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1', AWS_BEARER_TOKEN_BEDROCK: 'aws-dummy-0000000', ANTHROPIC_VERTEX_PROJECT_ID: 'p', CLOUD_ML_REGION: 'r' }
    const local = await serverOn({ name: 'Ollama', preset: 'ollama', baseUrl: 'http://localhost:11434', models: [{ id: 'qwen3:8b', as: ['opus'] }] })
    const conn = (await launch(local.id))!
    try {
      const env = withServerEnv(conn.server!.env, withoutAccountEnv(provider('claude-code'), { PATH: 'x', ...inherited }))
      expect(env).toEqual({ PATH: 'x', ...conn.server!.env })
    } finally {
      conn.release()
    }
    // Set Up's terminal: the same, from this process's own environment.
    const was = { ...process.env }
    Object.assign(process.env, inherited)
    try {
      spawned.length = 0
      const remote = await serverOn({ key: KEY })
      await servers.setUpServerConnection(remote.id)
      const env = spawned.at(-1)!.env
      // None of this PC's values: gone, or the connection's own (its subagents' model) in place.
      for (const [k, v] of Object.entries(inherited)) expect(env[k] === undefined || env[k] !== v, k).toBe(true)
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('deepseek-flash')
      expect(env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: KEY, CLAUDE_CONFIG_DIR: accounts.accountFolder(remote.id) })
      // Its key masked, by its fingerprint.
      expect(maskKeys(KEY)).toBe('<key>')
    } finally {
      for (const k of Object.keys(inherited)) if (!(k in was)) delete process.env[k]
    }
  })

  it('no effort or context on a server connection', () => {
    const l = agentLaunchSettings({ provider: 'claude-code', model: 'deepseek-flash', effort: 'high', use200kContext: true }, { providers: {} as never, defaultProvider: 'claude-code' } as never, config.settings, { kind: 'connection', conn: { kind: 'server', defaults: {} } })
    expect(l).toMatchObject({ model: 'deepseek-flash', effort: null, use200kContext: false })
  })

  it("not valid at the last look once its key is replaced or its server moves; a move removes the key in the same step", async () => {
    const a = await serverOn({ key: KEY })
    const conn = (await launch(a.id))!
    try {
      expect(conn.stillValid(a.id)).toBe(true)
      await servers.setServerKey(a.id, KEY2)
      expect(conn.stillValid(a.id)).toBe(false)
    } finally {
      conn.release()
    }
    // A path on the same server keeps the key; another server removes it.
    expect(await servers.editServerConnection(a.id, { baseUrl: 'https://api.deepseek.com/anthropic/v2' })).toEqual({ keyCleared: false })
    expect(store()[a.id]).toBeDefined()
    expect(await servers.editServerConnection(a.id, { baseUrl: 'https://gw.example.com' })).toEqual({ keyCleared: true })
    expect(store()[a.id]).toBeUndefined()
    expect(await outcome(launch(a.id))).toMatch(/has no key/)
  })

  it('a key removed and saved again is another key: a launch prepared on the first is out of date (round 1)', async () => {
    const a = await serverOn({ key: KEY })
    const conn = (await launch(a.id))!
    try {
      await servers.removeServerKey(a.id)
      await servers.setServerKey(a.id, KEY2)
      expect(conn.stillValid(a.id)).toBe(false)
    } finally {
      conn.release()
    }
    // Even with the store emptied (damaged) between: never the same save id twice.
    const before = store()[a.id].v
    writeFileSync(keyFile, '{}')
    await servers.setServerKey(a.id, KEY2)
    expect(store()[a.id].v).not.toBe(before)
  })
})

describe('key coverage: every saved key masked for good (round 2)', () => {
  const A = 'Ab!7#mP2&vL9^tR4~wX8'
  const B = 'Bq%3*bQ6(kD1)yU5+eW2'
  const oldOutput = (k: string) => `## Tool\n\`env\` printed ANTHROPIC_AUTH_TOKEN=${k}\n`
  // One profile for the file: a test that leaves the fingerprints unreadable is followed by a reset (as a user would).
  const readable = async (): Promise<void> => {
    if (maskingState().state === 'unavailable') await keys.resetMasking()
  }
  beforeEach(readable)
  afterAll(readable)

  it("rotated, removed, the connection removed, and a restart: an old session's export still masks the first key, with no key decrypted", async () => {
    const a = await serverOn({ key: A })
    await servers.setServerKey(a.id, B)
    await servers.removeServerKey(a.id)
    await accounts.removeAccount(a.id)
    // Nothing plain in the fingerprint file.
    expect(readFileSync(fpFile, 'utf8')).not.toMatch(/Ab!7|Bq%3|mP2&|kD1\)/)
    await restart()
    expect(maskingState()).toEqual({ state: 'ready', gap: false })
    const decrypt = vi.spyOn(electron.safeStorage, 'decryptString')
    try {
      await coverage.requireMasking()
      for (const k of [A, B]) {
        expect(maskKeys(oldOutput(k))).not.toContain(k.slice(0, 8))
        expect(JSON.parse(JSON.stringify(maskDeep({ comments: [{ text: `key ${k}` }] })))).toEqual({ comments: [{ text: 'key <key>' }] })
        expect(logLine('info', 'x', `said ${k}`, { k })).not.toContain(k.slice(4, 12))
      }
      expect(decrypt).not.toHaveBeenCalled()
    } finally {
      decrypt.mockRestore()
    }
    // Before ready (HI-1855), a profile that saved a key stays strict until its fingerprints are read.
    resetMaskingForTests('pending')
    coverage.startCoverageEarly()
    expect(maskingState().state).toBe('pending')
    await restart()
  })

  it('missing or damaged or undecryptable fingerprints after a key was saved: unavailable, strict everywhere, exports refused before writing, a new key refused', async () => {
    await serverOn({ key: A })
    for (const spoil of [() => writeFileSync(fpFile, '{ damaged'), () => rmSync(fpFile), () => vi.spyOn(electron.safeStorage, 'decryptString').mockImplementationOnce(() => { throw new Error('DPAPI') })]) {
      const keep = readFileSync(fpFile)
      spoil()
      await restart()
      expect(maskingState().state).toBe('unavailable')
      expect(logLine('warn', 'x', `printed ${A}`, { A })).not.toContain(A.slice(0, 8))
      expect(await outcome(coverage.requireMasking())).toMatch(/can't check this for API keys/)
      // A capture isn't written at all.
      const recs = join(profile, 'console-recordings')
      const before = existsSync(recs) ? readdirSync(recs).length : 0
      expect(await outcome(saveCapture({ source: { kind: 'session', label: 'x' }, events: [], trigger: 't', what: 'w', keep: 5 }))).toMatch(/can't check this for API keys/)
      expect(existsSync(recs) ? readdirSync(recs).length : 0).toBe(before)
      const c = await serverOn({ name: `Another ${Math.random()}` })
      expect(await outcome(servers.setServerKey(c.id, B))).toMatch(/can't check this for API keys/)
      writeFileSync(fpFile, keep)
      await restart()
      expect(maskingState().state).toBe('ready')
    }
  })

  it("the markers stand without the key store: lost fingerprints after every key is gone are still unavailable, and a backup of config can't lower them", async () => {
    const a = await serverOn({ key: A })
    await servers.removeServerKey(a.id)
    rmSync(fpFile)
    // The config mirror alone, as after the profile's file was lost; then the file alone, as after config.json's .bak.
    rmSync(marksFile)
    await restart()
    expect(maskingState().state).toBe('unavailable')
    expect(JSON.parse(readFileSync(marksFile, 'utf8'))).toMatchObject({ ever: true })
    config.update((c) => delete c.keyMasking)
    await restart()
    expect(maskingState().state).toBe('unavailable')
    expect(config.get().keyMasking).toMatchObject({ ever: true })
  })

  it('Reset: fingerprints made again from the keys saved now, and strict for good, a new session printing a lost key included, across a restart', async () => {
    const a = await serverOn({ key: A })
    await servers.setServerKey(a.id, B)
    writeFileSync(fpFile, '{ damaged')
    await restart()
    expect(maskingState().state).toBe('unavailable')
    await keys.resetMasking()
    expect(maskingState()).toEqual({ state: 'ready', gap: true })
    // A new session's output, a new comment: A's fingerprint is lost, so every long run is masked.
    expect(maskKeys(`new session ran: cat old.env -> ${A}`)).not.toContain(A.slice(0, 8))
    expect(logLine('info', 'x', `printed ${A}`)).not.toContain(A.slice(0, 8))
    expect(JSON.stringify(maskDeep({ comment: `quoting ${A}` }))).not.toContain(A.slice(0, 8))
    expect(await outcome(coverage.requireMasking())).toBe('ok')
    await restart()
    expect(maskingState()).toEqual({ state: 'ready', gap: true })
    expect(JSON.parse(readFileSync(marksFile, 'utf8'))).toMatchObject({ ever: true, gap: true })
    expect(coverage.coverageView()).toMatchObject({ gap: true, gapSince: expect.any(String) })
  })

  it('past the bound a new key is refused and nothing is dropped; the first key still masked after a restart', async () => {
    try {
      await restart()
      const per = fingerprint({ salt: Buffer.alloc(32), base: 4099 }, A).length
      coverage.setMaxWindowsForTests(coverage.coverageWindows() + per * 2)
      const a = await serverOn({ key: A })
      await servers.setServerKey(a.id, B)
      expect(await outcome(servers.setServerKey(a.id, 'Cz!9#mQ3&vL8^tR5~wY7'))).toMatch(/can't keep masking for another key/)
      expect(store()[a.id].last4).toBe(B.slice(-4))
      await restart()
      expect(maskKeys(oldOutput(A))).not.toContain(A.slice(0, 8))
    } finally {
      coverage.setMaxWindowsForTests(coverage.MAX_WINDOWS)
    }
  })
})

describe("reading a server's models (when asked)", () => {
  let srv: Server
  let port = 0
  const seen: { url: string; auth?: string; encoding?: string }[] = []
  let reply: (res: ServerResponse, url: string) => void = (res) => res.end()
  beforeAll(async () => {
    srv = createServer((req, res) => {
      seen.push({ url: req.url ?? '', ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), encoding: req.headers['accept-encoding'] })
      reply(res, req.url ?? '')
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    port = (srv.address() as { port: number }).port
  })
  afterAll(() => new Promise<void>((r) => srv.close(() => r())))
  const json = (body: unknown, status = 200) => (res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const local = (key?: string) => serverOn({ name: 'Local gateway', preset: undefined, baseUrl: `http://127.0.0.1:${port}`, models: [{ id: 'kept', as: ['opus'] }, { id: 'gone', as: ['haiku'] }], ...(key ? { key } : {}) })

  it('kept: the mappings of models still listed; the key sent as a bearer token to its own server only', async () => {
    const a = await local(KEY)
    seen.length = 0
    reply = json({ data: [{ id: 'kept' }, { id: 'new' }] })
    const r = await servers.readServerModels(a.id, 'r1')
    expect(r).toEqual({ ok: true, models: [{ id: 'kept', as: ['opus'] }, { id: 'new' }], dropped: ['gone'] })
    expect(seen).toEqual([{ url: '/v1/models', auth: `Bearer ${KEY}`, encoding: 'identity' }])
    expect(accounts.getAccount(a.id)!.server).toMatchObject({ modelsFrom: 'listed', models: [{ id: 'kept', as: ['opus'] }, { id: 'new' }] })
  })

  it('by kind only: refused (401), forbidden (403), failed (500), a redirect not followed, not a list, too large', async () => {
    const a = await local(KEY)
    reply = json({ error: { message: `bad key ${KEY}` } }, 401)
    expect(await servers.readServerModels(a.id, 'r')).toEqual({ ok: false, why: 'refused', status: 401 })
    reply = json({}, 403)
    expect(await servers.readServerModels(a.id, 'r')).toEqual({ ok: false, why: 'forbidden', status: 403 })
    reply = json({}, 500)
    expect(await servers.readServerModels(a.id, 'r')).toEqual({ ok: false, why: 'failed', status: 500 })
    seen.length = 0
    reply = (res, url) => {
      if (url === '/elsewhere') return json({ data: [{ id: 'x' }] })(res)
      res.writeHead(302, { location: `http://127.0.0.1:${port}/elsewhere` })
      res.end()
    }
    expect(await servers.readServerModels(a.id, 'r')).toEqual({ ok: false, why: 'redirect', status: 302 })
    expect(seen.map((s) => s.url)).toEqual(['/v1/models'])
    reply = json({ models: [] })
    expect(await servers.readServerModels(a.id, 'r')).toEqual({ ok: false, why: 'shape' })
    reply = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(`{"data":[${'{"id":"m"},'.repeat(120_000)}{"id":"z"}]}`)
    }
    expect(await servers.readServerModels(a.id, 'r')).toEqual({ ok: false, why: 'tooBig' })
    // Asked unencoded, and an encoded reply refused unread: no network reply reaches Node's Brotli decoder (HI-1836, #1582).
    reply = (res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' })
      res.end('\x1b\x00garbage')
    }
    expect(await servers.readServerModels(a.id, 'r')).toEqual({ ok: false, why: 'shape' })
    // None of it kept, nor the server's text anywhere.
    expect(accounts.getAccount(a.id)!.server!.models.map((m) => m.id)).toEqual(['kept', 'gone'])
  })

  it('stale: its server changed while it was read, or a newer reading started; nothing kept', async () => {
    const a = await local()
    let answer!: () => void
    let asked!: () => void
    const isAsked = new Promise<void>((r) => (asked = r))
    reply = (res) => {
      asked()
      answer = () => json({ data: [{ id: 'late' }] })(res)
    }
    const reading = servers.readServerModels(a.id, 'old')
    await isAsked
    await servers.editServerConnection(a.id, { baseUrl: `http://localhost:${port}` })
    answer()
    expect(await reading).toEqual({ ok: false, why: 'stale' })
    expect(accounts.getAccount(a.id)!.server!.models.map((m) => m.id)).toEqual(['kept', 'gone'])
    // A newer reading ends the one before.
    const asked2 = new Promise<void>((r) => (asked = r))
    let answer1!: () => void
    reply = (res) => {
      asked()
      answer1 = () => json({ data: [{ id: 'first' }] })(res)
    }
    const first = servers.readServerModels(a.id, 'one')
    await asked2
    reply = json({ data: [{ id: 'second' }] })
    const second = await servers.readServerModels(a.id, 'two')
    answer1?.()
    expect(second).toMatchObject({ ok: true })
    expect(await first).toEqual({ ok: false, why: 'stale' })
    expect(accounts.getAccount(a.id)!.server!.models.map((m) => m.id)).toEqual(['second'])
  }, HUNG_MS * 2)

  it('stale too when only its path changed meanwhile, the same server (round 1)', async () => {
    const a = await serverOn({ name: 'Paths', preset: undefined, baseUrl: `http://127.0.0.1:${port}/old`, models: [{ id: 'kept', as: ['opus'] }] })
    let answer!: () => void
    let asked!: () => void
    const isAsked = new Promise<void>((r) => (asked = r))
    reply = (res, url) => {
      expect(url).toBe('/old/v1/models')
      asked()
      answer = () => json({ data: [{ id: 'from-old-path' }] })(res)
    }
    const reading = servers.readServerModels(a.id, 'old-path')
    await isAsked
    expect(await servers.editServerConnection(a.id, { baseUrl: `http://127.0.0.1:${port}/new` })).toEqual({ keyCleared: false })
    answer()
    expect(await reading).toEqual({ ok: false, why: 'stale' })
    expect(accounts.getAccount(a.id)!.server!.models.map((m) => m.id)).toEqual(['kept'])
  }, HUNG_MS * 2)
})

describe('Ollama cloud models: on this PC, but not local (HI-1773, Darren 27 Oct)', () => {
  let srv: Server
  let port = 0
  let tags: unknown = { models: [] }
  beforeAll(async () => {
    // A stand-in for Ollama's own server on this PC: its /api/tags, as Ollama 0.33.1 answers (ollama/api/types.go's ListModelResponse).
    srv = createServer((req, res) => {
      res.writeHead(req.url === '/api/tags' ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.url === '/api/tags' ? tags : {}))
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    port = (srv.address() as { port: number }).port
  })
  afterAll(() => new Promise<void>((r) => srv.close(() => r())))
  const ollama = (models: { id: string; as?: ('opus' | 'sonnet' | 'haiku')[]; remote?: true }[], preset: string | undefined = 'ollama') => serverOn({ name: 'Ollama', preset, baseUrl: `http://127.0.0.1:${port}`, models })
  /** A new launch on it: whether it runs only on this PC, and its models as the footer gets them. */
  const launched = async (id: string): Promise<{ local: boolean; cloud: string[] }> => {
    const conn = (await launch(id))!
    try {
      return { local: conn.server!.local, cloud: conn.server!.models.filter((m) => m.remote).map((m) => m.id) }
    } finally {
      conn.release()
    }
  }
  const local = async (id: string): Promise<boolean> => (await launched(id)).local
  /** Its models marked cloud as Settings → Connections and the pickers get them, and as config keeps them. */
  const shownCloud = (id: string): string[] => view().connections.find((c) => c.id === id)!.server!.models.filter((m) => m.remote).map((m) => m.id)
  const savedCloud = (id: string): string[] => accounts.getAccount(id)!.server!.models.filter((m) => m.remote).map((m) => m.id)
  const pattern = async (value: string | null): Promise<void> => advanced.set('claude-code.connections.remoteModels', value)
  const tag = (name: string, remote?: string) => ({ name, model: name, size: 1, digest: 'x', ...(remote ? { remote_model: name, remote_host: remote } : {}) })

  it("read from Ollama: a model it marks remote (an alias of a cloud model too) is cloud, the rest local; each reading says it afresh", async () => {
    const a = await ollama([{ id: 'qwen3:8b', as: ['opus'] }])
    expect(await local(a.id)).toBe(true)
    // The server's own mark, whatever the name, kept; a cloud tag it doesn't mark (an older Ollama), by the preset's
    // pattern as it runs, never kept.
    tags = { models: [tag('qwen3:8b'), tag('mine', 'https://ollama.com:443'), tag('glm-4.6:cloud')] }
    expect(await servers.readServerModels(a.id, 'r1')).toMatchObject({ ok: true, models: [{ id: 'qwen3:8b', as: ['opus'] }, { id: 'mine', remote: true }, { id: 'glm-4.6:cloud', remote: true }] })
    expect(savedCloud(a.id)).toEqual(['mine'])
    expect(await local(a.id)).toBe(false)
    // Read again: what this reading says, not what the last one did.
    tags = { models: [tag('qwen3:8b'), tag('mine')] }
    expect(await servers.readServerModels(a.id, 'r2')).toMatchObject({ ok: true, models: [{ id: 'qwen3:8b', as: ['opus'] }, { id: 'mine' }] })
    expect(accounts.getAccount(a.id)!.server!.models[1].remote).toBeUndefined()
    expect(await local(a.id)).toBe(true)
  })

  it("an edit of its names keeps the server's mark; the window can't mark a model or take a mark off", async () => {
    const a = await ollama([])
    tags = { models: [tag('qwen3:8b'), tag('mine', 'https://ollama.com:443')] }
    await servers.readServerModels(a.id, 'r')
    // As the window sends them: its names changed, no marks (or a mark of its own on a local model).
    await servers.editServerConnection(a.id, { models: [{ id: 'qwen3:8b', as: ['haiku'], remote: true }, { id: 'mine', as: ['opus'] }] })
    expect(accounts.getAccount(a.id)!.server!.models).toEqual([{ id: 'qwen3:8b', as: ['haiku'] }, { id: 'mine', as: ['opus'], remote: true }])
    expect(await local(a.id)).toBe(false)
    // Taken out: local again.
    await servers.editServerConnection(a.id, { models: [{ id: 'qwen3:8b', as: ['opus'] }] })
    expect(await local(a.id)).toBe(true)
  })

  it('typed: by the preset\'s pattern (a tag of cloud or …-cloud, never a name\'s own -cloud), and only for the Ollama preset', async () => {
    const a = await ollama([{ id: 'qwen3:8b', as: ['opus'] }, { id: 'gpt-oss:120b-cloud' }, { id: 'my-cloud' }])
    // Marked as it runs and as it's shown, never in config (round 1).
    expect(savedCloud(a.id)).toEqual([])
    expect(shownCloud(a.id)).toEqual(['gpt-oss:120b-cloud'])
    expect(await launched(a.id)).toEqual({ local: false, cloud: ['gpt-oss:120b-cloud'] })
    // A custom server on this PC: no pattern of Ollama's applies.
    const custom = await ollama([{ id: 'gemma4:cloud', as: ['opus'] }], '')
    expect(shownCloud(custom.id)).toEqual([])
    expect(await launched(custom.id)).toEqual({ local: true, cloud: [] })
    // The real names Ollama gives (tests/fixtures/advanced): its cloud models taken, its local ones not.
    const test = accounts.remoteModelTest(providerDescriptor('claude-code').capabilities.connections!.server!, 'ollama')
    expect(['gemma4:cloud', 'kimi-k2.7-code:cloud', 'qwen3-coder:480b-cloud', 'deepseek-v3.1:671b-cloud'].every(test)).toBe(true)
    expect(['qwen3.8:27b', 'qwen3-coder-next:q4_K_M', 'qwen3.6:35b-a3b', 'devstral-small-2:24b', 'my-cloud', 'cloud'].some(test)).toBe(false)
  })

  it('the pattern as set in Settings → Advanced applies at the next launch and in what windows show, both ways (round 1)', async () => {
    const a = await ollama([{ id: 'qwen3:8b', as: ['opus'] }])
    expect(await launched(a.id)).toEqual({ local: true, cloud: [] })
    await pattern('^qwen3:')
    try {
      expect(await launched(a.id)).toEqual({ local: false, cloud: ['qwen3:8b'] })
      expect(shownCloud(a.id)).toEqual(['qwen3:8b'])
    } finally {
      await pattern(null)
    }
    // Set back: local again, with no edit or reading.
    expect(await launched(a.id)).toEqual({ local: true, cloud: [] })
    expect(shownCloud(a.id)).toEqual([])
  })

  it('added while the pattern was wrong, then the pattern put right: a new launch is local (round 1, HR3\'s repro)', async () => {
    await pattern('^qwen3:')
    let a: Awaited<ReturnType<typeof ollama>>
    try {
      a = await ollama([{ id: 'qwen3:8b', as: ['opus'] }])
    } finally {
      await pattern(null)
    }
    expect(savedCloud(a.id)).toEqual([])
    expect(await launched(a.id)).toEqual({ local: true, cloud: [] })
  })

  it("a connection saved before S7 (a cloud model typed, no mark): marked cloud as it runs and as it's shown (round 1)", async () => {
    const a = await ollama([{ id: 'qwen3:8b', as: ['opus'] }])
    // As S6 saved it: a typed cloud model, never marked.
    config.update((c) => {
      const s = c.accounts!.find((x) => x.id === a.id)!.server!
      s.models = [{ id: 'gemma4:cloud', as: ['opus'] }]
    })
    expect(savedCloud(a.id)).toEqual([])
    expect(await launched(a.id)).toEqual({ local: false, cloud: ['gemma4:cloud'] })
    expect(shownCloud(a.id)).toEqual(['gemma4:cloud'])
  })

  it('moved off the Ollama preset: its pattern no longer applies; a mark Ollama gave stays until read again', async () => {
    const a = await ollama([{ id: 'gemma4:cloud', as: ['opus'] }])
    tags = { models: [tag('gemma4:cloud'), tag('mine', 'https://ollama.com:443')] }
    await servers.readServerModels(a.id, 'r')
    expect(shownCloud(a.id)).toEqual(['gemma4:cloud', 'mine'])
    await servers.editServerConnection(a.id, { preset: null })
    expect(shownCloud(a.id)).toEqual(['mine'])
    expect(await local(a.id)).toBe(false)
  })
})
