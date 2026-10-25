// What an agent's line hasn't merged, as branchWatch counts it (#1627): a slot's line against its target, else the
// project's default branch, never the branch the project folder has checked out; a line whose branch isn't made yet is
// nothing to count, quietly. Real repositories.
import { execFileSync } from 'child_process'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import type { ProjectInfo } from '../src/shared/types'

const { lineStatus } = await import('../src/main/branchWatch')
const { createWorktree } = await import('../src/main/worktrees')

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
let root = ''

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
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
  root = tempDir('hive-branchwatch-')
  const p = join(root, 'project')
  run(root, 'init', '-q', '-b', 'main', p)
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) run(p, 'config', k, v)
  commit(p, 'a.txt')
  run(p, 'checkout', '-q', '-b', '1.0.0')
  commit(p, 'b.txt')
  commit(p, 'c.txt')
  run(p, 'checkout', '-q', 'main')
  const slot = join(root, 'slot-a')
  await createWorktree(p, slot, 'hive/P/P-1-fix', '1.0.0')
  commit(slot, 'fix.txt')
  return { project: { path: p, name: 'project', agents: [] } as unknown as ProjectInfo, slot }
}

describe("an agent's line, counted against where it merges (#1627)", () => {
  it("a slot's line with a target: counted against it, not the project folder's branch", async () => {
    const { project: pr, slot } = await project()
    const st = await lineStatus({ project: pr, worktree: { path: slot, branch: 'hive/P/P-1-fix', base: '1.0.0' }, slot: true, target: '1.0.0' })
    expect(st).toMatchObject({ into: '1.0.0', ahead: 1, dirty: 0 })
  })

  it("a slot's line with no target: counted against the default branch, though the project folder has another checked out", async () => {
    const { project: pr, slot } = await project()
    run(pr.path, 'checkout', '-q', '1.0.0')
    const st = await lineStatus({ project: pr, worktree: { path: slot, branch: 'hive/P/P-1-fix', base: '' }, slot: true })
    // main lacks 1.0.0's two commits and the line's own one.
    expect(st).toMatchObject({ into: 'main', base: 'main', ahead: 3 })
  })

  it("a slot's line whose branch isn't made yet: nothing to count, and no error", async () => {
    const { project: pr, slot } = await project()
    await expect(lineStatus({ project: pr, worktree: { path: slot, branch: 'hive/P/P-2-not-yet', base: '1.0.0' }, slot: true, target: '1.0.0' })).resolves.toBeNull()
  })

  it("a 0.9 worktree's: counted against the project folder's branch, which its Merge… merges into", async () => {
    const { project: pr, slot } = await project()
    const st = await lineStatus({ project: pr, worktree: { path: slot, branch: 'hive/P/P-1-fix', base: '1.0.0' } })
    expect(st).toMatchObject({ into: 'main', ahead: 3 })
  })
})
