// HI-3218: a card's revision diff through the revision reads port, on real Git and the pinned real jj: one file from a
// submission's base to its revision, from commits only (never the working copy), with an added, a deleted, a binary and
// an over-limit file, and (Git) a gitlink.
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { revisionReadsOf } from '../src/main/platform/revisionReadsPorts'
import { jjRevisionReadsWith } from '../src/main/platform/jjRevisionReads'
import { MAX_DIFF_BYTES } from '../src/main/git'
import { harness, jjExe } from './jjWorkspaceHarness'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim()
const BIG = 'x'.repeat(MAX_DIFF_BYTES + 10)

describe('Git: a submission file from its base to its revision (HI-3218)', () => {
  const reads = revisionReadsOf('git')!

  it('reads both sides from the commits, never the working tree', async () => {
    const r = join(tempDir('cw-revdiff-'), 'p')
    mkdirSync(r, { recursive: true })
    git(r, 'init', '-q', '-b', 'main')
    writeFileSync(join(r, 'a.txt'), 'one\n')
    writeFileSync(join(r, 'gone.txt'), 'bye\n')
    git(r, 'add', '-A')
    git(r, 'commit', '-q', '-m', 'base')
    const base = git(r, 'rev-parse', 'HEAD')
    writeFileSync(join(r, 'a.txt'), 'two\n')
    writeFileSync(join(r, 'new.txt'), 'hello\n')
    writeFileSync(join(r, 'bin.dat'), Buffer.from([1, 0, 2, 0]))
    writeFileSync(join(r, 'big.txt'), BIG)
    git(r, 'rm', '-q', 'gone.txt')
    git(r, 'add', '-A')
    // A gitlink: a submodule entry by its mode alone.
    git(r, 'update-index', '--add', '--cacheinfo', `160000,${base},sub`)
    git(r, 'commit', '-q', '-m', 'revision')
    const revision = git(r, 'rev-parse', 'HEAD')
    // The working tree moves on: never what is read.
    writeFileSync(join(r, 'a.txt'), 'three, uncommitted\n')

    expect(await reads.fileDiff(r, base, revision, 'a.txt')).toEqual({ path: 'a.txt', original: 'one\n', modified: 'two\n', binary: false })
    expect(await reads.fileDiff(r, base, revision, 'new.txt')).toEqual({ path: 'new.txt', original: '', modified: 'hello\n', binary: false })
    expect(await reads.fileDiff(r, base, revision, 'gone.txt')).toEqual({ path: 'gone.txt', original: 'bye\n', modified: '', binary: false })
    expect(await reads.fileDiff(r, base, revision, 'bin.dat')).toMatchObject({ path: 'bin.dat', binary: true, original: '', modified: '' })
    const big = await reads.fileDiff(r, base, revision, 'big.txt')
    expect(big).toMatchObject({ path: 'big.txt', binary: true, original: '' })
    expect(big.modified).not.toBe('')
    const link = await reads.fileDiff(r, base, revision, 'sub')
    expect(link.gitlink?.to).toMatchObject({ kind: 'gitlink', commit: base })
  })
})

describe.skipIf(!jjExe)('jj: a submission file from its base to its revision (HI-3218)', () => {
  it('reads both sides with jj file show, never the working copy; a file not there is empty, a large one said', async () => {
    const h = harness()
    const { repo: d } = h.repo('revdiff', false)
    writeFileSync(join(d, 'a.txt'), 'one\n')
    writeFileSync(join(d, 'gone.txt'), 'bye\n')
    h.jj(d, 'commit', '-m', 'base')
    const base = h.jj(d, 'log', '--no-graph', '-r', '@-', '-T', 'commit_id').trim()
    writeFileSync(join(d, 'a.txt'), 'two\n')
    writeFileSync(join(d, 'new.txt'), 'hello\n')
    writeFileSync(join(d, 'bin.dat'), Buffer.from([1, 0, 2, 0]))
    writeFileSync(join(d, 'big.txt'), BIG)
    rmSync(join(d, 'gone.txt'))
    // jj snapshots no new file over 1 MiB by default: this one is let in, so the revision has it.
    h.jj(d, '--config', 'snapshot.max-new-file-size=16MiB', 'commit', '-m', 'revision')
    const revision = h.jj(d, 'log', '--no-graph', '-r', '@-', '-T', 'commit_id').trim()
    writeFileSync(join(d, 'a.txt'), 'three, uncommitted\n')

    const reads = jjRevisionReadsWith(h.runner)
    expect(await reads.fileDiff(d, base, revision, 'a.txt')).toEqual({ path: 'a.txt', original: 'one\n', modified: 'two\n', binary: false })
    expect(await reads.fileDiff(d, base, revision, 'new.txt')).toEqual({ path: 'new.txt', original: '', modified: 'hello\n', binary: false })
    expect(await reads.fileDiff(d, base, revision, 'gone.txt')).toEqual({ path: 'gone.txt', original: 'bye\n', modified: '', binary: false })
    expect(await reads.fileDiff(d, base, revision, 'bin.dat')).toMatchObject({ path: 'bin.dat', binary: true })
    expect(await reads.fileDiff(d, base, revision, 'big.txt')).toMatchObject({ path: 'big.txt', binary: true, original: '' })
    // A commit jj doesn't have is an error, never an empty side.
    await expect(reads.fileDiff(d, base, 'f'.repeat(40), 'a.txt')).rejects.toThrow()
  }, 60000)
})
