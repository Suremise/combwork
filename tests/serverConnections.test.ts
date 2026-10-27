// Server connections (HI-1772): a connection that gets its model from a server by a base URL, with a key or none. Its key
// stored encrypted in the key store alone (one write per change, one lock for the whole file, no .bak), never in config;
// refused where it can't be kept safely or appears in another field; bound to its server's origin; decrypted for a
// launch's environment (masked while used); a keyless launch only for this PC's server; its models read from the server
// when asked (bounded, redirects refused, a stale reply dropped). Dummy keys only, in this file's temp folders; the CLI
// is never run and nothing signs in.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createServer, type Server, type ServerResponse } from 'http'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { ACCOUNTS_PREVIEW } from '../src/shared/advanced'
import { tempDir } from './tempDir'

const base = tempDir('hive-servers-')
const home = join(base, 'claude-home')
const userHome = join(base, 'user-profile')
const profile = join(base, 'profile')
process.env.HIVE_USER_DATA = profile
process.env.CLAUDE_CONFIG_DIR = home
delete process.env.HIVE_TEST_CLI_HOME_CONNECTION
;(electron.app as unknown as { getPath: (n: string) => string }).getPath = (n: string) => (n === 'home' ? userHome : profile)
const safe = (electron as unknown as { safeStorage: { available: boolean } }).safeStorage

const accounts = await import('../src/main/accounts')
const servers = await import('../src/main/serverConnections')
const keys = await import('../src/main/keyStore')
const { maskKeys, keysInUse } = await import('../src/main/keyMatcher')
const { config } = await import('../src/main/config')
const { advanced } = await import('../src/main/advanced')
const { provider } = await import('../src/main/providers')
const { providerService } = await import('../src/main/providerService')
const { withoutAccountEnv, withServerEnv } = await import('../src/main/providers/common')
const { createWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { agentLaunchSettings } = await import('../src/shared/providers')

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
  await advanced.set(ACCOUNTS_PREVIEW, true)
  mkdirSync(join(home, 'projects'), { recursive: true })
  mkdirSync(join(userHome, '.claude'), { recursive: true })
  mkdirSync(join(wsPath, 'alpha', '.hive'), { recursive: true })
  writeFileSync(join(wsPath, 'alpha', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One' }] }))
  config.settings.providers['claude-code'].enabled = true
  providerService.info = ((id: string) => ({ provider: id, found: true, path: 'claude.exe' })) as never
  vi.spyOn(provider('claude-code'), 'accountStatus').mockImplementation(async () => ({ ok: true, loggedIn: false }))
  w = createWorkspaceService()
  await w.open(wsPath)
})
afterEach(async () => {
  keys.keyStoreTestHooks.beforeWrite = undefined
  safe.available = true
  for (const a of [...(config.get().connections ?? [])]) await accounts.removeAccount(a.id).catch(() => undefined)
  config.update((c) => {
    c.connections = []
    c.lastUsedConnection = {}
  })
  await w.saveWorkspaceConfigWith(() => ({ connections: undefined, assistantConnection: undefined }))
})

const deepseek = { cli: 'claude-code' as const, name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', preset: 'deepseek', models: [{ id: 'deepseek-flash[1m]', as: ['opus' as const, 'sonnet' as const] }, { id: 'deepseek-flash', as: ['haiku' as const] }], modelsFrom: 'typed' as const }
async function serverOn(input: Partial<typeof deepseek> & { key?: string } = {}) {
  const a = await servers.addServerConnection({ ...deepseek, ...input })
  await here(() => accounts.setAccountOn(a.id, true))
  return a
}
const launch = (wanted?: string | null) => accounts.connectionForLaunch({ provider: 'claude-code', workspaceConfig: w.config, wanted, agentName: 'Builder' })
const store = (): Record<string, { v: number; origin: string; last4: string; blob: string }> => (existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')) : {})
const view = () => here(() => accounts.accountsView())

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
    expect(store()[a.id]).toMatchObject({ v: 1, origin: 'https://api.deepseek.com', last4: KEY.slice(-4) })
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
    const r = await servers.setServerKey(a.id, KEY2)
    expect(r).toEqual({ last4: KEY2.slice(-4) })
    expect(store()[a.id].v).toBe(2)
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
    expect(config.get().connections!.some((c) => c.server?.models.some((m) => m.id === `${plain}xyz`))).toBe(false)
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
    const cleaning = keys.dropKeysExcept(() => new Set(config.get().connections!.filter((c) => c.kind === 'server').map((c) => c.id)))
    release()
    await Promise.all([saving, cleaning])
    expect(store()[a.id]).toBeDefined()
    // A key whose connection is gone (a config restored from before it): dropped.
    writeFileSync(keyFile, JSON.stringify({ ...store(), 'a-gone0000': { v: 1, origin: 'https://x.example', last4: 'abcd', at: '', blob: 'x' } }))
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
      conn.server!.endKeyUse()
    }
    expect(keysInUse()).toBe(0)
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
      conn.server!.endKeyUse()
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
      conn.server!.endKeyUse()
    }
    // A path on the same server keeps the key; another server removes it.
    expect(await servers.editServerConnection(a.id, { baseUrl: 'https://api.deepseek.com/anthropic/v2' })).toEqual({ keyCleared: false })
    expect(store()[a.id]).toBeDefined()
    expect(await servers.editServerConnection(a.id, { baseUrl: 'https://gw.example.com' })).toEqual({ keyCleared: true })
    expect(store()[a.id]).toBeUndefined()
    expect(await outcome(launch(a.id))).toMatch(/has no key/)
  })
})

describe("reading a server's models (when asked)", () => {
  let srv: Server
  let port = 0
  const seen: { url: string; auth?: string }[] = []
  let reply: (res: ServerResponse, url: string) => void = (res) => res.end()
  beforeAll(async () => {
    srv = createServer((req, res) => {
      seen.push({ url: req.url ?? '', ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) })
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
    expect(seen).toEqual([{ url: '/v1/models', auth: `Bearer ${KEY}` }])
    expect(accounts.getAccount(a.id)!.server).toMatchObject({ modelsFrom: 'listed', models: [{ id: 'kept', as: ['opus'] }, { id: 'new' }] })
    expect(keysInUse()).toBe(0)
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
})
