// The merge queue's runner (#1360, SPEC §16.9.3): exactly one per project and target across every Hive on the workspace
// (the dev and the installed one share its hive.db). A runner holds the target's lease (queue_runners); another Hive
// takes it over only once the holder *process* is gone (its pid gone, or given to a process that started at another
// time), never because its renewals stopped: a stalled but living Hive keeps its queue (the panel says "run by
// <profile>"), so a living runner is never fenced out of a checkout it may still be writing.
//
// Everything a runner starts (git in its folder, an install, a check) is recorded with its pid and start as it starts
// (queue_runner_procs) and dropped as it ends. A takeover first ends the dead runner's recorded processes still running,
// each as a process tree and only while its pid and start match the record, waits for them, and then makes a folder of
// its own (never the dead runner's), removing the old one. Each fact the queue writes checks the lease inside its own
// write (`holds`, MergeQueue's `holds`): a runner that finds it no longer holds stops at once, writing nothing.
//
// A target's worktree is kept while the queue needs it (queueFolderNeeded): a released runner leaves it for the next.

import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { existsSync } from 'original-fs'
import { basename, dirname, join } from 'path'
import { removePath, samePlace } from '../fsutil'
import { git, type GitResult } from '../git'
import { createLogger, userText } from '../logger'
import type { FactStore, QueueLease, QueueProc, QueueProcKind } from './factStore'
import { defaultProbe, treeOf, type Listed, type ProcessProbe } from './queueProcs'
import type { Workflow } from './runtime'

const log = createLogger('queue')

/** How often a runner notes itself as seen (display only: never a reason to take a lease over). */
export const RENEW_MS = 30_000
/** How long a takeover, or a release, waits for the processes it ended to be gone. */
const END_WAIT_MS = 15_000
/** A recorded child's start may be this far outside the clock readings around it (clock resolution). */
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
  /** Test seams. `renew`: false skips a renewal (a Hive stalled for as long as a test wants). */
  hooks?: { renew?: () => boolean }
}

/** Who holds a target's lease, as the panel shows it. */
export interface Holder {
  profile: string
  pid: number
  renewedAt: string
}

export type Acquired = { ok: true; runner: QueueRunner } | { ok: false; heldBy: Holder | null }

/** A queue's folder name: collision-safe for targets alike (`a/b`, `a-b`) and per lease, so a takeover never reuses one. */
export function queueFolderName(project: string, target: string, lease: string): string {
  return `queue-${createHash('sha256').update(`${project.toLowerCase()}\0${target}`).digest('hex').slice(0, 12)}-${lease}`
}

/** Whether a folder is one of the queue's under a root (named as queueFolderName makes them): what clean-up may remove. */
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
  private readonly children = new Set<ChildProcess>()

  private constructor(
    readonly cfg: RunnerConfig,
    readonly lease: string,
    private readonly token: string,
    private dir: string
  ) {}

  get project(): string {
    return this.cfg.project
  }

  get target(): string {
    return this.cfg.target
  }

  /**
   * Takes the target's lease: when no runner holds it, or from one whose process is gone (a takeover: its recorded
   * processes ended first, its folder replaced by a new one). A holder that runs, or whose process can't be checked,
   * keeps it: `heldBy` says who.
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
      const lease = randomBytes(4).toString('hex')
      const token = randomBytes(16).toString('hex')
      const at = new Date().toISOString()
      const taken = await locked(cfg, () => store.takeQueueLease({ target: cfg.target, lease, token, profile: cfg.profile, pid: me.pid, started: me.started, takenAt: at, renewedAt: at }, now?.token ?? null))
      // Another Hive took or freed it meanwhile: looked at again.
      if (!taken) continue
      const runner = new QueueRunner(cfg, lease, token, join(cfg.root, queueFolderName(cfg.project, cfg.target, lease)))
      live.add(runner)
      try {
        if (now) {
          log.info(`Took over the merge queue for ${userText(cfg.target)} from ${userText(now.profile)} (process ${now.pid} has ended)`)
          await runner.takeOver(now, probe)
        }
        await runner.settleFolders()
      } catch (e) {
        if (!(e instanceof LeaseLost)) throw e
        runner.stop()
        return { ok: false, heldBy: store.queueLease(cfg.target) ? holderOf(store.queueLease(cfg.target)!) : null }
      }
      runner.startRenewal()
      return { ok: true, runner }
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
   * Starts a process of the runner's (an install, a check, git), recorded with its pid and start in the same write that
   * checks the lease, before it can write anything; dropped from the record when it ends. Throws LeaseLost (starting
   * nothing) once the runner no longer holds.
   */
  spawn(what: QueueProcKind, command: string, args: readonly string[], opts: SpawnOptions = {}): Promise<ChildProcess> {
    return this.change(() => {
      const before = Date.now()
      const child = spawnChild(command, args, { windowsHide: true, ...opts })
      this.track(what, child, before)
      return child
    })
  }

  /** git in a folder of the runner's (its own worktree, or the project for a ref), recorded as `spawn` records. */
  async git(cwd: string, args: string[], what: QueueProcKind = 'testMerge'): Promise<GitResult> {
    let run!: Promise<GitResult>
    await this.change(() => {
      const before = Date.now()
      run = git(cwd, args, undefined, undefined, { onSpawn: (child) => this.track(what, child, before) })
    })
    return run
  }

  /** Records a child as it starts (inside the runner's write), and drops it once it ends. */
  private track(what: QueueProcKind, child: ChildProcess, before: number): void {
    const pid = child.pid
    if (!pid) return
    this.cfg.store.addQueueProc({ lease: this.lease, pid, startAfter: before, startBefore: Date.now(), what })
    this.children.add(child)
    child.once('exit', () => {
      this.children.delete(child)
      void locked(this.cfg, () => this.cfg.store.dropQueueProc(this.lease, pid)).catch((e) => log.warn('forgetting a merge queue process that ended', e))
    })
  }

  /**
   * Gives the lease up (a workspace closing, Hive quitting, its project removed): the runner's processes ended first,
   * then its folder kept for the next runner if the queue still needs it (else removed), then its lease row, by its own
   * token, so nothing of a successor's is touched. Once.
   */
  async release(): Promise<void> {
    if (this.released) return
    const probe = this.cfg.probe ?? defaultProbe()
    const kids = [...this.children].filter((c) => c.exitCode === null && c.signalCode === null)
    this.stop()
    if (kids.length) {
      const list = await probe.list()
      const tree = list ? kids.flatMap((c) => list.filter((p) => p.pid === c.pid).flatMap((root) => treeOf(list, root))) : []
      if (tree.length) await probe.end(tree)
      for (const c of kids) if (c.exitCode === null && c.signalCode === null) c.kill()
      await gone(probe, tree)
    }
    const keep = this.cfg.needed ? await this.cfg.needed().catch(() => true) : false
    const store = this.cfg.store
    // Its own, by token: a lease taken over meanwhile (its pid looked gone to another Hive) keeps its successor's row and
    // folders, and the successor's takeover ends what was recorded.
    if (!store.holdsQueueLease(this.lease, this.token)) return
    if (!keep) await this.removeFolder(this.dir)
    await locked(this.cfg, () =>
      store.quiet(() => {
        if (!store.holdsQueueLease(this.lease, this.token)) return
        for (const p of store.queueProcs(this.lease)) store.dropQueueProc(this.lease, p.pid)
        if (keep) store.setQueueFolder({ folder: this.dir, target: this.target, lease: null })
        else store.dropQueueFolder(this.dir)
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
   * A takeover's first step (the lease already ours): the dead runner's recorded processes still running ended, as trees,
   * each only while its pid and start match its record, and waited for. One that can't be ended pauses the queue (needs
   * you, with its pid), and its folder stays; else its records go and its folder is removed.
   */
  private async takeOver(old: QueueLease, probe: ProcessProbe): Promise<void> {
    const store = this.cfg.store
    const recs = store.queueProcs(old.lease)
    if (recs.length) {
      const list = await probe.list()
      if (!list) return this.pauseFor(recs[0].pid)
      const roots = recs.flatMap((r) => list.filter((p) => matches(p, r)))
      const tree = uniq(roots.flatMap((root) => treeOf(list, root)))
      if (tree.length) {
        log.info(`Ending ${tree.length} process(es) the merge queue's last runner left running`)
        await probe.end(tree)
        const still = await gone(probe, tree)
        if (still === null) return this.pauseFor(roots[0].pid)
        if (still.length) return this.pauseFor(still[0].pid)
      }
      await this.change(() => {
        for (const r of recs) store.dropQueueProc(old.lease, r.pid)
      })
    }
    for (const f of store.queueFolders(this.target)) if (f.lease === old.lease) await this.removeFolder(f.folder)
  }

  /** The queue paused (needs you), naming a process a takeover couldn't end. */
  private async pauseFor(pid: number): Promise<void> {
    log.warn(`Couldn't end process ${pid} the merge queue's last runner left running: the queue for ${userText(this.target)} is paused`)
    await locked(this.cfg, () =>
      this.cfg.store.quiet(() => {
        this.fence()
        this.cfg.store.setQueuePause(this.target, { reason: 'needsYou', card: '', pid }) // i18n-ignore: a pause reason's code, not text
      })
    )
  }

  /**
   * The target's folders as this runner starts (the target's lease is its own now): one kept by a runner that released
   * cleanly becomes its own (warm); one of a lease no runner holds any more (a crash before its release finished) is
   * removed, unless a dead runner's processes there couldn't be ended; then its own recorded.
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
      // A dead runner's whose processes a takeover couldn't end: kept until they are (the queue is paused meanwhile).
      if (f.lease && store.queueProcs(f.lease).length) continue
      await this.removeFolder(f.folder)
    }
    if (mine) this.dir = mine
    await this.change(() => store.setQueueFolder({ folder: this.dir, target: this.target, lease: this.lease }))
  }

  /**
   * Removes one of the queue's folders and its record: only a folder named as the queue names them under the project's
   * worktrees folder (git's worktree removal, then what is left of it), never anything else.
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
function locked<T>(cfg: RunnerConfig, fn: () => T): Promise<T> {
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
 * removed with their records, except one a living runner of another Hive holds (that Hive releases its own). Only
 * folders named as the queue names them, under the project's worktrees folder.
 */
export async function forgetProjectQueues(cfg: Pick<RunnerConfig, 'store' | 'project' | 'root' | 'locked' | 'probe'>): Promise<void> {
  await releaseQueueRunners((r) => samePlace(r.project, cfg.project))
  const probe = cfg.probe ?? defaultProbe()
  const store = cfg.store
  const lock = <T>(fn: () => T): Promise<T> => (cfg.locked ? cfg.locked(fn) : Promise.resolve().then(fn))
  for (const f of store.queueFolders()) {
    const holder = store.queueLease(f.target)
    if (holder && f.lease === holder.lease && (await probe.alive(holder.pid, holder.started)) !== false) continue
    if (!isQueueFolder(cfg.root, f.folder)) continue
    if (existsSync(f.folder)) {
      const r = await git(cfg.project, ['worktree', 'remove', '--force', f.folder])
      if (!r.ok && existsSync(f.folder)) await removePath(f.folder).catch((e) => log.warn(`removing the merge queue's folder ${userText(f.folder)}`, e))
    }
    if (!existsSync(f.folder)) await lock(() => store.dropQueueFolder(f.folder))
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
