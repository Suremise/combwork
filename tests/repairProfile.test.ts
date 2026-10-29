// What Hive's profile keeps by a workspace's folder follows it when the workspace moves (HI-2007, from HI-1968's sweep;
// design HI-2007/s40 and s42): its window's pin (config.json's alwaysOnTop) and its close command's runs
// (close-commands/ws-<name>-<place>-…). The Assistant's old token file is left as it is. A move is recorded as the
// moved workspace opens, one record per old folder, and tried at each open and Repair until nothing is left there,
// whatever Repair's plan says: a move with nothing else to repair, a run still going, a rename that fails (kept on the
// banner until it is done), moves one after another, and a copy (its original keeps its own). Every change rechecks the
// workspace is still open there and the old folder still gone. The workspace and Repair are real; the profile is the
// test's; no session or close command is started.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import type { WorkspaceMoved } from '../src/shared/types'

// A run's rename: one that fails while `failing` is set (a folder another program holds, as Windows refuses), and
// `during`, run as one starts (the original coming back, the workspace closing).
const renames = vi.hoisted(() => ({ failing: false, during: null as null | (() => Promise<void>) }))
vi.mock('original-fs/promises', async (orig) => {
  const real = await orig<typeof import('fs/promises')>()
  const run = (p: string): boolean => /[\\/]close-commands[\\/]/.test(p)
  return {
    ...real,
    rename: async (a: string, b: string) => {
      if (!run(a)) return real.rename(a, b)
      if (renames.failing) throw new Error('EBUSY: resource busy or locked (test)')
      const during = renames.during
      renames.during = null
      await during?.()
      return real.rename(a, b)
    }
  }
})
afterEach(() => {
  renames.failing = false
  renames.during = null
})

const base = tempDir('repairprofile-')
const profile = join(base, 'profile')
;(electron.app as unknown as { getPath: () => string }).getPath = () => profile
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { checkMoved, repairMove } = await import('../src/main/workspaceMove')
const { moveHasWork } = await import('../src/shared/movePaths')
const { movePlan } = await import('../src/main/workspaceMove')
const { config } = await import('../src/main/config')
const { pinnedFor } = await import('../src/main/pin')
const { runFolderName, runPrefix } = await import('../src/main/closeCommand/runs')
const { assistantTokenFile } = await import('../src/main/assistantControl')

type WS = ReturnType<typeof createWorkspaceService>
const open: WS[] = []
afterAll(async () => {
  for (const w of open) await disposeWorkspaceService(w)
})

const ENDED = { state: 'exited', runnerPid: 1 }
// Its runner alive: this test's own process.
const GOING = { state: 'running', runnerPid: process.pid }
/** A run of the workspace's close command, kept in the profile with `status`. */
function addRun(ws: WS, i: number, status: object): string {
  const name = `${runFolderName(runPrefix('workspace', ws.openPlace), new Date(Date.UTC(2026, 9, 29, 12, 0, i)))}-0000000${i}`
  mkdirSync(join(profile, 'close-commands', name), { recursive: true })
  writeFileSync(join(profile, 'close-commands', name, 'status.json'), JSON.stringify(status))
  return name
}
const ended = (name: string): void => writeFileSync(join(profile, 'close-commands', name, 'status.json'), JSON.stringify(ENDED))

/** A workspace (with a project, or none), opened and recorded where it is (lastPath), with a pin, two ended runs and a token. */
async function pinnedWorkspace(root: string, project = true): Promise<{ ws: WS; at: string; runs: string[] }> {
  const at = join(root, 'ws')
  mkdirSync(join(at, '.hive'), { recursive: true })
  if (project) {
    mkdirSync(join(at, 'alpha', '.hive'), { recursive: true })
    writeFileSync(join(at, 'alpha', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  }
  const ws = createWorkspaceService()
  open.push(ws)
  await ws.open(at)
  await inWorkspace(ws, () => checkMoved(ws))
  config.update((c) => {
    c.alwaysOnTop = { ...c.alwaysOnTop, [at.toLowerCase()]: true }
  })
  const runs = [1, 2].map((i) => addRun(ws, i, ENDED))
  mkdirSync(join(profile, 'assistant-api'), { recursive: true })
  writeFileSync(assistantTokenFile(at), '{}')
  return { ws, at, runs }
}

/** Opens the workspace at `at`, as the window does (checkMoved as it opens). */
async function openAt(ws: WS, at: string): Promise<void> {
  await ws.open(at)
  await inWorkspace(ws, () => checkMoved(ws))
}
/** Closes the workspace, moves its folder into `root` and opens it there. */
async function moved(ws: WS, at: string, root: string): Promise<string> {
  await ws.close()
  const to = join(root, 'ws')
  mkdirSync(root)
  renameSync(at, to)
  await openAt(ws, to)
  return to
}
/** A copy of the workspace folder at `at` (its settings and project, the original left there) in `root`. */
function copied(at: string, root: string): string {
  const to = join(root, 'ws')
  mkdirSync(join(to, '.hive'), { recursive: true })
  for (const f of readdirSync(join(at, '.hive')).filter((n) => n.endsWith('.json'))) writeFileSync(join(to, '.hive', f), readFileSync(join(at, '.hive', f)))
  if (existsSync(join(at, 'alpha'))) {
    mkdirSync(join(to, 'alpha', '.hive'), { recursive: true })
    writeFileSync(join(to, 'alpha', '.hive', 'project.json'), readFileSync(join(at, 'alpha', '.hive', 'project.json')))
  }
  return to
}

const runsNamed = (prefix: string): string[] => readdirSync(join(profile, 'close-commands')).filter((n) => n.startsWith(prefix))
const tail = (names: string[], prefix: string): string[] => names.map((n) => n.slice(prefix.length)).sort()
const record = (from: string) => (config.get().profileMoves ?? []).find((m) => m.from.toLowerCase() === from.toLowerCase())
const prefixOf = (ws: WS): string => runPrefix('workspace', ws.openPlace)
/** What the window's banner and the palette's Repair go by (the workspace's info carries it to the window). */
const movedOf = (ws: WS): WorkspaceMoved | null => (ws as unknown as { moved: WorkspaceMoved | null }).moved

describe('what the profile keeps by the workspace folder follows a move (HI-2007)', () => {
  it('moved and repaired: the pin and the close-command runs; the old token file is left as it is', async () => {
    const { ws, at, runs } = await pinnedWorkspace(join(base, 'one'))
    const oldPrefix = prefixOf(ws)
    const to = await moved(ws, at, join(base, 'one-moved'))
    const report = await inWorkspace(ws, () => repairMove(ws))
    expect(report.failed).toEqual([])
    expect([pinnedFor(to), pinnedFor(at)]).toEqual([true, false])
    expect(runsNamed(oldPrefix)).toEqual([])
    expect(tail(runsNamed(prefixOf(ws)), prefixOf(ws))).toEqual(tail(runs, oldPrefix))
    expect(existsSync(assistantTokenFile(at))).toBe(true)
    expect(record(at)).toBeUndefined()
  })

  it('with nothing else to repair (no project, not in Open Recent): all of it follows as the workspace opens', async () => {
    const { ws, at, runs } = await pinnedWorkspace(join(base, 'bare'), false)
    const oldPrefix = prefixOf(ws)
    config.update((c) => {
      c.recentWorkspaces = c.recentWorkspaces.filter((p) => p.toLowerCase() !== at.toLowerCase())
    })
    const to = await moved(ws, at, join(base, 'bare-moved'))
    expect([pinnedFor(to), pinnedFor(at)]).toEqual([true, false])
    expect(tail(runsNamed(prefixOf(ws)), prefixOf(ws))).toEqual(tail(runs, oldPrefix))
    expect(record(at)).toBeUndefined()
    expect((await inWorkspace(ws, () => repairMove(ws))).complete).toBe(true)
  })

  it('a run still going stays at the old place, off the banner, and follows at a later open once it has ended', async () => {
    const { ws, at } = await pinnedWorkspace(join(base, 'going'))
    const oldPrefix = prefixOf(ws)
    const going = addRun(ws, 3, GOING)
    const to = await moved(ws, at, join(base, 'going-moved'))
    const first = await inWorkspace(ws, () => repairMove(ws))
    expect(first.failed).toEqual([])
    expect(runsNamed(oldPrefix)).toEqual([going])
    expect(record(at)).toMatchObject({ to })
    expect(record(at)?.failed).toBeUndefined()
    expect(movedOf(ws)?.profile).toBeUndefined()
    ended(going)
    await ws.close()
    await openAt(ws, to)
    expect(runsNamed(oldPrefix)).toEqual([])
    expect(tail(runsNamed(prefixOf(ws)), prefixOf(ws))).toContain(going.slice(oldPrefix.length))
    expect(record(at)).toBeUndefined()
  })

  it("a rename that fails: on the banner and Repair's plan, Repair isn't complete; the next one carries it and clears them", async () => {
    const { ws, at, runs } = await pinnedWorkspace(join(base, 'locked'))
    const oldPrefix = prefixOf(ws)
    renames.failing = true
    const to = await moved(ws, at, join(base, 'locked-moved'))
    const first = await inWorkspace(ws, () => repairMove(ws))
    renames.failing = false
    expect(first.complete).toBe(false)
    expect(first.rows.filter((r) => r.what.kind === 'closeRuns' && r.outcome === 'failed')).toHaveLength(runs.length)
    expect(tail(runsNamed(oldPrefix), oldPrefix)).toEqual(tail(runs, oldPrefix))
    expect(record(at)?.failed).toMatch(/EBUSY/)
    // The banner and the palette's Repair stay while it is pending (workspace.moved), with it in the plan.
    expect(movedOf(ws)?.profile).toEqual([{ from: at, failed: expect.stringMatching(/EBUSY/) }])
    const plan = (await inWorkspace(ws, () => movePlan(ws)))!
    expect(moveHasWork(plan)).toBe(true)
    const second = await inWorkspace(ws, () => repairMove(ws))
    expect(second.failed).toEqual([])
    expect(second.complete).toBe(true)
    expect(runsNamed(oldPrefix)).toEqual([])
    expect(record(at)).toBeUndefined()
    expect(movedOf(ws)).toBeNull()
    expect(pinnedFor(to)).toBe(true)
  })

  it('moved twice (A to B, then B to C): a run left at A follows to C', async () => {
    const { ws, at: a } = await pinnedWorkspace(join(base, 'chain-a'))
    const aPrefix = prefixOf(ws)
    const going = addRun(ws, 3, GOING)
    const b = await moved(ws, a, join(base, 'chain-b'))
    expect(record(a)).toMatchObject({ to: b })
    ended(going)
    const c = await moved(ws, b, join(base, 'chain-c'))
    expect(runsNamed(aPrefix)).toEqual([])
    expect(tail(runsNamed(prefixOf(ws)), prefixOf(ws))).toContain(going.slice(aPrefix.length))
    expect(record(a)).toBeUndefined()
    expect(record(b)).toBeUndefined()
    expect(pinnedFor(c)).toBe(true)
  })

  it("a copy of the moved workspace (B copied to C, B still there): C takes none of B's pending runs; B carries them itself", async () => {
    const { ws, at: a } = await pinnedWorkspace(join(base, 'own-a'))
    const aPrefix = prefixOf(ws)
    const going = addRun(ws, 3, GOING)
    const b = await moved(ws, a, join(base, 'own-b'))
    const bPrefix = prefixOf(ws)
    await ws.close()
    mkdirSync(join(base, 'own-c'))
    const c = copied(b, join(base, 'own-c'))
    await openAt(ws, c)
    ended(going)
    await inWorkspace(ws, () => repairMove(ws))
    await ws.close()
    expect(runsNamed(aPrefix)).toEqual([going])
    expect(record(a)).toMatchObject({ to: b })
    expect(record(b)).toBeUndefined()
    expect(pinnedFor(c)).toBe(false)
    await openAt(ws, b)
    expect(runsNamed(aPrefix)).toEqual([])
    expect(tail(runsNamed(bPrefix), bPrefix)).toContain(going.slice(aPrefix.length))
    expect(record(a)).toBeUndefined()
  })

  it('copied (the old folder still there): the original keeps its pin, runs and token', async () => {
    const { ws, at, runs } = await pinnedWorkspace(join(base, 'two'))
    await ws.close()
    mkdirSync(join(base, 'two-copy'))
    const to = copied(at, join(base, 'two-copy'))
    await openAt(ws, to)
    await inWorkspace(ws, () => repairMove(ws))
    expect([pinnedFor(at), pinnedFor(to)]).toEqual([true, false])
    expect(runsNamed('ws-')).toEqual(expect.arrayContaining(runs))
    expect(existsSync(assistantTokenFile(at))).toBe(true)
    expect(record(at)).toBeUndefined()
  })

  it('the original back while a run is renamed: the rest stays, and the record ends', async () => {
    const { ws, at, runs } = await pinnedWorkspace(join(base, 'back'))
    const oldPrefix = prefixOf(ws)
    addRun(ws, 3, ENDED)
    await ws.close()
    mkdirSync(join(base, 'back-moved'))
    const to = join(base, 'back-moved', 'ws')
    renameSync(at, to)
    // As the first run is renamed, a workspace is at the old folder again.
    renames.during = async () => {
      mkdirSync(join(at, '.hive'), { recursive: true })
    }
    await openAt(ws, to)
    // The newest went first; the two older ones stay with the workspace back there.
    expect(runsNamed(oldPrefix).sort()).toEqual([...runs].sort())
    expect(record(at)).toBeUndefined()
  })

  it('the workspace closed while a run is renamed: the rest stays, the record kept; the next open carries them', async () => {
    const { ws, at } = await pinnedWorkspace(join(base, 'closing'))
    const oldPrefix = prefixOf(ws)
    addRun(ws, 3, ENDED)
    await ws.close()
    mkdirSync(join(base, 'closing-moved'))
    const to = join(base, 'closing-moved', 'ws')
    renameSync(at, to)
    await ws.open(to)
    // As the first run is renamed, the workspace's lifetime ends, as a close or a switch ends it (close() then finishes).
    renames.during = async () => (ws as unknown as { life: AbortController }).life.abort()
    // The rest of checkMoved is refused for a closed workspace, as the window's call of it (which logs it) sees.
    await expect(inWorkspace(ws, () => checkMoved(ws))).rejects.toThrow(/closed/)
    await ws.close()
    expect(runsNamed(oldPrefix)).toHaveLength(2)
    expect(record(at)).toMatchObject({ to })
    await openAt(ws, to)
    expect(runsNamed(oldPrefix)).toEqual([])
    expect(record(at)).toBeUndefined()
  })
})
