// HI-3109: the Merge dialog's merge into a branch checked out nowhere makes it in a temporary worktree (HI-3030). A
// post-checkout hook that fails there (git's exit status after the worktree is made) isn't taken as no worktree: the
// merge goes on, and the folder goes after. A worktree git added but not at the target's tip is refused, and goes too.
// Nothing is left behind either way, however often it is tried. From hunt 7's probe (HG1). Real git.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { describe, expect, it } from 'vitest'
import { createWorktree, mergeWorktree } from '../src/main/worktrees'
import { tempDir } from './tempDir'

const slash = (p: string): string => p.replace(/\\/g, '/')
const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const worktrees = (project: string): string[] => run(project, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((l) => l.startsWith('worktree '))

/** main with two commits, release (checked out nowhere) at its head, cw/a a commit past it; the hook `name`, `hook`. */
async function repo(hook: string, name = 'post-checkout') {
  const root = tempDir('cw-merge-hooks-')
  const project = join(root, 'project')
  run(root, 'init', '-q', '-b', 'main', project)
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['core.autocrlf', 'false']]) run(project, 'config', k, v)
  for (const f of ['f.txt', 'g.txt']) {
    writeFileSync(join(project, f), `${f}\n`)
    run(project, 'add', '-A')
    run(project, 'commit', '-qm', f)
  }
  run(project, 'branch', 'release')
  const a = { path: join(root, 'wt', 'a'), branch: 'cw/a', base: 'main' }
  await createWorktree(project, a.path, a.branch, 'main')
  writeFileSync(join(a.path, 'a.txt'), 'A\n')
  run(a.path, 'add', '-A')
  run(a.path, 'commit', '-qm', 'work A')
  // The hook from here on: the worktree above was made before it.
  const hooks = join(root, 'hooks')
  mkdirSync(hooks)
  writeFileSync(join(hooks, name), hook)
  run(project, 'config', 'core.hooksPath', slash(hooks))
  return { root, project, a }
}
/** The temporary merge folders left (`<workspace>.worktrees/<project>/merge-…`, as worktrees.ts's temporaryRoot has it). */
const leftIn = (root: string): string[] => {
  const dir = join(dirname(root), `${root.split(/[\\/]/).at(-1)}.worktrees`, 'project')
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('merge-')) : []
}

describe('a merge into a branch checked out nowhere, with a post-checkout hook (HI-3109)', () => {
  for (const squash of [false, true]) {
    it(`a hook that fails after the checkout: merged (${squash ? 'squash' : 'merge commit'}), nothing left behind`, async () => {
      const { root, project, a } = await repo('#!/bin/sh\necho "post-checkout: node_modules missing" >&2\nexit 1\n')
      const listed = worktrees(project)
      const res = await mergeWorktree(project, a, { squash, message: 'into release', target: 'release' })
      expect(res).toMatchObject({ ok: true })
      expect(res.note).toBeUndefined()
      expect(run(project, 'show', 'release:a.txt')).toBe('A')
      expect(worktrees(project)).toEqual(listed)
      expect(leftIn(root)).toEqual([])
    })
  }

  it('a hook that leaves the checkout elsewhere than the target’s tip: refused three times, nothing merged, nothing left', async () => {
    // The hook moves the new worktree to the commit before, then fails: git made a worktree, but not the one asked for.
    const { root, project, a } = await repo('#!/bin/sh\ngit -c core.hooksPath=/dev/null checkout -q --detach HEAD~1\nexit 1\n')
    const listed = worktrees(project)
    const release = run(project, 'rev-parse', 'release')
    for (let i = 0; i < 3; i++) {
      const res = await mergeWorktree(project, a, { squash: false, message: 'into release', target: 'release' })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/^Nothing was merged/)
      expect(res.error).not.toMatch(/couldn’t remove|couldn't remove/)
    }
    expect(run(project, 'rev-parse', 'release')).toBe(release)
    expect(worktrees(project)).toEqual(listed)
    expect(leftIn(root)).toEqual([])
  })
})

describe("a commit hook needing the project folder's untracked files (HI-3109, Darren's decision A)", () => {
  for (const squash of [false, true]) {
    it(`refused (${squash ? 'squash' : 'merge commit'}), saying the hooks ran in a temporary checkout and where to merge instead`, async () => {
      // Husky's way: a commit-msg hook running a tool in node_modules, which only the project folder has.
      const { root, project, a } = await repo('#!/bin/sh\nexec ./node_modules/.bin/lint-msg "$1"\n', 'commit-msg')
      mkdirSync(join(project, 'node_modules', '.bin'), { recursive: true })
      writeFileSync(join(project, 'node_modules', '.bin', 'lint-msg'), '#!/bin/sh\nexit 0\n')
      const listed = worktrees(project)
      const release = run(project, 'rev-parse', 'release')
      const res = await mergeWorktree(project, a, { squash, message: 'into release', target: 'release' })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/^Nothing was merged: .*lint-msg/s)
      expect(res.error).toContain("they ran in a temporary checkout of release, which has none of the project folder's untracked files (node_modules, say). Check out release in the project folder and merge there")
      expect(run(project, 'rev-parse', 'release')).toBe(release)
      expect(worktrees(project)).toEqual(listed)
      expect(leftIn(root)).toEqual([])
    })
  }
})
