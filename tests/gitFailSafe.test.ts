// One git command failing while the rest work (#346): a failed read is never an answer. Not "detached HEAD", so not
// "nothing to merge"; not "not a git repository", so not an empty Changes tab; not an empty list of a branch's changes.
// Real repositories; `failing` makes the one matching command fail as git would (exit 128, its message), and `answering`
// gives one command an answer of the test's (a failure, or an output git would give).
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

let failing: ((cwd: string, args: string[]) => boolean) | null = null
let answering: ((cwd: string, args: string[]) => { ok: boolean; out: string } | null) | null = null
vi.mock('../src/main/git', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/git')>()
  const failed = (): ReturnType<typeof real.git> => Promise.resolve({ out: '', ok: false, buf: Buffer.alloc(0), err: 'fatal: injected failure', code: 128 })
  const answer = (a: { ok: boolean; out: string }): ReturnType<typeof real.git> => (a.ok ? Promise.resolve({ out: a.out, ok: true, buf: Buffer.from(a.out), err: '', code: 0 }) : failed())
  const git: typeof real.git = (cwd, args, ...rest) => {
    const a = answering?.(cwd, args)
    return a ? answer(a) : failing?.(cwd, args) ? failed() : real.git(cwd, args, ...rest)
  }
  const gitReading: typeof real.gitReading = (cwd, args) => (failing?.(cwd, args) ? failed() : real.gitReading(cwd, args))
  return { ...real, git, gitReading }
})

const { gitStatus } = await import('../src/main/git')
const { branchStatus, mergeWorktree, createWorktree, RepoReads } = await import('../src/main/worktrees')
const { placeKey } = await import('../src/main/fsutil')

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
let root = ''

afterEach(() => {
  failing = null
  answering = null
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

const commit = (cwd: string, file: string): void => {
  writeFileSync(join(cwd, file), `${file}\n`)
  run(cwd, 'add', '-A')
  run(cwd, 'commit', '-qm', file)
}

/** A repository on main, a worktree hive/wt merged into main, and the project folder on `dest` (which lacks hive/wt's commit). */
async function project(): Promise<{ p: string; wt: { path: string; branch: string; base: string } }> {
  root = tempDir('hive-failsafe-')
  const p = join(root, 'project')
  run(root, 'init', '-q', '-b', 'main', p)
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) run(p, 'config', k, v)
  commit(p, 'a.txt')
  run(p, 'branch', 'dest')
  const wt = { path: join(root, 'wt'), branch: 'hive/wt', base: 'main' }
  await createWorktree(p, wt.path, wt.branch, 'main')
  commit(wt.path, 'w.txt')
  run(p, 'merge', '-q', '--ff-only', 'hive/wt')
  run(p, 'checkout', '-q', 'dest')
  return { p, wt }
}

const readsHead = (args: string[]): boolean => args.includes('rev-parse') && args.includes('--symbolic-full-name') && args.includes('HEAD')

describe('the checked-out branch', () => {
  it('counts against it when git reads it', async () => {
    const { p, wt } = await project()
    expect(await branchStatus(p, wt)).toMatchObject({ into: 'dest', ahead: 1, dirty: 0 })
  })

  it('a detached project folder counts against the base, a real answer', async () => {
    const { p, wt } = await project()
    run(p, 'checkout', '-q', '--detach', 'main')
    expect(await branchStatus(p, wt)).toMatchObject({ into: null, ahead: 0 })
  })

  it('a failed read is not a detached HEAD: no "nothing to merge", and no merge', async () => {
    const { p, wt } = await project()
    failing = (cwd, args) => cwd === p && readsHead(args)
    await expect(branchStatus(p, wt)).rejects.toThrow(/Git couldn't check hive\/wt: git couldn't read the branch checked out .*injected failure/)
    const merged = await mergeWorktree(p, wt, { squash: false, message: 'm' })
    expect(merged.ok).toBe(false)
    expect(merged.error).toMatch(/Nothing was merged: .*injected failure/)
  })

  it("the worktree's status failing alone is not clean", async () => {
    const { p, wt } = await project()
    failing = (cwd, args) => cwd === wt.path && args.includes('status')
    await expect(branchStatus(p, wt)).rejects.toThrow(/Git couldn't check hive\/wt/)
  })
})

describe('the Changes tab', () => {
  it('a folder git says is no repository is one', async () => {
    root = tempDir('hive-failsafe-')
    const plain = join(root, 'plain')
    mkdirSync(plain)
    // Above it, no repository either (a temp folder); git says so in its own words.
    expect(await gitStatus(plain)).toMatchObject({ isRepo: false, files: [] })
  })

  it('a damaged index is an error, not "not a git repository"', async () => {
    const { p } = await project()
    writeFileSync(join(p, '.git', 'index'), 'not an index')
    await expect(gitStatus(p)).rejects.toThrow(/git status failed/)
  })

  it("a failed diff against the base is an error, not an empty list of the branch's changes", async () => {
    const { p, wt } = await project()
    expect((await gitStatus(wt.path, 'dest')).files.map((f) => f.path)).toEqual(['w.txt'])
    // The merge base's tree is gone (a damaged repository): merge-base still answers, the diff against it can't.
    const tree = run(p, 'rev-parse', 'dest^{tree}').trim()
    rmSync(join(p, '.git', 'objects', tree.slice(0, 2), tree.slice(2)), { force: true })
    await expect(gitStatus(wt.path, 'dest')).rejects.toThrow(/git diff failed/)
  })

  it("a base git can't find is an error, not the working tree alone", async () => {
    const { wt } = await project()
    await expect(gitStatus(wt.path, 'no-such-branch')).rejects.toThrow(/git merge-base no-such-branch failed/)
  })
})

// One operation's reads (#732) keep what git answered, never a failure taken for an answer (#734): a worktree listing that
// failed read as none, and was kept as none for the rest of a template's plan or load.
describe("one operation's worktree listing", () => {
  const isList = (args: string[]): boolean => args[0] === 'worktree' && args[1] === 'list'
  const places = (l: { path: string }[]): string[] => l.map((w) => placeKey(w.path)).sort()

  it("a failed listing reads as none but isn't kept: the next read asks git again, and keeps its answer", async () => {
    const { p, wt } = await project()
    let lists = 0
    answering = (_cwd, args) => (isList(args) && ++lists === 1 ? { ok: false, out: '' } : null)
    const reads = new RepoReads(p)
    expect(await reads.worktrees()).toEqual([])
    const listed = places(await reads.worktrees())
    expect(listed).toEqual([placeKey(p), placeKey(wt.path)].sort())
    expect(places(await reads.worktrees())).toEqual(listed)
    expect(lists).toBe(2)
  })

  it('a listing git gave is kept, empty or not, until changed()', async () => {
    const { p, wt } = await project()
    let lists = 0
    // The first answer is an empty listing (git ran and listed nothing); the rest are git's own.
    answering = (_cwd, args) => (isList(args) && ++lists === 1 ? { ok: true, out: '' } : null)
    const reads = new RepoReads(p)
    expect(await reads.worktrees()).toEqual([])
    expect(await reads.worktrees()).toEqual([])
    expect(lists).toBe(1)
    reads.changed()
    expect(places(await reads.worktrees())).toEqual([placeKey(p), placeKey(wt.path)].sort())
    expect(lists).toBe(2)
    // A worktree made meanwhile: the kept listing stands until the operation says it changed something.
    const made = join(dirname(wt.path), 'made')
    await createWorktree(p, made, 'hive/made', 'main')
    expect(places(await reads.worktrees())).toEqual([placeKey(p), placeKey(wt.path)].sort())
    reads.changed()
    expect(places(await reads.worktrees())).toEqual([placeKey(p), placeKey(wt.path), placeKey(made)].sort())
    expect(lists).toBe(3)
  })
})
