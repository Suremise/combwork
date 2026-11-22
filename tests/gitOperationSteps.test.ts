// HI-3470: Changes' panel for a git operation left under way (platform/git/gitOperationSteps.ts): what it reads (the
// operation, where git stopped, its conflicted files and which side has each) and each step the user can take (Continue,
// Skip, Abort, End bisect; Use mine, Use theirs, Mark resolved), with git's sides mapped in a rebase; and what refuses a
// step before git runs (the operation changed, files still in conflict, a run or an agent in the folder, the caller's
// guard). Real git in throwaway repositories.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { timing } from './waits'
import { commit, gitRepo, sh } from './workflow/harness'
import { pickCommand, type OperationRequest } from '../src/shared/gitOperations'

const norm = (p: string): string => resolve(p).toLowerCase()
/** What the queue counts as building in a folder: none unless a test says. */
let held: string[] | null = null
vi.mock('../src/main/workflow/queueHost', () => ({ folderBuilders: (_ws: unknown, folder: string) => (held && held.some((h) => norm(h) === norm(folder)) ? held : null) }))
/** An agent working in the folder: none unless a test says. */
let agent: string | null = null
vi.mock('../src/main/gitRepo', async (original) => ({ ...(await original<typeof import('../src/main/gitRepo')>()), busyAgentIn: async () => agent }))

vi.setConfig({ testTimeout: timing('test.hang') })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const steps = await import('../src/main/platform/git/gitOperationSteps')

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
const step = (req: OperationRequest, guard?: () => void) => inWorkspace(w, () => steps.operationStep(proj, proj, req, guard))

beforeEach(() => {
  proj = join(w.path!, `proj${++n}`)
  mkdirSync(proj, { recursive: true })
  gitRepo(proj)
  commit(proj, { 'a.txt': 'base\n', 'b.txt': 'b\n' }, 'files')
  held = null
  agent = null
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
    expect(c).toEqual({ path: 'a.txt', mine: false, theirs: true })
    expect(pickCommand('merge', c, 'mine')).toBe('git rm -- a.txt')
    await step({ what: 'merge', file: 'a.txt', pick: 'mine' })
    expect(existsSync(join(proj, 'a.txt'))).toBe(false)
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

describe('a revert or cherry-pick', () => {
  it("the reported case (a stop committed by hand, only the sequencer left): read as a revert with nothing in conflict; Abort ends it, keeping the hand commit", async () => {
    commit(proj, { 'r.txt': 'one\n' }, 'c1')
    commit(proj, { 'r.txt': 'two\n' }, 'c2')
    commit(proj, { 's.txt': 's\n' }, 'c3')
    expect(() => sh(proj, 'revert', '--no-edit', 'HEAD~2', 'HEAD')).toThrow()
    sh(proj, 'rm', '-q', 'r.txt')
    sh(proj, 'commit', '-q', '--no-edit')
    const hand = sh(proj, 'rev-parse', 'HEAD')
    expect(await state()).toEqual({ what: 'revert', conflicts: [] })
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

describe('refused before git runs', () => {
  it('another operation than the one shown, a run or an agent in the folder, the guard: each refused, the merge as it was', async () => {
    diverged()
    expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
    const abort: OperationRequest = { what: 'merge', step: 'abort' }
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
