// A project's view out of project.json (HI-1749, Darren's decision): the Session tab's Panes or Tiles, layout and pane
// placement are this user's UI state (config.ui.projectViews), so a view switch writes no project file, and another program
// holding project.json can't make it fail; the config is still written at once. A replace that gives up on a held file is
// in hive.log, with the processes Windows says have it open; any IPC failure that isn't Hive's own refusal is logged too.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

// Each replace of a project.json, and how many of the next ones fail as a file held open does (EPERM).
const fs = vi.hoisted(() => ({ renames: 0, failNext: 0 }))
vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>()
  const rename = async (from: string, to: string): Promise<void> => {
    if (String(to).endsWith('project.json')) {
      fs.renames++
      if (fs.failNext > 0) {
        fs.failNext--
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' })
      }
    }
    return real.rename(from, to)
  }
  return { ...real, default: { ...real, rename }, rename }
})
// The files module's warnings, kept.
const warned = vi.hoisted(() => [] as string[])
vi.mock('../src/main/logger', async (original) => {
  const real = await original<typeof import('../src/main/logger')>()
  return {
    ...real,
    createLogger: (scope: string) => {
      const l = real.createLogger(scope)
      return { ...l, warn: (m: string, e?: unknown) => (warned.push(`[${scope}] ${m}`), l.warn(m, e)) }
    }
  }
})

const base = tempDir('hive-project-view-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, projectViewKey } = await import('../src/main/workspace')
const { config } = await import('../src/main/config')
const { renameDiagnostics } = await import('../src/main/fsutil')

const wsPath = join(base, 'ws')
const alpha = join(wsPath, 'alpha')
const file = join(alpha, '.hive', 'project.json')
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>

beforeAll(async () => {
  mkdirSync(join(alpha, '.hive'), { recursive: true })
  // As a project's file was before HI-1749: its view in it.
  writeFileSync(file, JSON.stringify({ version: 2, id: 'p-0a1b2c3d', agents: [], sessionView: 'tiles', layout: 'columns2', placement: { columns2: [null, null] } }))
  w = createWorkspaceService()
  await w.open(wsPath)
})
afterAll(async () => disposeWorkspaceService(w))
beforeEach(() => {
  fs.failNext = 0
  warned.length = 0
})

describe("a project's view (HI-1749)", () => {
  it("is taken from project.json into this user's UI state on its first read, so no one loses a layout", async () => {
    const cfg = await run(() => w.projectConfig(alpha))
    expect(cfg).toMatchObject({ sessionView: 'tiles', layout: 'columns2', placement: { columns2: [null, null] } })
    expect(config.get().ui.projectViews?.[projectViewKey({ id: 'p-0a1b2c3d' }, alpha)]).toEqual({ sessionView: 'tiles', layout: 'columns2', placement: { columns2: [null, null] } })
  })

  it("is switched without writing project.json: a file held open past every retry doesn't stop it", async () => {
    fs.failNext = 1000
    const before = fs.renames
    const out = await run(() => w.updateProjectConfig(alpha, { sessionView: 'panes' }))
    expect(out.sessionView).toBe('panes')
    expect(fs.renames).toBe(before)
    expect((await run(() => w.projectConfig(alpha))).sessionView).toBe('panes')
    expect(config.get().ui.projectViews?.[projectViewKey({ id: 'p-0a1b2c3d' }, alpha)]?.sessionView).toBe('panes')
  })

  it('a change of the config is written at once, retried while the file is held, and leaves the view out of the file', async () => {
    fs.failNext = 3
    const out = await run(() => w.updateProjectConfig(alpha, { chime: 'on', layout: 'grid' }))
    expect(out).toMatchObject({ chime: 'on', layout: 'grid', sessionView: 'panes' })
    const saved = onDisk()
    expect(saved.chime).toBe('on')
    expect(saved).not.toHaveProperty('sessionView')
    expect(saved).not.toHaveProperty('layout')
    expect(saved).not.toHaveProperty('placement')
    expect((await run(() => w.projectConfig(alpha))).layout).toBe('grid')
    expect(warned.filter((l) => l.includes('replacing'))).toEqual([])
  })

  it('a replace that gives up on a held file is in hive.log, with what had it open', async () => {
    renameDiagnostics.holders = async () => ['4242 Some Indexer']
    try {
      fs.failNext = 1000
      await expect(run(() => w.updateProjectConfig(alpha, { chime: 'off' }))).rejects.toThrow(/EPERM/)
      await vi.waitFor(() => expect(warned.some((l) => l.includes('was open in'))).toBe(true), { timeout: 15_000 })
      const gaveUp = warned.find((l) => l.includes('replacing'))!
      expect(gaveUp).toMatch(/^\[files\] replacing .*project\.json.* failed with EPERM after 21 tries over \d+ ms: another process had it open$/)
      expect(warned.find((l) => l.includes('was open in'))).toMatch(/project\.json.* was open in .*4242 Some Indexer/)
    } finally {
      renameDiagnostics.holders = null
      fs.failNext = 0
    }
    // The view was kept meanwhile, and the config as it was.
    expect((await run(() => w.projectConfig(alpha))).chime).toBe('on')
  })
})
