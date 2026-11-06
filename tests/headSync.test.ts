// A folder's checkout read from its ref files with no git process (platform/git.ts headSync, HI-1731): the guard of a
// carried lease's end reads it again inside the pool's write. Its branch and commit as git has them, in a repository
// and in a linked worktree, with a loose ref, a packed one and a detached HEAD; null (unknown, so the guard keeps the
// lease) where it can't be read.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'
import { headSync } from '../src/main/platform/git'

const rev = (folder: string, what = 'HEAD'): string => sh(folder, 'rev-parse', what).trim()

describe("headSync: a checkout's branch and commit from its ref files", () => {
  it('a branch with a loose ref, in the repository and in a linked worktree, as git says', () => {
    const repo = join(tempDir('headsync-'), 'repo')
    gitRepo(repo)
    commit(repo, { 'a.txt': 'a\n' }, 'first')
    expect(headSync(repo)).toEqual({ line: sh(repo, 'symbolic-ref', '--short', 'HEAD').trim(), head: rev(repo) })
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'cw/side', wt)
    commit(wt, { 'b.txt': 'b\n' }, 'side')
    expect(headSync(wt)).toEqual({ line: 'cw/side', head: rev(wt) })
    // A commit since: read again, the new one.
    commit(wt, { 'c.txt': 'c\n' }, 'more')
    expect(headSync(wt)?.head).toBe(rev(wt))
  })

  it('a packed ref (no loose file left), and a detached HEAD', () => {
    const repo = join(tempDir('headsync-packed-'), 'repo')
    gitRepo(repo)
    commit(repo, { 'a.txt': 'a\n' }, 'first')
    sh(repo, 'pack-refs', '--all', '--prune')
    const branch = sh(repo, 'symbolic-ref', '--short', 'HEAD').trim()
    expect(headSync(repo)).toEqual({ line: branch, head: rev(repo) })
    sh(repo, 'checkout', '-q', '--detach')
    expect(headSync(repo)).toEqual({ line: null, head: rev(repo) })
  })

  it("null where it can't be read: no repository, a branch with no commit yet, a damaged HEAD, a missing worktree's git dir", () => {
    const base = tempDir('headsync-none-')
    const plain = join(base, 'plain')
    mkdirSync(plain, { recursive: true })
    expect(headSync(plain)).toBeNull()
    expect(headSync(join(base, 'missing'))).toBeNull()
    // A repository whose branch has no commit yet: its ref doesn't exist.
    const empty = join(base, 'empty')
    mkdirSync(empty)
    sh(empty, 'init', '-q', '-b', 'main')
    expect(headSync(empty)).toBeNull()
    const repo = join(base, 'repo')
    gitRepo(repo)
    commit(repo, { 'a.txt': 'a\n' }, 'first')
    const wt = join(base, 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'cw/gone', wt)
    // Its HEAD damaged: neither a ref nor a commit.
    const gitDir = sh(wt, 'rev-parse', '--absolute-git-dir').trim()
    writeFileSync(join(gitDir, 'HEAD'), 'not a head\n')
    expect(headSync(wt)).toBeNull()
    // Its git dir gone (the worktree pruned under it).
    rmSync(gitDir, { recursive: true, force: true })
    expect(headSync(wt)).toBeNull()
  })
})
