// Fewer git starts (HI-2115): answers about fixed commits (an ancestor, a merge base, a range's first parents) kept for
// as long as Hive runs, never while the repository's history can differ under the same ids (shallow, replace refs,
// grafts), never for names or unknown answers, and never across repositories. (The slots' finished-card look, the
// other cut, is tested in slotCards.test.ts; the Git status item's in gitRepo.test.ts.)
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'
import { gitTestHooks } from '../src/main/git'
import { firstParents, forgetKeptAnswers, gitStep, isAncestor, mergeBase } from '../src/main/platform/git'
import { isUnknown } from '../src/main/platform/types'

// Real git work, not a wait: a few dozen git commands per test.
vi.setConfig({ testTimeout: 60_000 })

/** The git commands started while `fn` ran (their arguments), and its answer. */
async function counted<T>(fn: () => Promise<T>): Promise<{ ran: string[][]; v: T }> {
  const ran: string[][] = []
  gitTestHooks.started = (_cwd, args) => void ran.push([...args])
  try {
    return { v: await fn(), ran }
  } finally {
    gitTestHooks.started = undefined
  }
}
const rev = (folder: string, what = 'HEAD'): string => sh(folder, 'rev-parse', what)

beforeEach(() => forgetKeptAnswers())
afterEach(() => {
  gitTestHooks.started = undefined
})

describe('answers about fixed commits, kept', () => {
  /** A repository with main (a, b) and a line from a (c): ids of each. */
  function history(): { repo: string; a: string; b: string; c: string } {
    const repo = join(tempDir('kept-'), 'repo')
    gitRepo(repo)
    const a = rev(repo)
    const b = commit(repo, { 'b.txt': 'b\n' }, 'b')
    sh(repo, 'switch', '-q', '-c', 'line', a)
    const c = commit(repo, { 'c.txt': 'c\n' }, 'c')
    sh(repo, 'switch', '-q', 'main')
    return { repo, a, b, c }
  }

  it('asked once across steps, in the repository and its linked worktree alike; answers as git does', async () => {
    const { repo, a, b, c } = history()
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', '--detach', wt)
    const first = await counted(() => gitStep(async () => [await isAncestor(repo, a, b), await isAncestor(repo, c, b), await mergeBase(repo, b, c), await firstParents(repo, a, b)]))
    expect(first.v).toEqual([true, false, a, [b]])
    expect(first.ran.length).toBe(4)
    // Another step (the next reconcile), outside any step, and in the worktree: no git.
    const again = await counted(() => gitStep(async () => [await isAncestor(repo, a, b), await isAncestor(wt, c, b), await mergeBase(wt, b, c), await firstParents(repo, a, b)]))
    expect(again.v).toEqual(first.v)
    expect(again.ran).toEqual([])
    expect((await counted(() => isAncestor(repo, a, b))).ran).toEqual([])
  })

  it('names and unknown answers are never kept', async () => {
    const { repo, a, b } = history()
    for (let i = 0; i < 2; i++) expect((await counted(() => isAncestor(repo, a, 'main'))).ran.length).toBe(1)
    const missing = 'f'.repeat(40)
    for (let i = 0; i < 2; i++) {
      const r = await counted(() => isAncestor(repo, missing, b))
      expect(isUnknown(r.v)).toBe(true)
      expect(r.ran.length).toBe(1)
    }
  })

  it('never answered from what was kept while a replace ref or a graft is there, and kept again once they go', async () => {
    const { repo, a, b, c } = history()
    expect(await isAncestor(repo, c, b)).toBe(false)
    // b replaced by a commit whose parent is c: c is now b's ancestor, as git says, never the kept "no".
    const fake = sh(repo, 'commit-tree', `${b}^{tree}`, '-p', c, '-m', 'fake')
    sh(repo, 'replace', b, fake)
    for (let i = 0; i < 2; i++) {
      const r = await counted(() => isAncestor(repo, c, b))
      expect(r.v).toBe(true)
      expect(r.ran.length).toBe(1)
    }
    // Packed, the loose folder gone: still seen.
    sh(repo, 'pack-refs', '--all', '--prune')
    rmSync(join(repo, '.git', 'refs', 'replace'), { recursive: true, force: true })
    expect((await counted(() => isAncestor(repo, c, b))).ran.length).toBe(1)
    sh(repo, 'replace', '-d', b)
    rmSync(join(repo, '.git', 'refs', 'replace'), { recursive: true, force: true })
    sh(repo, 'pack-refs', '--all', '--prune')
    expect((await counted(() => isAncestor(repo, c, b))).v).toBe(false)
    // A graft (info/grafts: b's parent is c) likewise.
    expect(await isAncestor(repo, a, b)).toBe(true)
    mkdirSync(join(repo, '.git', 'info'), { recursive: true })
    writeFileSync(join(repo, '.git', 'info', 'grafts'), `${b} ${c}\n`)
    const grafted = await counted(() => isAncestor(repo, c, b))
    expect(grafted.ran.length).toBe(1)
    rmSync(join(repo, '.git', 'info', 'grafts'))
    const plain = await counted(() => isAncestor(repo, a, b))
    expect(plain).toEqual({ v: true, ran: [] })
  })

  it("a reftable repository is never plain: a replacement inside the reftable is git's answer at once (HR3's round 2, finding 1)", async () => {
    const repo = join(tempDir('kept-reftable-'), 'repo')
    sh(join(repo, '..'), 'init', '-q', '--ref-format=reftable', '-b', 'main', repo)
    const a = commit(repo, { 'a.txt': 'a\n' }, 'a')
    const b = commit(repo, { 'b.txt': 'b\n' }, 'b')
    sh(repo, 'switch', '-q', '-c', 'line', a)
    const c = commit(repo, { 'c.txt': 'c\n' }, 'c')
    const before = await counted(() => isAncestor(repo, c, b))
    expect(before.v).toBe(false)
    expect((await counted(() => isAncestor(repo, c, b))).ran.length).toBe(1)
    sh(repo, 'replace', b, sh(repo, 'commit-tree', `${b}^{tree}`, '-p', c, '-m', 'fake'))
    expect(await isAncestor(repo, c, b)).toBe(true)
  })

  it("a linked worktree whose own config.worktree gains an include: not plain there, so git again (HR3's round 3, finding 2)", async () => {
    const { repo, a, b } = history()
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', '--detach', wt)
    expect((await counted(() => isAncestor(wt, a, b))).ran.length).toBe(1)
    expect((await counted(() => isAncestor(wt, a, b))).ran).toEqual([])
    writeFileSync(join(sh(wt, 'rev-parse', '--absolute-git-dir'), 'config.worktree'), '[include]\n\tpath = more.config\n')
    expect(await counted(() => isAncestor(wt, a, b))).toEqual({ v: true, ran: [expect.any(Array)] })
    // The project's own folder (another git dir, its config.worktree plain) still answers from what was kept.
    expect((await counted(() => isAncestor(repo, a, b))).ran).toEqual([])
  })

  it("metadata that can't be read is never taken for plain: what was kept isn't given (HR3's round 3, finding 1)", async () => {
    const { repo, a, b } = history()
    expect(await isAncestor(repo, a, b)).toBe(true)
    expect((await counted(() => isAncestor(repo, a, b))).ran).toEqual([])
    // A config file that is there but can't be read (here a folder in its place: EISDIR, not "no such file").
    const worktreeConfig = join(repo, '.git', 'config.worktree')
    mkdirSync(worktreeConfig)
    expect((await counted(() => isAncestor(repo, a, b))).ran.length).toBe(1)
    rmSync(worktreeConfig, { recursive: true })
    expect((await counted(() => isAncestor(repo, a, b))).ran).toEqual([])
    // packed-refs likewise: git is asked (whatever it answers), never the kept "yes".
    mkdirSync(join(repo, '.git', 'packed-refs'))
    expect((await counted(() => isAncestor(repo, a, b))).ran.length).toBe(1)
    rmSync(join(repo, '.git', 'packed-refs'), { recursive: true })
    expect((await counted(() => isAncestor(repo, a, b))).ran).toEqual([])
  })

  it('another replace namespace named in the environment: never kept', async () => {
    const { repo, a, b } = history()
    process.env.GIT_REPLACE_REF_BASE = 'refs/other-replace/'
    try {
      expect((await counted(() => isAncestor(repo, a, b))).ran.length).toBe(1)
      expect((await counted(() => isAncestor(repo, a, b))).ran.length).toBe(1)
    } finally {
      delete process.env.GIT_REPLACE_REF_BASE
    }
  })

  it('a shallow repository: asked each time; deepened, the answers are the whole history’s', async () => {
    const { repo, a, b } = history()
    const shallow = join(repo, '..', 'shallow')
    sh(join(repo, '..'), 'clone', '-q', '--depth', '1', '--no-local', `file://${repo.replace(/\\/g, '/')}`, shallow)
    const s1 = await counted(() => isAncestor(shallow, a, b))
    expect(isUnknown(s1.v) || s1.v === false).toBe(true)
    expect(s1.ran.length).toBe(1)
    sh(shallow, 'fetch', '-q', '--unshallow')
    const deep = await counted(() => isAncestor(shallow, a, b))
    expect(deep.v).toBe(true)
    expect(deep.ran.length).toBe(1)
    expect((await counted(() => isAncestor(shallow, a, b))).ran).toEqual([])
  })

  it("a folder reused for another repository never gets the other's answers", async () => {
    const one = history()
    expect(await isAncestor(one.repo, one.a, one.b)).toBe(true)
    // The same folder, now a copy whose b is c's descendant instead: another repository (its own common dir is the
    // same path, but the commit ids differ, so the answers asked are others).
    const other = join(tempDir('kept-other-'), 'repo')
    gitRepo(other)
    const x = rev(other)
    const y = commit(other, { 'y.txt': 'y\n' }, 'y')
    rmSync(one.repo, { recursive: true, force: true })
    cpSync(other, one.repo, { recursive: true })
    const r = await counted(() => isAncestor(one.repo, y, x))
    expect(r).toEqual({ v: false, ran: [r.ran[0]] })
    expect(r.ran.length).toBe(1)
  })
})
