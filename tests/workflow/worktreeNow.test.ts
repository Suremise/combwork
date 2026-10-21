// A worktree as it is now in two gits (#1374): its branch, head and uncommitted state, a line's head and git paths,
// as branch(), head(), dirty() and lineHead() answer them one git each.
import { execFileSync } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../tempDir'
import { commit, gitRepo, sh } from './harness'
import * as G from '../../src/main/platform/git'
import { isUnknown } from '../../src/main/platform/types'

describe('worktreeNow', () => {
  it("answers as branch, head, dirty and lineHead do, in a linked worktree, detached, and with a line that doesn't exist", async () => {
    const repo = gitRepo(join(tempDir('git-'), 'r'))
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'feature/card', wt, 'main')
    const mainHead = commit(repo, { 'b.txt': 'b\n' }, 'main moves')
    const now = await G.worktreeNow(wt, { target: 'main', gitPaths: ['index'] })
    expect(now).toEqual({ line: 'feature/card', head: await G.head(wt), dirty: [], target: mainHead, gitPaths: [sh(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'index')] })
    expect(isUnknown(now) || existsSync(now.gitPaths[0])).toBe(true)
    // Uncommitted files and a rebase under way (its marker in the worktree's own git folder).
    writeFileSync(join(wt, 'new.txt'), 'new\n')
    expect(await G.worktreeNow(wt)).toMatchObject({ line: 'feature/card', dirty: ['new.txt'] })
    sh(wt, 'add', 'new.txt')
    sh(wt, 'commit', '-qm', 'new')
    commit(repo, { 'new.txt': 'other\n' }, 'conflicting')
    expect(() => sh(wt, 'rebase', '-q', 'main')).toThrow()
    const rebasing = await G.worktreeNow(wt, { target: 'main' })
    expect(rebasing).toMatchObject({ line: null, target: sh(repo, 'rev-parse', 'main') })
    expect(isUnknown(rebasing) ? [] : rebasing.dirty).toEqual(expect.arrayContaining(['new.txt', '(rebase-merge)']))
    expect(await G.dirty(wt)).toEqual(isUnknown(rebasing) ? null : rebasing.dirty)
    sh(wt, 'rebase', '--abort')
    // Detached; and a line that doesn't exist is null, the rest still read.
    sh(wt, 'checkout', '-q', '--detach')
    expect(await G.worktreeNow(wt, { target: 'gone', gitPaths: ['index'] })).toMatchObject({ line: null, head: await G.head(wt), dirty: [], target: null, gitPaths: [expect.stringMatching(/index$/)] })
    expect(await G.branch(wt)).toBeNull()
  })

  it('a repository with no commit yet: no head, its files still listed', async () => {
    const dir = join(tempDir('git-'), 'empty')
    execFileSync('git', ['init', '-q', '-b', 'main', dir])
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    expect(await G.worktreeNow(dir)).toEqual({ line: 'main', head: null, dirty: ['a.txt'], gitPaths: [] })
    expect(await G.dirty(dir)).toEqual(['a.txt'])
  })

  it('a folder that is not a repository is unknown', async () => {
    expect(isUnknown(await G.worktreeNow(tempDir('git-none-')))).toBe(true)
  })
})
