// Workspace MCP servers run in a project only when on in the workspace and on in the project (#1093): adding one adds it
// off everywhere, with no questions; the workspace switch turns it on with the projects picked, and off keeping the
// projects' choices; a name used before starts with no project's choice; a server copied from a project's own config is
// on there; and settings from before (#713's on for all projects, with project.json's disabled lists) move to the model
// without changing what runs. Each case has a workspace of its own.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { migratedProjectMcp, migratedWorkspaceMcp, mcpOnInProject, serverOnIn } from '../src/shared/agentMcp'
import { tempDir } from './tempDir'

const base = tempDir('hive-mcp-projects-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// Never the user's own CLI homes: the Codex and Copilot adapters read their config for a project's own servers.
process.env.CODEX_HOME = join(base, 'codex-home')
process.env.COPILOT_HOME = join(base, 'copilot-home')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const mcp = await import('../src/main/mcp')

describe('whether a server is on in a project', () => {
  it('needs it on in the workspace and in the project', () => {
    expect(mcpOnInProject('godot', [], { disabled: [], enabled: [] })).toBe(false)
    expect(mcpOnInProject('godot', [], { disabled: [], enabled: ['godot'] })).toBe(false)
    expect(mcpOnInProject('godot', ['godot'], { disabled: [], enabled: [] })).toBe(false)
    expect(mcpOnInProject('godot', ['godot'], { disabled: [], enabled: ['godot'] })).toBe(true)
    expect(mcpOnInProject('godot', ['godot'], null)).toBe(false)
  })

  it("turns nothing on from a list Hive can't read", () => {
    expect(mcpOnInProject('godot', ['godot'], { enabled: 'godot' as never })).toBe(false)
    expect(mcpOnInProject('godot', 'godot' as never, { enabled: ['godot'] })).toBe(false)
  })

  it('needs a definition that can be read', () => {
    expect(serverOnIn({ name: 'godot', def: null, globallyEnabled: true }, { disabled: [], enabled: ['godot'] })).toBe(false)
    expect(serverOnIn({ name: 'godot', def: { command: 'node' }, globallyEnabled: true }, { disabled: [], enabled: ['godot'] })).toBe(true)
    expect(serverOnIn({ name: 'godot', def: { command: 'node' }, globallyEnabled: false }, { disabled: [], enabled: ['godot'] })).toBe(false)
  })
})

describe('moving settings from before #1093', () => {
  it('keeps every server on where it ran, and nowhere else', () => {
    // On for all projects: on in each project that didn't turn it off.
    expect(migratedProjectMcp(['github'], { disabled: [], enabled: [] })).toEqual(['github'])
    expect(migratedProjectMcp(['github'], { disabled: ['github'], enabled: [] })).toEqual([])
    // Turned on in the project: stays on. Off in both lists (a hand edit): off won, so off.
    expect(migratedProjectMcp([], { disabled: ['b'], enabled: ['a', 'b'] })).toEqual(['a'])
    // A project.json from before #713, or none.
    expect(migratedProjectMcp(['github'], { disabled: [] })).toEqual(['github'])
    expect(migratedProjectMcp(['github'], null)).toEqual(['github'])
    // On in the workspace: everything that ran anywhere.
    expect(migratedWorkspaceMcp(['github'], [{ disabled: [], enabled: ['notes'] }, { disabled: ['docs'], enabled: ['docs'] }, null])).toEqual(['github', 'notes'])
    expect(migratedWorkspaceMcp([], [])).toEqual([])
  })

  it('does the same again when a move is cut short', () => {
    const before = { disabled: ['github'], enabled: ['notes'] }
    const once = migratedProjectMcp(['github', 'docs'], before)
    expect(migratedProjectMcp(['github', 'docs'], { ...before, enabled: once })).toEqual(once)
  })
})

describe('MCP servers per project', () => {
  const trashDir = join(base, 'trash')
  const was = process.env.HIVE_TEST_TRASH_DIR
  const godot = { description: 'Godot', command: 'node', args: ['godot.js'] }
  // Each case's own workspace, as 0.9.0 left it: github on for all projects and turned off in apiary; notes deployed
  // and turned on in apiary only; docs deployed and off. Opening it moves it to #1093's model. Nothing a case does
  // reaches another.
  let wsPath: string
  let amber: string
  let apiary: string
  let w: ReturnType<typeof createWorkspaceService>
  const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())
  const mcpDir = (): string => join(wsPath, '.hive', 'mcp')
  const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

  /** Which projects have the server on, as a launch decides it. */
  const onIn = async (name: string): Promise<string[]> =>
    run(async () => {
      const m = (await mcp.listMcp()).find((x) => x.name === name)
      if (!m) return []
      const out: string[] = []
      for (const [label, p] of [['amberlight', amber], ['apiary', apiary]] as const) if (serverOnIn(m, (await w.projectConfig(p)).mcp)) out.push(label)
      return out
    })
  const listed = async (name: string) => (await run(() => mcp.listMcp())).find((m) => m.name === name)!
  const chosen = async (p: string): Promise<string[]> => (await run(() => w.projectConfig(p))).mcp.enabled

  /** A server's file to add, in a folder of its own. */
  const file = (name: string, data: unknown): string => {
    const dir = tempDir('hive-mcp-projects-file-')
    writeFileSync(join(dir, name), JSON.stringify(data))
    return join(dir, name)
  }
  /** Turns a server on in the workspace as its enable dialog does: shown, with the projects picked. */
  const enable = async (name: string, projects: Record<string, boolean> = {}) => {
    const shown = await listed(name)
    await run(() => mcp.setMcpGlobal(name, true, { def: shown.def, revision: shown.revision }, projects))
  }

  beforeAll(() => {
    process.env.HIVE_TEST_TRASH_DIR = trashDir
  })
  afterAll(() => {
    if (was === undefined) delete process.env.HIVE_TEST_TRASH_DIR
    else process.env.HIVE_TEST_TRASH_DIR = was
  })
  beforeEach(async () => {
    wsPath = tempDir('hive-mcp-projects-ws-')
    amber = join(wsPath, 'amberlight')
    apiary = join(wsPath, 'apiary')
    mkdirSync(mcpDir(), { recursive: true })
    for (const p of [amber, apiary]) mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(wsPath, '.hive', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: ['github'] } }))
    for (const n of ['github', 'notes', 'docs']) writeFileSync(join(mcpDir(), `${n}.json`), JSON.stringify({ command: 'node', args: [`${n}.js`] }))
    writeFileSync(join(amber, '.hive', 'project.json'), JSON.stringify({ version: 2, mcp: { disabled: [] } }))
    writeFileSync(join(apiary, '.hive', 'project.json'), JSON.stringify({ version: 2, mcp: { disabled: ['github'], enabled: ['notes'] } }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterEach(async () => {
    await disposeWorkspaceService(w)
  })

  it('changes nothing that runs at upgrade, and moves the settings once', async () => {
    expect(await onIn('github')).toEqual(['amberlight'])
    expect(await onIn('notes')).toEqual(['apiary'])
    expect(await onIn('docs')).toEqual([])
    // The Hive Assistant's own choices too (HI-1472): none, with the old Advanced switch not set.
    expect(json(join(wsPath, '.hive', 'workspace.json')).mcp).toEqual({ enabled: ['github', 'notes'], model: 2, assistant: [] })
    expect(json(join(amber, '.hive', 'project.json')).mcp).toEqual({ disabled: [], enabled: ['github'] })
    expect(json(join(apiary, '.hive', 'project.json')).mcp).toEqual({ disabled: [], enabled: ['notes'] })
    // Opened again: already moved, so a project's choice made since isn't undone.
    await run(() => mcp.setMcpProject(amber, 'github', false))
    await disposeWorkspaceService(w)
    w = createWorkspaceService()
    await w.open(wsPath)
    expect(await onIn('github')).toEqual([])
  })

  it("turns the workspace off everywhere, keeping the projects' choices for when it is on again", async () => {
    await run(() => mcp.setMcpGlobal('github', false))
    expect(await onIn('github')).toEqual([])
    expect(await chosen(amber)).toEqual(['github'])
    await enable('github')
    expect(await onIn('github')).toEqual(['amberlight'])
  })

  it('turns a server on in the workspace in the projects picked', async () => {
    await enable('docs', { [amber]: true, [apiary]: false })
    expect(await onIn('docs')).toEqual(['amberlight'])
    // Picked again: one turned on, one off.
    await run(() => mcp.setMcpGlobal('docs', false))
    await enable('docs', { [amber]: false, [apiary]: true })
    expect(await onIn('docs')).toEqual(['apiary'])
    expect([await chosen(amber), await chosen(apiary)]).toEqual([['github'], ['docs', 'notes']])
  })

  it("keeps a project's switch while the workspace has the server off, and runs it nowhere", async () => {
    await run(() => mcp.setMcpProject(amber, 'docs', true))
    expect(await chosen(amber)).toContain('docs')
    expect(await onIn('docs')).toEqual([])
    await run(() => mcp.setMcpProject(amber, 'docs', false))
    expect(await chosen(amber)).not.toContain('docs')
  })

  it("refuses to turn on a server that has changed since it was shown, or that isn't there", async () => {
    const shown = await listed('docs')
    writeFileSync(join(mcpDir(), 'docs.json'), JSON.stringify({ command: 'node', args: ['other.js'] }))
    await expect(run(() => mcp.setMcpGlobal('docs', true, { def: shown.def, revision: shown.revision }, { [amber]: true }))).rejects.toThrow('has changed since')
    await expect(run(() => mcp.setMcpGlobal('missing', true))).rejects.toThrow('no MCP server named missing')
    await expect(run(() => mcp.setMcpProject(apiary, 'missing', true))).rejects.toThrow('no MCP server named missing')
    // Refused before any project's choice changed.
    expect(await chosen(amber)).toEqual(['github'])
    expect(await onIn('docs')).toEqual([])
  })

  it('adds a server off in the workspace and in every project', async () => {
    await run(() => mcp.addMcpFromFile(file('godot.json', godot), 'godot'))
    expect((await listed('godot')).globallyEnabled).toBe(false)
    expect([await chosen(amber), await chosen(apiary)]).toEqual([['github'], ['notes']])
  })

  it("starts a server added under a name used before with no project's choice", async () => {
    await run(() => mcp.addMcpFromFile(file('godot.json', godot), 'godot'))
    await enable('godot', { [amber]: true, [apiary]: true })
    // Replaced: the new definition is off everywhere, whatever the projects chose for the old one.
    await run(() => mcp.addMcpFromFile(file('godot.json', { ...godot, args: ['godot2.js'] }), 'godot', true))
    expect((await listed('godot')).globallyEnabled).toBe(false)
    expect([await chosen(amber), await chosen(apiary)]).toEqual([['github'], ['notes']])
    // Deleted: every project forgets it, so one added by hand under the name later is on nowhere.
    await run(() => mcp.setMcpProject(amber, 'godot', true))
    await run(() => mcp.deleteMcp('godot'))
    for (const p of [amber, apiary]) expect(json(join(p, '.hive', 'project.json')).mcp.enabled).not.toContain('godot')
    writeFileSync(join(mcpDir(), 'godot.json'), JSON.stringify(godot))
    expect(await onIn('godot')).toEqual([])
  })

  it('creates a new server from the template off everywhere', async () => {
    await run(() => mcp.setMcpProject(amber, 'docs', true))
    await run(() => mcp.deleteMcp('docs'))
    await run(() => mcp.createMcp('docs'))
    expect((await listed('docs')).globallyEnabled).toBe(false)
    expect(await chosen(amber)).not.toContain('docs')
  })

  it("copies a server from a project's own config on in the workspace and that project when it is what was shown", async () => {
    const sandbox = { command: 'node', args: ['sandbox.js'] }
    const tools = { command: 'node', args: ['tools.js'] }
    writeFileSync(join(apiary, '.mcp.json'), JSON.stringify({ mcpServers: { sandbox, tools } }))
    const offered = await run(() => mcp.projectMcpServers(apiary))
    expect(offered.map((s) => [s.name, s.runs])).toEqual([
      ['sandbox', ['Runs: node sandbox.js']],
      ['tools', ['Runs: node tools.js']]
    ])
    // tools changed after it was shown: copied, but off.
    const r = await run(() => mcp.importFromProject(apiary, ['sandbox', 'tools'], { sandbox, tools: { command: 'node', args: ['old.js'] } }))
    expect(r).toEqual({ copied: ['sandbox', 'tools'], on: ['sandbox'] })
    expect(await onIn('sandbox')).toEqual(['apiary'])
    expect(await onIn('tools')).toEqual([])
    expect(await run(() => mcp.projectMcpServers(apiary))).toEqual([])
  })
})
