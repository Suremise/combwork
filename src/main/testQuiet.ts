import { appendFileSync } from 'original-fs'
import { app, screen, type BrowserWindow } from 'electron'

/**
 * Test copies of Hive don't interrupt the person at the desk: their windows open off screen and never take focus, and
 * Windows notifications, taskbar flashes and the chime don't happen. What would have happened is appended to
 * HIVE_TEST_NOTIFY_LOG (one JSON line each), so suites can check it. A test copy is an unpackaged build with a test
 * profile (HIVE_USER_DATA, which every suite, scenario and verification script sets, however it is started), or one
 * started with HIVE_TEST_QUIET=1; HIVE_TEST_QUIET=0 turns it off, for a test that needs a real window. A packaged build
 * is quiet only with HIVE_TEST_QUIET=1 (#1253: the packaged suites start dist\win-unpacked with it, hiveEnv); its test
 * profile alone doesn't make it so. Never on in normal use: `npm run dev` has no HIVE_USER_DATA, and the installed app
 * is started without HIVE_TEST_QUIET.
 */
export function testQuiet(env: NodeJS.ProcessEnv = process.env, packaged = app.isPackaged): boolean {
  const quiet = env.HIVE_TEST_QUIET
  if (packaged) return quiet === '1'
  return quiet === '1' || (quiet !== '0' && !!env.HIVE_USER_DATA)
}

/**
 * Whether this copy honours the test seams every test copy is given (HIVE_TEST_NOTIFY_LOG, HIVE_TEST_TRASH_DIR,
 * HIVE_TEST_TIPS): any unpackaged build, and a packaged one only when quiet (HIVE_TEST_QUIET=1: a copy a test started,
 * #1253, #1599). The installed app is never started quiet, so it takes none of them.
 */
export function takesTestSeams(env: NodeJS.ProcessEnv = process.env, packaged = app.isPackaged): boolean {
  return !packaged || testQuiet(env, packaged)
}

/** How far left of every screen a quiet test window's right edge is: well beyond any width a suite gives it. */
const OFF_SCREEN_GAP = 8000

/**
 * Where a quiet test copy opens a window: far left of every screen, so it never covers the user's windows, even when a
 * suite makes it as wide as a screen. It still renders (main turns off Chromium's occlusion tracking for test copies),
 * and the suites drive it through the page.
 */
export function offScreenOrigin(width: number): { x: number; y: number } {
  const displays = screen.getAllDisplays()
  return { x: Math.min(...displays.map((d) => d.bounds.x)) - width - OFF_SCREEN_GAP, y: Math.min(...displays.map((d) => d.bounds.y)) }
}

/** Whether any part of these bounds is on a screen. */
function onAnyScreen(b: Electron.Rectangle): boolean {
  return screen.getAllDisplays().some(({ bounds: d }) => b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y)
}

/** A quiet test copy's window goes straight back off screen whenever a suite moves or resizes part of it onto one. */
export function keepOffScreen(win: BrowserWindow): void {
  const check = (): void => {
    if (win.isDestroyed()) return
    const b = win.getBounds()
    if (!onAnyScreen(b)) return
    const at = offScreenOrigin(b.width)
    win.setPosition(at.x, at.y)
  }
  win.on('move', check)
  win.on('resize', check)
}

/** One line to HIVE_TEST_NOTIFY_LOG, if set (unpackaged builds and quiet packaged ones only). */
export function testNotifyLog(entry: { kind: 'notification' | 'flash' | 'chime' | 'dialog'; title?: string; body?: string; projectPath?: string; on?: boolean }): void {
  const file = takesTestSeams() ? process.env.HIVE_TEST_NOTIFY_LOG : undefined
  if (!file) return
  try {
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
  } catch {
    // A test log that can't be written mustn't break Hive.
  }
}

/**
 * A token this test copy issues (a launch's hook token, an agent's or the Assistant's Agent API token), appended to
 * HIVE_TEST_TOKEN_LOG as `{ kind, token }` when that is set (unpackaged builds and quiet packaged ones only, as the
 * other seams): the scenario harness's leak check knows from it every token a session could have printed, however soon
 * its launch ended and its files went (HI-2262, HR1's rounds 1 and 2). Called where the token is made, before it is kept,
 * written or returned. A record asked for that can't be written throws (naming no token), so nothing is issued that
 * the record lacks; without the variable it does nothing.
 */
export function recordTestToken(kind: 'hook' | 'agent' | 'assistant', token: string): void {
  const file = takesTestSeams() ? process.env.HIVE_TEST_TOKEN_LOG : undefined
  if (!file) return
  try {
    appendFileSync(file, `${JSON.stringify({ kind, token })}\n`)
  } catch (e) {
    // i18n-ignore: a test seam's diagnostic for the test that set HIVE_TEST_TOKEN_LOG, never shown in normal use
    throw new Error(`HIVE_TEST_TOKEN_LOG couldn't be written (${(e as NodeJS.ErrnoException)?.code ?? 'error'}): no ${kind} token issued`, { cause: e })
  }
}

/**
 * Shows a Windows notification, or in a quiet test copy only records it. Returns whether it was shown (so a caller
 * keeps a reference only to one that was).
 */
export function showOsNotification(note: Electron.Notification, title: string, body: string): boolean {
  testNotifyLog({ kind: 'notification', title, body })
  if (testQuiet()) return false
  note.show()
  return true
}

/** Brings a window up for the user: restored, shown and focused; in a quiet test copy, shown without taking focus. */
export function presentWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  if (testQuiet()) {
    win.showInactive()
    return
  }
  win.show()
  win.focus()
}
