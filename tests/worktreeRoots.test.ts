// Agents' worktrees as the workspace routes them (#784): projectForRoot, ownsRoot and assertRoot follow the newest read
// or write of a project's config, whatever order reads end in. A read begun before another, or before a change, and
// ending after it found older worktrees: it changes nothing, so a removed agent's worktree isn't accepted again and a
// current one stays recognised; nor does a read begun before a refresh found its project gone put that project's back,
// nor a refresh of a workspace closed or switched meanwhile record its worktrees in the next one.
import { AsyncLocalStorage } from 'async_hooks'
import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { ProjectConfig } from '../src/shared/types'
import { tempDir } from './tempDir'
import { legacyWorktree } from '../src/shared/agentFolders'

const base = tempDir('hive-worktreeroots-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

describe("agents' worktrees follow the newest config read, in whatever order reads end (#784)", () => {
  // Each case has a workspace of its own, with alpha's agent in tree('old') and gamma's in tree('gamma').
  let wsPath: string
  let trees: string
  let w: ReturnType<typeof createWorkspaceService>
  const alpha = () => join(wsPath, 'alpha')
  const gamma = () => join(wsPath, 'gamma')
  const tree = (name: string) => join(trees, name)
  const withTree = (path: string) => ({ version: 2, layout: 'auto', agents: [{ id: 'a1', name: 'B1', provider: 'claude-code', worktree: { path, branch: 'hive/b1', base: 'main' } }] })
  const project = (ws: string, name: string, worktree: string) => {
    mkdirSync(join(ws, name, '.hive'), { recursive: true })
    writeFileSync(join(ws, name, '.hive', 'project.json'), JSON.stringify(withTree(worktree)))
  }
  const moveTo = (name: string) => (c: ProjectConfig) => ({ agents: c.agents.map((a) => ({ ...a, worktree: { path: tree(name), branch: 'hive/b1', base: 'main' } })) })
  const routed = (path: string) => ({ project: w.projectForRoot(path), owned: w.ownsRoot(join(path, 'src').toLowerCase()), allowed: (() => { try { w.assertRoot(path); return true } catch { return false } })() })
  const current = (owner: string) => ({ project: owner, owned: true, allowed: true })
  const unknown = { project: null, owned: false, allowed: false }
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)

  // Holds the first read of `target`'s config made in the test's 'older' context once it has read the file, as a read
  // begun just before a change and slow to end. Refreshes the watcher schedules meanwhile run outside that context.
  const mine = new AsyncLocalStorage<string>()
  const older = <T>(fn: () => Promise<T>): Promise<T> => mine.run('older', () => run(fn))
  const holdOlderRead = (target: string) => {
    const service = w as unknown as { projectConfig: (p: string) => Promise<ProjectConfig> }
    const real = service.projectConfig.bind(w)
    const gate: { open: () => void } = { open: () => undefined }
    const released = new Promise<void>((r) => (gate.open = r))
    const state = { holding: true }
    const spy = vi.spyOn(service, 'projectConfig').mockImplementation(async (p: string) => {
      const cfg = await real(p)
      if (state.holding && p === target && mine.getStore() === 'older') {
        state.holding = false
        await released
      }
      return cfg
    })
    return { held: () => vi.waitFor(() => expect(state.holding).toBe(false), { timeout: HUNG_MS }), release: () => gate.open(), restore: () => (gate.open(), spy.mockRestore()) }
  }

  beforeEach(async () => {
    wsPath = tempDir('hive-worktreeroots-ws-')
    trees = tempDir('hive-worktreeroots-trees-')
    project(wsPath, 'alpha', tree('old'))
    project(wsPath, 'gamma', tree('gamma'))
    w = createWorkspaceService()
    await w.open(wsPath)
    // The refresh the open scheduled reads the projects' files: Windows won't rename gamma with one open (#1375: EPERM),
    // and each case's reads are its own.
    await w.refreshesSettled()
  })
  afterEach(async () => disposeWorkspaceService(w))

  it('an older refresh ending after a change and a newer refresh changes nothing: the removed worktree stays out, the new one in', async () => {
    expect(routed(tree('old'))).toEqual(current(alpha()))
    const hold = holdOlderRead(alpha())
    try {
      const first = older(() => w.refresh())
      await hold.held()
      // Meanwhile the agent moves to another worktree, and a newer refresh reports it.
      await run(() => w.mutateProjectConfig(alpha(), moveTo('new')))
      expect(legacyWorktree((await run(() => w.refresh())).projects.find((p) => p.path === alpha())?.agents[0])?.path).toBe(tree('new'))
      hold.release()
      await first
    } finally {
      hold.restore()
    }
    expect(legacyWorktree(w.info()?.projects.find((p) => p.path === alpha())?.agents[0])?.path).toBe(tree('new'))
    expect(routed(tree('new'))).toEqual(current(alpha()))
    expect(routed(tree('old'))).toEqual(unknown)
  })

  it('an older read on its own ending after a newer one (the file changed by hand between) changes nothing', async () => {
    const hold = holdOlderRead(alpha())
    try {
      const first = older(() => w.projectInfo(alpha()))
      await hold.held()
      writeFileSync(join(alpha(), '.hive', 'project.json'), JSON.stringify(withTree(tree('new'))))
      expect(legacyWorktree((await run(() => w.projectInfo(alpha()))).agents[0])?.path).toBe(tree('new'))
      hold.release()
      // What it read is from before: it says so to its caller, and routes nothing.
      expect(legacyWorktree((await first).agents[0])?.path).toBe(tree('old'))
    } finally {
      hold.restore()
    }
    expect(routed(tree('new'))).toEqual(current(alpha()))
    expect(routed(tree('old'))).toEqual(unknown)
  })

  it("a read begun before a refresh found its project gone doesn't put that project's worktree back", async () => {
    expect(routed(tree('gamma'))).toEqual(current(gamma()))
    const hold = holdOlderRead(gamma())
    try {
      const first = older(() => w.projectInfo(gamma()))
      await hold.held()
      // Renamed to a folder that isn't a project (a dot first), and the refresh says it is gone.
      renameSync(gamma(), join(wsPath, '.gamma-gone'))
      expect((await run(() => w.refresh())).projects.map((p) => p.path)).toEqual([alpha()])
      expect(routed(tree('gamma'))).toEqual(unknown)
      hold.release()
      await first
    } finally {
      hold.restore()
    }
    expect(routed(tree('gamma'))).toEqual(unknown)
    // The project still here keeps its own.
    expect(routed(tree('old'))).toEqual(current(alpha()))
  })

  it("a refresh of a workspace switched meanwhile records none of its worktrees in the next one, read or yet to read", async () => {
    const next = tempDir('hive-worktreeroots-next-')
    project(next, 'delta', tree('delta'))
    const hold = holdOlderRead(alpha())
    let first: Promise<unknown> = Promise.resolve()
    try {
      // Held reading alpha: gamma is still to read when the window switches to another workspace.
      first = older(() => w.refresh()).then(() => 'reported', (e: Error) => e.message)
      await hold.held()
      await run(() => w.open(next))
      hold.release()
      expect(await first).toMatch(/closed/i)
    } finally {
      hold.restore()
    }
    expect(routed(tree('old'))).toEqual(unknown)
    expect(routed(tree('gamma'))).toEqual(unknown)
    expect(routed(tree('delta'))).toEqual(current(join(next, 'delta')))
  })

  it('reads and changes in order still route each change, and a project made again is read again', async () => {
    await run(() => w.mutateProjectConfig(alpha(), moveTo('new')))
    expect(routed(tree('new'))).toEqual(current(alpha()))
    expect(routed(tree('old'))).toEqual(unknown)
    renameSync(gamma(), join(wsPath, '.gamma-gone'))
    await run(() => w.refresh())
    expect(routed(tree('gamma'))).toEqual(unknown)
    renameSync(join(wsPath, '.gamma-gone'), gamma())
    await run(() => w.refresh())
    expect(routed(tree('gamma'))).toEqual(current(gamma()))
  })

  it("a project's slots and retired homes (#1442) are roots from the read that found them until one that doesn't, a config change between", async () => {
    const found: { folders: { path: string; name: string; is: 'slot' | 'home' }[] } = { folders: [{ path: tree('slot-a'), name: 'slot-a', is: 'slot' }, { path: tree('hr1'), name: 'hr1', is: 'home' }] }
    w.setLiveProvider(async (p, cfg) => ({ live: null, restartNeeded: false, agents: (cfg.agents ?? []).map((a) => ({ ...a, live: null, restartNeeded: false, resume: null, place: { folder: p, is: 'project' as const, name: null, branch: null } })), folders: p === alpha() ? found.folders : [] }))
    try {
      await run(() => w.refresh())
      expect([routed(tree('slot-a')), routed(tree('hr1'))]).toEqual([current(alpha()), current(alpha())])
      // A change to alpha's config records its worktrees again: its slots stay.
      await run(() => w.mutateProjectConfig(alpha(), moveTo('new')))
      expect([routed(tree('slot-a')), routed(tree('new'))]).toEqual([current(alpha()), current(alpha())])
      // A read that finds the slot gone: no longer a root.
      found.folders = [found.folders[1]]
      await run(() => w.refresh())
      expect([routed(tree('slot-a')), routed(tree('hr1'))]).toEqual([unknown, current(alpha())])
      await w.close()
      expect(routed(tree('hr1'))).toEqual(unknown)
    } finally {
      w.setLiveProvider(async (p, cfg) => ({ live: null, restartNeeded: false, agents: (cfg.agents ?? []).map((a) => ({ ...a, live: null, restartNeeded: false, resume: null, place: { folder: p, is: 'project' as const, name: null, branch: null } })) }))
    }
  })

  // A read of `target` in the 'older' context, held once it has its folders (as a slow read ending late), finding `folders()`.
  const holdFolderRead = (target: string, folders: () => string[]) => {
    const gate: { open: () => void; reached: () => void } = { open: () => undefined, reached: () => undefined }
    const released = new Promise<void>((r) => (gate.open = r))
    const reached = new Promise<void>((r) => (gate.reached = r))
    w.setLiveProvider(async (p, cfg) => {
      const found = p === target ? folders().map((f) => ({ path: f, name: 'x', is: 'slot' as const })) : []
      if (p === target && mine.getStore() === 'older') {
        gate.reached()
        await released
      }
      return { live: null, restartNeeded: false, agents: (cfg.agents ?? []).map((a) => ({ ...a, live: null, restartNeeded: false, resume: null, place: { folder: p, is: 'project' as const, name: null, branch: null } })), folders: found }
    })
    return { reached, release: () => gate.open() }
  }
  const plainProvider = () => w.setLiveProvider(async (p, cfg) => ({ live: null, restartNeeded: false, agents: (cfg.agents ?? []).map((a) => ({ ...a, live: null, restartNeeded: false, resume: null, place: { folder: p, is: 'project' as const, name: null, branch: null } })) }))

  it("a late read's slots (#1442 round 1, HR2's case) neither come back as roots nor return at the next config write", async () => {
    let now = [tree('slot-old')]
    const hold = holdFolderRead(alpha(), () => now)
    try {
      const first = older(() => w.projectInfo(alpha()))
      await hold.reached
      now = [tree('slot-new')]
      await run(() => w.projectInfo(alpha()))
      hold.release()
      await first
      expect([routed(tree('slot-old')), routed(tree('slot-new'))]).toEqual([unknown, current(alpha())])
      // A config write records the roots again from what the newest read found, never the late one's.
      await run(() => w.mutateProjectConfig(alpha(), () => ({ layout: 'auto' })))
      expect([routed(tree('slot-old')), routed(tree('slot-new'))]).toEqual([unknown, current(alpha())])
    } finally {
      hold.release()
      plainProvider()
    }
  })

  it("a read begun before a refresh found its project gone records none of its slots, nor keeps them for later", async () => {
    const hold = holdFolderRead(gamma(), () => [tree('gamma-slot')])
    try {
      const first = older(() => w.projectInfo(gamma()))
      await hold.reached
      renameSync(gamma(), join(wsPath, '.gamma-gone'))
      await run(() => w.refresh())
      hold.release()
      await first.catch(() => undefined)
      expect(routed(tree('gamma-slot'))).toEqual(unknown)
      // Back again, read with no slots: still none.
      plainProvider()
      renameSync(join(wsPath, '.gamma-gone'), gamma())
      await run(() => w.refresh())
      expect([routed(tree('gamma-slot')), routed(tree('gamma'))]).toEqual([unknown, current(gamma())])
    } finally {
      hold.release()
      plainProvider()
    }
  })
})
