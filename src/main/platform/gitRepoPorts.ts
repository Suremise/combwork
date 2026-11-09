// The repository context port's Git implementation (SPEC §16.3.6, HI-2784's R1): today's code, called through the port.
// Each member delegates to the module that did it before (git.ts's git(), gitTool.ts's check, repoLock.ts's locks,
// folderFence.ts's fence, refHold.ts's holds), with the same argv, environment, timeouts, output bounds, lock files and
// lock order: a context is resolved by the same commonGitDir a lock takes, and file reads with no git process for the
// rest, so no git command is added or dropped.

import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { readFile, realpath, stat } from 'original-fs/promises'
import { changingFolder } from '../folderFence'
import { git, gitRouted, withoutGitRoute } from '../git'
import { checkGit, gitProblem, gitTool } from '../gitTool'
import { commonGitDir, inStoreOrder, withLocksInOrder, withRepoLock } from '../repoLock'
import { currentLine, ensureCombworkExcluded, trackedCombworkFiles, untrackCombwork } from './gitKeepOut'
import { fileList, ignoredSet } from './gitFiles'
import { holdRefs } from './refHold'
import { vcsOf } from '../vcsDetect'
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

/** Claude Code's memory folder's base (memoryDir.ts's memoryBase before HI-2789): one rev-parse; its common git folder's parent when that is a `.git`, else the top level. */
async function mainTree(folder: string, o: { timeout: number }): Promise<{ main: string | null } | { none: true } | null> {
  const r = await git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], undefined, undefined, { timeout: o.timeout }).catch(() => null)
  if (!r) return null
  if (!r.ok) return /not a git repository/i.test(r.err) ? { none: true } : null
  const [common, top] = r.out.trim().split(/\r?\n/)
  // The common git folder's parent is the main working tree when it is a `.git` folder; else the top level.
  const main = common && basename(common).toLowerCase() === '.git' ? dirname(common) : top
  return { main: main && isAbsolute(main) ? resolve(main) : null }
}

/** The trust check's root (accounts.ts's resolveTarget before HI-2789): the main working tree, a linked worktree's checked against git's own listing. */
async function trustRoot(folder: string, o: { timeout: number }): Promise<{ root: string | null } | { none: true } | { unknown: true }> {
  const run = (cwd: string, args: string[]) => git(cwd, args, undefined, undefined, { timeout: o.timeout }).catch(() => null)
  const r = await run(folder, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'])
  // Not a repository (git says so); anything else (a bare repository, a timeout, git missing) can't be told.
  if (!r?.ok) return r && /not a git repository/i.test(r.err) ? { none: true } : { unknown: true }
  const [gitDir, common, top] = r.out.trim().split(/\r?\n/)
  const same = (a?: string, b?: string): boolean => !!a && !!b && resolve(a).toLowerCase() === resolve(b).toLowerCase()
  // In the main working tree (its git folder the common one, wherever that is kept): its top level.
  let tree: string | undefined = same(gitDir, common) ? top : undefined
  if (!tree) {
    // A linked worktree: the main working tree, as git lists it first, checked to be one (not a git folder).
    const worktrees = await run(folder, ['worktree', 'list', '--porcelain'])
    const first = worktrees?.ok ? worktrees.out.split(/\r?\n\r?\n/)[0].split(/\r?\n/) : []
    const listed = first.includes('bare') ? undefined : first.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
    const check = listed ? await run(listed, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']) : null
    const [itsCommon, itsTop] = check?.ok ? check.out.trim().split(/\r?\n/) : []
    if (same(itsCommon, common) && same(itsTop, listed)) tree = itsTop
  }
  return { root: tree ?? null }
}

/** The repository's info/exclude (providers/common.ts's excludeCopies before HI-2789): in the common git dir git names. */
async function excludeFile(folder: string, o: { timeout: number }): Promise<string | null> {
  const common = await git(folder, ['rev-parse', '--git-common-dir'], undefined, undefined, { timeout: o.timeout })
  const gitDir = common.ok ? common.out.trim() : ''
  if (!gitDir) return null
  return join(isAbsolute(gitDir) ? gitDir : resolve(folder, gitDir), 'info', 'exclude')
}

export const gitRepoPorts: RepoPorts = {
  platform: 'git',
  tool: 'Git', // i18n-ignore: a product's name
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
  metadataDirs: ['.git'],
  mainTree,
  trustRoot,
  excludeFile,
  keepOut: {
    holds: (projectPath) => vcsOf(projectPath)?.kind === 'git',
    ensure: (projectPath, opts) => ensureCombworkExcluded(projectPath, opts),
    tracked: (projectPath, root, opts) => trackedCombworkFiles(projectPath, root, opts),
    untrack: (projectPath, confirmed) => untrackCombwork(projectPath, confirmed)
  },
  currentLine,
  files: { ignored: ignoredSet, list: fileList }
}
