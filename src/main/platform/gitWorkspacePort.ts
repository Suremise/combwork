// The workspace lifecycle port's Git implementation (SPEC §16.3.6 Port 2, HI-2786's R4): today's code, called through the
// port. Workspaces are git worktrees. Each member runs the git command the slot pool, its card hooks and a 0.9 worktree's
// recreation ran themselves before (or delegates to the module that did: worktrees.ts, platform/git.ts), with the same
// argv, folder, bounds and parsing, so no git command is added, dropped or reordered (tests/slotTraces.test.ts).

import { randomBytes } from 'crypto'
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

/**
 * HI-3010: a hooks folder no hook can be in, for one command: a new name under the folder's `.git` (a worktree's `.git`
 * is a file, so nothing can be under it; a repository's own `.git` has no such random name). Never made.
 */
export const noHooks = (folder: string): string => join(folder, '.git', `combwork-no-hooks-${randomBytes(8).toString('hex')}`)

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
  // HI-3010: the head past `base` first (git's own exit, no words, when it isn't), then the line made where HEAD is now
  // (no start point: a commit meanwhile is on it, and no file changes). Its builder may be at work, so no hook runs
  // (HR1's round 1: a post-checkout or reference-transaction hook can change files): for this command only, hooks are
  // looked for where none can be and fsmonitor is off; the repository's settings are never written.
  // HI-3031: and the commits past the base the lease's own: where HEAD was as the lease began (its reflog, to the second,
  // read at the lease's start's whole second, so a move in that second counts as before it) is the base or behind it. A
  // free slot waits at its last target's head, which can be past the base with another target's commits; no reflog
  // (turned off, expired) is a refusal too.
  branchHere: async (folder, line, base, since) => {
    const past = await git(folder, ['merge-base', '--is-ancestor', base, 'HEAD'])
    // agent-protocol: a log line's detail (slots.ts logs it), never sent to an agent
    if (!past.ok) return { ok: false, err: past.err.trim() || `HEAD isn't at ${base} or past it` } // i18n-ignore: a log line's detail, never shown
    const at = Math.floor(Date.parse(since) / 1000)
    const was = Number.isFinite(at) ? await git(folder, ['rev-parse', '--verify', '--quiet', `HEAD@{@${at}}`]) : null
    const wasHash = was?.ok ? was.out.trim() : ''
    // agent-protocol: a log line's detail (slots.ts logs it), never sent to an agent
    if (!wasHash) return { ok: false, err: `HEAD's place as its lease began isn't known` } // i18n-ignore: a log line's detail, never shown
    const own = await git(folder, ['merge-base', '--is-ancestor', wasHash, base])
    // agent-protocol: a log line's detail (slots.ts logs it), never sent to an agent
    if (!own.ok) return { ok: false, err: own.err.trim() || `HEAD was past ${base} before its lease began` } // i18n-ignore: a log line's detail, never shown
    return step(git(folder, ['-c', `core.hooksPath=${noHooks(folder)}`, '-c', 'core.fsmonitor=false', 'switch', '--no-guess', '-c', line]))
  },
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
