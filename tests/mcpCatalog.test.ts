// MCP catalogues (HI-545): catalog.json v1 checked as the mcp project's validator checks it; this PC's requirements
// (met, not met, or not checkable); search and filters. Downloads keep to their source's scheme at every redirect and
// to one size and time budget; a zip is used only if its size and sha256 match; the cache stays bounded. Install is
// #550's Add (added nowhere, Combwork's provenance kept out of launches); Update keeps the places shown, the user's env
// values too, and writes nothing when the definition or the places changed meanwhile, or a project can't be read; a
// workspace closed during a download gets nothing. Each case has a workspace of its own; the catalogues are file://.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import * as electron from 'electron'
import { OUR_CATALOG_URL, catalogRowShown, isOurCatalogUrl, sameCatalogSource, checkRequirements, compareVersions, editionOf, readCatalog, type PcFacts } from '../src/shared/mcpCatalog'
import { tempDir } from './tempDir'

const base = tempDir('cw-mcp-catalog-')
const profile = join(base, 'profile')
;(electron.app as unknown as { getPath: () => string }).getPath = () => profile
process.env.CW_USER_DATA = profile
process.env.CW_TEST_CLI_HOME_CONNECTION = '1'
process.env.CODEX_HOME = join(base, 'codex-home')
process.env.COPILOT_HOME = join(base, 'copilot-home')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const mcp = await import('../src/main/mcp')
const catalog = await import('../src/main/mcpCatalog')
const { config } = await import('../src/main/config')
const { sessions } = await import('../src/main/sessions')

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
const entry = (o: Record<string, unknown> = {}) => ({ name: 'demo', version: '1.0.0', description: 'A demo server', tags: ['demo'], requires: { os: ['windows', 'macos', 'linux'] }, zip: { url: 'https://example.com/demo.zip', sha256: 'a'.repeat(64), size: 10 }, ...o })
const PC: PcFacts = { os: 'windows', edition: 'Pro', build: 26100, features: { 'Windows Sandbox': true }, node: '22.4.0', docker: false }
const words = (kind: string, value: string): string => `${kind}:${value}`

describe('catalog.json v1 (HI-545)', () => {
  it('reads a valid catalogue and ignores unknown fields', () => {
    const c = readCatalog({ schemaVersion: 1, name: 'Suremise/combwork-mcp', extra: true, servers: [{ ...entry(), future: 1 }] }, 'https://example.com/catalog.json')
    expect(c).toMatchObject({ name: 'Suremise/combwork-mcp', skipped: 0 })
    expect(c.servers.map((s) => s.name)).toEqual(['demo'])
    expect('future' in c.servers[0]).toBe(false)
  })

  it('refuses a catalogue it can\'t read as a whole, and skips the servers that are invalid or named twice', () => {
    expect(() => readCatalog({ schemaVersion: 2, name: 'x', servers: [] }, 'https://e.com/c.json')).toThrow('schemaVersion: 2')
    expect(() => readCatalog({ schemaVersion: 1, servers: [] }, 'https://e.com/c.json')).toThrow('name')
    expect(() => readCatalog({ schemaVersion: 1, name: 'x', servers: {} }, 'https://e.com/c.json')).toThrow('servers')
    const c = readCatalog({ schemaVersion: 1, name: 'x', servers: [entry(), entry(), entry({ name: 'Bad Name' }), entry({ name: 'b', version: '1.0' }), entry({ name: 'c', zip: { url: 'http://e.com/c.zip', sha256: 'a'.repeat(64), size: 1 } }), entry({ name: 'd', requires: { os: ['linux'], windows: {} } })] }, 'https://e.com/c.json')
    expect(c.servers.map((s) => s.name)).toEqual(['demo'])
    expect(c.skipped).toBe(5)
  })

  it('takes file:// zips only from a file:// catalogue', () => {
    const fileZip = entry({ zip: { url: 'file:///C:/share/demo.zip', sha256: 'a'.repeat(64), size: 1 } })
    expect(readCatalog({ schemaVersion: 1, name: 'x', servers: [fileZip] }, 'https://e.com/c.json').skipped).toBe(1)
    expect(readCatalog({ schemaVersion: 1, name: 'x', servers: [fileZip] }, 'file:///C:/share/catalog.json').servers).toHaveLength(1)
  })

  it('compares versions, maps editions and checks requirements: met, not met, or not checkable', () => {
    expect([compareVersions('1.2.0', '1.10.0'), compareVersions('2.0.0', '2.0.0'), compareVersions('3.0.1', '3.0.0')]).toEqual([-1, 0, 1])
    expect(['Core', 'Professional', 'EnterpriseS', 'Education', 'ServerStandard'].map(editionOf)).toEqual(['Home', 'Pro', 'Enterprise', 'Education', null])
    const r = { os: ['windows'], windows: { editions: ['Enterprise'], minBuild: 26000, features: ['Windows Sandbox', 'Hyper-V'] }, node: '>=24', docker: true, apps: ['A GPU'] }
    expect(checkRequirements(r, PC, words).map((c) => [c.label, c.state])).toEqual([
      ['os:windows', 'ok'],
      ['edition:Enterprise', 'no'],
      ['build:26000', 'ok'],
      ['feature:Windows Sandbox', 'ok'],
      ['feature:Hyper-V', 'unknown'],
      ['node:24', 'no'],
      ['docker:', 'no'],
      ['app:A GPU', 'unknown']
    ])
    // A probe that failed (null) is not checkable, never "not met".
    expect(checkRequirements({ os: ['windows'], node: '>=18' }, { ...PC, node: null }, words)[1].state).toBe('unknown')
    expect(checkRequirements({ os: ['linux'] }, PC, words)[0].state).toBe('no')
  })

  it('searches name, description and tags, and filters', () => {
    const row = { name: 'windows-sandbox', description: 'Test builds on a clean Windows', tags: ['testing'], installed: null, update: false, checks: [] as never[] }
    expect(catalogRowShown(row, 'clean TEST', 'all')).toBe(true)
    expect(catalogRowShown(row, 'docker', 'all')).toBe(false)
    expect(catalogRowShown(row, '', 'installed')).toBe(false)
    expect(catalogRowShown({ ...row, installed: '1.0.0', update: true }, '', 'updates')).toBe(true)
    expect(catalogRowShown({ ...row, checks: [{ kind: 'os', label: '', state: 'no' }] as never }, '', 'meets')).toBe(false)
  })
})

describe('downloads (HI-545/s17)', () => {
  afterEach(() => {
    catalog.testHooks.fetch = undefined
  })
  /** A fetch answering each URL as `routes` says: a redirect, bytes, or never (until aborted). */
  const routes = (map: Record<string, { to?: string; body?: Uint8Array; status?: number; hang?: boolean }>): typeof fetch =>
    (async (url: string, init?: RequestInit) => {
      const r = map[url]
      if (!r) return new Response('missing', { status: 404 })
      if (r.hang) return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      if (r.to) return new Response(null, { status: 302, headers: { location: r.to } })
      return new Response(Buffer.from(r.body ?? new Uint8Array()), { status: r.status ?? 200 })
    }) as never

  it('follows https redirects and refuses one into http or file:', async () => {
    catalog.testHooks.fetch = routes({ 'https://a.com/z': { to: 'https://b.com/z' }, 'https://b.com/z': { body: strToU8('ok') }, 'https://a.com/http': { to: 'http://b.com/z' }, 'https://a.com/file': { to: 'file:///C:/x.zip' } })
    expect((await catalog.download('https://a.com/z', 'https', 100, 5000))!.bytes.toString()).toBe('ok')
    await expect(catalog.download('https://a.com/http', 'https', 100, 5000)).rejects.toThrow('leads to an address this source may not use')
    await expect(catalog.download('https://a.com/file', 'https', 100, 5000)).rejects.toThrow('leads to an address this source may not use')
    // An https source never reads a file:// address, even one given directly.
    await expect(catalog.download('file:///C:/x.zip', 'https', 100, 5000)).rejects.toThrow('may not use')
  })

  it('stops after five redirects, past the byte budget, and at the time budget', async () => {
    const loop: Record<string, { to: string }> = {}
    for (let i = 0; i < 8; i++) loop[`https://a.com/${i}`] = { to: `https://a.com/${i + 1}` }
    catalog.testHooks.fetch = routes({ ...loop, 'https://a.com/big': { to: 'https://b.com/big' }, 'https://b.com/big': { body: new Uint8Array(200) }, 'https://a.com/slow': { hang: true } })
    await expect(catalog.download('https://a.com/0', 'https', 100, 5000)).rejects.toThrow('Too many redirects')
    await expect(catalog.download('https://a.com/big', 'https', 100, 5000)).rejects.toThrow('is larger than its catalogue says')
    await expect(catalog.download('https://a.com/slow', 'https', 100, 200)).rejects.toThrow('took too long')
  })

  it("ends a download when its workspace's lifetime ends", async () => {
    catalog.testHooks.fetch = routes({ 'https://a.com/slow': { hang: true } })
    const life = new AbortController()
    const going = catalog.download('https://a.com/slow', 'https', 100, 60_000, life.signal)
    life.abort()
    await expect(going).rejects.toThrow()
  })

  it('holds a file:// download to the same end and time budget (HI-545 round 1)', async () => {
    const d = tempDir('cw-mcp-catalog-file-')
    writeFileSync(join(d, 'demo.zip'), 'bytes')
    const url = pathToFileURL(join(d, 'demo.zip')).href
    expect((await catalog.download(url, 'file', 100, 5000))!.bytes.toString()).toBe('bytes')
    // Its workspace closed already: nothing is read.
    const life = new AbortController()
    life.abort()
    await expect(catalog.download(url, 'file', 100, 5000, life.signal)).rejects.toThrow()
    // A share that stalls: the time budget ends it.
    catalog.testHooks.stat = () => new Promise(() => {})
    try {
      await expect(catalog.download(url, 'file', 100, 100)).rejects.toThrow('took too long')
      // And so does its workspace closing meanwhile.
      const closing = new AbortController()
      const going = catalog.download(url, 'file', 100, 60_000, closing.signal)
      closing.abort()
      await expect(going).rejects.toThrow()
    } finally {
      catalog.testHooks.stat = undefined
    }
  })
})

describe('installing and updating (HI-545)', () => {
  const trashDir = join(base, 'trash')
  const wasTrash = process.env.CW_TEST_TRASH_DIR
  let wsPath: string
  let ambrosia: string
  let apiary: string
  let share: string
  let w: ReturnType<typeof createWorkspaceService>
  const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())
  const mcpDir = (): string => join(wsPath, '.combwork', 'mcp')
  const projectMcp = (p: string) => JSON.parse(readFileSync(join(p, '.combwork', 'project.json'), 'utf8')).mcp
  const agent = { id: 'a1', name: 'Builder', provider: 'claude-code' }
  const launched = async (p: string) => run(async () => (await sessions.effective(p, agent as never)).mcpServers)
  const source = (): string => pathToFileURL(join(share, 'catalog.json')).href

  /** Publishes demo at `version` to the share: its zip (running `script`, with `env`) and the catalogue listing it. */
  const publish = (version: string, script = 'server.js', env: Record<string, string> = { DEMO_TOKEN: '${DEMO_TOKEN}' }, o: { folder?: string; size?: number; sha?: string; other?: boolean } = {}): void => {
    // Combwork's names (HI-2503); with other, names Combwork doesn't read (HI-2594).
    const def = { description: 'A demo server', command: 'node', args: [`\${${o.other ? 'OTHER' : 'CW'}_MCP_DIR}/demo/${script}`], env }
    const zip = zipSync({ [`${o.folder ?? 'demo'}/${o.other ? 'other' : 'combwork'}-mcp.json`]: strToU8(JSON.stringify(def)), [`${o.folder ?? 'demo'}/${script}`]: strToU8(`// demo ${version}`) })
    writeFileSync(join(share, `demo-${version}.zip`), zip)
    const server = entry({ version, requires: { os: ['windows', 'macos', 'linux'] }, zip: { url: pathToFileURL(join(share, `demo-${version}.zip`)).href, sha256: o.sha ?? sha(zip), size: o.size ?? zip.length } })
    writeFileSync(join(share, 'catalog.json'), JSON.stringify({ schemaVersion: 1, name: 'Test catalogue', servers: [server, entry({ name: 'needs-mac', requires: { os: ['macos'] }, zip: server.zip })] }))
  }
  const pages = (refresh = true) => run(() => catalog.catalogPages({ refresh }))
  const row = async (name = 'demo') => (await pages())[0].rows.find((r) => r.name === name)!
  const install = async () => {
    const p = await run(() => catalog.prepareCatalogServer(source(), 'demo'))
    await run(() => catalog.installCatalogServer(p.id, 'demo', false))
  }
  const addTo = async (p: string) => {
    const m = (await run(() => mcp.listMcp(true))).find((x) => x.name === 'demo')!
    await run(() => mcp.addMcpTo({ project: p }, 'demo', { def: m.def, revision: m.revision }))
  }
  /** Update prepared, as its dialog would show it: the definition and the places now. */
  const prepareUpdate = async () => {
    const p = await run(() => catalog.prepareCatalogServer(source(), 'demo'))
    const ex = p.existing!
    return { p, shown: { def: ex.def, revision: ex.revision }, places: { projects: ex.projects, assistant: ex.assistant } }
  }

  beforeAll(() => {
    process.env.CW_TEST_TRASH_DIR = trashDir
  })
  afterAll(() => {
    if (wasTrash === undefined) delete process.env.CW_TEST_TRASH_DIR
    else process.env.CW_TEST_TRASH_DIR = wasTrash
  })
  beforeEach(async () => {
    wsPath = tempDir('cw-mcp-catalog-ws-')
    share = tempDir('cw-mcp-catalog-share-')
    ambrosia = join(wsPath, 'ambrosia')
    apiary = join(wsPath, 'apiary')
    mkdirSync(mcpDir(), { recursive: true })
    for (const p of [ambrosia, apiary]) {
      mkdirSync(join(p, '.combwork'), { recursive: true })
      writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [agent], mcp: { disabled: [], enabled: [], model: 3 } }))
    }
    catalog.testHooks.facts = PC
    publish('1.0.0')
    config.update((c) => {
      c.settings.mcpCatalogs = { oursOn: false, sources: [{ url: source(), on: true }] }
    })
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    catalog.testHooks.facts = undefined
    catalog.testHooks.probe = undefined
    await disposeWorkspaceService(w)
  })

  it('lists a source as a category, with the note for a source Combwork doesn\'t check, until noted', async () => {
    const [p] = await pages()
    expect(p).toMatchObject({ name: 'Test catalogue', ours: false, noteDue: true, total: 2, skipped: 0 })
    expect(p.rows.find((r) => r.name === 'needs-mac')!.checks[0].state).toBe('no')
    catalog.noteCatalogSource(source())
    expect((await pages(false))[0].noteDue).toBe(false)
  })

  it('installs a server checked against its catalogue, added nowhere, its provenance kept out of launches', async () => {
    await install()
    const m = (await run(() => mcp.listMcp(true))).find((x) => x.name === 'demo')!
    expect(m.def?.catalog).toEqual({ source: source(), name: 'demo', version: '1.0.0', sha256: sha(readFileSync(join(share, 'demo-1.0.0.zip'))) })
    expect(m).toMatchObject({ projects: [], assistant: false })
    expect(readFileSync(join(mcpDir(), 'demo', 'server.js'), 'utf8')).toBe('// demo 1.0.0')
    expect(await row()).toMatchObject({ installed: '1.0.0', update: false })
    await addTo(ambrosia)
    const def = (await launched(ambrosia)).demo
    expect(def?.args?.[0]).toMatch(/demo[\\/]server\.js$/)
    expect('catalog' in (def ?? {})).toBe(false)
  })

  it("refuses a download that doesn't match its catalogue, a zip laid out wrong, or a server this PC can't run, writing nothing", async () => {
    publish('1.0.0', 'server.js', undefined, { sha: 'b'.repeat(64) })
    await pages()
    await expect(run(() => catalog.prepareCatalogServer(source(), 'demo'))).rejects.toThrow("demo's download doesn't match its catalogue")
    publish('1.0.0', 'server.js', undefined, { folder: 'other' })
    await pages()
    await expect(run(() => catalog.prepareCatalogServer(source(), 'demo'))).rejects.toThrow("doesn't hold a folder named demo")
    await expect(run(() => catalog.prepareCatalogServer(source(), 'needs-mac'))).rejects.toThrow("needs-mac can't run on this PC: Runs on macos")
    expect((await run(() => mcp.listMcp())).map((m) => m.name)).toEqual([])
  })

  it('updates keeping the places shown and the user\'s env values, and is offered only for a higher version', async () => {
    await install()
    await addTo(ambrosia)
    // The user's own value for its token.
    const file = join(mcpDir(), 'demo.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), env: { DEMO_TOKEN: 'mine' } }, null, 2))
    publish('1.1.0', 'server2.js', { DEMO_TOKEN: '${DEMO_TOKEN}', NEW_KEY: 'x' })
    expect(await row()).toMatchObject({ installed: '1.0.0', update: true })
    const u = await prepareUpdate()
    expect(u.places).toEqual({ projects: [ambrosia], assistant: false })
    expect(await run(() => catalog.updateCatalogServer(u.p.id, u.shown, u.places))).toEqual({})
    const def = (await launched(ambrosia)).demo
    expect(def?.args?.[0]).toMatch(/server2\.js$/)
    expect(def?.env).toEqual({ DEMO_TOKEN: 'mine', NEW_KEY: 'x' })
    expect(projectMcp(ambrosia).enabled).toEqual(['demo'])
    expect(await row()).toMatchObject({ installed: '1.1.0', update: false })
  })

  it("installs and runs a zip with Combwork's names, updating it from the same folder; a zip with only the old names has no definition (HI-2594)", async () => {
    await install()
    await addTo(ambrosia)
    const folder = join(mcpDir(), 'demo').replace(/\\/g, '/')
    expect((await launched(ambrosia)).demo?.args?.[0]).toBe(`${folder}/server.js`)
    publish('1.1.0', 'server2.js')
    expect(await row()).toMatchObject({ installed: '1.0.0', update: true })
    const u = await prepareUpdate()
    expect(await run(() => catalog.updateCatalogServer(u.p.id, u.shown, u.places))).toEqual({})
    expect(JSON.parse(readFileSync(join(mcpDir(), 'demo.json'), 'utf8')).args).toEqual(['${CW_MCP_DIR}/demo/server2.js'])
    expect(readdirSync(join(mcpDir(), 'demo'))).toEqual(['server2.js'])
    expect((await launched(ambrosia)).demo?.args?.[0]).toBe(`${folder}/server2.js`)
    // other-mcp.json, a name Combwork doesn't read: refused, and nothing written.
    publish('1.2.0', 'server3.js', undefined, { other: true })
    await pages()
    await expect(run(() => catalog.prepareCatalogServer(source(), 'demo'))).rejects.toThrow('No combwork-mcp.json or combwork-mcp.example.json found')
    expect(readdirSync(join(mcpDir(), 'demo'))).toEqual(['server2.js'])
  })

  it('writes nothing when a place is removed or added, or the definition edited, while the update waits; nothing is re-added', async () => {
    await install()
    await addTo(ambrosia)
    publish('1.1.0', 'server2.js')
    await pages()
    // Removed meanwhile: refused, and ambrosia isn't given it back.
    let u = await prepareUpdate()
    await run(() => mcp.removeMcpFrom({ project: ambrosia }, 'demo'))
    expect((await run(() => catalog.updateCatalogServer(u.p.id, u.shown, u.places))).stale).toContain('Where demo is added changed while the update waited')
    expect(projectMcp(ambrosia).enabled).toEqual([])
    expect(readFileSync(join(mcpDir(), 'demo.json'), 'utf8')).toContain('server.js')
    // Added meanwhile: refused, so apiary never runs a definition it wasn't shown.
    u = await prepareUpdate()
    await addTo(apiary)
    expect((await run(() => catalog.updateCatalogServer(u.p.id, u.shown, u.places))).stale).toContain('changed while the update waited')
    expect((await launched(apiary)).demo?.args?.[0]).toMatch(/demo[\\/]server\.js$/)
    // The definition edited meanwhile: refused.
    u = await prepareUpdate()
    const file = join(mcpDir(), 'demo.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('A demo server', 'Edited'))
    expect((await run(() => catalog.updateCatalogServer(u.p.id, u.shown, u.places))).stale).toContain('has changed since it was shown')
    expect(readFileSync(file, 'utf8')).toContain('server.js')
  })

  it("refuses an update while a project's settings are partway through a save, writing nothing", async () => {
    await install()
    await addTo(ambrosia)
    publish('1.1.0', 'server2.js')
    await pages()
    const u = await prepareUpdate()
    const settings = join(ambrosia, '.combwork', 'project.json')
    const saved = readFileSync(settings, 'utf8')
    writeFileSync(settings, '{')
    await expect(run(() => catalog.updateCatalogServer(u.p.id, u.shown, u.places))).rejects.toThrow("Couldn't read the settings of ambrosia")
    writeFileSync(settings, saved)
    expect((await launched(ambrosia)).demo?.args?.[0]).toMatch(/demo[\\/]server\.js$/)
  })

  it('gives a workspace closed during the download nothing, and drops what it held', async () => {
    await pages()
    const p = await run(() => catalog.prepareCatalogServer(source(), 'demo'))
    await disposeWorkspaceService(w)
    await expect(catalog.installCatalogServer(p.id, 'demo', false)).rejects.toThrow('The workspace closed before demo was installed')
    await expect(catalog.installCatalogServer(p.id, 'demo', false)).rejects.toThrow('That download has expired')
    w = createWorkspaceService()
    await w.open(wsPath)
    expect((await run(() => mcp.listMcp())).map((m) => m.name)).toEqual([])
  })

  it('lists every source, each with its servers, on refresh and in a search after it, and keeps the cache bounded (HI-545 round 1)', async () => {
    const urls: string[] = []
    for (let i = 0; i < 12; i++) {
      const d = tempDir('cw-mcp-catalog-src-')
      writeFileSync(join(d, 'catalog.json'), JSON.stringify({ schemaVersion: 1, name: `Source ${i}`, servers: [entry({ description: `The demo of source ${i}` })] }))
      urls.push(pathToFileURL(join(d, 'catalog.json')).href)
    }
    catalog.setCatalogSources({ oursOn: false, sources: urls.map((url) => ({ url, on: true })) })
    const opened = await pages()
    expect(opened.map((p) => [p.name, p.total, p.error ?? null])).toEqual(urls.map((_, i) => [`Source ${i}`, 1, null]))
    // A search afterwards reads nothing again and still lists them all.
    const searched = await run(() => catalog.catalogPages({ query: 'demo' }))
    expect(searched.map((p) => p.total)).toEqual(urls.map(() => 1))
    expect(catalog.cacheSize().sources).toBeLessThanOrEqual(catalog.MAX_USER_SOURCES + 1)
    catalog.setCatalogSources({ oursOn: false, sources: [{ url: urls[0], on: true }] })
    expect(catalog.cacheSize().sources).toBeLessThanOrEqual(1)
    expect(() => catalog.setCatalogSources({ oursOn: true, sources: [{ url: 'http://e.com/c.json', on: true }] })).toThrow('https:// or file://')
    expect(() => catalog.setCatalogSources({ oursOn: true, sources: Array.from({ length: catalog.MAX_USER_SOURCES + 1 }, (_, i) => ({ url: `https://e.com/${i}.json`, on: true })) })).toThrow('at most 15 catalogues')
  })

  it("discards what it held when its workspace is closed and opened again in the same folder (HI-545 round 1)", async () => {
    await pages()
    const p = await run(() => catalog.prepareCatalogServer(source(), 'demo'))
    await w.close()
    await w.open(wsPath)
    await expect(run(() => catalog.installCatalogServer(p.id, 'demo', false))).rejects.toThrow('The workspace closed before demo was installed')
    expect((await run(() => mcp.listMcp())).map((m) => m.name)).toEqual([])
    // An update's too.
    await install()
    publish('1.1.0', 'server2.js')
    await pages()
    const u = await prepareUpdate()
    await w.close()
    await w.open(wsPath)
    await expect(run(() => catalog.updateCatalogServer(u.p.id, u.shown, u.places))).rejects.toThrow('The workspace closed before demo was installed')
    expect(readFileSync(join(mcpDir(), 'demo.json'), 'utf8')).toContain('server.js')
  })

  it('installs under another name when its own is taken, and is found by where it came from for its update (HI-545 round 1)', async () => {
    await run(() => mcp.createMcp('demo'))
    await pages()
    const p = await run(() => catalog.prepareCatalogServer(source(), 'demo'))
    expect(p).toMatchObject({ nameTaken: true, existing: null })
    await run(() => catalog.installCatalogServer(p.id, 'demo-cat', false))
    const m = (await run(() => mcp.listMcp(true))).find((x) => x.name === 'demo-cat')!
    expect(m.def?.catalog).toMatchObject({ name: 'demo', version: '1.0.0' })
    // The catalogue's ${CW_MCP_DIR} reference, moved to its name.
    expect(m.def?.args?.[0]).toBe('${CW_MCP_DIR}/demo-cat/server.js')
    expect(readFileSync(join(mcpDir(), 'demo-cat', 'server.js'), 'utf8')).toBe('// demo 1.0.0')
    // The local demo is untouched; the catalogue row is installed (by its provenance), not "name in use".
    expect(JSON.parse(readFileSync(join(mcpDir(), 'demo.json'), 'utf8')).catalog).toBeUndefined()
    expect(await row()).toMatchObject({ installed: '1.0.0', update: false })
    publish('1.1.0', 'server2.js')
    await pages()
    const u = await prepareUpdate()
    expect(u.p.existing?.name).toBe('demo-cat')
    expect(await run(() => catalog.updateCatalogServer(u.p.id, u.shown, u.places))).toEqual({})
    expect((await run(() => mcp.listMcp(true))).find((x) => x.name === 'demo-cat')?.def?.args?.[0]).toBe('${CW_MCP_DIR}/demo-cat/server2.js')
  })

  it("knows ours by its current address only: another repository's under the same owner (Suremise/demo-mcp) isn't ours (HI-2594)", () => {
    const other = 'https://github.com/Suremise/demo-mcp/releases/latest/download/catalog.json'
    expect(isOurCatalogUrl(OUR_CATALOG_URL)).toBe(true)
    expect(isOurCatalogUrl(other)).toBe(false)
    expect(sameCatalogSource(other, OUR_CATALOG_URL)).toBe(false)
  })

  it("shows a requirement whose probe failed or timed out as not checkable, never as met", async () => {
    catalog.testHooks.facts = undefined
    catalog.testHooks.probe = async () => {
      throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
    }
    publish('1.0.0')
    writeFileSync(join(share, 'catalog.json'), JSON.stringify({ schemaVersion: 1, name: 'T', servers: [entry({ requires: { os: ['windows', 'macos', 'linux'], node: '>=18' }, zip: { url: pathToFileURL(join(share, 'demo-1.0.0.zip')).href, sha256: 'a'.repeat(64), size: 1 } })] }))
    const r = await row()
    expect(r.checks.find((c) => c.kind === 'node')?.state).toBe('unknown')
  })
})
