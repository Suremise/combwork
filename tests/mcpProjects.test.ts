// Workspace MCP servers are available, and run only where they are added (HI-2059): a project's MCP tab adds and removes
// them, Add showing what one runs (refused if its definition changed since); Add to… in the MCP view sets every project
// at once, checked before its first write and honest about a write that fails midway. A name used before starts added
// nowhere; a server copied from a project's own config is added there. Upgrading converts each project's list on its own,
// keeping what ran (#1093's on in the workspace and on in the project) and dropping a choice the workspace had off: a
// project not converted keeps its old meaning, so nothing that didn't run starts. Settings from before #1093 still move
// through it. Each case has a workspace of its own.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { MCP_ADDED_MODEL, mcpAdded, mcpOnInProject, mcpServerShown, migratedProjectMcp, migratedWorkspaceMcp, serverOnIn } from '../src/shared/agentMcp'
import { tempDir } from './tempDir'

const base = tempDir('hive-mcp-projects-')
const profile = join(base, 'profile')
;(electron.app as unknown as { getPath: () => string }).getPath = () => profile
process.env.CW_USER_DATA = profile
// A test copy on its CLI test home: its agents start with no connection (the seam, HI-1755).
process.env.CW_TEST_CLI_HOME_CONNECTION = '1'
// Never the user's own CLI homes: the Codex and Copilot adapters read their config for a project's own servers.
process.env.CODEX_HOME = join(base, 'codex-home')
process.env.COPILOT_HOME = join(base, 'copilot-home')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const mcp = await import('../src/main/mcp')
const { sessions } = await import('../src/main/sessions')

describe('which servers are added to a project (HI-2059)', () => {
  it('a converted project: its list as it is', () => {
    expect(mcpAdded({ enabled: ['godot', 'notes'], model: MCP_ADDED_MODEL }, [])).toEqual(['godot', 'notes'])
    expect(mcpOnInProject('godot', { enabled: ['godot'], model: MCP_ADDED_MODEL }, undefined)).toBe(true)
  })

  it("one not converted keeps #1093's meaning: its own choices the workspace had on, never more", () => {
    expect(mcpAdded({ disabled: [], enabled: ['godot', 'notes'] }, ['notes'])).toEqual(['notes'])
    expect(mcpAdded({ disabled: [], enabled: ['godot'] }, [])).toEqual([])
    expect(mcpAdded(null, ['godot'])).toEqual([])
  })

  it("adds nothing from a list Combwork can't read, its own or the workspace's", () => {
    expect(mcpAdded({ enabled: 'godot' as never, model: MCP_ADDED_MODEL }, ['godot'])).toEqual([])
    expect(mcpAdded({ enabled: ['godot'] }, 'godot')).toEqual([])
    expect(mcpAdded({ enabled: ['godot'] }, { godot: true })).toEqual([])
    expect(mcpAdded({ enabled: ['godot'], model: 2 as never }, undefined)).toEqual([])
  })

  it('needs a definition that can be read', () => {
    const added = { disabled: [] as string[], enabled: ['godot'], model: MCP_ADDED_MODEL as typeof MCP_ADDED_MODEL }
    expect(serverOnIn({ name: 'godot', def: null }, { ...added, enabled: ['godot'] }, [])).toBe(false)
    expect(serverOnIn({ name: 'godot', def: { command: 'node' } }, { ...added, enabled: ['godot'] }, [])).toBe(true)
  })

  it("the MCP view's and the picker's search and filter", () => {
    const godot = { name: 'godot-b1', def: { description: 'Godot editor B1', tags: ['game', 'Engine'], command: 'node' }, projects: ['C:\\ws\\a'], assistant: false }
    const notes = { name: 'notes', def: { description: 'Shared notes', command: 'node' }, projects: [], assistant: true }
    const broken = { name: 'broken', def: null, projects: [], assistant: false, error: 'not JSON' }
    expect(mcpServerShown(godot, 'engine b1', 'all')).toBe(true)
    expect(mcpServerShown(godot, 'notes', 'all')).toBe(false)
    expect(mcpServerShown(notes, 'SHARED', 'added')).toBe(true)
    expect(mcpServerShown(notes, '', 'nowhere')).toBe(false)
    expect(mcpServerShown(broken, '', 'nowhere')).toBe(true)
    expect(mcpServerShown(broken, '', 'errors')).toBe(true)
    expect(mcpServerShown(godot, '', 'errors')).toBe(false)
  })

  it("strips Combwork's own fields from what a CLI is given", () => {
    expect(mcp.toLaunchDef({ description: 'd', tags: ['x'], command: 'node', args: ['a.js'] }, 'C:\\ws\\.combwork\\mcp')).toEqual({ command: 'node', args: ['a.js'] })
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

describe('MCP servers per project (HI-2059)', () => {
  const trashDir = join(base, 'trash')
  const was = process.env.CW_TEST_TRASH_DIR
  const godot = { description: 'Godot', command: 'node', args: ['godot.js'] }
  // Each case's own workspace, as 0.9.0 left it: github on for all projects and turned off in apiary; notes deployed
  // and turned on in apiary only; docs deployed and off. Opening it moves it to #1093's model, then to added servers.
  // Nothing a case does reaches another.
  let wsPath: string
  let ambrosia: string
  let apiary: string
  let w: ReturnType<typeof createWorkspaceService>
  const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())
  const mcpDir = (): string => join(wsPath, '.combwork', 'mcp')
  const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
  const projectMcp = (p: string) => json(join(p, '.combwork', 'project.json')).mcp

  /** The servers a launch in a project gets (its agent's), but Combwork's own: the launch's own reader. */
  const gets = async (p: string): Promise<string[]> => run(async () => Object.keys((await sessions.effective(p, { id: 'a1', name: 'Builder', provider: 'claude-code' } as never)).mcpServers).filter((n) => n !== 'hive').sort())
  /** Which projects a server runs in, as a launch decides it. */
  const onIn = async (name: string): Promise<string[]> => {
    const out: string[] = []
    for (const [label, p] of [['ambrosia', ambrosia], ['apiary', apiary]] as const) if ((await gets(p)).includes(name)) out.push(label)
    return out
  }
  const listed = async (name: string) => (await run(() => mcp.listMcp(true))).find((m) => m.name === name)!
  const shown = async (name: string) => {
    const m = await listed(name)
    return { def: m.def, revision: m.revision }
  }
  const add = async (p: string, name: string) => run(async () => mcp.addMcpTo({ project: p }, name, await shown(name)))

  /** A server's file to add, in a folder of its own. */
  const file = (name: string, data: unknown): string => {
    const dir = tempDir('hive-mcp-projects-file-')
    writeFileSync(join(dir, name), JSON.stringify(data))
    return join(dir, name)
  }
  const open = async (): Promise<void> => {
    w = createWorkspaceService()
    await w.open(wsPath)
  }
  const reopen = async (): Promise<void> => {
    await disposeWorkspaceService(w)
    await open()
  }

  beforeAll(() => {
    process.env.CW_TEST_TRASH_DIR = trashDir
  })
  afterAll(() => {
    if (was === undefined) delete process.env.CW_TEST_TRASH_DIR
    else process.env.CW_TEST_TRASH_DIR = was
  })
  beforeEach(() => {
    wsPath = tempDir('hive-mcp-projects-ws-')
    ambrosia = join(wsPath, 'ambrosia')
    apiary = join(wsPath, 'apiary')
    mkdirSync(mcpDir(), { recursive: true })
    for (const p of [ambrosia, apiary]) mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(wsPath, '.combwork', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: ['github'] } }))
    for (const n of ['github', 'notes', 'docs']) writeFileSync(join(mcpDir(), `${n}.json`), JSON.stringify({ command: 'node', args: [`${n}.js`] }))
    const agents = [{ id: 'a1', name: 'Builder', provider: 'claude-code' }]
    writeFileSync(join(ambrosia, '.combwork', 'project.json'), JSON.stringify({ version: 2, chime: 'on', agents, mcp: { disabled: [] } }))
    writeFileSync(join(apiary, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents, mcp: { disabled: ['github'], enabled: ['notes'] } }))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await disposeWorkspaceService(w)
  })

  it('changes nothing that runs at upgrade, converts each project once, and keeps the rest of its settings', async () => {
    await open()
    expect(await onIn('github')).toEqual(['ambrosia'])
    expect(await onIn('notes')).toEqual(['apiary'])
    expect(await onIn('docs')).toEqual([])
    // The workspace's old switch is kept, frozen, for a project not converted; the Assistant's list is converted too.
    expect(json(join(wsPath, '.combwork', 'workspace.json')).mcp).toEqual({ enabled: ['github', 'notes'], model: 2, assistant: [], assistantModel: 3 })
    expect(projectMcp(ambrosia)).toEqual({ disabled: [], enabled: ['github'], model: 3 })
    expect(projectMcp(apiary)).toEqual({ disabled: [], enabled: ['notes'], model: 3 })
    expect(json(join(ambrosia, '.combwork', 'project.json')).chime).toBe('on')
    // Nothing was dropped: no notice due.
    expect(json(join(wsPath, '.combwork', 'workspace.json')).mcp.droppedNotice).toBeUndefined()
    // Opened again: already converted, so a removal made since isn't undone.
    await run(() => mcp.removeMcpFrom({ project: ambrosia }, 'github'))
    await reopen()
    expect(await onIn('github')).toEqual([])
  })

  it("drops a choice kept while the workspace had the server off, and says so once", async () => {
    // #1093's model already: docs remembered in ambrosia while the workspace has it off.
    writeFileSync(join(wsPath, '.combwork', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: ['github'], model: 2, assistant: ['docs', 'github'] } }))
    writeFileSync(join(ambrosia, '.combwork', 'project.json'), JSON.stringify({ version: 2, mcp: { disabled: [], enabled: ['docs', 'github'] } }))
    await open()
    expect(projectMcp(ambrosia)).toEqual({ disabled: [], enabled: ['github'], model: 3 })
    expect(json(join(wsPath, '.combwork', 'workspace.json')).mcp.assistant).toEqual(['github'])
    expect(await onIn('docs')).toEqual([])
    // apiary's notes, which the workspace had off too.
    expect(w.config.mcp.droppedNotice).toBe(3)
    const toasts: unknown[] = []
    vi.spyOn(w, 'emit').mockImplementation((e) => void toasts.push(e))
    await mcp.sayMcpAddedOnce(w)
    await mcp.sayMcpAddedOnce(w)
    expect(toasts).toHaveLength(1)
    expect(JSON.stringify(toasts[0])).toContain('3 choices kept for servers that were off in the workspace were dropped')
    expect(json(join(wsPath, '.combwork', 'workspace.json')).mcp.droppedNotice).toBeUndefined()
  })

  it("a project whose conversion fails keeps its old meaning, so a choice the workspace had off never runs, and converts at the next open", async () => {
    writeFileSync(join(wsPath, '.combwork', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: ['github', 'notes'], model: 2 } }))
    writeFileSync(join(ambrosia, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder', provider: 'claude-code' }], mcp: { disabled: [], enabled: ['github'] } }))
    // apiary remembers docs, off in the workspace.
    writeFileSync(join(apiary, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder', provider: 'claude-code' }], mcp: { disabled: [], enabled: ['docs', 'notes'] } }))
    w = createWorkspaceService()
    const write = w.mutateProjectConfig.bind(w)
    // ambrosia's write goes through; apiary's fails, after it.
    const spy = vi.spyOn(w, 'mutateProjectConfig').mockImplementation((p, fn, o) => (p === apiary ? Promise.reject(Object.assign(new Error('EBUSY: locked'), { code: 'EBUSY' })) : write(p, fn, o)))
    await w.open(wsPath)
    spy.mockRestore()
    expect(projectMcp(ambrosia).model).toBe(3)
    expect(projectMcp(apiary)).toEqual({ disabled: [], enabled: ['docs', 'notes'] })
    // Its launch, its listing and the MCP view read it as it ran: notes, never docs.
    expect(await gets(apiary)).toEqual(['notes'])
    expect((await listed('docs')).projects).toEqual([])
    expect((await listed('notes')).projects).toEqual([apiary])
    // Removing another name from it converts it without bringing docs back.
    await run(() => mcp.removeMcpFrom({ project: apiary }, 'github'))
    expect(projectMcp(apiary)).toEqual({ disabled: [], enabled: ['notes'], model: 3 })
    expect(await gets(apiary)).toEqual(['notes'])
  })

  it('a project not converted at open converts at the next, never starting a server the workspace had off', async () => {
    writeFileSync(join(wsPath, '.combwork', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: ['notes'], model: 2 } }))
    writeFileSync(join(apiary, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder', provider: 'claude-code' }], mcp: { disabled: [], enabled: ['docs', 'notes'] } }))
    w = createWorkspaceService()
    const write = w.mutateProjectConfig.bind(w)
    const spy = vi.spyOn(w, 'mutateProjectConfig').mockImplementation((p, fn, o) => (p === apiary ? Promise.reject(new Error('EPERM')) : write(p, fn, o)))
    await w.open(wsPath)
    spy.mockRestore()
    expect(await gets(apiary)).toEqual(['notes'])
    await reopen()
    expect(projectMcp(apiary)).toEqual({ disabled: [], enabled: ['notes'], model: 3 })
    expect(await gets(apiary)).toEqual(['notes'])
    expect(w.config.mcp.droppedNotice).toBe(1)
  })

  it("Add on a project not converted converts it in the same write, adding only what was asked", async () => {
    writeFileSync(join(wsPath, '.combwork', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: ['notes'], model: 2 } }))
    writeFileSync(join(apiary, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder', provider: 'claude-code' }], mcp: { disabled: [], enabled: ['docs', 'notes'] } }))
    w = createWorkspaceService()
    const write = w.mutateProjectConfig.bind(w)
    const spy = vi.spyOn(w, 'mutateProjectConfig').mockImplementation((p, fn, o) => (p === apiary ? Promise.reject(new Error('EPERM')) : write(p, fn, o)))
    await w.open(wsPath)
    spy.mockRestore()
    await add(apiary, 'github')
    expect(projectMcp(apiary)).toEqual({ disabled: [], enabled: ['github', 'notes'], model: 3 })
    expect(await gets(apiary)).toEqual(['github', 'notes'])
  })

  it('adds and removes a server in one project, which runs it from its next session', async () => {
    await open()
    await add(ambrosia, 'docs')
    expect(await onIn('docs')).toEqual(['ambrosia'])
    expect((await listed('docs')).projects).toEqual([ambrosia])
    await run(() => mcp.removeMcpFrom({ project: ambrosia }, 'docs'))
    expect(await onIn('docs')).toEqual([])
    expect(projectMcp(ambrosia).enabled).toEqual(['github'])
  })

  it("refuses to add a server that has changed since it was shown, isn't there, can't be run, or into a folder that isn't a project", async () => {
    await open()
    const before = await shown('docs')
    writeFileSync(join(mcpDir(), 'docs.json'), JSON.stringify({ command: 'node', args: ['other.js'] }))
    await expect(run(() => mcp.addMcpTo({ project: ambrosia }, 'docs', before))).rejects.toThrow('has changed since')
    await expect(run(() => mcp.addMcpTo({ project: ambrosia }, 'missing', before))).rejects.toThrow('no MCP server named missing')
    writeFileSync(join(mcpDir(), 'broken.json'), JSON.stringify({ description: 'neither command nor url' }))
    await expect(run(async () => mcp.addMcpTo({ project: ambrosia }, 'broken', await shown('broken')))).rejects.toThrow('has changed since')
    await expect(run(async () => mcp.addMcpTo({ project: join(wsPath, 'elsewhere') }, 'notes', await shown('notes')))).rejects.toThrow()
    // Nothing changed.
    expect(projectMcp(ambrosia).enabled).toEqual(['github'])
  })

  it('Add to… adds where ticked and removes where unticked, checking every place before its first write', async () => {
    await open()
    let r = await run(async () => mcp.setMcpPlaces('docs', await shown('docs'), { [ambrosia]: true, [apiary]: true }, true))
    expect(r).toEqual({ added: [ambrosia, apiary, 'assistant'], removed: [], failed: [] })
    expect(await onIn('docs')).toEqual(['ambrosia', 'apiary'])
    r = await run(async () => mcp.setMcpPlaces('docs', undefined, { [ambrosia]: false, [apiary]: true }, false))
    expect(r).toEqual({ added: [], removed: [ambrosia, 'assistant'], failed: [] })
    expect(await onIn('docs')).toEqual(['apiary'])
    // A place that isn't this workspace's project: refused before anything is written.
    await expect(run(async () => mcp.setMcpPlaces('docs', await shown('docs'), { [ambrosia]: true, [join(wsPath, 'elsewhere')]: true }))).rejects.toThrow()
    expect(await onIn('docs')).toEqual(['apiary'])
    // Changed since it was shown: refused before anything is written, the removals too.
    const before = await shown('docs')
    writeFileSync(join(mcpDir(), 'docs.json'), JSON.stringify({ command: 'node', args: ['other.js'] }))
    await expect(run(() => mcp.setMcpPlaces('docs', before, { [ambrosia]: true, [apiary]: false }))).rejects.toThrow('has changed since')
    expect(await onIn('docs')).toEqual(['apiary'])
  })

  it('Add to… whose second write fails keeps the first and says which changed and which failed', async () => {
    await open()
    await add(apiary, 'docs')
    const write = w.mutateProjectConfig.bind(w)
    vi.spyOn(w, 'mutateProjectConfig').mockImplementation((p, fn, o) => (p === apiary ? Promise.reject(new Error('EBUSY: resource busy')) : write(p, fn, o)))
    const r = await run(async () => mcp.setMcpPlaces('docs', await shown('docs'), { [ambrosia]: true, [apiary]: false }))
    expect(r).toEqual({ added: [ambrosia], removed: [], failed: [{ place: apiary, error: 'EBUSY: resource busy' }] })
    vi.restoreAllMocks()
    expect(await onIn('docs')).toEqual(['ambrosia', 'apiary'])
  })

  it('adds a server from a file added nowhere', async () => {
    await open()
    await run(() => mcp.addMcpFromFile(file('godot.json', godot), 'godot'))
    expect(await listed('godot')).toMatchObject({ projects: [], assistant: false })
    expect([projectMcp(ambrosia).enabled, projectMcp(apiary).enabled]).toEqual([['github'], ['notes']])
  })

  it('starts a server added under a name used before added nowhere', async () => {
    await open()
    await run(() => mcp.addMcpFromFile(file('godot.json', godot), 'godot'))
    await add(ambrosia, 'godot')
    await add(apiary, 'godot')
    // Replaced: the new definition is added nowhere, wherever the old one was.
    await run(() => mcp.addMcpFromFile(file('godot.json', { ...godot, args: ['godot2.js'] }), 'godot', true))
    expect((await listed('godot')).projects).toEqual([])
    expect([projectMcp(ambrosia).enabled, projectMcp(apiary).enabled]).toEqual([['github'], ['notes']])
    // Deleted: removed everywhere, so one added by hand under the name later runs nowhere.
    await add(ambrosia, 'godot')
    await run(() => mcp.deleteMcp('godot'))
    for (const p of [ambrosia, apiary]) expect(projectMcp(p).enabled).not.toContain('godot')
    writeFileSync(join(mcpDir(), 'godot.json'), JSON.stringify(godot))
    expect(await onIn('godot')).toEqual([])
  })

  it("refuses to replace, delete or create a server while a project's settings can't be read, keeping the old one (HI-2059 round 1)", async () => {
    await open()
    await run(() => mcp.addMcpFromFile(file('godot.json', godot), 'godot'))
    await add(ambrosia, 'godot')
    const read = w.projectConfig.bind(w)
    const unreadable = (): void => void vi.spyOn(w, 'projectConfig').mockImplementation((p, o) => (p === ambrosia ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })) : read(p, o)))
    unreadable()
    await expect(run(() => mcp.addMcpFromFile(file('godot.json', { ...godot, args: ['unseen-new-server.js'] }), 'godot', true))).rejects.toThrow("Couldn't read the settings of ambrosia, so godot wasn't changed")
    await expect(run(() => mcp.deleteMcp('godot'))).rejects.toThrow("Couldn't read the settings of ambrosia")
    vi.restoreAllMocks()
    // Reads back: the old definition is still there and the only one ambrosia's launch can get.
    expect((await listed('godot')).def?.args).toEqual(['godot.js'])
    expect((await listed('godot')).projects).toEqual([ambrosia])
    expect(await run(async () => (await sessions.effective(ambrosia, { id: 'a1', name: 'Builder', provider: 'claude-code' } as never)).mcpServers.godot?.args)).toEqual(['godot.js'])
    // Deleted once it can be read: removed there. Creating one under the name is refused too while it can't be read.
    await run(() => mcp.deleteMcp('godot'))
    expect(projectMcp(ambrosia).enabled).not.toContain('godot')
    unreadable()
    await expect(run(() => mcp.createMcp('godot'))).rejects.toThrow("Couldn't read the settings of ambrosia")
    vi.restoreAllMocks()
    expect(await listed('godot')).toBeUndefined()
  })

  it("refuses to replace a server while a project's file is partway through a save, never reading its last good copy (HI-2059 round 2)", async () => {
    await open()
    await run(() => mcp.addMcpFromFile(file('godot.json', godot), 'godot'))
    await add(ambrosia, 'godot')
    const settings = join(ambrosia, '.combwork', 'project.json')
    const saved = readFileSync(settings, 'utf8')
    // Another writer is partway through saving ambrosia's settings: the file doesn't parse yet.
    writeFileSync(settings, '{')
    await expect(run(() => mcp.addMcpFromFile(file('godot.json', { ...godot, args: ['unseen-new-server.js'] }), 'godot', true))).rejects.toThrow("Couldn't read the settings of ambrosia, so godot wasn't changed")
    await expect(run(() => mcp.deleteMcp('godot'))).rejects.toThrow("Couldn't read the settings of ambrosia")
    // The writer finishes: the old definition is the only one ambrosia's launch can get.
    writeFileSync(settings, saved)
    expect((await listed('godot')).def?.args).toEqual(['godot.js'])
    expect(await run(async () => (await sessions.effective(ambrosia, { id: 'a1', name: 'Builder', provider: 'claude-code' } as never)).mcpServers.godot?.args)).toEqual(['godot.js'])
  })

  it('creates a new server from the template added nowhere', async () => {
    await open()
    await add(ambrosia, 'docs')
    await run(() => mcp.deleteMcp('docs'))
    await run(() => mcp.createMcp('docs'))
    expect((await listed('docs')).projects).toEqual([])
    expect(projectMcp(ambrosia).enabled).not.toContain('docs')
  })

  it("copies a server from a project's own config, added to that project when it is what was shown", async () => {
    await open()
    const sandbox = { command: 'node', args: ['sandbox.js'] }
    const tools = { command: 'node', args: ['tools.js'] }
    writeFileSync(join(apiary, '.mcp.json'), JSON.stringify({ mcpServers: { sandbox, tools } }))
    const offered = await run(() => mcp.projectMcpServers(apiary))
    expect(offered.map((s) => [s.name, s.runs])).toEqual([
      ['sandbox', ['Runs: node sandbox.js']],
      ['tools', ['Runs: node tools.js']]
    ])
    // tools changed after it was shown: copied, but added nowhere.
    const r = await run(() => mcp.importFromProject(apiary, ['sandbox', 'tools'], { sandbox, tools: { command: 'node', args: ['old.js'] } }))
    expect(r).toEqual({ copied: ['sandbox', 'tools'], on: ['sandbox'] })
    expect(await onIn('sandbox')).toEqual(['apiary'])
    expect(await onIn('tools')).toEqual([])
    expect(await run(() => mcp.projectMcpServers(apiary))).toEqual([])
  })
})
