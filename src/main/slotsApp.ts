// The slot pool in the app (#1429, slots.ts): one pool per open workspace and project, on the workspace's board (its
// writes inside boardWrite, so they wait for and join the board's other changes), keyed by the project's id so a rename
// keeps its slots. A slot's setup, installs and archive command run as Combwork's own runs, attributed to "Combwork (slot
// <name>)" in the Progress panel, each in the job its operation recorded on the slot, on Combwork's process supervisor
// (shared with agents' launches and the merge queue): with no supervisor nothing runs, and a job counts as settled only
// once its processes are seen ended. Each run gets a session command's environment plus the slot's own (CW_SLOT,
// CW_SLOT_PORT_BASE), its output in a bounded log in Combwork's own folder. This process holds its pools' operations
// (its pid and start: another Combwork takes one over only once it is gone). A workspace closing ends its pools' commands
// and awaits their operations. Every hour, each open workspace's pools with slots are tidied (Settings → Advanced,
// Remove idle slots after a day).

import { type ChildProcess } from 'child_process'
import { mkdirSync } from 'original-fs'
import { basename, join } from 'path'
import { agentMsg, inDefaultDialect, inDialectOf, say, type AgentMsg, type AgentValues } from '../shared/agentText'
import { app } from 'electron'
import { advanced } from './advanced'
import { brokerWorkingIn, processSupervisor } from './agentProcesses'
import { boardRead, boardWrite, boardWriteOp, cardKeyOf } from './boardStore'
import { config } from './config'
import { agentReadsInbox, cancelFromSource, createDelivery, deliveriesOf, fromSource, offerNow, onDeliveriesChanged, waitingForRunNow } from './deliveries'
import { containsPlace } from './fsutil'
import { getLane } from './lanes'
import { createLogger, userText } from './logger'
import { progress, progressGate } from './progressService'
import { childEnv } from './ptyHost'
import { sessions } from './sessions'
import { removeCopiesIn } from './skillCopies'
import { settleSlotJob } from './slotJobs'
import { builderCountOf, SlotPool, slotLevelsOf, slotOptionsOf, SlotStore, type OpHolder, type Slot, type SlotConn, type SlotLease, type SlotRenamer, type SlotRunEnd, type SlotRunner, type SlotWriter } from './slots'
import { onCombworkEvent } from './events'
import { agentBusy } from './workflow/lineUpdates'
import { agentRunsGoing } from './workflow/service'
import { openWorkspaces, workspaceFor, WorkspaceService } from './workspace'
import { goneWriterCleared, goneWriterSettles, goneWriterStill, setRetiredHomes, setWriterHost, writerCleared, writerHeld, writerOver } from './agentFolders'
import { BoundedLog, checkEnv, execCommand, FILE_IO, type Spawn } from './workflow/queueChecks'
import type { WorkspaceFilesOutcome, WorkspacePort } from './platform/workspacePort'
import { registerWorkspacePort, workspacePortForPlatform, workspacePortOf } from './platform/workspacePorts'
import { createJjWorkspacePort, generationOf, type JjWorkspacePort } from './platform/jjWorkspacePort'
import { isUnknown } from './platform/types'
import { SlotStaleView } from './slotStaleView'
import { recoverStale } from './platform/jjRecovery'
import { storeGitGated } from './platform/jjRunner'
import { git } from './git'
import { boardPrepStore } from './platform/jjSlotPrep'
import { historyFor } from './platform/historyPorts'
import { takeStores } from './repoLock'
import { trash } from './trash'
import { holdLaunches } from './launchHolds'
import type { PlatformId } from '../shared/platform/descriptors'
import { endLeaseJob, journalPath, LeaseJob, leaseJobGone, retireSeal, startLauncher, sweepSeals } from './workflow/queueJobs'
import { defaultProbe } from './workflow/queueProcs'
import { workflowFor } from './workflow/service'
import { projectAgents } from '../shared/defaults'
import { agentMax } from './projectAgents'
import { openEntry } from '../shared/workflow/facts'
import { LANES_END_WAIT_MINUTES, LANES_GENTLE_END, SLOTS_REMOVE_IDLE, SLOTS_SETUP_MINUTES } from '../shared/advanced'
import type { SlotTestOp, SlotView } from '../shared/types'

const log = createLogger('slots')

/** How often each open workspace's pools are tidied. */
const TIDY_MS = 60 * 60 * 1000

/** Where slot runs keep their logs: Combwork's own folder, never a project's. */
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
 * Starts a command in its job on Combwork's process supervisor: the launcher is put in the job before it runs the command
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

/** How this Combwork tells processes apart (pid and start), ends them, and knows itself. */
const probe = defaultProbe()

/** Where a project's slot jobs keep their journals (what their supervisor follows outside them). */
export const journalsOf = (root: string): string => join(root, '.slot-journals')

/** Whether a settled lease's job is gone (HI-1723), asked of this Combwork's supervisor; false with none to ask. */
async function sealGone(lease: string): Promise<boolean> {
  const host = processSupervisor()
  return host.usable && (await host.ensure()) && (await leaseJobGone(host, lease))
}

/** A settled job's seal removed once its job is gone (HI-1723), after this Combwork let its own handle go. */
export function retireSealOf(root: string, job: string): void {
  void retireSeal(root, job, journalsOf(root), sealGone).catch(() => false)
}

/** The journals folders being swept now, and the ones swept since this Combwork started. */
const sweeping = new Set<string>()
const swept = new Set<string>()

/**
 * Removes the seals in a project's journals folder whose jobs are gone (HI-1723: an empty folder per slot or copy job
 * piled up). One sweep a folder at a time (a call while one runs does nothing); `once`: only the first since this
 * Combwork started (a pool made).
 */
export function sweepSealsOf(root: string, o: { once?: boolean } = {}): void {
  const dir = journalsOf(root)
  const key = dir.toLowerCase()
  if (sweeping.has(key) || (o.once && swept.has(key))) return
  sweeping.add(key)
  swept.add(key)
  void sweepSeals(root, dir, sealGone)
    .then((n) => n && log.info(`removed ${n} sealed journal(s) whose jobs are gone in ${userText(dir)}`))
    .catch((e) => log.warn(`sweeping the sealed journals of ${userText(dir)}`, e))
    .finally(() => sweeping.delete(key))
}

/** A slot run's errors (dialects, HI-2447): its end's error, kept on the slot by the pool (said in the Default there). */
const T = {
  noSupervisor: agentMsg({ id: 'slot.run.noSupervisor', text: "Combwork's process supervisor isn't running, so it can't run a slot's commands", note: "A slot's or copy's setup error: Combwork runs their commands in a job of its own, and can't now." }),
  noJob: agentMsg({ id: 'slot.run.noJob', text: "its job couldn't be made: {problem}", note: "A slot's or copy's setup error: the job its command runs in couldn't be made. {problem} is why." }),
  closed: agentMsg({ id: 'slot.run.closed', text: 'the workspace closed', note: "A slot's or copy's setup error: its workspace closed before its command ran." }),
  merged: agentMsg({ id: 'slot.laneEnd.merged', text: '{card} merged at {commit}', note: "A card in slot.laneEnd.note's list: merged, with its merge commit's first 12 characters." }),
  notMerged: agentMsg({ id: 'slot.laneEnd.notMerged', text: '{card} not merged', note: "A card in slot.laneEnd.note's list: not merged." }),
  more: agentMsg({ id: 'slot.laneEnd.more', text: 'and {count} more', note: "The end of slot.laneEnd.note's list, past its first 20 cards. {count} is digits." }),
  laneEnd: agentMsg({ id: 'slot.laneEnd.note', text: "{abandoned, select, yes {Lane {lane} was abandoned} other {Lane {lane} is finished}}{listed, select, yes {: {list}} other {}}. Your session ends once this turn does; Combwork resumes it for your next lane. Close the lane's work in your reply, then end your turn.", note: "The note a lane's builder is given as its lane ends (HI-1706): each card (slot.laneEnd.merged or notMerged, joined by \"; \"), and that its session ends with its turn. Cut at 2000 characters." })
}
const sayStored = (m: AgentMsg, values?: AgentValues): string => inDefaultDialect(() => say(m, values))

/**
 * A project's slot runs: each a run of "Combwork (slot <name>)" in the Progress panel, in the job the pool recorded for it.
 * Fails closed: with no process supervisor, or its job not made, nothing runs. Its job is ended when the command
 * ends, when the workspace closes (`signal`) or at its time limit, and the run is settled only once the job is seen
 * empty: otherwise the job stays recorded on the slot for `settle`.
 */
export function appRunner(ws: WorkspaceService, projectPath: string, root: string): SlotRunner {
  return async (r) => {
    const host = processSupervisor()
    if (!host.usable || !(await host.ensure())) return { ok: false, exitCode: null, spawnError: true, error: sayStored(T.noSupervisor), logPath: null, settled: true }
    const opened = await LeaseJob.open(host, r.job, await journalPath(root, r.job, journalsOf(root)))
    if ('problem' in opened) return { ok: false, exitCode: null, spawnError: true, error: sayStored(T.noJob, { problem: opened.problem }), logPath: null, settled: true }
    const job = opened
    const workspacePath = ws.path ?? ''
    // A copy's run is credited to the agent whose lease holds it (HI-1710), named as the project names it now.
    const holder = r.of === 'copy' && r.holder ? r.holder : null
    const reviewer = holder ? { agentId: holder, agentName: (await ws.projectConfig(projectPath).then((c) => projectAgents(c).find((a) => a.id === holder)?.name, () => undefined)) ?? holder } : null
    const caller = { source: 'combwork' as const, workspacePath, projectPath, ...(r.of === 'copy' ? { copy: r.slot, ...(reviewer ? { reviewer } : {}) } : { slot: r.slot }) }
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
      if (r.files && !r.signal.aborted) {
        // HI-1182: the submodules-and-LFS step, its tool in this job with no shell, within the same time limit.
        const x = r.files.tool.exec({ spawn: jobSpawn(job), env: { ...checkEnv(childEnv()), ...r.env }, log: out, timeoutMs: minutes * 60_000, signal: r.signal })
        let o: WorkspaceFilesOutcome
        try {
          o = await r.files.tool.prepare(x, r.files.step).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
        } finally {
          x.close()
        }
        if (!o.ok) out.write(Buffer.from(o.error + '\n'))
        end = { ok: o.ok && !r.signal.aborted, exitCode: o.ok ? 0 : 1, ...(x.timedOut() ? { timedOut: true } : {}), ...(o.ok ? {} : { error: o.error }), logPath: null, settled: false }
      }
      const e = r.signal.aborted || r.files ? null : await execCommand({ spawn: jobSpawn(job), platform: process.platform, timeoutMs: minutes * 60_000, env: () => ({ ...checkEnv(childEnv()), ...r.env }) }, r.command, r.folder, out)
      if (r.files && r.signal.aborted && !end.error && !end.ok) end = { ...end, error: sayStored(T.closed) }
      else if (!r.files) end = e ? { ok: !e.spawnError && !e.timedOut && e.exitCode === 0 && !r.signal.aborted, exitCode: e.exitCode, ...(e.timedOut ? { timedOut: true } : {}), ...(e.spawnError ? { spawnError: true } : {}), logPath: null, settled: false } : { ...end, error: sayStored(T.closed) }
    } finally {
      r.signal.removeEventListener('abort', onClose)
      out.close()
      // What the command left running (a watcher it started) ends with its job; settled only once it is seen empty.
      // Settled as a dead holder's job would be (slotJobs.ts): ended, its journal sealed, read and what it names ended.
      const settled = await settleSlotJob({ endJob: () => job.end().catch(() => false), probe, root, dir: journalsOf(root) }, r.job).catch(() => false)
      await job.close().catch(() => undefined)
      if (settled) retireSealOf(root, r.job)
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
 * (slotJobs.ts): ended by its name on this Combwork's supervisor, its journal sealed and read, what it names ended. True
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

/**
 * A project's rename steps (#1441): Repair's helpers (workspaceMove.ts' worktreeRenamer), loaded on first use, so the
 * pool's module doesn't load everything Repair needs.
 */
function renamerFor(ws: WorkspaceService, projectPath: string): SlotRenamer {
  const r = (): Promise<SlotRenamer> => import('./workspaceMove').then((m) => m.worktreeRenamer(ws, projectPath))
  return {
    identity: async (f) => (await r()).identity(f),
    copy: async (a, b, who) => (await r()).copy(a, b, who),
    move: async (a, b, t) => (await r()).move(a, b, t),
    follow: async (a, b, t) => (await r()).follow(a, b, t),
    back: async (a, b, t) => (await r()).back(a, b, t),
    where: async (a, b, t) => (await r()).where(a, b, t)
  }
}

/**
 * A store's repository lock (HI-2866), as jj's port takes it around each write: the one owner every platform's takes go
 * through (repoLock.ts `takeStores`, HI-2896), so a take inside one this context holds (live) runs straight through,
 * whichever platform named the store.
 */
export function storeLock<T>(store: string, fn: () => Promise<T>): Promise<T> {
  return takeStores([{ store, folder: store }], fn, { quiet: true })
}

/**
 * jj's workspace port with the app's dependencies (HI-2866), registered once: its control workspace beside the project's
 * slots with its record in the workspace database, the project folder's quiet (no session, no process), the store's
 * lock, the Recycle Bin, the slots' bindings in the workspace database (jjSlotPrep.ts), and §16.3.2's containment on
 * the store for a slot's reuse.
 */
export function jjPort(): JjWorkspacePort {
  const known = workspacePortOf('jj')
  if (known) return known as JjWorkspacePort
  const port = createJjWorkspacePort({
    control: (repo) => {
      const ws = workspaceFor(repo)
      const folder = join(ws ? ws.worktreesRoot : join(repo, '..'), basename(repo), '.cw-jj-control')
      const journal = ws ? new SlotStore(boardConn(ws), basename(repo)).journal(`jj_control:${repo.toLowerCase()}`) : { read: () => ({ unreadable: true }), write: async () => undefined, clear: async () => undefined }
      return { folder, journal }
    },
    // HI-2887 (Darren's r9: automatic): the project folder held against agent launches while its control is made.
    projectHold: (repo) => holdLaunches(repo),
    // Darren's (a) on HI-2887: a lost control is made again automatically, under the same hold.
    remakeAllowed: () => true,
    made: (repo, ws) => log.info(`Made jj's control workspace for ${userText(basename(repo))} at ${userText(ws)}: the project folder's working copy recorded once`),
    lock: storeLock,
    trash: async (p) => void (await trash(p)),
    prep: (store) => {
      const ws = workspaceFor(store)
      return ws ? boardPrepStore(boardConn(ws)) : null
    },
    contains: (store, target, change, at) => historyFor('git').contains(store, target, change, at)
  })
  registerWorkspacePort('jj', port)
  return port
}

/**
 * A stale jj slot recovered, the user's explicit action (HI-2866; the window's Recover…, J9c): J2's `recoverStale` under
 * the pool's operation of the slot, the preserved bytes outside every workspace (the project's worktrees folder's
 * `.cw-recovery`). A protocol code when refused.
 */
export async function recoverStaleSlot(ws: WorkspaceService, projectPath: string, name: string): Promise<{ ok: true } | { ok: false; why: string }> {
  const pool = await poolFor(ws, projectPath)
  return pool.recoverStale(name, async (s, fence, journal, quietNow) => {
    const r = await recoverStale(
      { port: jjPort(), git: (cwd, args) => storeGitGated(cwd, args, () => git(cwd, args)), preserveRoot: join(ws.worktreesRoot, basename(projectPath), '.cw-recovery', s.name), trash: async (p) => void (await trash(p)) },
      { repo: projectPath, folder: s.folder, identity: s.identity!, journal, fence, quiet: quietNow }
    )
    return r.ok ? { ok: true } : { ok: false, why: r.why }
  })
}

/** Each project's platform as last read (HI-2866): which port its pools make new slots and copies with. */
const platforms = new Map<string, PlatformId>()
const platformKey = (ws: WorkspaceService, projectPath: string): string => `${(ws.path ?? '').toLowerCase()}
${projectPath.toLowerCase()}`
async function readPlatform(ws: WorkspaceService, projectPath: string): Promise<void> {
  const p = (await ws.projectConfig(projectPath).catch(() => null))?.platform
  if (p === 'jj') jjPort()
  platforms.set(platformKey(ws, projectPath), p === 'jj' ? 'jj' : 'git')
}
/** The port a project's new slots and copies are made with now (Git's unless the project uses jj). */
export function projectWorkspaces(ws: WorkspaceService, projectPath: string): WorkspacePort {
  return workspacePortForPlatform(platforms.get(platformKey(ws, projectPath)) ?? 'git')
}
/** Reads a project's platform again (before a lending). */
export const refreshProjectWorkspaces = (ws: WorkspaceService, projectPath: string): Promise<void> => readPlatform(ws, projectPath)

const pools = new Map<string, { life: AbortSignal; pool: Promise<SlotPool> }>()
const poolKey = (ws: WorkspaceService, projectPath: string): string => `${(ws.path ?? '').toLowerCase()}\n${projectPath.toLowerCase()}`

/** A project's slot pool in a workspace if one has been made (never makes one): for what only concerns existing slots. */
export function poolIfMade(ws: WorkspaceService, projectPath: string): Promise<SlotPool> | null {
  const known = pools.get(poolKey(ws, projectPath))
  return known && known.life === ws.lifetime && !known.life.aborted ? known.pool : null
}

/** A project's slot pool in a workspace (made on first use, for the workspace's life). */
export function poolFor(ws: WorkspaceService, projectPath: string): Promise<SlotPool> {
  const key = poolKey(ws, projectPath)
  const known = pools.get(key)
  if (known && known.life === ws.lifetime && !known.life.aborted) return known.pool
  const pool = (async () => {
    const cfg = await ws.projectConfig(projectPath)
    await readPlatform(ws, projectPath)
    const root = join(ws.worktreesRoot, basename(projectPath))
    const store = new SlotStore(boardConn(ws), cfg.id ?? basename(projectPath))
    const made: SlotPool = new SlotPool({
      store,
      workspacesFor: () => projectWorkspaces(ws, projectPath),
      refreshPorts: () => readPlatform(ws, projectPath),
      project: projectPath,
      root,
      options: async () => slotOptionsOf(await ws.projectConfig(projectPath), slotLevelsOf(config.settings, ws)),
      builders: () => builderCountOf(projectPath, async () => projectAgents(await ws.projectConfig(projectPath)).length),
      cap: () => agentMax(projectPath),
      runner: appRunner(ws, projectPath, root),
      settle: async (job) => {
        const ok = await appSettle(root)(job)
        if (ok) retireSealOf(root, job)
        return ok
      },
      holder,
      sessionIn,
      brokerIn: brokerWorkingIn,
      inFlight: async (card) => {
        const wf = await workflowFor(ws, projectPath).catch(() => null)
        try {
          return !!(wf && openEntry(wf.state(card)))
        } catch {
          return false
        }
      },
      removeIdle: () => advanced.get(SLOTS_REMOVE_IDLE) !== false,
      ended: (lease, slot) => {
        stopLeaseSession(projectPath, lease, slot, { ws, pool: made })
        // Where its agent works changes (#1442: an idle builder's "in slot-b" goes): the window reads it again.
        if (!ws.lifetime.aborted) ws.scheduleRefresh()
      },
      writerOver: (w) => writerOver(w),
      overCleared: (run) => writerCleared(run),
      writerGone: {
        settles: (w, slot) => goneWriterSettles(projectPath, w, slot),
        still: (evidence) => goneWriterStill(evidence),
        cleared: (run, evidence) => {
          goneWriterCleared(run, evidence)
          // Free now: a lane waiting for a slot may get it (#1438).
          slotFreed(ws, projectPath)
        }
      },
      // A finished card's slot asked about only once its settle is over (HI-2170): the slots' pass looks again.
      looked: () => slotFreed(ws, projectPath),
      removeSkillCopies: (folder) => removeCopiesIn(projectPath, folder, { always: true, why: 'slot removed' }), // i18n-ignore: the log's reason (English)
      renamer: renamerFor(ws, projectPath)
    })
    // The seals of jobs settled before this Combwork started (HI-1723).
    sweepSealsOf(root, { once: true })
    // Writers a Combwork that has gone left, settled where what was kept of their runs allows (HI-1886).
    void made.settleGoneWriters().catch((e) => log.warn(`settling the slot writers of a Combwork that has gone in ${userText(projectPath)}`, e))
    // Slots that owed a settle when Combwork last ran (HI-2906): looked at now.
    void made.owedPass().catch((e) => log.warn(`looking at the slots that owe a settle in ${userText(projectPath)}`, e))
    return made
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
 *
 * A lane's lease (`laneEnded`, `laneAbandoned`; `at`: its workspace and pool) is ended gently instead (HI-1706,
 * LANES_GENTLE_END on): laneEnd.
 *
 * A carried lease's end (#1441: an adopted worktree, kept for a card or lane from the upgrade) never stops an agent
 * that has work elsewhere (HI-1731: HB3 was stopped mid-lane when the card its old folder was kept for went to Done):
 * workNow, conservative (what can't be told counts as work). Its run goes on, and the slot drains once it leaves the
 * folder (its next start elsewhere moves it); nothing reuses or removes a slot while it has a writer. With nothing else,
 * it is stopped once its turn is over: workNow, the run, its idleness and the slot's writer read again at that moment,
 * with nothing awaited between that look and the stop (HR4's design review: work arriving during an await is never
 * missed). Work found is asked again at each idle moment after, until the run leaves the slot (HI-1784: the watch on
 * the lane's last card, ending a moment after the lane, kept B1 in its old folder for good). The promise returned (a
 * carried lease's only) settles once the first look is made.
 */
export function stopLeaseSession(projectPath: string, lease: SlotLease, slot: Slot, at?: { ws: WorkspaceService; pool: SlotPool }): Promise<void> | void {
  const w = slot.writer
  if (!w || w.lease !== lease.id) return
  if (lease.kind === 'carried' && at) {
    // Logged when what keeps it changes, not at each look.
    let kept: string | null = null
    const keep = (work: string): void => {
      if (work === kept) return
      kept = work
      log.info(`Keeps ${userText(w.agent)}'s session in ${userText(slot.name)} running: its carried lease ${lease.id} ended (${lease.why ?? 'released'}), but it ${work}`)
    }
    // Its one await first (watches.ts, imported here: it registers its delivery sources as it loads, which slots' own
    // users needn't); every look after it is synchronous.
    return import('./watches').then(
      (watches) => {
        const go = (): boolean => {
          const work = workNow(projectPath, w.agent, lease, at, watches.watchKnown)
          if (work) keep(work)
          return !work
        }
        const writerNow = (): SlotWriter | null => at.pool.slots().find((s) => s.name === slot.name)?.writer ?? null
        stopWhenIdle(projectPath, lease, slot, w, { go, writerNow })
      },
      (e) => keep(`may work elsewhere (that couldn't be told: ${e instanceof Error ? e.message : String(e)})`) // i18n-ignore: a log line
    )
  }
  // This Combwork's run of it, still (another Combwork's run, or one already over, isn't this Combwork's to stop).
  const mine = (): { run: string; starting: boolean } | null => {
    const r = sessions.runNow(projectPath, w.agent)
    return r && r.run === w.run ? r : null
  }
  if (at && lease.lane && (lease.why === 'laneEnded' || lease.why === 'laneAbandoned') && advanced.get<boolean>(LANES_GENTLE_END) !== false && !mine()?.starting) {
    laneEnd(projectPath, lease, slot.name, w, at)
    return
  }
  // At the idle moment, the slot's writer still this run under this lease (HI-1762: its next card's start may have taken
  // the slot over meanwhile, its run then under the new lease, which this end must never stop).
  const writerNow = at ? (): SlotWriter | null => at.pool.slots().find((s) => s.name === slot.name)?.writer ?? null : null
  stopWhenIdle(projectPath, lease, slot, w, writerNow ? { go: () => true, writerNow } : undefined)
}

/**
 * What an agent works on besides a lease that ended (HI-1731), in words for the log, or null when nothing: another open
 * lease of its in the pool; a running lane of the project it builds or reviews; a card of the project in flight (past
 * Todo, not Done) it builds or reviews, with or without a lease yet; a watch of its own. All read now, synchronously
 * (the pool's leases, the lanes' and cards' tables, the watches kept): nothing can arrive between its reads and what is
 * done with its answer. Conservative: watches not loaded yet, or anything that can't be read, count as work.
 */
export function workNow(projectPath: string, agent: string, lease: SlotLease, at: { ws: WorkspaceService; pool: SlotPool }, watchKnown: (projectPath: string, agent: string) => { label: string } | null | 'unknown'): string | null {
  try {
    const other = at.pool.leasesOf(agent).find((l) => l.id !== lease.id && !l.to)
    if (other) return `holds lease ${other.id} (${other.lane ? `lane ${other.lane}` : other.card !== null ? `#${other.card}` : other.kind})` // i18n-ignore: a log line
    const project = basename(projectPath)
    const lane = boardRead(at.ws, (db) => db.prepare("SELECT id, builder_id AS builder FROM lanes WHERE state = 'active' AND project = ? COLLATE NOCASE AND (builder_id = ? OR reviewer_id = ?) ORDER BY ord LIMIT 1").get(project, agent, agent) as { id: string; builder: string } | undefined) // i18n-ignore: SQL
    if (lane) return `${lane.builder === agent ? 'builds' : 'reviews'} lane ${lane.id}` // i18n-ignore: a log line
    const card = boardRead(at.ws, (db) => db.prepare("SELECT number FROM cards WHERE archived = 0 AND project = ? COLLATE NOCASE AND (agent = ? OR review_agent = ?) AND coalesce(stage, CASE col WHEN 'todo' THEN 'todo' WHEN 'done' THEN 'done' END, '') NOT IN ('todo', 'done') ORDER BY number LIMIT 1").get(project, agent, agent) as { number: number } | undefined) // i18n-ignore: SQL
    if (card) return `has #${card.number} in flight` // i18n-ignore: a log line
    const watch = watchKnown(projectPath, agent)
    if (watch === 'unknown') return "may watch something (its watches aren't loaded yet)" // i18n-ignore: a log line
    if (watch) return `watches (${userText(watch.label)})` // i18n-ignore: a log line
    return null
  } catch (e) {
    return `may work elsewhere (that couldn't be told: ${e instanceof Error ? e.message : String(e)})` // i18n-ignore: a log line
  }
}

/**
 * The lease's run stopped once its turn and its runs have finished; a start still being prepared at once (#1434).
 * `check` (a carried lease's, HI-1731): at that moment, with nothing awaited, the run still the slot's writer under this
 * lease (`writerNow`; not: nothing more is looked at), then `go` (false: it has work, kept running and asked again at
 * its next idle moment, HI-1784).
 */
function stopWhenIdle(projectPath: string, lease: SlotLease, slot: Slot, w: SlotWriter, check?: { go: () => boolean; writerNow: () => SlotWriter | null }): void {
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
    if (check) {
      const writer = check.writerNow()
      if (!writer || writer.run !== w.run || writer.lease !== lease.id) return done()
      // Work now: asked again at its next idle moment.
      if (!check.go()) return
    }
    done()
    log.info(`Stopping ${userText(w.agent)}'s ${r.starting ? 'start' : 'session'} in ${userText(slot.name)}: its lease ${lease.id} ended (${lease.why ?? 'released'})`)
    sessions.stop(projectPath, w.agent)
  }
  off = onCombworkEvent((e) => {
    if ((e.type === 'session-status' && e.state.agentId === w.agent && e.state.projectPath.toLowerCase() === projectPath.toLowerCase()) || e.type === 'progress-changed') look()
  })
  look()
}

/** The lane-finished notes' source (HI-1706): one per lane lease's end, its ref the lease's id. */
export const LANE_END_SOURCE = 'lane-end'
/** At most this many of a lane's cards are named in its note (then "and N more"), and the note at most this long. */
const NOTE_CARDS = 20
const NOTE_MAX_CHARS = 2000
/** How often a lane's end looks again with no event (a typing pause or a line's wait ending tells nothing). */
const LANE_END_RECHECK_MS = 5000

/**
 * The note a lane's builder is given as its lane ends (HI-1706): the lane, each card's merge commit (or that it wasn't
 * merged), and that its session ends once its turn does. Agent-facing: English. At most NOTE_CARDS cards named.
 */
export function laneEndNote(lane: string, abandoned: boolean, cards: readonly { key: string; merged: string | null }[]): string {
  const named = cards.slice(0, NOTE_CARDS).map((c) => (c.merged ? say(T.merged, { card: c.key, commit: c.merged.slice(0, 12) }) : say(T.notMerged, { card: c.key })))
  const more = cards.length > NOTE_CARDS ? [say(T.more, { count: String(cards.length - NOTE_CARDS) })] : []
  const list = [...named, ...more].join('; ')
  const text = say(T.laneEnd, { abandoned: abandoned ? 'yes' : 'no', lane, listed: list ? 'yes' : 'no', list })
  return text.length > NOTE_MAX_CHARS ? `${text.slice(0, NOTE_MAX_CHARS - 1)}…` : text
}

/**
 * Why a lane's builder's run isn't done with its turn yet (HI-1706), or null when it is: in a turn as its status or its
 * hooks say (a Stop the drain carried on is still one), a line of Combwork's or the user's not taken, its runs or background
 * tasks going, or a delivery still to reach it (the lane's note among them until it is read), whether or not the gate
 * gives it yet. No settle time: each is a state. All read at one moment with nothing awaited (HR1's round 1 finding 1),
 * so the answer is never older than the look that acts on it; sessions.quit asks it again at each key and before Enter.
 */
export function laneEndHeldNow(projectPath: string, agent: string, run: string): string | null {
  if (agentBusy(projectPath, agent)) return 'it is in a turn' // i18n-ignore: a reason for the log
  if (sessions.turnOpen(projectPath, agent, run)) return 'its turn is still open' // i18n-ignore: a reason for the log
  const going = agentRunsGoing(projectPath, agent)
  if (going.length) return `its runs are going (${going.join(', ')})` // i18n-ignore: a reason for the log
  if (sessions.lineWaiting(projectPath, agent)) return "a line typed into it isn't taken yet" // i18n-ignore: a reason for the log
  const waiting = waitingForRunNow(projectPath, agent, run, sessions.liveFor(projectPath, agent)?.sessionId || null)
  if (waiting.length) return `deliveries still to reach it (${waiting.map((r) => r.id).join(', ')})` // i18n-ignore: a reason for the log
  return null
}

// A connection switch at an agent's safe point waits on the same (HI-1755): given to sessions as this loads.
sessions.safePointHeld = laneEndHeldNow

/** laneEndHeldNow once the project's deliveries are read (the only await, before every state is read). */
export async function laneEndWaitsFor(projectPath: string, agent: string, run: string): Promise<string | null> {
  await deliveriesOf(projectPath, agent)
  return laneEndHeldNow(projectPath, agent, run)
}

/** What laneEnd works with (HI-1706): the real ones in Combwork, a test's own in unit tests. */
export interface LaneEndDeps {
  /** Whether the end still owns that run: its workspace open, the run the agent's now, the slot's writer under the lease. */
  fenced: () => boolean
  /** laneEndWaitsFor's answer for the run. */
  waitsFor: () => Promise<string | null>
  /** Makes the lane's note once (its id, or null when there is none to give: no inbox, refused). */
  note: () => Promise<string | null>
  /** Cancels the note if it hasn't been read (the end lost its run, or is over). */
  retire: (why: string) => Promise<void>
  /** sessions.quit for the run, fenced; not forced, it asks laneEndHeldNow again at each key and before Enter. */
  quit: (why: string, force: boolean) => Promise<'sent' | 'held' | 'gone'>
  /** Calls the function at each change that may matter; returns the unsubscribe. */
  watch: (look: () => void) => () => void
  now: () => number
  /** When the end stops waiting for the turn (absolute, ms): set once from the lease's end, never moved. */
  deadline: number
  log: (line: string) => void
}

/**
 * Waits for a lane's builder's turn to be over, then ends its run with its CLI's exit (HI-1706). Looked at again on
 * each change and every few seconds, one look at a time; the note is made at the first look. Ends when the quit is sent,
 * the fence is lost (nothing is typed or killed then, and the unread note is retired), or the run is gone. Past the
 * deadline it quits whatever it waits for (forced: killed where its prompt can't be typed into).
 *
 * The fence and the deadline never wait for a look's work (HR1's round 1 finding 2): each change, recheck and the
 * deadline's own timer checks them at once, and past the deadline or with the fence lost, any look still awaiting its
 * note, its states or its quit is dropped (its epoch is over: what it finds later acts on nothing). Only one quit runs at
 * a time: the forced one waits for one already typing (bounded by its own typing) rather than start a second.
 */
export function waitForLaneEnd(d: LaneEndDeps): { done: Promise<string> } {
  let over = false
  let looking = false
  let again = false
  let noted = false
  let forcing = false
  let lastWhy: string | null = null
  /** Bumped when the deadline or the fence's loss takes over: a look begun before acts on nothing it finds after. */
  let epoch = 0
  let quitting: Promise<'sent' | 'held' | 'gone'> | null = null
  let resolve!: (why: string) => void
  const done = new Promise<string>((r) => (resolve = r))
  const timers: NodeJS.Timeout[] = []
  let unwatch: (() => void) | null = null
  const finish = (why: string): void => {
    if (over) return
    over = true
    epoch++
    unwatch?.()
    for (const t of timers) clearTimeout(t)
    d.log(why)
    resolve(why)
  }
  const lost = (): void => {
    if (over) return
    finish('the run or its lease is gone: nothing ended') // i18n-ignore: for the log
    void d.retire('its lane end lost its run').catch(() => undefined) // i18n-ignore: for the log
  }
  /** The one quit at a time. */
  const quitOnce = (why: string, force: boolean): Promise<'sent' | 'held' | 'gone'> => {
    if (!quitting) quitting = d.quit(why, force).finally(() => (quitting = null))
    return quitting
  }
  /** Past the deadline: whatever a look awaits is dropped, and the run is ended forced. */
  const forced = async (): Promise<void> => {
    if (over || forcing) return
    forcing = true
    epoch++
    try {
      // A quit already typing finishes (or gives up) first: never two at once.
      if (quitting) await quitting.catch(() => 'held')
      if (over) return
      if (!d.fenced()) return lost()
      const r = await quitOnce(`its lane ended and it didn't finish its turn in time (${lastWhy ?? 'unknown'})`, true) // i18n-ignore: a reason for the log
      if (over) return
      if (r === 'gone') return lost()
      // 'held': input arrived while it typed; the next recheck forces it again.
      if (r === 'held') return
      finish('ended past the deadline') // i18n-ignore: for the log
      await d.retire('its run ended').catch(() => undefined) // i18n-ignore: for the log
    } finally {
      forcing = false
    }
  }
  const step = async (): Promise<void> => {
    const mine = epoch
    const dropped = (): boolean => over || epoch !== mine
    if (!noted) {
      noted = true
      try {
        await d.note()
      } catch (e) {
        d.log(`its lane's note wasn't made: ${(e as Error).message}`)
      }
      // Made after its end was over (the fence lost, or ended forced, meanwhile): retired, as the end retired none.
      if (over) return void d.retire('its lane end was over before its note was made').catch(() => undefined) // i18n-ignore: for the log
      if (dropped()) return
      if (!d.fenced()) return lost()
    }
    const why = await d.waitsFor()
    if (dropped()) return
    if (!d.fenced()) return lost()
    if (d.now() >= d.deadline) return forced()
    if (why) {
      if (why !== lastWhy) d.log(`waiting: ${why}`)
      lastWhy = why
      return
    }
    const r = await quitOnce('its lane ended and its turn is over', false) // i18n-ignore: a reason for the log
    if (dropped()) return
    if (r === 'held') return
    if (r === 'gone') return lost()
    finish('ended once its turn was over') // i18n-ignore: for the log
  }
  const look = (): void => {
    if (over) return
    // The fence and the deadline first, whatever a look awaits.
    if (!d.fenced()) return lost()
    if (d.now() >= d.deadline) return void forced()
    if (looking) {
      again = true
      return
    }
    looking = true
    void (async () => {
      try {
        // finish() sets `over` (and the deadline `epoch`): read through a call, as the loop can't see that.
        const ended = (): boolean => over
        do {
          again = false
          await step()
        } while (again && !ended())
      } catch (e) {
        d.log(`a look failed: ${(e as Error).message}`)
      } finally {
        looking = false
      }
    })()
  }
  unwatch = d.watch(look)
  const tick = (): void => {
    if (over) return
    look()
    timers.push(setTimeout(tick, LANE_END_RECHECK_MS))
  }
  timers.push(setTimeout(tick, LANE_END_RECHECK_MS))
  timers.push(setTimeout(look, Math.max(0, d.deadline - d.now()) + 50))
  look()
  return { done }
}

/** The lane leases being ended now (by id): a second end of the same lease joins the first, never makes another note. */
const laneEnds = new Map<string, { done: Promise<string> }>()

/** A lane lease's gentle end under way (tests): how it ends (its log's last word), or null when none is. */
export const laneEndOf = (lease: string): Promise<string> | null => laneEnds.get(lease)?.done ?? null

/**
 * A lane's lease ended with its builder still running in the slot (HI-1706): its run is ended gently. The builder is
 * told the lane is finished (or abandoned), with each card's merge commit, in a note for that run alone; once its turn is
 * over (laneEndWaitsFor) its CLI is ended with its own exit command (sessions.quit), killed only if that doesn't end it.
 * Fenced throughout to that run, that lease and the workspace's lifetime. The slot stays the writer's until it exits.
 */
function laneEnd(projectPath: string, lease: SlotLease, slotName: string, w: SlotWriter, at: { ws: WorkspaceService; pool: SlotPool }): void {
  if (laneEnds.has(lease.id)) return
  const { ws, pool } = at
  const life = ws.lifetime
  const label = `${userText(w.agent)} in ${userText(slotName)}` // i18n-ignore: for the log
  const ended = Date.parse(lease.to ?? '') || Date.now()
  const fenced = (): boolean => {
    if (life.aborted) return false
    const r = sessions.runNow(projectPath, w.agent)
    if (!r || r.run !== w.run || r.starting) return false
    const writer = pool.slots().find((s) => s.name === slotName)?.writer
    return !!writer && writer.run === w.run && writer.lease === lease.id
  }
  const note = async (): Promise<string | null> => {
    if (!agentReadsInbox(projectPath, w.agent)) return null
    // Once per lease end, whatever became of one made before (read, cancelled): durable in the deliveries, and joined
    // in memory meanwhile (laneEnds).
    await deliveriesOf(projectPath, w.agent)
    const made = fromSource(projectPath, LANE_END_SOURCE).find((r) => r.ref === lease.id)
    if (made) return made.id
    const lane = lease.lane ? await getLane(ws, lease.lane).catch(() => null) : null
    const wf = await workflowFor(ws, projectPath).catch(() => null)
    const cards = (lane?.cards ?? []).map((c) => {
      let merged: string | null = null
      try {
        merged = wf ? (wf.state(wf.store.card(c.number)).integrated?.result ?? null) : null
      } catch {
        // A card gone from the board: named, not merged.
      }
      return { key: cardKeyOf(ws, c.number)?.key ?? `#${c.number}`, merged }
    })
    const st = sessions.liveFor(projectPath, w.agent)
    const r = await createDelivery(projectPath, { agentId: w.agent, agentName: st?.agentName, conversation: st?.sessionId || null, kind: 'control', from: { kind: 'combwork', name: 'Combwork' }, body: inDialectOf({ projectPath, agentId: w.agent }, () => laneEndNote(lane?.name ?? lease.lane ?? '', lease.why === 'laneAbandoned', cards)), source: LANE_END_SOURCE, ref: lease.id, forRun: w.run }) // i18n-ignore: the product's name, as a delivery's sender
    await offerNow(projectPath, w.agent)
    return r.id
  }
  const waiter = waitForLaneEnd({
    fenced,
    waitsFor: () => laneEndWaitsFor(projectPath, w.agent, w.run),
    note,
    retire: async (why) => void (await cancelFromSource(projectPath, LANE_END_SOURCE, lease.id, why)),
    quit: (why, force) => sessions.quit(projectPath, w.agent, w.run, { fenced, why, force, ready: () => laneEndHeldNow(projectPath, w.agent, w.run), cause: 'lane' }),
    watch: (look) => {
      const offEvents = onCombworkEvent((e) => {
        if ((e.type === 'session-status' && e.state.agentId === w.agent && e.state.projectPath.toLowerCase() === projectPath.toLowerCase()) || e.type === 'progress-changed') look()
      })
      const offDeliveries = onDeliveriesChanged((host, agents) => {
        if (host.toLowerCase() === projectPath.toLowerCase() && agents.has(w.agent)) look()
      })
      return () => {
        offEvents()
        offDeliveries()
      }
    },
    now: () => Date.now(),
    deadline: ended + advanced.number(LANES_END_WAIT_MINUTES) * 60_000,
    log: (line) => log.info(`Lane ${userText(lease.lane ?? '')}'s end, ${label} (lease ${lease.id}): ${line}`)
  })
  laneEnds.set(lease.id, waiter)
  void waiter.done.finally(() => laneEnds.delete(lease.id))
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
        .then(async (p) => (await p.settleGoneWriters(), p.tidy()))
        .catch((e) => log.warn(`tidying the slots of ${userText(path)}`, e))
      sweepSealsOf(join(ws.worktreesRoot, basename(path)))
    }
  }
}

/** Told when a slot may have come free (its writer drained): slotCards.ts's lanes waiting for a slot try again. */
let slotFreedFn: ((ws: WorkspaceService, projectPath: string) => void) | null = null
export function setSlotFreed(fn: typeof slotFreedFn): void {
  slotFreedFn = fn
}
/** Also told each time (HI-2304): a connection switch whose resume waits for its slot. */
const freedListeners = new Set<(projectPath: string) => void>()
function slotFreed(ws: WorkspaceService, projectPath: string): void {
  slotFreedFn?.(ws, projectPath)
  for (const fn of freedListeners) {
    try {
      fn(projectPath)
    } catch (e) {
      log.warn('after a slot came free', e)
    }
  }
}
sessions.slotFreedWatch = (fn) => {
  freedListeners.add(fn)
  return () => freedListeners.delete(fn)
}

/** Starts the hourly tidy (index.ts, once); a workspace closing closes its pools. */
export function startSlots(): void {
  if (timer) return
  timer = setInterval(() => void tidyOpenPools(), TIDY_MS)
  timer.unref()
  WorkspaceService.closingTasks.add(forgetPools)
  // Slots' writers (#1434, agentFolders.ts): this Combwork as their holder, their runs' tokens among its live ones, a claim
  // tracked as its project's pool's work (close awaits it), and a writer released handed to its pool.
  setWriterHost({
    self: holder.self,
    alive: holder.alive,
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
      slotFreed(ws, projectPath)
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

/** Each pool's view of its jj slots' staleness (HI-2912): gone with the pool, so a workspace opened again starts afresh. */
const staleViews = new WeakMap<SlotPool, SlotStaleView>()
function staleViewOf(pool: SlotPool): SlotStaleView {
  let v = staleViews.get(pool)
  if (!v) {
    v = new SlotStaleView({
      row: (name) => pool.slots().find((x) => x.name === name) ?? null,
      owes: (name) => pool.owedOf(name) !== null,
      read: async (folder) => {
        const r = await jjPort().stale(folder)
        return isUnknown(r) ? null : r
      },
      generation: generationOf
    })
    staleViews.set(pool, v)
  }
  return v
}

/**
 * A pool's slots as the window reads them (`slots:list`). A writer is held (#1506) when its run isn't live here and its
 * Combwork is this one or one known to have gone: Release Slot… is offered for it.
 */
export async function slotViews(pool: SlotPool): Promise<SlotView[]> {
  const slots = pool.slots()
  const view = staleViewOf(pool)
  view.keepOnly(slots.map((s) => s.name))
  return Promise.all(
    slots.map(async (s) => {
      const l = pool.openLease(s.name)
      const w = s.writer
      const held = !!w && (await writerHeld(w))
      // A jj slot (HI-2869): stale only when J2's read says so (never a guess); its Recover… is the user's. Not read while
      // the pool works on the slot or it owes a settle (HI-2912, slotStaleView.ts): its last answer for that folder.
      const jj = s.platform === 'jj'
      const stale = jj ? await view.staleOf(s.name) : false
      return { name: s.name, folder: s.folder, state: s.state, warmError: s.warmError, warmLog: s.warmLog, lease: l ? { id: l.id, kind: l.kind, agent: l.agent, card: l.card, lane: l.lane } : null, writer: w ? { agent: w.agent, lease: w.lease, held } : null, ...(jj ? { platform: 'jj' as const } : {}), ...(stale ? { stale: true as const } : {}) }
    })
  )
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
    case 'writer':
      // A run of another Combwork's writing in a lent slot (#1561's scenario): its Combwork gone when that process has ended.
      return pool.deps.store.conn.write((db) => Number(db.prepare("UPDATE slots SET writer_run = ?, writer_lease = (SELECT l.id FROM slot_leases l WHERE l.project = slots.project AND l.slot = slots.name AND l.ended_at IS NULL), writer_agent = ?, writer_pid = ?, writer_started = ? WHERE project = ? AND name = ? AND writer_run IS NULL").run(op.run, op.agent, op.pid, op.started, pool.deps.store.project, op.slot).changes) === 1) // i18n-ignore: SQL
    case 'quit': {
      // A lane's end's quit of a running CLI (HI-1706's cliquit, the real Claude Code and Codex): its run now, unfenced.
      const r = sessions.runNow(pool.deps.project, op.agent)
      return r ? sessions.quit(pool.deps.project, op.agent, r.run, { fenced: () => true, why: 'a test asked', cause: 'lane' }) : 'gone' // i18n-ignore: for the log
    }
    default:
      throw new Error('unknown slot test op') // i18n-ignore: a test channel, never shown
  }
}
