// Storage measurements walk every file of every worktree, so a page that stops waiting abandons its call (#246): the
// call fails, and the walk stops once no other call waits for it (another window's, or one that can't be abandoned).
// A window's page going (closed or reloaded) runs none of its clean-up, so its requests are abandoned with it (#260).
// opendir is held at a gate so a walk can be caught half way; what it reads afterwards shows whether it carried on.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null, opened: [] as string[] }))
vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>()
  return {
    ...real,
    opendir: async (path: string, ...rest: unknown[]) => {
      gate.opened.push(String(path))
      if (gate.hold) await gate.hold
      return real.opendir(path, ...(rest as []))
    }
  }
})

const base = tempDir('cw-storage-abandon-')
afterAll(() => rmSync(base, { recursive: true, force: true }))
const DIRS = 40
/** A project whose agent's worktree has DIRS folders of one 100-byte file each. */
function project(name: string): { path: string; tree: string } {
  const path = join(base, name)
  const tree = join(base, `${name}-tree`)
  mkdirSync(join(path, '.combwork'), { recursive: true })
  for (let i = 0; i < DIRS; i++) {
    mkdirSync(join(tree, `d${i}`), { recursive: true })
    writeFileSync(join(tree, `d${i}`, 'f.txt'), 'x'.repeat(100))
  }
  return { path, tree }
}
const projects = new Map<string, string>()
const assistantHome = join(base, 'assistant-home')

vi.mock('../src/main/sessions', () => ({ sessions: {} }))
vi.mock('../src/main/workspace', () => ({
  workspace: {
    assertSessionHost: (p: string) => p,
    isAssistantHome: (p: string) => p === assistantHome,
    assistantHome,
    listProjectPaths: async () => [...projects.keys()],
    projectConfig: async (p: string) => ({ agents: [{ id: 'tree', name: 'Tree', worktree: { path: projects.get(p) } }] })
  },
  workspaceOf: () => ({ worktreesRoot: join(base, 'worktrees') }),
  // windows.ts sets it at load: storage reaches it through unusedWorktrees → … → progressService
  setWorkspaceFallback: () => {}
}))
// A 0.9 board (#1451): no slots, so each agent's 0.9 worktree is what is measured.
const { mockFactory } = await vi.hoisted(() => import('./keepType'))
vi.mock('../src/main/agentFolders', mockFactory<typeof import('../src/main/agentFolders')>(async (original) => ({
  ...(await original()),
  folderFacts: async (projectPath: string) => ({ projectPath, migrated: false, migratedAgents: [], homes: [], slots: [] })
})))

const { StorageStopped, abandonStorage, abandonWindowStorage, projectStorage, workspaceStorage } = await import('../src/main/storage')
const { workspace } = await import('../src/main/workspace')

/** Holds every opendir until released. */
function hold(): () => void {
  let release!: () => void
  gate.hold = new Promise((r) => (release = r))
  return () => {
    gate.hold = null
    release()
  }
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50))
const reads = (dir: string): number => gate.opened.filter((p) => p.startsWith(dir)).length

beforeEach(() => {
  gate.hold = null
  gate.opened = []
})

describe('abandoning a storage measurement', () => {
  it('stops the walk when nothing else waits, and the next call starts afresh', async () => {
    const p = project('alone')
    projects.set(p.path, p.tree)
    const release = hold()
    const call = projectStorage(p.path, true, 'page-1')
    await settle()
    abandonStorage('page-1')
    await expect(call).rejects.toBeInstanceOf(StorageStopped)
    const before = reads(p.tree)
    release()
    await settle()
    expect(reads(p.tree) - before).toBeLessThanOrEqual(1)
    const again = await projectStorage(p.path, false)
    expect(again.worktrees[0].bytes).toBe(DIRS * 100)
  })

  it("carries on for another window's request, which gets the whole result", async () => {
    const p = project('shared')
    projects.set(p.path, p.tree)
    const release = hold()
    const first = projectStorage(p.path, true, 'window-a')
    const second = projectStorage(p.path, true, 'window-b')
    await settle()
    abandonStorage('window-a')
    await expect(first).rejects.toBeInstanceOf(StorageStopped)
    release()
    expect((await second).worktrees[0].bytes).toBe(DIRS * 100)
    expect(reads(p.tree)).toBe(DIRS + 1)
  })

  it('carries on for a call that gave no request (it cannot be abandoned)', async () => {
    const p = project('anonymous')
    projects.set(p.path, p.tree)
    const release = hold()
    const page = projectStorage(p.path, true, 'page-2')
    const plain = projectStorage(p.path, true)
    await settle()
    abandonStorage('page-2')
    await expect(page).rejects.toBeInstanceOf(StorageStopped)
    release()
    expect((await plain).worktrees[0].bytes).toBe(DIRS * 100)
  })

  it('stops a workspace measurement before the next project', async () => {
    projects.clear()
    const a = project('ws-a')
    const b = project('ws-b')
    projects.set(a.path, a.tree)
    projects.set(b.path, b.tree)
    const release = hold()
    const call = workspaceStorage(true, 'settings-1')
    await settle()
    abandonStorage('settings-1')
    await expect(call).rejects.toBeInstanceOf(StorageStopped)
    release()
    await settle()
    expect(reads(b.tree)).toBe(0)
    projects.clear()
  })

  it('ignores a request that is unknown or already answered', async () => {
    const p = project('done')
    projects.set(p.path, p.tree)
    const done = await projectStorage(p.path, true, 'page-3')
    abandonStorage('page-3')
    abandonStorage('never-sent')
    expect(await projectStorage(p.path, false, 'page-4')).toEqual(done)
  })
})

// Requests are the window's that sent them (#260): its page going abandons them all, and only it can abandon one.
describe("a window's requests", () => {
  it('closing one window leaves a shared measurement to the other, which gets its result', async () => {
    const p = project('two-windows')
    projects.set(p.path, p.tree)
    const release = hold()
    // Both pages happen to use the same request id: each is its own window's.
    const one = projectStorage(p.path, true, 'page', 1)
    const two = projectStorage(p.path, true, 'page', 2)
    await settle()
    abandonWindowStorage(1)
    await expect(one).rejects.toBeInstanceOf(StorageStopped)
    release()
    expect((await two).worktrees[0].bytes).toBe(DIRS * 100)
    expect(reads(p.tree)).toBe(DIRS + 1)
  })

  it('closing the last window that waits stops the walk', async () => {
    const p = project('both-close')
    projects.set(p.path, p.tree)
    const release = hold()
    const one = projectStorage(p.path, true, 'page-a', 1)
    const two = projectStorage(p.path, true, 'page-b', 2)
    await settle()
    abandonWindowStorage(1)
    await expect(one).rejects.toBeInstanceOf(StorageStopped)
    abandonWindowStorage(2)
    await expect(two).rejects.toBeInstanceOf(StorageStopped)
    const before = reads(p.tree)
    release()
    await settle()
    expect(reads(p.tree) - before).toBeLessThanOrEqual(1)
  })

  it('carries on for a caller that is no window', async () => {
    const p = project('window-and-anonymous')
    projects.set(p.path, p.tree)
    const release = hold()
    const page = projectStorage(p.path, true, 'page', 3)
    const plain = projectStorage(p.path, true)
    await settle()
    abandonWindowStorage(3)
    await expect(page).rejects.toBeInstanceOf(StorageStopped)
    release()
    expect((await plain).worktrees[0].bytes).toBe(DIRS * 100)
  })

  it("a window abandons only its own request, not another window's with the same id", async () => {
    const p = project('same-id')
    projects.set(p.path, p.tree)
    const release = hold()
    const mine = projectStorage(p.path, true, 'page', 4)
    abandonStorage('page', 5)
    abandonStorage('page')
    abandonWindowStorage(5)
    release()
    expect((await mine).worktrees[0].bytes).toBe(DIRS * 100)
  })

  // A page that sends the same request id again while the first call still runs (#299): every call under it is
  // abandoned with the page, while another window's and an anonymous caller's go on.
  it('abandons every call that reused a request id, not only the latest', async () => {
    const alpha = project('dup-alpha')
    const beta = project('dup-beta')
    projects.set(alpha.path, alpha.tree)
    projects.set(beta.path, beta.tree)
    const release = hold()
    const first = projectStorage(alpha.path, true, 'storage-1', 7)
    const again = projectStorage(alpha.path, true, 'storage-1', 7)
    const other = projectStorage(beta.path, true, 'storage-1', 7)
    const theirs = projectStorage(beta.path, true, 'storage-1', 8)
    const plain = projectStorage(alpha.path, true)
    await settle()
    abandonWindowStorage(7)
    for (const call of [first, again, other]) await expect(call).rejects.toBeInstanceOf(StorageStopped)
    release()
    expect((await theirs).worktrees[0].bytes).toBe(DIRS * 100)
    expect((await plain).worktrees[0].bytes).toBe(DIRS * 100)
  })

  it('stops the walk once every call that reused the id is abandoned', async () => {
    const p = project('dup-alone')
    projects.set(p.path, p.tree)
    const release = hold()
    const first = projectStorage(p.path, true, 'storage-2', 9)
    const again = projectStorage(p.path, true, 'storage-2', 9)
    await settle()
    abandonStorage('storage-2', 9)
    await expect(first).rejects.toBeInstanceOf(StorageStopped)
    await expect(again).rejects.toBeInstanceOf(StorageStopped)
    const before = reads(p.tree)
    release()
    await settle()
    expect(reads(p.tree) - before).toBeLessThanOrEqual(1)
  })

  it('keeps the request while any call under it runs: one answering first leaves the others abandonable', async () => {
    const quick = project('dup-quick')
    const slow = project('dup-slow')
    projects.set(quick.path, quick.tree)
    projects.set(slow.path, slow.tree)
    await projectStorage(quick.path, true)
    const release = hold()
    const waiting = projectStorage(slow.path, true, 'storage-3', 10)
    // Answered at once from the last result, under the same request, while the other still runs.
    expect((await projectStorage(quick.path, false, 'storage-3', 10)).worktrees[0].bytes).toBe(DIRS * 100)
    await settle()
    abandonWindowStorage(10)
    await expect(waiting).rejects.toBeInstanceOf(StorageStopped)
    const before = reads(slow.tree)
    release()
    await settle()
    expect(reads(slow.tree) - before).toBeLessThanOrEqual(1)
    // A new call with the id after it was abandoned is a request of its own, and runs.
    expect((await projectStorage(slow.path, true, 'storage-3', 10)).worktrees[0].bytes).toBe(DIRS * 100)
  })

  // A call abandoned while it lists the projects, then the same id sent again by the same window (#338): the new call
  // is a request of its own and runs; the old one stays abandoned rather than carrying on under the new one.
  it('a workspace call abandoned while listing projects stays abandoned when its id is sent again', async () => {
    projects.clear()
    const p = project('reused-id')
    projects.set(p.path, p.tree)
    let list!: (paths: string[]) => void
    vi.spyOn(workspace, 'listProjectPaths').mockImplementationOnce(() => new Promise((r) => (list = r)))
    const release = hold()
    const old = workspaceStorage(true, 'storage-4', 11)
    abandonStorage('storage-4', 11)
    const fresh = workspaceStorage(true, 'storage-4', 11)
    const stopped = expect(old).rejects.toBeInstanceOf(StorageStopped)
    list([p.path])
    await settle()
    release()
    await stopped
    expect((await fresh).projects.find((x) => x.path === p.path)?.worktrees[0].bytes).toBe(DIRS * 100)
    projects.clear()
  })

  it("stops a closed window's workspace measurement before the next project", async () => {
    projects.clear()
    const a = project('wsw-a')
    const b = project('wsw-b')
    projects.set(a.path, a.tree)
    projects.set(b.path, b.tree)
    const release = hold()
    const call = workspaceStorage(true, 'settings', 6)
    await settle()
    abandonWindowStorage(6)
    await expect(call).rejects.toBeInstanceOf(StorageStopped)
    release()
    await settle()
    expect(reads(b.tree)).toBe(0)
    projects.clear()
  })
})
