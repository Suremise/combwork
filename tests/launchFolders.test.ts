// HI-3144: the launch folders of removed agents (`.combwork/launch-<agent id>`) go: with Remove Agent, in a sweep as a
// workspace opens (left from before, or by a crash) and from Storage's Clean Up (listed with their size). Never a current
// agent's, nor one whose agent is starting or running, nor anything else in `.combwork` (a near name, a file, a link), nor
// any when the project's agents can't be read.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DEFAULT_CLEANUP } from '../src/shared/storage'
import type { CleanupOptions } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('cw-launch-folders-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// The Recycle Bin, as deleting the folder.
;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = async (p) => rmSync(p, { recursive: true, force: true })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const lf = await import('../src/main/launchFolders')
const { launchFolderAgent, launchFolderName } = await import('../src/main/launchFolderNames')
const { cleanup, cleanupPreview } = await import('../src/main/storage')
const { removeAgent } = await import('../src/main/projectAgents')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'shop')
/** A project whose project.json can't be read: its agents unknown. */
const q = join(wsPath, 'unread')
const cw = (project: string, ...rest: string[]): string => join(project, '.combwork', ...rest)
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
/** Agents starting or running, as sessions.ts would say (by id). */
const busy = new Set<string>()

/** A launch folder as a launch leaves it: its plugin with a skill and its settings. */
function launchFolder(project: string, name: string): string {
  const dir = cw(project, name)
  mkdirSync(join(dir, 'plugin', 'skills', 'work-on-card'), { recursive: true })
  writeFileSync(join(dir, 'plugin', 'skills', 'work-on-card', 'SKILL.md'), 'x'.repeat(2048))
  writeFileSync(join(dir, 'sync.json'), '{}')
  return dir
}
const agents = (project: string, ids: string[]): void => writeFileSync(cw(project, 'project.json'), JSON.stringify({ version: 2, agents: ids.map((id) => ({ id, name: id, provider: 'claude-code' })) }))
/** The `launch-…` entries of a project's .combwork (its other files are the workspace's own). */
const entries = (project: string): string[] => readdirSync(cw(project)).filter((n) => n.startsWith('launch-')).sort()

describe('HI-3144: launch folders of removed agents', () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    for (const d of [p, q]) mkdirSync(cw(d), { recursive: true })
    agents(p, ['a-keep', 'a-busy0'])
    writeFileSync(cw(q, 'project.json'), '{ not json')
    // Left from before HI-3144: a current agent's, removed agents', one whose (removed) agent is starting, one set aside by a
    // stopped removal; and what is never a launch folder: a near name, a file of that name, a link, other folders.
    for (const n of ['launch-a-keep', 'launch-a-gone1', 'launch-a2', 'launch-a-busy1', 'launch-a-old.removing-0123abcd', 'launch-a-x.bak', 'launch-', 'sessions']) launchFolder(p, n)
    writeFileSync(cw(p, 'launch-a-file'), 'not a folder')
    symlinkSync(launchFolder(base, 'elsewhere'), cw(p, 'launch-a-link'), 'junction')
    launchFolder(q, 'launch-a-q')
    busy.add('a-busy1')
    lf.initLaunchFolders((_project, id) => busy.has(id))
    w = createWorkspaceService()
    // Opening it sweeps (initLaunchFolders' listener).
    await w.open(wsPath)
    await lf.launchSweepsSettled()
  })
  afterAll(async () => disposeWorkspaceService(w))

  it('names: only launch-<agent id> exactly', () => {
    expect(launchFolderName('a-1234abcd')).toBe('launch-a-1234abcd')
    expect(['launch-a-1234abcd', 'launch-a2', 'launch-', 'launch-a-x.bak', 'launch-a.removing-0123abcd', 'launch-../x', 'Launch-a'].map(launchFolderAgent)).toEqual(['a-1234abcd', 'a2', null, null, null, null, null])
  })

  it("the sweep as the workspace opens removes removed agents' folders, never a current or starting agent's nor anything else; an unreadable project keeps its own", async () => {
    expect(entries(p)).toEqual(['launch-', 'launch-a-busy1', 'launch-a-file', 'launch-a-keep', 'launch-a-link', 'launch-a-x.bak'])
    expect(existsSync(cw(p, 'sessions', 'sync.json'))).toBe(true)
    // The link went nowhere: its target is untouched.
    expect(existsSync(join(base, '.combwork', 'elsewhere', 'sync.json'))).toBe(true)
    expect(entries(q)).toEqual(['launch-a-q'])
    // Its agent no longer starting: the next sweep takes it.
    busy.delete('a-busy1')
    await lf.sweepLaunchFolders(w)
    expect(existsSync(cw(p, 'launch-a-busy1'))).toBe(false)
    expect(existsSync(cw(p, 'launch-a-keep'))).toBe(true)
  })

  it('a project.json missing says nothing of its agents: its launch folders stay', async () => {
    renameSync(cw(p, 'project.json'), cw(p, 'project.json.away'))
    try {
      launchFolder(p, 'launch-a-gone2')
      expect(await run(() => lf.staleLaunchFolders(p))).toEqual([])
      expect(await run(() => lf.removeLaunchFolder(p, 'a-gone2'))).toBe(false)
      expect(existsSync(cw(p, 'launch-a-gone2'))).toBe(true)
    } finally {
      renameSync(cw(p, 'project.json.away'), cw(p, 'project.json'))
    }
  })

  it('Remove Agent removes its launch folder', async () => {
    agents(p, ['a-keep', 'a-busy0', 'a-leaving'])
    launchFolder(p, 'launch-a-leaving')
    await run(() => removeAgent(p, 'a-leaving', { deleteWorktree: false }))
    expect(existsSync(cw(p, 'launch-a-leaving'))).toBe(false)
    expect(existsSync(cw(p, 'launch-a-keep'))).toBe(true)
    // A current agent's is never removed, asked directly; nor one whose agent is running.
    expect(await run(() => lf.removeLaunchFolder(p, 'a-keep'))).toBe(false)
    busy.add('a-gone2')
    expect(await run(() => lf.removeLaunchFolder(p, 'a-gone2'))).toBe(false)
    busy.delete('a-gone2')
  })

  it('Clean Up lists them with their size, and removes those still stale; one whose agent came back meanwhile is skipped', async () => {
    launchFolder(p, 'launch-a-gone3')
    const opts: CleanupOptions = { ...DEFAULT_CLEANUP, archivedAttachmentsDays: null }
    expect(DEFAULT_CLEANUP.launchFolders).toBe(true)
    const items = await run(() => cleanupPreview(p, opts))
    const launch = items.filter((i) => i.kind === 'launch-folder').sort((a, b) => a.path.localeCompare(b.path))
    expect(launch.map((i) => [i.path, i.label])).toEqual([
      [cw(p, 'launch-a-gone2'), 'Removed agent a-gone2'],
      [cw(p, 'launch-a-gone3'), 'Removed agent a-gone3']
    ])
    expect(launch.every((i) => i.bytes >= 2048)).toBe(true)
    // Off: none listed.
    expect((await run(() => cleanupPreview(p, { ...opts, launchFolders: false }))).filter((i) => i.kind === 'launch-folder')).toEqual([])
    // a-gone3 added back (an undo) between the preview and the removal: kept, and said.
    agents(p, ['a-keep', 'a-busy0', 'a-gone3'])
    const r = await run(() => cleanup(p, opts, launch.map((i) => i.path)))
    expect(r.removed).toBe(1)
    expect(r.skipped.join('\n')).toMatch(/launch-a-gone3: no longer qualifies/)
    expect(existsSync(cw(p, 'launch-a-gone2'))).toBe(false)
    expect(existsSync(cw(p, 'launch-a-gone3'))).toBe(true)
    // A path the preview never listed, or outside .combwork, is never removed.
    const outside = launchFolder(base, 'launch-a-outside')
    expect((await run(() => cleanup(p, opts, [outside]))).removed).toBe(0)
    expect(existsSync(outside)).toBe(true)
  })

  it('a removal racing a start: the folder is set aside before it is deleted, so a launch makes a fresh one', async () => {
    agents(p, ['a-keep', 'a-busy0'])
    launchFolder(p, 'launch-a-gone4')
    // Renamed aside, then deleted: nothing of it is left under its own name or the set-aside one.
    expect(await run(() => lf.removeLaunchFolder(p, 'a-gone4'))).toBe(true)
    expect(readdirSync(cw(p)).filter((n) => n.startsWith('launch-a-gone4'))).toEqual([])
  })
})
