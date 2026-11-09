// Read-only jj detection's logic (HI-2793's J0), on hand-made .jj layouts and a stub runner: what its files say, what
// jj is asked and how a disagreement, a tool that can't run or a read that didn't answer is unknown, never a guess
// (SPEC §16.3.6 rule 3). The real jj's layouts are jjReal.test.ts's.
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { jjContextOf } from '../src/main/platform/jjDetect'
import type { JjRunner, JjRunResult } from '../src/main/platform/jjRunner'
import type { JjTool } from '../src/shared/jjTool'
import { tempDir } from './tempDir'

const OK: JjTool = { state: 'ok', version: '0.47.1', path: 'C:\\tools\\jj.exe' }
const answer = (out: string, code = 0): JjRunResult => ({ out, ok: code === 0, buf: Buffer.from(out), err: code ? 'Error: no' : '', code })

/** A stub jj: its tool, and an answer per command (by its arguments); every call recorded. */
function stub(answers: Record<string, JjRunResult>, tool: JjTool = OK): JjRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    readiness: async () => tool,
    readinessNow: () => tool,
    problem: () => (tool.state === 'ok' ? null : 'no jj'),
    shutdown: async () => undefined,
    run: async (_folder, args) => {
      calls.push([...args])
      return answers[args.join(' ')] ?? answer('', 1)
    }
  }
}

/** A first workspace: `.jj/repo` a folder, its store Git-backed at `git_target`. */
function workspace(root: string, target: string, type = 'git'): void {
  mkdirSync(join(root, '.jj', 'repo', 'store'), { recursive: true })
  mkdirSync(join(root, '.jj', 'working_copy'), { recursive: true })
  writeFileSync(join(root, '.jj', 'repo', 'store', 'type'), type)
  writeFileSync(join(root, '.jj', 'repo', 'store', 'git_target'), target)
}
/** A Git folder, as a store must be (a HEAD). */
function gitDir(d: string): void {
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'HEAD'), 'ref: refs/heads/main')
}
const confirms = (root: string, store: string): Record<string, JjRunResult> => ({ root: answer(`${root}\n`), 'git root': answer(`${store}\n`) })

describe('jj detection (read-only)', () => {
  it('finds nothing, and runs nothing, where no .jj is at or above the folder; names a Git root met on the way', async () => {
    const d = tempDir('jjd-none-')
    const s = stub({})
    expect(await jjContextOf(d, s)).toEqual({ none: true })
    mkdirSync(join(d, 'g', '.git'), { recursive: true })
    expect(await jjContextOf(join(d, 'g'), s)).toEqual({ none: true, nestedGit: resolve(d, 'g') })
    expect(s.calls).toEqual([])
  })

  it('a colocated workspace: the Git store is the .git beside .jj, confirmed by jj root and jj git root', async () => {
    const root = tempDir('jjd-co-')
    gitDir(join(root, '.git'))
    workspace(root, '../../../.git')
    mkdirSync(join(root, 'src'))
    const s = stub(confirms(root, join(root, '.git')))
    const d = await jjContextOf(join(root, 'src'), s)
    expect(d).toMatchObject({ jj: { root: resolve(root), store: resolve(root, '.git'), jjRepo: resolve(root, '.jj', 'repo'), workspace: resolve(root, '.jj'), folder: resolve(root, 'src'), subfolder: true, colocated: true, linked: false, tool: OK } })
    expect(s.calls).toEqual([['root'], ['git', 'root']])
  })

  it("a linked workspace: .jj/repo names the first workspace's repository, so one store", async () => {
    const first = tempDir('jjd-first-')
    workspace(first, 'git')
    gitDir(join(first, '.jj', 'repo', 'store', 'git'))
    const second = tempDir('jjd-second-')
    mkdirSync(join(second, '.jj'))
    writeFileSync(join(second, '.jj', 'repo'), join(first, '.jj', 'repo'))
    const store = join(first, '.jj', 'repo', 'store', 'git')
    const d = await jjContextOf(second, stub(confirms(second, store)))
    expect(d).toMatchObject({ jj: { root: resolve(second), store: resolve(store), jjRepo: resolve(first, '.jj', 'repo'), workspace: resolve(second, '.jj'), linked: true, colocated: false } })
  })

  it('a linked colocated workspace: its .git is a worktree whose common dir is the store', async () => {
    const first = tempDir('jjd-cofirst-')
    gitDir(join(first, '.git'))
    mkdirSync(join(first, '.git', 'worktrees', 'b'), { recursive: true })
    writeFileSync(join(first, '.git', 'worktrees', 'b', 'commondir'), '../..')
    workspace(first, '../../../.git')
    const second = tempDir('jjd-cosecond-')
    mkdirSync(join(second, '.jj'))
    writeFileSync(join(second, '.jj', 'repo'), join(first, '.jj', 'repo'))
    writeFileSync(join(second, '.git'), `gitdir: ${join(first, '.git', 'worktrees', 'b')}\n`)
    const d = await jjContextOf(second, stub(confirms(second, join(first, '.git'))))
    expect(d).toMatchObject({ jj: { linked: true, colocated: true, store: resolve(first, '.git') } })
  })

  it('unknown, with why, for a damaged or unsupported .jj, before asking jj', async () => {
    const s = stub({})
    const noRepo = tempDir('jjd-norepo-')
    mkdirSync(join(noRepo, '.jj'))
    expect(await jjContextOf(noRepo, s)).toMatchObject({ unknown: 'noRepo', root: resolve(noRepo) })
    const empty = tempDir('jjd-empty-')
    mkdirSync(join(empty, '.jj'))
    writeFileSync(join(empty, '.jj', 'repo'), '  ')
    expect(await jjContextOf(empty, s)).toMatchObject({ unknown: 'emptyPointer' })
    const gone = tempDir('jjd-gone-')
    mkdirSync(join(gone, '.jj'))
    writeFileSync(join(gone, '.jj', 'repo'), join(gone, 'nowhere'))
    expect(await jjContextOf(gone, s)).toMatchObject({ unknown: 'repoGone' })
    const other = tempDir('jjd-backend-')
    workspace(other, '', 'local')
    expect(await jjContextOf(other, s)).toMatchObject({ unknown: 'backend', detail: 'local' })
    const noStore = tempDir('jjd-nostore-')
    workspace(noStore, 'git')
    expect(await jjContextOf(noStore, s)).toMatchObject({ unknown: 'gitStore' })
    expect(s.calls).toEqual([])
  })

  it('unknown when jj can run no command (missing, too old): never facts from its files alone', async () => {
    const root = tempDir('jjd-tool-')
    gitDir(join(root, '.git'))
    workspace(root, '../../../.git')
    const missing = stub({}, { state: 'missing' })
    expect(await jjContextOf(root, missing)).toMatchObject({ unknown: 'tool', tool: { state: 'missing' } })
    expect(await jjContextOf(root, stub({}, { state: 'old', version: '0.40.0' }))).toMatchObject({ unknown: 'tool' })
    // A newer jj runs, but nothing it says is trusted: unknown, and not asked.
    const untested = stub(confirms(root, join(root, '.git')), { state: 'untested', version: '9.0.0', path: 'x' })
    expect(await jjContextOf(root, untested)).toMatchObject({ unknown: 'tool', tool: { state: 'untested' } })
    expect(untested.calls).toEqual([])
    expect(missing.calls).toEqual([])
  })

  it("unknown when jj's answer isn't one (timed out, cancelled, capped), or names another root or store", async () => {
    const root = tempDir('jjd-ask-')
    gitDir(join(root, '.git'))
    workspace(root, '../../../.git')
    const notRun: JjRunResult = { out: '', ok: false, buf: Buffer.alloc(0), err: 'timed out', code: -1, notRun: 'timedOut', timedOut: true }
    expect(await jjContextOf(root, stub({ root: notRun }))).toMatchObject({ unknown: 'notRun', command: ['root'], detail: 'timed out' })
    const cancelled: JjRunResult = { ...notRun, notRun: 'cancelled', timedOut: undefined, cancelled: true }
    expect(await jjContextOf(root, stub({ root: cancelled }))).toMatchObject({ unknown: 'notRun', cancelled: true })
    const elsewhere = tempDir('jjd-elsewhere-')
    expect(await jjContextOf(root, stub({ root: answer(`${elsewhere}\n`), 'git root': answer(join(root, '.git')) }))).toMatchObject({ unknown: 'disagrees', command: ['root'], expected: resolve(root) })
    expect(await jjContextOf(root, stub({ root: answer(root), 'git root': answer(`${elsewhere}\n`) }))).toMatchObject({ unknown: 'disagrees', command: ['git', 'root'] })
    // jj's own "no" (exit 1, not a jj repository) disagrees with its files: unknown too.
    expect(await jjContextOf(root, stub({ root: answer('', 1) }))).toMatchObject({ unknown: 'disagrees' })
  })
})

describe('jj detection: store identity and malformed markers', () => {
  it("a git_target naming a worktree's administrative folder resolves to its common dir: one store, never a second lock", async () => {
    const root = tempDir('jjd-admin-')
    mkdirSync(join(root, '.git', 'worktrees', 'w'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main')
    writeFileSync(join(root, '.git', 'worktrees', 'w', 'HEAD'), 'ref: refs/heads/w')
    writeFileSync(join(root, '.git', 'worktrees', 'w', 'commondir'), '../..')
    workspace(root, '../../../.git/worktrees/w')
    const d = await jjContextOf(root, stub(confirms(root, join(root, '.git'))))
    expect(d).toMatchObject({ jj: { store: resolve(root, '.git') } })
  })

  it('malformed markers are unknown, never followed: a pointer of several lines, one too large, a NUL, a target that is no Git folder', async () => {
    const s = stub({})
    const lines = tempDir('jjd-lines-')
    mkdirSync(join(lines, '.jj'))
    writeFileSync(join(lines, '.jj', 'repo'), `${join(lines, 'one')}\n${join(lines, 'two')}`)
    expect(await jjContextOf(lines, s)).toMatchObject({ unknown: 'emptyPointer' })
    const big = tempDir('jjd-big-')
    mkdirSync(join(big, '.jj'))
    writeFileSync(join(big, '.jj', 'repo'), 'x'.repeat(5000))
    expect(await jjContextOf(big, s)).toMatchObject({ unknown: 'emptyPointer' })
    const nul = tempDir('jjd-nul-')
    mkdirSync(join(nul, '.jj'))
    writeFileSync(join(nul, '.jj', 'repo'), `${join(nul, 'a')}\u0000b`)
    expect(await jjContextOf(nul, s)).toMatchObject({ unknown: 'emptyPointer' })
    const notGit = tempDir('jjd-notgit-')
    mkdirSync(join(notGit, 'plain'))
    workspace(notGit, '../../../plain')
    expect(await jjContextOf(notGit, s)).toMatchObject({ unknown: 'gitStore' })
    expect(s.calls).toEqual([])
  })
})
