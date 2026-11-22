// HI-3469: History's Moves (platform/git/gitMoves.ts, shared/gitMoves.ts): a branch's reflog read in plain words
// (Combwork's merges told by their trailer, its restores by their own message), and Restore to here…: the project
// folder's branch by git reset --keep (uncommitted work kept; a file the move would change refuses, named), a branch
// checked out nowhere by a compare-and-swap, each writing a move of its own that the one below it undoes; and what
// refuses it (checked out elsewhere, an open card's line, the merge slot, a session, a run or an agent in the folder, an
// operation under way, a branch moved since the user looked). Real git in throwaway repositories.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { timing } from './waits'
import { commit, gitRepo, sh } from './workflow/harness'
import { moveOf, restoreRequestOf } from '../src/shared/gitMoves'

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
const G = await import('../src/main/platform/git/gitMoves')

const base = tempDir('cw-gitmoves-')
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
const head = (ref = 'main'): string => sh(proj, 'rev-parse', ref)
const moves = (branch: string | null = 'main', page = 1) => inWorkspace(w, () => G.listMoves(proj, branch, page))
const plan = (branch: string, to: string, from = head(branch)) => inWorkspace(w, () => G.restorePlan(proj, { branch, from, to }))
const restore = (branch: string, to: string, from = head(branch)) => inWorkspace(w, () => G.restoreBranch(proj, { branch, from, to }))

beforeEach(() => {
  proj = join(w.path!, `proj${++n}`)
  mkdirSync(proj, { recursive: true })
  gitRepo(proj)
  sh(proj, 'config', 'core.autocrlf', 'false')
  sh(proj, 'config', 'core.logAllRefUpdates', 'true')
  commit(proj, { 'a.txt': 'base\n', 'b.txt': 'b\n' }, 'files')
  held = null
  agent = null
  card = null
  sessionIn = null
  slotHeld = false
})

describe('parsing', () => {
  it("names each of git's reflog messages, Combwork's merges by their trailer and its restores by their own words", () => {
    expect(moveOf('commit: a subject', '')).toEqual({ kind: 'commit', name: '' })
    expect(moveOf('commit (initial): one', '')).toEqual({ kind: 'initial', name: '' })
    expect(moveOf('commit (amend): two', '')).toEqual({ kind: 'amend', name: '' })
    expect(moveOf('commit (merge): Merge x', '')).toEqual({ kind: 'mergeCommit', name: '' })
    expect(moveOf('merge origin/main: Fast-forward', '')).toEqual({ kind: 'fastForward', name: 'origin/main' })
    expect(moveOf("merge side: Merge made by the 'ort' strategy.", '')).toEqual({ kind: 'merge', name: 'side' })
    expect(moveOf('pull --ff-only -q origin main: Fast-forward', '')).toEqual({ kind: 'pull', name: '' })
    expect(moveOf('rebase (finish): refs/heads/x onto 0123456789abcdef0123456789abcdef01234567', '')).toEqual({ kind: 'rebase', name: '0123456' })
    expect(moveOf('rebase -i (finish): refs/heads/x onto abcdef0', '')).toEqual({ kind: 'rebase', name: 'abcdef0' })
    expect(moveOf('reset: moving to HEAD~1', '')).toEqual({ kind: 'reset', name: 'HEAD~1' })
    expect(moveOf('branch: Created from main', '')).toEqual({ kind: 'created', name: 'main' })
    expect(moveOf('Branch: renamed refs/heads/old to refs/heads/new', '')).toEqual({ kind: 'renamed', name: 'old' })
    expect(moveOf('cherry-pick: a fix', '')).toEqual({ kind: 'cherryPick', name: '' })
    expect(moveOf('revert: Revert "x"', '')).toEqual({ kind: 'revert', name: '' })
    expect(moveOf('Combwork: restore from 0123456789ab: updating HEAD', '')).toEqual({ kind: 'restored', name: '0123456' })
    expect(moveOf('Combwork: up to date after a squash merge', '')).toEqual({ kind: 'combwork', name: 'up to date after a squash merge' })
    expect(moveOf('combwork: merge cw/HI/x', '')).toEqual({ kind: 'combwork', name: 'merge cw/HI/x' })
    // The merge queue moves its target with no message: its commit's trailer names the card.
    expect(moveOf('', 'HI-12')).toEqual({ kind: 'combworkMerge', name: 'HI-12' })
    expect(moveOf('', '')).toEqual({ kind: 'unnamed', name: '' })
    expect(moveOf('something new', 'HI-12')).toEqual({ kind: 'other', name: 'something new' })
  })

  it('takes only a request naming the branch and both commits in full', () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    expect(restoreRequestOf({ branch: 'main', from: a, to: b })).toEqual({ branch: 'main', from: a, to: b })
    expect(restoreRequestOf({ branch: 'main', from: a, to: 'HEAD~1' })).toBeNull()
    expect(restoreRequestOf({ branch: '', from: a, to: b })).toBeNull()
    expect(restoreRequestOf(null)).toBeNull()
  })
})

describe('the list', () => {
  it("lists the branch's moves newest first, each with its commit, time and words; a Combwork merge by its card", async () => {
    commit(proj, { 'a.txt': 'two\n' }, 'two')
    sh(proj, 'commit', '-q', '--amend', '-m', 'two amended')
    sh(proj, 'reset', '-q', '--hard', 'HEAD~1')
    // The merge queue's move of its target: update-ref with no message, its commit carrying the card's trailer.
    sh(proj, 'switch', '-q', '-c', 'work')
    const merged = commit(proj, { 'c.txt': 'c\n' }, 'HI-12: a card', { trailer: 'HI-12' })
    sh(proj, 'switch', '-q', 'main')
    sh(proj, 'update-ref', 'refs/heads/main', merged)
    sh(proj, 'reset', '-q', '--hard')
    const m = await moves()
    expect(m).toMatchObject({ branch: 'main', head: merged, folderBranch: 'main', page: 1 })
    expect(m.branches).toEqual(['main', 'work'])
    expect(m.moves.slice(0, 4).map((r) => [r.index, r.kind, r.name])).toEqual([
      [0, 'combworkMerge', 'HI-12'],
      [1, 'reset', 'HEAD~1'],
      [2, 'amend', ''],
      [3, 'commit', '']
    ])
    expect(m.moves[0]).toMatchObject({ commit: merged, subject: 'HI-12: a card', message: '' })
    expect(Math.abs(m.moves[0].at - Date.now())).toBeLessThan(10 * 60_000)
    // Another branch, by name; one that isn't a branch shows the project folder's.
    expect((await moves('work')).moves[0]).toMatchObject({ kind: 'commit', commit: merged })
    expect((await moves('nope')).branch).toBe('main')
  })

  it('pages the moves 20 at a time', async () => {
    for (let i = 0; i < 25; i++) commit(proj, { 'a.txt': `v${i}\n` }, `v${i}`)
    const first = await moves()
    expect([first.moves.length, first.page, first.pages, first.total >= 26]).toEqual([20, 1, 2, true])
    const second = await moves('main', 2)
    expect(second.moves[0].index).toBe(20)
    expect(second.page).toBe(2)
  })
})

describe('Restore to here…', () => {
  it("moves the project folder's branch back with git reset --keep, keeping uncommitted work, and the move below it undoes it", async () => {
    const old = head()
    const two = commit(proj, { 'a.txt': 'two\n' }, 'two')
    write('b.txt', 'mine\n')
    const p = await plan('main', old)
    expect(p).toMatchObject({ where: 'project', blocked: null, inTheWay: [], back: [], backMore: 0, droppedMore: 0, upstream: null, pushedDropped: 0 })
    expect(p.dropped.map((c) => [c.hash, c.subject])).toEqual([[two, 'two']])
    const done = await restore('main', old)
    expect(done).toContain(`It was at ${two}`)
    expect([head(), read('a.txt'), read('b.txt')]).toEqual([old, 'base\n', 'mine\n'])
    const m = await moves()
    expect(m.moves[0]).toMatchObject({ kind: 'restored', name: two.slice(0, 7), commit: old })
    // Undone: restored to the move below it.
    await restore('main', m.moves[1].commit)
    expect([head(), read('a.txt'), read('b.txt')]).toEqual([two, 'two\n', 'mine\n'])
    expect((await plan('main', old)).blocked).toBeNull()
  })

  it('refuses while an uncommitted file would change, naming it; nothing changes', async () => {
    const old = head()
    commit(proj, { 'a.txt': 'two\n' }, 'two')
    write('a.txt', 'mine\n')
    write('new.txt', 'untracked\n')
    const p = await plan('main', old)
    expect(p.inTheWay).toEqual(['a.txt'])
    expect(p.blocked).toContain('An uncommitted file would change')
    await expect(restore('main', old)).rejects.toThrow('An uncommitted file would change')
    expect([read('a.txt'), read('new.txt')]).toEqual(['mine\n', 'untracked\n'])
    // An untracked file the restore would bring back is in the way too.
    sh(proj, 'checkout', '-q', '--', 'a.txt')
    rmSync(join(proj, 'new.txt'))
    const before = head()
    commit(proj, { 'n.txt': 'n\n' }, 'adds n')
    sh(proj, 'rm', '-q', 'n.txt')
    sh(proj, 'commit', '-q', '-m', 'drops n')
    write('n.txt', 'mine\n')
    expect((await plan('main', sh(proj, 'rev-parse', 'HEAD~1'))).inTheWay).toEqual(['n.txt'])
    expect(before).not.toBe(head())
  })

  it('moves a branch checked out nowhere by a compare-and-swap, only from the commit the user saw', async () => {
    sh(proj, 'branch', 'side')
    const old = head('side')
    sh(proj, 'switch', '-q', 'side')
    const two = commit(proj, { 'a.txt': 'two\n' }, 'two')
    sh(proj, 'switch', '-q', 'main')
    expect((await plan('side', old)).where).toBe('nowhere')
    // Moved meanwhile: refused, the branch left where it is.
    await expect(restore('side', old, old)).rejects.toThrow('has moved on since you looked')
    await restore('side', old)
    expect(head('side')).toBe(old)
    expect((await moves('side')).moves[0]).toMatchObject({ kind: 'restored', name: two.slice(0, 7) })
    expect(read('a.txt')).toBe('base\n')
  })

  it("says how many of the dropped commits the branch's upstream has", async () => {
    const old = head()
    commit(proj, { 'a.txt': 'two\n' }, 'two')
    const three = commit(proj, { 'a.txt': 'three\n' }, 'three')
    sh(proj, 'remote', 'add', 'origin', join(base, 'nowhere.git'))
    sh(proj, 'update-ref', 'refs/remotes/origin/main', sh(proj, 'rev-parse', 'HEAD~1'))
    sh(proj, 'config', 'branch.main.remote', 'origin')
    sh(proj, 'config', 'branch.main.merge', 'refs/heads/main')
    const p = await plan('main', old)
    expect([p.upstream, p.pushedDropped, p.dropped.length, p.dropped[0].hash]).toEqual(['origin/main', 1, 2, three])
  })

  it('refuses a branch checked out in another worktree, an open card\'s line, a held merge slot, and where it is already', async () => {
    const old = head()
    commit(proj, { 'a.txt': 'two\n' }, 'two')
    sh(proj, 'branch', 'side')
    sh(proj, 'switch', '-q', 'side')
    commit(proj, { 'a.txt': 'side\n' }, 'side')
    sh(proj, 'switch', '-q', 'main')
    const other = join(base, `wt${n}`)
    sh(proj, 'worktree', 'add', '-q', other, 'side')
    expect((await plan('side', old)).blocked).toContain('is checked out in')
    await expect(restore('side', old)).rejects.toThrow('is checked out in')
    card = { number: 1, key: 'HI-7', title: 'x' }
    expect((await plan('main', old)).blocked).toContain('the branch of HI-7')
    card = null
    slotHeld = true
    expect((await plan('main', old)).blocked).toContain('its merge slot')
    slotHeld = false
    expect((await plan('main', head())).blocked).toContain('at that commit already')
  })

  it('refuses in the project folder while a session, a run or an agent is there, or git is mid-operation; nothing changes', async () => {
    const old = head()
    const two = commit(proj, { 'a.txt': 'two\n' }, 'two')
    sessionIn = proj
    await expect(restore('main', old)).rejects.toThrow("HB9's session is in the project folder")
    sessionIn = null
    held = [proj]
    await expect(restore('main', old)).rejects.toThrow('A run or an agent is working')
    held = null
    agent = 'HB8'
    await expect(restore('main', old)).rejects.toThrow('HB8 is working in the project folder')
    agent = null
    sh(proj, 'switch', '-q', '-c', 'x', old)
    commit(proj, { 'a.txt': 'x\n' }, 'x')
    sh(proj, 'switch', '-q', 'main')
    expect(() => sh(proj, 'merge', '--no-edit', 'x')).toThrow()
    await expect(restore('main', old)).rejects.toThrow('in the middle of a merge')
    sh(proj, 'merge', '--abort')
    expect(head()).toBe(two)
  })

  it('refuses a request that is malformed or names a commit git no longer has', async () => {
    await expect(inWorkspace(w, () => G.restorePlan(proj, { branch: 'main', from: head(), to: 'HEAD~1' }))).rejects.toThrow('asked for wrongly')
    await expect(plan('main', 'f'.repeat(40))).rejects.toThrow('no longer has the commit')
    await expect(plan('gone', head(), head())).rejects.toThrow("isn't a local branch")
  })
})
