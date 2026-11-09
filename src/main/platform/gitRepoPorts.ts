// The repository context port's Git implementation (SPEC §16.3.6, HI-2784's R1): today's code, called through the port.
// Each member delegates to the module that did it before (git.ts's git(), gitTool.ts's check, repoLock.ts's locks,
// folderFence.ts's fence, refHold.ts's holds), with the same argv, environment, timeouts, output bounds, lock files and
// lock order: a context is resolved by the same commonGitDir a lock takes, and file reads with no git process for the
// rest, so no git command is added or dropped.

import { dirname, join, resolve } from 'path'
import { readFile, realpath, stat } from 'original-fs/promises'
import { changingFolder } from '../folderFence'
import { git, gitRouted, withoutGitRoute } from '../git'
import { checkGit, gitProblem, gitTool } from '../gitTool'
import { commonGitDir, inStoreOrder, withLocksInOrder, withRepoLock } from '../repoLock'
import { holdRefs } from './refHold'
import type { RepoContext, RepoPorts } from './repoContext'

/** Whether `path` exists, as stat says (async: no file system call on main's thread blocks). */
const kind = async (path: string): Promise<'dir' | 'file' | null> => {
  try {
    return (await stat(path)).isDirectory() ? 'dir' : 'file'
  } catch {
    return null
  }
}

/** The working folder's top holding `folder`: the nearest folder at or above it with a `.git`, as detection finds it (§16.3.5). */
async function rootOf(folder: string): Promise<string | null> {
  let dir = resolve(folder)
  for (;;) {
    if (await kind(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** A working folder's own git dir, real: its `.git` folder, or the git dir a linked worktree's `.git` file names; null where unreadable. */
async function ownGitDir(root: string): Promise<string | null> {
  const dot = join(root, '.git')
  try {
    const own = (await kind(dot)) === 'dir' ? dot : /^gitdir: (.+)$/m.exec(await readFile(dot, 'utf8'))?.[1]?.trim()
    if (!own) return null
    const abs = resolve(root, own)
    return await realpath(abs).catch(() => abs)
  } catch {
    return null
  }
}

/**
 * The Git context of `folder`'s repository: its store is the common git dir commonGitDir names (withRepoLock's, so the
 * port's lock is the same row), null where git can't name one (no repository: a folder withRepoLocks skips).
 */
async function contextOf(folder: string): Promise<RepoContext | null> {
  const store = await commonGitDir(folder).catch(() => null)
  if (!store) return null
  const root = (await rootOf(folder)) ?? resolve(folder)
  const workspace = (await ownGitDir(root)) ?? store
  return { platform: 'git', store, workspace, root, folder, ...(resolve(root) !== resolve(folder) ? { subfolder: true } : {}) }
}

export const gitRepoPorts: RepoPorts = {
  platform: 'git',
  contextOf,
  runner: {
    run: (ctx, args, o = {}) => git(ctx.folder, [...args], o.maxOutput, o.input, { ...(o.env ? { env: o.env } : {}), ...(o.timeout ? { timeout: o.timeout } : {}) }),
    readiness: checkGit,
    readinessNow: gitTool,
    problem: gitProblem,
    routed: gitRouted,
    withoutRoute: withoutGitRoute
  },
  locks: {
    withRepoLock: (ctx, fn, o) => withRepoLock(ctx.folder, fn, o),
    withRepoLocks: (ctxs, fn, o) => withLocksInOrder(inStoreOrder(ctxs), fn, o),
    changingFolder: (ctx, what, fn) => changingFolder(ctx.folder, what, fn),
    holdRefs: (ctx, refs, o) => holdRefs(ctx.folder, refs, o)
  },
  metadataDirs: ['.git']
}
