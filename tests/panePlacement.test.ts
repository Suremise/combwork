// Saving where the panes are (#762), as Hive's main process does: placePanes under the project file's lock (the cells,
// and the order as they read), refusing an agent in two cells, and every placement settling as agents are added or
// removed, so each agent keeps its cell, across a restart too. Each case has a workspace of its own.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-placement-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { moveAgent, placePanes } = await import('../src/main/projectAgents')

describe('saving pane placements', () => {
  let w: ReturnType<typeof createWorkspaceService>
  let wsPath: string
  let alpha: string
  let file: string
  const agent = (id: string) => ({ id, name: id })
  /** A fresh workspace whose project has these agents and, if given, this placement saved for the grid of six. */
  const start = async (ids: string[], grid6?: (string | null)[]) => {
    writeFileSync(file, JSON.stringify({ version: 2, agents: ids.map(agent), layout: 'auto', worktreeSetup: 'npm ci', ...(grid6 ? { placement: { grid6 } } : {}) }))
    w = createWorkspaceService()
    await w.open(wsPath)
  }
  beforeEach(() => {
    wsPath = tempDir('hive-placement-ws-')
    alpha = join(wsPath, 'alpha')
    file = join(alpha, '.hive', 'project.json')
    mkdirSync(join(alpha, '.hive'), { recursive: true })
  })
  afterEach(() => disposeWorkspaceService(w))
  const saved = () => JSON.parse(readFileSync(file, 'utf8'))
  /** The project's view (its layout and placement), as this user's UI state keeps it (HI-1749: not in project.json). */
  const view = () => inWorkspace(w, () => w.projectConfig(alpha))
  const order = () => saved().agents.map((a: { id: string }) => a.id).join(',')
  // As adding and removing agents change them (addAgent, removeAgent, templates: all through mutateProjectConfig).
  const add = (id: string) => w.mutateProjectConfig(alpha, (now) => ({ agents: [...now.agents, agent(id)] }))
  const remove = (id: string) => w.mutateProjectConfig(alpha, (now) => ({ agents: now.agents.filter((a) => a.id !== id) }))

  it('saves the cells and the order as they read; an automatic layout becomes chosen', async () => {
    await start(['One', 'Two'])
    expect(await inWorkspace(w, () => placePanes(alpha, 'grid6', [null, 'Two', 'One']))).toEqual([null, 'Two', 'One'])
    expect((await view()).placement!.grid6).toEqual([null, 'Two', 'One'])
    expect(order()).toBe('Two,One')
    expect((await view()).layout).toBe('columns2')
    expect(saved().worktreeSetup).toBe('npm ci')
  })

  it('refuses an agent in two cells, or a layout without cells, and changes nothing', async () => {
    await start(['One', 'Two'], [null, 'One', 'Two'])
    const before = readFileSync(file, 'utf8')
    await expect(inWorkspace(w, () => placePanes(alpha, 'grid6', ['Two', 'Two', 'One']))).rejects.toThrow(/can't be placed/)
    await expect(inWorkspace(w, () => placePanes(alpha, 'single', ['One']))).rejects.toThrow(/can't be placed/)
    await expect(inWorkspace(w, () => placePanes(alpha, 'grid6', Array(49).fill(null)))).rejects.toThrow(/can't be placed/)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('agents added take a cell and keep it; one removed leaves its cell empty (add, add, remove)', async () => {
    await start(['One', 'Two'], [null, 'One', 'Two'])
    await add('Three')
    expect((await view()).placement!.grid6).toEqual(['Three', 'One', 'Two'])
    await add('Four')
    expect((await view()).placement!.grid6).toEqual(['Three', 'One', 'Two', 'Four'])
    await remove('One')
    expect((await view()).placement!.grid6).toEqual(['Three', null, 'Two', 'Four'])
  })

  it("a change of order (another layout's move, Tiles) moves no agent's cell", async () => {
    await start(['Two', 'Three', 'Four'], ['Three', null, 'Two', 'Four'])
    await inWorkspace(w, () => moveAgent(alpha, 'Four', 0))
    expect(order()).toBe('Four,Two,Three')
    expect((await view()).placement!.grid6).toEqual(['Three', null, 'Two', 'Four'])
  })

  it("names gone and agents added meanwhile: a gone one's cell is empty, an added one takes a cell", async () => {
    await start(['Two', 'Three', 'Four', 'Five'], ['Three', null, 'Two', 'Four'])
    // Placed as the window last saw them: One (gone since) and without Five (added since).
    expect(await inWorkspace(w, () => placePanes(alpha, 'columns2', ['Two', 'One', 'Three', 'Four']))).toEqual(['Two', 'Five', 'Three', 'Four'])
    expect((await view()).placement!.columns2).toEqual(['Two', 'Five', 'Three', 'Four'])
    expect(order()).toBe('Two,Five,Three,Four')
    // The grid of six's placement takes Five in too, in its first empty cell.
    expect((await view()).placement!.grid6).toEqual(['Three', 'Five', 'Two', 'Four'])
  })

  it('kept across a restart', async () => {
    await start(['One', 'Two'])
    await inWorkspace(w, () => placePanes(alpha, 'grid6', [null, null, 'Two', null, 'One']))
    const before = (await view()).placement!
    expect(before.grid6).toEqual([null, null, 'Two', null, 'One'])
    disposeWorkspaceService(w)
    w = createWorkspaceService()
    await w.open(wsPath)
    expect((await w.projectConfig(alpha)).placement).toEqual(before)
  })
})
