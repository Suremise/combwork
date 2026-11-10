// jj's compatibility cases J7 finished (HI-2800; SPEC §16.3.6, jj's recovery, agents and compatibility), with no jj:
// `.jj` is a platform's own folder whatever the project's platform (hidden from the Files tab's lists, search's walk,
// the document tools and None's deliverables), and Repair after a moved `.combwork` folder leaves a jj workspace's git
// worktree as it is. The real-jj cases (the non-colocated keep-out, trust) are tests/jjCompat7Real.test.ts.
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { inMetadataDir, METADATA_DIRS } from '../src/shared/platform/metadataDirs'
import { repoMetadataDirs } from '../src/main/platform/repoPorts'
import { readDoc } from '../src/main/docSections'
import { NoneAdapter } from '../src/main/platform/none'
import { repairWorktrees } from '../src/main/combworkMove'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { gitEnv } = require('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

describe("a platform's own folder, `.jj` among them (HI-2800)", () => {
  it('names .git and .jj, at the root, whatever the project’s platform', () => {
    expect(METADATA_DIRS).toEqual(['.git', '.jj'])
    expect(repoMetadataDirs()).toEqual(expect.arrayContaining(['.git', '.jj']))
    expect(inMetadataDir('.jj')).toBe(true)
    expect(inMetadataDir('.jj/repo/op_heads/heads/x')).toBe(true)
    expect(inMetadataDir('.jj\\working_copy\\checkout')).toBe(true)
    expect(inMetadataDir('.JJ/x')).toBe(false)
    expect(inMetadataDir('.JJ/x', true)).toBe(true)
    expect(inMetadataDir('src/.jj')).toBe(false)
    expect(inMetadataDir('.jjx/a')).toBe(false)
  })

  it('the document tools refuse a file in .jj', async () => {
    const root = tempDir('jj7-doc-')
    mkdirSync(join(root, '.jj'), { recursive: true })
    writeFileSync(join(root, '.jj', 'notes.md'), '# x\n')
    writeFileSync(join(root, 'README.md'), '# readme\n')
    expect(await readDoc(root, '.jj/notes.md')).toEqual({ ok: false, code: 'hidden' })
    expect((await readDoc(root, 'README.md')).ok).toBe(true)
  })

  it("a None project's deliverables leave .jj out (a non-colocated jj repository is a None project)", () => {
    const root = tempDir('jj7-none-')
    mkdirSync(join(root, '.jj', 'repo'), { recursive: true })
    writeFileSync(join(root, '.jj', 'repo', 'type'), 'git\n')
    writeFileSync(join(root, 'a.txt'), 'a\n')
    const files = new NoneAdapter(root).deliverables() as string[]
    expect(files).toEqual(['a.txt'])
  })
})

describe('Repair after a moved .combwork folder leaves a jj workspace’s worktree as it is (HI-2800, gate relocation)', () => {
  it('repairs a plain worktree, not one with a .jj in it', async () => {
    const env = gitEnv()
    const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const base = tempDir('jj7-move-')
    const repo = join(base, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', '-A')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a')
    const old = join(base, 'old')
    git(repo, 'worktree', 'add', '-q', join(old, 'plain'), '-b', 'p')
    git(repo, 'worktree', 'add', '-q', join(old, 'jjws'), '-b', 'j')
    // A jj workspace colocated with Git is a git worktree with a .jj beside its .git.
    mkdirSync(join(old, 'jjws', '.jj'))
    const moved = join(base, 'new')
    renameSync(old, moved)
    const jjGitFile = readFileSync(join(moved, 'jjws', '.git'), 'utf8')
    const n = await repairWorktrees(repo, [{ from: old, to: moved }])
    expect(n).toBe(1)
    expect(git(join(moved, 'plain'), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('p')
    // The jj workspace's git link is untouched (git still names the old place for it).
    expect(readFileSync(join(moved, 'jjws', '.git'), 'utf8')).toBe(jjGitFile)
    expect(git(repo, 'worktree', 'list', '--porcelain')).toMatch(/old[\\/]jjws/)
  })
})
