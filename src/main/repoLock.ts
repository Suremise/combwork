import { app } from 'electron'
import { realpath } from 'original-fs/promises'
import { basename, join } from 'path'
import { Worker } from 'worker_threads'
import { msg, tr } from '../shared/i18n'
import type { RepoLockHolder } from './repoLockCore'
import type { LockReply, LockRequest, TakeAnswer } from './repoLockWorker'
import { advanced } from './advanced'
import { toast } from './events'
import { withFileLock } from './fsutil'
import { git } from './git'
import { hiveError } from './hiveError'
import { commonDirSync } from './platform/git'
import { createLogger, userText } from './logger'
import { bundledScriptExists, workerHere, workerStarted } from './workerThreads'
import { REPO_LOCK_FILE } from './repoLockCore'

const log = createLogger('repoLock')

/**
 * The repository lock, as Hive's merges and ref moves take it (#1347, SPEC §16.9.3): across processes (repoLockCore.ts),
 * and within this one by withFileLock on the same file, so this Hive never waits on itself. Taken by the Git view's
 * folder actions (gitRepo.ts), a worktree's merge (the Merge dialog, agents' merges: projectAgents.ts) and the line
 * updater's move (gitPlatform.ts); later the merge queue's advance. Held for seconds: never across a test merge or merge
 * checks. No off switch: it is data safety (§16.6.4). Its takes and releases run in the lock's worker (HI-1680,
 * repoLockWorker.ts): their SQLite commits fsync, and on main's thread a burst of them (the line updater after a merge)
 * held up typing.
 */

type Body = LockRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never
interface Call {
  resolve: (v: TakeAnswer | null) => void
  reject: (e: Error) => void
  onWait?: (h: RepoLockHolder) => void
}

/** The lock's worker, started with the first take; in unit tests (no build), its code runs here. */
class LockThread {
  private worker: Worker | null = null
  private inProcess: ((m: LockRequest, post: (r: LockReply) => void) => Promise<TakeAnswer | null>) | null = null
  private calls = new Map<number, Call>()
  private next = 0

  async ask(body: Body, onWait?: (h: RepoLockHolder) => void): Promise<TakeAnswer | null> {
    const send = await this.transport()
    const id = ++this.next
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject, onWait })
      send({ ...body, id } as LockRequest)
    })
  }

  private async transport(): Promise<(m: LockRequest) => void> {
    if (this.worker) return (m) => this.worker!.postMessage(m)
    if (!this.inProcess && !bundledScriptExists(lockWorkerScript())) {
      workerHere('repository lock', "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
      this.inProcess = (await import('./repoLockWorker')).handleRequest
    }
    if (this.inProcess) {
      const run = this.inProcess
      const reply = (r: LockReply): void => this.reply(r)
      return (m) =>
        void run(m, reply).then(
          (value) => reply({ id: m.id, ok: true, value }),
          (e: unknown) => reply({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
        )
    }
    const w = new Worker(lockWorkerScript())
    this.worker = w
    workerStarted('repository lock', w) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
    w.on('message', (r: LockReply) => this.reply(r))
    const gone = (why: string): void => {
      if (this.worker !== w) return
      this.worker = null
      // Its connections closed with it: a lock it held stays this process's row, released by its token (or taken
      // over by this process's next take, as a leftover of its own), and a take under way is refused.
      log.warn(`the repository lock's worker ended (${why}); it starts again with the next take`)
      for (const c of this.calls.values()) c.reject(new Error(`The repository lock's worker ended (${why})`)) // i18n-ignore: an internal error, for the log
      this.calls.clear()
    }
    w.on('error', (e: Error) => gone(e.message))
    w.on('exit', (code) => gone(`exit code ${code}`)) // i18n-ignore: for the log
    w.unref()
    return (m) => w.postMessage(m)
  }

  private reply(r: LockReply): void {
    if ('slow' in r) {
      // Off main's thread now: what the disk was like, for the log.
      log.info(`the repository lock's ${r.slow.step} took ${Math.round(r.slow.ms)} ms in its worker (${userText(r.slow.dir)})`)
      return
    }
    const c = this.calls.get(r.id)
    if (!c) return
    if ('waiting' in r) return c.onWait?.(r.waiting)
    this.calls.delete(r.id)
    if (r.ok) c.resolve(r.value)
    else c.reject(new Error(r.error))
  }
}

/** The worker's script, beside main's (inside the asar, as the usage worker's); a test's build of it (`useLockWorker`). */
let scriptForTests: string | null = null
const lockWorkerScript = (): string => scriptForTests ?? join(__dirname, 'repo-lock-worker.js')

let thread = new LockThread()

/** Tests: the lock's worker from this script (a build of repoLockWorker.ts), or null for the default; a new thread. */
export function useLockWorker(file: string | null): void {
  scriptForTests = file
  thread = new LockThread()
}

/** How long a merge waits for another Hive's (Settings → Advanced). */
export const REPO_LOCK_WAIT = 'hive.merge.lockWaitSeconds'
/** How long a wait goes before the user is told who holds the lock. */
const NOTICE_AFTER_MS = 1000

const profile = (): string => {
  try {
    return basename(app.getPath('userData'))
  } catch {
    // No profile folder: the name alone.
    return 'profile'
  }
}

/**
 * The repository's common git dir (its worktrees share it), absolute and real (one spelling for this Hive's own lock,
 * however the folder was reached); throws when git can't say. Read from `.git` with no git process where it says
 * (HI-1970: every line move asked it), else git's answer.
 */
export async function commonGitDir(folder: string): Promise<string> {
  const known = commonDirSync(folder)
  const r = known ? null : await git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const dir = known ?? (r?.ok ? r.out.trim() : '')
  if (dir) return realpath(dir).catch(() => dir)
  throw hiveError(msg({ id: 'git.repoLock.noGitDir', defaultMessage: "Combwork couldn't find the git folder of {folder}, so nothing was changed: {why}", description: "An error: a merge or another change to a repository didn't start, because git couldn't name the repository's git folder (where Hive's merge lock lives). {why} is git's message." }), { folder, why: r?.err || r?.out || '' }, { kind: 'conflict' })
}

export interface RepoLockOptions {
  /** A background change (the line updater): no notice while it waits. */
  quiet?: boolean
  /** The project the notice is about. */
  project?: string
}

/**
 * Runs fn holding the repository lock of `folder`'s repository. A wait longer than a moment shows who holds it ("Another
 * Hive is merging into this repository (Hive-Dev)"); one longer than the Advanced setting's bound gives up with that, the
 * lock staying the holder's (a live holder is never taken over), and nothing of fn runs.
 */
export async function withRepoLock<T>(folder: string, fn: () => Promise<T>, opts: RepoLockOptions = {}): Promise<T> {
  const dir = await commonGitDir(folder)
  return withFileLock(join(dir, REPO_LOCK_FILE), async () => {
    const waitSeconds = advanced.number(REPO_LOCK_WAIT)
    const onWait = (h: RepoLockHolder): void => {
      log.info(`Waiting for the repository lock of ${userText(folder)}, held by ${userText(h.profile)} (pid ${h.pid})`)
      if (!opts.quiet) toast('info', tr(msg({ id: 'git.repoLock.waiting', defaultMessage: 'Another Combwork is merging into this repository ({profile})', description: "A notification's title: this Hive waits to merge into (or change) a repository because another Hive (its profile folder's name, {profile}, e.g. Hive-Dev) holds the repository's merge lock." }), { profile: h.profile }), tr(msg({ id: 'git.repoLock.waitingFor', defaultMessage: 'Combwork waits for it to finish, up to {seconds, number} s.', description: 'The notification\'s text under "Another Hive is merging into this repository": how long this Hive waits for the other one, in seconds.' }), { seconds: waitSeconds }), undefined, opts.project)
    }
    const got = (await thread.ask({ type: 'take', dir, profile: profile(), waitMs: waitSeconds * 1000, noticeAfterMs: NOTICE_AFTER_MS }, onWait)) as TakeAnswer
    if ('timedOut' in got) {
      log.warn(`Gave up waiting for the repository lock of ${userText(folder)}, held by ${userText(got.timedOut.profile)} (pid ${got.timedOut.pid})`)
      throw hiveError(msg({ id: 'git.repoLock.busy', defaultMessage: 'Another Combwork is merging into this repository ({profile}). Nothing was changed: try again once it has finished.', description: "An error: a merge or another change to a repository didn't start, because another Hive (its profile folder's name, {profile}) still held the repository's merge lock after Hive had waited for it." }), { profile: got.timedOut.profile }, { kind: 'conflict' })
    }
    try {
      return await fn()
    } finally {
      try {
        // Released before the next take in this process begins (withFileLock is held until then).
        await thread.ask({ type: 'release', dir, token: got.token })
      } catch (e) {
        // Left behind, the row is this process's own: the next take here replaces it, and another Hive does once this one ends.
        log.warn(`releasing the repository lock of ${userText(folder)}`, e)
      }
    }
  })
}

/**
 * Runs fn holding the repository locks of several folders' repositories (#1642 round 5: a workflow options write, which
 * can change the target of every project it reaches, taken as Clean Up Merged Branches takes it, across Hives): each
 * repository once, always in the same order (its git folder's path), so no two takers wait on each other. A folder in
 * no repository takes none. Taken before the turn of workflow writes, as everything that takes both does.
 */
export async function withRepoLocks<T>(folders: readonly string[], fn: () => Promise<T>, opts: RepoLockOptions = {}): Promise<T> {
  const byDir = new Map<string, string>()
  for (const f of folders) {
    const dir = await commonGitDir(f).catch(() => null)
    if (dir && !byDir.has(dir.toLowerCase())) byDir.set(dir.toLowerCase(), f)
  }
  const order = [...byDir].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, f]) => f)
  const from = (i: number): Promise<T> => (i === order.length ? fn() : withRepoLock(order[i], () => from(i + 1), opts))
  return from(0)
}
