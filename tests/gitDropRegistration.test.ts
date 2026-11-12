// HI-3069: Git's port drops one worktree registration (a kept jj slot's, its folder gone) on HI-3046's owned-entry
// proof, never by a repository-wide prune (HR1's round 1): its entry found by its gitdir, proved synchronously (the
// folder absent only on ENOENT or ENOTDIR), moved aside, proved again on what was moved, then removed (HR2's round 2).
// Real git; the race and the access errors are injected at exact points (a seam right before the move; `fs.lstatSync`).
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

/** Paths whose `lstatSync` throws EPERM (normalised, lower case). */
const denied = new Set<string>()
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const lstatSync = ((p: fs.PathLike, o?: unknown) => {
    if (denied.has(resolve(String(p)).toLowerCase())) throw Object.assign(new Error(`EPERM: operation not permitted, lstat '${String(p)}'`), { code: 'EPERM' })
    return (real.lstatSync as (p: fs.PathLike, o?: unknown) => fs.Stats)(p, o)
  }) as typeof real.lstatSync
  return { ...real, lstatSync, default: { ...real, lstatSync } }
})

const { gitWorkspacePort, registrationSeams } = await import('../src/main/platform/gitWorkspacePort')

afterEach(() => {
  denied.clear()
  registrationSeams.beforeAside = undefined
})

const g = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A repository with two worktrees: slot-a (relative paths, as a colocated jj workspace registers) and the user's own. */
function twoWorktrees(): { repo: string; slot: string; mine: string; base: string } {
  const base = tempDir('dropreg-')
  const repo = join(base, 'project')
  fs.mkdirSync(repo, { recursive: true })
  g(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(join(repo, 'a.txt'), 'a\n')
  g(repo, 'add', 'a.txt')
  g(repo, 'commit', '-q', '-m', 'one')
  const slot = join(base, 'slots', 'slot-a')
  const mine = join(base, 'mine')
  g(repo, 'worktree', 'add', '-q', '--relative-paths', '--detach', slot, 'HEAD')
  g(repo, 'worktree', 'add', '-q', '--detach', mine, 'HEAD')
  return { repo, slot, mine, base }
}
const listed = (repo: string): string[] => g(repo, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9).toLowerCase())
const has = (repo: string, p: string): boolean => listed(repo).includes(p.split('\\').join('/').toLowerCase())
const entries = (repo: string): string[] => fs.readdirSync(join(repo, '.git', 'worktrees')).sort()
const asides = (repo: string): string[] => fs.readdirSync(join(repo, '.git')).filter((n) => n.startsWith('.cw-gitlink-'))

describe("HI-3069: Git's port drops one worktree registration, on proof", () => {
  it("another worktree gone too (moved aside): only the slot's registration goes, the other's stays for Repair", async () => {
    const { repo, slot, mine } = twoWorktrees()
    fs.rmSync(slot, { recursive: true, force: true })
    fs.renameSync(mine, `${mine}-moved`)
    expect(await gitWorkspacePort.dropRegistration!(repo, slot)).toBe('dropped')
    expect(has(repo, slot)).toBe(false)
    expect(has(repo, mine)).toBe(true)
    expect(asides(repo)).toEqual([])
  })

  it('the folder there, locked, or not registered: left, nothing dropped', async () => {
    const { repo, slot, base } = twoWorktrees()
    expect(await gitWorkspacePort.dropRegistration!(repo, slot)).toEqual({ left: 'folder' })
    g(repo, 'worktree', 'lock', slot)
    fs.rmSync(slot, { recursive: true, force: true })
    expect(await gitWorkspacePort.dropRegistration!(repo, slot)).toEqual({ left: 'locked' })
    expect(has(repo, slot)).toBe(true)
    expect(await gitWorkspacePort.dropRegistration!(repo, join(base, 'nowhere'))).toBe('none')
  })

  it("its name reused between the proof and the move (pruned, then another worktree added): what was moved is put back, the new worktree's registration kept (HR2's round 2)", async () => {
    const { repo, slot, base } = twoWorktrees()
    fs.rmSync(slot, { recursive: true, force: true })
    const other = join(base, 'other', 'slot-a')
    const before = entries(repo)
    registrationSeams.beforeAside = () => {
      // Another git, between the proof and the move: the old registration pruned, a new worktree given its name.
      g(repo, 'worktree', 'prune')
      g(repo, 'worktree', 'add', '-q', '--detach', other, 'HEAD')
    }
    const r = await gitWorkspacePort.dropRegistration!(repo, slot)
    expect(r).toEqual({ left: expect.stringMatching(/^(replaced|gitdir|commondir)$/) })
    expect(entries(repo)).toEqual(before)
    expect(has(repo, other)).toBe(true)
    expect(fs.existsSync(join(other, 'a.txt'))).toBe(true)
    expect(asides(repo)).toEqual([])
  })

  it("the folder's lstat denied (EPERM): never taken for absent, nothing dropped (HR2's round 2)", async () => {
    const { repo, slot } = twoWorktrees()
    // Gone, but its lstat fails with EPERM, not ENOENT: only the injected error stands between it and its drop.
    fs.rmSync(slot, { recursive: true, force: true })
    denied.add(resolve(slot).toLowerCase())
    expect(await gitWorkspacePort.dropRegistration!(repo, slot)).toEqual({ left: 'folder' })
    denied.clear()
    expect(has(repo, slot)).toBe(true)
    // Without the error, the same call drops it: the denial was what kept it.
    expect(await gitWorkspacePort.dropRegistration!(repo, slot)).toBe('dropped')
  })

  it("the entry's locked file's lstat denied (EPERM): never taken for unlocked, nothing dropped (HR2's round 2)", async () => {
    const { repo, slot } = twoWorktrees()
    fs.rmSync(slot, { recursive: true, force: true })
    const entry = join(repo, '.git', 'worktrees', 'slot-a')
    denied.add(resolve(join(entry, 'locked')).toLowerCase())
    expect(await gitWorkspacePort.dropRegistration!(repo, slot)).toEqual({ left: 'unreadable' })
    denied.clear()
    expect(has(repo, slot)).toBe(true)
    expect(await gitWorkspacePort.dropRegistration!(repo, slot)).toBe('dropped')
  })
})
