// HI-3471: History's Commit dialog (platform/git/gitCommitActions.ts, shared/gitCommitView.ts): a commit's details and
// files (its card from its trailer or subject, a root commit's files, a merge's against its first parent) and one file's
// diff; Revert… and Cherry-pick… onto the project folder's branch (a merge with -m 1), a conflict leaving git
// mid-operation for Changes' panel, and what refuses them (a detached HEAD, the branch moved since the user looked, the
// commit not in it or already in it, uncommitted tracked changes, a session, a run or an agent in the folder, a held
// merge slot). Real git in throwaway repositories.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { timing } from './waits'
import { commit, gitRepo, sh } from './workflow/harness'
import { commitActionOf, commitCard } from '../src/shared/gitCommitView'

/** What the queue counts as building in a folder: none unless a test says. */
let held: string[] | null = null
vi.mock('../src/main/workflow/queueHost', () => ({ folderBuilders: () => held }))
/** An agent working in the folder: none unless a test says. */
let agent: string | null = null
vi.mock('../src/main/gitRepo', async (original) => ({ ...(await original<typeof import('../src/main/gitRepo')>()), busyAgentIn: async () => agent }))
/** An open card whose line the branch is: none unless a test says. */
let card: { number: number; key: string; title: string } | null = null
vi.mock('../src/main/branchMerge', async (original) => ({ ...(await original<typeof import('../src/main/branchMerge')>()), lineCard: async () => card }))

vi.setConfig({ testTimeout: timing('test.hang') })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { mergeSlots } = await import('../src/main/mergeSlotHost')
const C = await import('../src/main/platform/git/gitCommitActions')

const base = tempDir('cw-gitcommit-')
const w = createWorkspaceService()
w.path = join(base, 'ws')
afterAll(async () => {
  await disposeWorkspaceService(w)
  rmSync(base, { recursive: true, force: true })
})

/** A session's folder, a slot's holder: none unless a test says. */
let sessionIn: string | null = null
let slotHeld = false
vi.spyOn(sessions, 'liveStates').mockImplementation(() => (sessionIn ? ([{ cwd: sessionIn, agentName: 'HB9', agentId: 'a-1' }] as unknown as ReturnType<typeof sessions.liveStates>) : []))
vi.spyOn(mergeSlots, 'list').mockImplementation(() => (slotHeld ? ([{ branch: 'main', holder: { kind: 'agent', name: 'HB2' }, waiting: [] }] as unknown as ReturnType<typeof mergeSlots.list>) : []))

let n = 0
let proj = ''
const read = (rel: string): string => readFileSync(join(proj, rel), 'utf8').replace(/\r\n/g, '\n')
const write = (rel: string, text: string): void => writeFileSync(join(proj, rel), text)
const head = (ref = 'HEAD'): string => sh(proj, 'rev-parse', ref)
const detail = (c: string) => inWorkspace(w, () => C.commitDetail(proj, c))
const act = (action: 'revert' | 'cherryPick', c: string, branch = 'main', at = head()) => inWorkspace(w, () => C.commitAction(proj, { action, commit: c, branch, head: at }))

beforeEach(() => {
  proj = join(w.path!, `proj${++n}`)
  mkdirSync(proj, { recursive: true })
  gitRepo(proj)
  sh(proj, 'config', 'core.autocrlf', 'false')
  commit(proj, { 'a.txt': 'base\n', 'b.txt': 'b\n' }, 'files')
  held = null
  agent = null
  sessionIn = null
  slotHeld = false
  card = null
})

describe('parsing', () => {
  it("names a commit's card by its trailer, else a key at the start of its subject", () => {
    expect(commitCard('HI-12', 'anything')).toBe('HI-12')
    expect(commitCard('', 'HI-34: a fix')).toBe('HI-34')
    expect(commitCard('', 'Fix HI-34')).toBeNull()
    expect(commitCard('not a key', 'plain')).toBeNull()
  })

  it('takes only a request naming the action, the commit, the branch and its head', () => {
    const a = 'a'.repeat(40)
    expect(commitActionOf({ action: 'revert', commit: a, branch: 'main', head: a })).toEqual({ action: 'revert', commit: a, branch: 'main', head: a })
    expect(commitActionOf({ action: 'reset', commit: a, branch: 'main', head: a })).toBeNull()
    expect(commitActionOf({ action: 'revert', commit: 'HEAD', branch: 'main', head: a })).toBeNull()
    expect(commitActionOf(null)).toBeNull()
  })
})

describe('details', () => {
  it('reads a commit: hash, author, message, card, files against its first parent, and a file\'s diff', async () => {
    const c = commit(proj, { 'a.txt': 'two\n', 'c.txt': 'c\n' }, 'HI-7: two things\n\nThe body.', { trailer: 'HI-7' })
    const d = await detail(c)
    expect(d).toMatchObject({ hash: c, short: c.slice(0, d.short.length), subject: 'HI-7: two things', card: 'HI-7', branch: 'main', head: c, revert: null })
    expect(d.message).toContain('The body.')
    expect(d.files).toEqual([
      { path: 'a.txt', status: 'M' },
      { path: 'c.txt', status: 'A' }
    ])
    // It is in main already: no pick.
    expect(d.cherryPick).toContain('has this commit already')
    const diff = await inWorkspace(w, () => C.commitFileDiff(proj, c, 'a.txt'))
    expect([diff.original.replace(/\r\n/g, '\n'), diff.modified.replace(/\r\n/g, '\n')]).toEqual(['base\n', 'two\n'])
  })

  it("lists a root commit's files, and a merge's against its first parent", async () => {
    const root = sh(proj, 'rev-list', '--max-parents=0', 'HEAD')
    const r = await detail(root)
    const first = sh(proj, 'ls-tree', '-r', '--name-only', root).split(/\r?\n/).filter(Boolean)
    expect([r.parents, r.files.map((f) => f.path), r.files.every((f) => f.status === 'A')]).toEqual([[], first, true])
    const diff = await inWorkspace(w, () => C.commitFileDiff(proj, root, first[0]))
    expect([diff.original, diff.modified.length > 0]).toEqual(['', true])
    sh(proj, 'switch', '-q', '-c', 'side')
    commit(proj, { 's.txt': 's\n' }, 'side')
    sh(proj, 'switch', '-q', 'main')
    commit(proj, { 'm.txt': 'm\n' }, 'main')
    sh(proj, 'merge', '-q', '--no-ff', '--no-edit', 'side')
    const m = await detail(head())
    expect([m.parents.length, m.files]).toEqual([2, [{ path: 's.txt', status: 'A' }]])
  })

  it('refuses a commit that is malformed or not in the repository', async () => {
    await expect(detail('HEAD')).rejects.toThrow('asked for wrongly')
    await expect(detail('f'.repeat(40))).rejects.toThrow('Git has no commit')
  })
})

describe('Revert… and Cherry-pick…', () => {
  it('reverts a commit on the folder\'s branch with a new commit, and picks one from another branch', async () => {
    const c = commit(proj, { 'a.txt': 'two\n' }, 'two')
    const done = await act('revert', c)
    expect(done.made).toBe(head())
    expect(done.notice).toContain(`Reverted ${c.slice(0, 7)} on main`)
    expect(read('a.txt')).toBe('base\n')
    sh(proj, 'switch', '-q', '-c', 'side')
    const s = commit(proj, { 's.txt': 'side\n' }, 'on side')
    sh(proj, 'switch', '-q', 'main')
    expect((await detail(s)).revert).toContain("doesn't have this commit")
    const picked = await act('cherryPick', s)
    expect(picked.made).toBe(head())
    expect(read('s.txt')).toBe('side\n')
    expect(sh(proj, 'log', '-1', '--format=%s')).toBe('on side')
  })

  it("reverts a merge against its first parent", async () => {
    sh(proj, 'switch', '-q', '-c', 'side')
    commit(proj, { 's.txt': 's\n' }, 'side')
    sh(proj, 'switch', '-q', 'main')
    commit(proj, { 'm.txt': 'm\n' }, 'main')
    sh(proj, 'merge', '-q', '--no-ff', '--no-edit', 'side')
    const merge = head()
    const done = await act('revert', merge)
    expect(done.made).toBeTruthy()
    expect(() => readFileSync(join(proj, 's.txt'))).toThrow()
    expect(read('m.txt')).toBe('m\n')
  })

  it("a conflict leaves git mid-pick for Changes' panel, naming the files", async () => {
    sh(proj, 'switch', '-q', '-c', 'side')
    const s = commit(proj, { 'a.txt': 'side\n' }, 'side edit')
    sh(proj, 'switch', '-q', 'main')
    commit(proj, { 'a.txt': 'main\n' }, 'main edit')
    const done = await act('cherryPick', s)
    expect(done).toMatchObject({ made: null, conflicts: ['a.txt'] })
    expect(done.notice).toContain('stopped on a conflict in 1 file')
    expect(sh(proj, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD')).toBe(s)
    sh(proj, 'cherry-pick', '--abort')
  })

  it('refuses on a detached HEAD, a branch moved since the user looked, uncommitted tracked changes, a session, a run, an agent or a held slot; nothing changes', async () => {
    const c = commit(proj, { 'a.txt': 'two\n' }, 'two')
    const at = head()
    await expect(act('revert', c, 'main', 'e'.repeat(40))).rejects.toThrow('no longer on main at the commit you saw')
    write('a.txt', 'mine\n')
    expect((await detail(c)).revert).toContain('uncommitted changes')
    await expect(act('revert', c)).rejects.toThrow('uncommitted changes')
    sh(proj, 'checkout', '-q', '--', 'a.txt')
    // Untracked files are no reason.
    write('u.txt', 'untracked\n')
    sessionIn = proj
    await expect(act('revert', c)).rejects.toThrow("HB9's session is in the project folder")
    sessionIn = null
    held = [proj]
    await expect(act('revert', c)).rejects.toThrow('A run or an agent is working')
    held = null
    agent = 'HB8'
    await expect(act('revert', c)).rejects.toThrow('HB8 is working in the project folder')
    agent = null
    slotHeld = true
    await expect(act('revert', c)).rejects.toThrow('its merge slot')
    slotHeld = false
    card = { number: 1, key: 'HI-7', title: 'x' }
    await expect(act('revert', c)).rejects.toThrow('the branch of HI-7')
    card = null
    expect(head()).toBe(at)
    sh(proj, 'switch', '-q', '--detach')
    expect((await detail(c)).revert).toContain('detached HEAD')
    expect(head()).toBe(at)
  })
})
