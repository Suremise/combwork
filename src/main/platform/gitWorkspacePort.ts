// The workspace lifecycle port's Git implementation (SPEC §16.3.6 Port 2, HI-2786's R4): today's code, called through the
// port. Workspaces are git worktrees. Each member runs the git command the slot pool, its card hooks and a 0.9 worktree's
// recreation ran themselves before (or delegates to the module that did: worktrees.ts, platform/git.ts), with the same
// argv, folder, bounds and parsing, so no git command is added, dropped or reordered (tests/slotTraces.test.ts).

import { randomBytes } from 'crypto'
import { dirname, join, resolve } from 'path'
import { existsSync, renameSync } from 'original-fs'
import { readFile, rm as removeTree } from 'original-fs/promises'
import { git, gitErrorLine } from '../git'
import { copyIgnored, createWorktree, currentBranch, listWorktreesOrNull } from '../worktrees'
import * as G from './git'
import { gitRelocation } from './gitRelocation'
import { clearSubmoduleCheckouts, GIT_FILES_TITLE, gitFilesNeeded, gitFilesStatus, gitReads, hasPrivateModules, prepareGitFiles, SKIP_SMUDGE, submoduleWorkKept } from './gitModules'
import { gitFilesExec } from './gitModulesRun'
import { asideOf, entryIdSync, linksTo, provedSync, worktreesOf, type GitLinkReceipt } from './jjGitLink'
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
    const entry = join(resolve(repo, common), 'worktrees', m[1])
    const gitdir = await readFile(join(entry, 'gitdir'), 'utf8').catch(() => '')
    // A relative gitdir (git's worktree.useRelativePaths, or a colocated jj workspace's, HI-3069) is the entry's own.
    out.push(gitdir.trim() ? dirname(resolve(entry, gitdir.trim())) : `(${m[1]})`)
  }
  return out
}

/** Tests: a synchronous step right before a registration is moved aside (dropRegistration), as HI-3046's hooks. */
export const registrationSeams: { beforeAside?: (entry: string) => void } = {}

/**
 * HI-3069: the one registration (`<common>/worktrees/<id>`) whose gitdir names `folder`, dropped while that folder is
 * absent, never by a repository-wide prune (which would also drop another worktree gone meanwhile, needing its
 * registration for Repair). On HI-3046's owned-entry proof (jjGitLink.ts), its receipt taken now: the entry's file id
 * and birth time, `worktrees`' own, its `gitdir` and `commondir` bytes. Proved synchronously (in place, physically in
 * the store, not `locked`, the folder absent: only ENOENT or ENOTDIR counts as absent, any other error as doubt), moved
 * aside out of `worktrees` atomically with nothing awaited between, proved again on what was moved (a reused name, a new
 * entry: other ids), and only then removed. Anything that doesn't prove it is left: put back under its name when what
 * was moved isn't it and the name is free, else left aside, said so. Nothing else is touched.
 */
async function dropRegistration(repo: string, folder: string): Promise<'dropped' | 'none' | { left: string }> {
  const r = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!r.ok) return { left: gitErrorLine(r.err) }
  const store = r.out.trim()
  const links = await linksTo(store, folder)
  // agent-protocol: a log line's detail (slots.ts logs it), never sent to an agent
  if (!links) return { left: 'worktrees unreadable' } // i18n-ignore: a log line's detail, never shown
  if (!links.length) return 'none'
  // agent-protocol: a log line's detail (slots.ts logs it), never sent to an agent
  if (links.length > 1) return { left: `${links.length} registrations name it` } // i18n-ignore: a log line's detail, never shown
  const entry = links[0]
  const [gitdir, commondir] = await Promise.all(['gitdir', 'commondir'].map((f) => readFile(join(entry, f), 'utf8').catch(() => null)))
  const entryId = entryIdSync(entry)
  const worktreesId = entryIdSync(worktreesOf(store))
  // agent-protocol: a log line's detail (slots.ts logs it), never sent to an agent
  if (gitdir === null || commondir === null || !entryId || !worktreesId) return { left: 'unreadable' } // i18n-ignore: a log line's detail, never shown
  const receipt: GitLinkReceipt = { store, folder, workspace: '', generation: '', entry, entryId, worktreesId, gitdir, commondir }
  // Synchronous from here to the move: nothing can be awaited between the proof and the rename.
  const before = provedSync(receipt, entry, 'entry')
  if (before) return { left: before }
  const aside = asideOf(store, randomBytes(8).toString('hex'))
  registrationSeams.beforeAside?.(entry)
  try {
    renameSync(entry, aside)
  } catch (e) {
    return { left: e instanceof Error ? e.message : String(e) }
  }
  const after = provedSync(receipt, aside, 'aside')
  if (after) {
    // What was moved isn't the entry proved (replaced between the proof and the move): back under its name if still free.
    if (!existsSync(entry)) {
      try {
        renameSync(aside, entry)
        return { left: after }
      } catch {
        /* left aside */
      }
    }
    // agent-protocol: a log line's detail (slots.ts logs it), never sent to an agent
    return { left: `${after}, left at ${aside}` } // i18n-ignore: a log line's detail, never shown
  }
  const e = await removeTree(aside, { recursive: true }).then(() => null, (x: Error) => x.message)
  // agent-protocol: a log line's detail (slots.ts logs it), never sent to an agent
  return e ? { left: `${e}, left at ${aside}` } : 'dropped' // i18n-ignore: a log line's detail, never shown
}

/** HI-1182: a checkout's options for git: with `skipSmudge`, git-lfs's smudge left out (GIT_LFS_SKIP_SMUDGE, this process only), else as before. */
const smudge = (o?: CheckoutOptions): { env?: NodeJS.ProcessEnv } => (o?.skipSmudge ? { env: { ...process.env, ...SKIP_SMUDGE } } : {})

/**
 * HI-3010: a hooks folder no hook can be in, for one command: a new name under the folder's `.git` (a worktree's `.git`
 * is a file, so nothing can be under it; a repository's own `.git` has no such random name). Never made.
 */
export const noHooks = (folder: string): string => join(folder, '.git', `combwork-no-hooks-${randomBytes(8).toString('hex')}`)

/**
 * HI-3078: a slot's own submodule checkouts that `revision` doesn't keep as submodules (vendored into ordinary files
 * there, or gone) removed before it moves there, as a copy's and the queue's folder's are (HI-3027, HI-3028): git's
 * switch leaves such a folder where it is, so the switch refuses over its files, or leaves it untracked with its `.git`
 * file. A slot is someone's work folder, so a checkout with a change or an untracked file is left for git to name; its
 * clone stays. Only a worktree whose own git dir holds clones (`modules`, an fs read): with none, or no `.git` file
 * naming a git dir, no git runs for it and nothing is removed.
 */
async function clearSlotSubmodules(folder: string, revision: string): Promise<string | null> {
  if ((await hasPrivateModules(folder)) !== true) return null
  return clearSubmoduleCheckouts(gitReads, folder, [revision], { keepChanged: true })
}

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
  dropRegistration,
  prepare: async (folder, line, base, o) => {
    const cleared = await clearSlotSubmodules(folder, base ?? `refs/heads/${line}`)
    if (cleared) return { ok: false, err: cleared }
    return step(git(folder, base === null ? ['switch', '--no-guess', line] : ['switch', '--no-guess', '-c', line, base], undefined, undefined, smudge(o)))
  },
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
  detach: async (folder, revision, o) => {
    const cleared = await clearSlotSubmodules(folder, revision)
    if (cleared) return { ok: false, err: cleared }
    return step(git(folder, o?.quiet ? ['switch', '-q', '--detach', revision] : ['switch', '--detach', revision]))
  },
  // HI-3028: a copy's own submodule checkouts the revision doesn't keep as submodules removed first (their clones stay):
  // a forced checkout writes ordinary files into such a folder and `clean -fd` leaves its `.git` file, so git run in it
  // would see the old clone as its repository. A failure is the checkout's, with its words. A copy with no clones (its git
  // dir has no `modules`, an fs read) runs no git for it.
  resetTo: async (folder, revision, o) => {
    const cleared = (await hasPrivateModules(folder)) === false ? null : await clearSubmoduleCheckouts(gitReads, folder, [revision])
    if (cleared) return { ok: false, failed: 'checkout', err: cleared }
    const co = await git(folder, ['checkout', '--detach', '--force', revision], undefined, undefined, smudge(o))
    if (!co.ok) return { ok: false, failed: 'checkout', err: co.err }
    const cl = await git(folder, ['clean', '-fd'])
    return cl.ok ? { ok: true } : { ok: false, failed: 'clean', err: cl.err }
  },
  // HI-3026: git refuses any unforced removal of a worktree holding submodule clones (`<gitdir>/modules`, made by the
  // files step). Such a worktree is removed forced only once git's own clean check, made here as git would, and every
  // clone holding nothing a remote lacks say it loses nothing; else refused, saying why. Without clones, as before.
  remove: async (repo, folder, o) => {
    if (o?.force) return step(git(repo, ['worktree', 'remove', '--force', folder]))
    if ((await hasPrivateModules(folder)) !== true) return step(git(repo, ['worktree', 'remove', folder]))
    const kept = await submoduleWorkKept(gitReads, folder)
    return kept ? { ok: false, err: kept } : step(git(repo, ['worktree', 'remove', '--force', folder]))
  },
  dropLine: (repo, line, at) => step(git(repo, ['update-ref', '-d', `refs/heads/${line}`, at])),
  restoreLine: (repo, line, revision) => step(git(repo, ['update-ref', `refs/heads/${line}`, revision, ''])),
  errorLine: gitErrorLine,
  relocate: gitRelocation
}
