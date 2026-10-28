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
export async function runInWindow(win: BrowserWindow | null, kind: 'workspace' | 'quit', name: string | null, command: string, cwd: string): Promise<RunOutcome> {
  const startedAt = new Date()
  const run: CloseCommandRun = { id: `cc${++runs}-${startedAt.getTime()}`, kind, command, startedAt: startedAt.toISOString(), state: 'running', lines: [], exitCode: null }
  const panel = showPanel(win, run)
  const root = runsRoot()
  const said = `${kind === 'quit' ? 'When Hive quits' : `${userText(name ?? '')}'s close`} command ${userText(command)}` // i18n-ignore: for the log
  await pruneRuns(root, runPrefix(kind, name)).catch((e) => log.warn('pruning the close commands kept', e))
  let dir: string
  try {
    dir = startRun(root, runFolderName(kind, name, startedAt), command, cwd, { exec: process.execPath, script: runnerScript(), env: checkEnv(childEnv()) })
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

/** The close in progress for each workspace service: a second close of the same open joins it (s11). */
const closing = new WeakMap<WorkspaceService, { path: string; done: Promise<RunOutcome> }>()

/**
 * Closes a window's workspace for `reason`, running its close command once it has closed and drained, and waiting for
 * it as its panel says. With no command (or none for this reason, or a test copy), it is an ordinary close. A second
 * call for the same open joins the first (its reason wins).
 */
export function closeWithCommand(ws: WorkspaceService, reason: CloseReason, win: BrowserWindow | null, o: { cancelled?: AbortSignal } = {}): Promise<RunOutcome> {
  const path = ws.path
  const was = closing.get(ws)
  if (was && (!path || was.path === path)) return was.done
  if (!path) return ws.close().then(() => 'skipped' as const)
  const done = closeAndRun(ws, path, reason, win, o.cancelled)
  closing.set(ws, { path, done })
  void done.finally(() => {
    if (closing.get(ws)?.done === done) closing.delete(ws)
  })
  return done
}

async function closeAndRun(ws: WorkspaceService, path: string, reason: CloseReason, win: BrowserWindow | null, cancelled?: AbortSignal): Promise<RunOutcome> {
  // As the close began: the setting and place this open had, whatever opens next.
  const setting: CloseCommandSetting | undefined = ws.config.onClose
  const place = ws.openPlace
  const plan = planRun(setting, reason, { workspace: path }, { runs: closeCommandsRun() })
  await ws.close()
  if ('skip' in plan) {
    if (plan.skip !== 'none') log.info(`${userText(basename(path))}'s close command not run: ${plan.skip === 'test' ? 'a test copy of Hive' : 'Hive is restarting for an update'}`)
    return 'skipped'
  }
  const drained: DrainResult = place ? await drainWorkspace(path, place, { cancelled }) : { drained: true }
  if (!drained.drained) {
    log.warn(`${userText(basename(path))}'s close command not run: Hive hadn't finished writing it (${drained.left.join(', ')})`)
    return drainFailed(win, 'workspace', plan.command)
  }
  return runInWindow(win, 'workspace', basename(path), plan.command, path)
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
  return runInWindow(win, 'quit', null, plan.command, homedir())
}

/** Whether a quit has anything to run: a window's workspace with a command, or When Hive quits. */
export function quitRunsAny(workspaces: WorkspaceService[], global: CloseCommandSetting | undefined): boolean {
  if (!closeCommandsRun()) return false
  return !!global?.command?.trim() || workspaces.some((w) => !!w.path && !!w.config.onClose?.command?.trim())
}
