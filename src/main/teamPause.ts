import { app } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { readFileSync } from 'original-fs'
import { rm } from 'original-fs/promises'
import { HIVE_DIR, projectAgents } from '../shared/defaults'
import { TEAM_PAUSE_LINE, type TeamPause } from '../shared/teamPause'
import { emit } from './events'
import { writeJsonAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { inWorkspace, openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'

/**
 * Pausing the team before an update (HI-2081, SPEC §16.10.9; HR1's design checks s8, s10 and s12). A workspace's pause
 * is saved in its `.hive/team-pause.json` before it holds anything (a failed save holds and tells nothing), and read
 * once per workspace into memory, where every gate asks it (`pausedFor`, `teamPauseOf`): lane starts, the new
 * conversations Hive starts by itself, the reviewer pool, the merge queue's next entry, and the deliveries of Hive's own
 * wakes (`pauseHolds`, deliveries.ts' admission gate). The user's pause covers every open workspace with one id, and a
 * workspace opened while it lasts (the profile's `team-pause.json`) is held by it too; the Assistant's covers its own
 * workspace only. Pause and resume take each workspace's lock, which the gates' final checks read under, so a change
 * is never half seen. Each running agent is told once per pause (TEAM_PAUSE_LINE). Rules off: the same hold. A pause
 * saved by another version of Hive is lifted as it is read (the update was installed), and a workspace resumed on its own
 * leaves the user's pause, which goes with the last workspace it held (HI-2156).
 */

const log = createLogger('teamPause')

const FILE = 'team-pause.json'
/** What the last close left of the pauses (the profile's): its reason and each paused workspace's pause, by its .hive. */
const CLOSING_FILE = 'team-pause-closing.json'

interface PauseClosing {
  reason: string
  at: string
  pauses: { hiveDir: string; pauseId: string }[]
  app?: string
}

/** The last close's pauses, read once at this start (and its file removed): what an install's restart lifts. */
let closing: PauseClosing | null = null

/** Each workspace's pause as read (by its .hive folder): null, none. */
const known = new Map<string, TeamPause | null>()
/**
 * Whether each held pause is saved (round 1, finding 2): `pending` for one a workspace took from the user's pause of every
 * workspace and hasn't saved yet, `failed` when its save failed (held all the same, never parked), else saved.
 */
type SaveState = 'saved' | 'pending' | { failed: string }
const saves = new Map<string, SaveState>()
/** The pause each workspace's agents were told of (its id): told once a pause, whoever saved it. */
const told = new Map<string, string>()
/** When each workspace's team last resumed (ms; this run's): stall clocks count from then too (HR1's s12 check). */
const resumed = new Map<string, number>()
/** Each workspace's lock: pause, resume and the gates' admission checks go one at a time. */
const locks = new Map<string, Promise<unknown>>()
/**
 * The profile's pause file's lock (HR1's round 1 finding): each read-modify-write or removal of it goes one at a time, so
 * two workspaces resuming at once can't each drop the other from `resumedIn`. Taken inside a workspace's lock, never the
 * other way round.
 */
let appLock: Promise<unknown> = Promise.resolve()

/** A workspace's .hive folder, from its path (the same as its hiveDir, which a stand-in for one may not have). */
const hiveOf = (ws: Pick<WorkspaceService, 'path'>): string => join(ws.path ?? '', HIVE_DIR)
const keyOf = (ws: Pick<WorkspaceService, 'path'>): string => hiveOf(ws).toLowerCase()
const fileOf = (ws: Pick<WorkspaceService, 'path'>): string => join(hiveOf(ws), FILE)
const appFile = (): string => join(app.getPath('userData'), FILE)

/**
 * The profile's pause (the user's of every workspace) as saved: a TeamPause, and the workspaces resumed from it on their
 * own (by their .hive, lower case; HI-2156), which it no longer holds, in this run or the next.
 */
type AppPauseFile = TeamPause & { resumedIn?: string[] }

const valid = (v: unknown): v is TeamPause => !!v && typeof v === 'object' && typeof (v as TeamPause).pauseId === 'string' && typeof (v as TeamPause).since === 'string' && ((v as TeamPause).by === 'user' || (v as TeamPause).by === 'assistant')

/** A saved pause, or null: none, or one that can't be read (logged). */
function readPause(file: string): TeamPause | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const v = JSON.parse(text)
    return valid(v) ? v : null
  } catch (e) {
    log.warn(`A saved team pause can't be read (${userText(file)})`, e)
    return null
  }
}

/**
 * Whether a saved pause was for an update installed since (HI-2156): saved by another version of Hive than this one,
 * however Hive closed for it (the installer run by hand after a plain quit too). A pause saved before versions were
 * recorded is kept, and the window asks at start whether to resume it.
 */
const liftedByVersion = (p: TeamPause): boolean => !!p.version && p.version !== app.getVersion()

/** The same saved pause: its id and since (a pause saved again under the same id is another). */
const samePause = (a: TeamPause | null, b: TeamPause): boolean => !!a && a.pauseId === b.pauseId && a.since === b.since

/**
 * Removes a lifted pause's file (HR1's round 2 finding): later, under its lock, and only while it still holds that very
 * pause, so a pause saved meanwhile in its place is kept.
 */
async function removeLifted(file: string, p: TeamPause): Promise<void> {
  if (samePause(readPause(file), p)) await rm(file, { force: true })
}

/** The user's pause of every open workspace, as the profile keeps it (read again each time: tiny, and rare). */
export const appPause = (): AppPauseFile | null => {
  const p = readPause(appFile())
  if (p && ((closing && /^(install|update)$/.test(closing.reason) && closing.app === p.pauseId) || liftedByVersion(p))) {
    const file = appFile()
    void withAppLock(() => removeLifted(file, p)).catch(() => undefined)
    return null
  }
  return p
}

/** Whether the user's pause no longer holds a workspace: resumed from it on its own (HI-2156). */
const resumedFrom = (all: AppPauseFile, ws: Pick<WorkspaceService, 'path'>): boolean => Array.isArray(all.resumedIn) && all.resumedIn.includes(keyOf(ws))

const liftedByClosing = (ws: WorkspaceService, p: TeamPause): boolean => !!closing && /^(install|update)$/.test(closing.reason) && closing.pauses.some((x) => x.hiveDir === keyOf(ws) && x.pauseId === p.pauseId)

/**
 * Hive closing (quitNow, with its reason): each open workspace's pause written down with this close, replacing what an
 * earlier close wrote, so the next start lifts only these, and only after an install or an update.
 */
export async function recordPauseClosing(reason: string): Promise<void> {
  const pauses = openWorkspaces().flatMap((ws) => {
    const p = ws.path ? teamPauseOf(ws) : null
    return p ? [{ hiveDir: keyOf(ws), pauseId: p.pauseId }] : []
  })
  const all = readPause(appFile())
  const rec: PauseClosing = { reason, at: new Date().toISOString(), pauses, ...(all ? { app: all.pauseId } : {}) }
  if (!pauses.length && !all) return void (await rm(join(app.getPath('userData'), CLOSING_FILE), { force: true }).catch(() => undefined))
  await writeJsonAtomic(join(app.getPath('userData'), CLOSING_FILE), rec)
}

/** Reads (and removes) what the last close left of the pauses, once at start, before any workspace opens. */
export function loadPauseClosing(): void {
  const file = join(app.getPath('userData'), CLOSING_FILE)
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as PauseClosing
    closing = v && typeof v.reason === 'string' && Array.isArray(v.pauses) ? v : null
  } catch {
    closing = null
  }
  void rm(file, { force: true }).catch(() => undefined)
}

/**
 * A workspace's pause now (null: none). Read once from its file; a workspace with none, opened while the user's pause
 * lasts, is held by it at once (s10, HR1's s12 condition) and saved in the background.
 */
export function teamPauseOf(ws: WorkspaceService | null | undefined): TeamPause | null {
  if (!ws?.path) return null
  const k = keyOf(ws)
  if (known.has(k)) return known.get(k)!
  let p = readPause(fileOf(ws))
  // Hive restarting for the update this pause was for (HR1's s10 check): lifted before anything reads it, so the team
  // resumes on its own (the restart's resume offer). Only this very pause, closed under an install or an update, in the
  // close just before this start: a crash, a plain quit or an older record keeps it.
  if (p && (liftedByClosing(ws, p) || liftedByVersion(p))) {
    const file = fileOf(ws)
    const lifted = p
    void withLock(ws, () => removeLifted(file, lifted)).catch((e) => log.warn("Removing a team pause lifted by the update's restart", e))
    log.info(`The team of ${userText(ws.path)} resumes after the update it was paused for (${p.pauseId})`)
    p = null
  }
  known.set(k, p)
  saves.set(k, 'saved')
  if (!p) {
    const all = appPause()
    if (all && !resumedFrom(all, ws)) {
      // Held at once, pending until saved (round 1, finding 2): pauseTeam saves it, tells the window and the agents, and
      // a failure is the workspace's (never parked).
      known.set(k, all)
      saves.set(k, 'pending')
      p = all
      void pauseTeam(ws, 'user', all.pauseId).catch((e) => log.warn('Saving the team pause of a workspace opened while the team was paused', e))
    }
  }
  return p
}

/** Whether a workspace's pause is saved: `pending` (taken from the user's pause, not saved yet), or why its save failed. */
export function pauseSaveState(ws: WorkspaceService): SaveState {
  teamPauseOf(ws)
  return saves.get(keyOf(ws)) ?? 'saved'
}

/** The pause of the workspace a project (or the Assistant's home) is in: null for none, or a path in no open workspace. */
export const pausedFor = (projectPath: string): TeamPause | null => teamPauseOf(workspaceFor(projectPath))

/** When the team of a project's workspace last resumed in this run (ms), or 0. */
export function resumedAt(projectPath: string): number {
  const ws = workspaceFor(projectPath)
  return ws?.path ? (resumed.get(keyOf(ws)) ?? 0) : 0
}

/** Runs `fn` under the profile's pause file's lock (after any workspace's lock it needs). */
function withAppLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = appLock.then(fn, fn)
  appLock = run.catch(() => undefined)
  return run
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

async function save(ws: WorkspaceService, p: TeamPause): Promise<void> {
  await writeJsonAtomic(fileOf(ws), p)
  known.set(keyOf(ws), p)
  saves.set(keyOf(ws), 'saved')
}

/** Tells the window and the passes (lane starts, the pool, the deliveries) that a workspace's pause changed. */
function changed(ws: WorkspaceService, was: TeamPause | null = null): void {
  if (!ws.path) return
  emit({ type: 'team-pause-changed', workspacePath: ws.path, pause: known.get(keyOf(ws)) ?? null, ...(was ? { was } : {}) })
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
 * Pauses a workspace's team (its pause saved first: a failed save throws, and a new pause holds and tells nothing; one
 * taken from the user's pause stays held, its failure named, never parked). Already paused and saved: kept as it is,
 * unless the user's pause gives it the app's id. Its agents are told once a pause. Returns the pause.
 */
export async function pauseTeam(ws: WorkspaceService, by: TeamPause['by'], pauseId: string = randomUUID()): Promise<TeamPause> {
  if (!ws.path) throw new Error('No workspace is open') // i18n-ignore: an error for the log and the caller's reply
  const k = keyOf(ws)
  const p = await withLock(ws, async () => {
    const was = teamPauseOf(ws)
    const saved = saves.get(k) === 'saved'
    if (was && saved && (was.pauseId === pauseId || by === 'assistant')) return null
    // Taken from the user's pause and not saved yet: that very pause is saved now, as it was.
    const next: TeamPause = was && !saved && was.pauseId === pauseId ? was : { pauseId, since: new Date().toISOString(), by, version: app.getVersion() }
    try {
      await save(ws, next)
    } catch (e) {
      if (was && !saved) saves.set(k, { failed: e instanceof Error ? e.message : String(e) })
      throw e
    }
    return next
  })
  if (!p) return teamPauseOf(ws)!
  log.info(`The team of ${userText(ws.path)} is paused (${p.by}, ${p.pauseId})`)
  changed(ws)
  if (told.get(k) !== p.pauseId) {
    told.set(k, p.pauseId)
    await tellAgents(ws, p).catch((e) => log.warn('Telling the agents the team is pausing', e))
  }
  return p
}

/** Resumes a workspace's team: its pause removed (then the passes run again, and held wakes are offered). */
export async function resumeTeam(ws: WorkspaceService): Promise<boolean> {
  if (!ws.path) return false
  const was = await withLock(ws, async () => {
    const p = teamPauseOf(ws)
    if (!p) return null
    await rm(fileOf(ws), { force: true })
    await leaveAppPause(ws, p)
    known.set(keyOf(ws), null)
    saves.set(keyOf(ws), 'saved')
    resumed.set(keyOf(ws), Date.now())
    return p
  })
  if (!was) return false
  log.info(`The team of ${userText(ws.path)} resumes (${was.pauseId}: paused ${Math.round((Date.now() - Date.parse(was.since)) / 60_000)} min)`)
  changed(ws, was)
  return true
}

/**
 * A workspace resumed while the user's pause of every workspace held it (HI-2156: the Assistant's resume, which covers its
 * own workspace): that pause no longer holds it, here or after a restart. The profile's pause goes once no other open
 * workspace is held by it; else it names this workspace as resumed from it.
 */
function leaveAppPause(ws: WorkspaceService, p: TeamPause): Promise<void> {
  return withAppLock(async () => {
    const all = appPause()
    if (!all || all.pauseId !== p.pauseId) return
    const out = [...(Array.isArray(all.resumedIn) ? all.resumedIn : []), keyOf(ws)]
    // Held still: an open workspace on this pause not resumed from it (one resuming meanwhile is named in the file already).
    const others = openWorkspaces().some((w) => w.path && !out.includes(keyOf(w)) && teamPauseOf(w)?.pauseId === all.pauseId)
    if (!others) await rm(appFile(), { force: true })
    else if (!resumedFrom(all, ws)) await writeJsonAtomic(appFile(), { ...all, resumedIn: out })
  })
}

/** What the user's pause or resume of every open workspace did: those it reached, and those it couldn't (why). */
export interface AppPauseResult {
  pause: TeamPause | null
  done: string[]
  failed: { workspacePath: string; error: string }[]
}

/**
 * The user's pause of every open workspace (one id, saved in the profile first, so a workspace opened meanwhile is
 * held too). A workspace whose save fails is named (HR1's s12 condition): the app is never parked while one isn't paused.
 */
export async function pauseApp(): Promise<AppPauseResult> {
  // Paused again: every open workspace held again, those resumed from it on their own included.
  const p = await withAppLock(async () => {
    const was = appPause()
    const next: TeamPause = was ? { pauseId: was.pauseId, since: was.since, by: was.by, ...(was.version ? { version: was.version } : {}) } : { pauseId: randomUUID(), since: new Date().toISOString(), by: 'user', version: app.getVersion() }
    await writeJsonAtomic(appFile(), next)
    return next
  })
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

/** The user's resume: the profile's pause removed first (no workspace opened later is held), then each paused workspace's. */
export async function resumeApp(): Promise<AppPauseResult> {
  await withAppLock(() => rm(appFile(), { force: true }))
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

/** A workspace closing: its pause is read from its file again when it opens next. */
export function forgetTeamPause(ws: WorkspaceService): void {
  known.delete(keyOf(ws))
  saves.delete(keyOf(ws))
}

/** For tests: forgets every workspace's pause as read. */
export function resetTeamPauseForTests(): void {
  known.clear()
  saves.clear()
  told.clear()
  locks.clear()
  appLock = Promise.resolve()
  resumed.clear()
}
