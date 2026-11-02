import { AsyncLocalStorage } from 'async_hooks'
import { join, resolve, sep } from 'path'
import { SHARE_ENV, Worker } from 'worker_threads'
import { lstat, readFile, readlink } from 'original-fs/promises'
import { insideReal } from './fsutil'
import { gitExe, gitExeGone, gitProblem, gitTool, noteGitMissing, noteGitRan, PATH_GIT, type GitExe } from './gitTool'
import type { GitDiff, GitStatus } from '../shared/types'
import { gitProblemData } from '../shared/gitTool'
import { withValues } from '../shared/advanced'
import { msg, tr } from '../shared/i18n'
import { hiveError } from './hiveError'
import { createLogger } from './logger'
import { runGit, type GitOutcome, type GitReply, type GitRequest, type RefsRequest } from './gitWorker'
import { bundledScriptExists, workerHere, workerStarted } from './workerThreads'
import { readRepoRefs, type RepoRefs } from './platform/repoRefs'

const log = createLogger('git')

export const MAX_DIFF_BYTES = 2 * 1024 * 1024

export interface GitResult {
  out: string
  ok: boolean
  buf: Buffer
  /** Standard error, for messages to show when a command fails. */
  err: string
  /**
   * The exit code; -1 when git didn't run to an exit code of its own (not started: `missing`, or `notRun`), so no caller
   * takes it for git's own "no" (exit 1: a config key not set, HEAD detached, not an ancestor).
   */
  code: number
  /** Git couldn't be started: not installed, or not on Hive's PATH (#346). Never an answer about the repository. */
  missing?: boolean
  /**
   * HI-2019: git didn't run to an exit of its own for another reason, as Node or Hive's worker said it (`EAGAIN`, a
   * busy machine; `ERR_GIT_WORKER`, the worker ended; the output bound; ended by a signal): a failure to try again, never
   * git's answer, and never git missing.
   */
  notRun?: string
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
  /** HI-2137: gitTool's own check of git: this git rather than gitExe()'s, and what it does is not noted as git's state. */
  exe?: string
}

/**
 * A seam for unit tests: told of each git command as it starts on git's worker thread (#732 counts a template plan's
 * and load's), not of one a route runs (HI-2078).
 */
export const gitTestHooks: { started?: (cwd: string, args: readonly string[]) => void } = {}

/** HI-2078: where a scope's git runs instead of the worker: the request as the worker gets it, its outcome as execFile's. */
export type GitRoute = (m: Omit<GitRequest, 'id'>) => Promise<GitOutcome>

/** A route's scope: its route, while what it wraps runs (active), and not after. */
type RouteScope = { route: GitRoute; active: boolean }
const routes = new AsyncLocalStorage<RouteScope | null>()

/**
 * HI-2078: runs `fn` with every git() it makes run by `route` (the merge queue's run: its lease's git host, in its job),
 * until `fn` settles. Work started inside it and still going after (a timer, a listener) runs git on the worker again,
 * as a completed step's answers go (gitStep). Inside, `route` answers for itself: it never falls back to the worker.
 */
export async function withGitRoute<T>(route: GitRoute, fn: () => Promise<T>): Promise<T> {
  const scope: RouteScope = { route, active: true }
  try {
    return await routes.run(scope, fn)
  } finally {
    scope.active = false
  }
}

/** HI-2078: runs `fn` outside any route (a runner's own release and clean-up, whoever started it). */
export function withoutGitRoute<T>(fn: () => T): T {
  return routes.run(null, fn)
}

/** HI-2189: a route runs git here now (another process, with its own environment), not the worker. */
export function gitRouted(): boolean {
  return !!routes.getStore()?.active
}

export function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024, input?: string, opts: GitRunOptions = {}): Promise<GitResult> {
  // HI-2137: the git Hive starts (Git for Windows' real git rather than its launcher, where it found one).
  const run = (): Promise<GitResult> => gitAs(opts.exe !== undefined ? { exe: opts.exe } : gitExe(), cwd, args, maxBuffer, input, opts)
  return changesWorktrees(args) ? oneWorktreeChange(cwd, run) : run()
}

/** A command that changes the repository's list of worktrees (add, remove, prune, move, repair, lock...), not `list`. */
export const changesWorktrees = (args: readonly string[]): boolean => args[0] === 'worktree' && args[1] !== undefined && args[1] !== 'list'

/** The changes to each repository's worktrees under way, by the folder they run in (its last one's end). */
const worktreeChanges = new Map<string, Promise<unknown>>()

/**
 * HI-2322: one change to a repository's worktrees at a time in this process. Git reads every worktree's entry
 * (.git/worktrees/<name>) as it adds one, and fails on one another add has made but not yet written ("fatal: failed to
 * read .git/worktrees/copy-1/commondir"), so two review copies, slots or worktrees made at once could fail. Keyed by
 * the folder git runs in: every caller runs these in the project's folder. Each waits for the one before it, whatever
 * that one's outcome; the entry goes once its last change has ended.
 */
export function oneWorktreeChange<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(cwd).toLowerCase()
  const run = (worktreeChanges.get(key) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => undefined)
  worktreeChanges.set(key, tail)
  void tail.then(() => worktreeChanges.get(key) === tail && worktreeChanges.delete(key))
  return run
}

/**
 * The line of git's stderr that says why it failed: its first `fatal:` or `error:` line, else its first line. Not
 * simply the first: `git worktree add` says "Preparing worktree…" before its error (HI-2322).
 */
export function gitErrorLine(err: string): string {
  const lines = err.trim().split(/\r?\n/)
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0] ?? ''
}

/** For tests: how many repositories have a worktree change under way or waiting. */
export const worktreeChangesPending = (): number => worktreeChanges.size

/** git() with the git it starts (`use`). */
async function gitAs(use: GitExe, cwd: string, args: string[], maxBuffer: number, input: string | undefined, opts: GitRunOptions): Promise<GitResult> {
  const m = { cwd, args: [...GIT_PREFIX, ...args], maxBuffer, ...(use.exe !== 'git' ? { exe: use.exe } : {}), ...(use.launcherEnv ? { launcherEnv: use.launcherEnv } : {}), ...(input !== undefined ? { input } : {}), ...(opts.env ? { env: opts.env } : {}), ...(opts.timeout ? { timeout: opts.timeout } : {}) }
  const scope = routes.getStore()
  // HI-2078: a route's scope runs it there; else it starts off main's thread (HI-1783): gitWorker.ts runs it as this
  // always did. Either way its outcome is read here.
  if (!scope?.active) gitTestHooks.started?.(cwd, args)
  const o = scope?.active ? await scope.route(m) : await thread.run(m)
  if (o.held) log.warn(`git ${args[0]}'s output stayed open after it exited, held by another process (HI-1854): taken as read`)
  const buf = Buffer.from(o.stdout.buffer, o.stdout.byteOffset, o.stdout.byteLength)
  const err = o.error
  const errCode = err?.code
  // Git didn't start. Node says ENOENT for a missing working folder too: that one is a failure, not a missing git.
  const missing = (errCode === 'ENOENT' || errCode === 'EACCES' || errCode === 'EPERM' || errCode === 'UNKNOWN') && o.cwdExists
  // HI-2019: anything but git's own exit code (a start that failed, the worker ended, the output bound, a signal) is -1,
  // never 1, which callers read as git's "no"; what happened is kept (`notRun`), and said when git itself said nothing.
  const ranToExit = !err || typeof errCode === 'number'
  const notRun = !ranToExit && !missing ? String(errCode ?? err?.signal ?? 'error') : undefined
  const code = err ? (typeof errCode === 'number' ? errCode : -1) : 0
  if (opts.exe === undefined) {
    // HI-2137: the real git Hive found couldn't start (uninstalled, moved): it never ran, so once more with PATH's,
    // whether or not another command found it gone first.
    if (missing && use.exe !== PATH_GIT.exe) {
      gitExeGone(use.exe)
      return gitAs(PATH_GIT, cwd, args, maxBuffer, input, opts)
    }
    if (missing) noteGitMissing()
    // Git ran (whatever it answered): not one that didn't start for another reason (no working folder, output too big).
    else if (ranToExit) noteGitRan()
  }
  const stderr = Buffer.from(o.stderr.buffer, o.stderr.byteOffset, o.stderr.byteLength).toString('utf8').trim()
  const said = stderr || (notRun ? `git ${args[0]} didn't run to an exit (${notRun})` : '') // i18n-ignore: git's side of an error, in English as git's messages are
  return { out: buf.toString('utf8'), ok: !err, buf, err: said, code, ...(missing ? { missing } : {}), ...(notRun ? { notRun } : {}), ...(err?.killed && opts.timeout ? { timedOut: true } : {}) }
}

/**
 * Where git's commands run (HI-1783): its worker thread (gitWorker.ts, a build entry beside main's script), started with
 * the first; in this thread where there is no built script (unit tests), as before. A command under way when the worker
 * ends is answered as one that couldn't start (its outcome unknown: never taken for git's answer); the next starts it again.
 */
class GitThread {
  private worker: Worker | null = null
  /** Each call under way: its answer, or null when the worker ended first. */
  private calls = new Map<number, (r: GitReply | null) => void>()
  private next = 0
  /** Why the worker last ended. */
  private lost = ''

  run(m: Omit<GitRequest, 'id'>): Promise<GitOutcome> {
    const w = this.ensure()
    if (!w) return runGit(m)
    const id = ++this.next
    return new Promise((done) => {
      this.calls.set(id, (r) => done(r && 'outcome' in r ? r.outcome : lostOutcome(this.lost)))
      w.postMessage({ ...m, id } satisfies GitRequest)
    })
  }

  /**
   * A repository's refs and working folders, read in the worker (HI-1814: observe.ts's read walked every ref file on
   * main); here where there is none, and here again when it ended first (a read has no side effects).
   */
  refs(common: string, max: number): Promise<RepoRefs> {
    const w = this.ensure()
    if (!w) return Promise.resolve(readRepoRefs(common, max))
    const id = ++this.next
    return new Promise((done) => {
      this.calls.set(id, (r) => done(r && 'refs' in r ? r.refs : readRepoRefs(common, max)))
      w.postMessage({ id, kind: 'refs', common, max } satisfies RefsRequest)
    })
  }

  private ensure(): Worker | null {
    if (this.worker) return this.worker
    const script = gitWorkerScript()
    if (!bundledScriptExists(script)) {
      workerHere('git', "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
      return null
    }
    const w = new Worker(script, { env: SHARE_ENV })
    this.worker = w
    workerStarted('git', w) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
    w.on('message', (r: GitReply) => {
      const c = this.calls.get(r.id)
      this.calls.delete(r.id)
      c?.(r)
    })
    const gone = (why: string): void => {
      if (this.worker !== w) return
      this.worker = null
      log.warn(`git's worker ended (${why}); it starts again with the next command`)
      this.lost = why
      for (const c of this.calls.values()) c(null)
      this.calls.clear()
    }
    w.on('error', (e: Error) => gone(e.message))
    w.on('exit', (code) => gone(`exit code ${code}`)) // i18n-ignore: for the log
    w.unref()
    return w
  }
}

/** A command's outcome when git's worker ended while it was under way: one that couldn't start (never git's answer). */
const lostOutcome = (why: string): GitOutcome => ({ stdout: new Uint8Array(), stderr: Buffer.from(`Hive's git worker ended (${why})`), error: { code: 'ERR_GIT_WORKER', killed: false, signal: null }, cwdExists: true }) // i18n-ignore: git's error text, for the log and the caller's message

/** The observer's read of a repository's refs (observe.ts), off main's thread: see GitThread.refs. */
export const readRefsOffMain = (common: string, max: number): Promise<RepoRefs> => thread.refs(common, max)

/** The worker's script, beside main's (inside the asar, as the others' are); a test's build of it (`useGitWorker`). */
let gitScriptForTests: string | null = null
const gitWorkerScript = (): string => gitScriptForTests ?? join(__dirname, 'git-worker.js')
let thread = new GitThread()

/** Tests: git's worker from this script (a build of gitWorker.ts), or null for the default; a new thread. */
export function useGitWorker(file: string | null): void {
  gitScriptForTests = file
  thread = new GitThread()
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
  outside: msg({ id: 'service.git.outside', defaultMessage: 'Path is outside the project', description: "An error showing a file's changes: its path leads out of the project." }),
  tooLarge: msg({ id: 'service.git.tooLarge', defaultMessage: 'File is too large to diff ({kb, number} KB).', description: "Shown in place of a file's changes in the Changes tab: the file is too large ({kb} KB) to compare." })
}

/** Shown in place of a file's diff when it is over MAX_DIFF_BYTES. */
export const tooLargeDiff = (path: string, bytes: number): GitDiff => ({ path, original: '', modified: tr(M.tooLarge, { kb: Math.round(bytes / 1024) }), binary: true })

/** Why a git command failed, for an error the window shows: git missing, else git's own first line. `command` is the git command, as it is. */
export function failure(command: string, r: GitResult): Error {
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

export function isBinary(buf: Buffer): boolean {
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
      if (s.size > MAX_DIFF_BYTES) return tooLargeDiff(file, s.size)
      modified = await readFile(abs)
    }
  } catch (e) {
    if ((e as { outside?: boolean }).outside) throw e
    // Deleted in the working tree.
  }
  if (isBinary(original) || isBinary(modified)) return { path: file, original: '', modified: '', binary: true }
  return { path: file, original: original.toString('utf8'), modified: modified.toString('utf8'), binary: false }
}
