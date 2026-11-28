// HI-3475: the Files tab's History (SPEC §8, A file's history). The parsing (shared/fileHistory.ts); the git reads
// (platform/git/gitFileHistory.ts: a file's commits following its renames, a folder's, pinned pages, a file at two
// commits each side at its own path, the merge that introduced a commit, a submission's range); and the panel
// (fileHistoryPanel.ts): each commit's own card and who submitted it, never found through ancestry. Real git in
// throwaway repositories; the board is a stand-in.
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { timing } from './waits'
import { commit, gitRepo, sh } from './workflow/harness'
import { FILE_HISTORY_COMMITS, historyPathOk, introducingMerge, nameStatusOf, parseFileLog, subjectKey, trailerKey } from '../src/shared/fileHistory'
import type { Submission } from '../src/shared/workflow/facts'

/** The board History reads, as a test sets it: cards by key and number, attributions, each card's submissions. */
const board = {
  cards: [] as { id: number; key: string; title: string }[],
  attributed: new Map<string, number | null>(),
  submissions: new Map<number, Submission[]>(),
  none: false
}
const fakeWorkflow = {
  store: {
    cardByKey: (key: string) => {
      const n = /^#(\d+)$/.exec(key)
      return board.cards.find((c) => (n ? c.id === Number(n[1]) : c.key === key)) ?? null
    },
    folderCommitCard: (_folder: string, sha: string) => board.attributed.get(sha)
  },
  state: (n: number) => ({ submissions: board.submissions.get(n) ?? [] })
}
vi.mock('../src/main/workflow/service', () => ({ workflowFor: async () => (board.none ? null : fakeWorkflow) }))
/** Git as History runs it: a test may answer in its place (`gitHook`), seeing each call's options; else the real one. */
type GitArgs = [cwd: string, args: string[], maxBuffer?: number, input?: string, opts?: { timeout?: number }]
let gitHook: ((...a: GitArgs) => Promise<unknown> | null) | null = null
vi.mock('../src/main/git', async (original) => {
  const m = await original<typeof import('../src/main/git')>()
  return { ...m, git: (...a: GitArgs) => gitHook?.(...a) ?? m.git(...a) }
})

vi.setConfig({ testTimeout: timing('test.hang') })

const H = await import('../src/main/platform/git/gitFileHistory')
const P = await import('../src/main/fileHistoryPanel')
const { gitRepoReads } = await import('../src/main/platform/git/gitRepoReads')
const { platformLimits } = await import('../src/main/platform/limits')
const historyMs = platformLimits.gitHistoryMs

const base = tempDir('cw-filehistory-')
afterAll(() => rmSync(base, { recursive: true, force: true }))

let n = 0
let proj = ''
const head = (): string => sh(proj, 'rev-parse', 'HEAD')
const ws = {
  changesRootProject: (p: string) => ({ folder: p, project: p }),
  projectConfig: async () => ({ agents: [{ id: 'a-1', name: 'HB5' }] })
}
type Ws = Parameters<typeof P.fileHistoryAt>[0]
const history = (rel: string, isDir = false, pinned: string | null = null, page = 1) => P.fileHistoryAt(ws as unknown as Ws, proj, rel, isDir, pinned, page, gitRepoReads)

beforeEach(() => {
  proj = join(base, `proj${++n}`)
  mkdirSync(proj, { recursive: true })
  gitRepo(proj)
  sh(proj, 'config', 'core.autocrlf', 'false')
  board.cards = [
    { id: 12, key: 'HI-12', title: 'Twelve' },
    { id: 13, key: 'HI-13', title: 'Thirteen' }
  ]
  board.attributed = new Map()
  board.submissions = new Map()
  board.none = false
  gitHook = null
  platformLimits.gitHistoryMs = historyMs
})

describe('parsing', () => {
  it('reads name-status entries, a rename with both its paths', () => {
    expect(nameStatusOf(['M', 'a.txt', 'R097', 'old.txt', 'new.txt', 'A', 'b.txt'])).toEqual([
      { status: 'M', path: 'a.txt', oldPath: null },
      { status: 'R', path: 'new.txt', oldPath: 'old.txt' },
      { status: 'A', path: 'b.txt', oldPath: null }
    ])
  })

  it("reads git's -z log, one commit per record, a merge's first parent", () => {
    const out = `\x1e${'a'.repeat(40)}\x1f${'b'.repeat(40)} ${'c'.repeat(40)}\x1faaaaaaa\x1fAnn\x1fann@x\x1f100\x1fHI-12: things\x1fHI-12\x1f\0\nR100\0x.txt\0y.txt\0`
    expect(parseFileLog(out)).toEqual([{ hash: 'a'.repeat(40), short: 'aaaaaaa', parent: 'b'.repeat(40), author: 'Ann', email: 'ann@x', date: 100_000, subject: 'HI-12: things', trailer: 'HI-12', files: [{ status: 'R', path: 'y.txt', oldPath: 'x.txt' }] }])
  })

  it('takes a key only from the trailer or the start of the subject', () => {
    expect(trailerKey('HI-12, HI-13')).toBe('HI-12')
    expect(trailerKey('not a key')).toBeNull()
    expect(subjectKey('HI-12: a fix')).toBe('HI-12')
    expect(subjectKey("Fix HI-12's bug")).toBeNull()
  })

  it('reads only paths inside the folder', () => {
    for (const ok of ['', 'a.txt', 'sub/c.txt']) expect(historyPathOk(ok)).toBe(true)
    for (const bad of ['../x', 'a/../b', '/etc', 'C:/x', 'a\\b', 'a//b', './a', 3]) expect(historyPathOk(bad)).toBe(false)
  })

  describe('the merge that introduced a commit', () => {
    const line = (...rows: [string, ...string[]][]) => rows.map(([hash, ...parents]) => ({ hash, parents }))
    const has = (...hs: string[]) => (h: string) => hs.includes(h)
    it("is the oldest merge on the line holding it, whose first parent doesn't", () => {
      // H (holds c) ← M (merge of P and c's side) ← P (doesn't)
      expect(introducingMerge('c', line(['H', 'M'], ['M', 'P', 'c'], ['P', 'Q']), has('c', 'H', 'M'), false)).toBe('M')
    })
    it('is none for a commit on the line itself, even with a later merge', () => {
      expect(introducingMerge('c', line(['M', 'c', 'x'], ['c', 'P']), has('c', 'M'), false)).toBeNull()
    })
    it('is none for an octopus', () => {
      expect(introducingMerge('c', line(['O', 'P', 'c', 'd'], ['P', 'Q']), has('c', 'O'), false)).toBeNull()
    })
    it('is none when the line was read short of where it arrived', () => {
      expect(introducingMerge('c', line(['H', 'M'], ['M', 'P', 'c']), has('c', 'H', 'M', 'P'), false)).toBeNull()
    })
    it("is none when the second parent doesn't hold it", () => {
      expect(introducingMerge('c', line(['M', 'P', 'x'], ['P', 'Q']), has('c', 'M'), false)).toBeNull()
    })
  })
})

describe('git reads', () => {
  it("follows a file's rename, each commit with the path it had", async () => {
    commit(proj, { 'old.txt': 'one\n' }, 'make it')
    sh(proj, 'mv', 'old.txt', 'new.txt')
    commit(proj, { 'new.txt': 'one\ntwo\n' }, 'rename and edit')
    commit(proj, { 'new.txt': 'one\ntwo\nthree\n' }, 'edit')
    const got = await H.fileLog(proj, 'new.txt', false, null, 1)
    expect(got.commits.map((c) => c.subject)).toEqual(['edit', 'rename and edit', 'make it'])
    expect(got.commits[1].files).toEqual([{ status: 'R', path: 'new.txt', oldPath: 'old.txt' }])
    expect(got.commits[2].files).toEqual([{ status: 'A', path: 'old.txt', oldPath: null }])
    expect(got).toMatchObject({ head: head(), moved: false, more: false, repoPath: 'new.txt', prefix: '' })
  })

  it("lists a folder's commits with what each changed under it", async () => {
    commit(proj, { 'sub/a.txt': 'a\n', 'top.txt': 't\n' }, 'one')
    commit(proj, { 'top.txt': 't2\n' }, 'outside')
    commit(proj, { 'sub/b.txt': 'b\n' }, 'two')
    const got = await H.fileLog(proj, 'sub', true, null, 1)
    expect(got.commits.map((c) => c.subject)).toEqual(['two', 'one'])
    expect(got.commits[1].files).toEqual([{ status: 'A', path: 'sub/a.txt', oldPath: null }])
  })

  it('pages from the head page 1 pinned, saying when the folder has moved since', async () => {
    for (let i = 0; i <= FILE_HISTORY_COMMITS; i++) commit(proj, { 'f.txt': `${i}\n` }, `c${i}`)
    const first = await H.fileLog(proj, 'f.txt', false, null, 1)
    expect(first.commits).toHaveLength(FILE_HISTORY_COMMITS)
    expect(first.more).toBe(true)
    commit(proj, { 'f.txt': 'later\n' }, 'later')
    const second = await H.fileLog(proj, 'f.txt', false, first.head, 2)
    expect(second.head).toBe(first.head)
    expect(second.moved).toBe(true)
    expect(second.commits.map((c) => c.subject)).toEqual(['c0'])
    expect(second.more).toBe(false)
  })

  it('reads paths from the top of the repository for a folder inside one', async () => {
    commit(proj, { 'inner/x.txt': '1\n' }, 'in')
    const got = await H.fileLog(join(proj, 'inner'), 'x.txt', false, null, 1)
    expect(got).toMatchObject({ prefix: 'inner/', repoPath: 'inner/x.txt' })
    expect(got.commits[0].files[0].path).toBe('inner/x.txt')
  })

  it('reads a renamed and edited file at both its paths', async () => {
    const a = commit(proj, { 'old.txt': 'one\n' }, 'make it')
    sh(proj, 'mv', 'old.txt', 'new.txt')
    const b = commit(proj, { 'new.txt': 'one\ntwo\n' }, 'rename and edit')
    expect(await H.fileVersions(proj, { commit: a, path: 'old.txt' }, { commit: b, path: 'new.txt' })).toEqual({ path: 'new.txt', original: 'one\n', modified: 'one\ntwo\n', binary: false, left: 'file', right: 'file' })
  })

  it("says which side isn't there, and which isn't a file", async () => {
    const a = commit(proj, { 'x.txt': 'x\n', 'dir/y.txt': 'y\n' }, 'make')
    expect(await H.fileVersions(proj, null, { commit: a, path: 'x.txt' })).toMatchObject({ original: '', modified: 'x\n', left: 'missing', right: 'file' })
    expect(await H.fileVersions(proj, { commit: a, path: 'gone.txt' }, { commit: a, path: 'x.txt' })).toMatchObject({ left: 'missing' })
    expect(await H.fileVersions(proj, { commit: a, path: 'dir' }, { commit: a, path: 'x.txt' })).toMatchObject({ left: 'notFile', original: '' })
  })

  it('fails on a commit that is gone rather than showing an empty side', async () => {
    const a = commit(proj, { 'x.txt': 'x\n' }, 'make')
    await expect(H.fileVersions(proj, { commit: 'f'.repeat(40), path: 'x.txt' }, { commit: a, path: 'x.txt' })).rejects.toThrow()
  })

  it('finds the merge that brought a branch commit in, and none for a commit on the line', async () => {
    commit(proj, { 'a.txt': '1\n' }, 'start')
    sh(proj, 'checkout', '-q', '-b', 'side')
    const c = commit(proj, { 'b.txt': 'b\n' }, 'on the side')
    sh(proj, 'checkout', '-q', 'main')
    const onLine = commit(proj, { 'a.txt': '2\n' }, 'on main')
    sh(proj, 'merge', '-q', '--no-ff', '-m', 'HI-12: merge', '-m', 'Combwork-Card: HI-12', 'side')
    const m = head()
    // An unrelated later merge doesn't introduce a commit already on the line.
    sh(proj, 'checkout', '-q', '-b', 'other', 'HEAD~1')
    commit(proj, { 'c.txt': 'c\n' }, 'other work')
    sh(proj, 'checkout', '-q', 'main')
    sh(proj, 'merge', '-q', '--no-ff', '-m', 'HI-13: merge', 'other')
    expect(await H.introducedBy(proj, head(), c)).toMatchObject({ merge: m, subject: 'HI-12: merge', trailer: 'HI-12' })
    expect(await H.introducedBy(proj, head(), onLine)).toBeNull()
  })

  it("names the outer merge for a nested one, and none for an octopus's", async () => {
    commit(proj, { 'a.txt': '1\n' }, 'start')
    sh(proj, 'checkout', '-q', '-b', 'inner')
    const c = commit(proj, { 'i.txt': 'i\n' }, 'inner work')
    sh(proj, 'checkout', '-q', '-b', 'outer', 'main')
    commit(proj, { 'o.txt': 'o\n' }, 'outer work')
    sh(proj, 'merge', '-q', '--no-ff', '-m', 'inner into outer', 'inner')
    sh(proj, 'checkout', '-q', 'main')
    sh(proj, 'merge', '-q', '--no-ff', '-m', 'HI-13: outer', 'outer')
    expect(await H.introducedBy(proj, head(), c)).toMatchObject({ merge: head(), subject: 'HI-13: outer' })
    sh(proj, 'checkout', '-q', '-b', 'x1', 'main')
    const d = commit(proj, { 'x1.txt': '1\n' }, 'x1')
    sh(proj, 'checkout', '-q', '-b', 'x2', 'main')
    commit(proj, { 'x2.txt': '2\n' }, 'x2')
    sh(proj, 'checkout', '-q', 'main')
    sh(proj, 'merge', '-q', '--no-ff', '-m', 'octopus', 'x1', 'x2')
    expect(await H.introducedBy(proj, head(), d)).toBeNull()
  })

  it("lists a range's own commits, never its base's", async () => {
    const b = commit(proj, { 'a.txt': '1\n' }, 'base')
    const x = commit(proj, { 'a.txt': '2\n' }, 'x')
    const y = commit(proj, { 'a.txt': '3\n' }, 'y')
    expect([...((await H.rangeCommits(proj, b, y)) ?? [])].sort()).toEqual([x, y].sort())
  })

  it("says nothing of a range whose commits aren't here, rather than failing", async () => {
    const b = commit(proj, { 'a.txt': '1\n' }, 'base')
    expect(await H.rangeCommits(proj, 'e'.repeat(40), b)).toBeNull()
  })

  it('refuses a later page whose pinned commit is gone, never reading it from the head now', async () => {
    commit(proj, { 'f.txt': '1\n' }, 'one')
    await expect(H.fileLog(proj, 'f.txt', false, 'f'.repeat(40), 2)).rejects.toThrow(/no commit fffffff/)
  })

  it("fails a read git can't do, rather than answering empty", async () => {
    const plain = join(base, `plain${n}`)
    mkdirSync(plain, { recursive: true })
    await expect(H.fileLog(plain, 'x.txt', false, null, 1)).rejects.toThrow(/couldn't read the history/)
  })

  describe('bounded by Settings → Advanced', () => {
    const ended = () => Promise.resolve({ ok: false, out: '', buf: Buffer.alloc(0), err: '', code: -1, timedOut: true })

    it('gives each git what is left of the deadline, and refuses one git ended at it', async () => {
      commit(proj, { 'f.txt': '1\n' }, 'one')
      platformLimits.gitHistoryMs = () => 5000
      const timeouts: number[] = []
      gitHook = (_cwd, args, _max, _input, opts) => {
        timeouts.push(opts?.timeout ?? -1)
        // The log itself runs past its bound: git ends it.
        return args.includes('log') ? ended() : null
      }
      await expect(H.fileLog(proj, 'f.txt', false, null, 1)).rejects.toThrow(/still reading the history after 5 seconds/)
      expect(timeouts.length).toBeGreaterThan(1)
      expect(timeouts.every((t) => t > 0 && t <= 5000)).toBe(true)
    })

    it('starts no git once the deadline has passed', async () => {
      commit(proj, { 'f.txt': '1\n' }, 'one')
      let ran = 0
      gitHook = () => (ran++, null)
      await expect(H.fileLog(proj, 'f.txt', false, null, 1, Date.now() - 1)).rejects.toThrow(/still reading the history/)
      await expect(H.rangeCommits(proj, 'a'.repeat(40), 'b'.repeat(40), Date.now() - 1)).rejects.toThrow(/still reading the history/)
      expect(ran).toBe(0)
    })

    it("refuses the page when its submissions' ranges run past it, never showing it without its agents", async () => {
      const b = commit(proj, { 'f.txt': '0\n' }, 'start')
      const r = commit(proj, { 'f.txt': '1\n' }, 'HI-12: one')
      board.submissions.set(12, [{ id: 1, by: 'a-1', base: b, revision: r, head: null, key: null, files: [], round: 1, generation: 0, sameRevision: false, summary: '' } as Submission])
      gitHook = (_cwd, args) => (args[0] === 'rev-list' && args[1]?.includes('..') ? ended() : null)
      await expect(history('f.txt')).rejects.toThrow(/still reading the history/)
    })
  })
})

describe('the panel', () => {
  const submission = (s: Partial<Submission> & Pick<Submission, 'id' | 'by'>): Submission => ({ revision: null, base: null, head: null, key: null, files: [], round: 1, generation: 0, sameRevision: false, summary: '', ...s }) as Submission

  it("names the card a commit's trailer, attribution or subject names, in that order, never another project's", async () => {
    const t = commit(proj, { 'f.txt': '1\n' }, 'HI-13: says thirteen', { trailer: 'HI-12' })
    const a = commit(proj, { 'f.txt': '2\n' }, 'no key')
    const s = commit(proj, { 'f.txt': '3\n' }, 'HI-13: by its subject')
    commit(proj, { 'f.txt': '4\n' }, 'ZZ-1: another project')
    commit(proj, { 'f.txt': '5\n' }, "Fix HI-12's bug")
    board.attributed.set(a, 12)
    const got = await history('f.txt')
    expect(got.rows.map((r) => r.card && `${r.card.key}:${r.card.how}`)).toEqual([null, null, 'HI-13:subject', 'HI-12:attributed', 'HI-12:trailer'])
    expect(got.rows.find((r) => r.hash === s)?.card?.title).toBe('Thirteen')
    expect(got.rows.find((r) => r.hash === t)?.card?.number).toBe(12)
  })

  it("says who submitted a commit in its own card's submission, the user's own commit too", async () => {
    const b = commit(proj, { 'f.txt': '0\n' }, 'HI-13: before the card')
    const mine = commit(proj, { 'f.txt': '1\n' }, "HI-12: the user's own commit")
    const r = commit(proj, { 'f.txt': '2\n' }, 'HI-12: the agent')
    board.submissions.set(12, [submission({ id: 1, by: 'a-1', base: b, revision: r })])
    board.submissions.set(13, [])
    const got = await history('f.txt')
    expect(got.rows.map((x) => [x.subject, x.submittedBy?.name ?? null])).toEqual([
      ['HI-12: the agent', 'HB5'],
      ["HI-12: the user's own commit", 'HB5'],
      ['HI-13: before the card', null]
    ])
    expect(got.rows[0].hash).toBe(r)
    expect(got.rows[1].hash).toBe(mine)
  })

  it("gives no agent for a base or upstream commit inside a submission's range", async () => {
    const b = commit(proj, { 'f.txt': 'a\nb\nc\nd\ne\nf\n' }, 'start')
    sh(proj, 'checkout', '-q', '-b', 'card')
    commit(proj, { 'f.txt': 'A\nb\nc\nd\ne\nf\n' }, 'HI-12: card work')
    sh(proj, 'checkout', '-q', 'main')
    const up = commit(proj, { 'f.txt': 'a\nb\nc\nd\ne\nF\n' }, 'HI-13: upstream work')
    const plain = commit(proj, { 'f.txt': 'a\nb\nc\nd\nE\nF\n' }, 'no card at all')
    sh(proj, 'checkout', '-q', 'card')
    sh(proj, 'merge', '-q', '--no-edit', 'main')
    const r = head()
    board.submissions.set(12, [submission({ id: 1, by: 'a-1', base: b, revision: r })])
    const got = await history('f.txt')
    const of = (h: string) => got.rows.find((x) => x.hash === h)
    // The target merged in after submitting is in base..revision, but its commits name their own card, or none.
    expect(of(up)).toMatchObject({ card: { key: 'HI-13' }, submittedBy: null })
    expect(of(plain)).toMatchObject({ card: null, submittedBy: null })
    expect(got.rows.find((x) => x.subject === 'HI-12: card work')?.submittedBy?.agent).toBe('a-1')
  })

  it("takes a shared folder's recorded commits over its range, and reads a new submission at the next read", async () => {
    const b = commit(proj, { 'f.txt': '0\n' }, 'start')
    const c = commit(proj, { 'f.txt': '1\n' }, 'HI-12: one')
    expect((await history('f.txt')).rows[0].submittedBy).toBeNull()
    board.submissions.set(12, [submission({ id: 1, by: 'a-2', commits: [], base: b, revision: c }), submission({ id: 2, by: 'a-1', commits: [c] })])
    expect((await history('f.txt')).rows[0].submittedBy).toEqual({ agent: 'a-1', name: 'HB5' })
  })

  it('shows commits with no cards when the project has no board to read', async () => {
    commit(proj, { 'f.txt': '1\n' }, 'HI-12: one')
    board.none = true
    expect((await history('f.txt')).rows[0]).toMatchObject({ card: null, submittedBy: null })
  })

  it('refuses a path outside the folder, a pin that is no commit id, and a malformed side', async () => {
    const a = commit(proj, { 'f.txt': '1\n' }, 'one')
    await expect(history('../x')).rejects.toThrow()
    await expect(history('f.txt', false, 'HEAD', 2)).rejects.toThrow(/asked for wrongly/)
    await expect(history('f.txt', false, 'f'.repeat(40), 2)).rejects.toThrow(/no commit fffffff/)
    await expect(history('')).rejects.toThrow()
    await expect(P.fileHistoryDiffAt(ws as unknown as Ws, proj, { commit: 'HEAD', path: 'f.txt' }, { commit: a, path: 'f.txt' }, gitRepoReads)).rejects.toThrow()
    await expect(P.fileHistoryDiffAt(ws as unknown as Ws, proj, null, null, gitRepoReads)).rejects.toThrow()
  })

  it("names a merge's card for \"came in with\", apart from the commit's own", async () => {
    commit(proj, { 'a.txt': '1\n' }, 'start')
    sh(proj, 'checkout', '-q', '-b', 'side')
    const c = commit(proj, { 'b.txt': 'b\n' }, 'no key here')
    sh(proj, 'checkout', '-q', 'main')
    commit(proj, { 'a.txt': '2\n' }, 'on main')
    sh(proj, 'merge', '-q', '--no-ff', '-m', 'HI-12: merge', 'side')
    const got = await P.fileHistoryIntroAt(ws as unknown as Ws, proj, head(), c, gitRepoReads)
    expect(got).toMatchObject({ merge: head(), card: { key: 'HI-12', how: 'subject' } })
    expect((await history('b.txt')).rows[0].card).toBeNull()
  })
})
