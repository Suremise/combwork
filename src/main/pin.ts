import type { BrowserWindow } from 'electron'
import { config } from './config'

/**
 * Always on Top, per window: a window keeps its pin while it shows a workspace, and the pin is remembered by workspace
 * in Hive's own config.json (a desk preference, so never in the workspace's .hive settings, which travel with it). A
 * window with no workspace, or showing one never pinned, is not on top.
 */
const key = (workspacePath: string): string => workspacePath.toLowerCase()

/** Whether a pin is still remembered under a folder (HI-2007: a moved workspace's old one, still to follow it). */
export const pinKeptAt = (folder: string): boolean => config.get().alwaysOnTop?.[key(folder)] === true

/** Whether the workspace's window was last left on top. */
export function pinnedFor(workspacePath: string | null): boolean {
  return !!workspacePath && config.get().alwaysOnTop?.[key(workspacePath)] === true
}

/** Puts the window on top or not, and remembers it for the workspace it shows (if any). Returns the new state. */
export function setPinned(win: BrowserWindow, workspacePath: string | null, on: boolean): boolean {
  win.setAlwaysOnTop(on)
  if (workspacePath) {
    config.update((c) => {
      const pins = { ...c.alwaysOnTop }
      if (on) pins[key(workspacePath)] = true
      else delete pins[key(workspacePath)]
      c.alwaysOnTop = pins
    })
  }
  return win.isAlwaysOnTop()
}

/**
 * A moved workspace's pin (HI-2007): remembered under its new folder instead of its old one, when `ok()` still holds as
 * config.json is changed (the same synchronous step). Returns whether it moved.
 */
export function carryPin(from: string, to: string, ok: () => boolean = () => true): boolean {
  let pinned = false
  config.update((c) => {
    if (c.alwaysOnTop?.[key(from)] !== true || !ok()) return
    const pins = { ...c.alwaysOnTop }
    delete pins[key(from)]
    pins[key(to)] = true
    c.alwaysOnTop = pins
    pinned = true
  })
  return pinned
}

/**
 * Keeps the window's pin with the workspace it shows: called whenever the workspace may have changed, it applies the
 * workspace's remembered pin once per workspace (so a pin set meanwhile isn't undone). Returns whether it changed.
 */
export function pinFollower(win: BrowserWindow): (workspacePath: string | null) => boolean {
  // A new window shows no workspace yet (the welcome page, or one about to open): only a real change of its own
  // workspace applies a remembered pin, so another window's workspace events never undo a pin set here meanwhile.
  let shown: string | null = null
  return (workspacePath) => {
    const now = workspacePath ? key(workspacePath) : null
    if (now === shown || win.isDestroyed()) return false
    shown = now
    const on = pinnedFor(workspacePath)
    if (win.isAlwaysOnTop() === on) return false
    win.setAlwaysOnTop(on)
    return true
  }
}
