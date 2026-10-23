// The slot pool in the app (#1429, slots.ts): one pool per open workspace and project, on the workspace's board (its
// writes inside boardWrite, so they wait for and join the board's other changes), keyed by the project's id so a rename
// keeps its slots. A slot's setup, installs and archive command run as Hive's own runs, attributed to "Hive (slot
// <name>)" in the Progress panel, each in the job its operation recorded on the slot, on Hive's process supervisor
// (shared with agents' launches and the merge queue): with no supervisor nothing runs, and a job counts as settled only
// once its processes are seen ended. Each run gets a session command's environment plus the slot's own (HIVE_SLOT,
// HIVE_SLOT_PORT_BASE), its output in a bounded log in Hive's own folder. This process holds its pools' operations
// (its pid and start: another Hive takes one over only once it is gone). A workspace closing ends its pools' commands
// and awaits their operations. Every hour, each open workspace's pools with slots are tidied (Settings → Advanced,
// Remove idle slots after a day).

import { type ChildProcess } from 'child_process'
import { mkdirSync } from 'original-fs'
import { basename, join } from 'path'
import { app } from 'electron'
import { advanced } from './advanced'
import { processSupervisor } from './agentProcesses'
import { boardRead, boardWrite, boardWriteOp } from './boardStore'
import { config } from './config'
import { containsPlace } from './fsutil'
import { createLogger, userText } from './logger'
import { agentLimit } from './projectAgents'
import { progress, progressGate } from './progressService'
import { childEnv } from './ptyHost'
import { sessions } from './sessions'
import { removeCopiesIn } from './skillCopies'
import { settleSlotJob } from './slotJobs'
import { builderCountOf, SlotPool, slotOptionsOf, SlotStore, type OpHolder, type Slot, type SlotConn, type SlotLease, type SlotRunEnd, type SlotRunner } from './slots'
import { onHiveEvent } from './events'
import { agentBusy } from './workflow/lineUpdates'
import { agentRunsGoing } from './workflow/service'
import { openWorkspaces, workspaceFor, WorkspaceService } from './workspace'
import { setRetiredHomes, setWriterHost, writerOver } from './agentFolders'
import { BoundedLog, checkEnv, execCommand, FILE_IO, type Spawn } from './workflow/queueChecks'
import { endLeaseJob, journalPath, LeaseJob, startLauncher } from './workflow/queueJobs'
import { defaultProbe } from './workflow/queueProcs'
import { workflowFor } from './workflow/service'
import { projectAgents } from '../shared/defaults'
import { openEntry } from '../shared/workflow/facts'
import { SLOTS_REMOVE_IDLE, SLOTS_SETUP_MINUTES } from '../shared/advanced'
import type { SlotTestOp, SlotView } from '../shared/types'
import { worktreeRenamer } from './workspaceMove'

const log = createLogger('slots')

/** How often each open workspace's pools are tidied. */
const TIDY_MS = 60 * 60 * 1000

/** Where slot runs keep their logs: Hive's own folder, never a project's. */
export const slotLogDir = (): string => join(app.getPath('userData'), 'logs', 'slots')

/** The board's database as a pool's connection: reads its readers', writes inside boardWrite (quiet: the window shows no slots yet). */
export function boardConn(ws: WorkspaceService): SlotConn {
  const life = ws.lifetime
  const wsPath = ws.path
  const alive = (): boolean => !life.aborted && ws.lifetime === life && ws.path === wsPath
  return {
    read: (fn) => boardRead(ws, fn),
    write: (fn) => boardWrite(ws, async () => boardWriteOp(ws, fn), { alive }),
    close: () => undefined
  }
}

/**
 * Starts a command in its job on Hive's process supervisor: the launcher is put in the job before it runs the command
 * (queueJobs.ts), and one that can't be is ended having run nothing.
 */
function jobSpawn(job: LeaseJob): Spawn {
  return (file, args, opts) => {
    const { child, after, before } = startLauncher({ command: file, args, verbatim: !!opts.windowsVerbatimArguments }, { cwd: opts.cwd as string | undefined, env: opts.env })
    const giveUp = (): void => {
      child.stdin?.end()
      if (child.exitCode === null) child.kill()
    }
    for (const st of [child.stdin, child.stdout, child.stderr]) st?.on('error', (e) => log.warn("a slot run's pipe", e))
    void job.assign(child.pid ?? 0, after, before).then(
      (ok) => {
        if (!ok || !child.pid) return giveUp()
        child.stdin!.write('go\n') // i18n-ignore: the launcher's go-ahead (queueJobs.ts), not text
        child.stdin!.end()
      },
      (e) => {
        log.warn('putting a slot run in its job', e)
        giveUp()
      }
    )
    return child as ChildProcess
  }
}

/** How this Hive tells processes apart (pid and start), ends them, and knows itself. */
const probe = defaultProbe()

/** Where a project's slot jobs keep their journals (what their supervisor follows outside them). */
export const journalsOf = (root: string): string => join(root, '.slot-journals')

/**
 * A project's slot runs: each a run of "Hive (slot <name>)" in the Progress panel, in the job the pool recorded for it.
 * Fails closed: with no process supervisor, or its job not made, nothing runs. Its job is ended when the command
 * ends, when the workspace closes (`signal`) or at its time limit, and the run is settled only once the job is seen
 * empty: otherwise the job stays recorded on the slot for `settle`.
 */
export function appRunner(ws: WorkspaceService, projectPath: string, root: string): SlotRunner {
  return async (r) => {
    const host = processSupervisor()
    if (!host.usable || !(await host.ensure())) return { ok: false, exitCode: null, spawnError: true, error: "Hive's process supervisor isn't running, so it can't run a slot's commands", logPath: null, settled: true } // i18n-ignore: agent-facing and the log
    const opened = await LeaseJob.open(host, r.job, await journalPath(root, r.job, journalsOf(root)))
    if ('problem' in opened) return { ok: false, exitCode: null, spawnError: true, error: `its job couldn't be made: ${opened.problem}`, logPath: null, settled: true } // i18n-ignore: agent-facing and the log
    const job = opened
    const workspacePath = ws.path ?? ''
    const caller = { source: 'hive' as const, workspacePath, projectPath, ...(r.of === 'copy' ? { copy: r.slot } : { slot: r.slot }) }
    let id: string | null = null
    if (workspacePath && progressGate.on()) {
      try {
        // Its title is its command line, which can hold a token: withheld from the Agent API (#620).
        id = progress.start(caller, { title: r.command, command: r.command, titleFromCommand: true }, { folder: r.folder }).id
      } catch (e) {
        log.warn('slot run not shown', e)
      }
    }
    let logPath: string | null = null
    try {
      mkdirSync(slotLogDir(), { recursive: true })
      logPath = join(slotLogDir(), `${Date.now()}-${r.slot.replace(/[^\w.-]/g, '-')}-${r.what}.log`)
    } catch {
      logPath = null
    }
    const out = new BoundedLog(logPath, FILE_IO)
    const onClose = (): void => void job.end().catch(() => false)
    r.signal.addEventListener('abort', onClose)
    let end: SlotRunEnd = { ok: false, exitCode: null, spawnError: true, logPath: null, settled: false }
    try {
      const minutes = Math.max(1, Number(advanced.get(SLOTS_SETUP_MINUTES)) || 60)
      const e = r.signal.aborted ? null : await execCommand({ spawn: jobSpawn(job), platform: process.platform, timeoutMs: minutes * 60_000, env: () => ({ ...checkEnv(childEnv()), ...r.env }) }, r.command, r.folder, out)
      end = e ? { ok: !e.spawnError && !e.timedOut && e.exitCode === 0 && !r.signal.aborted, exitCode: e.exitCode, ...(e.timedOut ? { timedOut: true } : {}), ...(e.spawnError ? { spawnError: true } : {}), logPath: null, settled: false } : { ...end, error: 'the workspace closed' } // i18n-ignore: agent-facing and the log
    } finally {
      r.signal.removeEventListener('abort', onClose)
      out.close()
      // What the command left running (a watcher it started) ends with its job; settled only once it is seen empty.
      // Settled as a dead holder's job would be (slotJobs.ts): ended, its journal sealed, read and what it names ended.
      const settled = await settleSlotJob({ endJob: () => job.end().catch(() => false), probe, root, dir: journalsOf(root) }, r.job).catch(() => false)
      await job.close().catch(() => undefined)
      end = { ...end, settled, logPath: out.usable ? logPath : null }
      if (id) {
        try {
          progress.finish(caller, id, { ok: end.ok, ...(end.exitCode !== null ? { exitCode: end.exitCode } : {}), ...(end.logPath ? { logPath: end.logPath } : {}) })
        } catch {
          // forgotten meanwhile (the panel turned off, the workspace closed)
        }
      }
    }
    if (!end.ok || !end.settled) log.warn(`Slot ${userText(r.slot)}'s ${r.what} ${end.ok ? 'left processes that could not be ended' : `failed (${end.timedOut ? 'timed out' : end.spawnError ? 'did not start' : `exit ${end.exitCode}`})`}`)
    return end
  }
}

/**
 * Settles a job an operation recorded (its holder gone, or a job that couldn't be emptied), by #1360's protocol
 * (slotJobs.ts): ended by its name on this Hive's supervisor, its journal sealed and read, what it names ended. True
 * once none of it runs; its journal is then cleared, and the pool clears the slot's job.
 */
export function appSettle(root: string): (job: string) => Promise<boolean> {
  return async (job) => {
    const host = processSupervisor()
    if (!host.usable || !(await host.ensure())) return false
    return settleSlotJob({ endJob: (name) => endLeaseJob(host, name), probe, root, dir: journalsOf(root) }, job).catch(() => false)
  }
}

/** This process as the holder of slot operations: its pid and start, read once, and the operations it runs now. */
let self: Promise<{ pid: number; started: number }> | null = null
export const holder: OpHolder = {
  self: () => (self ??= probe.self()),
  alive: (pid, started) => probe.alive(pid, started),
  live: new Set()
}

/** A running session's agent in a folder (or one inside it), for a removal's guard. */
function sessionIn(folder: string): string | null {
  const s = sessions.liveStates().find((x) => x.cwd && containsPlace(folder, x.cwd))
  return s ? `${s.agentId} (${s.status})` : null
}

const pools = new Map<string, { life: AbortSignal; pool: Promise<SlotPool> }>()
const poolKey = (ws: WorkspaceService, projectPath: string): string => `${(ws.path ?? '').toLowerCase()}\n${projectPath.toLowerCase()}`

/** A project's slot pool in a workspace (made on first use, for the workspace's life). */
export function poolFor(ws: WorkspaceService, projectPath: string): Promise<SlotPool> {
  const key = poolKey(ws, projectPath)
  const known = pools.get(key)
  if (known && known.life === ws.lifetime && !known.life.aborted) return known.pool
  const pool = (async () => {
    const cfg = await ws.projectConfig(projectPath)
    const root = join(ws.worktreesRoot, basename(projectPath))
    const store = new SlotStore(boardConn(ws), cfg.id ?? basename(projectPath))
    return new SlotPool({
      store,
      project: projectPath,
      root,
      options: async () => slotOptionsOf(await ws.projectConfig(projectPath), config.settings.agents.worktreeCopy),
      builders: () => builderCountOf(projectPath, async () => projectAgents(await ws.projectConfig(projectPath)).length),
      cap: () => agentLimit(projectPath),
      runner: appRunner(ws, projectPath, root),
      settle: appSettle(root),
      holder,
      sessionIn,
      inFlight: async (card) => {
        const wf = await workflowFor(ws, projectPath).catch(() => null)
        try {
          return !!(wf && openEntry(wf.state(card)))
        } catch {
          return false
        }
      },
      removeIdle: () => advanced.get(SLOTS_REMOVE_IDLE) !== false,
      ended: (lease, slot) => stopLeaseSession(projectPath, lease, slot),
      writerOver: (w) => writerOver(w),
      removeSkillCopies: (folder) => removeCopiesIn(projectPath, folder, { always: true, why: 'slot removed' }), // i18n-ignore: the log's reason (English)
      renamer: worktreeRenamer(ws, projectPath)
    })
  })()
  pools.set(key, { life: ws.lifetime, pool })
  pool.catch(() => pools.delete(key))
  return pool
}

/**
 * A lease ended (#1434, SPEC §16.10.2): the session run writing in its slot under it (the slot's writer, as the lease's
 * end found it) is stopped once its turn has finished (not in a turn, no prompt waiting, no run or background task
 * going); a start of it still being prepared gives up. Only that run: the agent's next run, in this slot under a new
 * lease or anywhere else, isn't this lease's to stop. Looked at again at each change of the agent's status or of the
 * Progress panel's runs, until that run is stopped or over. Its conversation stays resumable by hand while the slot
 * isn't lent again, and the slot isn't lent, taken or removed until the run has exited and released it.
 */
export function stopLeaseSession(projectPath: string, lease: SlotLease, slot: Slot): void {
  const w = slot.writer
  if (!w || w.lease !== lease.id) return
  // This Hive's run of it, still (another Hive's run, or one already over, isn't this Hive's to stop).
  const mine = (): { run: string; starting: boolean } | null => {
    const r = sessions.runNow(projectPath, w.agent)
    return r && r.run === w.run ? r : null
  }
  let off: (() => void) | null = null
  const done = (): void => {
    off?.()
    off = null
  }
  const look = (): void => {
    const r = mine()
    if (!r) return done()
    if (!r.starting && (agentBusy(projectPath, w.agent) || agentRunsGoing(projectPath, w.agent).length)) return
    done()
    log.info(`Stopping ${userText(w.agent)}'s ${r.starting ? 'start' : 'session'} in ${userText(slot.name)}: its lease ${lease.id} ended (${lease.why ?? 'released'})`)
    sessions.stop(projectPath, w.agent)
  }
  off = onHiveEvent((e) => {
    if ((e.type === 'session-status' && e.state.agentId === w.agent && e.state.projectPath.toLowerCase() === projectPath.toLowerCase()) || e.type === 'progress-changed') look()
  })
  look()
}

let timer: NodeJS.Timeout | null = null

/** Tidies every open workspace's pools that have slots. */
export async function tidyOpenPools(): Promise<void> {
  for (const ws of openWorkspaces()) {
    if (!ws.path) continue
    let ids: string[]
    try {
      ids = boardRead(ws, (db) => (db.prepare('SELECT DISTINCT project FROM slots').all() as { project: string }[]).map((r) => r.project)) // i18n-ignore: SQL
    } catch {
      // A board still 0.9's (no slot tables), or none open.
      continue
    }
    const byId = ws.projectIdsNow().byId
    for (const id of ids) {
      const path = byId.get(id)
      if (!path) continue
      await poolFor(ws, path)
        .then((p) => p.tidy())
        .catch((e) => log.warn(`tidying the slots of ${userText(path)}`, e))
    }
  }
}

/** Told when a slot may have come free (its writer drained): slotCards.ts's lanes waiting for a slot try again. */
let slotFreed: ((ws: WorkspaceService, projectPath: string) => void) | null = null
export function setSlotFreed(fn: typeof slotFreed): void {
  slotFreed = fn
}

/** Starts the hourly tidy (index.ts, once); a workspace closing closes its pools. */
export function startSlots(): void {
  if (timer) return
  timer = setInterval(() => void tidyOpenPools(), TIDY_MS)
  timer.unref()
  WorkspaceService.closingTasks.add(forgetPools)
  // Slots' writers (#1434, agentFolders.ts): this Hive as their holder, their runs' tokens among its live ones, a claim
  // tracked as its project's pool's work (close awaits it), and a writer released handed to its pool.
  setWriterHost({
    self: holder.self,
    live: holder.live,
    track: async (projectPath) => {
      const ws = workspaceFor(projectPath)
      return ws ? (await poolFor(ws, projectPath)).trackWriter() : null
    },
    drained: async (projectPath, slot) => {
      const ws = workspaceFor(projectPath)
      if (!ws) return
      await poolFor(ws, projectPath).then((p) => p.drained(slot))
      // Free now, perhaps: what waits for a slot may get it (#1438: a lane waiting for one).
      slotFreed?.(ws, projectPath)
    }
  })
}

/** A workspace closing: its pools' running commands ended and their operations awaited, then the pools forgotten. */
function forgetPools(path: string): Promise<void> {
  const mine = [...pools.entries()].filter(([k]) => k.startsWith(`${path.toLowerCase()}\n`))
  for (const [k] of mine) pools.delete(k)
  return Promise.allSettled(mine.map(([, v]) => v.pool.then((p) => p.close()))).then(() => undefined)
}

export function stopSlots(): void {
  setWriterHost(null)
  if (timer) clearInterval(timer)
  timer = null
  WorkspaceService.closingTasks.delete(forgetPools)
}

/** A pool's slots as the window reads them (`slots:list`). */
export function slotViews(pool: SlotPool): SlotView[] {
  return pool.slots().map((s) => {
    const l = pool.openLease(s.name)
    return { name: s.name, folder: s.folder, state: s.state, warmError: s.warmError, warmLog: s.warmLog, lease: l ? { id: l.id, kind: l.kind, agent: l.agent, card: l.card, lane: l.lane } : null, writer: s.writer ? { agent: s.writer.agent, lease: s.writer.lease } : null }
  })
}

/** A test copy's retired homes by project folder (`slots:test` `homes`, #1450's suite), until #1441 records real ones. */
const testHomes = new Map<string, readonly string[]>()

/** A test copy's call into a pool (`slots:test`): what #1438 and #1447 will do from the board and Repair. */
export async function slotTest(pool: SlotPool, op: SlotTestOp): Promise<unknown> {
  switch (op?.op) {
    case 'lend':
      return pool.lend({ agent: op.agent, ...(op.card !== undefined ? { card: op.card } : { lane: op.lane }), ...(op.slot ? { slot: op.slot } : {}) })
    case 'release':
      return pool.release(op.lease, op.why ?? 'released')
    case 'tidy':
      return pool.tidy(op.at)
    case 'remove':
      return pool.remove(op.slot)
    case 'carry':
      // #1441's adoption of an agent's own worktree (#1434's suite, until #1441 is built).
      return pool.carry(op.agent, { name: op.slot, folder: op.folder })
    case 'homes':
      // #1441's retired homes (#1450's suite, until #1441 is built): the folders given, for this project.
      if (!testHomes.size) setRetiredHomes((p) => testHomes.get(p.toLowerCase()) ?? [])
      testHomes.set(pool.deps.project.toLowerCase(), op.folders)
      return true
    default:
      throw new Error('unknown slot test op') // i18n-ignore: a test channel, never shown
  }
}
