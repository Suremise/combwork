// The merge queue's runner (#1360, SPEC §16.9.3): exactly one per project and target across every Hive on the workspace
// (the dev and the installed one share its hive.db). A runner holds the target's lease (queue_runners); another Hive
// takes it over only once the holder *process* is gone (its pid gone, or given to a process that started at another
// time), never because its renewals stopped: a stalled but living Hive keeps its queue (the panel says "run by
// <profile>"), so a living runner is never fenced out of a checkout it may still be writing.
//
// Process ownership (round 2, HR4's findings 1–3): each lease has a Windows job object, held by a supervisor that dies
// with its Hive, and closing the job ends everything in it (queueJobs.ts). Every command starts through a launcher that
// is put in the job and recorded before the command exists: so no process of the runner's, however started (a shell's
// detached server), outlives the job, and none runs unrecorded. The records (queue_runner_procs) are duties per target:
// a release, or the next runner to take the target's lease, ends the jobs and processes they name and drops them only
// once all are seen gone; until then they stay, whoever crashes meanwhile, and the queue pauses ("needs you", with the
// pid) rather than run beside a writer it couldn't end. A lease's folders are removed only once its duties are done.
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
import { jobName, JobSupervisor, startLauncher } from './queueJobs'
import { defaultProbe, treeOf, type Listed, type ProcessProbe } from './queueProcs'
import type { Workflow } from './runtime'

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
    super(`the merge queue for ${target} is run by another Hive now`) // i18n-ignore: an internal error, caught by the queue's host and logged
  }
}

export interface RunnerConfig {
  store: FactStore
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
   * dead runner's duties. `endJob`: false makes ending a job fail (a job that won't empty).
   */
  hooks?: { renew?: () => boolean; lingeringJob?: boolean; beforeSettle?: () => Promise<void>; endJob?: () => boolean }
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
  private sup: JobSupervisor | null = null
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
        // never touched), once its job is closed: a retry, in this Hive or another, can take it at once. What was
        // recorded stays, for the next runner's settle.
        runner.stop()
        await runner.sup?.close()
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

  /** Starts the lease's job and records its supervisor (a duty from now on); a problem when it can't. */
  private async startJob(): Promise<string | null> {
    const s = await JobSupervisor.start(jobName(this.lease), { linger: this.cfg.hooks?.lingeringJob })
    if ('problem' in s) return s.problem
    this.sup = s
    try {
      await this.change(() => this.cfg.store.addQueueProc({ lease: this.lease, target: this.target, pid: s.pid, startAfter: s.started, startBefore: s.started, what: 'supervisor' }))
    } catch (e) {
      await s.close()
      throw e
    }
    return null
  }

  /**
   * Starts a command of the runner's (an install, a check, git) inside its job: its launcher is put in the job and
   * recorded (in a write that checks the lease) before the command exists, and told to run it only then. Throws, with
   * nothing run, when the runner no longer holds (LeaseLost), its job has gone, or the launcher couldn't be put in the
   * job or recorded. The child is the launcher: its output and exit code are the command's.
   */
  async spawn(what: Exclude<QueueProcKind, 'supervisor'>, command: string, args: readonly string[], opts: Pick<SpawnOptions, 'cwd' | 'env' | 'shell'> & { input?: string } = {}): Promise<ChildProcess> {
    const sup = this.sup
    if (!sup?.alive || this.released) throw new LeaseLost(this.target)
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
      if (!(await sup.assign(pid, after, before))) throw new Error(`${command} couldn't be put in the merge queue's job`) // i18n-ignore: as above
      await this.change(() => this.cfg.store.addQueueProc({ lease: this.lease, target: this.target, pid, startAfter: after, startBefore: before, what }))
    } catch (e) {
      giveUp()
      throw e
    }
    child.once('exit', () => {
      // The launcher's tree may live on (a detached server), in the job: the job, the supervisor's duty, owns it.
      void locked(this.cfg, () => this.cfg.store.dropQueueProc(this.lease, pid)).catch((e) => log.warn('forgetting a merge queue process that ended', e))
    })
    child.stdin!.write(`go\n${opts.input ?? ''}`) // i18n-ignore: the launcher's go-ahead (queueJobs.ts), not text
    child.stdin!.end()
    return child
  }

  /** Runs a command (spawn) to its end: its output and exit code. */
  async run(what: Exclude<QueueProcKind, 'supervisor'>, command: string, args: readonly string[], opts: Pick<SpawnOptions, 'cwd' | 'env' | 'shell'> & { input?: string } = {}): Promise<RunResult> {
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
  git(cwd: string, args: string[], what: Exclude<QueueProcKind, 'supervisor'> = 'testMerge'): Promise<RunResult> {
    return this.run(what, 'git', [...GIT_PREFIX, ...args], { cwd })
  }

  /**
   * Gives the lease up (a workspace closing, Hive quitting, its project removed): its job ended and seen empty first, so
   * no process of its runs; then its folder kept for the next runner if the queue still needs it (else removed), its
   * records dropped, and its lease row deleted by its own token (nothing of a successor's). If the job can't be seen
   * empty, its records and folder stay as duties for the next runner, which ends what is left before it runs, and only
   * the lease goes. Once.
   */
  async release(): Promise<void> {
    if (this.released) return
    this.stop()
    const store = this.cfg.store
    const ended = !!this.sup && (this.cfg.hooks?.endJob?.() ?? true) && (await this.sup.end())
    if (ended) await this.sup!.close()
    else log.warn(`The merge queue for ${userText(this.target)} couldn't see its processes end: the next runner ends them before it runs`)
    const keep = ended && this.cfg.needed ? await this.cfg.needed().catch(() => true) : !ended
    // Its own, by token: a lease taken over meanwhile (its pid looked gone to another Hive) keeps its successor's row and
    // folders, and the successor settles what was recorded.
    if (!store.holdsQueueLease(this.lease, this.token)) return
    if (ended && !keep) await this.removeFolder(this.dir)
    await locked(this.cfg, () =>
      store.quiet(() => {
        if (!store.holdsQueueLease(this.lease, this.token)) return
        if (ended) {
          for (const p of store.queueProcs(this.lease)) store.dropQueueProc(this.lease, p.pid)
          if (keep) store.setQueueFolder({ folder: this.dir, target: this.target, lease: null })
          else store.dropQueueFolder(this.dir)
        }
        store.dropQueueLease(this.lease, this.token)
      })
    )
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
      for (const lease of new Set(duties.map((d) => d.lease))) {
        const ok = this.cfg.hooks?.endJob?.() !== false && (await this.sup!.endJob(jobName(lease)))
        if (!ok) return this.pauseFor(duties.find((d) => d.lease === lease && d.what === 'supervisor')?.pid ?? duties.find((d) => d.lease === lease)!.pid)
      }
      const list = await this.probe.list()
      if (!list) return this.pauseFor(duties[0].pid)
      const roots = duties.flatMap((d) => list.filter((p) => matches(p, d)))
      if (roots.length) {
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
    }
    // A pause this settling made before, now settled.
    const p = store.queuePause(this.target)
    if (p && p.reason === 'needsYou' && p.card === '' && p.pid !== undefined) await this.change(() => store.setQueuePause(this.target, null))
    return null
  }

  /** The queue paused (needs you), naming a process an earlier runner left that couldn't be ended. */
  private async pauseFor(pid: number): Promise<number> {
    log.warn(`Couldn't end process ${pid} an earlier merge queue runner left: the queue for ${userText(this.target)} is paused`)
    await this.change(() => this.cfg.store.setQueuePause(this.target, { reason: 'needsYou', card: '', pid })) // i18n-ignore: a pause reason's code, not text
    return pid
  }

  /**
   * The target's folders as this runner starts (the target's lease is its own now): one kept by a runner that released
   * cleanly becomes its own (warm); one of an earlier lease is removed once that lease's duties are done (else kept, the
   * queue paused); then its own recorded.
   */
  private async settleFolders(): Promise<void> {
    const store = this.cfg.store
    let mine: string | null = null
    for (const f of store.queueFolders(this.target)) {
      if (f.lease === this.lease) continue
      if (f.lease === null && !mine && existsSync(f.folder)) {
        mine = f.folder
        continue
      }
      if (f.lease && store.queueProcs(f.lease).length) continue
      await this.removeFolder(f.folder)
    }
    if (mine) this.dir = mine
    await this.change(() => store.setQueueFolder({ folder: this.dir, target: this.target, lease: this.lease }))
  }

  /**
   * Removes one of the queue's folders and its record: only a folder named as the queue names them, directly in the
   * project's worktrees folder (git's worktree removal, then what is left of it), never anything else.
   */
  private async removeFolder(folder: string): Promise<void> {
    if (!isQueueFolder(this.cfg.root, folder)) {
      log.warn(`Not removing ${userText(folder)}: it isn't one of the merge queue's folders`)
      return
    }
    if (existsSync(folder)) {
      const r = await git(this.project, ['worktree', 'remove', '--force', folder])
      if (!r.ok && existsSync(folder)) await removePath(folder).catch((e) => log.warn(`removing the merge queue's folder ${userText(folder)}`, e))
    }
    await git(this.project, ['worktree', 'prune'])
    if (!existsSync(folder)) await locked(this.cfg, () => this.cfg.store.dropQueueFolder(folder))
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
