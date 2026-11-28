// HI-3476: blame by card (SPEC §8, Blame by card). The parsing (shared/fileBlame.ts); the git read
// (platform/git/gitFileBlame.ts: the editor's text blamed, its own lines "not committed yet", lines followed across the
// file's renames, a file git has no version of); and the panel (fileBlamePanel.ts): each commit's own card and who
// submitted it (HI-3475's rules), a long file asked about first, a request stopped by the next or by cancel, bounded by
// History's deadline. Real git in throwaway repositories; the board is a stand-in.
import { mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { timing } from './waits'
import { commit, gitRepo, sh } from './workflow/harness'
import { ageShade, parseIncrementalBlame, UNCOMMITTED } from '../src/shared/fileBlame'
import type { Submission } from '../src/shared/workflow/facts'

const board = {
  cards: [] as { id: number; key: string; title: string }[],
  submissions: new Map<number, Submission[]>()
}
const fakeWorkflow = {
  store: {
    cardByKey: (key: string) => {
      const n = /^#(\d+)$/.exec(key)
      return board.cards.find((c) => (n ? c.id === Number(n[1]) : c.key === key)) ?? null
    },
    folderCommitCard: () => undefined
  },
  state: (n: number) => ({ submissions: board.submissions.get(n) ?? [] })
}
vi.mock('../src/main/workflow/service', () => ({ workflowFor: async () => fakeWorkflow }))
/** Git as blame runs it: a test may answer in its place, seeing each call's options; else the real one. */
type GitArgs = [cwd: string, args: string[], maxBuffer?: number, input?: string, opts?: { timeout?: number; signal?: AbortSignal }]
let gitHook: ((...a: GitArgs) => Promise<unknown> | null) | null = null
vi.mock('../src/main/git', async (original) => {
  const m = await original<typeof import('../src/main/git')>()
  return { ...m, git: (...a: GitArgs) => gitHook?.(...a) ?? m.git(...a) }
})

vi.setConfig({ testTimeout: timing('test.hang') })

const B = await import('../src/main/platform/git/gitFileBlame')
const P = await import('../src/main/fileBlamePanel')
const { gitRepoReads } = await import('../src/main/platform/git/gitRepoReads')
const { platformLimits } = await import('../src/main/platform/limits')
const limits = { ...platformLimits }

const base = tempDir('cw-fileblame-')
afterAll(() => rmSync(base, { recursive: true, force: true }))

let n = 0
let proj = ''
const ws = {
  changesRootProject: (p: string) => ({ folder: p, project: p }),
  projectConfig: async () => ({ agents: [{ id: 'a-1', name: 'HB5' }] })
}
type Ws = Parameters<typeof P.fileBlameAt>[0]
const text = (rel: string): string => readFileSync(join(proj, rel), 'utf8')
const blame = (rel: string, t = text(rel), large = false, id = `t${n}`) => P.fileBlameAt(ws as unknown as Ws, proj, rel, t, large, id, gitRepoReads)
const later = (): number => Date.now() + 60_000

beforeEach(() => {
  proj = join(base, `proj${++n}`)
  mkdirSync(proj, { recursive: true })
  gitRepo(proj)
  sh(proj, 'config', 'core.autocrlf', 'false')
  board.cards = [{ id: 12, key: 'HI-12', title: 'Twelve' }]
  board.submissions = new Map()
  gitHook = null
  Object.assign(platformLimits, limits)
})

describe('parsing', () => {
  const a = 'a'.repeat(40)
  const b = 'b'.repeat(40)
  it("reads git's incremental groups, each commit's details once, runs of one commit joined", () => {
    const out = [
      `${b} 3 3 1`,
      'author Bea',
      'author-mail <bea@x>',
      'author-time 200',
      'summary later',
      `previous ${a} old.txt`,
      'filename new.txt',
      `${a} 1 1 2`,
      'author Ann',
      'author-mail <ann@x>',
      'author-time 100',
      'summary first',
      'boundary',
      'filename old.txt',
      `${a} 4 4 1`,
      'filename old.txt',
      `${UNCOMMITTED} 5 5 1`,
      'author Not Committed Yet',
      'summary Version of new.txt from standard input',
      'filename new.txt'
    ].join('\n')
    const got = parseIncrementalBlame(out)
    expect(got.blocks).toEqual([
      { start: 1, count: 2, commit: a },
      { start: 3, count: 1, commit: b },
      { start: 4, count: 1, commit: a },
      { start: 5, count: 1, commit: null }
    ])
    expect(got.commits.get(b)).toEqual({ hash: b, author: 'Bea', email: 'bea@x', date: 200_000, subject: 'later', previous: { commit: a, path: 'old.txt' }, path: 'new.txt' })
    expect(got.commits.get(a)?.previous).toBeNull()
  })

  it('fades the older commits, the newest not at all', () => {
    expect(ageShade(10, 10, 0)).toBe(0)
    expect(ageShade(0, 10, 0)).toBe(1)
    expect(ageShade(5, 5, 5)).toBe(0)
  })
})

describe('git read', () => {
  it("names the commit of each line, the editor's own as not committed", async () => {
    const one = commit(proj, { 'f.txt': 'a\nb\nc\n' }, 'one')
    const two = commit(proj, { 'f.txt': 'a\nB\nc\n' }, 'two')
    const got = await B.fileBlame(proj, 'f.txt', 'a\nB\nc\nunsaved\n', later())
    if (got.kind !== 'blame') throw new Error(got.kind)
    expect(got.blocks).toEqual([
      { start: 1, count: 1, commit: one },
      { start: 2, count: 1, commit: two },
      { start: 3, count: 1, commit: one },
      { start: 4, count: 1, commit: null }
    ])
  })

  it("follows lines across the file's rename, with the path it had", async () => {
    const one = commit(proj, { 'old.txt': 'a\nb\n' }, 'one')
    sh(proj, 'mv', 'old.txt', 'new.txt')
    const two = commit(proj, { 'new.txt': 'a\nb\nc\n' }, 'two')
    const got = await B.fileBlame(proj, 'new.txt', text('new.txt'), later())
    if (got.kind !== 'blame') throw new Error(got.kind)
    expect(got.blocks).toEqual([
      { start: 1, count: 2, commit: one },
      { start: 3, count: 1, commit: two }
    ])
    expect(got.commits.find((c) => c.hash === one)?.path).toBe('old.txt')
    expect(got.commits.find((c) => c.hash === two)?.previous).toEqual({ commit: one, path: 'old.txt' })
  })

  it('has nothing to blame for a file the last commit lacks, or a folder with no commits', async () => {
    commit(proj, { 'f.txt': 'a\n' }, 'one')
    expect(await B.fileBlame(proj, 'new.txt', 'x\n', later())).toEqual({ kind: 'untracked' })
    const empty = join(base, `empty${n}`)
    mkdirSync(empty, { recursive: true })
    sh(empty, 'init', '-q')
    expect(await B.fileBlame(empty, 'f.txt', 'x\n', later())).toEqual({ kind: 'untracked' })
  })

  it("reads paths from the repository's top in a folder inside it", async () => {
    commit(proj, { 'sub/f.txt': 'a\n' }, 'one')
    const got = await B.fileBlame(join(proj, 'sub'), 'f.txt', 'a\n', later())
    if (got.kind !== 'blame') throw new Error(got.kind)
    expect(got.commits[0].path).toBe('sub/f.txt')
  })
})

describe('the panel', () => {
  const submission = (s: Partial<Submission> & Pick<Submission, 'id' | 'by'>): Submission => ({ revision: null, base: null, head: null, key: null, files: [], round: 1, generation: 0, sameRevision: false, summary: '', ...s }) as Submission

  it("names each commit's own card and who submitted it, else only the commit", async () => {
    const b0 = commit(proj, { 'f.txt': 'a\nb\n' }, 'plain start')
    const c = commit(proj, { 'f.txt': 'a\nB\n' }, 'HI-12: change b', { trailer: 'HI-12' })
    board.submissions.set(12, [submission({ id: 1, by: 'a-1', base: b0, revision: c })])
    const got = await blame('f.txt')
    if (got.kind !== 'blame') throw new Error(got.kind)
    expect(got.commits[c]).toMatchObject({ card: { key: 'HI-12', how: 'trailer', number: 12 }, submittedBy: { agent: 'a-1', name: 'HB5' }, subject: 'HI-12: change b' })
    expect(got.commits[b0]).toMatchObject({ card: null, submittedBy: null })
    expect(Object.keys(got.commits)).not.toContain(UNCOMMITTED)
  })

  it("asks first for a file longer than Settings → Advanced's limit", async () => {
    commit(proj, { 'f.txt': 'a\nb\nc\nd\n' }, 'one')
    platformLimits.blameAskLines = () => 3
    expect(await blame('f.txt')).toEqual({ kind: 'large', lines: 5, limit: 3 })
    expect((await blame('f.txt', undefined, true)).kind).toBe('blame')
  })

  it('stops a blame when the same request asks again, or is cancelled: its git is ended', async () => {
    commit(proj, { 'f.txt': 'a\n' }, 'one')
    const signals: AbortSignal[] = []
    let release = (): void => undefined
    gitHook = (_cwd, args, _max, _input, opts) => {
      if (args[0] !== '--literal-pathspecs' || args[1] !== 'blame') return null
      if (opts?.signal) signals.push(opts.signal)
      // A blame that runs until it is stopped.
      return new Promise((resolve) => {
        const done = (): void => resolve({ ok: false, out: '', buf: Buffer.alloc(0), err: 'cancelled', code: -1, cancelled: true })
        release = done
        opts?.signal?.addEventListener('abort', done, { once: true })
      })
    }
    const first = blame('f.txt', 'a\n', false, 'same')
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    const second = blame('f.txt', 'a\nb\n', false, 'same')
    await expect(first).rejects.toThrow(/changed meanwhile/)
    expect(signals[0].aborted).toBe(true)
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    P.fileBlameCancel('same')
    await expect(second).rejects.toThrow(/changed meanwhile/)
    expect(signals[1].aborted).toBe(true)
    release()
  })

  it("is bounded by History's deadline", async () => {
    commit(proj, { 'f.txt': 'a\n' }, 'one')
    platformLimits.gitHistoryMs = () => 7000
    gitHook = (_cwd, args, _max, _input, opts) => {
      expect(opts?.timeout).toBeGreaterThan(0)
      expect(opts?.timeout).toBeLessThanOrEqual(7000)
      return args[1] === 'blame' ? Promise.resolve({ ok: false, out: '', buf: Buffer.alloc(0), err: '', code: -1, timedOut: true }) : null
    }
    await expect(blame('f.txt')).rejects.toThrow(/still reading the history after 7 seconds/)
  })

  it('refuses a path outside the folder, and a request id that is no id', async () => {
    commit(proj, { 'f.txt': 'a\n' }, 'one')
    await expect(blame('../f.txt', 'a\n')).rejects.toThrow(/asked for wrongly/)
    await expect(blame('f.txt', 'a\n', false, 'no spaces allowed')).rejects.toThrow(/asked for wrongly/)
  })
})
