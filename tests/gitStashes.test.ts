// HI-3472: Changes' Stashes (platform/git/gitStashes.ts, shared/gitStashes.ts): the list (each stash's branch, message,
// date and files, its untracked ones included, Combwork's own told by Set Aside's mark), Show's files and diffs, Apply,
// Pop (dropped only after a clean apply; kept on a conflict, which HI-3518's panel is told of) and Drop (only the stash
// the user saw, whatever moved its place), and what refuses Apply and Pop before git runs (an operation under way, a
// file in conflict, uncommitted changes to a file the stash holds, a run or an agent in the folder, the caller's guard).
// Real git in throwaway repositories.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join, resolve } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { timing } from './waits'
import { commit, gitRepo, sh } from './workflow/harness'
import { combworkStash, stashRefOf, stashRequestOf, stashSubject, type StashRef } from '../src/shared/gitStashes'

/** A git child's environment from the run context's allowlist, never the shell's (tests/README.md, Isolation). */
const { gitEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

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
/** The row of the list holding `commit` now (the first, newest), as the window names it. */
const rowOf = async (c: string): Promise<StashRef> => {
  const r = (await list()).find((x) => x.commit === c)
  if (!r) throw new Error(`no stash ${c}`)
  return { commit: r.commit, index: r.index, message: r.message }
}
const refFor = async (stash: string | StashRef): Promise<StashRef> => (typeof stash === 'string' ? rowOf(stash) : stash)
const apply = async (stash: string | StashRef, pop: boolean, guard?: () => void) => {
  const ref = await refFor(stash)
  return inWorkspace(w, () => S.applyStash(proj, proj, { ...ref, pop }, guard))
}
const drop = async (stash: string | StashRef) => {
  const ref = await refFor(stash)
  return inWorkspace(w, () => S.dropStash(proj, ref))
}
const messages = async (): Promise<string[]> => (await list()).map((r) => r.message)
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

  it('takes only a request naming a row by its commit, place and message', () => {
    const c = 'a'.repeat(40)
    const row = { commit: c, index: 2, message: 'm' }
    expect(stashRequestOf({ ...row, pop: true, lease: 'L1' })).toEqual({ ...row, pop: true, lease: 'L1' })
    expect(stashRequestOf({ ...row, pop: false })).toEqual({ ...row, pop: false })
    expect(stashRequestOf({ ...row, commit: 'stash@{0}', pop: false })).toBeNull()
    expect(stashRequestOf({ commit: c, pop: false })).toBeNull()
    expect(stashRequestOf(row)).toBeNull()
    expect(stashRequestOf(null)).toBeNull()
    expect(stashRefOf(row)).toEqual(row)
    expect(stashRefOf({ ...row, index: -1 })).toBeNull()
    expect(stashRefOf({ ...row, index: 1.5 })).toBeNull()
    expect(stashRefOf({ ...row, message: 3 })).toBeNull()
  })
})

describe('the list and Show', () => {
  it('HI-3531: lists hundreds of stashes with untracked files, past what one command line holds, each counted', async () => {
    // A real one first (git keeps refs/stash's reflog), then 820 more, each with an untracked commit of its own: made
    // in one fast-import and listed in one update-ref transaction each, so it is quick however loaded the machine is.
    write('extra.txt', 'x\n')
    sh(proj, 'stash', 'push', '-q', '-u', '-m', 'real')
    const head = sh(proj, 'rev-parse', 'HEAD').trim()
    const N = 820
    const who = 'committer T <t@example.invalid> 1700000000 +0000\n'
    let stream = ''
    for (let i = 1; i <= N; i++) {
      const file = `u${i}.txt`
      stream += `reset refs/cw/u\ncommit refs/cw/u\nmark :${i}\n${who}data 1\nu\nM 100644 inline ${file}\ndata 2\n${i % 10}\n\n`
      stream += `commit refs/cw/s\nmark :${N + i}\n${who}data 2\ns\nfrom ${head}\nmerge ${head}\nmerge :${i}\n\n`
    }
    const marks = join(base, `marks-${n}.txt`)
    execFileSync('git', ['fast-import', '--quiet', `--export-marks=${marks}`], { cwd: proj, env: gitEnv(), input: stream })
    const sha = new Map(readFileSync(marks, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split(' ') as [string, string]))
    const tx = Array.from({ length: N }, (_, i) => `start\nupdate refs/stash ${sha.get(`:${N + i + 1}`)}\ncommit\n`).join('')
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'update-ref', '--stdin'], { cwd: proj, env: gitEnv(), input: tx })
    expect(stashes().length).toBe(N + 1)
    const rows = await list()
    expect(rows.length).toBe(N + 1)
    // Every one's untracked file counted, the real one's too.
    expect(rows.every((r) => r.files === 1)).toBe(true)
    expect(rows[N].message).toBe('real')
  })

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

  it('HI-3529: Show of a stash that replaced a file with a folder: the file deleted, the folder\'s file added', async () => {
    sh(proj, 'rm', '-q', 'a.txt')
    mkdirSync(join(proj, 'a.txt'))
    write('a.txt/child', 'new\n')
    sh(proj, 'add', '-A')
    sh(proj, 'stash', 'push', '-q', '-m', 'reorganise')
    const [s] = await list()
    expect(await S.stashFiles(proj, s.commit)).toEqual([
      { path: 'a.txt', status: 'D', untracked: false },
      { path: 'a.txt/child', status: 'A', untracked: false }
    ])
    const gone = await S.stashDiff(proj, s.commit, 'a.txt', false)
    expect([gone.original.replace(/\r\n/g, '\n'), gone.modified, gone.binary]).toEqual(['base\n', '', false])
    const added = await S.stashDiff(proj, s.commit, 'a.txt/child', false)
    expect([added.original, added.modified.replace(/\r\n/g, '\n')]).toEqual(['', 'new\n'])
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

  it("HI-3528: a conflict made since, by another stash in a terminal, isn't named as the applied stash's; settling some of its own keeps it", async () => {
    write('a.txt', 'first\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'first')
    write('b.txt', 'second\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'second')
    write('a.txt', 'both a\n')
    write('b.txt', 'both b\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'both')
    const [both, second, first] = stashes()
    commit(proj, { 'a.txt': 'theirs a\n', 'b.txt': 'theirs b\n' }, 'moved on')
    const head = sh(proj, 'rev-parse', 'HEAD')
    expect(await apply(first, false)).toEqual({ conflicts: ['a.txt'], dropped: false })
    expect(await S.stashConflictIn(proj)).toEqual({ commit: first, label: 'first', head })
    // In a terminal: a.txt put back as HEAD has it, then the other stash applied, HEAD unchanged; b.txt is in conflict.
    sh(proj, 'restore', '--source=HEAD', '--staged', '--worktree', 'a.txt')
    expect(() => sh(proj, 'stash', 'apply', second)).toThrow()
    expect(sh(proj, 'diff', '--name-only', '--diff-filter=U')).toBe('b.txt')
    expect(await S.stashConflictIn(proj)).toBeNull()
    // And once forgotten, it stays so, though the terminal's conflict is settled and the HEAD is the same.
    sh(proj, 'checkout', '--theirs', '--', 'b.txt')
    sh(proj, 'add', 'b.txt')
    expect(await S.stashConflictIn(proj)).toBeNull()
    sh(proj, 'reset', '-q', '--hard')
    // Two files of one stash in conflict: settling one keeps the stash named; the same file conflicted again by
    // another stash, with other sides, doesn't.
    expect(await apply(both, false)).toEqual({ conflicts: ['a.txt', 'b.txt'], dropped: false })
    sh(proj, 'checkout', '--theirs', '--', 'a.txt')
    sh(proj, 'add', 'a.txt')
    expect(await S.stashConflictIn(proj)).toEqual({ commit: both, label: 'both', head })
    sh(proj, 'restore', '--source=HEAD', '--staged', '--worktree', 'b.txt')
    expect(() => sh(proj, 'stash', 'apply', second)).toThrow()
    expect(sh(proj, 'diff', '--name-only', '--diff-filter=U')).toBe('b.txt')
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
    const row = await rowOf(c)
    sh(proj, 'stash', 'drop', '-q')
    await expect(apply(row, false)).rejects.toThrow("isn't in the list any more")
  })

  it('HI-3527: Pop drops the row the user saw, not another holding its commit', async () => {
    write('a.txt', 'one\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'original')
    const [one] = stashes()
    write('b.txt', 'two\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'middle')
    sh(proj, 'stash', 'store', '-m', 'relisted', one)
    const rows = await list()
    expect(rows.map((r) => [r.message, r.commit === one])).toEqual([['relisted', true], ['middle', false], ['original', true]])
    expect(await apply(rows[2], true)).toEqual({ conflicts: [], dropped: true })
    expect(read('a.txt')).toBe('one\n')
    expect(await messages()).toEqual(['relisted', 'middle'])
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
    const row = await rowOf(one)
    await drop(row)
    expect(stashes()).toEqual([two])
    await expect(drop(row)).rejects.toThrow("isn't in the list any more")
    await drop(two)
    expect(stashes()).toEqual([])
  })

  it('HI-3527: drops the row the user saw when several hold one commit, the bottom one too', async () => {
    write('a.txt', 'one\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'original')
    const [one] = stashes()
    write('b.txt', 'two\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'middle')
    sh(proj, 'stash', 'store', '-m', 'relisted', one)
    const rows = await list()
    await drop(rows[2])
    expect(await messages()).toEqual(['relisted', 'middle'])
    // The bottom one of another commit's two rows, by its own row. (Git lists a stored commit only under another top.)
    const [, mid] = stashes()
    sh(proj, 'stash', 'store', '-m', 'again', mid)
    const again = await list()
    expect(again.map((r) => r.message)).toEqual(['again', 'relisted', 'middle'])
    await drop(again[2])
    expect(await messages()).toEqual(['again', 'relisted'])
  })

  it('HI-3527: finds the row after the places moved; refuses when no row, or several and none at its place, is it', async () => {
    write('a.txt', 'one\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'original')
    const [one] = stashes()
    write('b.txt', 'two\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'other')
    const [other] = stashes()
    sh(proj, 'stash', 'store', '-m', 'relisted', one)
    const [relisted, , original] = (await list()).map((r) => ({ commit: r.commit, index: r.index, message: r.message }))
    expect([relisted.message, original.message]).toEqual(['relisted', 'original'])
    // A stash made meanwhile moves every place by one; and the row the user chose is dropped meanwhile.
    write('a.txt', 'three\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'meanwhile')
    sh(proj, 'stash', 'drop', '-q', 'stash@{3}')
    expect(await messages()).toEqual(['meanwhile', 'relisted', 'other'])
    // The other row holding its commit isn't taken instead.
    await expect(drop(original)).rejects.toThrow("isn't in the list any more")
    expect(await messages()).toEqual(['meanwhile', 'relisted', 'other'])
    // A row whose place moved is found by its commit and message.
    await drop(relisted)
    expect(await messages()).toEqual(['meanwhile', 'other'])
    // Two rows alike (commit and message), none at the place the user saw: which one can't be told.
    sh(proj, 'stash', 'store', '-m', 'twin', one)
    sh(proj, 'stash', 'store', '-m', 'between', other)
    sh(proj, 'stash', 'store', '-m', 'twin', one)
    expect(await messages()).toEqual(['twin', 'between', 'twin', 'meanwhile', 'other'])
    await expect(drop({ commit: one, index: 4, message: 'twin' })).rejects.toThrow('more than one is like the one you chose')
    expect(await messages()).toEqual(['twin', 'between', 'twin', 'meanwhile', 'other'])
    await drop({ commit: one, index: 2, message: 'twin' })
    expect(await messages()).toEqual(['twin', 'between', 'meanwhile', 'other'])
  })
})
