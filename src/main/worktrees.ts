import { basename, dirname, join, resolve } from 'path'
import { copyFile, mkdir } from 'original-fs/promises'
import { existsSync } from 'original-fs'
import type { AgentBranchStatus, MergeResult, WorktreeCheck } from '../shared/types'

/** A worktree with its branch and the branch it was made from: an agent's 0.9 one, or an unused one (#1452: no longer `WorktreeRef`). */
export interface WorktreeRef {
  path: string
  branch: string
  base: string
}
import type { TextPart } from '../shared/advanced'
import { fmt, msg, tr } from '../shared/i18n'
import { gitProblemData, gitProblemText } from '../shared/gitTool'
import { copyDir, isDir, placeKey, samePlace } from './fsutil'
import { branchOfRef, git, gitReading } from './git'
import { gitTool } from './gitTool'
import { errorText, combworkError, shownError } from './combworkError'
import { createLogger, userText } from './logger'
import { unwatchedWhile } from './platform/observe'
import { CW_DIR } from '../shared/defaults'

const log = createLogger('worktrees')

/**
 * What git and worktrees say (#848, E10d of #677). Errors thrown here reach the window (IPC) and agents (the Agent API's
 * add agent) alike: CombworkErrors, English for agents and in the window's language for the window. A reason or a merge's
 * error returned as data is the window's alone (a removal, a check, a merge): formatted with tr() when it is made. Git's
 * own words stay as git said them, in either.
 */
const M = {
  noTarget: msg({ id: 'worktrees.merge.noTarget', defaultMessage: 'There is no branch {branch} to merge into.', description: 'Why nothing was merged: the branch to merge into ({branch}) does not exist.' }),
  caseAlias: msg({ id: 'worktrees.merge.caseAlias', defaultMessage: "The branches {branch} and {other} differ only in case, which Windows can't tell apart, so nothing was merged. Rename one of them, then merge.", description: 'Why nothing was merged: two branches ({branch}, {other}) have names that differ only in upper and lower case, and Windows treats them as one.' }),
  nothingMerged: msg({ id: 'worktrees.merge.nothing', defaultMessage: 'Nothing was merged: {why}.', description: "Why nothing was merged: git couldn't read the project folder's branch, or failed while merging. {why} says why (git's message)." }),
  gitFailed: msg({ id: 'worktrees.gitFailed', defaultMessage: '{command} failed', description: "Why git couldn't do something, when git said nothing itself. {command} is the git command (\"git rev-parse\"): keep it as it is." }),
  gitProblem: msg({ id: 'worktrees.gitProblem', defaultMessage: '{problem}.', description: 'An error: git cannot run. {problem} says why (git is missing, or too old), without its full stop.' }),
  readBranch: msg({ id: 'worktrees.readBranch', defaultMessage: "git couldn't read the branch checked out in {folder} ({why})", description: "An error: git couldn't say which branch the folder {folder} has checked out; {why} is git's reason." }),
  listBranches: msg({ id: 'worktrees.listBranches', defaultMessage: "git couldn't list the branches ({why})", description: "An error: git couldn't list the repository's branches; {why} is git's reason." }),
  readOriginHead: msg({ id: 'worktrees.readOriginHead', defaultMessage: "git couldn't read origin/HEAD ({why})", description: "An error: git couldn't read which branch is the remote's main branch (origin/HEAD, git's name: keep it); {why} is git's reason." }),
  branchInWay: msg({ id: 'worktrees.branchInWay', defaultMessage: "Git can't make the branch {branch}: a branch {parent} is in the way. Choose another branch.", description: "An error: a new branch {branch} can't be made, because a branch {parent} exists and git can't have a branch inside another's name." }),
  badBranchName: msg({ id: 'worktrees.badBranchName', defaultMessage: '"{branch}" is not a valid branch name.', description: "An error: git doesn't take {branch} as a branch name." }),
  deleteBranch: msg({ id: 'worktrees.deleteBranch', defaultMessage: 'Could not delete branch {branch}', description: 'An error: the branch {branch} could not be deleted, and git said nothing about why.' }),
  cantCheck: msg({ id: 'worktrees.cantCheck', defaultMessage: "Git couldn't check {branch}: {why}.", description: "An error: git couldn't count the branch {branch}'s unmerged commits or its worktree's uncommitted files; {why} says why." }),
  statusFailed: msg({ id: 'worktrees.statusFailed', defaultMessage: 'git status failed in its folder', description: "Why git couldn't check a worktree (after \"Git couldn't check <branch>:\"): git status failed in the worktree's folder. Lower case." }),
  unknownError: msg({ id: 'worktrees.unknownError', defaultMessage: 'unknown error', description: "Why git couldn't do something, when nothing at all was said. Lower case: it follows a colon." })
}

/** "<git command> failed", when git said nothing itself. */
export const GIT_FAILED = M.gitFailed

/** Why git couldn't do something: git can't run, else the first line of what it said, else `fallback` (the command that failed). */
const gitWhy = (err: string, command: string): TextPart => gitProblemData(gitTool()) ?? (err.split(/\r?\n/)[0] || { m: M.gitFailed, values: { command } })

/** Git's own message when it gave one, as it came; else Combwork's words that `command` failed. */
const gitError = (err: string, command: string): Error => (err ? new Error(err) : combworkError(M.gitFailed, { command }))

/** Where Combwork creates worktrees: next to the workspace, so the project's own tools don't scan them and they aren't taken for projects. */
export function worktreesRoot(workspacePath: string): string {
  return join(dirname(workspacePath), `${basename(workspacePath)}.worktrees`)
}

/**
 * The branch checked out in a folder, or null when it is detached (git answers "HEAD"). Throws when git can't say
 * (#346): a failed read is not a detached HEAD, which callers deciding what is merged must tell apart. The full ref, cut
 * here: --abbrev-ref would answer heads/main for main when a tag main exists too (HI-2422).
 */
export async function checkedOutBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--symbolic-full-name', 'HEAD'])
  if (!r.ok) throw combworkError(M.readBranch, { folder: cwd, why: gitWhy(r.err, 'git rev-parse') }) // i18n-ignore: a git command, as it is
  const b = r.out.trim()
  return b.startsWith('refs/heads/') ? b.slice('refs/heads/'.length) : null
}

/** The branch checked out in a folder; null when it is detached or git can't say (for choices, never for what is merged). */
export async function currentBranch(cwd: string): Promise<string | null> {
  return checkedOutBranch(cwd).catch(() => null)
}

export async function localBranches(cwd: string): Promise<string[]> {
  return localBranchesStrict(cwd).catch(() => [])
}

/**
 * The local branches; throws when git can't list them (#353: a removal never takes an unknown main branch for none). By
 * their whole refs: `refname:short` says heads/main beside a tag main, and main would be no branch here (HI-2426).
 */
async function localBranchesStrict(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads'])
  if (!r.ok) throw combworkError(M.listBranches, { why: gitWhy(r.err, 'for-each-ref') })
  return r.out.split(/\r?\n/).map((l) => branchOfRef(l)).filter((b): b is string => !!b)
}

/** The project's worktrees (including the project folder itself), from `git worktree list`; none when git can't list them. */
export async function listWorktrees(cwd: string): Promise<{ path: string; branch: string | null }[]> {
  return (await listWorktreesOrNull(cwd)) ?? []
}

/** `listWorktrees`, or null when git can't list them (#734: a failed listing isn't an empty one). */
export async function listWorktreesOrNull(cwd: string): Promise<{ path: string; branch: string | null }[] | null> {
  const r = await git(cwd, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return null
  const out: { path: string; branch: string | null }[] = []
  for (const block of r.out.split(/\r?\n\r?\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (!path) continue
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null
    out.push({ path: resolve(path.trim()), branch: branch?.trim() ?? null })
  }
  return out
}

/**
 * What one operation reads of a project's repository, each read once (#732: a template's plan or load read the same
 * things once per agent): the branch checked out in the project folder, its worktrees, its local branches, its main
 * branch, branches' commits and worktrees' uncommitted files. After the operation makes or removes a worktree or branch
 * itself, `changed()`, so the next read of any of them is fresh; the project folder's branch is kept (nothing Combwork does
 * there moves it). A read that fails isn't kept: the next asks git again. Functions that take one read afresh without it.
 */
export class RepoReads {
  private readonly memo = new Map<string, Promise<unknown>>()
  constructor(readonly projectPath: string) {}

  /** `failed`: an answer that says git couldn't read it (null), not kept either. */
  private once<T>(key: string, read: () => Promise<T>, failed?: (v: T) => boolean): Promise<T> {
    const kept = this.memo.get(key) as Promise<T> | undefined
    if (kept) return kept
    const p = read()
    this.memo.set(key, p)
    const forget = (): void => void (this.memo.get(key) === p && this.memo.delete(key))
    p.then((v) => (failed?.(v) ? forget() : undefined), forget)
    return p
  }

  /** `checkedOutBranch` of the project folder: throws when git can't say. */
  checkedOutBranch(): Promise<string | null> {
    return this.once('head', () => checkedOutBranch(this.projectPath))
  }

  /** `currentBranch` of the project folder: null when it is detached or git can't say. */
  currentBranch(): Promise<string | null> {
    return this.checkedOutBranch().catch(() => null)
  }

  /** `listWorktrees`: none when git can't list them, a failure that isn't kept (#734). */
  worktrees(): Promise<{ path: string; branch: string | null }[]> {
    return this.once('worktrees', () => listWorktreesOrNull(this.projectPath), (v) => v === null).then((v) => v ?? [])
  }

  /** The local branches; throws when git can't list them. */
  branchesStrict(): Promise<string[]> {
    return this.once('branches', () => localBranchesStrict(this.projectPath))
  }

  /** `primaryBranchStrict`. */
  primaryBranchStrict(): Promise<string | null> {
    return this.once('primary', () => primaryBranchStrict(this.projectPath, this))
  }

  /** `tipOf` a branch. */
  tip(branch: string): Promise<string | null> {
    return this.once(`tip ${branch}`, () => tipOf(this.projectPath, branch), (v) => v === null)
  }

  /** `dirtyCount` of a worktree's folder. */
  dirty(path: string): Promise<number | null> {
    return this.once(`dirty ${placeKey(path)}`, () => dirtyCount(path), (v) => v === null)
  }

  /** The operation made or removed a worktree or branch: everything but the project folder's branch is read again. */
  changed(): void {
    for (const k of [...this.memo.keys()]) if (k !== 'head') this.memo.delete(k)
  }
}

/**
 * A branch name git can make: wanted, else wanted-2, wanted-3… `taken`: names to avoid too (a plan's earlier ones). Not
 * one that exists, nor one a branch is inside (cw/ws/x while cw/ws/x/y exists), case aside: on Windows git keeps
 * branches as files, so cw/Work/… and cw/work/… would be the same one (#703). A branch it would be inside (cw/ws for
 * cw/ws/alpha/b1) can't be numbered away: refused, saying which (`branchSpace` keeps Combwork's own clear of that).
 */
export async function uniqueBranch(cwd: string, wanted: string, taken: ReadonlySet<string> = new Set(), reads?: RepoReads): Promise<string> {
  const existing = [...new Set([...(await (reads ? reads.branchesStrict().catch(() => []) : localBranches(cwd))), ...taken].map((b) => b.toLowerCase()))]
  const parent = existing.find((b) => wanted.toLowerCase().startsWith(`${b}/`))
  if (parent) throw combworkError(M.branchInWay, { branch: wanted, parent })
  const free = (b: string): boolean => !existing.some((e) => e === b.toLowerCase() || e.startsWith(`${b.toLowerCase()}/`))
  if (free(wanted)) return wanted
  for (let i = 2; ; i++) if (free(`${wanted}-${i}`)) return `${wanted}-${i}`
}

/** A folder that doesn't exist yet: wanted, else wanted-2… `taken`: folders to avoid too, as `placeKey`s (a plan's earlier ones). */
export function uniqueFolder(wanted: string, taken: ReadonlySet<string> = new Set()): string {
  const free = (f: string): boolean => !existsSync(f) && !taken.has(placeKey(f))
  if (free(wanted)) return wanted
  for (let i = 2; ; i++) if (free(`${wanted}-${i}`)) return `${wanted}-${i}`
}

export async function createWorktree(projectPath: string, dest: string, branch: string, base: string): Promise<void> {
  const check = await git(projectPath, ['check-ref-format', '--branch', branch])
  if (!check.ok) {
    const problem = check.missing ? gitProblemData(gitTool()) : null
    throw problem ? combworkError(M.gitProblem, { problem }) : combworkError(M.badBranchName, { branch })
  }
  await mkdir(dirname(dest), { recursive: true })
  const r = await git(projectPath, ['worktree', 'add', '-b', branch, dest, base])
  if (!r.ok) throw gitError(r.err, 'git worktree add') // i18n-ignore: a git command, as it is
  log.info(`Created worktree ${userText(dest)} on ${userText(branch)} from ${userText(base)}`)
}

export async function removeWorktree(projectPath: string, wt: WorktreeRef, deleteBranch: boolean): Promise<void> {
  if (existsSync(wt.path)) {
    const r = await unwatchedWhile([wt.path], () => git(projectPath, ['worktree', 'remove', '--force', wt.path]))
    if (!r.ok) throw gitError(r.err, 'git worktree remove') // i18n-ignore: a git command, as it is
  } else {
    await git(projectPath, ['worktree', 'prune'])
  }
  if (deleteBranch) {
    const b = await git(projectPath, ['branch', '-D', wt.branch])
    if (!b.ok && !/not found/i.test(b.err)) throw b.err ? new Error(b.err) : combworkError(M.deleteBranch, { branch: wt.branch })
  }
  log.info(`Removed worktree ${userText(wt.path)}${deleteBranch ? ` and branch ${userText(wt.branch)}` : ''}`)
}

/** Glob patterns (one per line or comma separated) as regular expressions. A pattern without "/" matches any file or folder name. */
export function copyPatterns(text: string): RegExp[] {
  return text
    .split(/[\n,]/)
    .map((p) => p.trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, ''))
    .filter(Boolean)
    .map((p) => {
      const rx = p
        .split('**')
        .map((part) => part.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
        .join('.*')
      return new RegExp(p.includes('/') ? `^${rx}$` : `(^|/)${rx}$`, 'i')
    })
}

/**
 * Copies git-ignored files matching the patterns (e.g. .env files) from the project folder into a
 * new worktree, which only gets tracked files from git. Returns the copied paths.
 */
export async function copyIgnored(projectPath: string, dest: string, patterns: string): Promise<string[]> {
  const rx = copyPatterns(patterns)
  if (!rx.length) return []
  const r = await git(projectPath, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])
  if (!r.ok) return []
  const copied: string[] = []
  for (const raw of r.out.split('\0').filter(Boolean)) {
    const rel = raw.replace(/\/$/, '')
    if (rel === CW_DIR || rel.startsWith('.combwork/') || !rx.some((x) => x.test(rel))) continue
    const src = join(projectPath, rel)
    const target = join(dest, rel)
    try {
      await mkdir(dirname(target), { recursive: true })
      if (await isDir(src)) await copyDir(src, target)
      else await copyFile(src, target)
      copied.push(rel)
    } catch (e) {
      log.warn(`Could not copy ${userText(rel)} into the worktree`, e)
    }
  }
  return copied
}

/** Uncommitted files in a worktree; null when git can't say (a damaged index, say). */
export async function dirtyCount(cwd: string): Promise<number | null> {
  const r = await gitReading(cwd, ['status', '--porcelain', '-z'])
  return r.ok ? r.out.split('\0').filter((l) => l && !l.slice(3).startsWith('.combwork/')).length : null
}

/**
 * A worktree branch's commits not merged and its uncommitted files. A git command that fails (git missing included)
 * throws, never counting as nothing to merge or nothing to lose (#346).
 */
export async function branchStatus(projectPath: string, wt: WorktreeRef, reads?: RepoReads, target?: string): Promise<AgentBranchStatus> {
  // Detached is a real answer (counted against the base); a failed read isn't, and stops here. A target named (the Merge
  // dialog's branch picked with its target, #1450) is counted against instead of the project folder's branch.
  const into =
    target ??
    (await (reads ?? new RepoReads(projectPath)).checkedOutBranch().catch((e: Error) => {
      throw combworkError(M.cantCheck, { branch: wt.branch, why: errorText(e) }, { cause: e })
    }))
  const count = await git(projectPath, ['rev-list', '--count', `${into ?? wt.base}..${wt.branch}`])
  const dirty = (await isDir(wt.path)) ? await (reads ? reads.dirty(wt.path) : dirtyCount(wt.path)) : 0
  if (!count.ok || dirty === null) {
    throw combworkError(M.cantCheck, { branch: wt.branch, why: gitProblemData(gitTool()) ?? (count.ok ? M.statusFailed : count.err.trim() || M.unknownError) })
  }
  let ahead = parseInt(count.out.trim(), 10) || 0
  if (ahead > 0 && (await alreadyMerged(projectPath, into ?? wt.base, wt.branch))) ahead = 0
  const diff = ahead > 0 || dirty ? await diffSummary(wt.path, ahead > 0 ? (into ?? wt.base) : null) : undefined
  return { branch: wt.branch, base: wt.base, into, ahead, dirty: dirty ?? 0, ...(diff ? { diff } : {}) }
}

/**
 * The repository's main branch, which a worktree must be merged into before Combwork deletes it unasked (#291, #289): the
 * local branch origin/HEAD names, else main, else master. Not the project folder's current branch, which can be any
 * feature branch and change at any time. Null: none of them, or git couldn't say (`primaryBranchStrict` tells them apart).
 */
export async function primaryBranch(projectPath: string): Promise<string | null> {
  return primaryBranchStrict(projectPath).catch(() => null)
}

/**
 * `primaryBranch`, strictly (#353): null only when git says the repository has none of them; throws when git can't list
 * the branches or read origin/HEAD (anything but its "no such symbolic ref", exit 1 with nothing said), so a removal
 * never takes an unknown main branch for none.
 */
export async function primaryBranchStrict(projectPath: string, reads?: RepoReads): Promise<string | null> {
  const local = new Set(await (reads ? reads.branchesStrict() : localBranchesStrict(projectPath)))
  const remote = await git(projectPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  if (!remote.ok && !(remote.code === 1 && !remote.err)) throw combworkError(M.readOriginHead, { why: gitWhy(remote.err, 'symbolic-ref') })
  // The full ref, cut: `--short` says remotes/origin/x beside a tag origin/x (HI-2426).
  const named = (remote.ok && branchOfRef(remote.out, 'refs/remotes/origin/')) || ''
  return [named, 'main', 'master'].find((b) => b && local.has(b)) ?? null
}

/** The commit a branch points at, or null. */
export async function tipOf(projectPath: string, branch: string): Promise<string | null> {
  const r = await git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  return r.ok ? r.out.trim() || null : null
}

/** Commits of `tip` not in `into`, or 0 when its changes are there already (a squash merge); null when git can't say. */
export async function unmergedCommits(projectPath: string, into: string, tip: string): Promise<number | null> {
  const count = await git(projectPath, ['rev-list', '--count', `${into}..${tip}`])
  if (!count.ok) return null
  const n = parseInt(count.out.trim(), 10) || 0
  return n > 0 && (await alreadyMerged(projectPath, into, tip)) ? 0 : n
}

/**
 * Whether deleting a worktree and its branch loses nothing: git lists it as one of the project's worktrees (not the
 * project folder) on its branch, the branch's commit is fully merged into the repository's main branch
 * (`primaryBranch`; a squash merge counts) and the worktree has no uncommitted changes. Strict: anything git can't say
 * counts as not removable. `tip` is the commit checked, for `removeCheckedWorktree`. Shared by Remove All (#291) and
 * loading templates (#289).
 */
export async function worktreeCheck(projectPath: string, wt: WorktreeRef, reads?: RepoReads): Promise<WorktreeCheck> {
  const into = reads ? await reads.primaryBranchStrict().catch(() => null) : await primaryBranch(projectPath)
  // Git that can't run says nothing about the repository: that is the reason, not "no main branch" (#346).
  const unusable = (reason: () => string): WorktreeCheck => ({ removable: false, into, reason: gitProblemText(gitTool()) ?? reason() })
  if (!into) return unusable(() => tr(msg({ id: 'worktrees.why.noMain', defaultMessage: 'the repository has no main branch (main or master) to check it against', description: "Why Combwork keeps a worktree (it can't tell it is merged): the repository has no main branch. main and master are branch names: keep them. A clause, lower case." })))
  const listed = await (reads ? reads.worktrees() : listWorktrees(projectPath))
  // By real paths (#389): git lists the long name, while Combwork may have been given a short (8.3) one, a junction or a symlink.
  if (samePlace(wt.path, projectPath) || !listed.some((l) => samePlace(l.path, wt.path) && l.branch === wt.branch)) return unusable(() => tr(msg({ id: 'worktrees.why.notListed', defaultMessage: "git doesn't list it as a worktree on {branch}", description: "Why Combwork keeps a worktree: git doesn't list it as one of the project's worktrees on its branch {branch}. A clause, lower case." }), { branch: wt.branch }))
  if (!existsSync(wt.path)) return { removable: false, into, reason: tr(msg({ id: 'worktrees.why.folderMissing', defaultMessage: 'its folder is missing', description: "Why Combwork doesn't remove a worktree: its folder is gone. A clause, lower case." })) }
  // Both commits, so what is checked is fixed: the deletion is guarded against either branch moving afterwards.
  const tipOfBranch = (b: string): Promise<string | null> => (reads ? reads.tip(b) : tipOf(projectPath, b))
  const [tip, intoTip] = await Promise.all([tipOfBranch(wt.branch), tipOfBranch(into)])
  const [ahead, dirty] = tip && intoTip ? await Promise.all([unmergedCommits(projectPath, intoTip, tip), reads ? reads.dirty(wt.path) : dirtyCount(wt.path)]) : [null, null]
  if (!tip || !intoTip || ahead === null || dirty === null) return unusable(() => tr(msg({ id: 'worktrees.why.cantCheck', defaultMessage: "git couldn't check {branch}", description: "Why Combwork keeps a worktree: git couldn't check its branch {branch} for unmerged commits or uncommitted files. A clause, lower case." }), { branch: wt.branch }))
  return ahead || dirty ? { removable: false, into, reason: workLeft(ahead, dirty, into), ahead, dirty, tip, intoTip } : { removable: true, into, tip, intoTip, ahead: 0, dirty: 0 }
}

/** What a worktree holds that its main branch doesn't, in the window's language: "2 commits not merged into main and 1 uncommitted file". */
export function workLeft(ahead: number, dirty: number, into: string): string {
  const parts = [
    ahead ? tr(msg({ id: 'worktrees.why.notMerged', defaultMessage: '{n, plural, one {# commit} other {# commits}} not merged into {into}', description: "Why Combwork keeps a worktree: commits on its branch that the branch {into} doesn't have. A clause, lower case; it may be joined with the uncommitted files in a list." }), { n: ahead, into }) : '',
    dirty ? tr(msg({ id: 'worktrees.why.uncommitted', defaultMessage: '{n, plural, one {# uncommitted file} other {# uncommitted files}}', description: 'Why Combwork keeps a worktree: files changed in it and not committed. A clause, lower case; it may be joined with the unmerged commits in a list.' }), { n: dirty }) : ''
  ].filter(Boolean)
  return fmt.list(parts)
}

/** A removal's reason when nothing was checked. The window's. */
export const notChecked = (): string => tr(msg({ id: 'worktrees.why.notChecked', defaultMessage: 'not checked', description: "Why Combwork kept a worktree: it wasn't checked for unmerged or uncommitted work. A clause, lower case." }))

/** Why the refs a check rested on no longer hold, or null when both still point at the commits checked. */
async function refsMoved(projectPath: string, wt: WorktreeRef, into: string, tip: string, intoTip: string): Promise<string | null> {
  const [t, m] = await Promise.all([tipOf(projectPath, wt.branch), tipOf(projectPath, into)])
  const changed = msg({ id: 'worktrees.why.changed', defaultMessage: '{branch} changed since it was checked', description: "Why Combwork kept a worktree or its branch: the branch {branch} moved after Combwork checked it was merged. A clause, lower case." })
  return t !== tip ? tr(changed, { branch: wt.branch }) : m !== intoTip ? tr(changed, { branch: into }) : null
}

/**
 * The last step of `removeCheckedWorktree`: deletes the branch in one git ref transaction, all or nothing, that verifies
 * the main branch still points at the commit it was found merged into and deletes the branch only from the commit
 * checked. Null when deleted; otherwise why it was kept.
 */
export async function deleteCheckedBranch(projectPath: string, wt: WorktreeRef, into: string, tip: string, intoTip: string): Promise<string | null> {
  const tx = ['start', `verify refs/heads/${into} ${intoTip}`, `delete refs/heads/${wt.branch} ${tip}`, 'prepare', 'commit', ''].join('\n')
  const r = await git(projectPath, ['update-ref', '--stdin'], undefined, tx)
  return r.ok ? null : ((await refsMoved(projectPath, wt, into, tip, intoTip)) ?? gitKept(r.err, 'update-ref'))
}

/** Why git kept a worktree or a branch: its first line, or the command that failed. The window's. */
function gitKept(err: string, command: string): string {
  return tr(msg({ id: 'worktrees.why.gitKept', defaultMessage: 'git kept it: {why}', description: "Why a worktree or a branch wasn't removed: git refused. {why} is git's message, or the git command that failed. A clause, lower case." }), { why: err.split(/\r?\n/)[0] || tr(M.gitFailed, { command }) })
}

/**
 * Deletes a worktree and its branch that `worktreeCheck` found removable, guarded against anything since. Refused
 * (nothing touched) when the main branch isn't the one checked and the one the user was shown (`expectInto`), or when
 * the worktree's branch or the main branch no longer points at the commit checked. The worktree goes without --force,
 * so git refuses one with files written since. The branch is deleted in one git ref transaction that also verifies the
 * main branch still points at the commit it was found merged into: if either moved meanwhile, the branch is kept (and
 * the reply says so; the worktree, clean, is then gone but its commits stay on the branch). Never the forced removal
 * Discard uses. Returns what it did: `deleted` the worktree, `branchKept` with the reason.
 */
export async function removeCheckedWorktree(projectPath: string, wt: WorktreeRef, check: WorktreeCheck, expectInto?: string | null): Promise<{ deleted: boolean; branchKept?: boolean; reason?: string }> {
  const { into, tip, intoTip } = check
  if (!check.removable || !into || !tip || !intoTip) return { deleted: false, reason: check.reason ?? notChecked() }
  const now = await primaryBranch(projectPath)
  if (now !== into || (expectInto !== undefined && expectInto !== into)) {
    return { deleted: false, reason: tr(msg({ id: 'worktrees.why.mainMoved', defaultMessage: '{gone, select, yes {the main branch is gone, not {expected} as checked} other {the main branch is {now}, not {expected} as checked}}', description: "Why Combwork kept a worktree: the repository's main branch is another one ({now}) than the one checked ({expected}), or it is gone (gone: yes). A clause, lower case." }), { gone: now ? 'no' : 'yes', now: now ?? '', expected: expectInto ?? into }) }
  }
  const moved = await refsMoved(projectPath, wt, into, tip, intoTip)
  if (moved) return { deleted: false, reason: moved }
  const removed = await unwatchedWhile([wt.path], () => git(projectPath, ['worktree', 'remove', wt.path]))
  if (!removed.ok) return { deleted: false, reason: gitKept(removed.err, 'git worktree remove') } // i18n-ignore: a git command, as it is
  const kept = await deleteCheckedBranch(projectPath, wt, into, tip, intoTip)
  log.info(`Removed merged, clean worktree ${userText(wt.path)}${kept ? ` (branch ${userText(wt.branch)} kept: ${userText(kept)})` : ` and branch ${userText(wt.branch)}`}`)
  return kept ? { deleted: true, branchKept: true, reason: kept } : { deleted: true }
}

/**
 * Files, lines added and lines removed in a worktree compared with where its branch left `into` (its commits and its
 * tracked uncommitted changes), or with its own last commit when `into` is null. Null when git can't say.
 */
async function diffSummary(cwd: string, into: string | null): Promise<AgentBranchStatus['diff'] | null> {
  if (!(await isDir(cwd))) return null
  let from = 'HEAD'
  if (into) {
    const base = await git(cwd, ['merge-base', into, 'HEAD'])
    if (!base.ok) return null
    from = base.out.trim()
  }
  const r = await git(cwd, ['diff', '--shortstat', from])
  if (!r.ok) return null
  const n = (re: RegExp): number => parseInt(re.exec(r.out)?.[1] ?? '0', 10)
  return { files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?/), deletions: n(/(\d+) deletions?/) }
}

/**
 * Whether merging `branch` would leave `into` as it is: its commits were squash-merged (or their changes
 * made) already, though git still counts them as not merged. A conflict or a git error counts as not merged.
 */
async function alreadyMerged(projectPath: string, into: string, branch: string): Promise<boolean> {
  const [merged, tree] = await Promise.all([
    git(projectPath, ['merge-tree', '--write-tree', '--no-messages', into, branch]),
    git(projectPath, ['rev-parse', `${into}^{tree}`])
  ])
  return merged.ok && tree.ok && merged.out.split('\n')[0].trim() === tree.out.trim()
}

/**
 * Merges a worktree's branch into `target` (default: the project folder's checked-out branch), returning the commit the
 * target is at afterwards (`mergeCommit`). A worktree with uncommitted files is refused, never committed for it (#1347,
 * SPEC §16.9.3): what is merged is what was committed. Conflicts are detected before anything changes (git merge-tree);
 * if there are any, nothing is merged and the files are returned. A target the project folder has checked out is merged
 * there (git merge, its hooks run); one checked out nowhere is merged without touching any folder (the merged tree
 * committed, the branch moved only from where it was); one checked out in another folder is refused. The caller holds
 * the repository lock (repoLock.ts).
 */
export async function mergeWorktree(projectPath: string, wt: WorktreeRef, opts: { squash: boolean; message: string; moveBranch?: boolean; target?: string }): Promise<MergeResult> {
  const message = opts.message.trim() || `Merge ${wt.branch}` // i18n-ignore: a git commit message, kept in the repository
  const dirty = existsSync(wt.path) ? await dirtyCount(wt.path) : 0
  // Git can't say what is uncommitted there: merging (and removing the worktree afterwards) could lose it.
  if (dirty === null) return { ok: false, error: tr(msg({ id: 'worktrees.merge.cantCheck', defaultMessage: "Git couldn't check the worktree for uncommitted changes (git status failed in {folder}). Fix it, then merge again.", description: "Why nothing was merged: git couldn't say what is uncommitted in the worktree's folder {folder}." }), { folder: wt.path }) }
  if (dirty > 0) return { ok: false, uncommitted: dirty, error: tr(msg({ id: 'worktrees.merge.uncommitted', defaultMessage: "Nothing was merged: {files, plural, one {# file in the worktree isn't committed} other {# files in the worktree aren't committed}}. Commit or stash {files, plural, one {it} other {them}} in the worktree, then merge.", description: "Why nothing was merged: the worktree has uncommitted files ({files}: how many). Combwork merges only committed work; stash is git's word (git stash)." }), { files: dirty }) }
  let checkedOut: string | null
  try {
    checkedOut = await checkedOutBranch(projectPath)
  } catch (e) {
    return { ok: false, error: tr(M.nothingMerged, { why: shownError(e) }) }
  }
  let into = checkedOut
  if (opts.target !== undefined) {
    // The branch as git keeps it: on Windows a ref named in another case (MAIN) is the same branch (main), and must be
    // routed as that one, never moved as if it were checked out nowhere (HR6's round 1).
    const named = await branchNamed(projectPath, opts.target)
    if (typeof named !== 'string') return named
    into = named
    if (sameRef(into, wt.branch)) return { ok: false, error: tr(msg({ id: 'worktrees.merge.intoItself', defaultMessage: "{branch} can't be merged into itself.", description: "Why nothing was merged: the branch to merge into is the worktree's own branch {branch}." }), { branch: wt.branch }) }
  }
  if (!into) return { ok: false, error: tr(msg({ id: 'worktrees.merge.detached', defaultMessage: 'The project folder is not on a branch (detached HEAD). Check out the branch to merge into first.', description: "Why nothing was merged: the project folder has no branch checked out. detached HEAD is git's term." })) }
  if (sameRef(into, wt.branch)) return { ok: false, error: tr(msg({ id: 'worktrees.merge.sameBranch', defaultMessage: 'The project folder has {branch} checked out.', description: "Why nothing was merged: the project folder is on the worktree's own branch {branch}." }), { branch: wt.branch }) }
  if (into !== checkedOut) return mergeElsewhere(projectPath, wt, into, opts.squash, message, opts.moveBranch)
  // With nothing staged in the project folder, undoing a failed merge (reset --merge) can't touch the user's own work.
  if ((await git(projectPath, ['diff', '--cached', '--quiet'])).code === 1) {
    return { ok: false, error: tr(msg({ id: 'worktrees.merge.staged', defaultMessage: 'The project folder has staged changes. Commit or unstage them before merging.', description: 'Why nothing was merged: changes are staged (git add) in the project folder.' })) }
  }

  // The branch's commit, by its full ref: a bare name would be a same-named tag before the branch (HI-2422), and git
  // would merge the tag's commit, or say it is up to date, with only a warning. The target is the folder's HEAD.
  const tip = await git(projectPath, ['rev-parse', '--verify', `refs/heads/${wt.branch}^{commit}`])
  if (!tip.ok) return { ok: false, error: tr(M.nothingMerged, { why: tip.err || 'git rev-parse' }) } // i18n-ignore: a git command, as it is
  const source = tip.out.trim()
  const check = await git(projectPath, ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', source])
  if (check.code === 1) {
    const conflicts = check.out.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean)
    return { ok: false, conflicts: conflicts.length ? conflicts : [tr(msg({ id: 'worktrees.merge.unknownFiles', defaultMessage: '(unknown files)', description: "The list of a merge's conflicting files, when git didn't name them." }))] }
  }
  // Any other failure means this git can't do the check (older than 2.38); the merge itself still refuses to lose work.

  if (opts.squash) {
    const m = await git(projectPath, ['merge', '--squash', source])
    if (!m.ok) {
      await git(projectPath, ['reset', '--merge'])
      return { ok: false, error: m.err || m.out || tr(M.gitFailed, { command: 'git merge --squash' }) } // i18n-ignore: a git command, as it is
    }
    const c = await git(projectPath, ['commit', '-m', message])
    if (!c.ok && !/nothing to commit/i.test(c.out + c.err)) {
      await git(projectPath, ['reset', '--merge'])
      return { ok: false, error: c.err || c.out || tr(M.gitFailed, { command: 'git commit' }) } // i18n-ignore: a git command, as it is
    }
  } else {
    const m = await git(projectPath, ['merge', '--no-ff', '-m', message, source])
    if (!m.ok) {
      await git(projectPath, ['merge', '--abort'])
      return { ok: false, error: m.err || m.out || tr(M.gitFailed, { command: 'git merge' }) } // i18n-ignore: a git command, as it is
    }
  }
  log.info(`Merged ${userText(wt.branch)} into ${userText(into)}${opts.squash ? ' (squash)' : ''}`)
  const head = await git(projectPath, ['rev-parse', 'HEAD'])
  return afterMerge(projectPath, wt, into, head.ok ? head.out.trim() : undefined, opts.squash && !!opts.moveBranch)
}

/** A merge's result once the target has moved: its commit, and the agent's branch moved after a squash when asked. */
async function afterMerge(projectPath: string, wt: WorktreeRef, into: string, mergeCommit: string | undefined, move: boolean): Promise<MergeResult> {
  const done: MergeResult = { ok: true, ...(mergeCommit ? { mergeCommit } : {}) }
  if (!move) return done
  const moved = await moveBranchTo(projectPath, wt, into)
  return moved === true ? { ...done, branchMoved: true } : { ...done, moveError: moved }
}

/** A worktree's branch line in `git worktree list --porcelain`. */
const ON_BRANCH = 'branch refs/heads/' // i18n-ignore: git's porcelain output, as it is

/** Whether two branch names are one ref on Windows, whose ref store (NTFS) doesn't tell case apart. */
const sameRef = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * A local branch's name as git keeps it, for a name the caller may have written in another case: the branch of that
 * exact name, else the one branch whose name differs only in case. A refusal when there is none, when git can't list
 * them, or when several differ only in case from the name given (which is meant can't be told).
 */
async function branchNamed(projectPath: string, name: string): Promise<string | MergeResult> {
  const r = await git(projectPath, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])
  if (!r.ok) return { ok: false, error: tr(M.nothingMerged, { why: r.err || 'git for-each-ref' }) } // i18n-ignore: a git command, as it is
  const names = r.out.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^refs\/heads\//, ''))
  if (names.includes(name)) {
    const aliases = names.filter((n) => n !== name && sameRef(n, name))
    return aliases.length ? { ok: false, error: tr(M.caseAlias, { branch: name, other: aliases[0] }) } : name
  }
  const alike = names.filter((n) => sameRef(n, name))
  if (alike.length === 1) return alike[0]
  if (alike.length > 1) return { ok: false, error: tr(M.caseAlias, { branch: alike[0], other: alike[1] }) }
  return { ok: false, error: tr(M.noTarget, { branch: name }) }
}

/**
 * Merges into a branch the project folder hasn't checked out: the merged tree (git merge-tree) committed on the target's
 * tip (and the branch's, unless squashed), and the target moved to it only from that tip (update-ref's compare and swap).
 * No folder's files change, so a target checked out in another worktree is refused: its files would no longer match.
 */
async function mergeElsewhere(projectPath: string, wt: WorktreeRef, into: string, squash: boolean, message: string, moveBranch?: boolean): Promise<MergeResult> {
  const fail = (why: string): MergeResult => ({ ok: false, error: tr(M.nothingMerged, { why }) })
  const listed = await git(projectPath, ['worktree', 'list', '--porcelain'])
  if (!listed.ok) return fail(listed.err || 'git worktree list') // i18n-ignore: a git command, as it is
  // Checked out in any folder under any case of its name (one ref on Windows): its files would no longer match.
  const checkedOutAt = listed.out
    .split(/\r?\n\r?\n/)
    .map((b) => b.split(/\r?\n/))
    .find((lines) => lines.some((l) => l.startsWith(ON_BRANCH) && sameRef(l.slice(ON_BRANCH.length), into)))
  if (checkedOutAt) {
    const folder = checkedOutAt[0].replace(/^worktree /, '')
    return { ok: false, error: tr(msg({ id: 'worktrees.merge.targetElsewhere', defaultMessage: '{branch} is checked out in {folder}. Merge there, or check out another branch in that folder first.', description: "Why nothing was merged: the branch to merge into ({branch}) is checked out in another folder ({folder}) than the project folder." }), { branch: into, folder }) }
  }
  const [old, tip] = await Promise.all([git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${into}^{commit}`]), git(projectPath, ['rev-parse', '--verify', `refs/heads/${wt.branch}^{commit}`])])
  if (!old.ok) return { ok: false, error: tr(M.noTarget, { branch: into }) }
  if (!tip.ok) return fail(tip.err || 'git rev-parse') // i18n-ignore: a git command, as it is
  const from = old.out.trim()
  const merged = await git(projectPath, ['merge-tree', '--write-tree', '--name-only', '--no-messages', from, tip.out.trim()])
  if (merged.code === 1) {
    const conflicts = merged.out.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean)
    return { ok: false, conflicts: conflicts.length ? conflicts : [tr(msg({ id: 'worktrees.merge.unknownFiles', defaultMessage: '(unknown files)', description: "The list of a merge's conflicting files, when git didn't name them." }))] }
  }
  if (!merged.ok) return fail(merged.err || 'git merge-tree') // i18n-ignore: a git command, as it is
  const tree = merged.out.split(/\r?\n/)[0].trim()
  const oldTree = await git(projectPath, ['rev-parse', `${from}^{tree}`])
  // A squash that changes nothing (its work is in the target already) makes no commit, as git merge --squash doesn't.
  if (squash && oldTree.ok && oldTree.out.trim() === tree) return afterMerge(projectPath, wt, into, from, !!moveBranch)
  const commit = await git(projectPath, ['commit-tree', tree, '-p', from, ...(squash ? [] : ['-p', tip.out.trim()]), '-m', message])
  if (!commit.ok) return fail(commit.err || 'git commit-tree') // i18n-ignore: a git command, as it is
  const made = commit.out.trim()
  const moved = await git(projectPath, ['update-ref', '-m', `combwork: merge ${wt.branch}`, `refs/heads/${into}`, made, from]) // i18n-ignore: a reflog line, git's
  if (!moved.ok) return { ok: false, error: tr(msg({ id: 'worktrees.merge.targetMoved', defaultMessage: '{branch} changed while Combwork was merging into it. Nothing was merged: merge again.', description: 'Why nothing was merged: the branch merged into ({branch}) moved on meanwhile (another merge or commit).' }), { branch: into }) }
  log.info(`Merged ${userText(wt.branch)} into ${userText(into)} (not checked out)${squash ? ' (squash)' : ''}`)
  return afterMerge(projectPath, wt, into, made, squash && !!moveBranch)
}

/**
 * After a squash merge that keeps the worktree: moves the agent's branch to `into`, which now holds all its
 * work in the squash commit, so its next merge brings only what is new instead of conflicting with its own
 * old commits. Only when merging the branch again would change nothing (git merge-tree), and with
 * `reset --keep`, which refuses rather than lose uncommitted changes. Returns true, or why it didn't.
 */
export async function moveBranchTo(projectPath: string, wt: WorktreeRef, into: string): Promise<true | string> {
  if (!existsSync(wt.path)) return tr(msg({ id: 'worktrees.move.missing', defaultMessage: '{folder} is missing.', description: "Why the agent's branch wasn't moved after a squash merge: its worktree folder {folder} is gone." }), { folder: wt.path })
  // The full ref: --short answers heads/<branch> beside a same-named tag (HI-2422).
  const head = await git(wt.path, ['symbolic-ref', 'HEAD'])
  if (!head.ok || head.out.trim() !== `refs/heads/${wt.branch}`) return tr(msg({ id: 'worktrees.move.notOnBranch', defaultMessage: "The worktree isn't on {branch}.", description: "Why the agent's branch wasn't moved after a squash merge: its worktree has another branch than {branch} checked out." }), { branch: wt.branch })
  // Both by their full refs: a same-named tag would otherwise be read, and the branch reset to it (HI-2422).
  if (!(await alreadyMerged(projectPath, `refs/heads/${into}`, `refs/heads/${wt.branch}`))) return tr(msg({ id: 'worktrees.move.notEverything', defaultMessage: "{into} doesn't have everything on {branch}.", description: "Why the agent's branch {branch} wasn't moved after a squash merge: the branch merged into ({into}) lacks some of its changes." }), { into, branch: wt.branch })
  const r = await git(wt.path, ['reset', '--keep', `refs/heads/${into}`])
  if (!r.ok) return r.err || r.out || tr(M.gitFailed, { command: 'git reset' }) // i18n-ignore: a git command, as it is
  log.info(`Moved ${userText(wt.branch)} to ${userText(into)} after the squash merge`)
  return true
}
