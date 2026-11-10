// The workspace lifecycle port's Git implementation (SPEC §16.3.6 Port 2, HI-2786's R4): today's code, called through the
// port. Workspaces are git worktrees. Each member runs the git command the slot pool, its card hooks and a 0.9 worktree's
// recreation ran themselves before (or delegates to the module that did: worktrees.ts, platform/git.ts), with the same
// argv, folder, bounds and parsing, so no git command is added, dropped or reordered (tests/slotTraces.test.ts).

import { dirname, join, resolve } from 'path'
import { readFile } from 'original-fs/promises'
import { git, gitErrorLine } from '../git'
import { copyIgnored, createWorktree, currentBranch, listWorktreesOrNull } from '../worktrees'
import * as G from './git'
import { gitRelocation } from './gitRelocation'
import { GIT_FILES_TITLE, gitFilesNeeded, gitFilesStatus, gitReads, prepareGitFiles, SKIP_SMUDGE } from './gitModules'
import { gitFilesExec } from './gitModulesRun'
import type { CheckoutOptions, WorkspacePort, WorkspaceStep } from './workspacePort'

/** A git command's answer as a step's: done, or git's own words. */
const step = async (r: Promise<{ ok: boolean; err: string }>): Promise<WorkspaceStep> => {
  const { ok, err } = await r
  return { ok, err }
}

/**
 * The worktree entries `git worktree prune` would remove (their folders are missing), by the path each was at. Pruning
 * drops git's link to a worktree, which a moved one still needs to be repaired, so callers prune only when it would remove
 * nothing but the entries being recreated.
 */
async function prunable(repo: string): Promise<string[]> {
  const r = await git(repo, ['worktree', 'prune', '--dry-run', '--verbose'])
  if (!r.ok) return []
  const common = (await git(repo, ['rev-parse', '--git-common-dir'])).out.trim()
  const out: string[] = []
  for (const m of `${r.out}\n${r.err}`.matchAll(/^Removing worktrees\/([^:]+):/gm)) {
    const gitdir = await readFile(join(resolve(repo, common), 'worktrees', m[1], 'gitdir'), 'utf8').catch(() => '')
    out.push(gitdir.trim() ? dirname(resolve(gitdir.trim())) : `(${m[1]})`)
  }
  return out
}

/** HI-1182: a checkout's options for git: with `skipSmudge`, git-lfs's smudge left out (GIT_LFS_SKIP_SMUDGE, this process only), else as before. */
const smudge = (o?: CheckoutOptions): { env?: NodeJS.ProcessEnv } => (o?.skipSmudge ? { env: { ...process.env, ...SKIP_SMUDGE } } : {})

export const gitWorkspacePort: WorkspacePort = {
  platform: 'git',
  list: async (repo) => (await listWorktreesOrNull(repo))?.map((w) => ({ path: w.path, line: w.branch })) ?? null,
  head: (folder) => G.head(folder),
  line: (folder) => G.branch(folder),
  shownLine: async (folder) => {
    const on = await git(folder, ['branch', '--show-current'])
    return on.ok ? on.out.trim() : null
  },
  currentLine: (repo) => currentBranch(repo),
  checkout: (folder) => G.headSync(folder),
  heads: (folder, target) => G.heads(folder, target),
  dirty: (folder) => G.dirty(folder),
  lineHead: (repo, line) => G.lineHead(repo, line),
  defaultLine: (repo) => G.defaultBranch(repo),
  lineExists: async (repo, line) => (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${line}`])).ok,
  prunable,
  create: (repo, folder, at, o) => step(git(repo, ['worktree', 'add', '--detach', folder, at], undefined, undefined, smudge(o))),
  attach: (repo, folder, line) => step(git(repo, ['worktree', 'add', folder, line])),
  createOnNewLine: (repo, folder, line, base) => createWorktree(repo, folder, line, base),
  copyIgnored: (repo, folder, patterns) => copyIgnored(repo, folder, patterns),
  files: { title: GIT_FILES_TITLE, needed: (folder, disposable) => gitFilesNeeded(gitReads, folder, disposable), prepare: prepareGitFiles, exec: gitFilesExec, status: (folder) => gitFilesStatus(gitReads, folder) },
  prune: async (repo) => void (await git(repo, ['worktree', 'prune'])),
  prepare: (folder, line, base, o) => step(git(folder, base === null ? ['switch', '--no-guess', line] : ['switch', '--no-guess', '-c', line, base], undefined, undefined, smudge(o))),
  detach: (folder, revision, o) => step(git(folder, o?.quiet ? ['switch', '-q', '--detach', revision] : ['switch', '--detach', revision])),
  resetTo: async (folder, revision, o) => {
    const co = await git(folder, ['checkout', '--detach', '--force', revision], undefined, undefined, smudge(o))
    if (!co.ok) return { ok: false, failed: 'checkout', err: co.err }
    const cl = await git(folder, ['clean', '-fd'])
    return cl.ok ? { ok: true } : { ok: false, failed: 'clean', err: cl.err }
  },
  remove: (repo, folder, o) => step(git(repo, o?.force ? ['worktree', 'remove', '--force', folder] : ['worktree', 'remove', folder])),
  dropLine: (repo, line, at) => step(git(repo, ['update-ref', '-d', `refs/heads/${line}`, at])),
  restoreLine: (repo, line, revision) => step(git(repo, ['update-ref', `refs/heads/${line}`, revision, ''])),
  errorLine: gitErrorLine,
  relocate: gitRelocation
}
