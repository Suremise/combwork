// What Hive's profile keeps by a workspace's folder follows it when the workspace moves (HI-2007, from HI-1968's sweep):
// its window's pin (config.json's alwaysOnTop), its close command's runs (close-commands/ws-<name>-<place>-…) and its
// Assistant's old token file, which goes. Recorded when the move is first seen and tried at each open and Repair until
// all of it has followed, whatever Repair's plan says (HR2's round 1): a move with nothing else to repair, a run still
// going, a rename that fails. A copy's original, its folder still there, keeps its own. The workspace and Repair are
// real; the profile is the test's; no session or close command is started.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

// A run's rename that fails while `failing` is set (a folder another program holds), as Windows refuses one.
const renames = vi.hoisted(() => ({ failing: false }))
vi.mock('original-fs/promises', async (orig) => {
  const real = await orig<typeof import('fs/promises')>()
  const run = (p: string): boolean => /[\\/]close-commands[\\/]/.test(p)
  return { ...real, rename: (a: string, b: string) => (renames.failing && run(a) ? Promise.reject(new Error('EBUSY: resource busy or locked (test)')) : real.rename(a, b)) }
})

const base = tempDir('repairprofile-')
const profile = join(base, 'profile')
;(electron.app as unknown as { getPath: () => string }).getPath = () => profile
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { checkMoved, repairMove } = await import('../src/main/workspaceMove')
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
/** A run of the workspace's close command, kept in the profile with `status`. */
function addRun(ws: WS, i: number, status: object): string {
  const name = `${runFolderName(runPrefix('workspace', ws.openPlace), new Date(Date.UTC(2026, 9, 29, 12, 0, i)))}-0000000${i}`
  mkdirSync(join(profile, 'close-commands', name), { recursive: true })
  writeFileSync(join(profile, 'close-commands', name, 'status.json'), JSON.stringify(status))
  return name
}

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

/** Closes the workspace, moves its folder and opens it there, as the window does (checkMoved as it opens). */
async function moved(ws: WS, at: string, root: string): Promise<string> {
  await ws.close()
  const to = join(root, 'ws')
  mkdirSync(root)
  renameSync(at, to)
  await ws.open(to)
  await inWorkspace(ws, () => checkMoved(ws))
  return to
}

const runsNamed = (prefix: string): string[] => readdirSync(join(profile, 'close-commands')).filter((n) => n.startsWith(prefix))
const tail = (names: string[], prefix: string): string[] => names.map((n) => n.slice(prefix.length)).sort()
const pending = (to: string): number => (config.get().profileMoves ?? []).filter((m) => m.to.toLowerCase() === to.toLowerCase()).length

describe('what the profile keeps by the workspace folder follows a move (HI-2007)', () => {
  it('moved and repaired: the pin, the close-command runs and none of the old token file', async () => {
    const { ws, at, runs } = await pinnedWorkspace(join(base, 'one'))
    const oldPrefix = runPrefix('workspace', ws.openPlace)
    const to = await moved(ws, at, join(base, 'one-moved'))
    const report = await inWorkspace(ws, () => repairMove(ws))
    expect(report.failed).toEqual([])
    expect([pinnedFor(to), pinnedFor(at)]).toEqual([true, false])
    expect(runsNamed(oldPrefix)).toEqual([])
    const newPrefix = runPrefix('workspace', ws.openPlace)
    expect(tail(runsNamed(newPrefix), newPrefix)).toEqual(tail(runs, oldPrefix))
    expect(existsSync(assistantTokenFile(at))).toBe(false)
    expect(pending(to)).toBe(0)
  })

  it('with nothing else to repair (no project, not in Open Recent): all of it follows as the workspace opens (HR2, finding 1)', async () => {
    const { ws, at, runs } = await pinnedWorkspace(join(base, 'bare'), false)
    const oldPrefix = runPrefix('workspace', ws.openPlace)
    config.update((c) => {
      c.recentWorkspaces = c.recentWorkspaces.filter((p) => p.toLowerCase() !== at.toLowerCase())
    })
    const to = await moved(ws, at, join(base, 'bare-moved'))
    expect([pinnedFor(to), pinnedFor(at)]).toEqual([true, false])
    const newPrefix = runPrefix('workspace', ws.openPlace)
    expect(tail(runsNamed(newPrefix), newPrefix)).toEqual(tail(runs, oldPrefix))
    expect(existsSync(assistantTokenFile(at))).toBe(false)
    expect(pending(to)).toBe(0)
    expect((await inWorkspace(ws, () => repairMove(ws))).complete).toBe(true)
  })

  it('a run still going stays at the old place, and follows at a later open once it has ended (HR2, finding 2)', async () => {
    const { ws, at } = await pinnedWorkspace(join(base, 'going'))
    const oldPrefix = runPrefix('workspace', ws.openPlace)
    // Its runner alive: this test's own process.
    const going = addRun(ws, 3, { state: 'running', runnerPid: process.pid })
    const to = await moved(ws, at, join(base, 'going-moved'))
    const first = await inWorkspace(ws, () => repairMove(ws))
    expect(first.failed).toEqual([])
    expect(runsNamed(oldPrefix)).toEqual([going])
    expect(pending(to)).toBe(1)
    // It ends; the next open carries it, and nothing is left to carry.
    writeFileSync(join(profile, 'close-commands', going, 'status.json'), JSON.stringify(ENDED))
    await ws.close()
    await ws.open(to)
    await inWorkspace(ws, () => checkMoved(ws))
    expect(runsNamed(oldPrefix)).toEqual([])
    const newPrefix = runPrefix('workspace', ws.openPlace)
    expect(runsNamed(newPrefix).map((n) => n.slice(newPrefix.length))).toContain(going.slice(oldPrefix.length))
    expect(pending(to)).toBe(0)
  })

  it("a rename that fails: Repair says so and isn't complete; the next one carries it (HR2, finding 2)", async () => {
    const { ws, at, runs } = await pinnedWorkspace(join(base, 'locked'))
    const oldPrefix = runPrefix('workspace', ws.openPlace)
    renames.failing = true
    let to: string
    let first: Awaited<ReturnType<typeof repairMove>>
    try {
      to = await moved(ws, at, join(base, 'locked-moved'))
      first = await inWorkspace(ws, () => repairMove(ws))
    } finally {
      renames.failing = false
    }
    expect(first.complete).toBe(false)
    expect(first.rows.filter((r) => r.what.kind === 'closeRuns' && r.outcome === 'failed')).toHaveLength(runs.length)
    expect(tail(runsNamed(oldPrefix), oldPrefix)).toEqual(tail(runs, oldPrefix))
    expect(pending(to)).toBe(1)
    const second = await inWorkspace(ws, () => repairMove(ws))
    expect(second.failed).toEqual([])
    expect(second.complete).toBe(true)
    expect(runsNamed(oldPrefix)).toEqual([])
    expect(pending(to)).toBe(0)
  })

  it('copied (the old folder still there): the original keeps its pin, runs and token', async () => {
    const { ws, at, runs } = await pinnedWorkspace(join(base, 'two'))
    await ws.close()
    const to = join(base, 'two-copy', 'ws')
    // The copy's folder: the same files, the original left where it was.
    mkdirSync(join(to, 'alpha', '.hive'), { recursive: true })
    writeFileSync(join(to, 'alpha', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    mkdirSync(join(to, '.hive'), { recursive: true })
    for (const f of readdirSync(join(at, '.hive')).filter((n) => n.endsWith('.json'))) writeFileSync(join(to, '.hive', f), readFileSync(join(at, '.hive', f)))
    await ws.open(to)
    await inWorkspace(ws, () => checkMoved(ws))
    await inWorkspace(ws, () => repairMove(ws))
    expect([pinnedFor(at), pinnedFor(to)]).toEqual([true, false])
    expect(runsNamed('ws-')).toEqual(expect.arrayContaining(runs))
    expect(existsSync(assistantTokenFile(at))).toBe(true)
    expect(pending(to)).toBe(0)
  })
})
