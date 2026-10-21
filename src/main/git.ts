import { execFile } from 'child_process'
import { resolve, sep } from 'path'
import { lstat, readFile, readlink } from 'original-fs/promises'
import { existsSync } from 'original-fs'
import { insideReal } from './fsutil'
import { gitProblem, gitTool, noteGitMissing, noteGitRan } from './gitTool'
import type { GitDiff, GitStatus } from '../shared/types'
import { gitProblemData } from '../shared/gitTool'
import { withValues } from '../shared/advanced'
import { msg, tr } from '../shared/i18n'
import { hiveError } from './hiveError'

const MAX_DIFF_BYTES = 2 * 1024 * 1024

export interface GitResult {
  out: string
  ok: boolean
  buf: Buffer
  /** Standard error, for messages to show when a command fails. */
  err: string
  /** The exit code; -1 when git couldn't be started (`missing`), so no caller takes it for git's own "no" (exit 1). */
  code: number
  /** Git couldn't be started: not installed, or not on Hive's PATH (#346). Never an answer about the repository. */
  missing?: boolean
  /** Stopped at its `timeout` (GitRunOptions). */
  timedOut?: boolean
}

/**
 * What every git command Hive runs starts with. Hive's git calls run in the background, beside the user's and agents'
 * own git commands, so they never write the index as a side effect (#212): `status` refreshes it opportunistically
 * (taking index.lock, so a `git add` or `commit` at that moment fails with "index.lock: File exists") unless optional
 * locks are off, and `diff` against the working tree does it whatever that says unless autoRefreshIndex is off. Locks a
 * command needs (commit, merge, reset) are still taken.
 */
export const GIT_PREFIX = ['--no-optional-locks', '-c', 'diff.autoRefreshIndex=false', '-c', 'core.quotepath=off'] as const

/** A command that may take a while or reach a remote (the Git view's fetch, pull, push): its own environment and a time limit. */
export interface GitRunOptions {
  env?: NodeJS.ProcessEnv
  timeout?: number
}

/** A seam for unit tests: told of each git command as it starts (#732 counts a template plan's and load's). */
export const gitTestHooks: { started?: (cwd: string, args: readonly string[]) => void } = {}

export function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024, input?: string, opts: GitRunOptions = {}): Promise<GitResult> {
  gitTestHooks.started?.(cwd, args)
  return new Promise((res) => {
    const child = execFile('git', [...GIT_PREFIX, ...args], { cwd, windowsHide: true, maxBuffer, encoding: 'buffer', ...(opts.env ? { env: opts.env } : {}), ...(opts.timeout ? { timeout: opts.timeout } : {}) }, (err, stdout, stderr) => {
      const buf = (stdout as unknown as Buffer) ?? Buffer.alloc(0)
      const errCode = (err as { code?: unknown } | null)?.code
      // Git didn't start. Node says ENOENT for a missing working folder too: that one is a failure, not a missing git.
      const missing = (errCode === 'ENOENT' || errCode === 'EACCES' || errCode === 'EPERM' || errCode === 'UNKNOWN') && existsSync(cwd)
      const code = err ? (typeof errCode === 'number' ? errCode : missing ? -1 : 1) : 0
      if (missing) noteGitMissing()
      // Git ran (whatever it answered): not one that didn't start for another reason (no working folder, output too big).
      else if (!err || typeof errCode === 'number') noteGitRan()
      res({ out: buf.toString('utf8'), ok: !err, buf, err: ((stderr as unknown as Buffer) ?? Buffer.alloc(0)).toString('utf8').trim(), code, ...(missing ? { missing } : {}), ...((err as { killed?: boolean } | null)?.killed && opts.timeout ? { timedOut: true } : {}) })
    })
    // What the command reads (update-ref --stdin's transaction).
    if (input !== undefined) child.stdin?.end(input)
  })
}

/** Git couldn't read the index for a moment (another git command, a user's `git add`, is rewriting it): worth trying again (#222). */
export const INDEX_BUSY = /index file open failed|unable to (open|read|create).*index|could not read.*index|index\.lock|index file smaller than expected|bad index file/i
const BUSY_TRIES = 4
const BUSY_RETRY_MS = 50

/** git(), tried again briefly while the index is busy (`INDEX_BUSY`): a read that fails only for that moment isn't a failure. */
export async function gitReading(cwd: string, args: string[]): Promise<GitResult> {
  let r = await git(cwd, args)
  for (let t = 1; t < BUSY_TRIES && !r.ok && INDEX_BUSY.test(r.err); t++) {
    await new Promise((res) => setTimeout(res, BUSY_RETRY_MS))
    r = await git(cwd, args)
  }
  return r
}

/** The Changes tab's refusals and notes, in the window's language (#850): only the window reads them. */
const M = {
  failed: msg({ id: 'service.git.failed', defaultMessage: '{command} failed: {why}', description: "An error in the Changes tab: a git command ({command}, as it is: \"git status\") failed; {why} is git's own first line, or why git can't run." }),
  exitCode: msg({ id: 'service.git.exitCode', defaultMessage: 'exit code {code}', description: 'Why a git command failed when git said nothing: the number it exited with.' }),
  outside: msg({ id: 'service.git.outside', defaultMessage: 'Path is outside the project', description: "An error showing a file's changes: its path leads out of the project." })
}

/** Why a git command failed, for an error the window shows: git missing, else git's own first line. `command` is the git command, as it is. */
function failure(command: string, r: GitResult): Error {
  return hiveError(M.failed, { command, why: gitProblemData(gitTool()) ?? (r.err.split(/\r?\n/)[0] || withValues(M.exitCode, { code: r.code })) })
}

/** The commit where HEAD left base, or null if there is none (git's exit 1). Throws when git can't say (#346). */
async function mergeBase(cwd: string, base: string): Promise<string | null> {
  const r = await git(cwd, ['merge-base', base, 'HEAD'])
  if (r.ok) return r.out.trim()
  if (r.code === 1 && !r.err) return null
  throw failure(`git merge-base ${base}`, r) // i18n-ignore: a git command, as it is
}

/**
 * Changed files in a working tree. With base (a worktree agent's branch), lists everything that
 * differs from where the branch left base — its commits and uncommitted edits — rather than from HEAD.
 */
export async function gitStatus(projectPath: string, base?: string): Promise<GitStatus> {
  const { status, inWorktree } = await workingStatus(projectPath)
  if (!base || !status.isRepo) return status
  const mb = await mergeBase(projectPath, base)
  if (!mb) return status
  const r = await gitReading(projectPath, ['diff', '--name-status', '--no-renames', '-z', mb])
  // A failed diff is no list of changes: the tab shows the error, not an empty list (#346).
  if (!r.ok) throw failure('git diff', r) // i18n-ignore: a git command, as it is
  const files: GitStatus['files'] = []
  const parts = r.out.split('\0').filter(Boolean)
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const file = parts[i + 1]
    if (!file.startsWith('.hive/')) files.push({ path: file, status: parts[i][0], staged: false })
  }
  const real = await withoutStatOnly(projectPath, mb, files, inWorktree)
  const seen = new Set(real.map((f) => f.path))
  for (const f of status.files) if (f.status === '?' && !seen.has(f.path)) real.push(f)
  return { ...status, files: real }
}

/**
 * A diff against the working tree that doesn't refresh the index (GIT_PREFIX) lists a file whose timestamps changed but
 * not its content as modified. Git says exactly, without touching the index, whether the working tree's copy matches
 * the index (status, which compares content and mode in memory) and whether the index matches the merge base (a diff
 * of the index, mode included): a file is dropped only when both match. A file whose working copy differs from an index
 * that differs from the base too is kept (it is changed unless it was changed back by hand), and so is every file when
 * git can't say.
 */
async function withoutStatOnly(projectPath: string, mb: string, files: GitStatus['files'], inWorktree: Set<string>): Promise<GitStatus['files']> {
  const modified = files.filter((f) => f.status === 'M' && !inWorktree.has(f.path))
  if (!modified.length) return files
  const c = await git(projectPath, ['diff', '--cached', '--name-only', '--no-renames', '-z', mb])
  if (!c.ok) return files
  const indexChanged = new Set(c.out.split('\0').filter(Boolean))
  const drop = new Set(modified.filter((f) => !indexChanged.has(f.path)).map((f) => f.path))
  return drop.size ? files.filter((f) => !drop.has(f.path)) : files
}

/** The working tree's status, and the paths whose working copy differs from the index (or isn't in it). */
async function workingStatus(projectPath: string): Promise<{ status: GitStatus; inWorktree: Set<string> }> {
  const inWorktree = new Set<string>()
  const r = await gitReading(projectPath, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'])
  if (!r.ok) {
    // Only git's own "not a git repository" says it isn't one (#346). Git that can't run says nothing about that; any
    // other failure (a damaged index, a dubious owner) is an error the tab shows with Retry, not an empty repository.
    const problem = gitProblem()
    if (problem) return { status: { isRepo: false, gitProblem: problem, branch: null, ahead: 0, behind: 0, files: [] }, inWorktree }
    if (/not a git repository/i.test(r.err)) return { status: { isRepo: false, branch: null, ahead: 0, behind: 0, files: [] }, inWorktree }
    throw failure('git status', r) // i18n-ignore: a git command, as it is
  }
  const parts = r.out.split('\0').filter(Boolean)
  const status: GitStatus = { isRepo: true, branch: null, ahead: 0, behind: 0, files: [] }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.startsWith('## ')) {
      const head = p.slice(3)
      const m = head.match(/^(?:No commits yet on )?([^.\s]+)/)
      status.branch = m ? m[1] : head
      status.ahead = parseInt(head.match(/ahead (\d+)/)?.[1] ?? '0', 10)
      status.behind = parseInt(head.match(/behind (\d+)/)?.[1] ?? '0', 10)
      continue
    }
    const x = p[0]
    const y = p[1]
    const file = p.slice(3)
    if (x === 'R' || x === 'C') i++ // the next entry is the original path
    if (y !== ' ') inWorktree.add(file)
    if (file.startsWith('.hive/')) continue
    const code = x === '?' ? '?' : y !== ' ' ? y : x
    status.files.push({ path: file, status: code, staged: x !== ' ' && x !== '?' })
  }
  return { status, inWorktree }
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export async function gitDiff(projectPath: string, file: string, base?: string): Promise<GitDiff> {
  const abs = resolve(projectPath, file)
  if (!abs.toLowerCase().startsWith(resolve(projectPath).toLowerCase() + sep)) throw hiveError(M.outside)
  const ref = (base && (await mergeBase(projectPath, base))) || 'HEAD'
  const head = await git(projectPath, ['show', `${ref}:${file.replace(/\\/g, '/')}`], MAX_DIFF_BYTES * 2)
  const original = head.ok ? head.buf : Buffer.alloc(0)
  let modified = Buffer.alloc(0)
  try {
    const s = await lstat(abs)
    // A link is shown as git stores it (the path it points to), never followed: it could lead outside the project.
    if (s.isSymbolicLink()) modified = Buffer.from(await readlink(abs), 'utf8')
    else {
      // Nor a file reached through a linked folder that leads outside.
      if (!insideReal(abs, [projectPath])) throw Object.assign(hiveError(M.outside), { outside: true })
      if (s.size > MAX_DIFF_BYTES) return { path: file, original: '', modified: tr(msg({ id: 'service.git.tooLarge', defaultMessage: 'File is too large to diff ({kb, number} KB).', description: "Shown in place of a file's changes in the Changes tab: the file is too large ({kb} KB) to compare." }), { kb: Math.round(s.size / 1024) }), binary: true }
      modified = await readFile(abs)
    }
  } catch (e) {
    if ((e as { outside?: boolean }).outside) throw e
    // Deleted in the working tree.
  }
  if (isBinary(original) || isBinary(modified)) return { path: file, original: '', modified: '', binary: true }
  return { path: file, original: original.toString('utf8'), modified: modified.toString('utf8'), binary: false }
}
