import type { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type { CombworkEvent, ToastAction, ToastLevel, ToastMessage, ToastTarget } from '../shared/types'

/**
 * Where events and terminal output go. With several windows, each shows one workspace: an event about a
 * project goes to the window showing it, one about the app (settings, updates) to every window. The
 * windows module decides (setEventRouter); until it does, nothing is sent.
 */
export interface EventRouter {
  /** The windows an event is for. */
  forEvent: (event: CombworkEvent) => BrowserWindow[]
  /** The windows a terminal's output is for (by its key, e.g. session:<project path>#<agent>). */
  forPty: (key: string) => BrowserWindow[]
}

let router: EventRouter = { forEvent: () => [], forPty: () => [] }
const listeners = new Set<(e: CombworkEvent) => void>()

export function setEventRouter(r: EventRouter): void {
  router = r
}

function send(wins: BrowserWindow[], channel: string, ...args: unknown[]): void {
  for (const w of wins) if (!w.isDestroyed()) w.webContents.send(channel, ...args)
}

/** Sends an event to the window(s) it is for and to in-process listeners (e.g. the Agent API event stream). */
export function emit(event: CombworkEvent): void {
  send(router.forEvent(event), 'cw:event', event)
  for (const l of listeners) l(event)
}

/** Sends an event to one window (e.g. its own maximized state, or its workspace's changes). */
export function emitTo(win: BrowserWindow, event: CombworkEvent): void {
  send([win], 'cw:event', event)
  for (const l of listeners) l(event)
}

/** Tells in-process listeners only (the Agent API's event stream), no window: a notice shown as a Windows notification. */
export function tellListeners(event: CombworkEvent): void {
  for (const l of listeners) l(event)
}

export function onCombworkEvent(listener: (e: CombworkEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function sendPty(channel: 'pty:data' | 'pty:exit', key: string, payload: string | number): void {
  send(router.forPty(key), channel, key, payload)
}

/** What toast() hands its message to: main/notify.ts tell() (HI-2320: one way to tell the user), set as it loads. */
export type ToastTeller = (t: { level: ToastLevel; title: string; message?: string; actions?: ToastAction[]; source?: string; target?: ToastTarget; offer?: string; timeoutMs?: number; id?: string }) => { id: string; entry?: ToastMessage }

let teller: ToastTeller | null = null

export function setToastTeller(t: ToastTeller): void {
  teller = t
}

/**
 * Combwork's own message, by its level (warning or error: a warning, else a result; shared/notify.ts), told by tell():
 * a pop-up in the window the user is using, else in the one `source` (a path) names, else the last focused.
 * `target`: what a click on it opens (HI-1961: an agent's pane, a card). `offer`: what its buttons act on, so taking
 * or losing it resolves this entry alone (main/notify.ts resolveOffer). Returns it (nothing shown when routed nowhere).
 */
export function toast(level: ToastLevel, title: string, message?: string, actions?: ToastAction[], source?: string, target?: ToastTarget, extra?: { offer?: string; timeoutMs?: number; id?: string }): ToastMessage {
  if (teller) {
    const told = teller({ level, title, message, actions, source, target, ...extra })
    return told.entry ?? { id: told.id, level, title, message, actions, ...(target ? { target } : {}), source, timestamp: new Date().toISOString() }
  }
  // Before notify.ts has loaded (never in Combwork itself): straight to the windows.
  const t: ToastMessage = { id: extra?.id ?? randomUUID(), level, title, message, actions, ...(target ? { target } : {}), source, timestamp: new Date().toISOString() }
  emit({ type: 'toast', toast: t })
  return t
}
