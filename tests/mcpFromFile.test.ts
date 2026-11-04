// Add MCP Server from File (#550): a .json definition or a .zip of a server folder, checked, unpacked safely into
// .combwork/mcp/<name>/ and added nowhere (HI-2059); a name in use is refused unless replaced; what it runs is shown by name.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import * as electron from 'electron'
import { tempDir } from './tempDir'

// A write held at a gate (`hold`, for a path matching `path`): the race below makes its moment deterministic. `grow`:
// the file at that path is rewritten with `data` just after its stat, so it grows between the stat and the read.
const gate = vi.hoisted(() => ({
  hold: null as null | { path: RegExp; reached: () => void; release: Promise<void> },
  grow: null as null | { path: string; data: Uint8Array }
}))
vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>()
  return {
    ...real,
    writeFile: async (...a: Parameters<typeof real.writeFile>) => {
      const g = gate.hold
      if (g && g.path.test(String(a[0]))) {
        gate.hold = null
        g.reached()
        await g.release
      }
      return real.writeFile(...a)
    },
    stat: (async (...a: Parameters<typeof real.stat>) => {
      const st = await real.stat(...a)
      const g = gate.grow
      if (g && String(a[0]) === g.path) {
        gate.grow = null
        await real.writeFile(g.path, g.data)
      }
      return st
    }) as typeof real.stat
  }
})

const base = tempDir('hive-mcp-from-file-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const mcp = await import('../src/main/mcp')

const files = join(base, 'files')
// Each case has a workspace and a trash of its own (#787): what one adds or replaces never reaches another, in any order.
let cases = 0
let mcpDir: string
let trashDir: string
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())
const json = (o: unknown): Uint8Array => strToU8(JSON.stringify(o))
const OLLAMA = { description: 'Local models', command: 'node', args: ['${HIVE_MCP_DIR}/ollama/server.js'], env: { OLLAMA_HOST: 'http://127.0.0.1:11434', OLLAMA_KEY: '${OLLAMA_KEY}' } }

/** A file to add, in its own folder. */
function file(name: string, data: Uint8Array | string): string {
  const dir = join(files, `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, data)
  return path
}

/** A zip with one entry made on Unix as a symbolic link (fflate writes no links, so its attributes are set here). */
function withLink(entries: Record<string, Uint8Array>, link: string): Uint8Array {
  const z = zipSync({ ...entries, [link]: strToU8('../../outside') }, { os: 3 })
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength)
  for (let at = 0; at + 46 <= z.length; at++) {
    if (v.getUint32(at, true) !== 0x02014b50) continue
    const n = v.getUint16(at + 28, true)
    if (new TextDecoder().decode(z.subarray(at + 46, at + 46 + n)) === link) v.setUint32(at + 38, (0o120777 << 16) >>> 0, true)
  }
  return z
}

describe('Add MCP Server from File', () => {
  const was = process.env.HIVE_TEST_TRASH_DIR
  beforeEach(async () => {
    const dir = join(base, `case-${++cases}`)
    const wsPath = join(dir, 'ws')
    mcpDir = join(wsPath, '.combwork', 'mcp')
    trashDir = join(dir, 'trash')
    process.env.HIVE_TEST_TRASH_DIR = trashDir
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterEach(async () => {
    await disposeWorkspaceService(w)
    if (was === undefined) delete process.env.HIVE_TEST_TRASH_DIR
    else process.env.HIVE_TEST_TRASH_DIR = was
  })

  /** github, added from a .json (off): what the cases replacing or editing it start from. */
  const GITHUB = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } }
  const addGithub = () => run(() => mcp.addMcpFromFile(file('github.json', JSON.stringify(GITHUB)), 'github'))
  /** ollama, unpacked from a server folder .zip with a lib folder: what the cases replacing it start from. */
  const ollamaZip = (): Uint8Array =>
    zipSync({ 'ollama/hive-mcp.example.json': json(OLLAMA), 'ollama/server.js': strToU8('// server'), 'ollama/lib/util.js': strToU8('// util'), '__MACOSX/ollama/._server.js': strToU8('junk') })

  it('shows what a server runs: the command and arguments, or the URL, and environment and headers by name', () => {
    expect(mcp.mcpRuns({ command: 'node', args: ['${HIVE_MCP_DIR}/x/server.js', 'a b'], env: { HOST: 'http://h', KEY: '${KEY}' }, cwd: 'C:\\srv' })).toEqual([
      'Runs: node ${HIVE_MCP_DIR}/x/server.js "a b"',
      'In: C:\\srv',
      'Environment: HOST (set), KEY=${KEY}'
    ])
    expect(mcp.mcpRuns({ type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}', 'X-Key': '${X_KEY}' } })).toEqual([
      'Connects to: https://example.com/mcp (http)',
      'Headers: Authorization (set), X-Key=${X_KEY}'
    ])
  })

  it('checks a definition as launches need it', () => {
    expect(() => mcp.checkMcpDef([])).toThrow('must be a JSON object')
    expect(() => mcp.checkMcpDef({ description: 'x' })).toThrow('needs a "command"')
    expect(() => mcp.checkMcpDef({ command: 'node', args: 'server.js' })).toThrow('"args" must be a list of strings')
    expect(() => mcp.checkMcpDef({ command: 'node', env: { A: 1 } })).toThrow('"env" must be an object of strings')
    expect(() => mcp.checkMcpDef({ url: 'file:///c:/x' })).toThrow('"url" must be an http://')
    expect(mcp.checkMcpDef({ url: 'https://x/mcp', headers: { A: 'b' } })).toEqual({ url: 'https://x/mcp', headers: { A: 'b' } })
  })

  it('adds a .json definition added nowhere, named after the file, and says what it runs', async () => {
    // Added once for the Assistant under this name (its definition since deleted by hand): added again, it is nowhere.
    await run(() => w.saveWorkspaceConfigWith((c) => ({ mcp: { ...c.mcp, assistant: ['github'], assistantModel: 3 } })))
    const f = file('github.json', JSON.stringify(GITHUB))
    const preview = await run(() => mcp.previewMcpFile(f))
    expect(preview).toMatchObject({ name: 'github', files: 0, exists: false, runs: ['Runs: npx -y @modelcontextprotocol/server-github', 'Environment: GITHUB_TOKEN=${GITHUB_TOKEN}'] })
    const m = await run(() => mcp.addMcpFromFile(f, 'github'))
    expect(m).toMatchObject({ name: 'github', projects: [], assistant: false })
    expect(m.error).toBeUndefined()
    expect(JSON.parse(readFileSync(join(mcpDir, 'github.json'), 'utf8')).args).toEqual(['-y', '@modelcontextprotocol/server-github'])
  })

  it('refuses a name in use unless replaced; Replace moves the old one to the trash', async () => {
    await addGithub()
    const f = file('github.json', JSON.stringify({ command: 'uvx', args: ['github-mcp'] }))
    expect((await run(() => mcp.previewMcpFile(f))).exists).toBe(true)
    await expect(run(() => mcp.addMcpFromFile(f, 'github'))).rejects.toThrow('A server named "github" already exists: choose another name, or replace it.')
    expect(JSON.parse(readFileSync(join(mcpDir, 'github.json'), 'utf8')).command).toBe('npx')
    await run(() => mcp.addMcpFromFile(f, 'github', true))
    expect(JSON.parse(readFileSync(join(mcpDir, 'github.json'), 'utf8')).command).toBe('uvx')
    expect(readFileSync(join(trashDir, 'trash.jsonl'), 'utf8')).toContain('github.json')
    // Under another name instead, both stay.
    await run(() => mcp.addMcpFromFile(f, 'github-2'))
    expect(existsSync(join(mcpDir, 'github-2.json'))).toBe(true)
  })

  it("unpacks a server folder .zip into .combwork/mcp/<name>/, its definition from hive-mcp.json or the mcp repo's example", async () => {
    const f = file('ollama-v2.zip', ollamaZip())
    const preview = await run(() => mcp.previewMcpFile(f))
    expect(preview).toMatchObject({ name: 'ollama', files: 2, exists: false })
    expect(preview.runs).toEqual(['Runs: node ${HIVE_MCP_DIR}/ollama/server.js', 'Environment: OLLAMA_HOST (set), OLLAMA_KEY=${OLLAMA_KEY}'])
    const m = await run(() => mcp.addMcpFromFile(f, 'ollama'))
    expect(m).toMatchObject({ projects: [], assistant: false })
    expect(readFileSync(join(mcpDir, 'ollama', 'server.js'), 'utf8')).toBe('// server')
    expect(existsSync(join(mcpDir, 'ollama', 'lib', 'util.js'))).toBe(true)
    // The definition is the server's .json, not a file in its folder; nothing else is left in .combwork/mcp.
    expect(existsSync(join(mcpDir, 'ollama', 'hive-mcp.example.json'))).toBe(false)
    expect(existsSync(join(mcpDir, '__MACOSX'))).toBe(false)
    expect(readFileSync(join(mcpDir, 'ollama.json'), 'utf8')).toContain('${HIVE_MCP_DIR}/ollama/server.js')
  })

  it("added under another name, the definition runs that name's folder; a flat zip's folder is the zip's name", async () => {
    const z = zipSync({ 'ollama/hive-mcp.json': json(OLLAMA), 'ollama/server.js': strToU8('// server') })
    const m = await run(() => mcp.addMcpFromFile(file('ollama.zip', z), 'local-models'))
    expect(m.def?.args).toEqual(['${HIVE_MCP_DIR}/local-models/server.js'])
    expect(existsSync(join(mcpDir, 'local-models', 'server.js'))).toBe(true)
    const flat = zipSync({ 'hive-mcp.json': json({ command: 'node', args: ['${HIVE_MCP_DIR}/notes-server/index.js'] }), 'index.js': strToU8('//') })
    const f = file('notes-server.zip', flat)
    expect((await run(() => mcp.previewMcpFile(f))).name).toBe('notes-server')
    const n = await run(() => mcp.addMcpFromFile(f, 'notes'))
    expect(n.def?.args).toEqual(['${HIVE_MCP_DIR}/notes/index.js'])
    expect(existsSync(join(mcpDir, 'notes', 'index.js'))).toBe(true)
  })

  it('a .zip replacing a server replaces its folder; deleting the server takes its folder too', async () => {
    await run(() => mcp.addMcpFromFile(file('ollama-v2.zip', ollamaZip()), 'ollama'))
    expect(existsSync(join(mcpDir, 'ollama', 'lib', 'util.js'))).toBe(true)
    const z = zipSync({ 'ollama/hive-mcp.json': json(OLLAMA), 'ollama/server.js': strToU8('// v3') })
    await expect(run(() => mcp.addMcpFromFile(file('ollama.zip', z), 'ollama'))).rejects.toThrow('already exists')
    await run(() => mcp.addMcpFromFile(file('ollama.zip', z), 'ollama', true))
    expect(readFileSync(join(mcpDir, 'ollama', 'server.js'), 'utf8')).toBe('// v3')
    expect(existsSync(join(mcpDir, 'ollama', 'lib'))).toBe(false)
    await run(() => mcp.deleteMcp('ollama'))
    expect(existsSync(join(mcpDir, 'ollama.json'))).toBe(false)
    expect(existsSync(join(mcpDir, 'ollama'))).toBe(false)
  })

  it('refuses unsafe zips: paths outside the folder, absolute or Windows-invalid paths, links, no definition', async () => {
    const def = json(OLLAMA)
    const refused = async (z: Uint8Array, message: string): Promise<void> => {
      await expect(run(() => mcp.addMcpFromFile(file('bad.zip', z), 'bad'))).rejects.toThrow(message)
    }
    await refused(zipSync({ 'hive-mcp.json': def, '../evil.js': strToU8('x') }), 'unsafe path: ../evil.js')
    await refused(zipSync({ 'hive-mcp.json': def, 'a/../../evil.js': strToU8('x') }), 'unsafe path')
    await refused(zipSync({ 'hive-mcp.json': def, '/abs.js': strToU8('x') }), 'unsafe path')
    await refused(zipSync({ 'hive-mcp.json': def, 'C:/evil.js': strToU8('x') }), 'unsafe path')
    await refused(zipSync({ 'hive-mcp.json': def, 'x/file.js:stream': strToU8('x') }), 'unsafe path')
    await refused(zipSync({ 'hive-mcp.json': def, 'con.js': strToU8('x') }), 'unsafe path')
    await refused(withLink({ 'hive-mcp.json': def }, 'escape'), "has a link, which Combwork doesn't unpack: escape")
    await refused(zipSync({ 'server.js': strToU8('x') }), 'No hive-mcp.json or hive-mcp.example.json found')
    await refused(zipSync({ 'a/hive-mcp.json': def, 'b/x.js': strToU8('x') }), 'No hive-mcp.json')
    await refused(zipSync({ 'hive-mcp.json': strToU8('{oops') }), "hive-mcp.json isn't valid JSON")
    await refused(zipSync({ 'hive-mcp.json': json({ description: 'nothing to run' }) }), 'needs a "command"')
    // Nothing of them was written.
    expect(existsSync(join(mcpDir, 'bad'))).toBe(false)
    expect(existsSync(join(mcpDir, 'bad.json'))).toBe(false)
    expect(readdirSync(mcpDir).filter((n) => n.startsWith('.adding'))).toEqual([])
  })

  it('warns of a literal-looking secret before it is added, as for definitions in the workspace', async () => {
    const preview = await run(() => mcp.previewMcpFile(file('leaky.json', JSON.stringify({ command: 'npx', env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnop' } }))))
    expect(preview.secretWarnings).toEqual(['env "GITHUB_TOKEN" looks like a literal secret. Use an environment variable reference such as "${GITHUB_TOKEN}".'])
    // What it runs names the variable, never its value.
    expect(preview.runs).toEqual(['Runs: npx', 'Environment: GITHUB_TOKEN (set)'])
  })

  /**
   * Replaces `name` with `next`, holding the replace as it writes the new definition (the old one already in the
   * trash) while the user adds the server for the Assistant, having been shown `old`: the Add is refused and the new one is
   * added nowhere.
   */
  async function enableDuringReplace(name: string, old: Awaited<ReturnType<typeof mcp.addMcpFromFile>>, next: string): Promise<Awaited<ReturnType<typeof mcp.addMcpFromFile>>> {
    let reached!: () => void
    const atWrite = new Promise<void>((r) => (reached = r))
    let release!: () => void
    gate.hold = { path: new RegExp(`[\\\\/]${name}\\.json$`), reached, release: new Promise<void>((r) => (release = r)) }
    const replacing = run(() => mcp.addMcpFromFile(next, name, true))
    await atWrite
    const enabling = run(() => mcp.addMcpTo('assistant', name, { def: old.def, revision: old.revision }))
    release()
    const added = await replacing
    await expect(enabling).rejects.toThrow(`${name} has changed since it was shown to you. Check what it runs and add it again.`)
    expect(added.assistant).toBe(false)
    expect((await run(() => mcp.listMcp())).find((m) => m.name === name)?.assistant).toBe(false)
    return added
  }
  const enabled = async (name: string): Promise<boolean | undefined> => (await run(() => mcp.listMcp())).find((m) => m.name === name)?.assistant

  it('an Add of the old server while a replace is under way is refused, and the new one is added nowhere', async () => {
    const old = await run(() => mcp.addMcpFromFile(file('race.json', JSON.stringify({ command: 'node', args: ['old-server.js'] })), 'race'))
    const added = await enableDuringReplace('race', old, file('race.json', JSON.stringify({ command: 'node', args: ['new-server.js'] })))
    expect(added.def?.args).toEqual(['new-server.js'])
    // Shown the new server, it can be added.
    await run(() => mcp.addMcpTo('assistant', 'race', { def: added.def, revision: added.revision }))
    expect(await enabled('race')).toBe(true)
  })

  it('so is one during an upgrade that changes only the code, the definition the same', async () => {
    const def = json({ command: 'node', args: ['${HIVE_MCP_DIR}/same/server.js'] })
    const old = await run(() => mcp.addMcpFromFile(file('same.zip', zipSync({ 'same/hive-mcp.json': def, 'same/server.js': strToU8('// old version') })), 'same'))
    const added = await enableDuringReplace('same', old, file('same.zip', zipSync({ 'same/hive-mcp.json': def, 'same/server.js': strToU8('// new version') })))
    expect(added.def).toEqual(old.def)
    expect(added.revision).not.toBe(old.revision)
    expect(readFileSync(join(mcpDir, 'same', 'server.js'), 'utf8')).toBe('// new version')
    // An Add from a view of the old installation, after the upgrade, is refused too; the new one's works.
    await expect(run(() => mcp.addMcpTo('assistant', 'same', { def: old.def, revision: old.revision }))).rejects.toThrow('has changed since')
    await run(() => mcp.addMcpTo('assistant', 'same', { def: added.def, revision: added.revision }))
    expect(await enabled('same')).toBe(true)
  })

  it('an Add shown a definition since edited is refused', async () => {
    await addGithub()
    const shown = (await run(() => mcp.listMcp())).find((m) => m.name === 'github')!
    await run(() => mcp.saveMcp('github', JSON.stringify({ ...shown.def, args: ['-y', 'other-package'] }, null, 2)))
    await expect(run(() => mcp.addMcpTo('assistant', 'github', { def: shown.def, revision: shown.revision }))).rejects.toThrow('has changed since')
    expect(await enabled('github')).toBe(false)
  })

  it("deletes a definition that can't be read, removing it where it was added, and guesses no folder to delete", async () => {
    for (const [name, text] of [['broken', '{oops'], ['listed', '[1, 2]']]) {
      writeFileSync(join(mcpDir, `${name}.json`), text)
      mkdirSync(join(mcpDir, name), { recursive: true })
      writeFileSync(join(mcpDir, name, 'keep.txt'), 'not deleted')
      // Added before it broke.
      await run(() => w.saveWorkspaceConfigWith((c) => ({ mcp: { ...c.mcp, assistant: [name], assistantModel: 3 } })))
      expect((await run(() => mcp.listMcp())).find((m) => m.name === name)?.error).toBeTruthy()
      await run(() => mcp.deleteMcp(name))
      expect(existsSync(join(mcpDir, `${name}.json`))).toBe(false)
      expect(existsSync(join(mcpDir, name, 'keep.txt'))).toBe(true)
      expect(w.config.mcp.assistant).not.toContain(name)
    }
  })

  it('holds a file that grew after its size was checked to the limit by the bytes read', async () => {
    const big = (n: number): Uint8Array => json({ command: 'node', description: 'x'.repeat(n) })
    const small = file('grown.json', JSON.stringify({ command: 'node' }))
    gate.grow = { path: small, data: big(1024 * 1024) }
    await expect(run(() => mcp.previewMcpFile(small))).rejects.toThrow('The .json is too large for an MCP server definition (over 1 MB).')
    expect(gate.grow).toBeNull()
    expect(readFileSync(small).length).toBeGreaterThan(1024 * 1024)
    // A .zip has the same check against its 200 MB, not made here (a file that size).
  })

  it('refuses other files, a bad .json, and the reserved name', async () => {
    await expect(run(() => mcp.previewMcpFile(file('server.txt', 'x')))).rejects.toThrow('Choose a .json definition or a .zip of a server folder.')
    await expect(run(() => mcp.previewMcpFile(file('x.json', '{oops')))).rejects.toThrow("x.json isn't valid JSON")
    await expect(run(() => mcp.addMcpFromFile(file('x.json', JSON.stringify({ command: 'node' })), 'hive'))).rejects.toThrow('"hive" is reserved')
    // A file named hive.json gets another name to suggest.
    expect((await run(() => mcp.previewMcpFile(file('hive.json', JSON.stringify({ command: 'node' }))))).name).toBe('server')
  })
})
