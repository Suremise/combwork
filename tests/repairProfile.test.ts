// What Hive's profile keeps by a workspace's folder follows it when Repair… repairs a move (HI-2007, from HI-1968's
// sweep): its window's pin (config.json's alwaysOnTop), its close command's runs (close-commands/ws-<name>-<place>-…)
// and its Assistant's old token file, which goes. A copy's original, its folder still there, keeps its own. The
// workspace and Repair are real; the profile is the test's; no session or close command is started.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('repairprofile-')
const profile = join(base, 'profile')
;(electron.app as unknown as { getPath: () => string }).getPath = () => profile
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { checkMoved, repairMove } = await import('../src/main/workspaceMove')
const { config } = await import('../src/main/config')
const { pinnedFor } = await import('../src/main/pin')
const { runFolderName, runPrefix } = await import('../src/main/closeCommand/runs')
const { assistantTokenFile } = await import('../src/main/assistantControl')

const open: InstanceType<typeof import('../src/main/workspace').WorkspaceService>[] = []
afterAll(async () => {
  for (const w of open) await disposeWorkspaceService(w)
})

/** A workspace with one project, opened and recorded where it is (lastPath), with a pin, two ended runs and a token. */
async function pinnedWorkspace(root: string): Promise<{ ws: ReturnType<typeof createWorkspaceService>; at: string; runs: string[] }> {
  const at = join(root, 'ws')
  mkdirSync(join(at, 'alpha', '.hive'), { recursive: true })
  writeFileSync(join(at, 'alpha', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  const ws = createWorkspaceService()
  open.push(ws)
  await ws.open(at)
  await inWorkspace(ws, () => checkMoved(ws))
  config.update((c) => {
    c.alwaysOnTop = { ...c.alwaysOnTop, [at.toLowerCase()]: true }
  })
  const runs = [1, 2].map((i) => `${runFolderName(runPrefix('workspace', ws.openPlace), new Date(Date.UTC(2026, 9, 29, 12, 0, i)))}-0000000${i}`)
  for (const r of runs) {
    mkdirSync(join(profile, 'close-commands', r), { recursive: true })
    writeFileSync(join(profile, 'close-commands', r, 'status.json'), JSON.stringify({ state: 'exited', runnerPid: 1 }))
  }
  mkdirSync(join(profile, 'assistant-api'), { recursive: true })
  writeFileSync(assistantTokenFile(at), '{}')
  return { ws, at, runs }
}

const runsNamed = (prefix: string): string[] => readdirSync(join(profile, 'close-commands')).filter((n) => n.startsWith(prefix))

describe('Repair… carries what the profile keeps by the workspace folder (HI-2007)', () => {
  it('moved: the pin, the close-command runs and none of the old token file', async () => {
    const { ws, at, runs } = await pinnedWorkspace(join(base, 'one'))
    const oldPrefix = runPrefix('workspace', ws.openPlace)
    await ws.close()
    const to = join(base, 'one-moved', 'ws')
    mkdirSync(join(base, 'one-moved'))
    renameSync(at, to)
    await ws.open(to)
    const report = await inWorkspace(ws, () => repairMove(ws))
    expect(report.failed).toEqual([])
    expect([pinnedFor(to), pinnedFor(at)]).toEqual([true, false])
    expect(runsNamed(oldPrefix)).toEqual([])
    const newPrefix = runPrefix('workspace', ws.openPlace)
    expect(runsNamed(newPrefix).map((n) => n.slice(newPrefix.length)).sort()).toEqual(runs.map((n) => n.slice(oldPrefix.length)).sort())
    expect(existsSync(assistantTokenFile(at))).toBe(false)
  })

  it("copied (the old folder still there): the original keeps its pin, runs and token", async () => {
    const { ws, at, runs } = await pinnedWorkspace(join(base, 'two'))
    await ws.close()
    const to = join(base, 'two-copy', 'ws')
    // The copy's folder: the same files, the original left where it was.
    mkdirSync(join(to, 'alpha', '.hive'), { recursive: true })
    writeFileSync(join(to, 'alpha', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    mkdirSync(join(to, '.hive'), { recursive: true })
    for (const f of readdirSync(join(at, '.hive')).filter((n) => n.endsWith('.json')))
      writeFileSync(join(to, '.hive', f), readFileSync(join(at, '.hive', f)))
    await ws.open(to)
    await inWorkspace(ws, () => repairMove(ws))
    expect([pinnedFor(at), pinnedFor(to)]).toEqual([true, false])
    expect(runsNamed('ws-')).toEqual(expect.arrayContaining(runs))
    expect(existsSync(assistantTokenFile(at))).toBe(true)
  })
})
