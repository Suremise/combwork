// The repository context port (SPEC §16.3.6, HI-2784's R1): a repository's context (its store, workspace and root), its
// runner and locks, delegating to today's Git code unchanged. Proved by trace: the same git commands (argv, folder, order)
// and the same repository lock takes and releases (store, order) through the port as through the code it replaces. The
// import rule for callers moved to the port is tests/repoPortsImports.test.ts (check:repo's).
import { mkdirSync, realpathSync } from 'fs'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { gitRepo, sh } from './workflow/harness'

/** Each repository lock request the lock's worker got, in order: take or release, and its store. */
const lockTrace: string[] = []
vi.mock('../src/main/repoLockWorker', async (original) => {
  const real = await original<typeof import('../src/main/repoLockWorker')>()
  return {
    ...real,
    handleRequest: (m: Parameters<typeof real.handleRequest>[0], post: Parameters<typeof real.handleRequest>[1]) => {
      lockTrace.push(`${m.type} ${m.dir.toLowerCase()}`)
      return real.handleRequest(m, post)
    }
  }
})

const { git, gitTestHooks } = await import('../src/main/git')
const { commonGitDir, inStoreOrder, withRepoLock, withRepoLocks } = await import('../src/main/repoLock')
const { repoLockHolder } = await import('../src/main/repoLockCore')
const { gitRepoPorts } = await import('../src/main/platform/gitRepoPorts')
const { hasRepository, portsOf, repoContext, repoContexts, repoPortsOf, withFolderRepoLocks } = await import('../src/main/platform/repoPorts')
const { sameStore } = await import('../src/main/platform/repoContext')

// Real git work, not a wait: a few git commands per test.
vi.setConfig({ testTimeout: 60_000 })

afterEach(() => {
  gitTestHooks.started = undefined
  lockTrace.length = 0
})

/** The git commands started while `fn` ran (folder and arguments), the lock requests it made, and its answer. */
async function traced<T>(fn: () => Promise<T>): Promise<{ git: string[]; locks: string[]; v: T }> {
  const ran: string[] = []
  lockTrace.length = 0
  gitTestHooks.started = (cwd, args) => void ran.push(`${resolve(cwd).toLowerCase()} :: ${args.join(' ')}`)
  try {
    const v = await fn()
    return { git: ran, locks: [...lockTrace], v }
  } finally {
    gitTestHooks.started = undefined
  }
}

/** A repository with a linked worktree, a subfolder (no `.git` of its own: git is asked) and a folder in no repository. */
function repos() {
  const base = tempDir('cw-repo-ports-')
  const a = gitRepo(join(base, 'a'))
  const b = gitRepo(join(base, 'b'))
  const tree = join(base, 'a-tree')
  sh(a, 'worktree', 'add', '-q', '-b', 'side', tree)
  const sub = join(a, 'sub')
  mkdirSync(sub)
  const none = tempDir('cw-repo-ports-none-')
  return { a, b, tree, sub, none }
}

describe('a repository context', () => {
  it("names the store as the repository lock's commonGitDir, the folder's own git dir and its root; none outside a repository", async () => {
    const { a, tree, sub, none } = repos()
    const main = (await repoContext(a))!
    expect(main).toMatchObject({ platform: 'git', store: await commonGitDir(a), root: resolve(a), folder: a })
    expect(main.workspace.toLowerCase()).toBe(realpathSync(join(a, '.git')).toLowerCase())
    expect(main.subfolder).toBeUndefined()

    const linked = (await repoContext(tree))!
    expect(sameStore(linked, main)).toBe(true)
    expect(linked.root).toBe(resolve(tree))
    expect(linked.workspace.toLowerCase()).toBe(realpathSync(join(a, '.git', 'worktrees', 'a-tree')).toLowerCase())

    const inside = (await repoContext(sub))!
    expect(inside).toMatchObject({ root: resolve(a), folder: sub, subfolder: true })
    expect(sameStore(inside, main)).toBe(true)

    expect(await repoContext(none)).toBeNull()
    expect(await repoContexts([none, a, none])).toHaveLength(1)
  })

  it('is found by the platform a project names: Git has one, None none', async () => {
    const { a } = repos()
    expect(hasRepository('git')).toBe(true)
    expect(hasRepository('none')).toBe(false)
    expect(await repoContext(a, 'none')).toBeNull()
    const ctx = (await repoContext(a, 'git'))!
    expect(portsOf(ctx)).toBe(gitRepoPorts)
    expect(repoPortsOf('git')?.metadataDirs).toEqual(['.git'])
  })
})

describe('the runner', () => {
  it('runs the same git command in the same folder as git(), with the same answer', async () => {
    const { tree } = repos()
    const ctx = (await repoContext(tree))!
    const before = await traced(() => git(tree, ['rev-parse', '--abbrev-ref', 'HEAD']))
    const after = await traced(() => gitRepoPorts.runner.run(ctx, ['rev-parse', '--abbrev-ref', 'HEAD']))
    expect(after.git).toEqual(before.git)
    expect(after.v.out).toBe(before.v.out)
    expect(after.v.ok).toBe(true)
    expect(after.v.code).toBe(0)
  })

  it('passes its input and bound as git() takes them: past the bound the command didn\'t run to an exit', async () => {
    const { a } = repos()
    const ctx = (await repoContext(a))!
    const hashed = await gitRepoPorts.runner.run(ctx, ['hash-object', '--stdin'], { input: 'x\n' })
    expect(hashed.out.trim()).toBe((await git(a, ['hash-object', '--stdin'], undefined, 'x\n')).out.trim())
    const bounded = await gitRepoPorts.runner.run(ctx, ['log', '-1', '--format=%H%n%H%n%H'], { maxOutput: 8 })
    const legacy = await git(a, ['log', '-1', '--format=%H%n%H%n%H'], 8)
    expect({ ok: bounded.ok, code: bounded.code, notRun: !!bounded.notRun }).toEqual({ ok: legacy.ok, code: legacy.code, notRun: !!legacy.notRun })
    expect(bounded.ok).toBe(false)
  })
})

describe('the locks', () => {
  it("withFolderRepoLocks runs the same git commands and takes the same stores' locks, in the same order, as withRepoLocks", async () => {
    const { a, b, tree, sub, none } = repos()
    // Deliberately unsorted, with one store reached three ways (its root, a worktree, a subfolder git is asked about).
    const folders = [b, sub, none, tree, a]
    const held = (): (string | undefined)[] => [a, b].map((f) => repoLockHolder(realpathSync(join(f, '.git')))?.profile)
    const before = await traced(() => withRepoLocks(folders, async () => held(), { quiet: true }))
    const after = await traced(() => withFolderRepoLocks(folders, async () => held(), { quiet: true }))
    expect(before.v.every(Boolean)).toBe(true)
    expect(after.v).toEqual(before.v)
    expect(after.git).toEqual(before.git)
    // The subfolder has no `.git` of its own: git names its store, so the trace has git in it, not only file reads.
    expect(before.git.some((l) => l.includes('--git-common-dir'))).toBe(true)
    expect(after.locks).toEqual(before.locks)
    expect(before.locks.map((l) => l.split(' ')[0])).toEqual(['take', 'take', 'release', 'release'])
  })

  it('withRepoLock through the port takes the same row as withRepoLock of the folder', async () => {
    const { tree } = repos()
    const ctx = (await repoContext(tree))!
    const before = await traced(() => withRepoLock(tree, async () => repoLockHolder(ctx.store)?.pid))
    const after = await traced(() => gitRepoPorts.locks.withRepoLock(ctx, async () => repoLockHolder(ctx.store)?.pid))
    expect(after.v).toBe(process.pid)
    expect(after.v).toBe(before.v)
    expect(after.git).toEqual(before.git)
    expect(after.locks).toEqual(before.locks)
  })

  it('orders stores by path, case-insensitively, each once by its first folder', () => {
    const order = inStoreOrder([
      { store: 'D:\\r\\B\\.git', folder: 'b1' },
      { store: 'd:\\r\\a\\.git', folder: 'a1' },
      { store: 'D:\\R\\A\\.git', folder: 'a2' },
      { store: 'd:\\r\\b\\.git', folder: 'b2' }
    ])
    expect(order).toEqual(['a1', 'b1'])
  })
})
