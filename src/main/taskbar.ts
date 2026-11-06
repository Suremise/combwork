import type { BrowserWindow } from 'electron'
import { asksYou } from '../shared/inbox'
import { shouldFlash } from '../shared/taskbar'
import { config } from './config'
import { onCombworkEvent } from './events'
import { testNotifyLog, testQuiet } from './testQuiet'
import { windowForPath } from './windows'

/**
 * Flashes a window's taskbar button when one of its agents comes to ask you something while the window isn't
 * focused (Settings → Notifications). It stops when the window is focused or closed, or the setting is turned off.
 * The badge and title count are the window's own (renderer, from its attention inbox). Returns the unsubscribe.
 */
/** Starts or stops a window's taskbar flash; a quiet test copy only records it (testQuiet). */
function setFlash(win: BrowserWindow, on: boolean): void {
  testNotifyLog({ kind: 'flash', on })
  if (!testQuiet()) win.flashFrame(on)
}

export function startTaskbarFlash(): () => void {
  const last = new Map<string, boolean>()
  /** Windows whose button flashes now, and what stops it (one focus and one close listener each). */
  const flashing = new Map<BrowserWindow, () => void>()
  const flash = (win: BrowserWindow): void => {
    setFlash(win, true)
    if (flashing.has(win)) return
    const stop = (): void => {
      if (!flashing.delete(win)) return
      win.removeListener('focus', stop)
      win.removeListener('closed', stop)
      if (!win.isDestroyed()) setFlash(win, false)
    }
    flashing.set(win, stop)
    win.once('focus', stop)
    win.once('closed', stop)
  }
  return onCombworkEvent((e) => {
    if (e.type === 'settings-changed') {
      if (!e.settings.notifications.flashOnWaiting) for (const stop of [...flashing.values()]) stop()
      return
    }
    if (e.type === 'session-exit') last.delete(`${e.projectPath.toLowerCase()}#${e.agentId}`)
    if (e.type !== 'session-status') return
    const key = `${e.state.projectPath.toLowerCase()}#${e.state.agentId}`
    const before = last.get(key)
    const asked = asksYou(e.state)
    last.set(key, asked)
    const win = windowForPath(e.state.projectPath)?.win
    if (!win || win.isDestroyed()) return
    if (shouldFlash(!!before, asked, win.isFocused(), config.settings.notifications.flashOnWaiting)) flash(win)
  })
}
