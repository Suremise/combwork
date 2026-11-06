import { app, BrowserWindow, powerMonitor, powerSaveBlocker } from 'electron'
import { agentsWorking, shouldKeepAwake } from '../shared/keepAwake'
import { config } from './config'
import { emit, onCombworkEvent } from './events'
import { createLogger } from './logger'
import { sessions } from './sessions'
import { openWorkspaces } from './workspace'

const log = createLogger('power')

let blocker: number | null = null
/** Agents working while the PC is kept awake (0: it isn't). */
let keptFor = 0

/** How many working agents are keeping the PC awake now (0 when nothing is). */
export function keepAwakeCount(): number {
  return keptFor
}

/** Holds or releases Windows' sleep blocker to match the agents and the setting (Settings → General). */
function update(): void {
  const working = agentsWorking(sessions.liveStates())
  const hold = shouldKeepAwake(working, config.settings.general.keepAwake, powerMonitor.isOnBatteryPower())
  if (hold && blocker === null) {
    // The app keeps running; the screen may still turn off and lock.
    blocker = powerSaveBlocker.start('prevent-app-suspension')
    log.info(`Keeping the PC awake while ${working} agent(s) work`)
  } else if (!hold && blocker !== null) {
    powerSaveBlocker.stop(blocker)
    blocker = null
    log.info('No longer keeping the PC awake')
  }
  const count = hold ? working : 0
  if (count !== keptFor) {
    keptFor = count
    emit({ type: 'keep-awake', working: count })
  }
}

/**
 * How long the transcripts may take when Windows ends the session. Windows waits for each callback, and only after
 * about 5 s offers to end an app that holds it up. These leave room: no copy step starts after its budget, though
 * one under way finishes (a step is 1 MB, so it runs over by about one disk write).
 */
export const SHUTDOWN_BUDGET_MS = { 'query-session-end': 2000, 'session-end': 1000, shutdown: 2000 }
type Ending = keyof typeof SHUTDOWN_BUDGET_MS
/** When each notice was last acted on: every window gets it, and one save covers them all. */
const lastEnding: Partial<Record<Ending, number>> = {}

/**
 * Windows is shutting down, restarting or signing out: back up the transcripts before returning, as Windows doesn't
 * wait for a Promise. query-session-end asks first (another app may still cancel it, which leaves nothing to undo);
 * session-end follows when it goes ahead, and catches up with what was written since.
 */
function sessionEnding(kind: Ending): void {
  const now = Date.now()
  if (now - (lastEnding[kind] ?? 0) < 5000) return
  lastEnding[kind] = now
  const r = sessions.backupAllNow(SHUTDOWN_BUDGET_MS[kind])
  log.info(`Windows is ending the session (${kind}): backed up ${r.saved} transcript(s) in ${Date.now() - now} ms${r.incomplete ? `, ${r.incomplete} incomplete (out of time)` : ''}${r.skipped ? `, ${r.skipped} not tried` : ''}${r.failed ? `, ${r.failed} failed` : ''}`)
}

function watchWindow(win: BrowserWindow): void {
  win.on('query-session-end', () => sessionEnding('query-session-end'))
  win.on('session-end', () => sessionEnding('session-end'))
}

export function startPowerWatch(): void {
  onCombworkEvent((e) => {
    if (e.type === 'session-status' || e.type === 'session-exit') update()
  })
  config.onSettingsChanged((s, prev) => {
    if (s.general.keepAwake !== prev.general.keepAwake) update()
  })
  powerMonitor.on('on-ac', update)
  powerMonitor.on('on-battery', update)
  // Linux and macOS; Windows tells each window (query-session-end).
  powerMonitor.on('shutdown', () => sessionEnding('shutdown'))
  for (const w of BrowserWindow.getAllWindows()) watchWindow(w)
  app.on('browser-window-created', (_e, w) => watchWindow(w))
  powerMonitor.on('resume', () => {
    log.info('The PC woke up: refreshing agents and plan usage')
    sessions.refreshAfterResume()
    for (const w of openWorkspaces()) w.scheduleRefresh()
    update()
  })
  update()
}
