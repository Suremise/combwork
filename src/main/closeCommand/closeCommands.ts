import { app, type BrowserWindow } from 'electron'
import { existsSync } from 'original-fs'
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
const shown = new Map<number, { run: CloseCommandRun; end: (how: 'left' | 'dismissed') => void; skip: () => void }>()

/** A window's run, for a window that reloads while its panel is up. */
export function closeCommandState(win: BrowserWindow): CloseCommandRun | null {
  return shown.get(win.webContents.id)?.run ?? null
}

/**
 * The panel's button while Hive waits (closeCommand:dontWait): while its workspace is still closing and being written,
 * Skip the command (it won't run, nor When Hive quits; the close itself finishes and the panel stays until it has, Darren's
 * decision of 28 Oct ~15:30); once the command runs, Don't wait (Hive goes on, the command carries on).
 */
export function dontWait(win: BrowserWindow, id: string): void {
  const s = shown.get(win.webContents.id)
  if (!s || s.run.id !== id) return
  if (s.run.state === 'saving') s.skip()
  else if (s.run.state === 'running') s.end('left')
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

/** A panel shown in a window, as Hive waits on what it says: how that wait ends ('gone': its window closed, or none). */
interface Panel {
  run: CloseCommandRun
  update: (r: Partial<CloseCommandRun>) => void
  ended: Promise<'left' | 'dismissed' | 'gone'>
  end: (how: 'left' | 'dismissed') => void
  /** Resolves when its saving step's Skip the command is pressed (the panel stays up). */
  skipped: Promise<void>
}

/**
 * Shows the panel in `win`. A hidden window (closed to the tray, a quit waiting for agents) is shown, without taking the
 * focus, so the panel can be seen: never a quiet test copy's. With no window, its wait ends at once ('gone').
 */
function showPanel(win: BrowserWindow | null, run: CloseCommandRun): Panel {
  let finish!: (how: 'left' | 'dismissed' | 'gone') => void
  const ended = new Promise<'left' | 'dismissed' | 'gone'>((r) => (finish = r))
  const id = win && !win.isDestroyed() ? win.webContents.id : null
  const current = { ...run }
  let skipNow!: () => void
  const skipped = new Promise<void>((r) => (skipNow = r))
  const end = (how: 'left' | 'dismissed' | 'gone'): void => {
    if (id !== null && shown.get(id)?.run === current) shown.delete(id)
    if (win && !win.isDestroyed()) win.removeListener('closed', gone)
    if (id !== null && !shown.has(id)) send(win, null)
    finish(how)
  }
  const gone = (): void => end('gone')
  if (id === null) {
    finish('gone')
    return { run: current, update: (r) => void Object.assign(current, r), ended, end: () => undefined, skipped }
  }
  const skip = (): void => {
    if (current.skipped) return
    current.skipped = true
    if (shown.get(id)?.run === current) send(win, current)
    skipNow()
  }
  shown.set(id, { run: current, end, skip })
  win!.once('closed', gone)
  if (!win!.isVisible() && !testQuiet()) win!.showInactive()
  send(win, current)
  return {
    run: current,
    update: (r) => {
      Object.assign(current, r)
      if (shown.get(id)?.run === current) send(win, current)
    },
    ended,
    end,
    skipped
  }
}

/**
 * What a close or a run came to, for the caller (the log has the detail): 'notDrained', its workspace's close failed;
 * 'leftSaving', the user's Don't wait while Hive was still saving it. Either means its files may not be safely closed,
 * so When Hive quits, run doesn't run after it.
 */
export type RunOutcome = 'ok' | 'failed' | 'left' | 'skipped' | 'notDrained' | 'leftSaving'

/** A run's panel, before its command has started. */
const newRun = (kind: 'workspace' | 'quit', command: string, state: CloseCommandRun['state'], workspace?: string): CloseCommandRun => ({
  id: `cc${++runs}-${Date.now()}`,
  kind,
  command,
  startedAt: new Date().toISOString(),
  state,
  lines: [],
  exitCode: null,
  ...(workspace ? { workspace } : {})
})

/**
 * Runs `command` for its window, following its runner until it ends, the user stops waiting (Don't wait), or the window
 * goes. A failure stays on the panel until the user closes it. `panel`: the one already up (its workspace's saving
 * step), which goes on to show the command. Never throws.
 */
export async function runInWindow(win: BrowserWindow | null, kind: 'workspace' | 'quit', name: string | null, place: string | null, command: string, cwd: string, shownPanel?: Panel): Promise<RunOutcome> {
  const startedAt = new Date()
  const panel = shownPanel ?? showPanel(win, newRun(kind, command, 'running'))
  panel.update({ state: 'running', startedAt: startedAt.toISOString(), lines: [] })
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

/** A run that didn't happen because the workspace's close failed: said on its panel until closed. */
async function closeFailed(panel: Panel): Promise<RunOutcome> {
  panel.update({ state: 'failed', failure: 'drain' })
  await panel.ended
  return 'notDrained'
}

/**
 * A close of one open of a workspace (s11): joined by every later close of that open, and never cancelled or begun again
 * (Darren's decision of 28 Oct ~15:30): Hive always finishes closing it, as it did before close commands. Its saving step
 * (the close, then the drain) shows in its window's panel as "Waiting for <workspace> to finish saving…"; that step's
 * Skip the command (`skip`) means its command won't run, nor When Hive quits, and ends the drain's wait, never the
 * close: the panel stays until the close has finished. A command, once started, and a failure's dismissal wait as long
 * as they take. `wantDrain`: a caller needs it drained (When Hive quits) though it has no command of its own; asked
 * before its close has ended, its saving step does it, and `drainedOk` says it did. `showSaving`: brings up its saving
 * step now, for a caller that joins it and needs it drained (a quit joining a window's close).
 */
interface CloseOp {
  path: string
  place: string | null
  skip: AbortController
  wantDrain: boolean
  drainedOk: boolean
  showSaving: () => void
  done: Promise<RunOutcome>
}
const closing = new WeakMap<WorkspaceService, CloseOp>()

/**
 * Closes a window's workspace for `reason`, running its close command once it has closed and drained, and waiting for
 * it as its panel says. With no command (or none for this reason, or a test copy), it is an ordinary close, unless
 * `drain` (When Hive quits will run after it, HR6's round 1, finding 1): then it is drained all the same, the saving step
 * shown, and is 'leftSaving' if the user skipped the command, or 'notDrained' if its close failed. A second call for
 * the same open joins the first (its reason wins), drained as part of it if this one needs that, or after it with a
 * saving step of its own if the first had already closed without one. The close itself is never cancelled.
 */
export function closeWithCommand(ws: WorkspaceService, reason: CloseReason, win: BrowserWindow | null, o: { drain?: boolean } = {}): Promise<RunOutcome> {
  const path = ws.path
  const was = closing.get(ws)
  if (was && (!path || was.path === path)) {
    if (!o.drain) return was.done
    was.wantDrain = true
    was.showSaving()
    return was.done.then(async (r) => {
      if (r === 'notDrained' || r === 'leftSaving' || was.drainedOk) return r
      return savingStep(win, was.path, was.place)
    })
  }
  if (!path) return ws.close().then(() => 'skipped' as const)
  const op: CloseOp = { path, place: ws.openPlace, skip: new AbortController(), wantDrain: !!o.drain, drainedOk: false, showSaving: () => undefined, done: Promise.resolve('skipped') }
  const plan = planRun(ws.config.onClose, reason, { workspace: path }, { runs: closeCommandsRun() })
  op.done = closeAndRun(ws, op, plan, win)
  closing.set(ws, op)
  void op.done.finally(() => {
    if (closing.get(ws) === op) closing.delete(ws)
  })
  return op.done
}

/** A closed workspace's drain on its own (a quit joining a close that had ended without one), its saving step shown. */
async function savingStep(win: BrowserWindow | null, path: string, place: string | null): Promise<RunOutcome> {
  if (!place) return 'skipped'
  const stop = new AbortController()
  const panel = showPanel(win, newRun('workspace', '', 'saving', basename(path)))
  // Its close is over: skipping ends the wait at once.
  void panel.skipped.then(() => stop.abort())
  const d: DrainResult = await drainWorkspace(path, place, { cancelled: stop.signal })
  panel.end('dismissed')
  return d.drained ? 'skipped' : 'leftSaving'
}

/**
 * For the onclose suite (unpackaged builds only): the saving step waits while HIVE_TEST_HOLD_DRAIN's file exists, as a
 * slow save would keep it, until the user skips the command.
 */
async function heldForTest(signal: AbortSignal): Promise<void> {
  const file = app.isPackaged ? undefined : process.env.HIVE_TEST_HOLD_DRAIN
  if (!file) return
  while (existsSync(file) && !signal.aborted) await new Promise((r) => setTimeout(r, 100))
}

async function closeAndRun(ws: WorkspaceService, op: CloseOp, plan: ReturnType<typeof planRun>, win: BrowserWindow | null): Promise<RunOutcome> {
  const name = userText(basename(op.path))
  if ('skip' in plan && plan.skip !== 'none') log.info(`${name}'s close command not run: ${plan.skip === 'test' ? 'a test copy of Hive' : 'Hive is restarting for an update'}`)
  const hasCommand = 'command' in plan
  // The saving step's panel: up from the start when there is a command to run, or a caller needs it drained; brought up
  // later by a caller that joins needing that (a quit joining this window's close). Its Skip the command ends the
  // drain's wait, never the close.
  let panel: Panel | null = null
  op.showSaving = () => {
    if (panel) return
    panel = showPanel(win, newRun('workspace', hasCommand ? plan.command : '', 'saving', basename(op.path)))
    void panel.skipped.then(() => {
      log.info(`${name}: the user skipped its close command; Hive finishes closing it`)
      op.skip.abort()
    })
  }
  if (hasCommand || op.wantDrain) op.showSaving()
  const ended = (): void => (panel as Panel | null)?.end('dismissed')
  const skipped = (): RunOutcome => {
    log.warn(`${name}: the user skipped the command, so ${hasCommand ? 'its close command' : 'When Hive quits, run'} won't run`)
    ended()
    return 'leftSaving'
  }
  // The close, always to its end, as before close commands.
  try {
    await ws.close()
  } catch (e) {
    // Nothing to run and nothing waiting on it: an ordinary close's failure, as before.
    if (!panel) throw e
    log.warn(`${name}'s close failed, so ${hasCommand ? 'its close command' : 'When Hive quits, run'} won't run`, e)
    if (hasCommand) return closeFailed(panel)
    ended()
    return 'notDrained'
  }
  // Drained when it has a command to run, or a caller asked for it before its close ended.
  if (!hasCommand && !op.wantDrain) return 'skipped'
  op.showSaving()
  if (op.skip.signal.aborted) return skipped()
  await heldForTest(op.skip.signal)
  const d: DrainResult = op.place ? await drainWorkspace(op.path, op.place, { cancelled: op.skip.signal }) : { drained: true }
  op.drainedOk = d.drained
  if (op.skip.signal.aborted) return skipped()
  if (!d.drained) {
    log.warn(`${name} wasn't finished being written (${d.left.join(', ')}), so ${hasCommand ? 'its close command' : 'When Hive quits, run'} won't run`)
    ended()
    return 'notDrained'
  }
  if (!hasCommand) {
    ended()
    return 'skipped'
  }
  return runInWindow(win, 'workspace', basename(op.path), op.place ?? op.path.toLowerCase(), plan.command, op.path, (panel as Panel | null) ?? undefined)
}

/**
 * When Hive quits, run: in `win`, once every window's workspace has closed. `blocked`: one's close failed ('failed': the
 * panel says it didn't run) or the user didn't wait for one to finish saving ('left': it doesn't run, quietly).
 */
export async function runQuitCommand(setting: CloseCommandSetting | undefined, reason: CloseReason, win: BrowserWindow | null, blocked: 'failed' | 'left' | null): Promise<RunOutcome> {
  const plan = planRun(setting, reason, {}, { runs: closeCommandsRun() })
  if ('skip' in plan) {
    if (plan.skip !== 'none') log.info(`When Hive quits, run: not run (${plan.skip === 'test' ? 'a test copy of Hive' : 'Hive is restarting for an update'})`)
    return 'skipped'
  }
  if (blocked === 'left') {
    log.info("When Hive quits, run: not run, as the user didn't wait for a workspace to finish saving")
    return 'leftSaving'
  }
  if (blocked) {
    log.warn("When Hive quits, run: not run, as a workspace's close didn't finish")
    return closeFailed(showPanel(win, newRun('quit', plan.command, 'failed')))
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
