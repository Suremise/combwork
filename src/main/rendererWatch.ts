import { msg, tr } from '../shared/i18n'
import { dialog, type MessageBoxOptions, type RenderProcessGoneDetails } from 'electron'
import { randomUUID } from 'crypto'
import { emitTo } from './events'
import { createLogger, userText } from './logger'
import { taskText, whereText, type LongTask, type WindowWhere } from '../shared/windowHealth'
import type { HiveWindow } from './windows'
import { APP_NAME } from '../shared/appName'

const log = createLogger('window')

/** A second crash within this long doesn't reload again: it asks, so a page that crashes on load can't loop. */
export const CRASH_LOOP_MS = 60_000
/** How long a window may hang before Hive offers to reload it. */
const HANG_MS = 4000

/** What to do about a window's renderer that has gone: reload it, or ask (it crashed again soon after a reload). */
export function crashResponse(lastCrashAt: number | null, now: number): 'reload' | 'ask' {
  return lastCrashAt !== null && now - lastCrashAt < CRASH_LOOP_MS ? 'ask' : 'reload'
}

/** The note shown once a crashed window has reloaded. */
export function reloadedMessage(unsaved: number): string {
  return unsaved
    ? tr(msg({ id: 'main.window.reloadedLost', defaultMessage: '{n, plural, one {Your agents kept running. Unsaved changes to one file were lost.} other {Your agents kept running. Unsaved changes to # files were lost.}}', description: "The notice after Hive's window crashed and was reloaded, when files had unsaved edits. {n} is how many." }), { n: unsaved })
    : tr(msg({ id: 'main.window.reloaded', defaultMessage: 'Your agents kept running.', description: "The notice after Hive's window crashed and was reloaded." }))
}

/** What hive.log needs of a window's page to say why it froze (HI-1775): where it is, its last input, its last long tasks. */
interface Health {
  where: WindowWhere | null
  /** Its last input (a key, a click, a move): epoch ms. */
  inputAt: number
  /** Its long tasks lately, newest last. */
  recent: LongTask[]
  /** When a long-task line was last written, and the tasks held back since (rate-limited). */
  loggedAt: number
  heldBack: number
  /** When it stopped responding (Electron's `unresponsive`), while it hasn't responded since. */
  hungAt: number | null
}
const health = new WeakMap<HiveWindow, Health>()
const healthOf = (entry: HiveWindow): Health => {
  let h = health.get(entry)
  if (!h) health.set(entry, (h = { where: null, inputAt: 0, recent: [], loggedAt: 0, heldBack: 0, hungAt: null }))
  return h
}
/** At most one long-task line per window in this long: the rest are counted in the next. */
const LONG_TASK_LOG_MS = 10_000
/** How many of its last long tasks a hang's line names. */
const RECENT_TASKS = 5

/** The page says where it is now. */
export function noteWhere(entry: HiveWindow, where: WindowWhere | null): void {
  if (where) healthOf(entry).where = where
}

/** The page's long tasks just ended: logged as one line (its longest, how many, where), at most every LONG_TASK_LOG_MS. */
export function noteLongTasks(entry: HiveWindow, tasks: LongTask[], where: WindowWhere | null, now = Date.now()): void {
  if (!tasks.length) return
  const h = healthOf(entry)
  if (where) h.where = where
  h.recent = [...h.recent, ...tasks].slice(-RECENT_TASKS)
  if (now - h.loggedAt < LONG_TASK_LOG_MS) {
    h.heldBack += tasks.length
    return
  }
  const longest = tasks.reduce((a, b) => (b.ms > a.ms ? b : a))
  const total = tasks.reduce((t, x) => t + x.ms, 0)
  const more = h.heldBack ? `; ${h.heldBack} more since the last line, not logged` : '' // i18n-ignore: hive.log, in English
  // Where the longest ran (its own place: the window may have moved on since), and each other place the burst's tasks ran.
  const at = longest.where ?? where ?? h.where
  const places = new Set(tasks.map((t) => whereText(t.where ?? null, userText)).filter((w) => w !== whereText(at, userText) && w !== 'where unknown'))
  const elsewhere = places.size ? `; others in ${[...places].join(' | ')}` : '' // i18n-ignore: hive.log, in English
  log.warn(`The window's page was busy for ${Math.round(longest.ms)} ms (${whereText(at, userText)}); ${tasks.length} long task(s), ${Math.round(total)} ms in all; the longest: ${taskText(longest)}${elsewhere}${more}`)
  h.loggedAt = now
  h.heldBack = 0
}

/** What a hang's lines say of the window: where it was, its last input, its last long tasks. */
function hangContext(h: Health, now: number): string {
  const input = h.inputAt ? `its last input ${((now - h.inputAt) / 1000).toFixed(1)} s before` : 'no input seen' // i18n-ignore: hive.log, in English
  // Each where it ran, when that isn't where the window is now.
  const here = whereText(h.where, userText)
  const placed = (t: LongTask): string => {
    const there = whereText(t.where ?? null, userText)
    return there !== here && there !== 'where unknown' ? `${taskText(t)} in ${there}` : taskText(t) // i18n-ignore: hive.log, in English
  }
  const tasks = h.recent.length ? `its last long tasks: ${h.recent.map(placed).join(', ')}` : 'no long task reported' // i18n-ignore: hive.log, in English
  return `${whereText(h.where, userText)}; ${input}; ${tasks}`
}

const stillRunning = (): string => tr(msg({ id: 'main.window.stillRunning', defaultMessage: 'Your agents are still running: reloading the window reconnects to them.', description: "Hive's question when its window stopped or isn't responding." }))

/**
 * Keeps a window usable when its page crashes or hangs. Agents run in the main process, so they're
 * unaffected; only the page is reloaded (its terminals reattach, as after View → Reload), and the window
 * keeps its workspace. Each window is watched on its own.
 */
export function watchRenderer(entry: HiveWindow, opts: { quitting: () => boolean; openLogs: () => void; quit: () => void }): void {
  const win = entry.win
  let lastCrashAt: number | null = null
  // A reload Hive asked for after a hang crashes the page first: not a crash to report.
  let expectGone = false
  let hangTimer: NodeJS.Timeout | null = null
  let hangPrompt: AbortController | null = null

  const ask = (options: MessageBoxOptions, signal?: AbortSignal): Promise<number> =>
    dialog.showMessageBox(win, { ...options, ...(signal ? { signal } : {}), noLink: true }).then((r) => r.response)

  const reload = (afterCrash: boolean): void => {
    if (win.isDestroyed()) return
    const unsaved = entry.unsaved.length
    entry.unsaved = []
    if (afterCrash) {
      win.webContents.once('did-finish-load', () => {
        // Give the page a moment to subscribe to events.
        setTimeout(() => {
          if (win.isDestroyed()) return
          emitTo(win, { type: 'toast', toast: { id: randomUUID(), level: 'warning', title: tr(msg({ id: 'main.window.reloadedTitle', defaultMessage: "Combwork's window stopped and was reloaded", description: "A notice's title after Hive's window crashed and was reloaded." })), message: reloadedMessage(unsaved), timestamp: new Date().toISOString() } })
        }, 1500)
      })
    }
    win.webContents.reload()
  }

  win.webContents.on('render-process-gone', (_e, details: RenderProcessGoneDetails) => {
    if (details.reason === 'clean-exit' || win.isDestroyed() || opts.quitting()) return
    clearHang()
    if (expectGone) {
      expectGone = false
      // The reload asked for with the crash can land before it, and go with the old page.
      if (win.webContents.isCrashed()) reload(false)
      return
    }
    log.error(`The window's page stopped (${details.reason}, exit code ${details.exitCode})`)
    const now = Date.now()
    const response = crashResponse(lastCrashAt, now)
    lastCrashAt = now
    if (response === 'reload') return reload(true)
    void (async () => {
      for (;;) {
        const choice = await ask({
          type: 'error',
          title: APP_NAME,
          message: tr(msg({ id: 'main.window.stopped', defaultMessage: "Combwork's window stopped working.", description: "Hive's question when its window crashed again soon after a reload." })),
          detail: stillRunning(),
          buttons: [tr(msg({ id: 'main.window.reload', defaultMessage: 'Reload', description: "Button: reloads Hive's window." })), tr(msg({ id: 'main.window.openLogs', defaultMessage: 'Open Logs', description: "Button: opens the folder of Hive's log files." })), tr(msg({ id: 'main.window.quit', defaultMessage: 'Quit Combwork', description: 'Button: quits Hive.' }))],
          defaultId: 0,
          cancelId: 0
        })
        if (choice === 1) {
          opts.openLogs()
          continue
        }
        if (choice === 2) return opts.quit()
        return reload(true)
      }
    })()
  })

  const clearHang = (): void => {
    if (hangTimer) clearTimeout(hangTimer)
    hangTimer = null
    hangPrompt?.abort()
    hangPrompt = null
  }

  // Its last input, for a hang's line (each event only noted: no work here).
  const h = healthOf(entry)
  win.webContents.on('input-event', () => {
    h.inputAt = Date.now()
  })

  win.on('unresponsive', () => {
    // The episode's start, logged as it begins (once): a hang that recovers before the prompt has both ends in the log
    // too (HR1's HI-1775 round 1). The prompt still waits HANG_MS.
    if (h.hungAt === null && !win.isDestroyed() && !opts.quitting()) {
      h.hungAt = Date.now()
      log.warn(`The window's page isn't responding (${hangContext(h, h.hungAt)})`)
    }
    if (hangTimer || hangPrompt || win.isDestroyed()) return
    hangTimer = setTimeout(() => {
      hangTimer = null
      if (win.isDestroyed() || opts.quitting()) return
      const prompt = new AbortController()
      hangPrompt = prompt
      void ask(
        {
          type: 'warning',
          title: APP_NAME,
          message: tr(msg({ id: 'main.window.unresponsive', defaultMessage: "Combwork's window isn't responding.", description: "Hive's question when its window has stopped responding." })),
          detail: tr(msg({ id: 'main.window.unresponsiveDetail', defaultMessage: '{stillRunning} Wait for it, or reload it.', description: "Hive's question when its window isn't responding. {stillRunning} says the agents are still running." }), { stillRunning: stillRunning() }),
          buttons: [tr(msg({ id: 'main.window.wait', defaultMessage: 'Wait', description: "Button: waits for Hive's window to respond." })), tr(msg({ id: 'main.window.reload', defaultMessage: 'Reload', description: "Button: reloads Hive's window." }))],
          defaultId: 0,
          cancelId: 0
        },
        prompt.signal
      )
        .then((choice) => {
          if (prompt.signal.aborted || hangPrompt !== prompt) return
          hangPrompt = null
          if (choice !== 1 || win.isDestroyed()) return
          log.warn('Reloading the window after it stopped responding')
          // A hung page can't reload itself: end it first (Electron's way), then load it again.
          expectGone = true
          win.webContents.forcefullyCrashRenderer()
          reload(false)
        })
        .catch(() => undefined)
    }, HANG_MS)
  })

  // It recovered: no need to ask any more, and how long it was out goes in the log.
  win.on('responsive', () => {
    clearHang()
    if (h.hungAt === null) return
    const now = Date.now()
    log.warn(`The window's page responds again, ${((now - h.hungAt) / 1000).toFixed(1)} s after it stopped responding (${hangContext(h, now)})`)
    h.hungAt = null
  })
}
