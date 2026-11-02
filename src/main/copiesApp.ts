// Review and check copies in the app (#1435, copies.ts): one pool per open workspace and project, on the workspace's
// board, keyed by the project's id. Its warming runs are Hive's own, credited to the lease's agent (HI-1710), in jobs on the process
// supervisor as slots' are (slotsApp.ts); its leases carry this Hive's profile, pid and start.
//
// Isolated checks (`hive-progress --check <name> --isolated`, SPEC §16.13): the Agent API's resolve leases a check copy
// at the card's revision and opens the lease's job on the supervisor (`copy-<lease>`, recorded on the lease first);
// hive-progress starts the command's launcher in the copy and has it put in that job (POST /v1/progress/isolated)
// before it runs anything, so every process of the check is the lease's. Its run's start takes the lease (its ref
// becomes the run), its finish returns it, and Stop in the Progress panel ends the job (the whole tree). A returned copy
// is freed through the barrier (copies.ts), which settles the job first. Every 30 s, the pools with copies returning are
// looked at again; their holders going idle or their runs ending show there.

import { app } from 'electron'
import { basename, join } from 'path'
import { advanced } from './advanced'
import { inAgentLaunch, processSupervisor } from './agentProcesses'
import { boardRead } from './boardStore'
import { config } from './config'
import { containsPlace } from './fsutil'
import { createLogger, userText } from './logger'
import { progress } from './progressService'
import { sessions } from './sessions'
import { appRunner, appSettle, boardConn, holder, journalsOf, retireSealOf, sweepSealsOf } from './slotsApp'
import { slotLevelsOf, slotOptionsOf } from './slots'
import { openWorkspaces, WorkspaceService } from './workspace'
import { CopyPool, CopyStore, copiesDirOf, copyPoolSize, IsolatedRequests, type CopyLease } from './copies'
import { journalPath, LeaseJob } from './workflow/queueJobs'
import { LINK_TTL_MS } from './workflow/runLink'
import { projectAgents } from '../shared/defaults'
import { agentWorkflowRole, reviewsWork } from '../shared/workflow/roles'
import { isOpenRun } from '../shared/progress'
import type { CopyView } from '../shared/types'
import { COPIES_QUIET_WAIT, COPIES_REVIEW, SLOTS_REMOVE_IDLE, WORKFLOW_ENFORCE } from '../shared/advanced'

const log = createLogger('copies')

/** How often the pools with copies returning are looked at again. */
const LOOK_MS = 30_000

const pools = new Map<string, { life: AbortSignal; pool: Promise<CopyPool> }>()
const poolKey = (ws: WorkspaceService, projectPath: string): string => `${(ws.path ?? '').toLowerCase()}\n${projectPath.toLowerCase()}`

/** The open jobs of isolated runs' leases, by lease id (closed once settled). */
const jobs = new Map<string, LeaseJob>()

/** A project's copies pool in a workspace (made on first use, for the workspace's life). */
export function copiesFor(ws: WorkspaceService, projectPath: string): Promise<CopyPool> {
  const key = poolKey(ws, projectPath)
  const known = pools.get(key)
  if (known && known.life === ws.lifetime && !known.life.aborted) return known.pool
  const pool = (async () => {
    const cfg = await ws.projectConfig(projectPath)
    const root = join(ws.worktreesRoot, basename(projectPath))
    const workspacePath = ws.path ?? ''
    const made = new CopyPool({
      store: new CopyStore(boardConn(ws), cfg.id ?? basename(projectPath)),
      project: projectPath,
      dir: copiesDirOf(ws.worktreesRoot, projectPath),
      options: async () => slotOptionsOf(await ws.projectConfig(projectPath), slotLevelsOf(config.settings, ws)),
      size: async () => {
        const c = await ws.projectConfig(projectPath)
        return copyPoolSize(projectAgents(c).filter((a) => reviewsWork(agentWorkflowRole(a))).length, c.copies?.size)
      },
      runner: appRunner(ws, projectPath, root),
      settle: async (job) => {
        const ok = await appSettle(root)(job)
        if (ok) {
          const closing: Promise<void>[] = []
          for (const [id, j] of jobs) {
            if (j.lease !== job) continue
            jobs.delete(id)
            assigned.delete(id)
            closing.push(j.close().catch(() => undefined))
          }
          // Its seal goes once its job is gone (HI-1723): after this Hive let its own handle go.
          void Promise.all(closing).then(() => retireSealOf(root, job))
        }
        return ok
      },
      holder,
      profile: basename(app.getPath('userData')),
      runIn: (folder) => {
        const r = progress.list(workspacePath).find((x) => isOpenRun(x) && !!x.folder && containsPlace(folder, x.folder))
        return r ? `${r.agentName}: ${r.title}` : null
      },
      holderBusy: (agent) => {
        const s = sessions.liveFor(projectPath, agent)
        return s && (s.status === 'working' || s.status === 'waiting' || s.status === 'background') ? `${s.agentName ?? agent} (${s.status})` : null
      },
      leaseOver: (l) => (l.kind === 'review' ? (reviewOver?.(ws, projectPath, l) ?? null) : leaseOver(workspacePath, l)),
      // Review leases: with review copies on, and workflow rules enforced (off, Hive records facts and leases nothing, #1439).
      reviewOn: () => advanced.get(COPIES_REVIEW) !== false && advanced.get<boolean>(WORKFLOW_ENFORCE) !== false,
      quietWaitMs: () => Math.max(1, Number(advanced.get(COPIES_QUIET_WAIT)) || 10) * 60_000
    })
    // The seals of jobs settled before this Hive started (HI-1723; the folder slots' jobs share).
    sweepSealsOf(root, { once: true })
    return made
  })()
  pools.set(key, { life: ws.lifetime, pool })
  pool.catch(() => pools.delete(key))
  return pool
}

/**
 * Whether a review lease's review is over (#1439, reviewCopies.ts: its reviewer's review of the card has ended), as this
 * Hive knows; null: can't tell. And what runs after each look at the pools (waiting reviews leasing again).
 */
let reviewOver: ((ws: WorkspaceService, projectPath: string, l: CopyLease) => Promise<boolean | null>) | null = null
let afterLook: (() => Promise<void>) | null = null
export function setReviewCopyHooks(h: { over: typeof reviewOver; afterLook: typeof afterLook } | null): void {
  reviewOver = h?.over ?? null
  afterLook = h?.afterLook ?? null
}

/**
 * Whether a check lease's run is over, as this Hive knows: its run ended (or never started within a link's life).
 */
function leaseOver(workspacePath: string, l: CopyLease): boolean | null {
  if (l.kind !== 'check') return null
  const run = l.ref ? progress.list(workspacePath).find((r) => r.id === l.ref) : undefined
  if (run) return !isOpenRun(run)
  return Date.now() - Date.parse(l.from) > LINK_TTL_MS
}

/**
 * Leases a check copy for an isolated run (the Agent API's resolve) and opens its job: the lease and the copy's folder,
 * or why not (`wait`: none free yet; `refused`: its setup failed).
 */
export async function isolatedLease(ws: WorkspaceService, projectPath: string, req: { card: number; revision: string; agent: string | null }): Promise<{ lease: CopyLease; folder: string; copy: string } | { wait: string } | { refused: string }> {
  const pool = await copiesFor(ws, projectPath)
  const r = await pool.leaseCopy({ kind: 'check', card: req.card, revision: req.revision, agent: req.agent })
  if (!r.ok) {
    if (r.refusal.why === 'noCopy') return { wait: 'a check copy' } // i18n-ignore: hive-progress's words, agent-facing
    if (r.refusal.why === 'stillInUse') return { wait: `a check copy (${r.refusal.copy} is still in use by ${r.refusal.by})` } // i18n-ignore: hive-progress's words, agent-facing
    if (r.refusal.why === 'returned') return { wait: 'a check copy' } // i18n-ignore: hive-progress's words, agent-facing
    return { refused: r.refusal.why === 'setupFailed' ? `${r.refusal.copy}'s setup failed (${r.refusal.error}), so nothing was run` : 'no check copy could be leased' } // i18n-ignore: hive-progress's words, agent-facing
  }
  // The job its run's processes go in: recorded on the lease before it exists, then made (kill on close, journaled).
  const job = await pool.setLeaseJob(r.lease.id)
  const host = processSupervisor()
  const root = join(ws.worktreesRoot, basename(projectPath))
  const opened = job && host.usable && (await host.ensure()) ? await LeaseJob.open(host, job, await journalPath(root, job, journalsOf(root))) : null
  if (!opened || 'problem' in opened) {
    await pool.returnCopy(r.lease.id, 'noJob')
    return { refused: "Hive's process supervisor isn't running, so an isolated check can't be run" } // i18n-ignore: hive-progress's words, agent-facing
  }
  jobs.set(r.lease.id, opened)
  return { lease: r.lease, folder: r.copy.folder, copy: r.copy.name }
}

/** Isolated runs' copies being leased apart from the Agent API's requests (copies.ts' IsolatedRequests). */
const requests = new IsolatedRequests<{ lease: CopyLease; folder: string; copy: string }>((project, lease) => {
  void Promise.all(openWorkspaces().map((ws) => copiesFor(ws, project).then((p) => p.returnCopy(lease.id, 'abandoned')).catch(() => false))).catch(() => undefined)
})

/**
 * An isolated run's copy, asked for and set up without holding the Agent API's request (HR1's #1435 round 1: a first
 * setup outlasts any request's time limit): `wait` with a ticket to ask again with, until the copy is ready.
 */
export function isolatedRequest(ws: WorkspaceService, projectPath: string, owner: string, req: { card: number; revision: string; agent: string | null }, ticket?: string): Promise<{ lease: CopyLease; folder: string; copy: string } | { wait: string; ticket: string } | { refused: string }> {
  return requests.ask(owner, projectPath, `${req.card}|${req.revision}`, () => isolatedLease(ws, projectPath, req), ticket, ws.lifetime)
}

/** The link resolve gave out is the lease's run until its run starts. */
export async function isolatedLinked(ws: WorkspaceService, projectPath: string, lease: string, ref: string): Promise<void> {
  await (await copiesFor(ws, projectPath)).setRef(lease, ref)
}

/** The leases whose launcher has been put in their job: one each. */
const assigned = new Set<string>()

/**
 * Puts an isolated run's launcher (its pid, started between the readings) in its lease's job: only the lease's own
 * agent's, once per lease, while the lease is out, and only a process of that agent's own (in its launch's job, started
 * in that window: never another's, HR1's #1435 round 1). A lease returned meanwhile gets nothing new in its job; one
 * returned after it is in has the job ended by the barrier. Why not, or null once it is.
 */
export async function assignIsolated(ws: WorkspaceService, projectPath: string, agent: string, a: { lease: string; pid: number; after: number; before: number }): Promise<string | null> {
  const pool = await copiesFor(ws, projectPath)
  const l = pool.lease(a.lease)
  if (!l || l.agent !== agent) return 'no such check copy lease' // i18n-ignore: hive-progress's words, agent-facing
  if (!(await inAgentLaunch(projectPath, agent, a.pid, a.after, a.before))) return "that process isn't one of this agent's own" // i18n-ignore: hive-progress's words, agent-facing
  const job = jobs.get(a.lease)
  if (!job || assigned.has(a.lease)) return "its check copy's job takes no launcher now" // i18n-ignore: hive-progress's words, agent-facing
  // Taken before the await that assigns: a second call for the lease is refused, never two launchers in it.
  assigned.add(a.lease)
  if (pool.lease(a.lease)?.returned) return 'its check copy was returned' // i18n-ignore: hive-progress's words, agent-facing
  return (await job.assign(a.pid, a.after, a.before)) ? null : "the check's launcher couldn't be put in its check copy's job" // i18n-ignore: hive-progress's words, agent-facing
}

/** The lease a run holds (its isolated check), in any open pool of the workspace. */
async function leaseOfRun(ws: WorkspaceService, runId: string): Promise<{ pool: CopyPool; lease: CopyLease } | null> {
  for (const [k, v] of pools) {
    if (!k.startsWith(`${(ws.path ?? '').toLowerCase()}\n`) || v.life !== ws.lifetime) continue
    const pool = await v.pool.catch(() => null)
    const lease = pool?.leaseByRef(runId)
    if (pool && lease) return { pool, lease }
  }
  return null
}

/** A run ended (its finish): its isolated check's copy returned, freed once quiet. */
export async function isolatedRunEnded(ws: WorkspaceService, runId: string): Promise<void> {
  const got = await leaseOfRun(ws, runId)
  if (got && !got.lease.returned) await got.pool.returnCopy(got.lease.id, 'runEnded')
}

/** Runs Stop ended (their finish is recorded as stopped, not failed), until that finish; bounded. */
const stoppedRuns = new Set<string>()

/** Stop (the Progress panel) for an isolated run: its lease's job ended, so its whole tree is. Whether it had one. */
export async function stopIsolated(ws: WorkspaceService, runId: string): Promise<boolean> {
  const got = await leaseOfRun(ws, runId)
  const job = got && !got.lease.returned ? jobs.get(got.lease.id) : undefined
  if (!job) return false
  log.info(`Stopping isolated check ${runId} in ${userText(got!.lease.copy)}`)
  if (stoppedRuns.size >= 200) stoppedRuns.delete(stoppedRuns.values().next().value!)
  stoppedRuns.add(runId)
  await job.end().catch(() => false)
  return true
}

/** Whether a run was ended by Stop (once: its finish takes it). */
export function takeStopped(runId: string): boolean {
  return stoppedRuns.delete(runId)
}

/** The copy a folder is in and its lease not freed (a run there is a check of the lease's card and revision). */
export async function copyAt(ws: WorkspaceService, projectPath: string, folder: string): Promise<{ copy: string; lease: CopyLease | null } | null> {
  const got = (await copiesFor(ws, projectPath)).at(folder)
  return got ? { copy: got.copy.name, lease: got.lease } : null
}

/** A project's copies as the window reads them (`copies:list`). */
export async function copyViews(ws: WorkspaceService, projectPath: string): Promise<CopyView[]> {
  const pool = await copiesFor(ws, projectPath)
  return pool.copies().map((c) => {
    const l = pool.at(c.folder)?.lease ?? null
    return { name: c.name, folder: c.folder, state: c.state, revision: c.revision, warmError: c.warmError, lease: l ? { id: l.id, kind: l.kind, card: l.card, agent: l.agent, returned: !!l.returned } : null }
  })
}

/** Looks again at every open workspace's pools that have copies returning, or that `all` (the hourly tidy) asks for. */
export async function lookAtCopies(tidy = false): Promise<void> {
  requests.abandon()
  for (const ws of openWorkspaces()) {
    if (!ws.path) continue
    let ids: string[]
    try {
      ids = boardRead(ws, (db) => (db.prepare(tidy ? 'SELECT DISTINCT project FROM copies' : "SELECT DISTINCT project FROM copies WHERE state = 'returning' OR op IS NOT NULL OR job IS NOT NULL OR project IN (SELECT project FROM copy_leases WHERE kind = 'review' AND returned_at IS NULL)").all() as { project: string }[]).map((r) => r.project)) // i18n-ignore: SQL
    } catch {
      continue
    }
    const byId = ws.projectIdsNow().byId
    for (const id of ids) {
      const path = byId.get(id)
      if (!path) continue
      await copiesFor(ws, path)
        .then(async (p) => {
          if (tidy) await p.tidy(Date.now(), advanced.get(SLOTS_REMOVE_IDLE) !== false)
          else await p.refresh()
        })
        .catch((e) => log.warn(`looking at the copies of ${userText(path)}`, e))
      if (tidy) sweepSealsOf(join(ws.worktreesRoot, basename(path)))
    }
  }
  await afterLook?.().catch((e) => log.warn('leasing review copies for waiting reviews', e))
}

let timer: NodeJS.Timeout | null = null
let hourly: NodeJS.Timeout | null = null

/** Starts the looks (index.ts, once); a workspace closing closes its pools (their operations awaited). */
export function startCopies(): void {
  if (timer) return
  timer = setInterval(() => void lookAtCopies(), LOOK_MS)
  timer.unref()
  hourly = setInterval(() => void lookAtCopies(true), 60 * 60 * 1000)
  hourly.unref()
  WorkspaceService.closingTasks.add(closePools)
}

function closePools(path: string): Promise<void> {
  const mine = [...pools.entries()].filter(([k]) => k.startsWith(`${path.toLowerCase()}\n`))
  for (const [k] of mine) pools.delete(k)
  return Promise.allSettled(mine.map(([, v]) => v.pool.then((p) => p.close()))).then(() => undefined)
}

export function stopCopies(): void {
  if (timer) clearInterval(timer)
  if (hourly) clearInterval(hourly)
  timer = hourly = null
  WorkspaceService.closingTasks.delete(closePools)
}
