// The Preview in the app (HI-3614, design HI-3597 s8/s16/s21, SPEC §16.21): one runner for the whole profile (every
// project and window of this Combwork), behind Settings → Advanced's switch (cw.preview.enabled, off by default: off,
// nothing here is reachable and what runs is stopped).
//
// - Places: the project folder, a slot under its lease, or a review copy under its lease; at most one preview each.
// - Each server runs in a job of its own on Combwork's process supervisor (kill on close: its whole tree ends with it),
//   with a session command's environment plus PORT, CW_PREVIEW_PORT (and CW_PREVIEW_HMR_PORT), its output in a bounded log
//   in Combwork's own folder (logs\preview). Ended: its job ended, settled as a slot's is (slotJobs.ts), and closed.
// - It starts on demand only (the tab's IPC call, startPreview for the agent tool), never at launch, and stops on Stop,
//   when its place's lease ends (a slot's, a review's), its project leaves the workspace, the workspace closes, the
//   switch is turned off, or Combwork quits.
// - What could hold main's thread is elsewhere: the TCP table is read by netstat (previewPorts.ts), the stamp by git on
//   its worker (previewSource.ts), and the watcher is the system's.

import { app, shell, type BrowserWindow, type Rectangle } from 'electron'
import { createHash } from 'crypto'
import { mkdirSync, watch } from 'original-fs'
import { appendFile, readdir, readFile, writeFile } from 'original-fs/promises'
import { basename, join } from 'path'
import { advanced } from './advanced'
import { processSupervisor } from './agentProcesses'
import { copiesFor } from './copiesApp'
import { combworkError } from './combworkError'
import { emit, emitTo } from './events'
import { PreviewGuard } from './previewGuard'
import { PreviewShows } from './previewShown'
import { openableUrl } from '../shared/previewPolicy'
import { createLogger, userText } from './logger'
import { onPlaceEnded, setPreviewHoldCheck } from './placeEnds'
import { samePlace } from './places'
import { bindFree, readListeners } from './previewPorts'
import { PreviewRunner, rangeOf, type Launched } from './previewRunner'
import { previewSource } from './previewSource'
import type { JobList } from './processSupervisor'
import { childEnv } from './ptyHost'
import { combworkPorts } from './servers'
import { END_WAIT_MS, settleSlotJob } from './slotJobs'
import { jobSpawn, journalsOf, poolIfMade, retireSealOf } from './slotsApp'
import { BoundedLog, checkEnv, execCommand, FILE_IO } from './workflow/queueChecks'
import { endLeaseJob, journalPath, LeaseJob } from './workflow/queueJobs'
import { defaultProbe } from './workflow/queueProcs'
import { workspaceFor, WorkspaceService } from './workspace'
import { msg } from '../shared/i18n'
import { PREVIEW_ENABLED, PREVIEW_PORT_RANGE, PREVIEW_START_SECONDS } from '../shared/advanced'
import { PREVIEW_LOCKFILES, PREVIEW_PORT_DEFAULT, previewConfigOf, suggestPreviewCommand, type PreviewConfig, type PreviewEnd, type PreviewPlace, type PreviewSuggestion, type PreviewView } from '../shared/preview'

const log = createLogger('preview')

/** Where preview servers keep their logs: Combwork's own folder, never a project's. */
export const previewLogDir = (): string => join(app.getPath('userData'), 'logs', 'preview')

/** The longest a server runs: as long as it is left running (setTimeout's own bound, 24 days). */
const RUNS_MS = 2_147_483_647

/** How long the watcher gathers a burst of changes before it says so. */
const WATCH_GATHER_MS = 200

const M = {
  off: msg({ id: 'main.preview.off', defaultMessage: 'The Preview is turned off (Settings → Advanced, Preview: run projects’ dev servers).', description: 'An error: something asked for the Preview while its advanced setting is off. Settings → Advanced and the setting\'s title are names: use them as translated there.' }),
  noConfig: msg({ id: 'main.preview.noConfig', defaultMessage: '{project} has no preview command: set one in Project Settings → Preview.', description: 'An error: a preview was asked for in a project that has no preview command. {project} is the project\'s name. Project Settings → Preview is a section: use its names as translated there.' }),
  notAPlace: msg({ id: 'main.preview.notAPlace', defaultMessage: "That folder isn't {project}'s folder, one of its slots or one of its review copies.", description: "An error: a preview was asked for in a folder that isn't one a preview runs in. {project} is the project's name. A slot is a worktree Combwork lends to a card or a lane; a review copy is a copy at the revision a reviewer reviews." }),
  notLent: msg({ id: 'main.preview.notLent', defaultMessage: "{slot} isn't lent to a card or a review now, so a preview can't run in it.", description: "An error: a preview was asked for in a slot or review copy no card or review holds now. {slot} is its name (slot-b, copy-1)." }),
  notRunning: msg({ id: 'main.preview.notRunning', defaultMessage: "That preview isn't running now: start it again.", description: "An error: the Preview tab asked to show, reload or inspect a preview that has stopped meanwhile." }),
  guardFailed: msg({ id: 'main.preview.guardFailed', defaultMessage: "The preview's network guard couldn't start, so its page isn't shown. Start it again; Combwork's log says why.", description: "An error: the Preview's network guard (the filtering proxy every request of the previewed page goes through) didn't start, so Combwork shows no page." }),
  badConfig: msg({ id: 'main.preview.badConfig', defaultMessage: 'A preview needs a command (one line, at most 1,000 characters) and a page path starting with /.', description: "An error: Project Settings → Preview's values weren't saved: the command is empty or too long, or the path doesn't start with a slash." })
}

/** This Combwork tells processes apart and ends them so (a job's settle). */
const probe = defaultProbe()

let runner: PreviewRunner | null = null

/** The profile's one runner (made on first use). */
function runnerNow(): PreviewRunner {
  if (runner) return runner
  runner = new PreviewRunner({
    range: previewPorts,
    reserved: () => new Set(combworkPorts()),
    startSeconds: () => advanced.number(PREVIEW_START_SECONDS),
    bindFree,
    listeners: readListeners,
    launch,
    source: (folder) => previewSource(folder, app.getPath('temp')),
    watch: watchPlace,
    logPath: (id, place) => {
      try {
        mkdirSync(previewLogDir(), { recursive: true })
        return join(previewLogDir(), `${Date.now()}-${place.name.replace(/[^\w.-]/g, '-')}-${id}.log`)
      } catch {
        return null
      }
    },
    // Its guarded page, closed as part of its every end, before its place and ports are given back (round 1).
    teardown: (id) => closeShown(id),
    log: { info: (l) => log.info(l), warn: (l, e) => log.warn(l, e) }
  })
  // Every window's Preview tab follows its previews; a stopped one's guarded page (its partition and proxy) is closed.
  runner.onChange((v) => emit({ type: 'preview-changed', preview: v }))
  return runner
}

/**
 * Starts a server in its own job: its launcher put in the job before the command runs (slotsApp's jobSpawn), its output in
 * its log. Its tree is the job's processes; its stop ends the job and settles it.
 */
async function launch(o: { id: string; place: PreviewPlace; projectPath: string; command: string; env: Record<string, string>; logPath: string | null }): Promise<Launched | { problem: string }> {
  const ws = workspaceFor(o.projectPath)
  if (!ws) return { problem: 'its workspace is closed' } // i18n-ignore: a reason, kept in English on the preview (its end's detail) and the log
  const host = processSupervisor()
  if (!host.usable || !(await host.ensure())) return { problem: "Combwork's process supervisor isn't running" } // i18n-ignore: as above
  const root = join(ws.worktreesRoot, basename(o.projectPath))
  const job = `preview-${o.id.replace(/^pv-/, '')}`
  const opened = await LeaseJob.open(host, job, await journalPath(root, job, journalsOf(root)))
  if ('problem' in opened) return { problem: `its job couldn't be made: ${opened.problem}` } // i18n-ignore: as above
  const out = new BoundedLog(o.logPath, FILE_IO)
  const exited = execCommand({ spawn: jobSpawn(opened), platform: process.platform, timeoutMs: RUNS_MS, env: () => ({ ...checkEnv(childEnv()), ...o.env }) }, o.command, o.place.folder, out).then(
    (e) => {
      out.close()
      return { code: e.spawnError ? null : e.exitCode }
    },
    () => {
      out.close()
      return { code: null }
    }
  )
  /** Its stop under way: one at a time; one that couldn't prove its end is tried again when asked again. */
  let ending: Promise<boolean> | null = null
  let tries = 0
  const endOnce = async (): Promise<boolean> => {
    let settled: boolean
    if (tries++ === 0) {
      await opened.end().catch(() => false)
      settled = await settleSlotJob({ endJob: () => opened.end().catch(() => false), probe, root, dir: journalsOf(root) }, job).catch(() => false)
      await opened.close().catch(() => undefined)
    } else {
      // Its handle let go after the first try: by its name, and what its journal names (as a pool settles a job).
      settled = await settleSlotJob({ endJob: (name) => endLeaseJob(host, name), probe, root, dir: journalsOf(root) }, job).catch(() => false)
    }
    if (settled) retireSealOf(root, job)
    else log.warn(`Preview ${o.id} in ${userText(o.place.folder)} left processes that could not be ended (try ${tries})`)
    // Its command's end, bounded: a quit never waits on a server its job couldn't end.
    let bound: NodeJS.Timeout | undefined
    const over = await Promise.race([exited.then(() => true), new Promise<boolean>((res) => (bound = setTimeout(() => res(false), END_WAIT_MS)))])
    clearTimeout(bound)
    // Proved only when its job is settled and its command has ended: otherwise its place and ports stay held (the runner).
    return settled && over
  }
  return {
    job,
    exited,
    tree: async () => {
      const r = (await host.request('list', job)) as JobList | string | null
      if (!r || typeof r !== 'object' || !Array.isArray(r.processes)) return null
      // More than it describes: whether a listener is one of the rest can't be told.
      if (r.total > r.processes.length) return null
      return r.processes.map((p) => p.pid)
    },
    stop: async () => {
      const mine = (ending ??= endOnce())
      const ok = await mine
      if (ending === mine) ending = ok ? mine : null
      return ok
    }
  }
}

/** Watches a place's files (not .git's or node_modules'), saying so once per burst of changes. */
function watchPlace(folder: string, changed: () => void): () => void {
  let timer: NodeJS.Timeout | null = null
  let w: ReturnType<typeof watch> | null = null
  try {
    w = watch(folder, { recursive: true }, (_e, file) => {
      const f = String(file ?? '').replace(/\\/g, '/')
      if (/^\.git(\/|$)/.test(f) || /(^|\/)node_modules(\/|$)/.test(f)) return
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        changed()
      }, WATCH_GATHER_MS)
    })
    w.on('error', (e) => log.warn(`watching ${userText(folder)} for a preview`, e))
  } catch (e) {
    log.warn(`couldn't watch ${userText(folder)} for a preview`, e)
  }
  return () => {
    if (timer) clearTimeout(timer)
    w?.close()
  }
}

/** Whether the Preview is on (Settings → Advanced). */
export const previewOn = (): boolean => advanced.get<boolean>(PREVIEW_ENABLED) === true

/** Refuses anything of the Preview while it is off. */
function assertOn(): void {
  if (!previewOn()) throw combworkError(M.off, undefined, { kind: 'forbidden' })
}

/**
 * The place a folder is (`folder` left out: the project folder): the project folder, a slot under its open lease, or a
 * review copy under its lease not returned. Refused otherwise, saying why.
 */
export async function placeOf(ws: WorkspaceService, projectPath: string, folder?: string | null): Promise<PreviewPlace> {
  const name = basename(projectPath)
  if (!folder || samePlace(folder, projectPath)) return { kind: 'project', name: 'project', folder: projectPath, generation: 'project' }
  const slots = poolIfMade(ws, projectPath)
  if (slots) {
    const pool = await slots
    const slot = pool.slots().find((s) => samePlace(s.folder, folder))
    if (slot) {
      const lease = pool.openLease(slot.name)
      if (!lease) throw combworkError(M.notLent, { slot: slot.name }, { kind: 'invalid' })
      return { kind: 'slot', name: slot.name, folder: slot.folder, generation: lease.id }
    }
  }
  const copies = await copiesFor(ws, projectPath)
  const at = copies.at(folder)
  if (at && samePlace(at.copy.folder, folder)) {
    if (!at.lease || at.lease.returned || at.lease.kind !== 'review') throw combworkError(M.notLent, { slot: at.copy.name }, { kind: 'invalid' })
    return { kind: 'copy', name: at.copy.name, folder: at.copy.folder, generation: at.lease.id }
  }
  throw combworkError(M.notAPlace, { project: name }, { kind: 'invalid' })
}

/** The project's preview setting, or refused when it has none. */
async function configOf(ws: WorkspaceService, projectPath: string): Promise<PreviewConfig> {
  const cfg = previewConfigOf((await ws.projectConfig(projectPath)).preview)
  if (!cfg) throw combworkError(M.noConfig, { project: basename(projectPath) }, { kind: 'invalid' })
  return cfg
}

/**
 * Whether a start may still go on, asked again just before its server starts (HI-3614 round 1): the switch on, its
 * workspace open, its place still under the generation it was started for. Null: yes; else why not.
 */
function admission(ws: WorkspaceService, projectPath: string, place: PreviewPlace): () => Promise<PreviewEnd | null> {
  const life = ws.lifetime
  return async () => {
    if (!previewOn()) return { kind: 'turnedOff' }
    if (life.aborted || ws.lifetime !== life) return { kind: 'projectClosed' }
    const now = await placeOf(ws, projectPath, place.folder).catch(() => null)
    if (!previewOn()) return { kind: 'turnedOff' }
    if (life.aborted || ws.lifetime !== life) return { kind: 'projectClosed' }
    return now && now.kind === place.kind && now.generation === place.generation ? null : { kind: 'placeEnded' }
  }
}

/**
 * Starts the preview of a place (or gives the one running there): the tab's Start, the agent tool's start. It is
 * registered with its workspace at once (a closing finds it), and admitted again before its server starts.
 */
export async function startPreview(ws: WorkspaceService, projectPath: string, folder?: string | null): Promise<PreviewView> {
  assertOn()
  const place = await placeOf(ws, projectPath, folder)
  const cfg = await configOf(ws, projectPath)
  // Checked again after those awaits: the switch, and the workspace.
  assertOn()
  if (ws.lifetime.aborted || !ws.path) throw combworkError(M.notAPlace, { project: basename(projectPath) }, { kind: 'invalid' })
  return runnerNow().start(projectPath, place, cfg, { owner: ws.path.toLowerCase(), admit: admission(ws, projectPath, place) })
}

/** Checks a running preview's ports again before its page is loaded (HI-3615): a stranger on any of them stops it. */
export async function checkPreview(projectPath: string, id: string): ReturnType<PreviewRunner['checkOwnership']> {
  assertOn()
  const v = runner?.views(projectPath).find((x) => x.id === id)
  if (!v || !runner) return { ok: false, end: { kind: 'stopped' } }
  return runner.checkOwnership(id)
}

/** Stops the preview of a place (a folder of the project's; left out: the project folder's). Whether one was running. */
export async function stopPreview(ws: WorkspaceService, projectPath: string, folder?: string | null): Promise<boolean> {
  assertOn()
  const at = runnerNow().at(folder ?? projectPath)
  if (!at || at.state === 'stopped' || at.projectPath.toLowerCase() !== projectPath.toLowerCase()) return false
  await runnerNow().stop(at.id, { kind: 'stopped' })
  return true
}

/** A project's previews (running, and the last stopped one of each place). */
export function previewViews(projectPath: string): PreviewView[] {
  assertOn()
  return runner ? runner.views(projectPath) : []
}

/** A preview's source now, against its source at start (the agent tool's captures, HI-3616). */
export async function previewSourceNow(id: string): ReturnType<PreviewRunner['sourceNow']> {
  assertOn()
  return runner ? runner.sourceNow(id) : null
}

/** The profile's preview ports now. */
export const previewPorts = (): [number, number] => rangeOf(advanced.number(PREVIEW_PORT_RANGE), app.isPackaged, PREVIEW_PORT_DEFAULT)

/** Project Settings → Preview's suggestion, from the project folder's package.json and lockfiles, and the ports a server gets. */
export async function previewSuggestion(projectPath: string): Promise<{ suggestion: PreviewSuggestion | null; range: [number, number] }> {
  assertOn()
  const range = previewPorts()
  const pkg = await readFile(join(projectPath, 'package.json'), 'utf8').catch(() => null)
  if (!pkg) return { suggestion: null, range }
  const files = await readdir(projectPath).catch(() => [] as string[])
  return { suggestion: suggestPreviewCommand(pkg, files.filter((f) => PREVIEW_LOCKFILES.includes(f.toLowerCase()))), range }
}

/** Saves a project's preview setting (null: none), checked whole. */
export async function setPreviewConfig(ws: WorkspaceService, projectPath: string, raw: unknown): Promise<PreviewConfig | null> {
  assertOn()
  const cfg = raw === null ? null : previewConfigOf(raw)
  if (raw !== null && !cfg) throw combworkError(M.badConfig, undefined, { kind: 'invalid' })
  await ws.mutateProjectConfig(projectPath, () => ({ preview: cfg ?? undefined }))
  // Every window reads it again (the tab strip places the Preview tab by it, HI-3615), whoever set it.
  ws.scheduleRefresh()
  return cfg
}

/** Stops every preview of a workspace's projects (it is closing), starting ones too, and waits for their servers to end. */
function closeWorkspace(path: string): Promise<void> {
  if (!runner) return Promise.resolve()
  const key = path.toLowerCase()
  return runner.stopWhere((_v, owner) => owner === key, { kind: 'projectClosed' }).then(({ held }) => {
    if (held.length) log.warn(`The workspace closed with preview servers not proved ended (jobs ${held.join(', ')}): their journals settle them when a pool next looks`)
  })
}

// --- The guarded page (HI-3615): one PreviewGuard per running preview (its own partition and proxy), opened when a
// window's Preview tab first shows it, and closed as part of the preview's every end (the runner's teardown, awaited
// before its place and ports are given back: round 1). Where it shows, and whether a show is still wanted after each
// await, is PreviewShows' (previewShown.ts).

/** The URLs each shown preview's page tried to leave for: only these are opened in the user's browser, by Combwork's bar. */
const triedOf = new Map<string, Set<string>>()

const shows = new PreviewShows<BrowserWindow, PreviewGuard>({
  open: (id) => {
    const v = runner?.views().find((x) => x.id === id)
    if (!v || v.state !== 'running') return Promise.reject(new Error('not running')) // i18n-ignore: a reason, never shown (the caller says notRunning)
    return PreviewGuard.open({
      placeKey: createHash('sha256').update(v.place.folder.toLowerCase()).digest('hex').slice(0, 12),
      generation: v.place.generation,
      ownPorts: [v.port, ...(v.hmrPort ? [v.hmrPort] : [])],
      events: {
        // Lost (its proxy exited or stopped answering): the preview stops, its teardown closing what is left.
        lost: () => void runner?.stop(id, { kind: 'guardStopped' }),
        tried: (url) => {
          const set = triedOf.get(id) ?? new Set<string>()
          triedOf.set(id, set)
          if (set.size < 50) set.add(url)
          const w = shownIn.get(id)
          if (w && !w.isDestroyed()) emitTo(w, { type: 'preview-tried', projectPath: v.projectPath, id, url })
        },
        refused: (layer, url, why) => log.info(`Preview ${id}: the ${layer} refused ${userText(url)} (${why})`)
      }
    }).then((g) => {
      guardIds.set(g, id)
      return g
    })
  },
  attach: (win, g) => {
    if (g.view) win.contentView.addChildView(g.view)
    shownIn.set(idOf(g), win)
  },
  detach: (win, g) => {
    if (g.view && !win.isDestroyed()) win.contentView.removeChildView(g.view)
    if (shownIn.get(idOf(g)) === win) shownIn.delete(idOf(g))
  },
  place: (win, g, bounds) => g.view?.setBounds(boundsOf(win, bounds)),
  owned: async (id) => (await runner!.checkOwnership(id)).ok
})

/** Each guard's preview, and the window each shown preview is in (for its tried URLs' bar). */
const guardIds = new WeakMap<PreviewGuard, string>()
const idOf = (g: PreviewGuard): string => guardIds.get(g) ?? ''
const shownIn = new Map<string, BrowserWindow>()

/** A running preview of this project by id, or refused. */
function runningView(projectPath: string, id: string): PreviewView {
  const v = runner?.views(projectPath).find((x) => x.id === id)
  if (!v || v.state !== 'running' || !v.url) throw combworkError(M.notRunning, undefined, { kind: 'invalid' })
  return v
}

/** A preview's guarded page closed (the runner's teardown, at its every end): true once its guard's end is proved. */
async function closeShown(id: string): Promise<boolean> {
  const proved = await shows.close(id)
  triedOf.delete(id)
  shownIn.delete(id)
  return proved
}

/** The view's place in its window: the tab's area in the window's CSS pixels, scaled by its zoom, in whole pixels. */
function boundsOf(win: BrowserWindow, b: unknown): Rectangle {
  const r = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>
  const zoom = win.webContents.getZoomFactor() || 1
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v * zoom)) : 0)
  return { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) }
}

/**
 * Shows a running preview's page in a window, at those bounds (the tab's area): its guard opened on first use (the proxy
 * started, the partition's proxy awaited, the view made), its ports' owners checked again before its first load. A hide,
 * the window closing or the preview's end meanwhile makes it attach and load nothing.
 */
export async function showPreview(win: BrowserWindow, projectPath: string, id: string, bounds: unknown): Promise<PreviewView> {
  assertOn()
  const v = runningView(projectPath, id)
  let answer: Awaited<ReturnType<typeof shows.show>>
  try {
    answer = await shows.show(id, win, bounds, v.url!)
  } catch (e) {
    log.warn(`Preview ${id}'s network guard couldn't start`, e)
    await runner?.stop(id, { kind: 'guardStopped' })
    throw combworkError(M.guardFailed, undefined, { kind: 'invalid' })
  }
  if (answer === 'notOwned') throw combworkError(M.notRunning, undefined, { kind: 'invalid' })
  return runningView(projectPath, id)
}

/** Moves a shown preview's page (the tab resized); nothing when it isn't shown in that window. */
export function placePreview(win: BrowserWindow, id: string, bounds: unknown): Promise<void> {
  return shows.place(id, win, bounds)
}

/** Takes a preview's page out of its window (the tab hidden), and cancels a show of it there still under way. */
export function hidePreview(win: BrowserWindow, id: string): Promise<void> {
  return shows.hide(id, win)
}

/** Reloads a shown preview's page (hard: bypassing the cache), its ports' owners checked again first. */
export async function reloadPreview(projectPath: string, id: string, hard: boolean): Promise<void> {
  assertOn()
  runningView(projectPath, id)
  const g = shows.has(id) ? await shows.guard(id) : null
  if (!g) return
  const owned = await runner!.checkOwnership(id)
  if (!owned.ok) throw combworkError(M.notRunning, undefined, { kind: 'invalid' })
  g.reload(hard)
}

/** DevTools for a shown preview's page: the user's button only (no agent reaches it). */
export async function previewDevTools(projectPath: string, id: string): Promise<void> {
  assertOn()
  runningView(projectPath, id)
  const g = await shows.guard(id)
  g?.devTools()
}

/** Opens in the user's browser a URL the page tried to leave for: only one it did try, only http(s), on the user's click. */
export async function openTried(id: string, url: unknown): Promise<boolean> {
  assertOn()
  const u = typeof url === 'string' ? openableUrl(url) : null
  if (!u || !triedOf.get(id)?.has(u)) return false
  // Test copies only: written down instead of opening the user's browser (test copies never show anything outside them).
  const testLog = !app.isPackaged ? process.env.CW_TEST_PREVIEW_OPENED : undefined
  if (testLog) await appendFile(testLog, u + '\n')
  else await shell.openExternal(u)
  return true
}

/** Test copies only: a shown preview's guard, for its refusals and its proxy's process (ended as a crash would). */
export async function previewTest(op: { op: 'refusals' | 'killGuard' | 'shown' | 'tried' | 'capture'; id: string; file?: string }): Promise<unknown> {
  if (app.isPackaged) throw new Error('Not allowed') // i18n-ignore: a test channel, never shown
  const g = shows.has(op.id) ? await shows.guard(op.id) : null
  if (op.op === 'shown') return { shown: !!g?.alive && shownIn.has(op.id), viewDestroyed: !g?.view || g.view.webContents.isDestroyed() }
  if (op.op === 'tried') return [...(triedOf.get(op.id) ?? [])]
  if (!g) return null
  if (op.op === 'refusals') return g.refusals
  // The page as its view draws it (a window's own screenshot doesn't include a native view), to a test's file.
  if (op.op === 'capture') {
    const img = await g.view?.webContents.capturePage()
    if (!img || !op.file) return false
    await writeFile(op.file, img.toPNG())
    return true
  }
  return g.crashProxyForTests()
}

let offEnds: (() => void) | null = null
let offAdvanced: (() => void) | null = null

/** Starts listening for places' ends and the switch (index.ts, once). Nothing runs until a preview is asked for. */
export function startPreviews(): void {
  if (offEnds) return
  // Awaited by the pools and the project's removal: the slot or copy is settled only once its preview's server is gone.
  offEnds = onPlaceEnded((e) => {
    if (!runner) return
    // Its answer, the jobs not proved ended: the pool keeps the slot or copy held for them; the removal refuses.
    if (e.kind === 'generation') return runner.stopWhere((v) => v.place.generation === e.id, { kind: 'placeEnded' }).then(({ held }) => ({ held }))
    return runner.stopWhere((v) => v.projectPath.toLowerCase() === e.path.toLowerCase(), { kind: 'projectClosed' }).then(({ held }) => ({ held }))
  })
  offAdvanced = advanced.onChange(() => {
    if (!previewOn() && runner) void runner.stopWhere(() => true, { kind: 'turnedOff' })
  })
  WorkspaceService.closingTasks.add(closeWorkspace)
  // A slot's or copy's hold for a preview is cleared only once that preview's server and page are proved gone (round 2).
  setPreviewHoldCheck(async (job) => (runner ? runner.retryHeldJob(job) : true))
}

/** Combwork quitting: every preview's server ended. */
export async function stopPreviews(): Promise<void> {
  offEnds?.()
  offAdvanced?.()
  offEnds = offAdvanced = null
  WorkspaceService.closingTasks.delete(closeWorkspace)
  setPreviewHoldCheck(null)
  if (runner) await runner.stopWhere(() => true, { kind: 'quitting' })
}
