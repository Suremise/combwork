// The evidence and history port (SPEC §16.3.6 port 3, HI-2787's R6): Git's history reads and the watcher, delegating to
// today's code unchanged. Proved by trace: each member runs the same git commands (argv, folder, order) with the same
// answer as the code it replaces (platform/git.ts's read, or the inline command a caller ran, kept here as it was), and
// the two check brackets keep their own tracked-file reads apart: a run's always runs both gits and takes an unreadable
// list for none; the queue's reads its git dir from `.git` first and takes an unreadable list for unread (null), never
// an empty one (HR5's #1386 round 1). The import rule for the callers moved is tests/historyPortsImports.test.ts.
import { mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

/** git commands this test fails (`notRun`, as a busy machine or an ended worker leaves them), by their first argument. */
const failing = vi.hoisted(() => ({ cmd: null as string | null, ran: [] as string[] }))
vi.mock('../src/main/git', async (original) => {
  const real = await original<typeof import('../src/main/git')>()
  return {
    ...real,
    git: (cwd: string, args: string[], ...rest: unknown[]) => {
      if (failing.cmd && args[0] === failing.cmd) {
        failing.ran.push(`${resolve(cwd).toLowerCase()} :: ${args.join(' ')} (failed)`)
        return Promise.resolve({ out: '', ok: false, buf: Buffer.alloc(0), err: '', code: -1, notRun: 'EAGAIN' })
      }
      return (real.git as (...a: unknown[]) => unknown)(cwd, args, ...rest)
    }
  }
})

const { git, gitTestHooks } = await import('../src/main/git')
const G = await import('../src/main/platform/git')
const { gitHistory } = await import('../src/main/platform/gitHistory')
const { hasHistory, historyFor, historyOf, lineHistory, observePort } = await import('../src/main/platform/historyPorts')
const { observer } = await import('../src/main/platform/observe')
const { bracketStart } = await import('../src/main/workflow/queueChecks')
const { checkStart } = await import('../src/main/workflow/runChecks')
const { pathChanges } = await import('../src/main/workflow/focusedRun')
const { isUnknown } = await import('../src/main/platform/types')

// Real git work, not a wait: a few git commands per test.
vi.setConfig({ testTimeout: 60_000 })

afterEach(() => {
  gitTestHooks.started = undefined
  failing.cmd = null
  failing.ran.length = 0
})

/** The git commands started while `fn` ran (folder and arguments; a failed one marked), and its answer. */
async function traced<T>(fn: () => Promise<T>): Promise<{ git: string[]; v: T }> {
  const ran: string[] = []
  failing.ran = ran
  gitTestHooks.started = (cwd, args) => void ran.push(`${resolve(cwd).toLowerCase()} :: ${args.join(' ')}`)
  try {
    return { git: ran, v: await fn() }
  } finally {
    gitTestHooks.started = undefined
  }
}

/** Runs `before` and `after` and expects the same git commands and answers (each with git.ts's kept answers forgotten first). */
async function same<T>(before: () => Promise<T>, after: () => Promise<T>): Promise<{ git: string[]; v: T }> {
  G.forgetKeptAnswers()
  const b = await traced(before)
  G.forgetKeptAnswers()
  const a = await traced(after)
  expect(a.git).toEqual(b.git)
  expect(a.v).toEqual(b.v)
  return a
}

/** A repository with a line of work (one commit past main), a linked worktree on it, and a subfolder with no `.git`. */
function repo() {
  const base = tempDir('cw-history-ports-')
  const a = gitRepo(join(base, 'a'))
  const main = sh(a, 'rev-parse', 'HEAD')
  sh(a, 'checkout', '-q', '-b', 'work')
  const work = commit(a, { 'src/b.txt': 'b\n' }, 'work', { trailer: 'AM-1' })
  sh(a, 'checkout', '-q', 'main')
  const tree = join(base, 'a-tree')
  sh(a, 'worktree', 'add', '-q', tree, 'work')
  const sub = join(a, 'src')
  mkdirSync(join(a, 'empty'), { recursive: true })
  return { a, tree, sub, main, work }
}

// The inline reads callers made before R6, kept as they were (the code each port member replaces).
const before = {
  /** targets.ts's dropEmptyLines, its worktree list. */
  async checkedOut(folder: string): Promise<Map<string, string> | 'unknown'> {
    const list = await git(folder, ['worktree', 'list', '--porcelain'])
    if (!list.ok) return 'unknown'
    const out = new Map<string, string>()
    let at = ''
    for (const row of list.out.split(/\r?\n/)) {
      if (row.startsWith('worktree ')) at = row.slice('worktree '.length)
      else if (row.startsWith('branch refs/heads/')) out.set(row.slice('branch refs/heads/'.length), at)
    }
    return out
  },
  /** runChecks.ts's tracked(). */
  async runTracked(folder: string): Promise<{ files: string[]; gitDir: string | null }> {
    const ls = await git(folder, ['ls-files', '-z'])
    const gd = await git(folder, ['rev-parse', '--absolute-git-dir'])
    return { files: ls.ok ? ls.out.split('\0').filter(Boolean) : [], gitDir: gd.ok ? gd.out.trim() : null }
  },
  /** queueChecks.ts's tracked(). */
  async queueTracked(folder: string): Promise<{ files: string[] | null; gitDir: string | null }> {
    const ls = await git(folder, ['ls-files', '-z'])
    const own = G.gitDirSync(folder)
    const gd = own ? null : await git(folder, ['rev-parse', '--absolute-git-dir'])
    return { files: ls.ok ? ls.out.split('\0').filter(Boolean) : null, gitDir: own ?? (gd?.ok ? gd.out.trim() : null) }
  },
  /** focusedRun.ts's pathChanges, its read. */
  async rawDiff(folder: string, from: string, to: string): Promise<string | null> {
    const r = await git(folder, ['diff', '--raw', '-z', '--no-abbrev', '--find-renames', '--no-ext-diff', '--no-textconv', from, to, '--'])
    return r.ok ? r.out : null
  }
}

describe('the history port is found by platform', () => {
  it('Git has one, None none; the watcher is the same for both', () => {
    expect(historyOf('git')).toBe(gitHistory)
    expect(historyFor('git')).toBe(gitHistory)
    expect(lineHistory()).toBe(gitHistory)
    expect(hasHistory('git')).toBe(true)
    expect(historyOf('none')).toBeNull()
    expect(hasHistory('none')).toBe(false)
    expect(() => historyFor('none')).toThrow()
    // Not keyed by history: None's write record (its deliverables' watch) is the same observer's (R3.3).
    expect(observePort).toBe(observer)
  })
})

describe("Git's history reads, through the port", () => {
  it("run platform/git.ts's reads: the same commands, in the same order, with the same answers", async () => {
    const { a, tree, main, work } = repo()
    await same(() => G.head(tree), () => gitHistory.head(tree))
    await same(() => G.branch(tree), () => gitHistory.line(tree))
    await same(() => G.lineHead(a, 'work'), () => gitHistory.lineHead(a, 'work'))
    await same(() => G.lineHead(a, 'nope'), () => gitHistory.lineHead(a, 'nope'))
    await same(() => G.defaultBranch(a), () => gitHistory.defaultTarget(a))
    await same(() => G.commonDir(tree), () => gitHistory.store(tree))
    await same(() => G.commonDirFast(tree), () => gitHistory.storeFast(tree))
    await same(() => G.isAncestor(a, main, work), () => gitHistory.isAncestor(a, main, work))
    await same(() => G.mergeBase(a, main, work), () => gitHistory.mergeBase(a, main, work))
    await same(() => G.dirty(tree), () => gitHistory.dirty(tree))
    await same(() => G.change(a, main, work), () => gitHistory.change(a, main, work))
    await same(() => G.filesChanged(a, main, work), () => gitHistory.filesChanged(a, main, work))
    await same(() => G.candidateKey(a, main, work), () => gitHistory.candidateKey(a, main, work))
    await same(() => G.firstParents(a, main, work), () => gitHistory.firstParents(a, main, work))
    await same(() => G.commits(a, `${main}..${work}`, { firstParent: true }), () => gitHistory.commits(a, `${main}..${work}`, { firstParent: true }))
    await same(() => G.worktreeNow(tree, { target: 'main' }), () => gitHistory.workspaceNow(tree, { target: 'main' }))
    await same(() => G.contains(a, 'main', { base: main, revision: work }), () => gitHistory.contains(a, 'main', { base: main, revision: work }))
    const commonDir = (await G.commonDir(a)) as string
    expect(gitHistory.refSync(commonDir, 'refs/heads/work')).toBe(G.refSync(commonDir, 'refs/heads/work'))
  })

  it('run the inline commands their callers ran, unchanged, failures included', async () => {
    const { a, tree, sub, main, work } = repo()
    const lines = await same(async () => before.checkedOut(a), async () => {
      const v = await gitHistory.checkedOutLines(a)
      return isUnknown(v) ? 'unknown' : v
    })
    expect(lines.v).toBeInstanceOf(Map)
    expect([...(lines.v as Map<string, string>).keys()]).toEqual(['main', 'work'])
    await same(() => before.rawDiff(a, main, work), () => gitHistory.rawDiff(a, main, work))
    await same(() => before.rawDiff(a, main, 'nope'), () => gitHistory.rawDiff(a, main, 'nope'))
    for (const f of [a, tree, sub]) {
      await same(() => before.runTracked(f), () => gitHistory.checkFiles(f))
      await same(() => before.queueTracked(f), () => gitHistory.queueCheckFiles(f))
    }
    failing.cmd = 'worktree'
    await same<Map<string, string> | 'unknown' | 'answered'>(async () => before.checkedOut(a), async () => (isUnknown(await gitHistory.checkedOutLines(a)) ? 'unknown' : 'answered'))
    failing.cmd = 'ls-files'
    for (const f of [a, sub]) {
      await same(() => before.runTracked(f), () => gitHistory.checkFiles(f))
      await same(() => before.queueTracked(f), () => gitHistory.queueCheckFiles(f))
    }
  })

  it('deletes a line only while it is where it was found (update-ref with its old value)', async () => {
    const { a, main, work } = repo()
    sh(a, 'branch', 'gone', work)
    const moved = await traced(() => gitHistory.deleteLine(a, 'gone', main))
    expect(moved.v).toBe(false)
    expect(moved.git).toEqual([`${resolve(a).toLowerCase()} :: update-ref -d refs/heads/gone ${main}`])
    expect(sh(a, 'rev-parse', 'gone')).toBe(work)
    expect(await gitHistory.deleteLine(a, 'gone', work)).toBe(true)
    expect(await G.lineHead(a, 'gone')).toBeNull()
  })
})

describe("the check brackets' tracked files, at their callers", () => {
  it("a run's bracket runs both gits wherever it is; the queue's asks git for its git dir only where `.git` can't say", async () => {
    const { tree, sub } = repo()
    // The queue's bracket in a worktree: `.git` names its git dir, no rev-parse.
    const q = await traced(() => bracketStart(tree))
    expect(q.git.filter((l) => l.includes('ls-files') || l.includes('--absolute-git-dir'))).toEqual([`${resolve(tree).toLowerCase()} :: ls-files -z`])
    expect(q.v.files).toContain('src/b.txt')
    expect(q.v.gitDir?.toLowerCase()).toBe(resolve(G.gitDirSync(tree)!).toLowerCase())
    // In a subfolder (no `.git` of its own), git is asked.
    const qs = await traced(() => bracketStart(sub))
    expect(qs.git.filter((l) => l.includes('--absolute-git-dir'))).toEqual([`${resolve(sub).toLowerCase()} :: rev-parse --absolute-git-dir`])
    expect(qs.v.gitDir).not.toBeNull()

    // A run's bracket (a card with no start in its facts: only its own checkout): both gits, in the worktree too.
    const log = { settled: async () => undefined, changedBetween: async () => ({ changed: false, paths: [] }) }
    const run = { card: 1, folder: tree, project: tree, platform: 'git' as const, tested: null, check: null, checkCommand: null, command: null, commands: {}, facts: [], paths: [], excluded: [] }
    const r = await traced(() => checkStart(run, log))
    expect(r.git.filter((l) => l.includes('ls-files') || l.includes('--absolute-git-dir'))).toEqual([`${resolve(tree).toLowerCase()} :: ls-files -z`, `${resolve(tree).toLowerCase()} :: rev-parse --absolute-git-dir`])
    expect(r.v.snapshot).toContain('src/b.txt')
  })

  it("an unreadable list is unread (null) in the queue's bracket, and none in a run's: never an empty list for the queue", async () => {
    const { tree } = repo()
    failing.cmd = 'ls-files'
    const q = await traced(() => bracketStart(tree))
    expect(q.git).toContain(`${resolve(tree).toLowerCase()} :: ls-files -z (failed)`)
    expect(q.v.files).toBeNull()

    const log = { settled: async () => undefined, changedBetween: async () => ({ changed: false, paths: [] }) }
    const run = { card: 1, folder: tree, project: tree, platform: 'git' as const, tested: null, check: null, checkCommand: null, command: null, commands: {}, facts: [], paths: [], excluded: [] }
    const r = await traced(() => checkStart(run, log))
    expect(r.git).toContain(`${resolve(tree).toLowerCase()} :: ls-files -z (failed)`)
    expect(r.v.snapshot).not.toContain('src/b.txt')
  })

  it("the focused pick's change reads git's raw diff as before", async () => {
    const { a, main, work } = repo()
    const p = await traced(() => pathChanges(a, main, work))
    expect(p.git).toEqual([`${resolve(a).toLowerCase()} :: diff --raw -z --no-abbrev --find-renames --no-ext-diff --no-textconv ${main} ${work} --`])
    expect(p.v).toHaveLength(1)
  })
})
