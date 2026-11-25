// What an agent's line hasn't merged, as branchWatch counts it (#1627): a slot's line against its target, else the
// project's default branch, never the branch the project folder has checked out; a line whose branch isn't made yet is
// nothing to count, quietly. HI-1698: a branch that isn't there (an agent's 0.9 branch gone with its worktree, a card's
// line deleted after its merge) is nothing to count either, and a migrated agent's 0.9 worktree isn't its line; a line
// with no card target counts against the project's target before its default branch. Real repositories.
import { execFileSync } from 'child_process'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import type { ProjectInfo } from '../src/shared/types'

// The project's workflow target (its options in force), as the test sets it.
const projectTarget = vi.hoisted(() => ({ value: null as string | null }))
vi.mock('../src/main/gitRepo', () => ({ workTargetOf: async () => projectTarget.value }))

const { lineStatus } = await import('../src/main/branchWatch')
const { createWorktree } = await import('../src/main/worktrees')
const { setSlotsMigrated } = await import('../src/main/agentFolders')

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
let root = ''

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
  projectTarget.value = null
  setSlotsMigrated(null)
})

const commit = (cwd: string, file: string): void => {
  writeFileSync(join(cwd, file), `${file}\n`)
  run(cwd, 'add', '-A')
  run(cwd, 'commit', '-qm', file)
}

/**
 * A repository on main with a target branch 1.0.0 two commits ahead of it, a slot on the card's line made from 1.0.0
 * with one commit of its own, and the project folder on main.
 */
async function project(): Promise<{ project: ProjectInfo; slot: string }> {
  root = tempDir('cw-branchwatch-')
  const p = join(root, 'project')
  run(root, 'init', '-q', '-b', 'main', p)
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) run(p, 'config', k, v)
  commit(p, 'a.txt')
  run(p, 'checkout', '-q', '-b', '1.0.0')
  commit(p, 'b.txt')
  commit(p, 'c.txt')
  run(p, 'checkout', '-q', 'main')
  const slot = join(root, 'slot-a')
  await createWorktree(p, slot, 'cw/P/P-1-fix', '1.0.0')
  commit(slot, 'fix.txt')
  return { project: { path: p, name: 'project', agents: [] } as unknown as ProjectInfo, slot }
}

describe("an agent's line, counted against where it merges (#1627)", () => {
  it("a slot's line with a target: counted against it, not the project folder's branch", async () => {
    const { project: pr, slot } = await project()
    const st = await lineStatus({ project: pr, worktree: { path: slot, branch: 'cw/P/P-1-fix', base: '1.0.0' }, slot: true, target: '1.0.0' })
    expect(st).toMatchObject({ into: '1.0.0', ahead: 1, dirty: 0 })
  })

  it("a slot's line with no target: counted against the default branch, though the project folder has another checked out", async () => {
    const { project: pr, slot } = await project()
    run(pr.path, 'checkout', '-q', '1.0.0')
    const st = await lineStatus({ project: pr, worktree: { path: slot, branch: 'cw/P/P-1-fix', base: '' }, slot: true })
    // main lacks 1.0.0's two commits and the line's own one.
    expect(st).toMatchObject({ into: 'main', base: 'main', ahead: 3 })
  })

  it("a slot's line whose branch isn't made yet: nothing to count, and no error", async () => {
    const { project: pr, slot } = await project()
    await expect(lineStatus({ project: pr, worktree: { path: slot, branch: 'cw/P/P-2-not-yet', base: '1.0.0' }, slot: true, target: '1.0.0' })).resolves.toBeNull()
  })

  it("a 0.9 worktree's: counted against the project folder's branch, which its Merge… merges into", async () => {
    const { project: pr, slot } = await project()
    const st = await lineStatus({ project: pr, worktree: { path: slot, branch: 'cw/P/P-1-fix', base: '1.0.0' } })
    expect(st).toMatchObject({ into: 'main', ahead: 3 })
  })
})

describe('branches that are gone, and agents that moved to slots (HI-1698)', () => {
  it("an agent's 0.9 branch deleted with its worktree: nothing to count, no error", async () => {
    const { project: pr, slot } = await project()
    await expect(lineStatus({ project: pr, agentId: 'hb1', worktree: { path: join(root, 'gone'), branch: 'cw/hb1', base: 'main' } })).resolves.toBeNull()
    // A slot's line the same.
    await expect(lineStatus({ project: pr, agentId: 'hb1', worktree: { path: slot, branch: 'cw/hb1', base: '' }, slot: true })).resolves.toBeNull()
  })

  it("a card's line deleted after its merge: nothing to count, no error", async () => {
    const { project: pr, slot } = await project()
    run(slot, 'checkout', '-q', '--detach')
    run(pr.path, 'branch', '-D', 'cw/P/P-1-fix')
    await expect(lineStatus({ project: pr, agentId: 'hb2', worktree: { path: slot, branch: 'cw/P/P-1-fix', base: '1.0.0' }, slot: true, target: '1.0.0' })).resolves.toBeNull()
  })

  it("a migrated agent's 0.9 worktree, its branch still there, isn't its line any more", async () => {
    const { project: pr, slot } = await project()
    setSlotsMigrated(() => ['hb3'])
    await expect(lineStatus({ project: pr, agentId: 'hb3', worktree: { path: slot, branch: 'cw/P/P-1-fix', base: 'main' } })).resolves.toBeNull()
    // One not migrated still counts it, as before.
    expect(await lineStatus({ project: pr, agentId: 'hb9', worktree: { path: slot, branch: 'cw/P/P-1-fix', base: '1.0.0' } })).toMatchObject({ ahead: 3 })
  })

  it("a slot's line with no card target counts against the project's target (1.0.0), not main", async () => {
    const { project: pr, slot } = await project()
    projectTarget.value = '1.0.0'
    expect(await lineStatus({ project: pr, worktree: { path: slot, branch: 'cw/P/P-1-fix', base: '' }, slot: true })).toMatchObject({ into: '1.0.0', ahead: 1 })
  })
})
