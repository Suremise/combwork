// Merge… with the repo's own .gitattributes: two worktree branches that each add a CHANGELOG entry at the top of
// Unreleased merge one after the other with no conflict (merge-tree's check and both kinds of merge), both entries kept.
// And #1347: a dirty worktree is refused (never committed for it), the merge commit is returned, and a target the
// project folder hasn't checked out is merged without touching a folder.
// HI-2422: the branch is merged by its full ref, never a same-named tag.
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorktree, mergeWorktree } from '../src/main/worktrees'
import { tempDir } from './tempDir'

const CHANGELOG = '# Changelog\n\n## Unreleased\n\n- Earlier entry.\n\n## 0.3.1\n\n- Released.\n'
const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
let root = ''

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

async function twoBranches(): Promise<{ project: string; a: { path: string; branch: string; base: string }; b: { path: string; branch: string; base: string } }> {
  root = tempDir('cw-merge-')
  const project = join(root, 'project')
  run(root, 'init', '-q', '-b', 'main', project)
  // core.eol: the repo's `* text=auto` (#149) checks text out with the native ending (CRLF on Windows) otherwise.
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false'], ['core.eol', 'lf']]) run(project, 'config', k, v)
  copyFileSync(join(__dirname, '..', '.gitattributes'), join(project, '.gitattributes'))
  writeFileSync(join(project, 'CHANGELOG.md'), CHANGELOG)
  run(project, 'add', '-A')
  run(project, 'commit', '-qm', 'base')
  const a = { path: join(root, 'wt', 'a'), branch: 'cw/a', base: 'main' }
  const b = { path: join(root, 'wt', 'b'), branch: 'cw/b', base: 'main' }
  for (const [wt, entry] of [[a, '- Entry from A.'], [b, '- Entry from B.']] as const) {
    await createWorktree(project, wt.path, wt.branch, 'main')
    writeFileSync(join(wt.path, 'CHANGELOG.md'), CHANGELOG.replace('- Earlier entry.', `${entry}\n- Earlier entry.`))
    run(wt.path, 'commit', '-qam', wt.branch)
  }
  return { project, a, b }
}

describe('merging CHANGELOG entries from two branches', () => {
  for (const squash of [false, true]) {
    it(`keeps both, with no conflict (${squash ? 'squash' : 'merge commit'})`, async () => {
      const { project, a, b } = await twoBranches()
      const first = await mergeWorktree(project, a, { squash, message: 'A' })
      expect(first).toEqual({ ok: true, mergeCommit: run(project, 'rev-parse', 'HEAD').trim() })
      expect(await mergeWorktree(project, b, { squash, message: 'B' })).toEqual({ ok: true, mergeCommit: run(project, 'rev-parse', 'HEAD').trim() })
      const text = readFileSync(join(project, 'CHANGELOG.md'), 'utf8')
      expect(text).toContain('- Entry from A.\n- Entry from B.\n- Earlier entry.\n')
      expect(run(project, 'status', '--porcelain')).toBe('')
    })
  }
})

describe('mergeWorktree (#1347)', () => {
  it('refuses a worktree with uncommitted files, counted, committing nothing', async () => {
    const { project, a } = await twoBranches()
    writeFileSync(join(a.path, 'loose.txt'), 'x')
    writeFileSync(join(a.path, 'CHANGELOG.md'), 'changed')
    const tip = run(a.path, 'rev-parse', 'HEAD')
    const main = run(project, 'rev-parse', 'main')
    const r = await mergeWorktree(project, a, { squash: false, message: 'A' })
    expect(r).toMatchObject({ ok: false, uncommitted: 2 })
    expect(r.error).toBe("Nothing was merged: 2 files in the worktree aren't committed. Commit or stash them in the worktree, then merge.")
    expect(run(a.path, 'rev-parse', 'HEAD')).toBe(tip)
    expect(run(project, 'rev-parse', 'main')).toBe(main)
    expect(run(a.path, 'status', '--porcelain')).not.toBe('')
  })

  for (const squash of [false, true]) {
    it(`merges into a target checked out nowhere, leaving the project folder as it is (${squash ? 'squash' : 'merge commit'})`, async () => {
      const { project, a } = await twoBranches()
      run(project, 'branch', 'release')
      run(project, 'commit', '-q', '--allow-empty', '-m', 'main moves on')
      const head = run(project, 'rev-parse', 'HEAD')
      const r = await mergeWorktree(project, a, { squash, message: 'into release', target: 'release' })
      const release = run(project, 'rev-parse', 'release').trim()
      expect(r).toEqual({ ok: true, mergeCommit: release })
      expect(run(project, 'log', '-1', '--format=%P', 'release').trim().split(' ')).toHaveLength(squash ? 1 : 2)
      expect(run(project, 'show', 'release:CHANGELOG.md')).toContain('- Entry from A.')
      expect(run(project, 'rev-parse', 'HEAD')).toBe(head)
      expect(run(project, 'status', '--porcelain')).toBe('')
    })
  }

  // HI-3030 (Darren's decision): a merge into a branch checked out nowhere is made as every other merge is, by git merge
  // in a temporary worktree: signed as the repository says or refused with git's reason (never made unsigned, as git
  // commit-tree made it), and the repository's commit hooks run. The temporary folder goes either way.
  const worktrees = (project: string): string[] => run(project, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((l) => l.startsWith('worktree '))
  for (const squash of [false, true]) {
    it(`into a branch checked out nowhere with signing on and a signer that can't run: refused saying why, nothing moved (${squash ? 'squash' : 'merge commit'})`, async () => {
      const { project, a } = await twoBranches()
      run(project, 'branch', 'release')
      const listed = worktrees(project)
      // Repo-local: a signer that doesn't exist, so any commit git signs fails; nothing of the user's is touched.
      run(project, 'config', 'commit.gpgsign', 'true')
      run(project, 'config', 'gpg.program', join(root, 'no-such-signer.exe'))
      const release = run(project, 'rev-parse', 'release')
      const r = await mergeWorktree(project, a, { squash, message: 'into release', target: 'release' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/^Nothing was merged: /)
      expect(r.error).toMatch(/sign|gpg/i)
      expect(run(project, 'rev-parse', 'release')).toBe(release)
      expect(worktrees(project)).toEqual(listed)
    })

    it(`into a branch checked out nowhere: the repository's commit hooks run, and one refusing keeps it as it was (${squash ? 'squash' : 'merge commit'})`, async () => {
      const { project, a } = await twoBranches()
      run(project, 'branch', 'release')
      const listed = worktrees(project)
      const hooks = join(root, 'hooks')
      mkdirSync(hooks)
      run(project, 'config', 'core.hooksPath', hooks.replace(/\\/g, '/'))
      // commit-msg runs for a merge commit and a squash's commit alike: it marks the message.
      writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\necho "Hooked: yes" >> "$1"\n')
      const r = await mergeWorktree(project, a, { squash, message: 'into release', target: 'release' })
      const release = run(project, 'rev-parse', 'release').trim()
      expect(r).toEqual({ ok: true, mergeCommit: release })
      expect(run(project, 'log', '-1', '--format=%B', 'release')).toContain('Hooked: yes')
      expect(run(project, 'log', '-1', '--format=%P', 'release').trim().split(' ')).toHaveLength(squash ? 1 : 2)
      expect(worktrees(project)).toEqual(listed)
      // A hook that refuses (pre-merge-commit for a merge, pre-commit for a squash's commit): refused with its words.
      run(a.path, 'commit', '-q', '--allow-empty', '-m', 'more')
      writeFileSync(join(a.path, 'more.txt'), 'more\n')
      run(a.path, 'add', '-A')
      run(a.path, 'commit', '-qm', 'more work')
      writeFileSync(join(hooks, squash ? 'pre-commit' : 'pre-merge-commit'), '#!/bin/sh\necho "the hook says no" >&2\nexit 1\n')
      const no = await mergeWorktree(project, a, { squash, message: 'again', target: 'release' })
      expect(no.ok).toBe(false)
      expect(no.error).toContain('the hook says no')
      expect(run(project, 'rev-parse', 'release').trim()).toBe(release)
      expect(worktrees(project)).toEqual(listed)
    })
  }

  it('refuses a target checked out in another folder, and a target that does not exist', async () => {
    const { project, a, b } = await twoBranches()
    const r = await mergeWorktree(project, a, { squash: false, message: 'A', target: b.branch })
    expect(r.ok).toBe(false)
    expect(r.error).toContain(`${b.branch} is checked out in`)
    expect(await mergeWorktree(project, a, { squash: false, message: 'A', target: 'nope' })).toEqual({ ok: false, error: 'There is no branch nope to merge into.' })
  })

  // HR6's round 1: on Windows a ref named in another case is the same branch, so it is routed as that branch.
  it('a target named in another case is that branch: merged in its folder, or refused, never a bare ref move', async () => {
    const { project, a, b } = await twoBranches()
    const merged = await mergeWorktree(project, a, { squash: false, message: 'A', target: 'MAIN' })
    expect(merged).toEqual({ ok: true, mergeCommit: run(project, 'rev-parse', 'main').trim() })
    expect(readFileSync(join(project, 'CHANGELOG.md'), 'utf8')).toContain('- Entry from A.')
    expect(run(project, 'status', '--porcelain')).toBe('')
    const tipB = run(project, 'rev-parse', b.branch)
    const elsewhere = await mergeWorktree(project, a, { squash: false, message: 'A', target: b.branch.toUpperCase() })
    expect(elsewhere.ok).toBe(false)
    expect(elsewhere.error).toContain(`${b.branch} is checked out in`)
    expect(run(project, 'rev-parse', b.branch)).toBe(tipB)
    expect(await mergeWorktree(project, a, { squash: false, message: 'A', target: a.branch.toUpperCase() })).toEqual({ ok: false, error: `${a.branch} can't be merged into itself.` })
  })

  // HI-2422: a tag of the branch's name, at a commit the target already has, made git say "Already up to date" (a
  // warning, exit 0) and Combwork report the merge done, with the branch's work never merged.
  for (const squash of [false, true]) {
    it(`merges the branch, not a same-named tag, into the checked-out target (${squash ? 'squash' : 'merge commit'})`, async () => {
      const { project, a } = await twoBranches()
      run(project, 'tag', a.branch, 'refs/heads/main')
      // A squash keeping the worktree moves its branch too: the check that the worktree is on it reads it past the tag.
      const r = await mergeWorktree(project, a, { squash, message: 'A', ...(squash ? { moveBranch: true } : {}) })
      const main = run(project, 'rev-parse', 'refs/heads/main').trim()
      expect(r).toEqual({ ok: true, mergeCommit: main, ...(squash ? { branchMoved: true } : {}) })
      expect(readFileSync(join(project, 'CHANGELOG.md'), 'utf8')).toContain('- Entry from A.')
      expect(run(project, 'log', '-1', '--format=%P', 'refs/heads/main').trim().split(' ')).toHaveLength(squash ? 1 : 2)
      expect(run(project, 'status', '--porcelain')).toBe('')
      if (squash) expect(run(project, 'rev-parse', `refs/heads/${a.branch}`).trim()).toBe(main)
    })
  }

  // A tag `main` at the branch's own tip: the checked-out branch was read as heads/main (so a merge naming main as its
  // target was refused as checked out elsewhere), and a bare main for the move would be the tag, where the branch is.
  for (const target of [undefined, 'main']) {
    it(`a tag named as the target: the checked-out branch is merged into, and the agent's branch moved to it after a squash (HI-2422, target ${target ?? 'not named'})`, async () => {
      const { project, a } = await twoBranches()
      run(project, 'tag', 'main', `refs/heads/${a.branch}`)
      const r = await mergeWorktree(project, a, { squash: true, message: 'A', moveBranch: true, ...(target ? { target } : {}) })
      const main = run(project, 'rev-parse', 'refs/heads/main').trim()
      expect(r).toEqual({ ok: true, mergeCommit: main, branchMoved: true })
      expect(run(project, 'rev-parse', `refs/heads/${a.branch}`).trim()).toBe(main)
      expect(readFileSync(join(project, 'CHANGELOG.md'), 'utf8')).toContain('- Entry from A.')
    })
  }

  it('finds conflicts with a target checked out nowhere, and changes nothing', async () => {
    const { project, a } = await twoBranches()
    run(project, 'branch', 'release')
    run(project, 'checkout', '-q', 'release')
    // Not CHANGELOG.md: the repo's .gitattributes merges it by union, so it never conflicts.
    writeFileSync(join(project, 'notes.txt'), 'release\n')
    run(project, 'add', '-A')
    run(project, 'commit', '-qm', 'release')
    run(project, 'checkout', '-q', 'main')
    writeFileSync(join(a.path, 'notes.txt'), 'a\n')
    run(a.path, 'add', '-A')
    run(a.path, 'commit', '-qm', 'a notes')
    run(project, 'checkout', '-q', 'release')
    run(project, 'checkout', '-q', 'main')
    const release = run(project, 'rev-parse', 'release')
    expect(await mergeWorktree(project, a, { squash: true, message: 'A', target: 'release' })).toEqual({ ok: false, conflicts: ['notes.txt'] })
    expect(run(project, 'rev-parse', 'release')).toBe(release)
  })
})
