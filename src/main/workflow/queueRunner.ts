// The merge queue's runner (#1360, SPEC §16.9.3): exactly one per project and target across every Hive on the workspace
// (the dev and the installed one share its hive.db). A runner holds the target's lease (queue_runners); another Hive
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
import { git, GIT_PREFIX } from '../git'
import { createLogger, userText } from '../logger'
import type { FactStore, QueueLease, QueueProc, QueueProcKind } from './factStore'
import type { JobHost } from '../processSupervisor'
import { clearJournal, endLeaseJob, journalOf, journalPath, LeaseJob, queueHost, startLauncher, type Journalled } from './queueJobs'
import { defaultProbe, treeOf, type Listed, type ProcessProbe } from './queueProcs'
import type { Workflow } from './runtime'

const log = createLogger('queue')

/** How often a runner notes itself as seen (display only: never a reason to take a lease over). */
export const RENEW_MS = 30_000
/** How long a takeover waits for the processes it ended to be gone. */
const END_WAIT_MS = 15_000
/** How many times a takeover reads the earlier runners' journals again, as long as each read finds something new. */
const SETTLE_PASSES = 5
/** A recorded launcher's start may be this far outside the clock readings around it (clock resolution). */
const START_SLACK_MS = 50

/** The runner no longer holds its target's lease (another Hive took it over): it stops, writing nothing. */
export class LeaseLost extends Error {
  constructor(readonly target: string) {
    super(`the merge queue for ${target} is run by another Hive now`) // i18n-ignore: an internal error, caught by the queue's host and logged
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
   * jobs' journals go (a folder that can't be written, for a journal that fails). `afterJournalRead`: runs as a takeover
   * has read the earlier runners' journals, before it ends what they name (a late entry written meanwhile).
   */
  hooks?: { renew?: () => boolean; lingeringJob?: boolean; beforeSettle?: () => Promise<void>; afterJournalRead?: () => Promise<void>; endJob?: () => boolean; journalDir?: string }
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
    return !this.released && this.cfg.store.holdsQueueLease(this.lease, this.token)
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
  async spawn(what: Exclude<QueueProcKind, 'job'>, command: string, args: readonly string[], opts: Pick<SpawnOptions, 'cwd' | 'env' | 'shell'> & { input?: string } = {}): Promise<ChildProcess> {
    const job = this.job
    if (!job || this.released) throw new LeaseLost(this.target)
    const { child, after, before } = startLauncher({ command, args, shell: !!opts.shell }, { cwd: opts.cwd as string | undefined, env: opts.env })
    // Its errors are handled here from the start (a start that failed: a folder gone, no executable; a pipe that broke),
    // never left to the process's: the first is the start's error, later ones are logged.
    let startError: Error | null = null
    const failed = new Promise<Error>((res) =>
      child.on('error', (e) => {
        if (!startError) res((startError = e))
        else log.warn(`the merge queue's ${what} process`, e)
      })
    )
    for (const s of [child.stdin, child.stdout, child.stderr]) s?.on('error', (e) => log.warn(`the merge queue's ${what} process's pipe`, e))
    const giveUp = (): void => {
      // Never told to run: ending its input ends it, and one that started is ended too in case it is slow to see that.
      child.stdin?.end()
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill()
        } catch (e) {
          log.warn(`ending the merge queue's ${what} launcher`, e)
        }
      }
    }
    const pid = child.pid
    // Not started: nothing to record or end; the start's own error (it is told on the next tick).
    if (!pid) throw startError ?? (await failed)
    try {
      if (!(await job.assign(pid, after, before))) throw new Error(`${command} couldn't be put in the merge queue's job`) // i18n-ignore: as above
      await this.change(() => this.cfg.store.addQueueProc({ lease: this.lease, target: this.target, pid, startAfter: after, startBefore: before, what }))
    } catch (e) {
      giveUp()
      throw e
    }
    child.once('exit', () => {
      // The launcher's tree may live on (a detached server), in the job: the job, the lease's own duty, owns it.
      void locked(this.cfg, () => this.cfg.store.dropQueueProc(this.lease, pid)).catch((e) => log.warn('forgetting a merge queue process that ended', e))
    })
    child.stdin!.write(`go\n${opts.input ?? ''}`) // i18n-ignore: the launcher's go-ahead (queueJobs.ts), not text
    child.stdin!.end()
    return child
  }

  /** Runs a command (spawn) to its end: its output and exit code. */
  async run(what: Exclude<QueueProcKind, 'job'>, command: string, args: readonly string[], opts: Pick<SpawnOptions, 'cwd' | 'env' | 'shell'> & { input?: string } = {}): Promise<RunResult> {
    const child = await this.spawn(what, command, args, opts)
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    const code = await new Promise<number>((res) => {
      child.once('close', (c) => res(c ?? 1))
      child.once('error', () => res(-1))
    })
    return { ok: code === 0, code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8').trim() }
  }

  /** git in a folder of the runner's (its own worktree, or the project for a ref), as Hive runs git (GIT_PREFIX), through `run`. */
  git(cwd: string, args: string[], what: Exclude<QueueProcKind, 'job'> = 'testMerge'): Promise<RunResult> {
    return this.run(what, 'git', [...GIT_PREFIX, ...args], { cwd })
  }

  /**
   * Gives the lease up (a workspace closing, Hive quitting, its project removed): its job ended and seen empty first
   * (with the processes it follows), so no process of its runs; then its folder kept for the next runner if the queue
   * still needs it (else removed), its records dropped, and its lease row deleted by its own token (nothing of a
   * successor's). If the job can't be seen empty (or a process its journal names still runs), its job is let go all
   * the same (closing it ends what is in it), and its records, journal and folder stay as duties for the next runner
   * (a followed process isn't in the job), which ends what is left before it runs; only the lease goes. Once.
   */
  async release(): Promise<void> {
    if (this.released) return
    this.stop()
    const store = this.cfg.store
    // Its job and what it follows ended and seen gone, the journal's processes too (as the next runner would check them).
    const ended = !!this.job && (this.cfg.hooks?.endJob?.() ?? true) && (await this.job.end()) && (await this.journalGone(this.lease))
    await this.closeJob()
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
            log.warn(`The merge queue for ${userText(this.target)} is run by another Hive now: this one stopped`)
            this.stop()
          }
        })
        .catch((e) => log.warn('noting the merge queue runner as seen', e))
    }, this.cfg.renewMs ?? RENEW_MS)
    this.timer.unref()
  }

  /**
   * Settles every earlier runner's duties for the target (any lease but this one's, however many runners crashed since
   * they were recorded): each of their jobs ended and seen empty (or gone, which ended what was in it), then each
   * recorded process still running (its pid and start) ended as a tree and waited for, and only then their records
   * dropped. Something that can't be ended or seen gone pauses the queue (needs you, its pid) and its records stay, for
   * the next try (an acquire, or `settle` again). The pid it paused for, or null when all is settled. Public: a host
   * tries again before resuming such a pause.
   */
  async settle(): Promise<number | null> {
    const store = this.cfg.store
    const duties = store.queueProcs(null, this.target).filter((p) => p.lease !== this.lease)
    if (duties.length) {
      await this.cfg.hooks?.beforeSettle?.()
      const leases = [...new Set(duties.map((d) => d.lease))]
      const launchers = duties.filter((d) => d.what !== 'job')
      // Their jobs first, by name, never by the supervisor holding them (it may be a living Hive's, serving its other
      // targets and its agents): ended and seen empty, or gone (closed, so the system ended what was in them).
      for (const lease of leases) {
        const ok = this.cfg.hooks?.endJob?.() !== false && (await endLeaseJob(this.host!, lease))
        if (!ok) {
          // Named for the user: a process it recorded, if any can be read.
          const read = await this.journalsOf(leases)
          return this.pauseFor(launchers[0]?.pid ?? ('entries' in read ? read.entries[0]?.pid : undefined) ?? 0)
        }
      }
      // Then what they recorded and still runs: their launchers' trees, and each process their journals name (what their
      // jobs followed, outside them). Read once their jobs are ended, and again after ending what they name, until a read
      // finds nothing new: a supervisor that outlived its Hive may still write down what it finds meanwhile (HR4's round
      // 4 finding 2). A journal that can't be read, or that keeps growing, pauses the queue and keeps the duties.
      const ended = new Set<string>()
      for (let pass = 0; ; pass++) {
        const read = await this.journalsOf(leases)
        if ('unknown' in read) return this.pauseFor(launchers[0]?.pid ?? 0)
        const fresh = read.entries.filter((j) => !ended.has(`${j.pid}:${j.started}`))
        const named: QueueProc[] = [...(pass === 0 ? launchers : []), ...fresh.map((j) => ({ lease: '', target: this.target, pid: j.pid, startAfter: j.started, startBefore: j.started, what: 'check' as const }))]
        if (!named.length) break
        if (pass >= SETTLE_PASSES) return this.pauseFor(named[0].pid)
        for (const j of fresh) ended.add(`${j.pid}:${j.started}`)
        await this.cfg.hooks?.afterJournalRead?.()
        const list = await this.probe.list()
        if (!list) return this.pauseFor(named[0].pid)
        const roots = named.flatMap((d) => list.filter((p) => matches(p, d)))
        if (!roots.length) continue
        log.info(`Ending ${roots.length} process(es) an earlier merge queue runner left running`)
        const tree = uniq(roots.flatMap((root) => treeOf(list, root)))
        await this.probe.end(tree)
        const still = await gone(this.probe, tree)
        if (still === null) return this.pauseFor(roots[0].pid)
        if (still.length) return this.pauseFor(still[0].pid)
      }
      await this.change(() => {
        for (const d of duties) store.dropQueueProc(d.lease, d.pid)
      })
      for (const lease of leases) await clearJournal(this.cfg.root, lease, this.cfg.hooks?.journalDir)
    }
    // Then their folders, where whatever they ran worked (and whatever escaped before the supervisor saw it, if Hive
    // crashed in that moment, the window SPEC accepts): each removed, or the queue paused naming it, its record kept.
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

/** Runs `fn` under the config's lock (the app's boardWrite), else as it is. */
function locked<T>(cfg: Pick<RunnerConfig, 'locked'>, fn: () => T): Promise<T> {
  return cfg.locked ? cfg.locked(fn) : Promise.resolve().then(fn)
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
  for (const card of wf.store.cards()) {
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
