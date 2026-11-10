import { AsyncLocalStorage } from 'async_hooks'
import { existsSync } from 'original-fs'
import { app } from 'electron'
import { realpath } from 'original-fs/promises'
import { basename, join } from 'path'
import { Worker } from 'worker_threads'
import { msg, tr } from '../shared/i18n'
import type { RepoLockHolder } from './repoLockCore'
import type { LockReply, LockRequest, TakeAnswer } from './repoLockWorker'
import { advanced } from './advanced'
import { toast } from './events'
import { fileLockDepth, withFileLock } from './fsutil'
import { git } from './git'
import { combworkError } from './combworkError'
import { commonDirSync } from './platform/git'
import { gitVeto } from './platform/repoBoundary'
import { createLogger, userText } from './logger'
import { bundledScriptExists, workerHere, workerStarted } from './workerThreads'
import { REPO_LOCK_FILE } from './repoLockCore'
import type { RepoLockOptions } from './platform/repoContext'

const log = createLogger('repoLock')

/**
 * The repository lock, as Combwork's merges and ref moves take it (#1347, SPEC §16.9.3): across processes (repoLockCore.ts),
 * and within this one by withFileLock on the same file, so this Combwork never waits on itself. Taken by the Git view's
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

/** How long a merge waits for another Combwork's (Settings → Advanced). */
export const REPO_LOCK_WAIT = 'cw.merge.lockWaitSeconds'
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
 * The repository's common git dir (its worktrees share it), absolute and real (one spelling for this Combwork's own lock,
 * however the folder was reached); throws when git can't say. Read from `.git` with no git process where it says
 * (HI-1970: every line move asked it), else git's answer.
 */
export async function commonGitDir(folder: string): Promise<string> {
  const known = commonDirSync(folder)
  // Never git's answer for a folder a nearer non-colocated `.jj` holds (HI-2896, s13 §1): git would name a repository
  // above it, or none; an unreadable `.jj` is refused the same way.
  // A `.git` read here with a `.jj` beside it is asked of the boundary too (HR1's round 1): a valid jj repository naming
  // another store is unknown, not Git's.
  const veto = known && !existsSync(join(folder, '.jj')) ? null : await gitVeto(folder)
  if (veto) throw combworkError(msg({ id: 'git.repoLock.jjFolder', defaultMessage: "{folder} is in a jj repository that isn't colocated with Git, so Combwork didn't run git there: nothing was changed.", description: 'An error (HI-2896): a change that needs a Git repository was asked of a folder a jj (Jujutsu) repository with no Git working copy holds; git there would reach another repository or none. Keep jj and Git.' }), { folder }, { kind: 'conflict' })
  const r = known ? null : await git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const dir = known ?? (r?.ok ? r.out.trim() : '')
  if (dir) return realpath(dir).catch(() => dir)
  throw combworkError(msg({ id: 'git.repoLock.noGitDir', defaultMessage: "Combwork couldn't find the git folder of {folder}, so nothing was changed: {why}", description: "An error: a merge or another change to a repository didn't start, because git couldn't name the repository's git folder (where Combwork's merge lock lives). {why} is git's message." }), { folder, why: r?.err || r?.out || '' }, { kind: 'conflict' })
}

/** `quiet`: a background change (the line updater), no notice while it waits; `project`: the project the notice is about. */
export type { RepoLockOptions } from './platform/repoContext'

/**
 * Runs fn holding the repository lock of `folder`'s repository. A wait longer than a moment shows who holds it ("Another
 * Combwork is merging into this repository (Combwork-Dev)"); one longer than the Advanced setting's bound gives up with that, the
 * lock staying the holder's (a live holder is never taken over), and nothing of fn runs.
 */
export async function withRepoLock<T>(folder: string, fn: () => Promise<T>, opts: RepoLockOptions = {}): Promise<T> {
  const dir = await commonGitDir(folder)
  return takeStores([{ store: dir, folder }], fn, opts)
}

/**
 * The repository locks one async context is inside (HI-2896, design s13 §2 and s16 §1, HR1's): each physical take is an
 * owner, live from its last lock taken until just before its first release. A nested take runs straight through for a
 * store only a *live* inherited owner holds: an async continuation that outlives its take (its owner no longer live)
 * takes the lock again like anyone else, never riding another holder's.
 */
interface StoreOwner {
  readonly keys: ReadonlySet<string>
  live: boolean
  /**
   * The callbacks admitted on this owner's claim (HI-2896/s104, HR1's round 2): the owner keeps its locks, and stays
   * live, until each has settled, so none runs on a store another holder has taken.
   */
  readonly dependents: Set<Promise<unknown>>
  /** A folder of its first store, for the log. */
  readonly folder: string
}
const owners = new AsyncLocalStorage<readonly StoreOwner[]>()

/** The stores this async context holds now, by key (its live owners'). */
export const heldStoreKeys = (): Set<string> => new Set((owners.getStore() ?? []).filter((o) => o.live).flatMap((o) => [...o.keys]))

/** A store's key, as every take compares them (platformFence's storeKey: separators one way, case folded). */
export const storeKeyOf = (store: string): string => store.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/**
 * Runs fn holding the repository locks of `stores` (each a Git dir: a common git dir, or jj's store), whatever platform
 * names them (s13 §2): each store once by its key (callers resolve real paths, as commonGitDir and J0 do), in the key's
 * order, so no two takers in this process or another wait on each other. A store this context already holds (a live
 * owner's) runs straight through. A nested take of a store ordered before one it holds can't wait (it would hold and wait
 * out of order): it takes the lock only if it is free at once, else refuses.
 */
export async function takeStores<T>(stores: readonly { store: string; folder: string }[], fn: () => Promise<T>, opts: RepoLockOptions = {}): Promise<T> {
  // A take whose inherited claim expired while it waited for its own locks is made again from the start (HR1's round 1
  // on HI-2896): owners only ever stop being live, so this ends once every store it needs is held by it or a live owner.
  for (;;) {
    const r = await takeOnce(stores, fn, opts)
    if (r !== RETAKE) return r as T
  }
}

/** takeOnce's answer when a store it relied on an inherited owner for was released while it waited: nothing of fn ran. */
const RETAKE: unique symbol = Symbol('retake')

async function takeOnce<T>(stores: readonly { store: string; folder: string }[], fn: () => Promise<T>, opts: RepoLockOptions): Promise<T | typeof RETAKE> {
  const inherited = owners.getStore() ?? []
  const held = heldStoreKeys()
  const byKey = new Map<string, { store: string; folder: string }>()
  // The stores this take leaves to a live inherited owner: each checked again right before fn runs.
  const relied = new Set<string>()
  for (const s of stores) {
    const k = storeKeyOf(s.store)
    if (held.has(k)) relied.add(k)
    else if (!byKey.has(k)) byKey.set(k, s)
  }
  /**
   * fn admitted (s104): in one tick, the live inherited owner of each store this take relies on found (else RETAKE: one
   * expired, maybe while this take waited for its own locks), fn started in `ctx`, and its promise pinned to each of those
   * owners, which keep their locks until it settles. Nothing is awaited between the check and the pins.
   */
  const admit = (ctx: readonly StoreOwner[]): Promise<T> | typeof RETAKE => {
    const pins = new Set<StoreOwner>()
    for (const k of relied) {
      const o = inherited.find((x) => x.live && x.keys.has(k))
      if (!o) return RETAKE
      pins.add(o)
    }
    // Its completion registered before fn is invoked (HR1's s104 answer): a synchronous throw settles and unpins it too.
    // It always resolves (never rejects), so nothing is left unhandled; the caller keeps fn's own outcome.
    let finished!: () => void
    const completion = new Promise<void>((r) => (finished = r))
    for (const o of pins) {
      o.dependents.add(completion)
      void completion.then(() => void o.dependents.delete(completion))
    }
    let p: Promise<T>
    try {
      p = owners.run(ctx, fn)
    } catch (e) {
      finished()
      throw e
    }
    p.then(finished, finished)
    return p
  }
  if (!byKey.size) return admit(inherited)
  const keys = [...byKey.keys()].sort()
  const top = [...held].sort().pop()
  const owner: StoreOwner = { keys: new Set(keys), live: true, dependents: new Set(), folder: byKey.get(keys[0])!.folder }
  const inner = async (): Promise<T | typeof RETAKE> => {
    try {
      const run = admit([...inherited, owner])
      return run === RETAKE ? RETAKE : await run
    } finally {
      // Every callback admitted on this claim settled first (s104); then, in the tick that finds none left, no longer
      // live, before the first lock is released: a continuation that runs later takes the lock again.
      const slow = owner.dependents.size ? setTimeout(() => log.warn(`A callback started under the repository lock of ${userText(owner.folder)} still runs 30 s after its holder finished: the lock is kept until it ends`), 30_000) : null
      slow?.unref?.()
      for (;;) {
        if (!owner.dependents.size) {
          owner.live = false
          break
        }
        await Promise.allSettled([...owner.dependents])
      }
      if (slow) clearTimeout(slow)
    }
  }
  const from = (i: number): Promise<T | typeof RETAKE> => {
    if (i === keys.length) return inner()
    const s = byKey.get(keys[i])!
    // Ordered before a store held outside this take: never waited for (s13 §2's order rule).
    const noWait = top !== undefined && keys[i] < top
    return physicalLock(s.store, s.folder, () => from(i + 1), opts, noWait)
  }
  try {
    return await from(0)
  } finally {
    owner.live = false
  }
}

/** Runs fn holding the locks of contexts' stores (s13 §2: whatever platform named them, one owner, one order). */
export function withStoreLocks<T>(ctxs: readonly { store: string; folder: string }[], fn: () => Promise<T>, opts: RepoLockOptions = {}): Promise<T> {
  return takeStores(ctxs, fn, opts)
}

/** A nested take out of the stores' order, its lock held elsewhere (s13 §2): refused rather than waited for. */
function lockOrderError(folder: string): Error {
  log.warn(`A repository lock of ${userText(folder)} was asked for out of order while it was held elsewhere: refused, not waited for`)
  return combworkError(msg({ id: 'git.repoLock.order', defaultMessage: 'This repository is busy with another change. Nothing was changed: try again in a moment.', description: "An error (HI-2896): a change needed a repository's lock while holding another repository's, and the lock was held by another change; Combwork refuses rather than waiting, so the two can't wait on each other." }), undefined, { kind: 'conflict' })
}

/** One store's lock, across processes (the core's row) and in this one (withFileLock on its file). */
async function physicalLock<T>(dir: string, folder: string, fn: () => Promise<T>, opts: RepoLockOptions, noWait: boolean): Promise<T> {
  const file = join(dir, REPO_LOCK_FILE)
  // Out of order: taken only if no take in this process has it or waits for it (JS runs this check and the take at once).
  if (noWait && fileLockDepth(file) > 0) throw lockOrderError(folder)
  return withFileLock(file, async () => {
    const waitSeconds = noWait ? 0 : advanced.number(REPO_LOCK_WAIT)
    const onWait = (h: RepoLockHolder): void => {
      log.info(`Waiting for the repository lock of ${userText(folder)}, held by ${userText(h.profile)} (pid ${h.pid})`)
      if (!opts.quiet) toast('info', tr(msg({ id: 'git.repoLock.waiting', defaultMessage: 'Another Combwork is merging into this repository ({profile})', description: "A notification's title: this Combwork waits to merge into (or change) a repository because another Combwork (its profile folder's name, {profile}, e.g. Combwork-Dev) holds the repository's merge lock." }), { profile: h.profile }), tr(msg({ id: 'git.repoLock.waitingFor', defaultMessage: 'Combwork waits for it to finish, up to {seconds, number} s.', description: 'The notification\'s text under "Another Combwork is merging into this repository": how long this Combwork waits for the other one, in seconds.' }), { seconds: waitSeconds }), undefined, opts.project)
    }
    const got = (await thread.ask({ type: 'take', dir, profile: profile(), waitMs: waitSeconds * 1000, noticeAfterMs: NOTICE_AFTER_MS }, onWait)) as TakeAnswer
    if ('timedOut' in got && noWait) throw lockOrderError(folder)
    if ('timedOut' in got) {
      log.warn(`Gave up waiting for the repository lock of ${userText(folder)}, held by ${userText(got.timedOut.profile)} (pid ${got.timedOut.pid})`)
      throw combworkError(msg({ id: 'git.repoLock.busy', defaultMessage: 'Another Combwork is merging into this repository ({profile}). Nothing was changed: try again once it has finished.', description: "An error: a merge or another change to a repository didn't start, because another Combwork (its profile folder's name, {profile}) still held the repository's merge lock after Combwork had waited for it." }), { profile: got.timedOut.profile }, { kind: 'conflict' })
    }
    try {
      return await fn()
    } finally {
      try {
        // Released before the next take in this process begins (withFileLock is held until then).
        await thread.ask({ type: 'release', dir, token: got.token })
      } catch (e) {
        // Left behind, the row is this process's own: the next take here replaces it, and another Combwork does once this one ends.
        log.warn(`releasing the repository lock of ${userText(folder)}`, e)
      }
    }
  })
}

/**
 * Runs fn holding a lock of the same kind in another folder (HI-2462: the folder move's, `<workspace>\.combwork-move.lock`):
 * across processes by the core's row, in this one by withFileLock on its file. A live holder in another process isn't
 * waited for beyond `waitMs`: `busy` is called with it and its answer thrown, and nothing of fn runs. The file stays
 * after the release (its row gone): a lock's file is never removed, so every contender opens the same one.
 */
export async function withNamedLock<T>(dir: string, file: string, fn: () => Promise<T>, o: { waitMs: number; busy: (h: RepoLockHolder) => Error }): Promise<T> {
  return withFileLock(join(dir, file), async () => {
    const got = (await thread.ask({ type: 'take', dir, profile: profile(), waitMs: o.waitMs, noticeAfterMs: o.waitMs + 1, file })) as TakeAnswer
    if ('timedOut' in got) throw o.busy(got.timedOut)
    try {
      return await fn()
    } finally {
      try {
        await thread.ask({ type: 'release', dir, token: got.token, file })
      } catch (e) {
        log.warn(`releasing the lock ${userText(join(dir, file))}`, e)
      }
    }
  })
}

/**
 * Runs fn holding the repository locks of several folders' repositories (#1642 round 5: a workflow options write, which
 * can change the target of every project it reaches, taken as Clean Up Merged Branches takes it, across Combworks): each
 * repository once, always in the same order (its git folder's path), so no two takers wait on each other. A folder in
 * no repository takes none. Taken before the turn of workflow writes, as everything that takes both does.
 */
export async function withRepoLocks<T>(folders: readonly string[], fn: () => Promise<T>, opts: RepoLockOptions = {}): Promise<T> {
  const found: { store: string; folder: string }[] = []
  for (const f of folders) {
    // A folder in no repository takes none; one a nearer non-colocated `.jj` holds is refused (HI-2896), never skipped.
    if (!commonDirSync(f) && (await gitVeto(f))) await commonGitDir(f)
    const dir = await commonGitDir(f).catch(() => null)
    if (dir) found.push({ store: dir, folder: f })
  }
  return takeStores(found, fn, opts)
}

/**
 * The folders to lock for these stores (HI-2784: withRepoLocks's, and the repository context port's): each store once,
 * by the first folder naming it, sorted by the store's path compared case-insensitively, the order every taker uses.
 */
export function inStoreOrder(found: readonly { store: string; folder: string }[]): string[] {
  const byDir = new Map<string, string>()
  for (const { store, folder } of found) if (!byDir.has(store.toLowerCase())) byDir.set(store.toLowerCase(), folder)
  return [...byDir].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, f]) => f)
}

/** Runs fn holding each folder's repository lock, taken in the order given (inStoreOrder's). */
export function withLocksInOrder<T>(order: readonly string[], fn: () => Promise<T>, opts: RepoLockOptions = {}): Promise<T> {
  const from = (i: number): Promise<T> => (i === order.length ? fn() : withRepoLock(order[i], () => from(i + 1), opts))
  return from(0)
}
