// HI-3472: Changes' Stashes (platform/git/gitStashes.ts, shared/gitStashes.ts): the list (each stash's branch, message,
// date and files, its untracked ones included, Combwork's own told by Set Aside's mark), Show's files and diffs, Apply,
// Pop (dropped only after a clean apply; kept on a conflict, which HI-3518's panel is told of) and Drop (only the stash
// the user saw, whatever moved its place), and what refuses Apply and Pop before git runs (an operation under way, a
// file in conflict, uncommitted changes to a file the stash holds, a run or an agent in the folder, the caller's guard).
// Real git in throwaway repositories.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { timing } from './waits'
import { commit, gitRepo, sh } from './workflow/harness'
import { combworkStash, stashRequestOf, stashSubject } from '../src/shared/gitStashes'

const norm = (p: string): string => resolve(p).toLowerCase()
/** What the queue counts as building in a folder: none unless a test says. */
let held: string[] | null = null
vi.mock('../src/main/workflow/queueHost', () => ({ folderBuilders: (_ws: unknown, folder: string) => (held && held.some((h) => norm(h) === norm(folder)) ? held : null) }))
/** An agent working in the folder: none unless a test says. */
let agent: string | null = null
vi.mock('../src/main/gitRepo', async (original) => ({ ...(await original<typeof import('../src/main/gitRepo')>()), busyAgentIn: async () => agent }))

vi.setConfig({ testTimeout: timing('test.hang') })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const S = await import('../src/main/platform/git/gitStashes')

const base = tempDir('cw-gitstash-')
const w = createWorkspaceService()
w.path = join(base, 'ws')
afterAll(async () => {
  await disposeWorkspaceService(w)
  rmSync(base, { recursive: true, force: true })
})

let n = 0
let proj = ''
const read = (rel: string): string => readFileSync(join(proj, rel), 'utf8').replace(/\r\n/g, '\n')
const write = (rel: string, text: string): void => writeFileSync(join(proj, rel), text)
const list = () => S.listStashes(proj)
const apply = (stash: string, pop: boolean, guard?: () => void) => inWorkspace(w, () => S.applyStash(proj, proj, { commit: stash, pop }, guard))
const drop = (stash: string) => inWorkspace(w, () => S.dropStash(proj, stash))
const stashes = (): string[] => sh(proj, 'stash', 'list', '--format=%H').split(/\r?\n/).filter(Boolean)

beforeEach(() => {
  proj = join(w.path!, `proj${++n}`)
  mkdirSync(proj, { recursive: true })
  gitRepo(proj)
  sh(proj, 'config', 'core.autocrlf', 'false')
  commit(proj, { 'a.txt': 'base\n', 'b.txt': 'b\n' }, 'files')
  held = null
  agent = null
})

describe('parsing', () => {
  it("tells Set Aside's stashes by their mark, with the card or target each names", () => {
    expect(combworkStash('Combwork: set aside before merging HI-12 [cw:0a1b2c]')).toEqual({ why: 'merging', card: 'HI-12' })
    expect(combworkStash('Combwork: set aside before bringing 1.7.0 up to date with HI-3 [cw:ffffff]')).toEqual({ why: 'catchUp', target: '1.7.0', card: 'HI-3' })
    expect(combworkStash('Combwork: set aside before starting work on main [cw:123abc]')).toEqual({ why: 'starting', target: 'main' })
    expect(combworkStash('Combwork: set aside for a reason [cw:123abc]')).toEqual({ why: 'other', text: 'for a reason' })
    // Without its mark, the same words are anyone's.
    expect(combworkStash('Combwork: set aside before merging HI-12')).toBeNull()
    expect(combworkStash('WIP')).toBeNull()
  })

  it("splits git's reflog subject into the branch and the message", () => {
    expect(stashSubject('On main: my work')).toEqual({ branch: 'main', message: 'my work' })
    expect(stashSubject('WIP on cw/HI/x: 1234abc a subject')).toEqual({ branch: 'cw/HI/x', message: '1234abc a subject' })
    expect(stashSubject('On (no branch): detached')).toEqual({ branch: null, message: 'detached' })
    expect(stashSubject('something else')).toEqual({ branch: null, message: 'something else' })
  })

  it('takes only a request naming a stash by its commit', () => {
    const c = 'a'.repeat(40)
    expect(stashRequestOf({ commit: c, pop: true, lease: 'L1' })).toEqual({ commit: c, pop: true, lease: 'L1' })
    expect(stashRequestOf({ commit: c, pop: false })).toEqual({ commit: c, pop: false })
    expect(stashRequestOf({ commit: 'stash@{0}', pop: false })).toBeNull()
    expect(stashRequestOf({ commit: c })).toBeNull()
    expect(stashRequestOf(null)).toBeNull()
  })
})

describe('the list and Show', () => {
  it('lists every stash, newest first, with its branch, message, date and files, untracked ones included', async () => {
    expect(await list()).toEqual([])
    write('a.txt', 'mine\n')
    write('new.txt', 'new\n')
    sh(proj, 'stash', 'push', '--include-untracked', '-q', '-m', 'Combwork: set aside before merging HI-12 [cw:abc123]')
    sh(proj, 'switch', '-q', '-c', 'side')
    write('b.txt', 'bb\n')
    sh(proj, 'stash', 'push', '-q')
    const rows = await list()
    expect(rows.map((r) => r.index)).toEqual([0, 1])
    expect(rows[0]).toMatchObject({ branch: 'side', files: 1, combwork: null })
    expect(rows[0].message).toMatch(/^[0-9a-f]+ files$/)
    expect(rows[1]).toMatchObject({ branch: 'main', files: 2, message: 'Combwork: set aside before merging HI-12 [cw:abc123]', combwork: { why: 'merging', card: 'HI-12' } })
    expect(rows[1].commit).toBe(stashes()[1])
    expect(Math.abs(rows[1].at - Date.now())).toBeLessThan(10 * 60_000)
    // Show: the changed file, then the untracked one.
    expect(await S.stashFiles(proj, rows[1].commit)).toEqual([
      { path: 'a.txt', status: 'M', untracked: false },
      { path: 'new.txt', status: 'A', untracked: true }
    ])
    const d = await S.stashDiff(proj, rows[1].commit, 'a.txt', false)
    expect([d.original.replace(/\r\n/g, '\n'), d.modified.replace(/\r\n/g, '\n'), d.binary]).toEqual(['base\n', 'mine\n', false])
    const u = await S.stashDiff(proj, rows[1].commit, 'new.txt', true)
    expect([u.original, u.modified.replace(/\r\n/g, '\n')]).toEqual(['', 'new\n'])
  })

  it('a stash gone meanwhile refuses Show', async () => {
    write('a.txt', 'mine\n')
    sh(proj, 'stash', 'push', '-q')
    const [c] = stashes()
    sh(proj, 'stash', 'drop', '-q')
    await expect(S.stashFiles(proj, c)).rejects.toThrow("isn't in the list any more")
    await expect(S.stashDiff(proj, c, 'a.txt', false)).rejects.toThrow("isn't in the list any more")
  })
})

describe('Apply and Pop', () => {
  it('Apply puts the changes in and keeps the stash; Pop drops it after a clean apply', async () => {
    write('a.txt', 'mine\n')
    write('new.txt', 'new\n')
    sh(proj, 'stash', 'push', '--include-untracked', '-q', '-m', 'work')
    const [c] = stashes()
    expect(await apply(c, false)).toEqual({ conflicts: [], dropped: false })
    expect([read('a.txt'), read('new.txt')]).toEqual(['mine\n', 'new\n'])
    expect(stashes()).toEqual([c])
    sh(proj, 'checkout', '-q', '--', 'a.txt')
    rmSync(join(proj, 'new.txt'))
    expect(await apply(c, true)).toEqual({ conflicts: [], dropped: true })
    expect(read('a.txt')).toBe('mine\n')
    expect(stashes()).toEqual([])
  })

  it('a conflict leaves the files in conflict and keeps the stash, even for a Pop; HI-3518 is told which stash, until it is settled', async () => {
    write('a.txt', 'mine\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'work')
    const [c] = stashes()
    commit(proj, { 'a.txt': 'theirs\n' }, 'moved on')
    const head = sh(proj, 'rev-parse', 'HEAD')
    expect(await apply(c, true)).toEqual({ conflicts: ['a.txt'], dropped: false })
    expect(stashes()).toEqual([c])
    expect(read('a.txt')).toContain('<<<<<<<')
    expect(await S.stashConflictIn(proj)).toEqual({ commit: c, label: 'work', head })
    // Another Apply now refuses: a file is in conflict.
    await expect(apply(c, false)).rejects.toThrow('a.txt is in conflict')
    sh(proj, 'checkout', '--theirs', '--', 'a.txt')
    sh(proj, 'add', 'a.txt')
    expect(await S.stashConflictIn(proj)).toBeNull()
  })

  it("refuses while the folder has uncommitted changes to a file the stash holds, untracked ones too; another file's don't", async () => {
    write('a.txt', 'mine\n')
    write('new.txt', 'new\n')
    sh(proj, 'stash', 'push', '--include-untracked', '-q')
    const [c] = stashes()
    write('a.txt', 'again\n')
    await expect(apply(c, false)).rejects.toThrow('a.txt has uncommitted changes')
    sh(proj, 'checkout', '-q', '--', 'a.txt')
    write('new.txt', 'other\n')
    await expect(apply(c, true)).rejects.toThrow('new.txt has uncommitted changes')
    rmSync(join(proj, 'new.txt'))
    write('b.txt', 'unrelated\n')
    expect(await apply(c, true)).toEqual({ conflicts: [], dropped: true })
    expect(read('b.txt')).toBe('unrelated\n')
  })

  it('refuses while an operation is under way, a run or an agent works there, or the guard refuses; nothing is changed', async () => {
    write('a.txt', 'mine\n')
    sh(proj, 'stash', 'push', '-q')
    const [c] = stashes()
    held = [proj]
    await expect(apply(c, false)).rejects.toThrow('A run or an agent is working')
    held = null
    agent = 'HB9'
    await expect(apply(c, false)).rejects.toThrow('HB9 is working')
    agent = null
    await expect(
      apply(c, false, () => {
        throw new Error('a session is there')
      })
    ).rejects.toThrow('a session is there')
    sh(proj, 'switch', '-q', '-c', 'side')
    commit(proj, { 'b.txt': 'side\n' }, 'side')
    sh(proj, 'switch', '-q', 'main')
    commit(proj, { 'b.txt': 'main\n' }, 'main')
    expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
    await expect(apply(c, false)).rejects.toThrow('in the middle of a merge')
    sh(proj, 'merge', '--abort')
    expect(read('a.txt')).toBe('base\n')
    expect(stashes()).toEqual([c])
  })

  it('a stash dropped meanwhile refuses', async () => {
    write('a.txt', 'mine\n')
    sh(proj, 'stash', 'push', '-q')
    const [c] = stashes()
    sh(proj, 'stash', 'drop', '-q')
    await expect(apply(c, false)).rejects.toThrow("isn't in the list any more")
  })
})

describe('Drop', () => {
  it('drops the stash the user saw, even after another stash moved its place', async () => {
    write('a.txt', 'one\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'one')
    const [one] = stashes()
    write('a.txt', 'two\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'two')
    const two = stashes()[0]
    // `one` is stash@{1} now.
    await drop(one)
    expect(stashes()).toEqual([two])
    await expect(drop(one)).rejects.toThrow("isn't in the list any more")
    await drop(two)
    expect(stashes()).toEqual([])
  })
})
