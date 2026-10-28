import { app, type BrowserWindow } from 'electron'
import { basename, join, sep } from 'path'
import { homedir } from 'os'
import type { CloseCommandRun, CloseCommandSetting, CloseReason } from '../../shared/types'
import { emitTo } from '../events'
import { createLogger, userText } from '../logger'
import { childEnv } from '../ptyHost'
import { testQuiet } from '../testQuiet'
import { checkEnv } from '../workflow/queueChecks'
import type { WorkspaceService } from '../workspace'
import { drainWorkspace, type DrainResult } from './drain'
import { alive, planRun, pruneRuns, readRun, runFolderName, runPrefix, runsCloseCommands, startRun, START_MS } from './runs'

// HI-1368: the close commands as Hive runs them, in the window they belong to. A workspace's runs once it has closed
// and Hive has finished writing it (the drain); Hive waits for it with a panel (Don't wait, or Close once it failed),
// then goes on: the switch opens the next workspace, the window closes, Hive quits. When Hive quits, run, the same way,
// after every window's.

const log = createLogger('close-command')

/** How often the panel's state is read again while a command runs: a display refresh, not a wait for a condition. */
const FOLLOW_MS = 250

/** Each window's run its panel shows (by its webContents' id), and how Hive's wait for it ends. */
const shown = new Map<number, { run: CloseCommandRun; end: (how: 'left' | 'dismissed') => void }>()

/** A window's run, for a window that reloads while its panel is up. */
export function closeCommandState(win: BrowserWindow): CloseCommandRun | null {
  return shown.get(win.webContents.id)?.run ?? null
}

/** The panel's Don't wait: Hive stops waiting (the command carries on). */
export function dontWait(win: BrowserWindow, id: string): void {
  const s = shown.get(win.webContents.id)
  if (s && s.run.id === id && s.run.state === 'running') s.end('left')
}

/** The panel's Close, on a failed run: Hive goes on. */
export function dismiss(win: BrowserWindow, id: string): void {
  const s = shown.get(win.webContents.id)
  if (s && s.run.id === id && s.run.state === 'failed') s.end('dismissed')
}

/** Where the runs' folders are: in Hive's profile. */
const runsRoot = (): string => join(app.getPath('userData'), 'close-commands')

/** The runner's script, outside the asar (electron-builder.yml unpacks it). */
function runnerScript(): string {
  const p = join(__dirname, 'hive-close-runner.js')
  return app.isPackaged ? p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`) : p
}

/** Whether this Hive runs close commands at all (never a test copy, but for the e2e suite's seam). */
export const closeCommandsRun = (): boolean => runsCloseCommands(process.env, app.isPackaged)

let runs = 0

function send(win: BrowserWindow | null, run: CloseCommandRun | null): void {
  if (win && !win.isDestroyed()) emitTo(win, { type: 'close-command', run })
}

/**
 * Shows the panel in `win` and waits as it says. A hidden window (closed to the tray, a quit waiting for agents) is
 * shown, without taking the focus, so the panel can be seen: never a quiet test copy's.
 */
function showPanel(win: BrowserWindow | null, run: CloseCommandRun): { update: (r: Partial<CloseCommandRun>) => void; ended: Promise<'left' | 'dismissed' | 'gone'>; end: (how: 'left' | 'dismissed') => void } {
  let finish!: (how: 'left' | 'dismissed' | 'gone') => void
  const ended = new Promise<'left' | 'dismissed' | 'gone'>((r) => (finish = r))
  const id = win && !win.isDestroyed() ? win.webContents.id : null
  const current = { ...run }
  const end = (how: 'left' | 'dismissed' | 'gone'): void => {
    if (id !== null && shown.get(id)?.run.id === run.id) shown.delete(id)
    if (win && !win.isDestroyed()) win.removeListener('closed', gone)
    send(win, null)
    finish(how)
  }
  const gone = (): void => end('gone')
  if (id === null) {
    finish('gone')
    return { update: () => undefined, ended, end: () => undefined }
  }
  shown.set(id, { run: current, end })
  win!.once('closed', gone)
  if (!win!.isVisible() && !testQuiet()) win!.showInactive()
  send(win, current)
  return {
    update: (r) => {
      Object.assign(current, r)
      if (shown.get(id)?.run === current) send(win, current)
    },
    ended,
    end
  }
}

/** What a run came to, for the caller (the log has the detail). */
export type RunOutcome = 'ok' | 'failed' | 'left' | 'skipped' | 'notDrained'

/**
 * Runs `command` for its window, following its runner until it ends, the user stops waiting (Don't wait), or the window
 * goes. A failure stays on the panel until the user closes it. Never throws.
 */
export async function runInWindow(win: BrowserWindow | null, kind: 'workspace' | 'quit', name: string | null, place: string | null, command: string, cwd: string): Promise<RunOutcome> {
  const startedAt = new Date()
  const run: CloseCommandRun = { id: `cc${++runs}-${startedAt.getTime()}`, kind, command, startedAt: startedAt.toISOString(), state: 'running', lines: [], exitCode: null }
  const panel = showPanel(win, run)
  const root = runsRoot()
  const said = `${kind === 'quit' ? 'When Hive quits' : `${userText(name ?? '')}'s close`} command ${userText(command)}` // i18n-ignore: for the log
  const prefix = runPrefix(kind, place)
  await pruneRuns(root, prefix).catch((e) => log.warn('pruning the close commands kept', e))
  let dir: string
  try {
    dir = startRun(root, runFolderName(prefix, startedAt), command, cwd, { exec: process.execPath, script: runnerScript(), env: checkEnv(childEnv()) })
  } catch (e) {
    log.warn(`${said} couldn't start`, e)
    panel.update({ state: 'failed', failure: 'spawn', error: (e as Error).message })
    await panel.ended
    return 'failed'
  }
  log.info(`${said} started (${userText(dir)})`)
  // Followed until it ends, the user stops waiting, or the window goes; the panel's lines and state read as it goes.
  const result = await new Promise<RunOutcome | 'gone'>((resolve) => {
    let stopped = false
    const stop = (r: RunOutcome | 'gone'): void => {
      if (stopped) return
      stopped = true
      clearInterval(tick)
      resolve(r)
    }
    void panel.ended.then((how) => stop(how === 'left' ? 'left' : 'gone'))
    let reading = false
    const tick = setInterval(() => {
      if (reading || stopped) return
      reading = true
      void readRun(dir)
        .then(({ status, lines }) => {
          if (stopped) return
          if (!status) {
            if (Date.now() - startedAt.getTime() > START_MS) {
              log.warn(`${said}: its runner wrote no status in ${START_MS / 1000} s`)
              panel.update({ state: 'failed', failure: 'runner', lines })
              stop('failed')
            }
            return
          }
          if (status.state === 'running') {
            if (!alive(status.runnerPid)) {
              log.warn(`${said}: its runner ended before the command did`)
              panel.update({ state: 'failed', failure: 'runner', lines })
              return stop('failed')
            }
            return panel.update({ lines })
          }
          const took = Math.round((Date.parse(status.endedAt ?? new Date().toISOString()) - startedAt.getTime()) / 1000)
          if (status.state === 'spawnFailed') {
            log.warn(`${said} couldn't start: ${userText(status.error ?? '')}`)
            panel.update({ state: 'failed', failure: 'spawn', error: status.error, lines })
            return stop('failed')
          }
          log.info(`${said} ended with exit code ${status.exitCode} after ${took} s (${status.bytesSeen} bytes of output)`)
          if (status.exitCode === 0) return stop('ok')
          panel.update({ state: 'failed', exitCode: status.exitCode, lines })
          stop('failed')
        })
        .finally(() => (reading = false))
    }, FOLLOW_MS)
  })
  if (result === 'left') log.info(`${said}: Hive stopped waiting for it (Don't wait); it carries on`)
  if (result === 'ok') panel.end('dismissed')
  if (result === 'failed') await panel.ended
  return result === 'gone' ? 'left' : result
}

/** A run that didn't happen because Hive couldn't finish saving in time: said on the panel until closed. */
async function drainFailed(win: BrowserWindow | null, kind: 'workspace' | 'quit', command: string): Promise<RunOutcome> {
  const panel = showPanel(win, { id: `cc${++runs}-${Date.now()}`, kind, command, startedAt: new Date().toISOString(), state: 'failed', lines: [], exitCode: null, failure: 'drain' })
  await panel.ended
  return 'notDrained'
}

/**
 * A close of one open of a workspace (s11): joined by every later close of that open. Its close and drain (eligibility)
 * are bounded by `abort`, which every caller's bound feeds (HR6's round 2, finding 1: a quit joining a close already
 * under way bounds it too); a command, once started, and a failure's dismissal never are. `wantDrain`: a caller needs it
 * drained (When Hive quits) though it has no command of its own; asked before its close has ended, its own drain does
 * it, and `drainedOk` says it did.
 */
interface CloseOp {
  path: string
  place: string | null
  abort: AbortController
  wantDrain: boolean
  drainedOk: boolean
  done: Promise<RunOutcome>
}
const closing = new WeakMap<WorkspaceService, CloseOp>()

/** A caller's bound fed into the close's own: aborting it makes the close's eligibility end at once. */
function bound(op: CloseOp, cancelled?: AbortSignal): void {
  if (!cancelled) return
  if (cancelled.aborted) return op.abort.abort()
  cancelled.addEventListener('abort', () => op.abort.abort(), { once: true })
}

/**
 * Closes a window's workspace for `reason`, running its close command once it has closed and drained, and waiting for
 * it as its panel says. With no command (or none for this reason, or a test copy), it is an ordinary close, unless
 * `drain` (When Hive quits will run after it, HR6's round 1, finding 1): then it is drained all the same, and is
 * 'notDrained' if it couldn't be. `cancelled` bounds the close and its drain together (quit's bound), never a command:
 * past it, nothing of this close starts. A second call for the same open joins the first (its reason wins), its bound
 * applied to the first's close, and drained after it if this one needs that and the first didn't.
 */
export function closeWithCommand(ws: WorkspaceService, reason: CloseReason, win: BrowserWindow | null, o: { cancelled?: AbortSignal; drain?: boolean } = {}): Promise<RunOutcome> {
  const path = ws.path
  const was = closing.get(ws)
  if (was && (!path || was.path === path)) {
    bound(was, o.cancelled)
    if (!o.drain) return was.done
    was.wantDrain = true
    return was.done.then(async (r) => {
      if (r === 'notDrained') return r
      if (was.drainedOk) return r
      return (await drained(was.path, was.place, o.cancelled)).ok ? r : 'notDrained'
    })
  }
  if (!path) return ws.close().then(() => 'skipped' as const)
  const op: CloseOp = { path, place: ws.openPlace, abort: new AbortController(), wantDrain: !!o.drain, drainedOk: false, done: Promise.resolve('skipped') }
  bound(op, o.cancelled)
  const plan = planRun(ws.config.onClose, reason, { workspace: path }, { runs: closeCommandsRun() })
  op.done = closeAndRun(ws, op, plan, win)
  closing.set(ws, op)
  void op.done.finally(() => {
    if (closing.get(ws) === op) closing.delete(ws)
  })
  return op.done
}

/** Why a close and its drain weren't done in time, or not done at all: nothing of it may start. */
type Eligible = { ok: true } | { ok: false; why: string; error?: unknown }

/** A closed workspace drained (its place as it opened), bounded by `cancelled`. */
async function drained(path: string, place: string | null, cancelled?: AbortSignal): Promise<Eligible> {
  if (!place) return { ok: true }
  const d: DrainResult = await drainWorkspace(path, place, { cancelled })
  return d.drained ? { ok: true } : { ok: false, why: d.left.join(', ') }
}

/**
 * The close, then (when `drains()` says so once it has closed) its drain, as one phase bounded by the close's own abort
 * (HR6's round 1, finding 3, and round 2, finding 1). Past the bound it answers at once, not eligible; the close goes on
 * by itself, and nothing waits on it to start anything.
 */
async function closeAndDrain(ws: WorkspaceService, op: CloseOp, drains: () => boolean): Promise<Eligible> {
  const signal = op.abort.signal
  const closed = ws.close().then(
    (): Eligible => ({ ok: true }),
    (e): Eligible => ({ ok: false, why: `its close failed: ${(e as Error).message}`, error: e }) // i18n-ignore: for the log
  )
  const stopped = new Promise<Eligible>((resolve) => {
    const say = (): void => resolve({ ok: false, why: 'it was still closing when Hive stopped waiting' }) // i18n-ignore: for the log
    if (signal.aborted) return say()
    signal.addEventListener('abort', say, { once: true })
  })
  const first = await Promise.race([closed, stopped])
  if (!first.ok || !drains()) return first
  const d = await drained(op.path, op.place, signal)
  op.drainedOk = d.ok
  return d
}

async function closeAndRun(ws: WorkspaceService, op: CloseOp, plan: ReturnType<typeof planRun>, win: BrowserWindow | null): Promise<RunOutcome> {
  const name = userText(basename(op.path))
  if ('skip' in plan && plan.skip !== 'none') log.info(`${name}'s close command not run: ${plan.skip === 'test' ? 'a test copy of Hive' : 'Hive is restarting for an update'}`)
  const hasCommand = 'command' in plan
  // Drained when it has a command to run, or a caller (When Hive quits) asked for it before its close ended.
  const eligible = await closeAndDrain(ws, op, () => hasCommand || op.wantDrain)
  if (!eligible.ok) {
    // Nothing to run, nothing waiting on its drain, and nothing bounding it: an ordinary close's failure, as before.
    if (!hasCommand && !op.wantDrain && eligible.error !== undefined) throw eligible.error
    log.warn(`${name} wasn't closed and written in time, so ${hasCommand ? 'its close command' : 'When Hive quits, run'} won't run: ${eligible.why}`)
    return hasCommand ? drainFailed(win, 'workspace', plan.command) : 'notDrained'
  }
  if (!hasCommand) return 'skipped'
  return runInWindow(win, 'workspace', basename(op.path), op.place ?? op.path.toLowerCase(), plan.command, op.path)
}

/** When Hive quits, run: in `win`, once every window's workspace has closed; `blocked`: one didn't drain, so it doesn't run. */
export async function runQuitCommand(setting: CloseCommandSetting | undefined, reason: CloseReason, win: BrowserWindow | null, blocked: boolean): Promise<RunOutcome> {
  const plan = planRun(setting, reason, {}, { runs: closeCommandsRun() })
  if ('skip' in plan) {
    if (plan.skip !== 'none') log.info(`When Hive quits, run: not run (${plan.skip === 'test' ? 'a test copy of Hive' : 'Hive is restarting for an update'})`)
    return 'skipped'
  }
  if (blocked) {
    log.warn("When Hive quits, run: not run, as a workspace's databases weren't closed in time")
    return drainFailed(win, 'quit', plan.command)
  }
  return runInWindow(win, 'quit', null, null, plan.command, homedir())
}

/** Whether When Hive quits, run will run for this quit (set, not a test copy, not skipped for an update). */
export const quitCommandPlanned = (setting: CloseCommandSetting | undefined, reason: CloseReason): boolean => 'command' in planRun(setting, reason, {}, { runs: closeCommandsRun() })

/** Whether a quit has anything to run: a window's workspace with a command, or When Hive quits. */
export function quitRunsAny(workspaces: WorkspaceService[], global: CloseCommandSetting | undefined): boolean {
  if (!closeCommandsRun()) return false
  return !!global?.command?.trim() || workspaces.some((w) => !!w.path && !!w.config.onClose?.command?.trim())
}
