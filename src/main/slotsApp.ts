// The slot pool in the app (#1429, slots.ts): one pool per open workspace and project, on the workspace's board (its
// writes inside boardWrite, so they wait for and join the board's other changes), keyed by the project's id so a rename
// keeps its slots. A slot's setup, installs and archive command run as Hive's own runs, attributed to "Hive (slot
// <name>)" in the Progress panel, each in a job of its own on Hive's process supervisor (shared with agents' launches
// and the merge queue: what the command leaves running ends with its job), with a session command's environment plus
// the slot's own (HIVE_SLOT, HIVE_SLOT_PORT_BASE), its output in a bounded log in Hive's own folder. Every hour, each
// open workspace's pools with slots are tidied (Settings → Advanced, Remove idle slots after a day).

import { randomBytes } from 'crypto'
import { spawn as nodeSpawn, type ChildProcess } from 'child_process'
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
import { builderCountOf, SlotPool, slotOptionsOf, SlotStore, type SlotConn, type SlotRunEnd, type SlotRunner } from './slots'
import { openWorkspaces, WorkspaceService } from './workspace'
import { BoundedLog, checkEnv, execCommand, FILE_IO, type Spawn } from './workflow/queueChecks'
import { journalPath, LeaseJob, startLauncher } from './workflow/queueJobs'
import { workflowFor } from './workflow/service'
import { projectAgents } from '../shared/defaults'
import { openEntry } from '../shared/workflow/facts'
import { SLOTS_REMOVE_IDLE, SLOTS_SETUP_MINUTES } from '../shared/advanced'
import type { SlotTestOp, SlotView } from '../shared/types'

const log = createLogger('slots')

/** How often each open workspace's pools are tidied. */
const TIDY_MS = 60 * 60 * 1000

/** Where slot runs keep their logs: Hive's own folder, never a project's. */
export const slotLogDir = (): string => join(app.getPath('userData'), 'logs', 'slots')

/** The board's database as a pool's connection: reads its readers', writes inside boardWrite (quiet: the window shows no slots yet). */
function boardConn(ws: WorkspaceService): SlotConn {
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
 * Starts a command in a job of its own on Hive's process supervisor: the launcher is put in the job before it runs the
 * command (queueJobs.ts), and one that can't be is ended having run nothing. With no supervisor (PowerShell refused),
 * the command starts on its own, as agents' launches then do.
 */
function jobSpawn(job: LeaseJob | null): Spawn {
  if (!job) return nodeSpawn
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
        log.warn("putting a slot run in its job", e)
        giveUp()
      }
    )
    return child as ChildProcess
  }
}

/** A project's slot runs: each a run of "Hive (slot <name>)" in the Progress panel, in a job of its own. */
function appRunner(ws: WorkspaceService, projectPath: string, root: string): SlotRunner {
  return async (r) => {
    const workspacePath = ws.path ?? ''
    const caller = { source: 'hive' as const, workspacePath, projectPath, slot: r.slot }
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
    const name = `slot-${randomBytes(6).toString('hex')}`
    const host = processSupervisor()
    let job: LeaseJob | null = null
    if (host.usable) {
      const opened = await LeaseJob.open(host, name, await journalPath(root, name, join(root, '.slot-journals')))
      if ('problem' in opened) log.warn(`a slot run's job couldn't be made (${opened.problem}): it runs on its own`)
      else job = opened
    }
    let end: SlotRunEnd = { ok: false, exitCode: null, spawnError: true, logPath: null }
    try {
      const minutes = Math.max(1, Number(advanced.get(SLOTS_SETUP_MINUTES)) || 60)
      const e = await execCommand({ spawn: jobSpawn(job), platform: process.platform, timeoutMs: minutes * 60_000, env: () => ({ ...checkEnv(childEnv()), ...r.env }) }, r.command, r.folder, out)
      end = { ok: !e.spawnError && !e.timedOut && e.exitCode === 0, exitCode: e.exitCode, ...(e.timedOut ? { timedOut: true } : {}), ...(e.spawnError ? { spawnError: true } : {}), logPath: null }
    } finally {
      out.close()
      // What the command left running (a watcher it started) ends with its job.
      if (job) await job.end().catch(() => false)
      await job?.close().catch(() => undefined)
      end = { ...end, logPath: out.usable ? logPath : null }
      if (id) {
        try {
          progress.finish(caller, id, { ok: end.ok, ...(end.exitCode !== null ? { exitCode: end.exitCode } : {}), ...(end.logPath ? { logPath: end.logPath } : {}) })
        } catch {
          // forgotten meanwhile (the panel turned off, the workspace closed)
        }
      }
    }
    if (!end.ok) log.warn(`Slot ${userText(r.slot)}'s ${r.what} failed (${end.timedOut ? 'timed out' : end.spawnError ? 'did not start' : `exit ${end.exitCode}`})`)
    return end
  }
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
      sessionIn,
      inFlight: async (card) => {
        const wf = await workflowFor(ws, projectPath).catch(() => null)
        try {
          return !!(wf && openEntry(wf.state(card)))
        } catch {
          return false
        }
      },
      removeIdle: () => advanced.get(SLOTS_REMOVE_IDLE) !== false
    })
  })()
  pools.set(key, { life: ws.lifetime, pool })
  pool.catch(() => pools.delete(key))
  return pool
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

/** Starts the hourly tidy (index.ts, once); a workspace closing forgets its pools. */
export function startSlots(): void {
  if (timer) return
  timer = setInterval(() => void tidyOpenPools(), TIDY_MS)
  timer.unref()
  WorkspaceService.closingTasks.add(forgetPools)
}

function forgetPools(path: string): Promise<void> {
  for (const k of [...pools.keys()]) if (k.startsWith(`${path.toLowerCase()}\n`)) pools.delete(k)
  return Promise.resolve()
}

export function stopSlots(): void {
  if (timer) clearInterval(timer)
  timer = null
  WorkspaceService.closingTasks.delete(forgetPools)
}

/** A pool's slots as the window reads them (`slots:list`). */
export function slotViews(pool: SlotPool): SlotView[] {
  return pool.slots().map((s) => {
    const l = pool.openLease(s.name)
    return { name: s.name, folder: s.folder, state: s.state, warmError: s.warmError, warmLog: s.warmLog, lease: l ? { id: l.id, kind: l.kind, agent: l.agent, card: l.card, lane: l.lane } : null }
  })
}

/** A test copy's call into a pool (`slots:test`): what #1438 and #1447 will do from the board and Repair. */
export async function slotTest(pool: SlotPool, op: SlotTestOp): Promise<unknown> {
  switch (op?.op) {
    case 'lend':
      return pool.lend({ agent: op.agent, ...(op.card !== undefined ? { card: op.card } : { lane: op.lane }) })
    case 'release':
      return pool.release(op.lease, op.why ?? 'released')
    case 'tidy':
      return pool.tidy(op.at)
    case 'remove':
      return pool.remove(op.slot)
    default:
      throw new Error('unknown slot test op') // i18n-ignore: a test channel, never shown
  }
}
