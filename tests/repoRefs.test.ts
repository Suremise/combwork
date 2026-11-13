// HI-3160: the observer's read of a repository's working folders (repoRefs' foldersOf) resolves a worktree's relative
// gitdir against its entry in .git/worktrees, as Git does, never against the process's own working folder. Git writes a
// relative one with worktree.useRelativePaths (2.48+); jj writes one for a colocated workspace (`../../../../slot-a/.git`,
// its real form is in tests/jjIgnoredWrite.test.ts).
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { readRepoRefs } from '../src/main/platform/repoRefs'
import { tempDir } from './tempDir'

const { gitEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, windowsHide: true, env: gitEnv(), encoding: 'utf8' })

/** A repository with one commit, in a new folder: its parent and its own folder. */
function repo(): { parent: string; project: string } {
  const parent = realpathSync.native(tempDir('cw-reporefs-'))
  const project = join(parent, 'project')
  mkdirSync(project)
  git(project, 'init', '-q')
  git(project, 'commit', '-q', '--allow-empty', '-m', 'first')
  return { parent, project }
}

const listed = (project: string): string[] => readRepoRefs(join(project, '.git'), 100).folders.map((f) => resolve(f.folder).toLowerCase())

describe("HI-3160: a worktree's relative gitdir", () => {
  it("Git's (worktree.useRelativePaths): the worktree is listed, at its own folder", () => {
    const { parent, project } = repo()
    const wt = join(parent, 'wt-a')
    git(project, '-c', 'worktree.useRelativePaths=true', 'worktree', 'add', '-q', '-b', 'a', wt)
    const gitdir = readFileSync(join(project, '.git', 'worktrees', 'wt-a', 'gitdir'), 'utf8').trim()
    expect(isAbsolute(gitdir)).toBe(false)
    expect(listed(project)).toEqual([project, wt].map((p) => resolve(p).toLowerCase()))
  })

  it("jj's (a colocated workspace's registration): the slot is listed, at its own folder", () => {
    const { parent, project } = repo()
    // As `jj workspace add --colocate` registers a slot beside the project: an entry whose gitdir is relative to it.
    const slot = join(parent, 'slot-a')
    mkdirSync(slot)
    const entry = join(project, '.git', 'worktrees', 'slot-a')
    mkdirSync(entry, { recursive: true })
    writeFileSync(join(entry, 'gitdir'), '../../../../slot-a/.git\n')
    writeFileSync(join(entry, 'commondir'), '../..\n')
    writeFileSync(join(entry, 'HEAD'), git(project, 'rev-parse', 'HEAD'))
    writeFileSync(join(slot, '.git'), `gitdir: ${entry}\n`)
    expect(listed(project)).toEqual([project, slot].map((p) => resolve(p).toLowerCase()))
  })
})
