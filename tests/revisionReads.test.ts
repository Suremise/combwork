// HI-3218: a card's revision diff through the revision reads port, on real Git: one file from a
// submission's base to its revision, from commits only (never the working copy), with an added, a deleted, a binary and
// an over-limit file, and (Git) a gitlink.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { revisionReadsOf } from '../src/main/platform/revisionReadsPorts'
import { MAX_DIFF_BYTES } from '../src/main/git'

// The fixtures' git (HR1's round 2): the run context's allowlist, a global config of the test's own and no system config,
// never the shell's environment or the machine's git settings (signing, hooks, filters, GIT_* overrides).
const runContext = createRequire(import.meta.url)('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv; writeGitConfig: (file: string) => void }
const gitConfigFile = join(tempDir('cw-revdiff-gitconfig-'), 'gitconfig')
runContext.writeGitConfig(gitConfigFile)
const GIT_ENV = runContext.gitEnv({ GIT_CONFIG_GLOBAL: gitConfigFile })
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', env: GIT_ENV }).trim()
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

  it("a file the revision's tree lists whose blob can't be read is an error, never an empty side (HR1, round 1)", async () => {
    const r = join(tempDir('cw-revdiff-missing-'), 'p')
    mkdirSync(r, { recursive: true })
    git(r, 'init', '-q', '-b', 'main')
    writeFileSync(join(r, 'a.txt'), 'one\n')
    writeFileSync(join(r, 'b.txt'), 'kept\n')
    git(r, 'add', '-A')
    git(r, 'commit', '-q', '-m', 'base')
    const base = git(r, 'rev-parse', 'HEAD')
    // The revision's tree names a blob for a.txt that the store doesn't have; b.txt as it was.
    const entries = git(r, 'ls-tree', base).split('\n').map((l) => (l.endsWith('\ta.txt') ? l.replace(/blob [0-9a-f]{40}/, `blob ${'d'.repeat(40)}`) : l))
    const tree = execFileSync('git', ['mktree', '--missing'], { cwd: r, input: entries.join('\n') + '\n', encoding: 'utf8', env: GIT_ENV }).trim()
    const revision = git(r, 'commit-tree', tree, '-p', base, '-m', 'revision')
    expect(git(r, 'diff', '--raw', '--no-ext-diff', base, revision, '--', 'a.txt')).toMatch(/M\ta\.txt$/)
    await expect(reads.fileDiff(r, base, revision, 'a.txt')).rejects.toThrow(/cat-file/)
    // A file the tree doesn't list is still empty on that side, not an error.
    writeFileSync(join(r, 'c.txt'), 'new\n')
    git(r, 'add', 'c.txt')
    git(r, 'commit', '-q', '-m', 'add c')
    const withC = git(r, 'rev-parse', 'HEAD')
    expect(await reads.fileDiff(r, base, withC, 'c.txt')).toEqual({ path: 'c.txt', original: '', modified: 'new\n', binary: false })
  })
})
