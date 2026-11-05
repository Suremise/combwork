// HI-2564: a project folder deleted in place (Shift+Del, `rmdir /s`, a recursive rmSync) while Combwork watches it. Its
// .combwork goes first, and a refresh that found it half gone set it up again (.combwork, a default project.json, and
// .git\info\exclude), so the delete ended in ENOTEMPTY. A project set up in this lifetime whose project.json has gone is
// now never set up again by a refresh: only an open, or a change to it. Refreshes and id reads are called directly here,
// in the order each test names; the folder watcher's own refreshes, whenever they come, can only do the same.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

// Git as the tests run it (#369, as hiveVcs.test.ts): the run context's environment, the shell's GIT_* kept out of main's.
const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
const gitEnv = baseEnv()
const shellGit = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^GIT_/i.test(k) || /^NODE_(OPTIONS|PATH)$/i.test(k)))
for (const k of Object.keys(shellGit)) delete process.env[k]
afterAll(() => void Object.assign(process.env, shellGit))

const base = tempDir('hive-deleted-in-place-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { configTestHooks, createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')

vi.setConfig({ testTimeout: 30_000 })
/** Bounds a wait for a held read to be reached: only a hung read takes this long. */
const HUNG_MS = 15_000

function project(ws: string, name: string, git = false): string {
  const p = join(ws, name)
  mkdirSync(join(p, '.combwork'), { recursive: true })
  writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  writeFileSync(join(p, 'a.ts'), 'export const a = 1\n')
  if (git) execFileSync('git', ['init', '-q'], { env: gitEnv, cwd: p })
  return p
}
const combwork = (p: string): string => join(p, '.combwork')
const exclude = (p: string): string => join(p, '.git', 'info', 'exclude')
const excludes = (p: string): boolean => existsSync(exclude(p)) && /\.combwork/.test(readFileSync(exclude(p), 'utf8'))
const listed = async (w: { refresh: () => Promise<{ projects: { path: string }[] }> }, p: string): Promise<boolean> => (await w.refresh()).projects.some((x) => x.path.toLowerCase() === p.toLowerCase())

describe('a project folder deleted in place (HI-2564)', () => {
  it('a Git project emptied in steps between refreshes is never set up again, and its folder goes', async () => {
    const ws = join(base, 'ws-steps')
    project(ws, 'keep')
    const gone = project(ws, 'gone', true)
    const w = createWorkspaceService()
    await w.open(ws)
    try {
      await w.refreshesSettled()
      expect(excludes(gone)).toBe(true)
      // As a recursive delete goes: .combwork first, then .git's folders, then the rest. An id read before and between
      // the refreshes (the id index drops a project with no config), and a second refresh once it has.
      rmSync(combwork(gone), { recursive: true, force: true })
      await w.projectIds({ fresh: true })
      expect(await listed(w, gone)).toBe(true)
      await w.projectIds({ fresh: true })
      await w.refresh()
      expect(existsSync(combwork(gone))).toBe(false)
      rmSync(join(gone, '.git', 'info'), { recursive: true, force: true })
      await w.projectIds({ fresh: true })
      await w.refresh()
      expect(existsSync(join(gone, '.git', 'info'))).toBe(false)
      expect(existsSync(combwork(gone))).toBe(false)
      rmSync(join(gone, '.git'), { recursive: true, force: true })
      await w.refresh()
      expect(existsSync(combwork(gone))).toBe(false)
      rmSync(join(gone, 'a.ts'))
      // Its folder is empty: the delete's last step succeeds.
      rmdirSync(gone)
      expect(await listed(w, gone)).toBe(false)
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it('a folder a refresh set up, deleted before any id read, is not set up again', async () => {
    const ws = join(base, 'ws-found')
    project(ws, 'keep')
    const w = createWorkspaceService()
    await w.open(ws)
    try {
      await w.refreshesSettled()
      // A new folder is still made a project by a refresh (#1423).
      const found = join(ws, 'found')
      mkdirSync(found)
      expect(await listed(w, found)).toBe(true)
      expect(existsSync(join(combwork(found), 'project.json'))).toBe(true)
      rmSync(combwork(found), { recursive: true, force: true })
      await w.refresh()
      expect(existsSync(combwork(found))).toBe(false)
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it('with only its project.json deleted, a refresh writes neither it nor the exclude line', async () => {
    const ws = join(base, 'ws-only-config')
    const p = project(ws, 'p', true)
    const w = createWorkspaceService()
    await w.open(ws)
    try {
      await w.refreshesSettled()
      rmSync(join(combwork(p), 'project.json'))
      rmSync(exclude(p))
      await w.refresh()
      expect(existsSync(join(combwork(p), 'project.json'))).toBe(false)
      expect(existsSync(exclude(p))).toBe(false)
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it('a project reset by deleting its .combwork is set up anew when the workspace is opened again', async () => {
    const ws = join(base, 'ws-reset-open')
    const p = project(ws, 'p', true)
    writeFileSync(join(combwork(p), 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One', provider: 'claude-code' }] }))
    const w = createWorkspaceService()
    await w.open(ws)
    try {
      await w.refreshesSettled()
      rmSync(combwork(p), { recursive: true, force: true })
      rmSync(exclude(p))
      await w.refresh()
      expect(existsSync(combwork(p))).toBe(false)
      await w.close()
      await w.open(ws)
      await w.refreshesSettled()
      expect(JSON.parse(readFileSync(join(combwork(p), 'project.json'), 'utf8')).agents).toEqual([])
      expect(excludes(p)).toBe(true)
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it('a project reset by deleting its .combwork is set up again by a change to it', async () => {
    const ws = join(base, 'ws-reset-change')
    const p = project(ws, 'p')
    const w = createWorkspaceService()
    await w.open(ws)
    try {
      await w.refreshesSettled()
      rmSync(combwork(p), { recursive: true, force: true })
      await w.refresh()
      expect(existsSync(combwork(p))).toBe(false)
      await w.updateProjectConfig(p, { worktreeSetup: 'npm ci' })
      expect(JSON.parse(readFileSync(join(combwork(p), 'project.json'), 'utf8')).worktreeSetup).toBe('npm ci')
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it('an intact project whose repository is made later gains the exclude line at the next refresh', async () => {
    const ws = join(base, 'ws-git-later')
    const p = project(ws, 'p')
    const w = createWorkspaceService()
    await w.open(ws)
    try {
      await w.refreshesSettled()
      execFileSync('git', ['init', '-q'], { env: gitEnv, cwd: p })
      await w.refresh()
      expect(excludes(p)).toBe(true)
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it('a folder made again by the same name, once a refresh found it gone, is set up as a new one', async () => {
    const ws = join(base, 'ws-same-name')
    project(ws, 'keep')
    const p = project(ws, 'p')
    const w = createWorkspaceService()
    await w.open(ws)
    try {
      await w.refreshesSettled()
      rmSync(p, { recursive: true, force: true })
      expect(await listed(w, p)).toBe(false)
      mkdirSync(p)
      expect(await listed(w, p)).toBe(true)
      expect(existsSync(join(combwork(p), 'project.json'))).toBe(true)
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  // HR2 on the design: a read that saw project.json, held while the folder goes and a refresh confirms it gone, records
  // nothing when it ends, so a folder made again by that name is new.
  it('a read held while its folder is removed and found gone records nothing on its release', async () => {
    const ws = join(base, 'ws-held-gone')
    project(ws, 'keep')
    const p = project(ws, 'p')
    const w = createWorkspaceService()
    await w.open(ws)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let reached = false
    try {
      await w.refreshesSettled()
      configTestHooks.afterConfigSeen = async (at) => {
        if (reached || at.toLowerCase() !== p.toLowerCase()) return
        reached = true
        await held
      }
      const older = w.refresh().catch(() => null)
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: HUNG_MS })
      rmSync(p, { recursive: true, force: true })
      expect(await listed(w, p)).toBe(false)
      expect(w.setUpTicket(p)).toBeUndefined()
      release()
      await older
      expect(w.setUpTicket(p)).toBeUndefined()
      mkdirSync(p)
      expect(await listed(w, p)).toBe(true)
      expect(existsSync(join(combwork(p), 'project.json'))).toBe(true)
    } finally {
      release()
      delete configTestHooks.afterConfigSeen
      await disposeWorkspaceService(w)
    }
  })

  // HR2 on the design: another workspace opened meanwhile, so nothing of its own open can stand in for the old record.
  it('a read held across a close records nothing in the next workspace’s lifetime', async () => {
    const ws = join(base, 'ws-held-reopen')
    const p = project(ws, 'p')
    const other = join(base, 'ws-held-other')
    project(other, 'q')
    const w = createWorkspaceService()
    await w.open(ws)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let reached = false
    try {
      await w.refreshesSettled()
      configTestHooks.afterConfigSeen = async (at) => {
        if (reached || at.toLowerCase() !== p.toLowerCase()) return
        reached = true
        await held
      }
      const older = w.refresh().catch(() => null)
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: HUNG_MS })
      await w.close()
      await w.open(other)
      await w.refreshesSettled()
      expect(w.setUpTicket(join(other, 'q'))).toBeDefined()
      expect(w.setUpTicket(p)).toBeUndefined()
      release()
      await older
      expect(w.setUpTicket(p)).toBeUndefined()
    } finally {
      release()
      delete configTestHooks.afterConfigSeen
      await disposeWorkspaceService(w)
    }
  })
})
