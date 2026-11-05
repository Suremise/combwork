// The merge queue's runner (#1360, SPEC §16.9.3): exactly one per project and target across every Hive on the workspace
// (the dev and the installed one share its combwork.db). A runner holds the target's lease (queue_runners); another Hive
// takes it over only once the holder *process* is gone (its pid gone, or given to a process that started at another
// time), never because its renewals stopped: a stalled but living Hive keeps its queue (the panel says "run by
// <profile>"), so a living runner is never fenced out of a checkout it may still be writing.
//
// Process ownership: each lease has a Windows job object on Hive's process supervisor (processSupervisor.ts, shared
// with agents; queueJobs.ts), which dies with its Hive, and closing the job ends everything in it. Every command starts
// through a launcher that is put in the job and recorded before the command exists: so no process of the runner's,
// however started (a shell's detached server), outlives the job, and none runs unrecorded. What escapes a job anyway (a
// packaged app's children) the supervisor follows, writing each to the lease's journal before it follows it, and ends
// one it can't write down. The records (queue_runner_procs: the lease's job, its launchers) and the journal are duties
// per target: a release, or the next runner to take the target's lease, ends the jobs (by name, never the supervisor
// holding them) and the processes they name, and drops them only once all are seen gone; until then they stay, whoever
// crashes meanwhile, and the queue pauses ("needs you", with the pid) rather than run beside a writer it couldn't end.
// A lease's folders are removed only once its duties are done.
//
// Every store write the queue makes checks the lease inside that write (`withWriteFence`, MergeQueue's `holds`): a
// runner that no longer holds stops at once, writing nothing. A target's worktree is kept while the queue needs it
// (queueFolderNeeded): a released runner leaves it for the next.

import { type ChildProcess, type SpawnOptions } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { existsSync } from 'original-fs'
import { basename, dirname, join } from 'path'
import { removePath, samePlace } from '../fsutil'
import { access } from 'original-fs/promises'
import { git, GIT_PREFIX, withoutGitRoute } from '../git'
import { onOutputSettled, withLauncherEnv, type GitOutcome, type GitRequest } from '../gitWorker'
import { gitExe, gitExeGone, PATH_GIT, type GitExe } from '../gitTool'
import { createLogger, userText } from '../logger'
import { endTree } from '../progressReporters/wrapper'
import { withoutWriteFence, type FactStore, type QueueLease, type QueueProc, type QueueProcKind } from './factStore'
import type { JobHost } from '../processSupervisor'
import { clearJournal, endLeaseJob, journalOf, journalPath, launcherNotStarted, launcherSignalled, LeaseJob, queueHost, sealJournal, SIGNALLED, startLauncher, type Journalled } from './queueJobs'
import { defaultProbe, treeOf, type Listed, type ProcessProbe } from './queueProcs'
import { GitHost, startGitHost, type HostResult } from './gitHost'
import type { Workflow } from './runtime'

/** What a launcher is recorded as (its git host as `testMerge`, as the launchers of its git were). */
type Launched = Exclude<QueueProcKind, 'job'>

const log = createLogger('queue')

/** How often a runner notes itself as seen (display only: never a reason to take a lease over). */
export const RENEW_MS = 30_000
/** How long a takeover waits for the processes it ended to be gone. */
const END_WAIT_MS = 15_000
/** A recorded launcher's start may be this far outside the clock readings around it (clock resolution). */
const START_SLACK_MS = 50

/** The runner no longer holds its target's lease (another Hive took it over): it stops, writing nothing. */
export class LeaseLost extends Error {
  constructor(readonly target: string) {
    super(`the merge queue for ${target} is run by another Combwork now`) // i18n-ignore: an internal error, caught by the queue's host and logged
  }
}

export interface RunnerConfig {
  store: FactStore
  /** Hive's process supervisor (the app passes agents', processSupervisor()); left out, the queue's own (queueHost). */
  host?: JobHost
  /** The workspace folder: its runners are released as it closes. */
  workspace?: string
  /** The project folder (its repository). */
  project: string
  target: string
  /** Where the project's Hive worktrees go (`<workspace>.worktrees/<project>`): the runner's folder is made there. */
  root: string
  /** This Hive's profile, as the panel names a runner ("run by Hive-Dev"). */
  profile: string
  /** Runs a write under the lock its store needs (the app's boardWrite, as WorkflowConfig.locked); left out, as it is. */
  locked?: <T>(fn: () => T) => Promise<T>
  probe?: ProcessProbe
  /** Whether the target's queue still needs its folder (queueFolderNeeded); left out, it doesn't once released. */
  needed?: () => Promise<boolean>
  renewMs?: number
  /**
   * Test seams. `renew`: false skips a renewal (a Hive stalled for as long as a test wants). `lingeringJob`: the
   * supervisor outlives this process (a Hive whose helper survived it). `beforeSettle`: runs as a takeover begins on a
   * dead runner's duties. `endJob`: false makes ending a job fail (a job that won't empty). `journalDir`: where the
   * jobs' journals go (a folder that can't be written, for a journal that fails). `afterSeal`, `beforeClear`: run as a
   * takeover has sealed the earlier runners' journals, and just before it drops their duties (a late write, then).
   * `beforeHostSend` (HI-2079): runs between a git's lease read and its sending to the git host (a takeover then).
   */
  hooks?: { renew?: () => boolean; lingeringJob?: boolean; beforeSettle?: () => Promise<void>; afterSeal?: () => Promise<void>; beforeClear?: () => Promise<void>; endJob?: () => boolean; journalDir?: string; beforeHostSend?: () => Promise<void> }
}

/** Who holds a target's lease, as the panel shows it. */
export interface Holder {
  profile: string
  pid: number
  renewedAt: string
}

/**
 * `paused`: the runner holds the lease but a process an earlier runner left couldn't be ended (its pid): the queue is
 * paused, needs you, and nothing runs. `problem`: no runner could be set up (its job: PowerShell refused).
 */
export type Acquired = { ok: true; runner: QueueRunner; paused?: number } | { ok: false; heldBy: Holder | null; problem?: string }

/** A command's run: its output and exit code, as git()'s result. */
export interface RunResult {
  ok: boolean
  code: number
  out: string
  err: string
  /** Ended at its bound (`run`'s timeoutMs): its whole tree. */
  timedOut?: boolean
  /** Its stderr as far as it had come when the bound ended it (#1350: what was running then). */
  errAtTimeout?: string
  /**
   * HI-2020: the command never started, Node's code for why: its launcher couldn't start, or the launcher said (by its
   * nonce) that the command's own start failed. Code -1 then. Never set for a command that started, whatever its exit.
   */
  notRun?: string
  /**
   * HI-2042: the command (or its launcher) was ended by a signal, as Node saw it: its name. Code -1 then, never 1 (which
   * git's reads take for "no"). Not set for a command that exited with a code of its own, nor one ended at its bound.
   * On Windows a process ended from outside (TerminateProcess) exits with the code it was given: that is no signal.
   * HI-2054: Hive's own ending of a runner's job comes after `stop()` (release): a queue command run through the runner
   * can't start the next one then (LeaseLost), and the queue's later store writes are refused (its write fence), so its
   * exit 1 can't become a recorded answer. One another program ends (Task Manager, an antivirus) can't be told apart.
   */
  signal?: string
}

/** HI-2042: what a run ended by a signal says when the command itself said nothing. */
export const endedBy = (command: string, signal: string): string => `${command} was ended by a signal (${signal})` // i18n-ignore: the command's side of an error, in English as git's messages are

/** HI-2020: a launcher that never started (no pid): the start's own error. Only `run` takes it for a result. */
class NotStarted extends Error {
  constructor(readonly start: Error) {
    super(start.message)
  }
}

/** A queue's folder name: collision-safe for targets alike (`a/b`, `a-b`) and per lease, so a takeover never reuses one. */
export function queueFolderName(project: string, target: string, lease: string): string {
  return `queue-${createHash('sha256').update(`${project.toLowerCase()}\0${target}`).digest('hex').slice(0, 12)}-${lease}`
}

/** Whether a folder is one of the queue's (named as queueFolderName makes them) directly in a root: what clean-up may remove. */
export function isQueueFolder(root: string, folder: string): boolean {
  return /^queue-[0-9a-f]{12}-[0-9a-f]+$/.test(basename(folder)) && samePlace(dirname(folder), root)
}

const live = new Set<QueueRunner>()
const selves = new WeakMap<ProcessProbe, Promise<{ pid: number; started: number }>>()
const selfOf = (probe: ProcessProbe): Promise<{ pid: number; started: number }> => {
  let s = selves.get(probe)
  if (!s) selves.set(probe, (s = probe.self()))
  return s
}

const holderOf = (l: QueueLease): Holder => ({ profile: l.profile, pid: l.pid, renewedAt: l.renewedAt })

export class QueueRunner {
  private released = false
  /** HI-2079: its git host went or misbehaved: nothing starts and no fenced write commits from then on; it releases. */
  private broken = false
  /** The release under way (or done): one, whoever asks for it (a failure, the host's run ending). */
  private releasing: Promise<void> | null = null
  /** HI-2079: its git host, once started (one per lease), and the start under way. */
  private gitHost: GitHost | null = null
  private hostStart: Promise<GitHost | HostResult> | null = null
  private timer: NodeJS.Timeout | null = null
  private job: LeaseJob | null = null
  private host: JobHost | null = null
  private unwatch: (() => void) | null = null
  private readonly probe: ProcessProbe

  private constructor(
    readonly cfg: RunnerConfig,
    readonly lease: string,
    private readonly token: string,
    private dir: string
  ) {
    this.probe = cfg.probe ?? defaultProbe()
  }

  get project(): string {
    return this.cfg.project
  }

  get target(): string {
    return this.cfg.target
  }

  /**
   * Takes the target's lease: when no runner holds it, or from one whose process is gone (a takeover). A holder that
   * runs, or whose process can't be checked, keeps it: `heldBy` says who. Taken, the runner starts its job, then settles
   * every earlier runner's duties for the target (`settle`) before it is returned.
   */
  static async acquire(cfg: RunnerConfig): Promise<Acquired> {
    const probe = cfg.probe ?? defaultProbe()
    const me = await selfOf(probe)
    const store = cfg.store
    for (let tries = 0; tries < 3; tries++) {
      const now = store.queueLease(cfg.target)
      if (now) {
        // This process holds it (another runner of its own, still running): never taken from itself.
        if (now.pid === me.pid && (now.started === me.started || !now.started || !me.started)) return { ok: false, heldBy: holderOf(now) }
        if ((await probe.alive(now.pid, now.started)) !== false) return { ok: false, heldBy: holderOf(now) }
      }
      const lease = randomBytes(8).toString('hex')
      const token = randomBytes(16).toString('hex')
      const at = new Date().toISOString()
      const taken = await locked(cfg, () => store.takeQueueLease({ target: cfg.target, lease, token, profile: cfg.profile, pid: me.pid, started: me.started, takenAt: at, renewedAt: at }, now?.token ?? null))
      // Another Hive took or freed it meanwhile: looked at again.
      if (!taken) continue
      if (now) log.info(`Took over the merge queue for ${userText(cfg.target)} from ${userText(now.profile)} (process ${now.pid} has ended)`)
      const runner = new QueueRunner(cfg, lease, token, join(cfg.root, queueFolderName(cfg.project, cfg.target, lease)))
      try {
        const problem = await runner.startJob()
        if (problem) {
          log.warn(`The merge queue for ${userText(cfg.target)} can't run: its job couldn't be made (${userText(problem)})`)
          runner.stop()
          await locked(cfg, () => store.dropQueueLease(lease, token))
          return { ok: false, heldBy: null, problem }
        }
        live.add(runner)
        const paused = await runner.settle()
        await runner.settleFolders()
        runner.startRenewal()
        return { ok: true, runner, ...(paused !== null ? { paused } : {}) }
      } catch (e) {
        // A failed set-up (a write that failed, the lease lost) gives its lease up, by its own token (a successor's is
        // never touched), once its job is closed: a retry, in this Hive or another, can take it at once. Its job's duty
        // goes with it once closing it has ended what was in it (kill on close) and its journal holds nothing; else it
        // stays, for the next runner's settle.
        runner.stop()
        await runner.closeJob()
        await runner.forgetFailedJob().catch((x) => log.warn(`forgetting the merge queue's job for ${userText(cfg.target)} after a failed start`, x))
        await locked(cfg, () => store.dropQueueLease(lease, token)).catch((x) => log.warn(`giving up the merge queue's lease for ${userText(cfg.target)} after a failed start`, x))
        if (!(e instanceof LeaseLost)) throw e
        const h = store.queueLease(cfg.target)
        return { ok: false, heldBy: h ? holderOf(h) : null }
      }
    }
    const h = store.queueLease(cfg.target)
    return { ok: false, heldBy: h ? holderOf(h) : null }
  }

  /** The runner's own worktree (made by the queue's first test merge in it). */
  folder(): string {
    return this.dir
  }

  /** Whether this runner still holds its lease: inside a write, as that write sees it (so a fact it guards commits only while it does). */
  holds(): boolean {
    return !this.released && !this.broken && this.cfg.store.holdsQueueLease(this.lease, this.token)
  }

  /** HI-2079: its git host went or misbehaved, so it gave its lease up: its queue takes a new one (queueHost's runHost). */
  get failed(): boolean {
    return this.broken
  }

  /** Whether it may start something: its job made, not released, not failed. */
  private admits(): boolean {
    return !!this.job && !this.released && !this.broken
  }

  /** Throws LeaseLost unless the runner still holds its lease (inside a write: what it writes is then refused whole). */
  fence(): void {
    if (!this.holds()) throw new LeaseLost(this.target)
  }

  /** A write of the runner's own, fenced: done only while it holds its lease, as one write with that check. */
  private change<T>(fn: () => T): Promise<T> {
    return locked(this.cfg, () =>
      this.cfg.store.quiet(() => {
        this.fence()
        return fn()
      })
    )
  }

  /**
   * Records the lease's job as a duty of the target (`what = 'job'`, before it exists: whichever runner settles the
   * target ends it by name, never the supervisor holding it, which may be another Hive's, serving its other targets and
   * agents: HR4's round 3 finding 2), then makes it on the supervisor, kill on close, with its journal: each process it
   * follows is written there, durably, before it is followed (HR4's round 3 finding 1), and one it can't write is ended
   * at once and pauses the queue. A problem when it can't be made.
   */
  private async startJob(): Promise<string | null> {
    const host = this.cfg.host ?? queueHost({ linger: this.cfg.hooks?.lingeringJob })
    await this.change(() => this.cfg.store.addQueueProc({ lease: this.lease, target: this.target, pid: 0, startAfter: 0, startBefore: 0, what: 'job' }))
    const journal = await journalPath(this.cfg.root, this.lease, this.cfg.hooks?.journalDir)
    const job = await LeaseJob.open(host, this.lease, journal)
    if ('problem' in job) {
      await locked(this.cfg, () => this.cfg.store.dropQueueProc(this.lease, 0))
      return job.problem
    }
    this.host = host
    this.job = job
    this.unwatch = host.onUnowned((lease, pid) => {
      if (lease !== this.lease) return
      log.warn(`The merge queue's job for ${userText(this.target)} found process ${pid} outside it and couldn't record it, so ended it`)
      void this.pauseFor(pid).catch((e) => log.warn('pausing the merge queue for a process it could not record', e))
    })
    return null
  }

  /** HI-2079: its git host's process id while it has one (tests: to end it as a crash would). */
  get gitHostPid(): number | null {
    return this.gitHost?.pid ?? null
  }

  /** The supervisor's process id (tests: to end a lingering one). */
  get supervisorPid(): number | null {
    return this.host?.pid ?? null
  }

  /** Tests only: the job follows a process, as the supervisor follows a packaged app's (refused outside tests). */
  followForTests(pid: number): Promise<unknown> {
    return this.job ? this.job.follow(pid) : Promise.resolve(null)
  }

  /** Lets the lease's job go (closing it ends anything left in it, kill on close) and stops watching it. */
  private async closeJob(): Promise<void> {
    this.unwatch?.()
    this.unwatch = null
    const job = this.job
    this.job = null
    await job?.close()
  }

  /**
   * Starts a command of the runner's (an install, a check, git) inside its job: its launcher is put in the job and
   * recorded (in a write that checks the lease) before the command exists, and told to run it only then. Throws, with
   * nothing run, when the runner no longer holds (LeaseLost), its job has gone, or the launcher couldn't be put in the
   * job or recorded. The child is the launcher: its output and exit code are the command's.
   */
  async spawn(what: Launched, command: string, args: readonly string[], opts: Pick<SpawnOptions, 'cwd' | 'env' | 'shell' | 'windowsVerbatimArguments'> & { input?: string } = {}): Promise<ChildProcess> {
    const { child, failed } = this.launch(what, command, args, opts)
    // Not started: nothing to record or end; the start's own error (it is told on the next tick), marked as a start that
    // definitely failed (HI-2020), apart from the lease, the job or the record failing.
    if (!child.pid) throw new NotStarted(await failed)
    await this.letGo(what, child, command, opts.input)
    return child
  }

  /**
   * `spawn` in Node's own shape (#1349's checks start their processes so, `QueueConfig.runCheck`): the launcher is given
   * back at once, and told to run the command once it is in the job and recorded, as `spawn` does; until then it runs
   * nothing, and one that can't be put there or recorded ends having run nothing (its exit code is not 0). Throws LeaseLost
   * at once once the runner no longer holds.
   */
  spawnNow(what: Launched, command: string, args: readonly string[], opts: Pick<SpawnOptions, 'cwd' | 'env' | 'shell' | 'windowsVerbatimArguments'> = {}): ChildProcess {
    const { child } = this.launch(what, command, args, opts)
    if (child.pid) void this.letGo(what, child, command).catch((e) => log.warn(`starting the merge queue's ${what}`, e))
    return child
  }

  /** Starts a command's launcher, waiting for its go-ahead, with its errors handled from the start. */
  private launch(what: Launched, command: string, args: readonly string[], opts: Pick<SpawnOptions, 'cwd' | 'env' | 'shell' | 'windowsVerbatimArguments'>): { child: ChildProcess; failed: Promise<Error>; after: number; before: number } {
    if (!this.admits()) throw new LeaseLost(this.target)
    const { child, after, before, nonce } = startLauncher({ command, args, shell: !!opts.shell, verbatim: !!opts.windowsVerbatimArguments }, { cwd: opts.cwd as string | undefined, env: opts.env })
    this.nonces.set(child, nonce)
    // Its errors are handled here from the start (a start that failed: a folder gone, no executable; a pipe that broke),
    // never left to the process's: the first is the start's error, later ones are logged.
    let startError: Error | null = null
    const failed = new Promise<Error>((res) =>
      child.on('error', (e) => {
        if (!startError) res((startError = e))
        else log.warn(`the merge queue's ${what} process`, e)
      })
    )
    for (const st of [child.stdin, child.stdout, child.stderr]) st?.on('error', (e) => log.warn(`the merge queue's ${what} process's pipe`, e))
    this.started.set(child, { after, before })
    return { child, failed, after, before }
  }

  /** Clock readings around each launcher's start, until it is let go. */
  private readonly started = new WeakMap<ChildProcess, { after: number; before: number }>()
  /** Each launcher's nonce (HI-2020: how it says its command never started). */
  private readonly nonces = new WeakMap<ChildProcess, string>()

  /**
   * A launcher put in the job and recorded (a write that checks the lease), then told to run its command; one that can't
   * be is given up (it ends having run nothing) and the error thrown.
   */
  private async letGo(what: Launched, child: ChildProcess, command: string, input?: string): Promise<void> {
    const pid = child.pid!
    const { after, before } = this.started.get(child)!
    const giveUp = (): void => {
      // Never told to run: ending its input ends it, and one that started is ended too in case it is slow to see that.
      child.stdin?.end()
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill()
        } catch (e) {
          log.warn(`ending the merge queue's ${what} launcher`, e)
        }
      }
    }
    try {
      const job = this.job
      if (!job || !this.admits()) throw new LeaseLost(this.target)
      if (!(await job.assign(pid, after, before))) throw new Error(`${command} couldn't be put in the merge queue's job`) // i18n-ignore: as above
      await this.change(() => this.cfg.store.addQueueProc({ lease: this.lease, target: this.target, pid, startAfter: after, startBefore: before, what }))
    } catch (e) {
      giveUp()
      throw e
    }
    child.once('exit', () => {
      // The launcher's tree may live on (a detached server), in the job: the job, the lease's own duty, owns it.
      void forgetEnded(this.cfg, this.lease, pid).catch((e) => log.warn('forgetting a merge queue process that ended', e))
    })
    child.stdin!.write(`go\n${input ?? ''}`) // i18n-ignore: the launcher's go-ahead (queueJobs.ts), not text
    child.stdin!.end()
  }

  /**
   * Runs a command (spawn) to its end: its output and exit code. `timeoutMs`: once it has run that long its whole tree
   * is ended (#1350: a signer waiting for a passphrase), and the result says it timed out.
   */
  async run(what: Launched, command: string, args: readonly string[], opts: Pick<SpawnOptions, 'cwd' | 'env' | 'shell'> & { input?: string; timeoutMs?: number } = {}): Promise<RunResult> {
    const { timeoutMs, ...spawnOpts } = opts
    let child: ChildProcess
    try {
      child = await this.spawn(what, command, args, spawnOpts)
    } catch (e) {
      // HI-2020: a launcher that never started ran nothing: a result saying so. The lease lost, the job or the record
      // failing, and anything else stay thrown, as before.
      if (e instanceof NotStarted) return { ok: false, code: -1, out: '', err: e.start.message, notRun: String((e.start as NodeJS.ErrnoException).code ?? 'error') }
      throw e
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    let timedOut = false
    let atTimeout: string | undefined
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true
          atTimeout = Buffer.concat(err).toString('utf8')
          endTree(child)
        }, timeoutMs)
      : undefined
    // HI-2042: the launcher itself ended by a signal (no code) is kept as one, apart from its bound's.
    let ended = null as string | null
    const code = await new Promise<number>((res) => {
      // HI-2043: its output read whole, bounded once it has exited (its bound's end too: what it wrote meanwhile kept).
      // Its bound is on the launcher, not its output: one that exited in time is never timed out by output still open.
      child.once('exit', () => clearTimeout(timer))
      onOutputSettled(child, (c, s) => {
        ended = c === null ? (s ?? 'unknown') : null
        res(c ?? 1)
      })
      child.once('error', () => res(-1))
    })
    clearTimeout(timer)
    const stderr = Buffer.concat(err).toString('utf8').trim()
    // HI-2020: the launcher's own line (its nonce) when the command's start failed; a 127 without it is the command's.
    const nonce = this.nonces.get(child)
    const never = code === 127 && !timedOut && nonce ? launcherNotStarted(stderr, nonce) : null
    if (never) return { ok: false, code: -1, out: Buffer.concat(out).toString('utf8'), err: never.err, notRun: never.code }
    // HI-2042: the command ended by a signal (the launcher's line, by its nonce), or the launcher itself: never code 1.
    // Its bound comes first: a run it ended stays timed out, as before.
    const killed = !timedOut && nonce && code === SIGNALLED ? launcherSignalled(stderr, nonce) : null
    if (killed) return { ok: false, code: -1, out: Buffer.concat(out).toString('utf8'), err: killed.err || endedBy(command, killed.signal), signal: killed.signal }
    if (ended && !timedOut) return { ok: false, code: -1, out: Buffer.concat(out).toString('utf8'), err: stderr || endedBy(command, ended), signal: ended }
    return { ok: code === 0 && !timedOut, code, out: Buffer.concat(out).toString('utf8'), err: stderr, ...(timedOut ? { timedOut, errAtTimeout: atTimeout } : {}) }
  }

  /**
   * git in a folder of the runner's (its own worktree, or the project for a ref), as Hive runs git (GIT_PREFIX); `opts`
   * its environment and bound (the queue's merge commits, #1350; a push). HI-2079: one with no bound runs in the lease's
   * git host (no Node start of its own); a bounded one through `run`'s launcher, whose bound ends its tree. HI-2137: the
   * git Hive starts (gitExe), once more with PATH's when that one couldn't start.
   */
  git(cwd: string, args: string[], what: Launched = 'testMerge', opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<RunResult> {
    return this.gitAs(gitExe(), cwd, args, what, opts)
  }

  private async gitAs(use: GitExe, cwd: string, args: string[], what: Launched, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<RunResult> {
    const env = use.launcherEnv ? withLauncherEnv(opts.env ?? process.env, use.launcherEnv) : opts.env
    const r = opts.timeoutMs ? await this.run(what, use.exe, [...GIT_PREFIX, ...args], { cwd, ...opts, env }) : await this.hostGit(cwd, [...GIT_PREFIX, ...args], env ?? process.env, use.exe)
    // As git() does: the real git gone, this command once more with PATH's, whichever command found it gone first.
    if (r.notRun === 'ENOENT' && use.exe !== PATH_GIT.exe && existsSync(cwd)) {
      gitExeGone(use.exe)
      return this.gitAs(PATH_GIT, cwd, args, what, opts)
    }
    return r
  }

  /**
   * HI-2079: git in the lease's host, as `run` would tell it. Throws LeaseLost, with nothing sent, once the runner no
   * longer holds (released, failed, or its lease another's: read just before it is sent). A host that goes or misbehaves
   * fails the runner (`fail`): what was waiting is lost, never an answer (`signal: 'hostLost'`, HI-2054's again).
   */
  private async hostGit(cwd: string, args: string[], env: NodeJS.ProcessEnv, command: string): Promise<RunResult> {
    const r = await this.inHost({ command, args, cwd, env })
    if (!r) throw new LeaseLost(this.target)
    return toRunResult('git', r)
  }

  /**
   * HI-2078: the route of git() in the queue's run (withGitRoute, queueHost's runHost): each git its steps run (the
   * platform's reads too) in the lease's host, within git()'s bounds (the host ends it there), its outcome as the
   * worker's execFile gives it, so git() reads it as it reads the worker's. Once the runner no longer admits (released,
   * failed, its lease another's), nothing starts: an outcome that never ran (`leaseLost`), never an answer.
   */
  async gitOutcome(m: Omit<GitRequest, 'id'>): Promise<GitOutcome> {
    // As execFile checks its bound (the worker's path throws so too): a number, 0 or more (0: no output at all).
    if (typeof m.maxBuffer !== 'number' || Number.isNaN(m.maxBuffer) || m.maxBuffer < 0) throw Object.assign(new RangeError(`The value of "maxBuffer" is out of range. It must be >= 0. Received ${String(m.maxBuffer)}`), { code: 'ERR_OUT_OF_RANGE' }) // i18n-ignore: Node's own error, as execFile throws it
    // HI-2137: the git git() names (gitExe), with its PATH as the worker gives it.
    const env = m.launcherEnv ? withLauncherEnv(m.env ?? process.env, m.launcherEnv) : (m.env ?? process.env)
    const r = await this.inHost({ command: m.exe ?? 'git', args: m.args, cwd: m.cwd, env, ...(m.input !== undefined ? { input: m.input } : {}), maxBuffer: m.maxBuffer, ...(m.timeout ? { timeout: m.timeout } : {}) })
    return r ? outcomeOf(r, m.cwd) : { stdout: NO_BYTES, stderr: NO_BYTES, error: { code: 'leaseLost', killed: false, signal: null }, cwdExists: true }
  }

  /**
   * A request in the lease's git host, started first if need be; null, with nothing sent, once the runner doesn't admit
   * (released, failed, or its lease another's: read just before it is sent), checked again after every wait.
   */
  private async inHost(spec: Parameters<GitHost['request']>[0]): Promise<HostResult | null> {
    if (!this.admits()) return null
    let host: GitHost | HostResult
    try {
      host = this.gitHost ?? (await (this.hostStart ??= this.startHost().finally(() => (this.hostStart = null))))
    } catch (e) {
      if (e instanceof LeaseLost) return null
      throw e
    }
    if (!(host instanceof GitHost)) return host
    if (!this.admits() || this.gitHost !== host || !this.cfg.store.holdsQueueLease(this.lease, this.token)) return null
    await this.cfg.hooks?.beforeHostSend?.()
    if (!this.admits() || this.gitHost !== host) return null
    return host.request(spec)
  }

  /**
   * Starts the lease's git host, as a launcher starts (letGo): put in the job, recorded (a write that checks the lease),
   * and only then told to go, each step only while the runner still admits. One that couldn't start ran nothing: that
   * result, for the git that asked (HI-2020), and the next git tries again. Released meanwhile: LeaseLost, the host never
   * told to go (its input's end ends it, and it is in the job). Anything else fails the runner: no second host.
   */
  private async startHost(): Promise<GitHost | HostResult> {
    const { child, after, before } = startGitHost()
    const host = new GitHost(child, (why) => this.fail(`its git host ${child.pid ?? ''} stopped: ${why}`)) // i18n-ignore: a reason, logged
    if (!child.pid) {
      const start = await new Promise<Error>((res) => child.once('error', res))
      return { out: '', err: start.message, outBuf: NO_BYTES, errBuf: Buffer.from(start.message), code: null, notRun: String((start as NodeJS.ErrnoException).code ?? 'error') }
    }
    try {
      const job = this.job
      if (!job || !this.admits()) throw new LeaseLost(this.target)
      if (!(await job.assign(child.pid, after, before))) throw new Error("the merge queue's git host couldn't be put in its job") // i18n-ignore: an internal error, logged
      await this.change(() => this.cfg.store.addQueueProc({ lease: this.lease, target: this.target, pid: child.pid!, startAfter: after, startBefore: before, what: 'testMerge' }))
      if (!this.admits()) throw new LeaseLost(this.target)
    } catch (e) {
      host.close()
      if (child.exitCode === null && child.signalCode === null) child.kill()
      // Released meanwhile (its job gone with it): LeaseLost, as for any start then. Else the runner fails.
      if (this.released || e instanceof LeaseLost) throw new LeaseLost(this.target)
      this.fail(`its git host couldn't be started: ${(e as Error).message}`) // i18n-ignore: a reason, logged
      throw new LeaseLost(this.target)
    }
    child.once('exit', () => void forgetEnded(this.cfg, this.lease, child.pid!).catch((e) => log.warn("forgetting the merge queue's git host", e)))
    host.go()
    this.gitHost = host
    return host
  }

  /**
   * HI-2079: the runner fails (its git host went, misbehaved, or couldn't be started): from now on nothing starts and no
   * fenced write commits, and it releases (its job ended, so nothing of its host runs on). Its queue's host sees `failed`
   * and takes a new lease, whose settle ends whatever this one couldn't. Once; nothing after a release.
   */
  private fail(why: string): void {
    if (this.broken || this.released) return
    this.broken = true
    log.warn(`The merge queue for ${userText(this.target)} gave its lease up: ${userText(why)}`)
    void this.release().catch((e) => log.warn(`releasing the merge queue for ${userText(this.target)} after its git host failed`, e))
  }

  /**
   * Gives the lease up (a workspace closing, Hive quitting, its project removed): its job ended and seen empty first
   * (with the processes it follows), so no process of its runs; then its folder kept for the next runner if the queue
   * still needs it (else removed), its records dropped, and its lease row deleted by its own token (nothing of a
   * successor's). If the job can't be seen empty (or a process its journal names still runs), its job is let go all
   * the same (closing it ends what is in it), and its records, journal and folder stay as duties for the next runner
   * (a followed process isn't in the job), which ends what is left before it runs; only the lease goes. Once: every
   * caller (a failure, the queue's run ending) waits for the same release. A lease lost to another Hive is the
   * successor's to settle: nothing then.
   */
  release(): Promise<void> {
    if (this.releasing) return this.releasing
    if (this.released) return Promise.resolve()
    // HI-2078: its own git (removing its folder) runs on git's worker, outside the queue's route it may be called from.
    return (this.releasing = withoutGitRoute(() => this.releaseOnce()))
  }

  private async releaseOnce(): Promise<void> {
    this.stop()
    // Its git host takes nothing more (its job's end ends what it runs).
    this.gitHost?.close()
    const store = this.cfg.store
    // Its job and what it follows ended and seen gone, the journal's processes too (as the next runner would check them).
    // Its job and what it follows ended and seen gone; then the job let go (its supervisor can't write to its journal
    // after that), and only then the journal's processes checked, as the next runner would check them.
    const emptied = !!this.job && (this.cfg.hooks?.endJob?.() ?? true) && (await this.job.end())
    await this.closeJob()
    const ended = emptied && (await this.journalGone(this.lease))
    if (!ended) log.warn(`The merge queue for ${userText(this.target)} couldn't see its processes end: the next runner ends them before it runs`)
    const keep = ended && this.cfg.needed ? await this.cfg.needed().catch(() => true) : !ended
    // Its own, by token: a lease taken over meanwhile (its pid looked gone to another Hive) keeps its successor's row and
    // folders, and the successor settles what was recorded.
    if (!store.holdsQueueLease(this.lease, this.token)) return
    // A folder it couldn't remove keeps its record (its lease's): the next runner's settle tries again, else pauses naming it.
    if (ended && !keep) await this.removeFolder(this.dir)
    await locked(this.cfg, () =>
      store.quiet(() => {
        if (!store.holdsQueueLease(this.lease, this.token)) return
        if (ended) {
          for (const p of store.queueProcs(this.lease)) store.dropQueueProc(this.lease, p.pid)
          if (keep) store.setQueueFolder({ folder: this.dir, target: this.target, lease: null })
        }
        store.dropQueueLease(this.lease, this.token)
      })
    )
    if (ended) await clearJournal(this.cfg.root, this.lease, this.cfg.hooks?.journalDir)
  }

  /**
   * After a failed start, its job closed: its duty (and journal) dropped when the journal holds nothing (closing the job
   * ended what was in it), else kept for the next runner's settle.
   */
  async forgetFailedJob(): Promise<void> {
    // Only a journal known to name nothing: one that names anything, or can't be read, keeps the duty.
    const j = await journalOf(this.cfg.root, this.lease, this.cfg.hooks?.journalDir)
    if (j.state === 'unknown' || (j.state === 'read' && j.entries.length)) return
    await locked(this.cfg, () => {
      for (const p of this.cfg.store.queueProcs(this.lease)) this.cfg.store.dropQueueProc(this.lease, p.pid)
    })
    await clearJournal(this.cfg.root, this.lease, this.cfg.hooks?.journalDir)
  }

  /** Whether none of the processes a lease's journal names still runs (by pid and start); false when that can't be told (a journal that can't be read too). */
  private async journalGone(lease: string): Promise<boolean> {
    const j = await journalOf(this.cfg.root, lease, this.cfg.hooks?.journalDir)
    if (j.state === 'unknown') return false
    if (j.state === 'absent' || !j.entries.length) return true
    const list = await this.probe.list()
    return !!list && !j.entries.some((n) => list.some((p) => p.pid === n.pid && Math.abs(p.started - n.started) <= 1))
  }

  /** Stops renewing and holding (no write): what release and a lost lease share. */
  private stop(): void {
    this.released = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    live.delete(this)
  }

  private startRenewal(): void {
    this.timer = setInterval(() => {
      if (this.cfg.hooks?.renew?.() === false) return
      void locked(this.cfg, () => this.cfg.store.renewQueueLease(this.lease, this.token, new Date().toISOString()))
        .then((held) => {
          if (!held && !this.released) {
            log.warn(`The merge queue for ${userText(this.target)} is run by another Combwork now: this one stopped`)
            this.stop()
          }
        })
        .catch((e) => log.warn('noting the merge queue runner as seen', e))
    }, this.cfg.renewMs ?? RENEW_MS)
    this.timer.unref()
  }

  /**
   * Settles every earlier runner's duties for the target (any lease but this one's, however many runners crashed since
   * they were recorded), in this order, each step only once the one before has succeeded:
   * 1. their jobs ended by name (never the supervisor holding them) and seen empty, or gone;
   * 2. their journals sealed: closed to writers for good, so nothing a supervisor that outlived its Hive writes down can
   *    arrive after the read (it ends what it can't write down instead);
   * 3. one read of them (unreadable or damaged: unknown, never empty), then every process they and the launcher
   *    records name that still runs ended as a tree, and waited for;
   * 4. their folders removed;
   * 5. only then their records dropped and their journals cleared (the seals stay).
   * A step that fails pauses the queue (needs you, naming the pid or the folder) and leaves everything as it was, so a
   * crash or a failure at any point leaves the evidence for the next try (an acquire, or `settle` again). The pid it
   * paused for (0: none to name), or null when all is settled. Public: a host tries again before resuming such a pause.
   */
  async settle(): Promise<number | null> {
    const store = this.cfg.store
    const duties = store.queueProcs(null, this.target).filter((p) => p.lease !== this.lease)
    const leases = [...new Set(duties.map((d) => d.lease))]
    if (leases.length) {
      await this.cfg.hooks?.beforeSettle?.()
      const launchers = duties.filter((d) => d.what !== 'job')
      // A pid to name in a pause: a launcher's, else one a journal names, if any can be read.
      const hint = async (): Promise<number> => {
        const read = await this.journalsOf(leases)
        return launchers[0]?.pid ?? ('entries' in read ? read.entries[0]?.pid : undefined) ?? 0
      }
      for (const lease of leases) {
        const ok = this.cfg.hooks?.endJob?.() !== false && (await endLeaseJob(this.host!, lease))
        if (!ok) return this.pauseFor(await hint())
      }
      for (const lease of leases) if (!(await sealJournal(this.cfg.root, lease, this.cfg.hooks?.journalDir))) return this.pauseFor(await hint())
      await this.cfg.hooks?.afterSeal?.()
      const read = await this.journalsOf(leases)
      if ('unknown' in read) return this.pauseFor(launchers[0]?.pid ?? 0)
      const named: QueueProc[] = [...launchers, ...read.entries.map((j) => ({ lease: '', target: this.target, pid: j.pid, startAfter: j.started, startBefore: j.started, what: 'check' as const }))]
      if (named.length) {
        const list = await this.probe.list()
        if (!list) return this.pauseFor(named[0].pid)
        const roots = named.flatMap((d) => list.filter((p) => matches(p, d)))
        if (roots.length) {
          log.info(`Ending ${roots.length} process(es) an earlier merge queue runner left running`)
          const tree = uniq(roots.flatMap((root) => treeOf(list, root)))
          await this.probe.end(tree)
          const still = await gone(this.probe, tree)
          if (still === null) return this.pauseFor(roots[0].pid)
          if (still.length) return this.pauseFor(still[0].pid)
        }
      }
      await this.cfg.hooks?.beforeClear?.()
      for (const f of store.queueFolders(this.target)) if (f.lease && leases.includes(f.lease) && !(await this.removeFolder(f.folder))) return this.pauseFor(0, f.folder)
      await this.change(() => {
        for (const d of duties) store.dropQueueProc(d.lease, d.pid)
      })
      for (const lease of leases) await clearJournal(this.cfg.root, lease, this.cfg.hooks?.journalDir)
    }
    // Folders of leases with no duties left (a release that ended its job but couldn't remove its folder): removed, or
    // the queue paused naming one, its record kept.
    for (const f of store.queueFolders(this.target)) {
      if (f.lease === null || f.lease === this.lease || store.queueProcs(f.lease).length) continue
      if (!(await this.removeFolder(f.folder))) return this.pauseFor(0, f.folder)
    }
    // A pause this settling made before, now settled.
    const p = store.queuePause(this.target)
    if (p && p.reason === 'needsYou' && p.card === '') await this.change(() => store.setQueuePause(this.target, null))
    return null
  }

  /** The leases' journals, together: every process they name, or unknown when any can't be read. */
  private async journalsOf(leases: string[]): Promise<{ entries: Journalled[] } | { unknown: string }> {
    const entries: Journalled[] = []
    for (const lease of leases) {
      const j = await journalOf(this.cfg.root, lease, this.cfg.hooks?.journalDir)
      if (j.state === 'unknown') {
        log.warn(`The merge queue's journal for an earlier runner of ${userText(this.target)} can't be read (${userText(j.why)}): the queue is paused`)
        return { unknown: j.why }
      }
      if (j.state === 'read') entries.push(...j.entries)
    }
    return { entries }
  }

  /**
   * The queue paused (needs you), naming a process that couldn't be ended (0: a job that couldn't be seen empty, no one
   * process named), or one its job ended because it couldn't record it.
   */
  private async pauseFor(pid: number, folder?: string): Promise<number> {
    if (folder) log.warn(`The merge queue for ${userText(this.target)} is paused: an earlier runner's folder ${userText(folder)} couldn't be removed (something still has it open)`)
    else log.warn(`The merge queue for ${userText(this.target)} is paused: process ${pid || 'in an earlier job'} couldn't be ended or recorded`)
    await this.change(() => this.cfg.store.setQueuePause(this.target, { reason: 'needsYou', card: '', ...(pid ? { pid } : {}), ...(folder ? { files: [folder] } : {}) })) // i18n-ignore: a pause reason's code, not text
    return pid
  }

  /**
   * HI-2079: the queue paused (needs you) because its git host failed two runners in a row: nothing runs until it is
   * resumed. The next runner's settle lifts it once it has nothing left to end, as it does the pauses settling makes.
   */
  async pauseForHost(): Promise<void> {
    log.warn(`The merge queue for ${userText(this.target)} is paused: its git host failed twice in a row`)
    await this.change(() => this.cfg.store.setQueuePause(this.target, { reason: 'needsYou', card: '' })) // i18n-ignore: a pause reason's code, not text
  }

  /**
   * The target's folders as this runner starts (the target's lease is its own now, and settle has removed the earlier
   * leases' it could): one kept by a runner that released cleanly becomes its own (warm), another kept one is removed;
   * then its own recorded.
   */
  private async settleFolders(): Promise<void> {
    const store = this.cfg.store
    let mine: string | null = null
    for (const f of store.queueFolders(this.target)) {
      if (f.lease !== null) continue
      if (!mine && existsSync(f.folder)) {
        mine = f.folder
        continue
      }
      await this.removeFolder(f.folder)
    }
    if (mine) this.dir = mine
    await this.change(() => store.setQueueFolder({ folder: this.dir, target: this.target, lease: this.lease }))
  }

  /**
   * Removes one of the queue's folders and its record: only a folder named as the queue names them, directly in the
   * project's worktrees folder (git's worktree removal, then what is left of it), never anything else. Whether it has
   * gone (a folder that isn't the queue's is never removed, and its record is left).
   */
  private async removeFolder(folder: string): Promise<boolean> {
    // Gone already (removed by hand, or recorded where the workspace was before it moved): only its record goes.
    if (!existsSync(folder)) {
      await locked(this.cfg, () => this.cfg.store.dropQueueFolder(folder))
      return true
    }
    if (!isQueueFolder(this.cfg.root, folder)) {
      log.warn(`Not removing ${userText(folder)}: it isn't one of the merge queue's folders`)
      return false
    }
    const r = await git(this.project, ['worktree', 'remove', '--force', folder])
    if (!r.ok && existsSync(folder)) await removePath(folder).catch((e) => log.warn(`removing the merge queue's folder ${userText(folder)}`, e))
    await git(this.project, ['worktree', 'prune'])
    if (existsSync(folder)) return false
    await locked(this.cfg, () => this.cfg.store.dropQueueFolder(folder))
    return true
  }
}

/**
 * HI-2079: a git host's result as `run` tells a launcher's: a start that failed (notRun), an end by a signal (never code
 * 1, HI-2042), and a request lost with its host (`signal: 'hostLost'`: no answer, HI-2054's again).
 */
function toRunResult(command: string, r: HostResult): RunResult {
  if (r.notRun) return { ok: false, code: -1, out: '', err: r.err.trim(), notRun: r.notRun }
  const err = r.err.trim()
  if (r.lost !== undefined) return { ok: false, code: -1, out: r.out, err: err || `${command} was lost with the merge queue's git host (${r.lost})`, signal: 'hostLost' } // i18n-ignore: the command's side of an error, in English as git's messages are
  if (r.signal) return { ok: false, code: -1, out: r.out, err: err || endedBy(command, r.signal), signal: r.signal }
  const code = r.code ?? -1
  return { ok: code === 0, code, out: r.out, err }
}

const NO_BYTES = Buffer.alloc(0)

/**
 * HI-2078: a git host's result as the worker's execFile gives its outcome (git() maps both alike): its exit code, a
 * start that failed (Node's code, and whether its folder is there), an end by a signal, its bounds as execFile's
 * (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, or killed by its timeout), and lost with its host (`hostLost`): the raw bytes kept.
 */
export async function outcomeOf(r: HostResult, cwd: string): Promise<GitOutcome> {
  const o = { stdout: r.outBuf, stderr: r.errBuf, cwdExists: true }
  const failed = (code: unknown, killed = false, signal: string | null = null): GitOutcome => ({ ...o, error: { code, killed, signal } })
  if (r.lost !== undefined) return failed('hostLost')
  // A start that failed: execFile's stderr is empty then (git() says why itself); its folder looked at as the worker does.
  if (r.notRun) return { ...failed(r.notRun), stderr: NO_BYTES, cwdExists: await access(cwd).then(() => true, () => false) }
  if (r.bounded) {
    if (r.alive) log.warn(`A merge queue git past its ${r.bounded} couldn't be ended: its job ends it with the lease`)
    return r.bounded === 'maxBuffer' ? failed('ERR_CHILD_PROCESS_STDIO_MAXBUFFER', true, 'SIGTERM') : failed(null, true, 'SIGTERM')
  }
  if (r.signal) return failed(null, false, r.signal)
  return r.code === 0 ? { ...o, error: null } : failed(r.code ?? 'error')
}

/** Runs `fn` under the config's lock (the app's boardWrite), else as it is. */
function locked<T>(cfg: Pick<RunnerConfig, 'locked'>, fn: () => T): Promise<T> {
  return cfg.locked ? cfg.locked(fn) : Promise.resolve().then(fn)
}

/**
 * A lease's process that ended, its record dropped. Outside the queue's write fence (HI-2177): the exit is told in the
 * async context its start ran in, the queue's fenced work, whose fence throws LeaseLost once the lease is gone, as it is
 * when the runner's release ends its git host. That release dropped its records, and a successor only settles what
 * still runs, so the record of one that ended goes whoever holds the lease now.
 */
export function forgetEnded(cfg: Pick<RunnerConfig, 'locked' | 'store'>, lease: string, pid: number): Promise<void> {
  return withoutWriteFence(() => locked(cfg, () => cfg.store.dropQueueProc(lease, pid)))
}

/** Whether a listed process is the one a record names: its pid, and a start between the readings around its start. */
const matches = (p: Listed, r: QueueProc): boolean => p.pid === r.pid && p.started >= r.startAfter - START_SLACK_MS && p.started <= r.startBefore + START_SLACK_MS

const uniq = (l: Listed[]): Listed[] => l.filter((p, i) => l.findIndex((x) => x.pid === p.pid && x.started === p.started) === i)

/** Waits until none of these processes runs (by pid and start); those still running after END_WAIT_MS, or null when they can't be listed. */
async function gone(probe: ProcessProbe, targets: Listed[]): Promise<Listed[] | null> {
  if (!targets.length) return []
  const until = Date.now() + END_WAIT_MS
  for (;;) {
    const list = await probe.list()
    if (!list) return null
    const still = targets.filter((t) => list.some((p) => p.pid === t.pid && p.started === t.started))
    if (!still.length || Date.now() > until) return still
    await new Promise((res) => setTimeout(res, 200))
  }
}

/**
 * Whether a target's queue still needs its worktree (#1360 item 5): an open queue entry for it, an unfinished journal
 * (`IntegrationStarted` with no outcome), an in-flight card whose *ruleset* (never the project's options now: §16.6.5)
 * says Hive merges into it, or a run in the folder (`busy`).
 */
export function queueFolderNeeded(wf: Workflow, target: string, busy?: () => boolean): boolean {
  if (busy?.()) return true
  // Only the cards past Todo and not Done (#1629): Unused worktrees asks too (#1644), and a board keeps every card it had.
  for (const card of wf.store.cardsInFlight()) {
    const s = wf.state(card)
    if (s.entries.some((e) => e.target === target && (e.state === 'open' || e.state === 'started'))) return true
    if (s.started && s.stage !== 'done' && s.stage !== 'todo' && s.started.target === target && wf.rulesetOf(card, s).options.finish === 'hiveMerges') return true
  }
  return false
}

/**
 * A project leaving Hive (removed or deleted, #1360 item 5): this Hive's runners of it released, then its queue folders
 * removed with their records, except a living runner's of another Hive (that Hive releases its own) and one whose
 * lease still has duties (processes not seen gone). Only folders named as the queue names them, in the project's
 * worktrees folder.
 */
export async function forgetProjectQueues(cfg: Pick<RunnerConfig, 'store' | 'project' | 'root' | 'locked' | 'probe'>): Promise<void> {
  await releaseQueueRunners((r) => samePlace(r.project, cfg.project))
  const probe = cfg.probe ?? defaultProbe()
  const store = cfg.store
  for (const f of store.queueFolders()) {
    const holder = store.queueLease(f.target)
    if (holder && f.lease === holder.lease && (await probe.alive(holder.pid, holder.started)) !== false) continue
    if ((f.lease && store.queueProcs(f.lease).length) || !isQueueFolder(cfg.root, f.folder)) continue
    if (existsSync(f.folder)) {
      const r = await git(cfg.project, ['worktree', 'remove', '--force', f.folder])
      if (!r.ok && existsSync(f.folder)) await removePath(f.folder).catch((e) => log.warn(`removing the merge queue's folder ${userText(f.folder)}`, e))
    }
    if (!existsSync(f.folder)) await locked(cfg, () => store.dropQueueFolder(f.folder))
  }
  await git(cfg.project, ['worktree', 'prune'])
}

/** Every runner this Hive holds (the panel's "run by", a workspace closing). */
export function queueRunners(): QueueRunner[] {
  return [...live]
}

/** Releases this Hive's runners (all, or those `which` picks): a workspace closing, Hive quitting, a project removed. */
export async function releaseQueueRunners(which: (r: QueueRunner) => boolean = () => true): Promise<void> {
  await Promise.all(queueRunners().filter(which).map((r) => r.release().catch((e) => log.warn(`releasing the merge queue for ${userText(r.target)}`, e))))
}
