// A worktree as it is now in two gits (#1374): its branch, head and uncommitted state, a line's head and git paths,
// as branch(), head(), dirty() and lineHead() answer them one git each. And an intent's evidence with fewer gits
// (#1373): the git dir read from `.git`, the index listed once.
import { execFileSync } from 'child_process'
import { existsSync, realpathSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../tempDir'
import { B1, commit, gitRepo, moved, setup, sh } from './harness'
import * as G from '../../src/main/platform/git'
import { isUnknown } from '../../src/main/platform/types'
import { preset } from '../../src/shared/workflow/options'

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

describe('gitDirSync (#1373)', () => {
  it("answers as git's --absolute-git-dir in a repository and a linked worktree; null in a subfolder or outside one", () => {
    const repo = gitRepo(join(tempDir('git-'), 'r'))
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'side', wt, 'main')
    const real = (p: string | null) => (p === null ? null : realpathSync(p).toLowerCase())
    for (const f of [repo, wt]) expect(real(G.gitDirSync(f))).toBe(real(sh(f, 'rev-parse', '--path-format=absolute', '--absolute-git-dir')))
    expect(G.gitDirSync(join(repo, 'src'))).toBeNull()
    expect(G.gitDirSync(tempDir('git-none-'))).toBeNull()
  })
})

describe("an intent's evidence (#1373)", () => {
  it('reads the index once for its first answer, as git would give it; asked again, it reads it afresh', async () => {
    const e = setup({ ...preset('git', 'pair'), finish: 'agentMerges', preChecks: [], mergeChecks: [] })
    try {
      const c = e.wf.createCard({ title: 'One' })
      const st = await e.wf.start(c.key, B1)
      moved(st)
      const folder = st.data!.folder as string
      commit(folder, { 'a.txt': 'a\n' }, 'a')
      const card = e.store.cardByKey(c.key)!
      const s = e.wf.state(card)
      const p = e.wf.platform(e.options)
      const before = await e.wf.evidenceOf(card, s, e.options)
      // The same answer as a prime with nothing kept for it (content reading the index itself).
      const fresh = (await p.prime(card, s, e.options)) as Record<string, unknown>
      delete fresh.staged
      expect(before.content).not.toBeNull()
      expect(before.content).toBe(await p.content(card, s, e.options, fresh))
      // A change staged meanwhile (to a tracked file, so no folder's stat moves: only the index tells): asked again with
      // the same primed reads (as revalidate asks), the index is read again.
      writeFileSync(join(folder, 'a.txt'), 'changed\n')
      sh(folder, 'add', 'a.txt')
      expect(await p.content(card, s, e.options, before.primed)).not.toBe(before.content)
    } finally {
      e.close()
    }
  })
})
