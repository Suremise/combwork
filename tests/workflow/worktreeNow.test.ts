// A worktree as it is now in two gits (#1374): its branch, head and uncommitted state, a line's head and git paths,
// as branch(), head(), dirty() and lineHead() answer them one git each. And an intent's evidence with fewer gits
// (#1373): the git dir read from `.git`, the index listed once.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { junction } from '../pathAliases'
import { tempDir } from '../tempDir'
import { B1, commit, gitRepo, moved, setup, sh } from './harness'
import * as G from '../../src/main/platform/git'
import { gitTestHooks } from '../../src/main/git'
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

  it('its markers and a line the ref files name are read from .git with no git process, a merge under way still seen; git where they can\'t say (HI-1970)', async () => {
    const repo = gitRepo(join(tempDir('git-'), 'r'))
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
    commit(wt, { 'a.txt': 'mine\n' }, 'mine')
    commit(repo, { 'a.txt': 'theirs\n' }, 'theirs')
    expect(() => sh(wt, 'merge', '-q', 'main')).toThrow()
    const asked: string[] = []
    gitTestHooks.started = (_cwd, args) => void asked.push(args[0])
    try {
      expect(await G.worktreeNow(wt, { target: 'main' })).toMatchObject({ line: 'card', target: sh(repo, 'rev-parse', 'main'), dirty: expect.arrayContaining(['(MERGE_HEAD)']) })
      expect(asked).toEqual(['status'])
      // Packed: still read from the files.
      sh(repo, 'pack-refs', '--all')
      asked.length = 0
      expect(await G.worktreeNow(wt, { target: 'main' })).toMatchObject({ target: sh(repo, 'rev-parse', 'main') })
      expect(asked).toEqual(['status'])
      // A line the files don't name: git's answer.
      asked.length = 0
      expect(await G.worktreeNow(wt, { target: 'gone' })).toMatchObject({ target: null })
      expect(asked).toContain('rev-parse')
    } finally {
      gitTestHooks.started = undefined
    }
  })

  it("the repository lock's git folder from .git, one real path however the folder is reached (HI-1970)", async () => {
    const repo = gitRepo(join(tempDir('git-'), 'r'))
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
    const viaJunction = junction(repo, join(repo, '..', 'j'))
    const { commonGitDir } = await import('../../src/main/repoLock')
    const asked: string[] = []
    gitTestHooks.started = (_cwd, args) => void asked.push(args[0])
    try {
      const real = realpathSync.native(join(repo, '.git'))
      expect(await commonGitDir(repo)).toBe(real)
      expect(await commonGitDir(wt)).toBe(real)
      expect(await commonGitDir(viaJunction)).toBe(real)
      expect(asked).toEqual([])
      // A subfolder has no `.git` of its own: git says, the same path.
      const sub = join(repo, 'sub')
      mkdirSync(sub)
      expect(await commonGitDir(sub)).toBe(real)
    } finally {
      gitTestHooks.started = undefined
    }
  })

  it("GIT_DIR set: git's repository, not the folder's `.git` (HR3's HI-1970 round 1)", async () => {
    const a = gitRepo(join(tempDir('git-'), 'a'))
    const b = gitRepo(join(tempDir('git-'), 'b'))
    const bHead = commit(b, { 'b.txt': 'b\n' }, 'b moves')
    const { commonGitDir } = await import('../../src/main/repoLock')
    const env = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE }
    process.env.GIT_DIR = join(b, '.git')
    process.env.GIT_WORK_TREE = b
    try {
      expect(G.gitDirSync(a)).toBeNull()
      expect(await commonGitDir(a)).toBe(realpathSync.native(join(b, '.git')))
      expect(await commonGitDir(a)).toBe(realpathSync.native(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: a, encoding: 'utf8', env: process.env }).trim()))
      expect(await G.worktreeNow(a, { target: 'main' })).toMatchObject({ target: bHead })
    } finally {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('a branch with a diverged upstream: the same branch, head and files, with no ahead/behind count asked of git (#1377)', async () => {
    const repo = gitRepo(join(tempDir('git-'), 'r'))
    // A clone whose main is its upstream, both sides moved on.
    const clone = join(repo, '..', 'clone')
    execFileSync('git', ['clone', '-q', repo, clone])
    sh(clone, 'config', 'core.autocrlf', 'false')
    commit(repo, { 'theirs.txt': 'theirs\n' }, 'upstream moves')
    sh(clone, 'fetch', '-q')
    const mine = commit(clone, { 'mine.txt': 'mine\n' }, 'local moves')
    writeFileSync(join(clone, 'new.txt'), 'new\n')
    // Git counts it by default: the walk worktreeNow leaves out.
    expect(sh(clone, 'status', '--porcelain=v2', '--branch')).toMatch(/^# branch\.ab \+1 -1$/m)
    const asked: string[][] = []
    gitTestHooks.started = (_cwd, args) => {
      if (args[0] === 'status') asked.push([...args])
    }
    try {
      expect(await G.worktreeNow(clone, { target: 'main' })).toEqual({ line: 'main', head: mine, dirty: ['new.txt'], target: mine, gitPaths: [] })
    } finally {
      gitTestHooks.started = undefined
    }
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('--no-ahead-behind')
    expect(await G.dirty(clone)).toEqual(['new.txt'])
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
