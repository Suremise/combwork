// HI-2025: the harness's repositories are whole copies of one made once per test file (harness.ts, gitRepo). Each copy is
// what freshGitRepo makes (branch, config, tree, message; clean, its index fresh) and independent of every other copy and
// of the template: changing one copy's config, index, refs, hooks or files changes nothing in another, nor in a copy
// made afterwards.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../tempDir'
import { commit, freshGitRepo, gitRepo, sh } from './harness'

/** What a copy must be: freshGitRepo's repository, whatever its commit's id (made at another time). */
function described(dir: string) {
  return {
    branch: sh(dir, 'branch', '--show-current'),
    branches: sh(dir, 'branch', '--format=%(refname:short)'),
    commits: sh(dir, 'rev-list', '--count', 'HEAD'),
    message: sh(dir, 'log', '-1', '--format=%s'),
    tree: sh(dir, 'rev-parse', 'HEAD^{tree}'),
    name: sh(dir, 'config', '--local', 'user.name'),
    email: sh(dir, 'config', '--local', 'user.email'),
    autocrlf: sh(dir, 'config', '--local', 'core.autocrlf'),
    status: sh(dir, 'status', '--porcelain', '--untracked-files=all'),
    // diff-files doesn't refresh the index: empty only when the copy's index was refreshed.
    diffFiles: sh(dir, 'diff-files', '--name-only'),
    readme: readFileSync(join(dir, 'README.md'), 'utf8')
  }
}

describe("the harness's repository template (HI-2025)", () => {
  it('a copy is what freshGitRepo makes: main, one commit, the same tree, message and config; clean, its index fresh', () => {
    const fresh = described(freshGitRepo(join(tempDir('tpl-fresh-'), 'repo')))
    const copy = described(gitRepo(join(tempDir('tpl-copy-'), 'repo')))
    expect(copy).toEqual(fresh)
    expect(copy).toMatchObject({ branch: 'main', branches: 'main', commits: '1', status: '', diffFiles: '' })
  })

  it("changing one copy's config, index, refs, hooks and files changes nothing in another, nor in one made afterwards", () => {
    const a = gitRepo(join(tempDir('tpl-a-'), 'repo'))
    const b = gitRepo(join(tempDir('tpl-b-'), 'repo'))
    const pristine = described(b)
    const head = sh(b, 'rev-parse', 'HEAD')
    // Copy A changed every way a test can.
    sh(a, 'config', 'user.name', 'Someone Else')
    sh(a, 'config', 'core.autocrlf', 'true')
    writeFileSync(join(a, 'README.md'), 'changed\n')
    sh(a, 'add', 'README.md')
    commit(a, { 'src/new.txt': 'new\n' }, 'a commit in A')
    sh(a, 'branch', 'side')
    sh(a, 'update-ref', 'refs/cw/marker', 'HEAD')
    writeFileSync(join(a, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n')
    writeFileSync(join(a, 'src', 'a.txt'), 'edited, uncommitted\n')
    expect(sh(a, 'rev-parse', 'HEAD')).not.toBe(head)
    // B as it was; a copy made now as B was made.
    const c = gitRepo(join(tempDir('tpl-c-'), 'repo'))
    for (const dir of [b, c]) {
      expect(described(dir)).toEqual(pristine)
      expect(sh(dir, 'rev-parse', 'HEAD')).toBe(head)
      expect(sh(dir, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main')
      expect(existsSync(join(dir, '.git', 'hooks', 'pre-commit'))).toBe(false)
      expect(existsSync(join(dir, 'src', 'new.txt'))).toBe(false)
    }
  })

  it('a copy into a folder that already has files keeps them, untracked, as git init there did', () => {
    const dir = join(tempDir('tpl-into-'), 'repo')
    const earlier = join(dir, '.combwork', 'project.json')
    mkdirSync(join(dir, '.combwork'), { recursive: true })
    writeFileSync(earlier, '{}')
    gitRepo(dir)
    expect(readFileSync(earlier, 'utf8')).toBe('{}')
    expect(sh(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('?? .combwork/project.json')
  })
})
