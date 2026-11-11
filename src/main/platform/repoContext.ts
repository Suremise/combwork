// Port 1 of the platform contract (SPEC §16.3.6, HI-2784's R1): what a repository is (its context) and how Combwork talks to
// it (a runner, its locks). Plain contracts: no platform's code is imported here, so a caller that holds a RepoContext and
// asks these ports never reaches a version control's module itself. Each platform implements them in its own module
// (Git: gitRepoPorts.ts, over git.ts, gitTool.ts, repoLock.ts, folderFence.ts and refHold.ts, delegating to them
// unchanged); repoPorts.ts finds a folder's or a context's implementation, and never switches on a platform id.
//
// 1.4.0 changes no behaviour (§16.3.6's rule 1): a port's Git implementation runs today's code with the same argv,
// environment, timeouts, output bounds, lock files and lock order.

import type { PlatformId } from '../../shared/platform/descriptors'
import type { IgnoreRule } from '../../shared/gitIgnoreRules'

/**
 * A repository as Combwork talks to it. `store`: the backing store all of its workspaces share (Git: the common git dir,
 * absolute and real), compared case-insensitively (`sameStore`): two contexts are the same repository exactly when their
 * stores are, and one store has one repository lock. `workspace`: the working folder's own state (Git: its own git dir;
 * the main checkout's is the store's folder). `root`: the working folder's top; `folder`: the one asked about, which a
 * runner runs in; `subfolder`: `folder` is below `root` (§16.3.5, OP-29: its actions affect the whole repository).
 */
export interface RepoContext {
  platform: PlatformId
  store: string
  workspace: string
  root: string
  folder: string
  subfolder?: boolean
}

/** Whether two contexts' stores are one store (one repository, one lock): compared case-insensitively. */
export const sameStore = (a: Pick<RepoContext, 'store'>, b: Pick<RepoContext, 'store'>): boolean => a.store.toLowerCase() === b.store.toLowerCase()

/**
 * What a command a runner ran answered (Git's is `GitResult`, this shape). A command that didn't run to an exit of its
 * own (`missing`, `notRun`, `timedOut`) is never the tool's answer about the repository: `code` is -1 then.
 */
export interface RunResult {
  out: string
  ok: boolean
  buf: Buffer
  /** Standard error, for messages to show when a command fails. */
  err: string
  /**
   * The exit code; -1 when the tool didn't run to an exit code of its own (not started: `missing`, or `notRun`), so no
   * caller takes it for the tool's own "no" (exit 1: a config key not set, HEAD detached, not an ancestor).
   */
  code: number
  /** The tool couldn't be started: not installed, or not on Combwork's PATH (#346). Never an answer about the repository. */
  missing?: boolean
  /**
   * HI-2019: the tool didn't run to an exit of its own for another reason, as Node or Combwork's worker said it (`EAGAIN`,
   * a busy machine; `ERR_GIT_WORKER`, the worker ended; the output bound; ended by a signal): a failure to try again,
   * never the tool's answer, and never the tool missing.
   */
  notRun?: string
  /** Stopped at its `timeout` (RunOptions). */
  timedOut?: boolean
}

/** A command's bounds and inputs. Unset, each is the platform runner's own default (Git: git()'s). */
export interface RunOptions {
  /** The output kept, in bytes: past it the command is ended and didn't run to an exit (`notRun`). */
  maxOutput?: number
  /** Written to its standard input. */
  input?: string
  /** Its environment, for a command that may reach a remote (the Git view's fetch, pull, push). */
  env?: NodeJS.ProcessEnv
  /** Ended after this many milliseconds (`timedOut`). */
  timeout?: number
}

/**
 * Whether the platform's tool runs (Provider Setup's row, #346): `missing` (not on Combwork's PATH, or it failed to
 * start), `old` (older than Combwork works with), `unknown` (not checked yet, or it answered something else: `error`).
 * Git's is `GitTool` (shared/gitTool.ts), this shape.
 */
export interface Readiness {
  state: 'ok' | 'missing' | 'old' | 'unknown'
  version?: string
  path?: string
  error?: string
}

/**
 * A platform's bounded runner: every command Combwork runs in a repository, off main's thread, in the environment, with
 * the credentials rules and in the job its platform gives it (Git: git() and its worker, its route into the queue's host,
 * its environment allowlist, GIT_TERMINAL_PROMPT=0). A route (the merge queue's host, in its lease's job) is the
 * platform's own (Git: `withGitRoute`): a runner only says whether one runs its commands now and runs work outside it.
 */
export interface RepoRunner {
  /** Runs the tool in `ctx.folder` with `args` (the platform's own prefix added, as every command it runs has it). */
  run(ctx: RepoContext, args: readonly string[], o?: RunOptions): Promise<RunResult>
  /** Checks the tool again (Provider Setup's Check again), one check at a time. */
  readiness(): Promise<Readiness>
  /** The tool as last checked, without checking. */
  readinessNow(): Readiness
  /** What to tell the user when the tool can't run (missing or too old), in English; null when it runs. */
  problem(): string | null
  /** A route (another process, its own environment) runs this scope's commands now, not the runner's own thread. */
  routed(): boolean
  /** Runs `fn` outside any route (a runner's own release and clean-up, whoever started it). */
  withoutRoute<T>(fn: () => T): T
}

/** How a repository lock is taken: quietly (a background change, no notice while it waits), and the project a notice is about. */
export interface RepoLockOptions {
  quiet?: boolean
  project?: string
}

/** A ref and the revision it must be at (a full id). */
export interface RefAt {
  ref: string
  oid: string
}

/** A prepared hold: the refs locked until `close()`; `lost()` once its process ended or its input broke (its proof can't stand). */
export interface RefHold {
  lost(): boolean
  close(): Promise<void>
}

/** Why a hold couldn't be prepared: a ref not where it was checked, a lock someone else holds, the answer late, or the tool failing. */
export type RefHoldRefused = { why: 'moved' | 'locked' | 'timeout' | 'failed'; ref?: string; lock?: string; detail: string }

/** A hold's bounds: the wait for its prepare, and for its process to exit once closed. */
export interface HoldOptions {
  prepareMs: number
  closeMs: number
}

/**
 * A platform's locks (SPEC §16.9.3, R1.1–R1.3): the repository lock, one per store, across processes; the folder fence
 * while Combwork rewrites a folder an agent may be typing in; ref holds while Combwork records what it proved about refs.
 */
export interface RepoLocks {
  /**
   * Runs `fn` holding the repository lock of `ctx`'s store. A live holder is never taken over; past the Advanced
   * setting's wait it gives up with who holds it, and nothing of `fn` runs.
   */
  withRepoLock<T>(ctx: RepoContext, fn: () => Promise<T>, o?: RepoLockOptions): Promise<T>
  /** Runs `fn` holding the repository locks of several contexts: each store once, always in the same order, so no two takers wait on each other. */
  withRepoLocks<T>(ctxs: readonly RepoContext[], fn: () => Promise<T>, o?: RepoLockOptions): Promise<T>
  /** Runs `fn` with `ctx.folder` fenced (#646): no turn starts there, nothing is typed into an agent working in it, until it settles. */
  changingFolder<T>(ctx: RepoContext, what: string, fn: () => Promise<T>): Promise<T>
  /** Holds the platform's own locks of `refs` at the revisions given, until the hold is closed; a refusal says why. */
  holdRefs(ctx: RepoContext, refs: readonly RefAt[], o: HoldOptions): Promise<{ hold: RefHold } | { refused: RefHoldRefused }>
}

/** A platform's repository context port: its contexts, runner, locks and the folders that are its own. */
export interface RepoPorts {
  platform: PlatformId
  /** Its tool's name, as Copy Diagnostics names it (a product's name: Git). */
  tool: string
  /** The context of the repository holding `folder`, or null when this platform has none there (no repository, unreadable). */
  contextOf(folder: string): Promise<RepoContext | null>
  runner: RepoRunner
  locks: RepoLocks
  /**
   * The folder names that are the platform's own at a workspace's root (Git: `.git`): never file-search content, never
   * a deliverable, never an agent's edit.
   */
  metadataDirs: readonly string[]
  /**
   * The folder a provider keys a repository's shared state by (HI-2789: Claude Code's memory): the repository's main
   * working tree, whichever of its workspaces `folder` is (`main` null when it can't be named as an absolute folder);
   * `none` when the tool says `folder` is in no repository; null when it can't tell (a timeout, another failure).
   */
  mainTree(folder: string, o: { timeout: number }): Promise<{ main: string | null } | { none: true } | null>
  /**
   * The folder a provider's trust is asked for (HI-2789, the trust check's roots): the main working tree holding
   * `folder`, checked to be one (`root` null when it can't be: a bare repository, a listing that disagrees); `none` when
   * the tool says `folder` is in no repository; `unknown` for anything else (a timeout, the tool missing).
   */
  trustRoot(folder: string, o: { timeout: number }): Promise<{ root: string | null } | { none: true } | { unknown: true }>
  /** The store's own exclude file, where Combwork keeps its copies out of the repository (Git: info/exclude in the common git dir); null when it can't be named. */
  excludeFile(folder: string, o: { timeout: number }): Promise<string | null>
  /** Keeping a project's .combwork out of the repository (HI-2792, #345, #364), in the platform's own terms. */
  keepOut: KeepOut
  /** The line the project folder has checked out, read with no process (HI-2792: ProjectInfo's branch); null when none or unreadable. */
  currentLine(projectPath: string): Promise<string | null>
  /** The Files tab's reads (HI-2792): what the repository ignores of a folder's entries, and the files a search reads. */
  files: RepoFiles
}

/** The Files tab's repository reads (port 1, HI-2792; Git's: check-ignore and ls-files, platform/gitFiles.ts). */
export interface RepoFiles {
  /** The ignored entries among `rels` (folders with a trailing `/`) with each one's rule; null when the tool couldn't say; `none` when no repository of this platform holds the folder. */
  ignored(folder: string, rels: string[]): Promise<Map<string, IgnoreRule> | null | 'none'>
  /** Every file a search reads (tracked and untracked, not ignored); null when the tool can't list them (none holds the folder, or it failed). */
  list(folder: string): Promise<string[] | null>
}

/** What keeping .combwork out of a repository is (port 1's metadata, HI-2792): Git's is info/exclude and `git rm --cached`. */
export interface KeepOut {
  /** Whether a repository of this platform holds the project (read from its folders, no process). */
  holds(projectPath: string): boolean
  /**
   * Keeps the project's .combwork out of the repository holding it (`readOnly`: asks only), then asks the tool whether it
   * is; null when no repository of this platform holds it. `unconfirmed`: the tool couldn't be asked (its runner's problem says why).
   */
  ensure(projectPath: string, opts?: { readOnly?: boolean | (() => boolean) }): Promise<{ excluded: boolean; root: string; added: boolean; unconfirmed?: boolean } | null>
  /** The files under the project's .combwork the repository tracks (`fresh`: asked again now); null when the tool can't say. */
  tracked(projectPath: string, root: string, opts?: { fresh?: boolean }): Promise<string[] | null>
  /** Stops tracking exactly the files the user confirmed (none if the tracked list changed since), leaving them on disk: how many. */
  untrack(projectPath: string, confirmed: string[]): Promise<number>
}
