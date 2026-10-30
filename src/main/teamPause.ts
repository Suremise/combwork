import { app } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { rm } from 'original-fs/promises'
import { HIVE_DIR, projectAgents } from '../shared/defaults'
import { TEAM_PAUSE_LINE, type TeamPause } from '../shared/teamPause'
import { emit } from './events'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { inWorkspace, openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'

/**
 * Pausing the team before an update (HI-2081, SPEC §16.10.9; HR1's design checks s8, s10 and s12). A workspace's pause
 * is held in memory, where every gate asks it (`pausedFor`, `teamPauseOf`): lane starts, the new conversations Hive
 * starts by itself, the reviewer pool, the merge queue's next entry, and the deliveries of Hive's own wakes
 * (`pauseHolds`, deliveries.ts' admission gate). The user's pause covers every open workspace with one id, and a
 * workspace opened while it lasts is held by it too; the Assistant's covers its own workspace only, and its resume takes
 * its workspace out of the user's pause, which ends with the last workspace it held. Pause and resume take each
 * workspace's lock, which the gates' final checks read under, so a change is never half seen. Each running agent is told
 * once per pause (TEAM_PAUSE_LINE). Rules off: the same hold.
 *
 * Kept for this running Hive only (HI-2156, the Assistant's design call): a restart (an update, a reboot, a crash) ends
 * every agent a pause held, so Hive starts unpaused, and removes the files earlier builds saved a pause in.
 */

const log = createLogger('teamPause')

/** Where earlier builds saved a pause: each workspace's `.hive`, and the profile (with what a close left of them). */
const OLD_FILE = 'team-pause.json'
const OLD_CLOSING_FILE = 'team-pause-closing.json'

/** Each workspace's pause (by its .hive folder, lower case): none, not paused. */
const known = new Map<string, TeamPause>()
/** The user's pause of every open workspace, while it lasts. */
let all: TeamPause | null = null
/** The workspaces resumed on their own from the user's pause (by their .hive): it no longer holds them. */
const leftAll = new Set<string>()
/** The workspaces whose old pause file was looked for in this run. */
const cleared = new Set<string>()
/** The pause each workspace's agents were told of (its id): told once a pause. */
const told = new Map<string, string>()
/** When each workspace's team last resumed (ms; this run's): stall clocks count from then too (HR1's s12 check). */
const resumed = new Map<string, number>()
/** Each workspace's lock: pause, resume and the gates' admission checks go one at a time. */
const locks = new Map<string, Promise<unknown>>()

/** A workspace's .hive folder, from its path (the same as its hiveDir, which a stand-in for one may not have). */
const hiveOf = (ws: Pick<WorkspaceService, 'path'>): string => join(ws.path ?? '', HIVE_DIR)
const keyOf = (ws: Pick<WorkspaceService, 'path'>): string => hiveOf(ws).toLowerCase()

/** The user's pause of every open workspace, while it lasts. */
export const appPause = (): TeamPause | null => all

/** At start (HI-2156): the profile's files an earlier build saved a pause in, removed; Hive starts unpaused. */
export function clearSavedPauses(): void {
  for (const f of [OLD_FILE, OLD_CLOSING_FILE]) void rm(join(app.getPath('userData'), f), { force: true }).catch((e) => log.warn('Removing a team pause an earlier Hive saved', e))
}

/**
 * A workspace's pause now (null: none). A workspace not resumed from the user's pause is held by it (s10, HR1's s12
 * condition), its agents told. The first ask in a run removes the file an earlier build saved its pause in.
 */
export function teamPauseOf(ws: WorkspaceService | null | undefined): TeamPause | null {
  if (!ws?.path) return null
  const k = keyOf(ws)
  if (!cleared.has(k)) {
    cleared.add(k)
    void rm(join(hiveOf(ws), OLD_FILE), { force: true }).catch((e) => log.warn('Removing a team pause an earlier Hive saved', e))
  }
  const p = known.get(k)
  if (p) return p
  if (!all || leftAll.has(k)) return null
  known.set(k, all)
  void announce(ws, all)
  return all
}

/** The pause of the workspace a project (or the Assistant's home) is in: null for none, or a path in no open workspace. */
export const pausedFor = (projectPath: string): TeamPause | null => teamPauseOf(workspaceFor(projectPath))

/** When the team of a project's workspace last resumed in this run (ms), or 0. */
export function resumedAt(projectPath: string): number {
  const ws = workspaceFor(projectPath)
  return ws?.path ? (resumed.get(keyOf(ws)) ?? 0) : 0
}

/** Runs `fn` under the workspace's lock (pause and resume, and the gates' final checks). */
export function withLock<T>(ws: WorkspaceService, fn: () => Promise<T> | T): Promise<T> {
  const k = keyOf(ws)
  const run = (locks.get(k) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => undefined)
  locks.set(k, tail)
  void tail.then(() => {
    if (locks.get(k) === tail) locks.delete(k)
  })
  return run
}

/** Tells the window and the passes (lane starts, the pool, the deliveries) that a workspace's pause changed. */
function changed(ws: WorkspaceService, was: TeamPause | null = null): void {
  if (!ws.path) return
  emit({ type: 'team-pause-changed', workspacePath: ws.path, pause: known.get(keyOf(ws)) ?? null, ...(was ? { was } : {}) })
}

/** A workspace's new pause: logged, the window told, and its running agents once a pause. */
async function announce(ws: WorkspaceService, p: TeamPause): Promise<void> {
  const k = keyOf(ws)
  log.info(`The team of ${userText(ws.path)} is paused (${p.by}, ${p.pauseId})`)
  changed(ws)
  if (told.get(k) === p.pauseId) return
  told.set(k, p.pauseId)
  await tellAgents(ws, p).catch((e) => log.warn('Telling the agents the team is pausing', e))
}

/** Each running project agent of the workspace, told once for this pause (its delivery: source team-pause, ref the id). */
async function tellAgents(ws: WorkspaceService, p: TeamPause): Promise<void> {
  // Loaded here: deliveries.ts asks this module for its admission gate.
  const { createDelivery } = await import('./deliveries')
  const projects = ws.info()?.projects ?? []
  const results = await Promise.allSettled(
    projects.flatMap((proj) =>
      projectAgents(proj.config).flatMap((a) =>
        sessions.liveFor(proj.path, a.id)
          ? [inWorkspace(ws, () => createDelivery(proj.path, { agentId: a.id, agentName: a.name, kind: 'control', from: { kind: 'hive', name: 'Hive' }, body: TEAM_PAUSE_LINE, source: 'team-pause', ref: p.pauseId, replace: true }))] // i18n-ignore: the product's name, as a delivery's sender
          : []
      )
    )
  )
  for (const r of results) if (r.status === 'rejected') log.warn('Telling an agent the team is pausing', r.reason)
}

/**
 * Pauses a workspace's team. Already paused: kept as it is, unless the user's pause gives it the app's id. Its agents
 * are told once a pause. Returns the pause.
 */
export async function pauseTeam(ws: WorkspaceService, by: TeamPause['by'], pauseId: string = randomUUID()): Promise<TeamPause> {
  if (!ws.path) throw new Error('No workspace is open') // i18n-ignore: an error for the log and the caller's reply
  const k = keyOf(ws)
  const p = await withLock(ws, () => {
    const was = teamPauseOf(ws)
    if (was && (was.pauseId === pauseId || by === 'assistant')) return null
    const next: TeamPause = all?.pauseId === pauseId ? all : { pauseId, since: new Date().toISOString(), by }
    known.set(k, next)
    return next
  })
  if (p) await announce(ws, p)
  return teamPauseOf(ws)!
}

/**
 * Resumes a workspace's team (then the passes run again, and held wakes are offered). Held by the user's pause, it
 * leaves it (HI-2156), and the user's pause ends with the last workspace it held.
 */
export async function resumeTeam(ws: WorkspaceService): Promise<boolean> {
  if (!ws.path) return false
  const k = keyOf(ws)
  const was = await withLock(ws, () => {
    const p = teamPauseOf(ws)
    if (!p) return null
    known.delete(k)
    if (all && p.pauseId === all.pauseId) {
      leftAll.add(k)
      const id = all.pauseId
      if (!openWorkspaces().some((w) => w.path && keyOf(w) !== k && teamPauseOf(w)?.pauseId === id)) endAppPause()
    }
    resumed.set(k, Date.now())
    return p
  })
  if (!was) return false
  log.info(`The team of ${userText(ws.path)} resumes (${was.pauseId}: paused ${Math.round((Date.now() - Date.parse(was.since)) / 60_000)} min)`)
  changed(ws, was)
  return true
}

function endAppPause(): void {
  all = null
  leftAll.clear()
}

/** What the user's pause or resume of every open workspace did: those it reached, and those it couldn't (why). */
export interface AppPauseResult {
  pause: TeamPause | null
  done: string[]
  failed: { workspacePath: string; error: string }[]
}

/**
 * The user's pause of every open workspace (one id, so a workspace opened meanwhile is held too, and paused again, every
 * one resumed from it on its own). A workspace it can't pause is named (HR1's s12 condition): the app is never parked
 * while one isn't paused.
 */
export async function pauseApp(): Promise<AppPauseResult> {
  const p: TeamPause = all ?? { pauseId: randomUUID(), since: new Date().toISOString(), by: 'user' }
  all = p
  leftAll.clear()
  const out: AppPauseResult = { pause: p, done: [], failed: [] }
  for (const ws of openWorkspaces()) {
    if (!ws.path) continue
    try {
      await pauseTeam(ws, 'user', p.pauseId)
      out.done.push(ws.path)
    } catch (e) {
      out.failed.push({ workspacePath: ws.path, error: e instanceof Error ? e.message : String(e) })
      log.warn(`Pausing the team of ${userText(ws.path)}`, e)
    }
  }
  return out
}

/** The user's resume: the user's pause ended first (no workspace opened later is held), then each paused workspace's. */
export async function resumeApp(): Promise<AppPauseResult> {
  endAppPause()
  const out: AppPauseResult = { pause: null, done: [], failed: [] }
  for (const ws of openWorkspaces()) {
    if (!ws.path || !teamPauseOf(ws)) continue
    try {
      if (await resumeTeam(ws)) out.done.push(ws.path)
    } catch (e) {
      out.failed.push({ workspacePath: ws.path, error: e instanceof Error ? e.message : String(e) })
      log.warn(`Resuming the team of ${userText(ws.path)}`, e)
    }
  }
  return out
}

/** For tests: forgets every pause, as a new start does. */
export function resetTeamPauseForTests(): void {
  known.clear()
  endAppPause()
  cleared.clear()
  told.clear()
  locks.clear()
  resumed.clear()
}
