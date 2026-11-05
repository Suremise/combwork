import { app, type BrowserWindow } from 'electron'
import { existsSync, writeFileSync } from 'original-fs'
import { basename, join, sep } from 'path'
import { homedir } from 'os'
import type { CloseCommandRun, CloseCommandStep, CloseReason, CommandRef, CommandsCombwork } from '../../shared/types'
import { OBSERVE_MS, resolvePoint, type CommandReason, type CommandValues } from '../../shared/commands'
import { msg } from '../../shared/i18n'
import { combworkError } from '../combworkError'
import { config } from '../config'
import type { ListControl, ListStatus, ListStep } from './listRunner'
import { emitTo } from '../events'
import { createLogger, userText } from '../logger'
import { childEnv } from '../ptyHost'
import { testQuiet } from '../testQuiet'
import { checkEnv } from '../workflow/queueChecks'
import type { WorkspaceService } from '../workspace'
import { drainWorkspace, type DrainResult } from './drain'
import { alive, carryRuns, type RunsCarried, planList, pruneRuns, readList, runFolderName, runPrefix, runsCloseCommands, startRun, START_MS } from './runs'

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

/**
 * A moved workspace's close-command runs follow it (HI-2007, Repair…): those kept under any of its old place's spellings
 * (`fromPlaces`) are its new place's, while `proceed` says so (runs.ts carryRuns).
 */
export const carryWorkspaceRuns = (fromPlaces: readonly string[], toPlace: string, proceed: () => boolean): Promise<RunsCarried> =>
  carryRuns(runsRoot(), fromPlaces.map((p) => runPrefix('workspace', p)), runPrefix('workspace', toPlace), proceed)

/** The runner's script, outside the asar (electron-builder.yml unpacks it). */
function runnerScript(): string {
  const p = join(__dirname, 'cw-close-runner.js')
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

/** A list's run while Hive follows it, by its panel's id: its folder (for controls) and how its launch failure is settled. */
const following = new Map<string, { dir: string | null; control: (action: ListControl['action'], step: number, attempt: number) => void }>()

/**
 * The panel's choices on a failed step (closeCommand:control): Rerun, Skip it and continue, Stop here, for that step's
 * attempt only, so a repeated or stale one does nothing (the runner takes each control once, HI-1954/s19 §2).
 */
export function controlRun(win: BrowserWindow, id: string, action: unknown, step: unknown, attempt: unknown): void {
  const s = shown.get(win.webContents.id)
  const a = s?.run.awaiting
  if (!s || s.run.id !== id || !a || a.step !== step || a.attempt !== attempt) return
  if (action !== 'rerun' && action !== 'skip' && action !== 'stop') return
  following.get(id)?.control(action, a.step, a.attempt)
}

/** Its panel's steps from the runner's status: those of this launch at `from` on, the earlier ones as they were. */
function stepsFrom(panelSteps: CloseCommandStep[], status: ListStatus, from: number): CloseCommandStep[] {
  return panelSteps.map((p, i) => {
    const s = i >= from ? status.steps[i - from] : undefined
    if (!s) return p
    return { name: s.name, state: s.state, exitCode: s.exitCode, ...(s.failure ? { failure: s.failure } : {}), ...(s.detail ? { detail: s.detail } : {}), ...(s.startedAt ? { startedAt: s.startedAt } : {}), ...(s.endedAt ? { endedAt: s.endedAt } : {}) }
  })
}

/**
 * Runs a point's commands (`steps`, its templates as saved now) for its window, all in one runner (HI-1954, design
 * HI-1954/s19 §2), followed until the list ends, the user stops waiting (Don't wait: the rest run on by themselves,
 * in order), or the window goes. A failed step waits on the panel for the user's choice, which goes to the runner as a
 * control; a launch that fails is the first step's failure, with the same choices (Skip launches the rest, so a list
 * goes on to its end, HI-1954/s21). `values()`: the placeholders' values, read again for a Rerun. Never throws.
 */
export async function runListInWindow(win: BrowserWindow | null, point: NonNullable<CloseCommandRun['point']>, place: string | null, steps: ListStep[], values: () => CommandValues, shownPanel?: Panel): Promise<RunOutcome> {
  // Kept with the workspace's runs, or When Hive quits' when there is no workspace (a Hive command run by hand from none).
  const kind = point === 'quit' || !place ? 'quit' : 'workspace'
  const panel = shownPanel ?? showPanel(win, newRun(kind, '', 'running'))
  const id = panel.run.id
  let panelSteps: CloseCommandStep[] = steps.map((s) => ({ name: s.name, state: 'waiting', exitCode: null }))
  const name = values().name
  panel.update({ state: 'running', point, steps: panelSteps, awaiting: null, startedAt: new Date().toISOString(), lines: [], command: '', ...(name ? { workspace: name } : {}) })
  const root = runsRoot()
  const said = `${point} commands (${steps.map((s) => userText(s.name)).join(', ')})` // i18n-ignore: for the log
  const prefix = runPrefix(kind, place)
  await pruneRuns(root, prefix).catch((e) => log.warn('pruning the commands kept', e))
  const home = homedir()
  let from = 0
  let dir: string | null = null
  let launchFailed = false
  const show = (r: Partial<CloseCommandRun>): void => panel.update({ steps: panelSteps, ...r })
  const launch = (): void => {
    launchFailed = false
    try {
      dir = startRun(root, runFolderName(prefix, new Date()), { list: true, steps: steps.slice(from), values: values(), home }, home, { exec: process.execPath, script: runnerScript(), env: checkEnv(childEnv()) })
      writeFileSync(join(dir, 'observer'), '')
      if (unwatched) detach()
      log.info(`${said} started at step ${from + 1} (${userText(dir)})`)
    } catch (e) {
      dir = null
      launchFailed = true
      log.warn(`${said} couldn't start at step ${from + 1}`, e)
      panelSteps = panelSteps.map((p, i) => (i === from ? { ...p, state: 'failed', failure: 'spawn', detail: (e as Error).message } : p))
      show({ state: 'failed', awaiting: { step: from, attempt: 0, needed: steps[from].needed } })
    }
  }
  let settle!: (r: RunOutcome | 'gone') => void
  const result = new Promise<RunOutcome | 'gone'>((r) => (settle = r))
  following.set(id, {
    get dir() {
      return dir
    },
    control: (action, step, attempt) => {
      if (launchFailed && step === from && attempt === 0) {
        // The launch failed: Hive settles it, the runner never having started.
        if (action === 'stop') {
          panelSteps = panelSteps.map((p, i) => (i > from ? { ...p, state: 'skipped' } : p))
          show({ awaiting: null })
          return settle('failed')
        }
        if (action === 'skip') from++
        if (from >= steps.length) {
          show({ awaiting: null })
          return settle('failed')
        }
        show({ state: 'running', awaiting: null })
        return launch()
      }
      if (!dir) return
      try {
        writeFileSync(join(dir, `control-${step - from}-${attempt}.json`), JSON.stringify({ action, ...(action === 'rerun' ? { values: values() } : {}) }))
      } catch (e) {
        log.warn(`${said}: couldn't hand the runner the user's choice`, e)
      }
    }
  })
  // Don't wait, or no window to ask (none, or it went): nobody waits, so the runner settles failures by its rule now.
  let unwatched = false
  const detach = (): void => {
    if (!dir) return
    try {
      writeFileSync(join(dir, 'control-detach.json'), JSON.stringify({ action: 'detach' }))
    } catch (e) {
      log.warn(`${said}: couldn't tell the runner nobody waits`, e)
    }
  }
  void panel.ended.then((how) => {
    unwatched = true
    detach()
    // A launch that failed with nobody to ask: it failed, as a command that couldn't start always has.
    settle(how === 'left' ? 'left' : launchFailed ? 'failed' : 'gone')
  })
  launch()
  // Followed until it ends, the user stops waiting, or the window goes; watched, so the runner waits for a choice.
  let reading = false
  let observed = Date.now()
  const startedAt = Date.now()
  const tick = setInterval(() => {
    if (reading || !dir) return
    const at = dir
    reading = true
    if (Date.now() - observed >= OBSERVE_MS) {
      observed = Date.now()
      try {
        writeFileSync(join(at, 'observer'), '')
      } catch {
        // Tried again at the next tick's turn.
      }
    }
    void readList(at)
      .then(({ status, lines }) => {
        if (at !== dir) return
        if (!status) {
          if (Date.now() - startedAt > START_MS) {
            log.warn(`${said}: its runner wrote no status in ${START_MS / 1000} s`)
            show({ state: 'failed', failure: 'runner', awaiting: null, lines })
            settle('failed')
          }
          return
        }
        panelSteps = stepsFrom(panelSteps, status, from)
        const cur = status.steps.findIndex((s) => s.state === 'running')
        const now = status.awaiting ? status.steps[status.awaiting.step] : cur >= 0 ? status.steps[cur] : undefined
        const common = { lines, command: now?.command ?? '', exitCode: now?.exitCode ?? null }
        if (status.state === 'running' && !alive(status.runnerPid)) {
          log.warn(`${said}: its runner ended before the list did`)
          show({ ...common, state: 'failed', failure: 'runner', awaiting: null })
          return settle('failed')
        }
        if (status.state === 'exited') {
          const failed = status.steps.some((s) => s.state === 'failed')
          log.info(`${said} ended ${status.ended}${failed ? ', with a step failed' : ''}${status.unattended ? ` (${status.unattended})` : ''}`)
          show({ ...common, awaiting: null })
          return settle(status.ended === 'done' && !failed ? 'ok' : 'failed')
        }
        if (status.awaiting) {
          const a = status.awaiting
          return show({ ...common, state: 'failed', awaiting: { step: from + a.step, attempt: a.attempt, needed: steps[from + a.step].needed } })
        }
        show({ ...common, state: 'running', awaiting: null })
      })
      .finally(() => (reading = false))
  }, FOLLOW_MS)
  const r = await result
  clearInterval(tick)
  following.delete(id)
  if (r === 'left') log.info(`${said}: Combwork stopped waiting (Don't wait); the rest run on by themselves`)
  // A list that ended (done or stopped) goes; one whose runner went keeps its panel until it is closed.
  if (r === 'ok' || (r === 'failed' && panel.run.failure !== 'runner')) panel.end('dismissed')
  if (r === 'failed' && panel.run.failure === 'runner') await panel.ended
  return r === 'gone' ? 'left' : r
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
  const plan = planList(ws.config.commands?.onClose, { hive: combworkCommands().list, workspace: ws.config.commands?.list }, reason, { runs: closeCommandsRun() })
  // Its placeholders' values as it closes: its folder and projects, read while it is still open.
  const values = workspaceValues(ws, reason)
  op.done = closeAndRun(ws, op, plan, win, values)
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
 * For the onclose suite (unpackaged builds only): the saving step waits while CW_TEST_HOLD_DRAIN's file exists, as a
 * slow save would keep it, until the user skips the command.
 */
async function heldForTest(signal: AbortSignal): Promise<void> {
  const file = app.isPackaged ? undefined : process.env.CW_TEST_HOLD_DRAIN
  if (!file) return
  while (existsSync(file) && !signal.aborted) await new Promise((r) => setTimeout(r, 100))
}

async function closeAndRun(ws: WorkspaceService, op: CloseOp, plan: ReturnType<typeof planList>, win: BrowserWindow | null, values: CommandValues): Promise<RunOutcome> {
  const name = userText(basename(op.path))
  if ('skip' in plan && plan.skip !== 'none') log.info(`${name}'s close commands not run: ${plan.skip === 'test' ? 'a test copy of Combwork' : 'Combwork is restarting for an update'}`)
  if ('gone' in plan && plan.gone) log.info(`${name}'s close point picks ${plan.gone} command(s) no longer there: left out`)
  const hasCommand = 'steps' in plan
  // The saving step's panel: up from the start when there is a command to run, or a caller needs it drained; brought up
  // later by a caller that joins needing that (a quit joining this window's close). Its Skip the command ends the
  // drain's wait, never the close.
  let panel: Panel | null = null
  op.showSaving = () => {
    if (panel) return
    panel = showPanel(win, { ...newRun('workspace', '', 'saving', basename(op.path)), point: 'close', ...(hasCommand ? { steps: plan.steps.map((s) => ({ name: s.name, state: 'waiting' as const, exitCode: null })) } : {}) })
    void panel.skipped.then(() => {
      log.info(`${name}: the user skipped its close command; Combwork finishes closing it`)
      op.skip.abort()
    })
  }
  if (hasCommand || op.wantDrain) op.showSaving()
  const ended = (): void => (panel as Panel | null)?.end('dismissed')
  const skipped = (): RunOutcome => {
    log.warn(`${name}: the user skipped the command, so ${hasCommand ? 'its close command' : 'When Combwork quits, run'} won't run`)
    ended()
    return 'leftSaving'
  }
  // The close, always to its end, as before close commands.
  try {
    await ws.close()
  } catch (e) {
    // Nothing to run and nothing waiting on it: an ordinary close's failure, as before.
    if (!panel) throw e
    log.warn(`${name}'s close failed, so ${hasCommand ? 'its close command' : 'When Combwork quits, run'} won't run`, e)
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
    log.warn(`${name} wasn't finished being written (${d.left.join(', ')}), so ${hasCommand ? 'its close command' : 'When Combwork quits, run'} won't run`)
    ended()
    return 'notDrained'
  }
  if (!hasCommand) {
    ended()
    return 'skipped'
  }
  return runListInWindow(win, 'close', op.place ?? op.path.toLowerCase(), plan.steps, () => values, (panel as Panel | null) ?? undefined)
}

/**
 * When Hive quits, run: in `win`, once every window's workspace has closed. `blocked`: one's close failed ('failed': the
 * panel says it didn't run) or the user didn't wait for one to finish saving ('left': it doesn't run, quietly).
 */
export async function runQuitCommand(commands: CommandsCombwork, reason: CloseReason, win: BrowserWindow | null, blocked: 'failed' | 'left' | null): Promise<RunOutcome> {
  const plan = planList(commands.onQuit, { hive: commands.list }, reason, { runs: closeCommandsRun() })
  if ('skip' in plan) {
    if (plan.skip !== 'none') log.info(`When Combwork quits, run: not run (${plan.skip === 'test' ? 'a test copy of Combwork' : 'Combwork is restarting for an update'})`)
    return 'skipped'
  }
  if (blocked === 'left') {
    log.info("When Combwork quits, run: not run, as the user didn't wait for a workspace to finish saving")
    return 'leftSaving'
  }
  if (blocked) {
    log.warn("When Combwork quits, run: not run, as a workspace's close didn't finish")
    return closeFailed(showPanel(win, { ...newRun('quit', '', 'failed'), point: 'quit', steps: plan.steps.map((s) => ({ name: s.name, state: 'waiting' as const, exitCode: null })) }))
  }
  return runListInWindow(win, 'quit', null, plan.steps, () => ({ reason }))
}

/** Whether When Hive quits, run will run for this quit (set, not a test copy, not skipped for an update). */
export const quitCommandPlanned = (commands: CommandsCombwork, reason: CloseReason): boolean => 'steps' in planList(commands.onQuit, { hive: commands.list }, reason, { runs: closeCommandsRun() })

/** Whether a quit has anything to run: a window's workspace with a command, or When Hive quits. */
export function quitRunsAny(workspaces: WorkspaceService[], commands: CommandsCombwork): boolean {
  if (!closeCommandsRun()) return false
  return commands.onQuit.run.length > 0 || workspaces.some((w) => !!w.path && !!w.config.commands?.onClose.run.length)
}

/**
 * Runs one command by hand (HI-1954: the palette's Run Command, Settings' Run): its panel in this window, as a point's,
 * with its one step, its placeholders the window's workspace's (none: Hive's own commands only make sense without them).
 * A test copy runs one only through the suites' seam, as it runs the points.
 */
export function runByHand(win: BrowserWindow, ws: WorkspaceService | null, ref: CommandRef): void {
  const c = resolvePoint({ run: [ref] }, { hive: combworkCommands().list, workspace: ws?.config.commands?.list })[0]?.command
  if (!c) throw combworkError(M.gone, undefined, { kind: 'notFound' })
  if (!closeCommandsRun()) throw combworkError(M.testCopy, undefined, { kind: 'conflict' })
  const place = ws?.path ? (ws.openPlace ?? ws.path.toLowerCase()) : null
  const step = { name: c.name, command: c.command, folder: c.folder ?? '', needed: false }
  void runListInWindow(win, 'manual', place, [step], () => (ws?.path ? workspaceValues(ws, 'manual') : { reason: 'manual' })) // i18n-ignore: {reason}'s value, as the command reads it
}

const M = {
  gone: msg({ id: 'commands.run.gone', defaultMessage: 'That command is no longer there.', description: 'An error: the user ran one of their commands by hand (Settings → Commands, or the command palette), but it was deleted meanwhile.' }),
  testCopy: msg({ id: 'commands.run.testCopy', defaultMessage: "This is a test copy of Combwork: it doesn't run your commands.", description: "An error in a test copy of Combwork (one the developers' tests start): it never runs the user's own commands." })
}

/**
 * A workspace's open point (HI-1954, design HI-1954/s19 §1 and s21 §3): its commands run in its window as it opens, its
 * agents held by the gate reserved as it opened (WorkspaceService.open) until the list ends, the user stops waiting, or
 * chooses Stop here; a launch that fails is the first step's failure, its choices the same. Closed or switched meanwhile,
 * the gate settles as closed by itself, and nothing it held starts. Never throws.
 */
export async function runOpenCommands(ws: WorkspaceService): Promise<void> {
  const gate = ws.openGate
  if (!gate?.held || !ws.path) return
  const name = userText(basename(ws.path))
  try {
    const plan = planList(ws.config.commands?.onOpen, { hive: combworkCommands().list, workspace: ws.config.commands?.list }, 'open', { runs: closeCommandsRun() })
    if (!('steps' in plan)) {
      gate.settle('done')
      return
    }
    if (plan.gone) log.info(`${name}'s open point picks ${plan.gone} command(s) no longer there: left out`)
    // Its projects from its folder: the open's first read of them (the window's view) may not have happened yet.
    const known: Record<string, string> = {}
    for (const p of await ws.listProjectPaths().catch(() => [])) known[basename(p).toLowerCase()] = p
    if (!gate.held || ws.lifetime.aborted) return
    const r = await runListInWindow(ws.window ?? null, 'open', ws.openPlace ?? ws.path.toLowerCase(), plan.steps, () => workspaceValues(ws, 'open', known))
    if (gate.settle(r === 'left' ? 'detached' : r === 'ok' ? 'done' : 'stopped')) log.info(`${name}'s open commands: its agents may start (${gate.end})`)
  } catch (e) {
    log.warn(`${name}'s open commands`, e)
    gate.settle('stopped')
  }
}

/** Hive's own commands, as saved (Settings → Commands at Hive's level). */
const combworkCommands = (): CommandsCombwork => config.settings.commands

/** What a workspace's commands' placeholders stand for now: its folder, its name, why, and its projects by name. */
export function workspaceValues(ws: WorkspaceService, reason: CommandReason, known: Record<string, string> = {}): CommandValues {
  const path = ws.path ?? undefined
  // `known`: its projects read from its folder, for an open whose first read of them hasn't happened yet (HR2's round 1).
  const projects: Record<string, string> = { ...known }
  for (const p of ws.info()?.projects ?? []) projects[p.name.toLowerCase()] = p.path
  return { workspace: path, name: path ? basename(path) : undefined, reason, projects }
}
