// A project's view out of project.json (HI-1749, Darren's decision): the Session tab's Panes or Tiles, layout and pane
// placement are this user's UI state (config.ui.projectViews), so a view switch writes no project file, and another program
// holding project.json can't make it fail; the config is still written at once. A replace that gives up on a held file is
// in hive.log, with the processes Windows says have it open, those lookups bounded; any IPC failure that isn't Combwork's own
// refusal is logged too. Each case has a project, workspace and UI state of its own.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const { renameDiagnostics, renameRetrying, holderLookupsRunning } = await import('../src/main/fsutil')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 15_000
const ID = 'p-0a1b2c3d'
let n = 0
let w: ReturnType<typeof createWorkspaceService>
let alpha: string
let file: string
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
const savedView = () => config.get().ui.projectViews?.[projectViewKey({ id: ID }, alpha)]

beforeEach(async () => {
  fs.failNext = 0
  warned.length = 0
  config.update((c) => {
    c.ui.projectViews = {}
  })
  // A workspace of its own, its project's file as it was before HI-1749: its view in it.
  const wsPath = join(base, `ws-${++n}`)
  alpha = join(wsPath, 'alpha')
  file = join(alpha, '.combwork', 'project.json')
  mkdirSync(join(alpha, '.combwork'), { recursive: true })
  writeFileSync(file, JSON.stringify({ version: 2, id: ID, agents: [], chime: 'on', sessionView: 'tiles', layout: 'columns2', placement: { columns2: [null, null] } }))
  w = createWorkspaceService()
  await w.open(wsPath)
})
afterEach(async () => {
  fs.failNext = 0
  renameDiagnostics.holders = null
  await disposeWorkspaceService(w)
})

describe("a project's view (HI-1749)", () => {
  it("is taken from project.json into this user's UI state on its first read, so no one loses a layout", async () => {
    const cfg = await run(() => w.projectConfig(alpha))
    expect(cfg).toMatchObject({ sessionView: 'tiles', layout: 'columns2', placement: { columns2: [null, null] } })
    expect(savedView()).toEqual({ sessionView: 'tiles', layout: 'columns2', placement: { columns2: [null, null] } })
  })

  it("is switched without writing project.json: a file held open past every retry doesn't stop it", async () => {
    fs.failNext = 1000
    const before = fs.renames
    const out = await run(() => w.updateProjectConfig(alpha, { sessionView: 'panes' }))
    expect(out.sessionView).toBe('panes')
    expect(fs.renames).toBe(before)
    expect((await run(() => w.projectConfig(alpha))).sessionView).toBe('panes')
    expect(savedView()?.sessionView).toBe('panes')
  })

  it('a change of the config is written at once, retried while the file is held, and leaves the view out of the file', async () => {
    fs.failNext = 3
    const out = await run(() => w.updateProjectConfig(alpha, { chime: 'off', layout: 'grid' }))
    expect(out).toMatchObject({ chime: 'off', layout: 'grid', sessionView: 'tiles' })
    const saved = onDisk()
    expect(saved.chime).toBe('off')
    expect(saved).not.toHaveProperty('sessionView')
    expect(saved).not.toHaveProperty('layout')
    expect(saved).not.toHaveProperty('placement')
    expect((await run(() => w.projectConfig(alpha))).layout).toBe('grid')
    expect(warned.filter((l) => l.includes('replacing'))).toEqual([])
  })

  it('a replace that gives up on a held file is in hive.log, with what had it open', async () => {
    renameDiagnostics.holders = async () => ['4242 Some Indexer']
    fs.failNext = 1000
    await expect(run(() => w.updateProjectConfig(alpha, { chime: 'off' }))).rejects.toThrow(/EPERM/)
    await vi.waitFor(() => expect(warned.some((l) => l.includes('was open in'))).toBe(true), { timeout: HUNG_MS })
    const gaveUp = warned.find((l) => l.includes('replacing'))!
    expect(gaveUp).toMatch(/^\[files\] replacing .*project\.json.* failed with EPERM after 21 tries over \d+ ms: another process had it open$/)
    expect(warned.find((l) => l.includes('was open in'))).toMatch(/project\.json.* was open in .*4242 Some Indexer/)
    // The config as it was: the failed change isn't kept.
    fs.failNext = 0
    expect((await run(() => w.projectConfig(alpha))).chime).toBe('on')
  })
})

describe('looking up what held a file (HI-1749)', () => {
  const held = async (): Promise<never> => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
  }
  const giveUp = (path: string) => renameRetrying(`${path}.tmp`, path, 0, undefined, held).catch(() => undefined)
  const deferred = () => {
    let resolve!: (v: string[]) => void
    return { promise: new Promise<string[]>((r) => (resolve = r)), resolve }
  }

  it('runs a few at once, one per file, queues none, and frees its place when one ends or times out', async () => {
    const pending: { path: string; d: ReturnType<typeof deferred> }[] = []
    renameDiagnostics.holders = (path) => {
      const d = deferred()
      pending.push({ path, d })
      return d.promise
    }
    const { max, timeoutMs } = renameDiagnostics
    try {
      renameDiagnostics.max = 2
      // Failures at once: two of a.json, then b.json, c.json and d.json; only a.json's and b.json's holders are looked up.
      await Promise.all(['a.json', 'a.json', 'b.json', 'c.json', 'd.json'].map((f) => giveUp(join(base, f))))
      expect(pending.map((p) => p.path)).toEqual([join(base, 'a.json'), join(base, 'b.json')])
      expect(holderLookupsRunning()).toBe(2)
      expect(warned.filter((l) => l.includes('replacing'))).toHaveLength(5)
      expect(warned.filter((l) => l.includes('not looking up'))).toHaveLength(2)

      // One ends: its place is free, and the next file's lookup starts.
      pending[0].d.resolve(['7 Editor'])
      await vi.waitFor(() => expect(holderLookupsRunning()).toBe(1), { timeout: HUNG_MS })
      expect(warned.some((l) => /a\.json.* was open in .*7 Editor/.test(l))).toBe(true)
      await giveUp(join(base, 'c.json'))
      expect(pending.map((p) => p.path)).toEqual([join(base, 'a.json'), join(base, 'b.json'), join(base, 'c.json')])

      // One that never answers is given up on, and frees its place too.
      renameDiagnostics.timeoutMs = 20
      await giveUp(join(base, 'e.json'))
      expect(pending).toHaveLength(3)
      pending[2].d.resolve([])
      await vi.waitFor(() => expect(holderLookupsRunning()).toBe(1), { timeout: HUNG_MS })
      await giveUp(join(base, 'e.json'))
      expect(pending).toHaveLength(4)
      await vi.waitFor(() => expect(warned.some((l) => /could not tell what had .*e\.json.* open/.test(l))).toBe(true), { timeout: HUNG_MS })
      // b.json's lookup took the old bound; ended now, nothing is left running.
      pending[1].d.resolve([])
      await vi.waitFor(() => expect(holderLookupsRunning()).toBe(0), { timeout: HUNG_MS })
    } finally {
      renameDiagnostics.max = max
      renameDiagnostics.timeoutMs = timeoutMs
    }
  })
})
