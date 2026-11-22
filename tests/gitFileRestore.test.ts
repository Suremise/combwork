// HI-3477: the Files tab's Discard Changes… and Restore From… (platform/git/gitFileRestore.ts): the plan its confirm
// shows (the file on disk against the version it becomes, from HEAD, the target or a commit), A Commit…'s list (the
// file's own commits, a page at a time), and the change itself: the file's uncommitted changes stashed first, under
// Set Aside's mark (so Stashes names them and Apply brings them back), then its version written; refused before git
// runs while an operation is under way, a run or an agent works there or the caller's guard refuses. Real git in
// throwaway repositories.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { timing } from './waits'
import { commit, gitRepo, sh } from './workflow/harness'
import { combworkStash, stashSubject } from '../src/shared/gitStashes'
import { restoreRequestOf, type RestoreSource } from '../src/shared/gitFileRestore'
import { HISTORY_COMMITS } from '../src/shared/gitRepo'

/** What the queue counts as building in a folder: none unless a test says. */
let held: string[] | null = null
vi.mock('../src/main/workflow/queueHost', () => ({ folderBuilders: () => held }))
/** An agent working in the folder: none unless a test says. */
let agent: string | null = null
vi.mock('../src/main/gitRepo', async (original) => ({ ...(await original<typeof import('../src/main/gitRepo')>()), busyAgentIn: async () => agent }))

vi.setConfig({ testTimeout: timing('test.hang') })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const R = await import('../src/main/platform/git/gitFileRestore')

const base = tempDir('cw-gitrestore-')
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
const status = (rel: string): string => sh(proj, 'status', '--porcelain=v1', '--', rel).replace(/\r?\n$/, '')
const stashMessages = (): string[] => sh(proj, 'stash', 'list', '--format=%gs').split(/\r?\n/).filter(Boolean).map((s) => stashSubject(s).message)
const head = (): string => sh(proj, 'rev-parse', 'HEAD').trim()
const plan = (rel: string, source: RestoreSource, target: string | null = null, picked: string | null = null) => R.restorePlan(proj, rel, source, target, picked)
const restore = (rel: string, source: RestoreSource, at: string, guard?: () => void) => inWorkspace(w, () => R.restoreFile(proj, { rel, source, commit: at }, guard))

beforeEach(() => {
  proj = join(w.path!, `proj${++n}`)
  mkdirSync(proj, { recursive: true })
  gitRepo(proj)
  sh(proj, 'config', 'core.autocrlf', 'false')
  commit(proj, { 'a.txt': 'base\n', 'b.txt': 'b\n', 'sub/c.txt': 'c\n' }, 'files')
  held = null
  agent = null
})

describe('parsing', () => {
  it("names a discard's and a restore's stash from Set Aside's mark", () => {
    expect(combworkStash('Combwork: set aside before discarding sub/c.txt [cw:0a1b2c]')).toEqual({ why: 'discarding', file: 'sub/c.txt' })
    expect(combworkStash('Combwork: set aside before restoring a.txt from 1234abc [cw:0a1b2c]')).toEqual({ why: 'restoring', file: 'a.txt', from: '1234abc' })
  })

  it('takes only a request naming a file, a source and a whole commit', () => {
    const c = 'a'.repeat(40)
    expect(restoreRequestOf({ rel: 'a.txt', source: 'target', commit: c })).toEqual({ rel: 'a.txt', source: 'target', commit: c })
    expect(restoreRequestOf({ rel: 'a.txt', source: 'elsewhere', commit: c })).toBeNull()
    expect(restoreRequestOf({ rel: 'a.txt', source: 'head', commit: 'HEAD' })).toBeNull()
    expect(restoreRequestOf({ rel: '', source: 'head', commit: c })).toBeNull()
  })
})

describe('Discard Changes', () => {
  it('shows the file on disk against HEAD, then stashes its changes, staged and not, and leaves other files alone', async () => {
    write('a.txt', 'staged\n')
    sh(proj, 'add', 'a.txt')
    write('a.txt', 'staged and more\n')
    write('b.txt', 'other\n')
    const p = await plan('a.txt', 'head')
    expect(p).toMatchObject({ rel: 'a.txt', source: 'head', commit: head(), exists: true, changed: true })
    expect(p.diff).toMatchObject({ original: 'staged and more\n', modified: 'base\n', binary: false })
    expect(await restore('a.txt', 'head', p.commit)).toEqual({ stashed: true })
    expect(read('a.txt')).toBe('base\n')
    expect(status('a.txt')).toBe('')
    expect(read('b.txt')).toBe('other\n')
    const [msg] = stashMessages()
    expect(combworkStash(msg)).toEqual({ why: 'discarding', file: 'a.txt' })
    // Apply brings it back.
    sh(proj, 'stash', 'apply', '-q')
    expect(read('a.txt')).toBe('staged and more\n')
  })

  it("works on a file in a subfolder, and in a project folder that is a repository's subfolder", async () => {
    write('sub/c.txt', 'changed\n')
    const p = await plan('sub/c.txt', 'head')
    await restore('sub/c.txt', 'head', p.commit)
    expect(read('sub/c.txt')).toBe('c\n')
    const top = proj
    proj = join(top, 'sub')
    try {
      write('c.txt', 'again\n')
      const q = await plan('c.txt', 'head')
      expect(q.diff.modified).toBe('c\n')
      await restore('c.txt', 'head', q.commit)
      expect(read('c.txt')).toBe('c\n')
    } finally {
      proj = top
    }
  })

  it("takes a file's name literally, from a subfolder too: a name like a pattern never reaches another file", async () => {
    commit(proj, { 'sub/c[1].txt': 'one\n', 'sub/c1.txt': 'other\n' }, 'names')
    write('sub/c[1].txt', 'changed\n')
    write('sub/c1.txt', 'changed too\n')
    const top = proj
    proj = join(top, 'sub')
    try {
      await restore('c[1].txt', 'head', (await plan('c[1].txt', 'head')).commit)
      expect(read('c[1].txt')).toBe('one\n')
      expect(read('c1.txt')).toBe('changed too\n')
    } finally {
      proj = top
    }
  })

  it('refuses a file with nothing to discard, one git does not track, a path outside, and a HEAD moved since the confirm', async () => {
    await expect(restore('a.txt', 'head', head())).rejects.toThrow('no uncommitted changes')
    write('new.txt', 'new\n')
    await expect(plan('new.txt', 'head')).rejects.toThrow("Git doesn't track new.txt")
    await expect(restore('new.txt', 'head', head())).rejects.toThrow("Git doesn't track new.txt")
    await expect(plan('../x.txt', 'head')).rejects.toThrow('asked for wrongly')
    write('a.txt', 'mine\n')
    const p = await plan('a.txt', 'head')
    commit(proj, { 'b.txt': 'moved\n' }, 'moved')
    await expect(restore('a.txt', 'head', p.commit)).rejects.toThrow('changed meanwhile')
    expect(read('a.txt')).toBe('mine\n')
    expect(stashMessages()).toEqual([])
  })
})

describe('Restore From', () => {
  it("the target's version, the commit the confirm showed even after the target moves, as a change to commit", async () => {
    sh(proj, 'branch', 'target')
    sh(proj, 'switch', '-q', 'target')
    commit(proj, { 'a.txt': 'on target\n' }, 'target')
    const shown = head()
    sh(proj, 'switch', '-q', 'main')
    const p = await plan('a.txt', 'target', 'target')
    expect(p).toMatchObject({ commit: shown, target: 'target', exists: true, changed: false })
    expect(p.diff).toMatchObject({ original: 'base\n', modified: 'on target\n' })
    sh(proj, 'switch', '-q', 'target')
    commit(proj, { 'a.txt': 'later\n' }, 'later')
    sh(proj, 'switch', '-q', 'main')
    expect(await restore('a.txt', 'target', p.commit)).toEqual({ stashed: false })
    expect(read('a.txt')).toBe('on target\n')
    expect(status('a.txt')).toBe('M a.txt')
    expect(stashMessages()).toEqual([])
  })

  it('stashes uncommitted changes first, named for the commit restored from', async () => {
    const first = head()
    commit(proj, { 'a.txt': 'second\n' }, 'second')
    write('a.txt', 'mine\n')
    const p = await plan('a.txt', 'commit', null, first)
    expect(p).toMatchObject({ changed: true, exists: true })
    expect(await restore('a.txt', 'commit', p.commit)).toEqual({ stashed: true })
    expect(read('a.txt')).toBe('base\n')
    expect(combworkStash(stashMessages()[0])).toEqual({ why: 'restoring', file: 'a.txt', from: first.slice(0, 7) })
  })

  it("refuses a target that isn't a branch, and a commit without the file; nothing is changed", async () => {
    await expect(plan('a.txt', 'target', 'nowhere')).rejects.toThrow("target isn't a branch")
    await expect(plan('a.txt', 'target', null)).rejects.toThrow("target isn't a branch")
    const before = head()
    commit(proj, { 'd.txt': 'd\n' }, 'd')
    const p = await plan('d.txt', 'commit', null, before)
    expect(p.exists).toBe(false)
    write('d.txt', 'mine\n')
    await expect(restore('d.txt', 'commit', before)).rejects.toThrow(`d.txt isn't in ${before.slice(0, 7)}`)
    await expect(restore('d.txt', 'commit', 'f'.repeat(40))).rejects.toThrow("That commit isn't in this repository")
    expect(read('d.txt')).toBe('mine\n')
    expect(stashMessages()).toEqual([])
  })

  it('round 1: refuses a commit where the path is a folder, in the plan and the restore; nothing is changed', async () => {
    // a.txt a folder then (a.txt/child), a file now.
    sh(proj, 'rm', '-q', 'a.txt')
    commit(proj, { 'a.txt/child': 'child\n' }, 'a folder')
    const folderAt = head()
    sh(proj, 'rm', '-rq', 'a.txt')
    commit(proj, { 'a.txt': 'a file again\n' }, 'a file')
    write('a.txt', 'mine\n')
    await expect(plan('a.txt', 'commit', null, folderAt)).rejects.toThrow(`a.txt isn't a file in ${folderAt.slice(0, 7)}`)
    await expect(restore('a.txt', 'commit', folderAt)).rejects.toThrow(`a.txt isn't a file in ${folderAt.slice(0, 7)}`)
    expect(read('a.txt')).toBe('mine\n')
    expect(stashMessages()).toEqual([])
  })

  it('round 1: refuses a folder of tracked files as the file, before anything is stashed', async () => {
    write('sub/c.txt', 'mine\n')
    await expect(plan('sub', 'head')).rejects.toThrow("Git doesn't track sub")
    await expect(restore('sub', 'head', head())).rejects.toThrow("Git doesn't track sub")
    expect(read('sub/c.txt')).toBe('mine\n')
    expect(stashMessages()).toEqual([])
  })

  it("A Commit…'s list: only the file's own commits, newest first, a page at a time", async () => {
    for (let i = 1; i <= HISTORY_COMMITS + 2; i++) commit(proj, { 'a.txt': `v${i}\n`, ...(i % 2 ? { 'b.txt': `b${i}\n` } : {}) }, `a ${i}`)
    commit(proj, { 'b.txt': 'only b\n' }, 'only b')
    const one = await R.fileCommits(proj, 'a.txt', 1)
    expect(one).toMatchObject({ page: 1, pages: 2, total: HISTORY_COMMITS + 3 })
    expect(one.commits).toHaveLength(HISTORY_COMMITS)
    expect(one.commits[0].subject).toBe(`a ${HISTORY_COMMITS + 2}`)
    const two = await R.fileCommits(proj, 'a.txt', 2)
    expect(two.commits.map((c) => c.subject)).toEqual(['a 2', 'a 1', 'files'])
    expect((await R.fileCommits(proj, 'sub/c.txt', 9)).commits.map((c) => c.subject)).toEqual(['files'])
  })
})

describe('refusals', () => {
  it('refuses while an operation is under way, a run or an agent works there, the file is in conflict, or the guard refuses; nothing is changed', async () => {
    write('a.txt', 'mine\n')
    held = ['a test run']
    await expect(restore('a.txt', 'head', head())).rejects.toThrow('A run or an agent is working')
    held = null
    agent = 'HB9'
    await expect(restore('a.txt', 'head', head())).rejects.toThrow('HB9 is working')
    agent = null
    await expect(
      restore('a.txt', 'head', head(), () => {
        throw new Error('a session is there')
      })
    ).rejects.toThrow('a session is there')
    expect(read('a.txt')).toBe('mine\n')
    sh(proj, 'checkout', '-q', '--', 'a.txt')
    sh(proj, 'switch', '-q', '-c', 'side')
    commit(proj, { 'b.txt': 'side\n' }, 'side')
    sh(proj, 'switch', '-q', 'main')
    commit(proj, { 'b.txt': 'main\n' }, 'main')
    expect(() => sh(proj, 'merge', '--no-edit', 'side')).toThrow()
    await expect(restore('b.txt', 'head', head())).rejects.toThrow('in the middle of a merge')
    sh(proj, 'merge', '--abort')
    expect(stashMessages()).toEqual([])
  })
})
