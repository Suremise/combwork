import { app, BrowserWindow, crashReporter, powerMonitor } from 'electron'
import { readdirSync, rmSync, statSync } from 'original-fs'
import { basename, join } from 'path'
import { createLogger } from './logger'
import { memoryLine } from './memory'

/**
 * Why Combwork stopped (#985): crash dumps kept in the profile, never sent anywhere, and a line in combwork.log for every way
 * the app can end, so a run that stops without a word (17 Oct 2026) leaves something to go on. The logger's writer thread
 * (HI-1730) writes lines within moments; at the process's exit what it hasn't written is written at once (flushLogs), so
 * a line logged just before the end is on disk when the process goes. A crash of the whole process can lose the last few
 * milliseconds' lines.
 */
const log = createLogger('exit')

/** The ways Combwork itself ends or restarts the app; each call goes through exitBy() and is logged with its caller. */
export type ExitWay = 'app.quit' | 'app.exit' | 'process.exit' | 'app.relaunch' | 'autoUpdater.quitAndInstall'

/** Ends (or restarts) the app by `how`, after logging it with who asked: the only place Combwork's main process does. */
export function exitBy(how: ExitWay, caller: string, act: () => void): void {
  log.info(`Leaving by ${how}: ${caller}`)
  act()
}

/**
 * The one way out that isn't logged: a start refused before its profile folder is chosen (HI-2594, a move of Hive's
 * folder it couldn't make; index.ts says why on stderr and in an error box). The log is in the profile: a line written
 * then would make Electron's default profile folder, Combwork's, which the next start would take for the profile.
 */
export function exitBeforeProfile(code: number): never {
  process.exit(code)
}

/** The folder of the profile's crash dumps (Crashpad's database; the dumps themselves are in its reports folder). */
export function crashDumpsDir(): string {
  return join(app.getPath('userData'), 'Crashpad')
}

/**
 * Starts Electron's crash reporter writing into the profile, with uploading off: a crash of the main process, a
 * window's page or a helper process leaves a minidump there for the user to attach to an issue themselves. Before
 * the app is ready, so the helpers started later report to it.
 */
export function startCrashDumps(): void {
  try {
    app.setPath('crashDumps', crashDumpsDir())
    // It names Combwork's crash handler in CHROME_CRASHPAD_PIPE_NAME, which Chromium's own processes need (taken out of
    // main's environment, a page's crash leaves no dump): what Combwork starts doesn't get it (childEnv, CHILD_ENV_STRIP).
    crashReporter.start({ uploadToServer: false, compress: true })
  } catch (e) {
    log.warn("Couldn't start keeping crash dumps", e)
  }
}

export type CrashDump = { file: string; at: number; bytes: number }

/** The profile's crash dumps, newest first. */
export function crashDumps(dir = join(crashDumpsDir(), 'reports')): CrashDump[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const dumps: CrashDump[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.dmp')) continue
    try {
      const st = statSync(join(dir, name))
      dumps.push({ file: join(dir, name), at: st.mtimeMs, bytes: st.size })
    } catch {
      // Gone meanwhile.
    }
  }
  return dumps.sort((a, b) => b.at - a.at)
}

/** Copy Diagnostics' lines about crash dumps: how many, and the newest, by its file name. */
export function crashDumpLines(dumps: CrashDump[], dir: string): string[] {
  if (!dumps.length) return ['None.']
  const newest = dumps[0]
  return [`- ${dumps.length} in \`${dir}\`; the newest from ${new Date(newest.at).toISOString()}: \`${basename(newest.file)}\` (${Math.round(newest.bytes / 1024)} KB)`, '- Saved on this PC only: Combwork never sends them. Attach one to an issue yourself if asked.'] // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
}

/** What a process that went says of itself, for the log. */
const gone = (d: { reason: string; exitCode: number }): string => `${d.reason}, exit code ${d.exitCode}`

/**
 * Logs every way out and the events around one: errors nothing caught, a page or a helper process that went, the PC
 * sleeping, waking, locking or shutting down, Windows ending the session, and the quit's own steps. Call once, as early
 * as the logger can write (the profile folder is set).
 */
export function startExitLog(): void {
  process.on('uncaughtException', (e) => log.error('uncaughtException', e))
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e))
  process.on('exit', (code) => log.info(`The main process is exiting (exit code ${code}); memory: ${memoryLine()}`))
  app.on('render-process-gone', (_e, contents, d) => {
    const line = `A page's process went (${gone(d)}; ${contents.getType()} ${contents.id})`
    if (d.reason === 'clean-exit') log.info(line)
    else log.error(line)
  })
  app.on('child-process-gone', (_e, d) => {
    const line = `A ${d.type} process went (${gone(d)}${d.serviceName ? `; ${d.serviceName}` : ''}${d.name ? `; ${d.name}` : ''})`
    if (d.reason === 'clean-exit') log.info(line)
    else log.error(line)
  })
  app.on('before-quit', () => log.info('before-quit'))
  app.on('will-quit', () => log.info('will-quit'))
  app.on('quit', (_e, code) => log.info(`quit (exit code ${code})`))
  // Every window is told: one line for them all.
  const told: Record<string, number> = {}
  const ending = (kind: string, line: string, reasons: string[]): void => {
    if (Date.now() - (told[kind] ?? 0) < 5000) return
    told[kind] = Date.now()
    log.info(`${line} (${reasons.join(', ') || 'no reason given'})`)
  }
  const watchWindow = (w: BrowserWindow): void => {
    w.on('query-session-end', (e) => ending('query', 'Windows asks whether the session may end', e.reasons))
    w.on('session-end', (e) => ending('end', 'Windows is ending the session', e.reasons))
  }
  app.on('browser-window-created', (_e, w) => watchWindow(w))
  void app.whenReady().then(() => {
    for (const w of BrowserWindow.getAllWindows()) watchWindow(w)
    powerMonitor.on('suspend', () => log.info('The PC is going to sleep'))
    // Waking up is logged where Combwork acts on it (power.ts).
    powerMonitor.on('shutdown', () => log.info('The PC is shutting down'))
    powerMonitor.on('lock-screen', () => log.info('The screen was locked'))
    powerMonitor.on('unlock-screen', () => log.info('The screen was unlocked'))
  })
}

/** How many crash dumps the profile keeps (#1111): one can be tens of MB, and the newest say what is wrong now. */
export const CRASH_DUMPS_KEPT = 3

/**
 * Removes all but the newest `keep` dumps (newest first, as crashDumps gives them), as old heap snapshots are (not to
 * the Recycle Bin: Combwork's own diagnostics in its profile). Returns the dumps left; one that can't be removed stays.
 */
export function pruneCrashDumps(dumps: CrashDump[], keep = CRASH_DUMPS_KEPT): { kept: CrashDump[]; removed: number; bytes: number } {
  let removed = 0
  let bytes = 0
  const kept = dumps.slice(0, keep)
  for (const d of dumps.slice(keep)) {
    try {
      rmSync(d.file)
      removed++
      bytes += d.bytes
    } catch {
      kept.push(d)
    }
  }
  return { kept, removed, bytes }
}

/** At start, after its first line: the crash dumps the profile has, and the newest's time; past the newest three, the rest go. */
export function logCrashDumps(): void {
  const { kept: dumps, removed, bytes } = pruneCrashDumps(crashDumps())
  if (removed) log.info(`Removed ${removed} older crash dump(s) (${Math.round(bytes / 1024 / 1024)} MB): the newest ${CRASH_DUMPS_KEPT} are kept`)
  if (dumps.length) log.info(`${dumps.length} crash dump(s) in the profile; the newest from ${new Date(dumps[0].at).toISOString()}`)
}
