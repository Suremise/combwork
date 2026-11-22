// HI-3470: Changes' panel for a git operation left under way (platform/git/gitOperationSteps.ts): what it reads (the
// operation, where git stopped, its conflicted files and which side has each) and each step the user can take (Continue,
// Skip, Abort, End bisect; Use mine, Use theirs, Mark resolved), with git's sides mapped in a rebase; and what refuses a
// step before git runs (the operation changed, files still in conflict, a run or an agent in the folder, the caller's
// guard). Real git in throwaway repositories.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { timing } from './waits'
import { commit, gitRepo, sh } from './workflow/harness'
import { pickCommand, shellWord, submoduleUpdateCommand, type OperationRequest } from '../src/shared/gitOperations'

const norm = (p: string): string => resolve(p).toLowerCase()
/** What the queue counts as building in a folder: none unless a test says. */
let held: string[] | null = null
vi.mock('../src/main/workflow/queueHost', () => ({ folderBuilders: (_ws: unknown, folder: string) => (held && held.some((h) => norm(h) === norm(folder)) ? held : null) }))
/** An agent working in the folder: none unless a test says. */
let agent: string | null = null
vi.mock('../src/main/gitRepo', async (original) => ({ ...(await original<typeof import('../src/main/gitRepo')>()), busyAgentIn: async () => agent }))

/** Each git command's arguments and bound, while a test collects them (null: none). */
let gitCalls: { args: string[]; timeout?: number }[] | null = null
/** HI-3518 (HR1's round 1): HEAD can't be read while a test says (rev-parse of HEAD fails). */
let headUnreadable = false
vi.mock('../src/main/git', async (original) => {
  const real = await original<typeof import('../src/main/git')>()
  return {
    ...real,
    git: (cwd: string, args: string[], max?: number, input?: string, opts?: Parameters<typeof real.git>[4]) => {
      gitCalls?.push({ args, timeout: opts?.timeout })
      if (headUnreadable && args[0] === 'rev-parse' && args.includes('HEAD')) return Promise.resolve({ ok: false, out: '', err: 'fatal: bad object HEAD', code: 128 })
      return real.git(cwd, args, max, input, opts)
    }
  }
})

vi.setConfig({ testTimeout: timing('test.hang') })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const steps = await import('../src/main/platform/git/gitOperationSteps')
const { platformLimits } = await import('../src/main/platform/limits')

const base = tempDir('cw-gitoperation-')
const w = createWorkspaceService()
w.path = join(base, 'ws')
afterAll(async () => {
  await disposeWorkspaceService(w)
  rmSync(base, { recursive: true, force: true })
})

let n = 0
let proj = ''
const read = (rel: string): string => readFileSync(join(proj, rel), 'utf8')
const gitDir = (): string => sh(proj, 'rev-parse', '--absolute-git-dir')
const state = () => steps.operationState(proj)
type Ask = OperationRequest extends infer R ? (R extends OperationRequest ? Omit<R, 'id'> & { id?: string } : never) : never
/** A request as the panel sends it: the stop it shows now, unless the test names another (HR1's round 1). */
const step = async (req: Ask & { seen?: string }, guard?: () => void) => {
  const now = await state()
  const id = req.id ?? now?.id ?? 'none'
  // A pick names the conflict the panel shows for its file (HI-3518, HR1's round 1), unless the test names another.
  const seen = 'file' in req && req.seen === undefined ? now?.conflicts.find((c) => c.path === req.file)?.stages : req.seen
  return inWorkspace(w, () => steps.operationStep(proj, proj, { ...req, id, ...(seen ? { seen } : {}) } as OperationRequest, guard))
}

beforeEach(() => {
  proj = join(w.path!, `proj${++n}`)
  mkdirSync(proj, { recursive: true })
  gitRepo(proj)
  commit(proj, { 'a.txt': 'base\n', 'b.txt': 'b\n' }, 'files')
  held = null
  agent = null
  gitCalls = null
  headUnreadable = false
})

/** `side` changes a.txt one way on a branch, main another: a conflict to merge, rebase or pick. */
function diverged(): string {
  sh(proj, 'switch', '-q', '-c', 'side')
  const mine = commit(proj, { 'a.txt': 'side\n' }, 'side edit')
  sh(proj, 'switch', '-q', 'main')
  commit(proj, { 'a.txt': 'main\n' }, 'main edit')
  return mine
}

describe('a merge', () => {
  it('reads the merge, the commit merged and the file in conflict; Continue waits for it; Use theirs settles it; Continue commits the merge', async () => {
    const merged = diverged()
    expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
    const s = await state()
    expect(s).toMatchObject({ what: 'merge', at: { commit: merged.slice(0, 7), subject: 'side edit' }, conflicts: [{ path: 'a.txt', mine: true, theirs: true }] })
    await expect(step({ what: 'merge', step: 'continue' })).rejects.toThrow('1 file is still in conflict')
    expect(existsSync(join(gitDir(), 'MERGE_HEAD'))).toBe(true)
    await step({ what: 'merge', file: 'a.txt', pick: 'theirs' })
    expect(read('a.txt')).toBe('side\n')
    expect((await state())?.conflicts).toEqual([])
    await step({ what: 'merge', step: 'continue' })
    expect(await state()).toBeNull()
    expect(sh(proj, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
  })

  it('Use mine keeps the branch’s side; Mark resolved takes the file as edited by hand; Abort puts the folder back', async () => {
    diverged()
    const before = sh(proj, 'rev-parse', 'HEAD')
    commit(proj, { 'c.txt': 'c\n' }, 'more on main')
    sh(proj, 'switch', '-q', 'side')
    commit(proj, { 'c.txt': 'cc\n' }, 'more on side')
    sh(proj, 'switch', '-q', 'main')
    expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
    expect((await state())?.conflicts.map((c) => c.path)).toEqual(['a.txt', 'c.txt'])
    await step({ what: 'merge', file: 'a.txt', pick: 'mine' })
    expect(read('a.txt')).toBe('main\n')
    writeFileSync(join(proj, 'c.txt'), 'both\n')
    await step({ what: 'merge', file: 'c.txt', pick: 'resolved' })
    expect((await state())?.conflicts).toEqual([])
    const head = sh(proj, 'rev-parse', 'HEAD')
    await step({ what: 'merge', step: 'abort' })
    expect(await state()).toBeNull()
    expect(sh(proj, 'rev-parse', 'HEAD')).toBe(head)
    expect(read('a.txt')).toBe('main\n')
    expect(sh(proj, 'status', '--porcelain')).toBe('')
    expect(before).not.toBe(head)
  })

  it('a side that deleted the file: said so, and Use that side deletes it', async () => {
    sh(proj, 'switch', '-q', '-c', 'side')
    commit(proj, { 'a.txt': 'side\n' }, 'side edit')
    sh(proj, 'switch', '-q', 'main')
    sh(proj, 'rm', '-q', 'a.txt')
    sh(proj, 'commit', '-q', '-m', 'gone on main')
    expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
    const c = (await state())!.conflicts[0]
    expect(c).toMatchObject({ path: 'a.txt', mine: false, theirs: true })
    expect(pickCommand('merge', c, 'mine')).toBe('git rm -- a.txt')
    await step({ what: 'merge', file: 'a.txt', pick: 'mine' })
    expect(existsSync(join(proj, 'a.txt'))).toBe(false)
    expect((await state())?.conflicts).toEqual([])
  })
})

describe('a path git would read as a glob (HI-3501)', () => {
  /** Each file changed one way on `side`, another on main, then merged: all in conflict. */
  function conflicted(files: string[]): void {
    commit(proj, Object.fromEntries(files.map((f) => [f, 'base\n'])), 'base of each')
    sh(proj, 'switch', '-q', '-c', 'side')
    commit(proj, Object.fromEntries(files.map((f) => [f, 'side\n'])), 'side edit')
    sh(proj, 'switch', '-q', 'main')
    commit(proj, Object.fromEntries(files.map((f) => [f, 'main\n'])), 'main edit')
    expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
  }
  const unmerged = (): string[] => sh(proj, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean).sort()
  // `a[1].txt` as a glob matches `a1.txt`, and `[id].tsx` matches `i.tsx` and `d.tsx`: none of those may move.
  const FILES = ['a[1].txt', 'a1.txt', 'app/[id].tsx', 'app/i.tsx', 'app/d.tsx']

  it('Use theirs settles the file clicked alone: its siblings stay in conflict, as they were', async () => {
    conflicted(FILES)
    await step({ what: 'merge', file: 'a[1].txt', pick: 'theirs' })
    await step({ what: 'merge', file: 'app/[id].tsx', pick: 'theirs' })
    expect(read('a[1].txt')).toBe('side\n')
    expect(read('app/[id].tsx')).toBe('side\n')
    expect(unmerged()).toEqual(['a1.txt', 'app/d.tsx', 'app/i.tsx'])
    for (const f of ['a1.txt', 'app/d.tsx', 'app/i.tsx']) expect(read(f)).toContain('<<<<<<<')
  })

  it('Use mine and Mark resolved stage the file clicked alone, never a sibling with its markers', async () => {
    conflicted(FILES)
    await step({ what: 'merge', file: 'a[1].txt', pick: 'mine' })
    expect(read('a[1].txt')).toBe('main\n')
    writeFileSync(join(proj, 'app', '[id].tsx'), 'both\n')
    await step({ what: 'merge', file: 'app/[id].tsx', pick: 'resolved' })
    expect(unmerged()).toEqual(['a1.txt', 'app/d.tsx', 'app/i.tsx'])
    expect((await state())?.conflicts.map((c) => c.path)).toEqual(['a1.txt', 'app/d.tsx', 'app/i.tsx'])
    expect(sh(proj, 'show', ':app/[id].tsx')).toBe('both')
  })

  it('Mark resolved stages nothing else that matches: not a changed file out of conflict', async () => {
    commit(proj, { 'b1.txt': 'b1\n' }, 'b1')
    conflicted(['b[1].txt'])
    writeFileSync(join(proj, 'b1.txt'), 'changed, not staged\n')
    writeFileSync(join(proj, 'b[1].txt'), 'done\n')
    await step({ what: 'merge', file: 'b[1].txt', pick: 'resolved' })
    expect(sh(proj, 'diff', '--cached', '--name-only')).not.toContain('b1.txt')
    expect(sh(proj, 'diff', '--name-only')).toBe('b1.txt')
  })

  it('Use a side that deleted the file deletes that file alone, never a sibling it would match', async () => {
    commit(proj, { 'd[1].txt': 'base\n', 'd1.txt': 'base\n' }, 'two')
    sh(proj, 'switch', '-q', '-c', 'side')
    commit(proj, { 'd[1].txt': 'side\n', 'd1.txt': 'side\n' }, 'side edit')
    sh(proj, 'switch', '-q', 'main')
    sh(proj, 'rm', '-q', '--', 'd[1].txt')
    commit(proj, { 'd1.txt': 'main\n' }, 'one gone on main')
    expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
    const c = (await state())!.conflicts.find((x) => x.path === 'd[1].txt')!
    expect(c).toMatchObject({ path: 'd[1].txt', mine: false, theirs: true })
    await step({ what: 'merge', file: 'd[1].txt', pick: 'mine' })
    expect(existsSync(join(proj, 'd[1].txt'))).toBe(false)
    expect(existsSync(join(proj, 'd1.txt'))).toBe(true)
    expect(unmerged()).toEqual(['d1.txt'])
  })

  it("the tooltip's command names the path literally, quoted for a shell", () => {
    const both = { mine: true, theirs: true }
    expect(pickCommand('merge', { path: 'a[1].txt', ...both }, 'resolved')).toBe("git add -A -- ':(literal)a[1].txt'")
    expect(pickCommand('merge', { path: 'app/[id].tsx', ...both }, 'theirs')).toBe("git checkout --theirs -- ':(literal)app/[id].tsx'; git add -- ':(literal)app/[id].tsx'")
    expect(pickCommand('merge', { path: 'd[1].txt', mine: false, theirs: true }, 'mine')).toBe("git rm -- ':(literal)d[1].txt'")
    expect(pickCommand('merge', { path: "it's here.txt", ...both }, 'resolved')).toBe('git add -A -- "it\'s here.txt"')
    expect(pickCommand('merge', { path: 'src/a-b_c.txt', ...both }, 'resolved')).toBe('git add -A -- src/a-b_c.txt')
    // HI-3513: an apostrophe with something both shells expand: no quoting suits both, so PowerShell's (Windows' own),
    // each quote character doubled in single quotes, the typographic ones too.
    expect(pickCommand('merge', { path: "it's $x.txt", ...both }, 'resolved')).toBe("git add -A -- 'it''s $x.txt'")
    expect(pickCommand('merge', { path: "a[1] it's `q`.txt", ...both }, 'resolved')).toBe("git add -A -- ':(literal)a[1] it''s `q`.txt'")
    expect(pickCommand('merge', { path: 'don’t ‘$x’.txt', ...both }, 'resolved')).toBe("git add -A -- 'don’’t ‘‘$x’’.txt'")
  })
})

describe("a shown command's words read the same in PowerShell and Git Bash (HI-3502, HR2's round 1)", () => {
  it('a submodule notice names its path literally, one argument, never a second command', () => {
    expect(submoduleUpdateCommand('vendor/lib')).toBe('git submodule update -- vendor/lib')
    expect(submoduleUpdateCommand('third party/lib')).toBe("git submodule update -- 'third party/lib'")
    expect(submoduleUpdateCommand('vendor; Write-Output marker')).toBe("git submodule update -- 'vendor; Write-Output marker'")
    expect(submoduleUpdateCommand('libs/[id] x')).toBe("git submodule update -- ':(literal)libs/[id] x'")
    expect(submoduleUpdateCommand("it's lib")).toBe('git submodule update -- "it\'s lib"')
    // Each shell expands something inside double quotes: with an apostrophe too, nothing pastes the same in both.
    for (const p of ["it's $HOME", "it's `x", 'it’s $x', "it's \"q\""]) expect(submoduleUpdateCommand(p)).toBeNull()
  })

  it('quotes a word in single quotes, else double quotes, else not at all', () => {
    expect(shellWord('a-b_c/d.txt')).toBe('a-b_c/d.txt')
    expect(shellWord('a b;c&d|e$f`g')).toBe("'a b;c&d|e$f`g'")
    expect(shellWord('it’s')).toBe('"it’s"')
    expect(shellWord("it's!")).toBeNull()
  })
})

describe('a submodule in conflict (HI-3502)', () => {
  /** git, with a local submodule allowed (git refuses file:// clones by default). */
  const sub = (cwd: string, ...args: string[]): string => sh(cwd, '-c', 'protocol.file.allow=always', ...args)
  /** The index's commit of `lib` (stage 0). */
  const staged = (): string => sh(proj, 'ls-files', '-s', '--', 'lib').split(/\s+/)[1] ?? ''
  /**
   * A submodule `lib` at a first commit in proj, then moved to `main` on main and to `side` on a branch `side`: two
   * commits of its own repository that diverge from the first, so neither side's move fast-forwards and git leaves it
   * in conflict.
   */
  function submodule(): { main: string; side: string } {
    const src = join(w.path!, `sub${n}`)
    mkdirSync(src, { recursive: true })
    gitRepo(src)
    const start = commit(src, { 'f.txt': '1\n' }, 'sub base')
    const main = commit(src, { 'f.txt': '2\n' }, 'sub main')
    sh(src, 'switch', '-q', '-c', 'other', start)
    const side = commit(src, { 'g.txt': '3\n' }, 'sub side')
    sub(proj, 'submodule', '-q', 'add', src, 'lib')
    const at = (c: string): void => void sh(join(proj, 'lib'), 'checkout', '-q', c)
    at(start)
    sh(proj, 'add', '-A')
    sh(proj, 'commit', '-q', '-m', 'lib at base')
    sh(proj, 'switch', '-q', '-c', 'side')
    at(side)
    sh(proj, 'add', 'lib')
    sh(proj, 'commit', '-q', '-m', 'lib on side')
    sh(proj, 'switch', '-q', 'main')
    at(main)
    sh(proj, 'add', 'lib')
    sh(proj, 'commit', '-q', '-m', 'lib on main')
    return { main, side }
  }

  it('Use theirs stages their commit, not the one the folder has checked out; Continue commits it', async () => {
    const c = submodule()
    expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
    const lib = (await state())!.conflicts.find((x) => x.path === 'lib')!
    expect(lib).toMatchObject({ path: 'lib', mine: true, theirs: true, submodule: { mine: c.main, theirs: c.side } })
    expect(pickCommand('merge', lib, 'theirs')).toBe(`git update-index --cacheinfo 160000 ${c.side} lib`)
    expect(sh(join(proj, 'lib'), 'rev-parse', 'HEAD')).toBe(c.main)
    await step({ what: 'merge', file: 'lib', pick: 'theirs' })
    expect(staged()).toBe(c.side)
    expect((await state())?.conflicts).toEqual([])
    await step({ what: 'merge', step: 'continue' })
    expect(sh(proj, 'rev-parse', 'HEAD:lib')).toBe(c.side)
    // Its folder is left as it was: the notice says how to check the commit out there.
    expect(sh(join(proj, 'lib'), 'rev-parse', 'HEAD')).toBe(c.main)
  })

  it('Use mine stages mine, even with their commit checked out in its folder', async () => {
    const c = submodule()
    expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
    sh(join(proj, 'lib'), 'checkout', '-q', c.side)
    await step({ what: 'merge', file: 'lib', pick: 'mine' })
    expect(staged()).toBe(c.main)
    expect((await state())?.conflicts).toEqual([])
  })

  it("a rebase: Use mine stages the replayed commit's move (git's theirs), never dropping it", async () => {
    const c = submodule()
    sh(proj, 'switch', '-q', 'side')
    expect(() => sh(proj, 'rebase', 'main')).toThrow()
    const lib = (await state())!.conflicts.find((x) => x.path === 'lib')!
    expect(lib.submodule).toEqual({ mine: c.side, theirs: c.main })
    await step({ what: 'rebase', file: 'lib', pick: 'mine' })
    expect(staged()).toBe(c.side)
    await step({ what: 'rebase', step: 'continue' })
    expect(sh(proj, 'rev-parse', 'HEAD:lib')).toBe(c.side)
    expect(sh(proj, 'rev-parse', 'HEAD~1')).toBe(sh(proj, 'rev-parse', 'main'))
  })

  it('a side that deleted the submodule: Use that side removes it; Use the other stages its commit', async () => {
    const c = submodule()
    sh(join(proj, 'lib'), 'checkout', '-q', c.main)
    sh(proj, 'rm', '-q', 'lib')
    sh(proj, 'commit', '-q', '-m', 'lib gone on main')
    expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
    const lib = (await state())!.conflicts.find((x) => x.path === 'lib')!
    expect(lib).toMatchObject({ path: 'lib', mine: false, theirs: true, submodule: { theirs: c.side } })
    expect(lib.submodule).toEqual({ theirs: c.side })
    await step({ what: 'merge', file: 'lib', pick: 'theirs' })
    expect(staged()).toBe(c.side)
    expect((await state())?.conflicts).toEqual([])
    await step({ what: 'merge', step: 'abort' })
    expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
    await step({ what: 'merge', file: 'lib', pick: 'mine' })
    expect(staged()).toBe('')
    expect((await state())?.conflicts).toEqual([])
  })
})

describe('a rebase, its sides swapped', () => {
  it("reads its step; Use mine takes the commit being replayed (git's theirs); Continue finishes it on main", async () => {
    diverged()
    const main = sh(proj, 'rev-parse', 'main')
    sh(proj, 'switch', '-q', 'side')
    expect(() => sh(proj, 'rebase', 'main')).toThrow()
    const s = await state()
    expect(s).toMatchObject({ what: 'rebase', step: { at: 1, of: 1 }, at: { subject: 'side edit' }, conflicts: [{ path: 'a.txt', mine: true, theirs: true }] })
    expect(pickCommand('rebase', s!.conflicts[0], 'mine')).toBe('git checkout --theirs -- a.txt; git add -- a.txt')
    await step({ what: 'rebase', file: 'a.txt', pick: 'mine' })
    expect(read('a.txt')).toBe('side\n')
    await step({ what: 'rebase', step: 'continue' })
    expect(await state()).toBeNull()
    expect(sh(proj, 'rev-parse', 'HEAD~1')).toBe(main)
    expect(sh(proj, 'branch', '--show-current')).toBe('side')
  })

  it('Skip drops the commit it stopped at', async () => {
    diverged()
    const main = sh(proj, 'rev-parse', 'main')
    sh(proj, 'switch', '-q', 'side')
    expect(() => sh(proj, 'rebase', 'main')).toThrow()
    await step({ what: 'rebase', step: 'skip' })
    expect(await state()).toBeNull()
    expect(sh(proj, 'rev-parse', 'HEAD')).toBe(main)
  })
})

describe('a step that goes on and stops at the next conflict (HI-3503)', () => {
  /** `side` has two commits, one changing c.txt, then one d.txt; main changes both: each of side's commits conflicts. */
  function twoStops(): string[] {
    commit(proj, { 'c.txt': 'c\n', 'd.txt': 'd\n' }, 'c and d')
    sh(proj, 'switch', '-q', '-c', 'side')
    const one = commit(proj, { 'c.txt': 'side c\n' }, 'topic one')
    const two = commit(proj, { 'd.txt': 'side d\n' }, 'topic two')
    sh(proj, 'switch', '-q', 'main')
    commit(proj, { 'c.txt': 'main c\n', 'd.txt': 'main d\n' }, 'main edits')
    return [one, two]
  }

  it('a rebase: Continue commits step 1 and stops at step 2: said as gone on, not as refused', async () => {
    twoStops()
    sh(proj, 'switch', '-q', 'side')
    expect(() => sh(proj, 'rebase', 'main')).toThrow()
    expect(await state()).toMatchObject({ step: { at: 1, of: 2 }, conflicts: [{ path: 'c.txt' }] })
    await step({ what: 'rebase', file: 'c.txt', pick: 'mine' })
    expect(await step({ what: 'rebase', step: 'continue' })).toMatchObject({ stoppedAgain: true })
    expect(await state()).toMatchObject({ what: 'rebase', step: { at: 2, of: 2 }, at: { subject: 'topic two' }, conflicts: [{ path: 'd.txt' }] })
    expect(sh(proj, 'log', '-1', '--format=%s', 'HEAD')).toBe('topic one')
  })

  it('a rebase: Skip drops step 1 and stops at step 2: said as gone on', async () => {
    twoStops()
    sh(proj, 'switch', '-q', 'side')
    expect(() => sh(proj, 'rebase', 'main')).toThrow()
    expect(await step({ what: 'rebase', step: 'skip' })).toMatchObject({ stoppedAgain: true })
    expect(await state()).toMatchObject({ step: { at: 2, of: 2 }, conflicts: [{ path: 'd.txt' }] })
    expect(sh(proj, 'log', '-1', '--format=%s', 'HEAD')).toBe('main edits')
  })

  it('a cherry-pick of two commits: Continue picks the first and stops at the second', async () => {
    const [one, two] = twoStops()
    expect(() => sh(proj, 'cherry-pick', one, two)).toThrow()
    await step({ what: 'cherry-pick', file: 'c.txt', pick: 'theirs' })
    expect(await step({ what: 'cherry-pick', step: 'continue' })).toMatchObject({ stoppedAgain: true })
    expect(await state()).toMatchObject({ what: 'cherry-pick', at: { subject: 'topic two' }, conflicts: [{ path: 'd.txt' }] })
  })

  it('a step that went through and finished it: no stop again', async () => {
    diverged()
    expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
    await step({ what: 'merge', file: 'a.txt', pick: 'theirs' })
    const done = await step({ what: 'merge', step: 'continue' })
    expect(done.stoppedAgain).toBeUndefined()
    expect(await state()).toBeNull()
  })

  it("a step git refuses, where it stays, is still refused with git's error", async () => {
    diverged()
    // The side's change kept out: the pick is empty, and git won't commit it.
    expect(() => sh(proj, 'cherry-pick', 'side')).toThrow()
    const before = (await state())!.id
    await step({ what: 'cherry-pick', file: 'a.txt', pick: 'mine' })
    await expect(step({ what: 'cherry-pick', step: 'continue' })).rejects.toThrow(/Git refused: .*empty/)
    expect((await state())?.id).toBe(before)
  })
})

describe('files left in conflict with no operation under way (HI-3518)', () => {
  /** a.txt and b.txt changed and stashed; then main commits other changes to both: applying the stash conflicts in both. */
  function stashConflict(): void {
    writeFileSync(join(proj, 'a.txt'), 'stashed a\n')
    writeFileSync(join(proj, 'b.txt'), 'stashed b\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'my work')
    commit(proj, { 'a.txt': 'main a\n', 'b.txt': 'main b\n' }, 'main edits')
    expect(() => sh(proj, 'stash', 'apply', '-q')).toThrow()
  }

  it('a conflicting stash apply: its files, mine and the stash as theirs; each pick settles its file; then nothing to show', async () => {
    stashConflict()
    const s = await state()
    expect(s).toMatchObject({ what: 'conflicts', conflicts: [{ path: 'a.txt', mine: true, theirs: true }, { path: 'b.txt', mine: true, theirs: true }] })
    expect(s!.id).toBe(`conflicts|${sh(proj, 'rev-parse', 'HEAD')}`)
    expect(s!.step).toBeUndefined()
    await step({ what: 'conflicts', file: 'a.txt', pick: 'theirs' })
    expect(read('a.txt')).toBe('stashed a\n')
    expect((await state())?.conflicts.map((c) => c.path)).toEqual(['b.txt'])
    await step({ what: 'conflicts', file: 'b.txt', pick: 'mine' })
    expect(read('b.txt')).toBe('main b\n')
    // Nothing unmerged is left: no panel. The stash git kept is still there.
    expect(await state()).toBeNull()
    expect(sh(proj, 'stash', 'list')).toContain('my work')
  })

  it('Mark resolved takes the file as edited by hand', async () => {
    stashConflict()
    writeFileSync(join(proj, 'a.txt'), 'both a\n')
    await step({ what: 'conflicts', file: 'a.txt', pick: 'resolved' })
    expect(sh(proj, 'show', ':a.txt')).toBe('both a')
    expect((await state())?.conflicts.map((c) => c.path)).toEqual(['b.txt'])
  })

  it('has no step: Continue, Skip and Abort are refused before git runs', async () => {
    stashConflict()
    for (const s of ['continue', 'skip', 'abort'] as const) await expect(step({ what: 'conflicts', step: s })).rejects.toThrow("That isn't a step git offers")
    expect((await state())?.conflicts).toHaveLength(2)
  })

  it('refused once HEAD has moved since the user looked, or the request names an operation', async () => {
    stashConflict()
    const id = (await state())!.id!
    await expect(step({ what: 'merge', id, file: 'a.txt', pick: 'mine' })).rejects.toThrow("Git isn't in the middle of a merge")
    sh(proj, 'update-ref', 'HEAD', 'HEAD~1')
    await expect(step({ what: 'conflicts', id, file: 'a.txt', pick: 'mine' })).rejects.toThrow('changed since you looked')
    expect(read('a.txt')).toContain('<<<<<<<')
  })

  it("HR1's round 1: stash A's conflict settled in a terminal and stash B's in its place, at the same HEAD: A's pick is refused, B's conflict as it was", async () => {
    writeFileSync(join(proj, 'a.txt'), 'stash A\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'A')
    writeFileSync(join(proj, 'a.txt'), 'stash B\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'B')
    commit(proj, { 'a.txt': 'main a\n' }, 'main edit')
    expect(() => sh(proj, 'stash', 'apply', '-q', 'stash@{1}')).toThrow()
    const sawA = (await state())!
    const aConflict = sawA.conflicts.find((c) => c.path === 'a.txt')!
    // In a terminal: A's conflict thrown away, then B applied onto the same HEAD, a.txt in conflict again.
    sh(proj, 'reset', '-q', '--hard')
    expect(() => sh(proj, 'stash', 'apply', '-q', 'stash@{0}')).toThrow()
    const sawB = (await state())!
    expect(sawB.id).toBe(sawA.id)
    expect(sawB.conflicts.find((c) => c.path === 'a.txt')!.stages).not.toBe(aConflict.stages)
    const index = sh(proj, 'ls-files', '-u', '--', 'a.txt')
    const onDisk = read('a.txt')
    await expect(step({ what: 'conflicts', id: sawA.id!, file: 'a.txt', pick: 'theirs', seen: aConflict.stages })).rejects.toThrow("a.txt's conflict changed since you looked")
    expect(sh(proj, 'ls-files', '-u', '--', 'a.txt')).toBe(index)
    expect(read('a.txt')).toBe(onDisk)
    // A pick without the conflict it saw is refused too: files left in conflict always name it.
    await expect(inWorkspace(w, () => steps.operationStep(proj, proj, { what: 'conflicts', id: sawB.id!, file: 'a.txt', pick: 'theirs' }))).rejects.toThrow("a.txt's conflict changed since you looked")
    // B's own pick, as its panel shows it, works.
    await step({ what: 'conflicts', file: 'a.txt', pick: 'theirs' })
    expect(read('a.txt')).toBe('stash B\n')
  })

  it("HR1's round 1: HEAD can't be read: no stop to show, and a pick is refused before git touches a file", async () => {
    stashConflict()
    const id = (await state())!.id!
    headUnreadable = true
    expect((await state())?.id).toBeNull()
    gitCalls = []
    await expect(step({ what: 'conflicts', id, file: 'a.txt', pick: 'theirs' })).rejects.toThrow("can't read where git stopped")
    expect(gitCalls.filter((c) => ['checkout', 'add', 'rm', 'update-index'].some((cmd) => c.args.includes(cmd)))).toEqual([])
    expect(read('a.txt')).toContain('<<<<<<<')
  })
})

describe('a revert or cherry-pick', () => {
  it("the reported case (a stop committed by hand, only the sequencer left): read as a revert with nothing in conflict; Abort ends it, keeping the hand commit", async () => {
    commit(proj, { 'r.txt': 'one\n' }, 'c1')
    commit(proj, { 'r.txt': 'two\n' }, 'c2')
    commit(proj, { 's.txt': 's\n' }, 'c3')
    expect(() => sh(proj, 'revert', '--no-edit', 'HEAD~2', 'HEAD')).toThrow()
    sh(proj, 'rm', '-q', 'r.txt')
    sh(proj, 'commit', '-q', '--no-edit')
    const hand = sh(proj, 'rev-parse', 'HEAD')
    expect(await state()).toMatchObject({ what: 'revert', conflicts: [] })
    await step({ what: 'revert', step: 'abort' })
    expect(await state()).toBeNull()
    expect(existsSync(join(gitDir(), 'sequencer'))).toBe(false)
    expect(sh(proj, 'rev-parse', 'HEAD')).toBe(hand)
    // The branch can be switched again: what git refused while the sequencer stayed.
    sh(proj, 'switch', '-q', '--detach', 'main')
  })

  it('a cherry-pick in conflict: Continue after Use theirs makes the commit', async () => {
    const picked = diverged()
    expect(() => sh(proj, 'cherry-pick', picked)).toThrow()
    expect(await state()).toMatchObject({ what: 'cherry-pick', at: { commit: picked.slice(0, 7) } })
    await step({ what: 'cherry-pick', file: 'a.txt', pick: 'theirs' })
    await step({ what: 'cherry-pick', step: 'continue' })
    expect(await state()).toBeNull()
    expect(sh(proj, 'log', '-1', '--format=%s')).toBe('side edit')
    expect(read('a.txt')).toBe('side\n')
  })
})

describe('a bisect', () => {
  it('End bisect resets it; it offers no Continue', async () => {
    const start = sh(proj, 'rev-parse', 'HEAD')
    commit(proj, { 'x.txt': '1\n' }, 'x1')
    commit(proj, { 'x.txt': '2\n' }, 'x2')
    sh(proj, 'bisect', 'start', 'HEAD', start)
    expect((await state())?.what).toBe('bisect')
    await expect(step({ what: 'bisect', step: 'continue' })).rejects.toThrow("isn't a step git offers")
    await step({ what: 'bisect', step: 'abort' })
    expect(await state()).toBeNull()
    expect(sh(proj, 'branch', '--show-current')).toBe('main')
  })
})

/** `side`'s edit of a.txt as a patch, and main's own edit of it: `git am -3` of the patch stops in conflict. */
function amStopped(): string {
  sh(proj, 'switch', '-q', '-c', 'side')
  commit(proj, { 'a.txt': 'side\n' }, 'side edit')
  const patches = join(base, `patches${n}`)
  sh(proj, 'format-patch', '-q', '-1', '-o', patches)
  sh(proj, 'switch', '-q', 'main')
  const before = commit(proj, { 'a.txt': 'main\n' }, 'main edit')
  expect(() => sh(proj, 'am', '-3', join(patches, readdirSync(patches)[0]))).toThrow()
  return before
}

describe('git am, its sides as git names them', () => {
  it("reads it with its step; Use mine keeps the folder's branch (git's ours: the patch is the other side); Continue applies it", async () => {
    amStopped()
    const s = await state()
    expect(s).toMatchObject({ what: 'am', step: { at: 1, of: 1 }, conflicts: [{ path: 'a.txt', mine: true, theirs: true }] })
    expect(pickCommand('am', s!.conflicts[0], 'mine')).toBe('git checkout --ours -- a.txt; git add -- a.txt')
    await step({ what: 'am', file: 'a.txt', pick: 'mine' })
    expect(read('a.txt')).toBe('main\n')
    expect((await state())?.conflicts).toEqual([])
    // Mine kept: the patch changes nothing more, so git's own refusal of an empty patch is said; Skip then ends it.
    await expect(step({ what: 'am', step: 'continue' })).rejects.toThrow('Git refused:')
    await step({ what: 'am', step: 'skip' })
    expect(await state()).toBeNull()
  })

  it('Use theirs takes the patch, and Continue applies it as its commit', async () => {
    amStopped()
    await step({ what: 'am', file: 'a.txt', pick: 'theirs' })
    expect(read('a.txt')).toBe('side\n')
    await step({ what: 'am', step: 'continue' })
    expect(await state()).toBeNull()
    expect(sh(proj, 'log', '-1', '--format=%s')).toBe('side edit')
  })

  it('Abort puts the branch back as it was before the patches', async () => {
    const before = amStopped()
    await step({ what: 'am', step: 'abort' })
    expect(await state()).toBeNull()
    expect(sh(proj, 'rev-parse', 'HEAD')).toBe(before)
    expect(read('a.txt')).toBe('main\n')
  })
})

describe("the stop the user saw (HR1's round 1)", () => {
  /** `side` has two commits that each conflict with main on a.txt: a rebase of it stops twice, at the same path. */
  function twoStops(): void {
    sh(proj, 'switch', '-q', '-c', 'side')
    commit(proj, { 'a.txt': 'side 1\n' }, 'side one')
    commit(proj, { 'a.txt': 'side 2\n' }, 'side two')
    sh(proj, 'switch', '-q', 'main')
    commit(proj, { 'a.txt': 'main\n' }, 'main edit')
    sh(proj, 'switch', '-q', 'side')
    expect(() => sh(proj, 'rebase', 'main')).toThrow()
  }

  it('a Skip, a pick or an Abort confirmed at one stop, made once a terminal went on to the next stop of the same rebase: refused, nothing done', async () => {
    twoStops()
    const first = (await state())!
    expect(first).toMatchObject({ what: 'rebase', step: { at: 1, of: 2 }, at: { subject: 'side one' } })
    // The user's terminal settles the first stop and goes on: git stops again, at the same path, in the same rebase.
    writeFileSync(join(proj, 'a.txt'), 'by hand\n')
    sh(proj, 'add', 'a.txt')
    expect(() => sh(proj, '-c', 'core.editor=true', 'rebase', '--continue')).toThrow()
    const second = (await state())!
    expect(second).toMatchObject({ what: 'rebase', step: { at: 2, of: 2 }, at: { subject: 'side two' }, conflicts: [{ path: 'a.txt' }] })
    expect(second.id).not.toBe(first.id)
    const head = sh(proj, 'rev-parse', 'HEAD')
    await expect(step({ what: 'rebase', id: first.id!, step: 'skip' })).rejects.toThrow('Git has moved on in')
    await expect(step({ what: 'rebase', id: first.id!, file: 'a.txt', pick: 'theirs' })).rejects.toThrow('Git has moved on in')
    await expect(step({ what: 'rebase', id: first.id!, step: 'abort' })).rejects.toThrow('Git has moved on in')
    // Nothing done: the second stop as it was, its conflict still there.
    expect(await state()).toEqual(second)
    expect(sh(proj, 'rev-parse', 'HEAD')).toBe(head)
    expect(read('a.txt')).toContain('<<<<<<<')
    // Asked for the stop it shows now, it is done.
    await step({ what: 'rebase', id: second.id!, step: 'skip' })
    expect(await state()).toBeNull()
  })

  it('a merge ended in a terminal and another begun: an Abort confirmed for the first refused', async () => {
    diverged()
    expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
    const first = (await state())!
    sh(proj, 'merge', '--abort')
    sh(proj, 'switch', '-q', '-c', 'other', 'main~1')
    commit(proj, { 'a.txt': 'other\n' }, 'other edit')
    sh(proj, 'switch', '-q', 'main')
    expect(() => sh(proj, 'merge', '--no-edit', 'other')).toThrow()
    expect((await state())!.id).not.toBe(first.id)
    await expect(step({ what: 'merge', id: first.id!, step: 'abort' })).rejects.toThrow('Git has moved on in')
    expect(existsSync(join(gitDir(), 'MERGE_HEAD'))).toBe(true)
  })
})

describe("another operation of the same kind at the same HEAD (HR1's round 2)", () => {
  /** A one-patch file of a commit on its own branch from main~0 changing a.txt to `text`. */
  function patchOf(name: string, text: string): string {
    sh(proj, 'switch', '-q', '-c', name, 'main')
    commit(proj, { 'a.txt': `${text}\n` }, `${name} edit`)
    const out = join(base, `patches-${name}-${n}`)
    sh(proj, 'format-patch', '-q', '-1', '-o', out)
    sh(proj, 'switch', '-q', 'main')
    return join(out, readdirSync(out)[0])
  }

  it('git am: patch A aborted in a terminal and patch B applied, both stopping at a.txt from the same HEAD: a request made for A is refused, B as it was', async () => {
    const a = patchOf('pa', 'patch A')
    const b = patchOf('pb', 'patch B')
    commit(proj, { 'a.txt': 'main\n' }, 'main edit')
    const head = sh(proj, 'rev-parse', 'HEAD')
    expect(() => sh(proj, 'am', '-3', a)).toThrow()
    const first = (await state())!
    sh(proj, 'am', '--abort')
    expect(() => sh(proj, 'am', '-3', b)).toThrow()
    const second = (await state())!
    // The same kind, HEAD, step and conflicted path: only the patch tells them apart.
    expect(sh(proj, 'rev-parse', 'HEAD')).toBe(head)
    expect(second).toMatchObject({ what: 'am', step: first.step, conflicts: first.conflicts.map((c) => ({ path: c.path, mine: c.mine, theirs: c.theirs })) })
    expect(first.id).toBeTruthy()
    expect(second.id).not.toBe(first.id)
    const patchNow = readFileSync(join(gitDir(), 'rebase-apply', '0001'), 'utf8')
    const fileNow = read('a.txt')
    for (const req of [{ step: 'abort' }, { step: 'continue' }, { step: 'skip' }, { file: 'a.txt', pick: 'theirs' }, { file: 'a.txt', pick: 'resolved' }] as const) {
      await expect(step({ what: 'am', id: first.id!, ...req })).rejects.toThrow('Git has moved on in')
    }
    expect(await state()).toEqual(second)
    expect(sh(proj, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(gitDir(), 'rebase-apply', '0001'), 'utf8')).toBe(patchNow)
    expect(read('a.txt')).toBe(fileNow)
    expect(sh(proj, 'ls-files', '-u')).not.toBe('')
  })

  for (const kind of ['cherry-pick', 'revert'] as const) {
    it(`${kind}: one ended in a terminal and another begun from the same HEAD, stopping at the same path: a request made for the first is refused`, async () => {
      // Two commits on main (for a revert) or on a branch (for a pick), each conflicting at a.txt.
      if (kind === 'revert') {
        commit(proj, { 'a.txt': 'one\n' }, 'one')
        commit(proj, { 'a.txt': 'two\n' }, 'two')
        commit(proj, { 'a.txt': 'three\n' }, 'three')
      }
      const x = kind === 'revert' ? sh(proj, 'rev-parse', 'HEAD~2') : (sh(proj, 'switch', '-q', '-c', 'x', 'main'), commit(proj, { 'a.txt': 'x\n' }, 'x edit'))
      const y = kind === 'revert' ? sh(proj, 'rev-parse', 'HEAD~1') : (sh(proj, 'switch', '-q', '-c', 'y', 'main'), commit(proj, { 'a.txt': 'y\n' }, 'y edit'))
      if (kind === 'cherry-pick') {
        sh(proj, 'switch', '-q', 'main')
        commit(proj, { 'a.txt': 'main\n' }, 'main edit')
      }
      const head = sh(proj, 'rev-parse', 'HEAD')
      expect(() => sh(proj, kind, '--no-edit', x)).toThrow()
      const first = (await state())!
      sh(proj, kind, '--abort')
      expect(() => sh(proj, kind, '--no-edit', y)).toThrow()
      const second = (await state())!
      expect(second.what).toBe(kind)
      expect(second.id).not.toBe(first.id)
      await expect(step({ what: kind, id: first.id!, step: 'abort' })).rejects.toThrow('Git has moved on in')
      await expect(step({ what: kind, id: first.id!, file: 'a.txt', pick: 'mine' })).rejects.toThrow('Git has moved on in')
      expect(await state()).toEqual(second)
      expect(sh(proj, 'rev-parse', 'HEAD')).toBe(head)
    })
  }

  it('bisect: a terminal marked a commit since: an End bisect made for the stop before is refused', async () => {
    const start = sh(proj, 'rev-parse', 'HEAD')
    for (const i of [1, 2, 3, 4]) commit(proj, { 'x.txt': `${i}\n` }, `x${i}`)
    sh(proj, 'bisect', 'start', 'HEAD', start)
    const first = (await state())!
    sh(proj, 'bisect', 'bad')
    expect((await state())!.id).not.toBe(first.id)
    await expect(step({ what: 'bisect', id: first.id!, step: 'abort' })).rejects.toThrow('Git has moved on in')
    expect((await state())?.what).toBe('bisect')
  })
})

describe("git's files that say where it stopped can't be read (HR1's round 2)", () => {
  it('an am whose current patch is gone: no id, and every step refused, nothing done', async () => {
    amStopped()
    const head = sh(proj, 'rev-parse', 'HEAD')
    rmSync(join(gitDir(), 'rebase-apply', '0001'))
    const s = await state()
    expect(s).toMatchObject({ what: 'am', id: null })
    await expect(step({ what: 'am', id: 'am|x|y', step: 'abort' })).rejects.toThrow("Combwork can't read where git stopped")
    await expect(step({ what: 'am', id: 'am|x|y', file: 'a.txt', pick: 'mine' })).rejects.toThrow("Combwork can't read where git stopped")
    expect(sh(proj, 'rev-parse', 'HEAD')).toBe(head)
    expect(existsSync(join(gitDir(), 'rebase-apply'))).toBe(true)
  })
})

describe("the bound of a step (HR1's round 1)", () => {
  it("Continue runs with Commit's own bound, Settings → Advanced's longest commit time, never one of its own", async () => {
    const was = platformLimits.gitCommitMs
    platformLimits.gitCommitMs = () => 4_321_000
    try {
      diverged()
      expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
      await step({ what: 'merge', file: 'a.txt', pick: 'theirs' })
      gitCalls = []
      await step({ what: 'merge', step: 'continue' })
      const cont = gitCalls.find((c) => c.args[0] === 'merge' && c.args[1] === '--continue')
      expect(cont?.timeout).toBe(4_321_000)
    } finally {
      platformLimits.gitCommitMs = was
    }
  })
})

describe('refused before git runs', () => {
  it('another operation than the one shown, a run or an agent in the folder, the guard: each refused, the merge as it was', async () => {
    diverged()
    expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
    const abort: Ask = { what: 'merge', step: 'abort' }
    await expect(step({ what: 'rebase', step: 'abort' })).rejects.toThrow("isn't in the middle of a rebase")
    held = [proj]
    await expect(step(abort)).rejects.toThrow('A run or an agent is working in')
    held = null
    agent = 'HB1'
    await expect(step(abort)).rejects.toThrow('HB1 is working in')
    agent = null
    await expect(
      step(abort, () => {
        throw new Error('the guard says no')
      })
    ).rejects.toThrow('the guard says no')
    await expect(step({ what: 'merge', file: 'b.txt', pick: 'mine' })).rejects.toThrow("b.txt isn't in conflict any more")
    expect((await state())?.what).toBe('merge')
    // Nothing under way: refused as changed.
    await step(abort)
    await expect(step(abort)).rejects.toThrow("isn't in the middle of a merge")
  })

  it("git's own refusal is said in its words", async () => {
    diverged()
    sh(proj, 'switch', '-q', 'side')
    expect(() => sh(proj, 'rebase', 'main')).toThrow()
    rmSync(join(gitDir(), 'rebase-merge', 'git-rebase-todo'), { force: true })
    writeFileSync(join(gitDir(), 'rebase-merge', 'git-rebase-todo'), 'nonsense here\n')
    await step({ what: 'rebase', file: 'a.txt', pick: 'theirs' })
    await expect(step({ what: 'rebase', step: 'continue' })).rejects.toThrow('Git refused:')
  })
})
