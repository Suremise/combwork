// HI-3478: Compare with… (SPEC §8, Compare a file). The path mapping (shared/fileCompare.ts); the git read
// (platform/git/gitFileCompare.ts: a file's version at a branch, tag or commit, its path there across renames on either
// side of the merge base, a path deleted there, unrelated histories, a path given); and the panel (fileComparePanel.ts):
// what it offers, and refs it refuses before git sees them. Real git in throwaway repositories.
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { timing } from './waits'
import { commit, gitRepo, sh } from './workflow/harness'
import { compareRefOk, pathAfter, pathBefore } from '../src/shared/fileCompare'

let slots: { folder: string; target: string | null }[] = []
vi.mock('../src/main/agentFolders', () => ({ boardSlots: async () => slots }))
vi.setConfig({ testTimeout: timing('test.hang') })

const C = await import('../src/main/platform/git/gitFileCompare')
const P = await import('../src/main/fileComparePanel')
const { gitRepoReads } = await import('../src/main/platform/git/gitRepoReads')

const base = tempDir('cw-filecompare-')
afterAll(() => rmSync(base, { recursive: true, force: true }))

let n = 0
let proj = ''
const later = (): number => Date.now() + 60_000
const at = (rel: string, ref: string, given: string | null = null) => C.fileAtRef(proj, rel, ref, given, later())
const ws = (project = proj) => ({ changesRootProject: (p: string) => ({ folder: p, project }) }) as unknown as Parameters<typeof P.compareChoicesAt>[0]

beforeEach(() => {
  proj = join(base, `proj${++n}`)
  mkdirSync(proj, { recursive: true })
  gitRepo(proj)
  sh(proj, 'config', 'core.autocrlf', 'false')
  slots = []
})

describe('the path mapping', () => {
  it('walks back through the renames since the merge base, newest first', () => {
    expect(pathBefore('c.txt', [[{ status: 'M', path: 'c.txt', oldPath: null }], [{ status: 'R', path: 'c.txt', oldPath: 'b.txt' }], [{ status: 'R', path: 'b.txt', oldPath: 'a.txt' }]])).toBe('a.txt')
    expect(pathBefore('x.txt', [])).toBe('x.txt')
  })
  it("follows the version's side: renamed, deleted, or as it was", () => {
    expect(pathAfter('a.txt', [{ status: 'R', path: 'z.txt', oldPath: 'a.txt' }])).toEqual({ path: 'z.txt', renamed: true })
    expect(pathAfter('a.txt', [{ status: 'D', path: 'a.txt', oldPath: null }])).toEqual({ path: null, renamed: false })
    expect(pathAfter('a.txt', [{ status: 'R', path: 'a.txt', oldPath: 'q.txt' }])).toEqual({ path: 'a.txt', renamed: false })
  })
  it('takes only names and hashes, never an option or a range', () => {
    for (const ok of ['main', 'feature/x', 'v1.2.0', 'a'.repeat(40)]) expect(compareRefOk(ok)).toBe(true)
    for (const bad of ['', '--output=x', '-x', 'a..b', 'HEAD~1', 'HEAD^', 'a b', 'x:y', '@{1}', 3]) expect(compareRefOk(bad)).toBe(false)
  })
})

describe('git read', () => {
  it("reads the file at a branch, the same path, and the version's commit", async () => {
    commit(proj, { 'f.txt': 'one\n' }, 'start')
    sh(proj, 'branch', 'target')
    const t = sh(proj, 'rev-parse', 'target')
    commit(proj, { 'f.txt': 'two\n' }, 'later')
    expect(await at('f.txt', 'target')).toEqual({ ref: 'target', commit: t, short: t.slice(0, 7), path: 'f.txt', how: 'same', text: 'one\n', state: 'file', binary: false })
  })

  it('finds a file renamed here since the merge base at its old path there', async () => {
    commit(proj, { 'old.txt': 'one\n' }, 'start')
    sh(proj, 'branch', 'target')
    sh(proj, 'mv', 'old.txt', 'new.txt')
    commit(proj, { 'new.txt': 'one\ntwo\n' }, 'rename and edit')
    expect(await at('new.txt', 'target')).toMatchObject({ path: 'old.txt', how: 'renamed', text: 'one\n' })
  })

  it("finds a file renamed only on the version's divergent branch", async () => {
    commit(proj, { 'a.txt': 'one\ntwo\nthree\n' }, 'start')
    sh(proj, 'checkout', '-q', '-b', 'side')
    sh(proj, 'mv', 'a.txt', 'z.txt')
    commit(proj, { 'z.txt': 'one\ntwo\nthree\nside\n' }, 'renamed on side')
    sh(proj, 'checkout', '-q', 'main')
    commit(proj, { 'a.txt': 'ONE\ntwo\nthree\n' }, 'main edits')
    expect(await at('a.txt', 'side')).toMatchObject({ path: 'z.txt', how: 'renamed', text: 'one\ntwo\nthree\nside\n' })
  })

  it('says a file deleted at the version maps to nothing, guessing nothing', async () => {
    commit(proj, { 'a.txt': 'one\n', 'keep.txt': 'k\n' }, 'start')
    sh(proj, 'checkout', '-q', '-b', 'side')
    sh(proj, 'rm', '-q', 'a.txt')
    commit(proj, {}, 'deleted on side')
    sh(proj, 'checkout', '-q', 'main')
    expect(await at('a.txt', 'side')).toMatchObject({ path: null, how: 'none', state: 'missing', text: '' })
  })

  it("takes a file new since the merge base as not there", async () => {
    commit(proj, { 'keep.txt': 'k\n' }, 'start')
    sh(proj, 'branch', 'target')
    commit(proj, { 'new.txt': 'n\n' }, 'add')
    expect(await at('new.txt', 'target')).toMatchObject({ path: 'new.txt', how: 'same', state: 'missing' })
  })

  it('uses the path as it is across unrelated histories', async () => {
    commit(proj, { 'f.txt': 'mine\n' }, 'start')
    sh(proj, 'checkout', '-q', '--orphan', 'other')
    sh(proj, 'rm', '-rfq', '.')
    commit(proj, { 'f.txt': 'theirs\n' }, 'unrelated')
    sh(proj, 'checkout', '-q', 'main')
    expect(await at('f.txt', 'other')).toMatchObject({ path: 'f.txt', how: 'same', text: 'theirs\n' })
  })

  it('reads a path given (History\'s row) as it is, at a tag or a commit', async () => {
    const one = commit(proj, { 'old.txt': 'one\ntwo\nthree\n' }, 'start')
    sh(proj, 'tag', '-a', '-m', 'v', 'v1')
    sh(proj, 'mv', 'old.txt', 'new.txt')
    commit(proj, { 'new.txt': 'one\ntwo\nthree\nfour\n' }, 'rename')
    expect(await at('new.txt', one, 'old.txt')).toMatchObject({ commit: one, path: 'old.txt', how: 'same', text: 'one\ntwo\nthree\n' })
    expect(await at('new.txt', 'v1')).toMatchObject({ commit: one, path: 'old.txt', how: 'renamed' })
  })

  it("refuses a name that isn't a commit here", async () => {
    commit(proj, { 'f.txt': 'one\n' }, 'start')
    await expect(at('f.txt', 'nowhere')).rejects.toThrow(/isn't a branch, tag or commit here/)
  })

  it("reads paths from the repository's top in a folder inside it", async () => {
    commit(proj, { 'sub/f.txt': 'one\n' }, 'start')
    sh(proj, 'branch', 'target')
    commit(proj, { 'sub/f.txt': 'two\n' }, 'later')
    expect(await C.fileAtRef(join(proj, 'sub'), 'f.txt', 'target', null, later())).toMatchObject({ path: 'sub/f.txt', text: 'one\n' })
  })
})

describe('the panel', () => {
  it("offers the branches and tags, newest first, and the slot's own target and project folder", async () => {
    commit(proj, { 'f.txt': 'one\n' }, 'start')
    sh(proj, 'branch', 'release')
    sh(proj, 'tag', '-a', '-m', 't', 'v1')
    const head = sh(proj, 'rev-parse', 'HEAD')
    const mine = await P.compareChoicesAt(ws(), proj, gitRepoReads)
    expect(mine.projectFolder).toBeNull()
    expect(mine.branches.map((b) => b.name).sort()).toEqual(['main', 'release'])
    expect(mine.tags).toEqual([{ name: 'v1', commit: head }])
    const slot = join(base, `slot${n}`)
    sh(proj, 'worktree', 'add', '-q', slot, '-b', 'card')
    slots = [{ folder: slot, target: 'release' }]
    const theirs = await P.compareChoicesAt(ws(proj), slot, gitRepoReads)
    expect(theirs.target).toEqual({ name: 'release', commit: head })
    expect(theirs.projectFolder).toBe(proj)
  })

  it('refuses an option-like or range ref, and a path outside the folder, before git sees them', async () => {
    commit(proj, { 'f.txt': 'one\n' }, 'start')
    for (const ref of ['--output=x', 'main..HEAD', 'HEAD~1']) await expect(P.compareWithAt(ws(), proj, 'f.txt', ref, null, gitRepoReads)).rejects.toThrow(/asked for wrongly/)
    await expect(P.compareWithAt(ws(), proj, '../f.txt', 'main', null, gitRepoReads)).rejects.toThrow(/asked for wrongly/)
    expect((await P.compareWithAt(ws(), proj, 'f.txt', 'main', null, gitRepoReads)).text).toBe('one\n')
  })
})
