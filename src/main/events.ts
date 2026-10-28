import type { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type { HiveEvent, ToastAction, ToastLevel, ToastMessage, ToastTarget } from '../shared/types'

/**
 * Where events and terminal output go. With several windows, each shows one workspace: an event about a
 * project goes to the window showing it, one about the app (settings, updates) to every window. The
 * windows module decides (setEventRouter); until it does, nothing is sent.
 */
export interface EventRouter {
  /** The windows an event is for. */
  forEvent: (event: HiveEvent) => BrowserWindow[]
  /** The windows a terminal's output is for (by its key, e.g. session:<project path>#<agent>). */
  forPty: (key: string) => BrowserWindow[]
}

let router: EventRouter = { forEvent: () => [], forPty: () => [] }
const listeners = new Set<(e: HiveEvent) => void>()

export function setEventRouter(r: EventRouter): void {
  router = r
}

function send(wins: BrowserWindow[], channel: string, ...args: unknown[]): void {
  for (const w of wins) if (!w.isDestroyed()) w.webContents.send(channel, ...args)
}

/** Sends an event to the window(s) it is for and to in-process listeners (e.g. the Agent API event stream). */
export function emit(event: HiveEvent): void {
  send(router.forEvent(event), 'hive:event', event)
  for (const l of listeners) l(event)
}

/** Sends an event to one window (e.g. its own maximized state, or its workspace's changes). */
export function emitTo(win: BrowserWindow, event: HiveEvent): void {
  send([win], 'hive:event', event)
  for (const l of listeners) l(event)
}

/** Tells in-process listeners only (the Agent API's event stream), no window: a notice shown as a Windows notification. */
export function tellListeners(event: HiveEvent): void {
  for (const l of listeners) l(event)
}

export function onHiveEvent(listener: (e: HiveEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function sendPty(channel: 'pty:data' | 'pty:exit', key: string, payload: string | number): void {
  send(router.forPty(key), channel, key, payload)
}

/** A message for the Notifications panel only (the bell's history), not shown as a toast: a notice told by routeAppNotice. */
export function logNotice(level: ToastLevel, title: string, message?: string): ToastMessage {
  const t: ToastMessage = { id: randomUUID(), level, title, message, timestamp: new Date().toISOString(), quiet: true }
  emit({ type: 'toast', toast: t })
  return t
}

/** `target`: what a click on it opens (HI-1961: an agent's pane, a card). */
export function toast(level: ToastLevel, title: string, message?: string, actions?: ToastAction[], source?: string, target?: ToastTarget): ToastMessage {
  const t: ToastMessage = { id: randomUUID(), level, title, message, actions, ...(target ? { target } : {}), source, timestamp: new Date().toISOString() }
  emit({ type: 'toast', toast: t })
  return t
}
