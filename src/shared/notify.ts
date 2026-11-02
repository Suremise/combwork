/**
 * One notification system (HI-2320): every message Hive shows is one entry, of one kind, routed once by the table
 * below, to a pop-up in one window (kept in that window's bell), a Windows notification (its bell row kept quietly), the
 * bell only, or nowhere. No path makes a second copy: main's tell() (main/notify.ts) and the window's pushToast are the
 * only two ways in, and an entry is one id.
 */

import type { AppSettings, NotifyKind, ToastLevel, ToastMessage } from './types'

export type { NotifyKind }

/** Where an entry goes: a pop-up (and its window's bell), a Windows notification (and a quiet bell row), the bell alone, or nowhere. */
export type NotifyRoute = 'popup' | 'windows' | 'bell' | 'none'

/** The Hive window you are using: the workspace it holds and the project it shows. */
export interface FocusedHive {
  workspacePath: string | null
  projectPath: string | null
}

type Gates = Pick<AppSettings['notifications'], 'desktopNotifications' | 'notifyOnFinished' | 'notifyOnWaiting' | 'bannerScope'>

/** The kinds Windows notifications are for while no Hive window is focused, and the Agent API's stream hears of. */
const AWAY: ReadonlySet<NotifyKind> = new Set(['needsYou', 'finished', 'work', 'usage', 'quit'])
/** The kinds Settings → Notifications' master switch (`desktopNotifications`) turns off. */
const GATED: ReadonlySet<NotifyKind> = AWAY
/** The kinds *Show pop-ups about agents for* (`bannerScope`) applies to. */
const SCOPED: ReadonlySet<NotifyKind> = new Set(['needsYou', 'finished', 'work'])

/** Whether a kind goes to Windows notifications while Hive is in the background (else it waits in its window). */
export const toldWhenAway = (kind: NotifyKind): boolean => AWAY.has(kind)

const samePath = (a: string | null, b: string | null): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/**
 * Where an entry goes now (the truth table of SPEC §14 Notifications; first match wins):
 * 1. The master switch off: nowhere for the agent kinds, usage and quit; Hive's own messages still pop up.
 * 2. That kind off (finished, needs you): nowhere.
 * 3. No Hive window focused: a Windows notification for the agent kinds, usage and quit; the rest pop up in their
 *    window, their clock paused until it is focused. A tip waits for a quiet moment instead.
 * 4. A window focused: Hive has closed has nowhere to go; the agent kinds left out by the scope (*Only in the bell*,
 *    another workspace's, another project's) go to the bell only; everything else pops up. A notice about no project
 *    passes every scope.
 * Chimes are not routed: they follow the chime settings whatever the route.
 */
export function notifyRoute(n: Gates, kind: NotifyKind, focused: FocusedHive | null, from: { workspacePath: string | null; projectPath: string | null }): { route: NotifyRoute; why: string } {
  if (GATED.has(kind) && !n.desktopNotifications) return { route: 'none', why: 'notifications off' } // i18n-ignore: the log's reason (English)
  if (kind === 'finished' && !n.notifyOnFinished) return { route: 'none', why: 'finished notices off' } // i18n-ignore: the log's reason (English)
  if (kind === 'needsYou' && !n.notifyOnWaiting) return { route: 'none', why: 'waiting notices off' } // i18n-ignore: the log's reason (English)
  if (!focused) return AWAY.has(kind) ? { route: 'windows', why: 'no Hive window focused' } : { route: 'popup', why: 'no Hive window focused: waits in its window' } // i18n-ignore: the log's reason (English)
  if (kind === 'quit') return { route: 'none', why: 'Hive has closed: no window to show it' } // i18n-ignore: the log's reason (English)
  if (!SCOPED.has(kind)) return { route: 'popup', why: 'Hive focused' } // i18n-ignore: the log's reason (English)
  if (!from.projectPath && !from.workspacePath) return { route: 'popup', why: 'about no project' } // i18n-ignore: the log's reason (English)
  if (n.bannerScope === 'none') return { route: 'bell', why: 'pop-up scope: only in the bell' } // i18n-ignore: the log's reason (English)
  if (n.bannerScope === 'workspace' && !samePath(focused.workspacePath, from.workspacePath)) return { route: 'bell', why: "pop-up scope: another workspace's" } // i18n-ignore: the log's reason (English)
  if (n.bannerScope === 'project' && !samePath(focused.projectPath, from.projectPath)) return { route: 'bell', why: "pop-up scope: another project's" } // i18n-ignore: the log's reason (English)
  return { route: 'popup', why: `pop-up scope: ${n.bannerScope}` } // i18n-ignore: the log's reason (English)
}

/** A message's kind from its level, for those raised by level alone (the window's notify(), hive_notify, main's toast()). */
export const kindOfLevel = (level: ToastLevel): NotifyKind => (level === 'warning' || level === 'error' ? 'warning' : 'result')

/** An entry's kind: its own, else from its level. */
export const kindOf = (t: Pick<ToastMessage, 'kind' | 'level'>): NotifyKind => t.kind ?? kindOfLevel(t.level)

/** How many pop-ups show at once (more are behind "+N more"), and how many that close by themselves are kept. */
export const MAX_POPUPS = 4
/** The least time a pop-up with live buttons, or an error, stays (ms). */
export const LONG_POPUP_MS = 15_000

/** Whether a pop-up stays until handled: one that needs you (unless set to close like the others), or a tip. */
export function staysUntilHandled(t: Pick<ToastMessage, 'kind' | 'level' | 'resolved'>, waitingStays: boolean): boolean {
  const kind = kindOf(t)
  if (kind === 'tip') return true
  return kind === 'needsYou' && waitingStays && !t.resolved
}

/**
 * How long a pop-up that closes by itself stays (ms): its own time, else the setting's, longer for an error or live
 * buttons. Its own time is for answering it: once resolved (its outcome shown), the setting's (HI-2370: Don't Resume's
 * outcome stayed the offer's 2 minutes over the window).
 */
export function popupMs(t: Pick<ToastMessage, 'level' | 'actions' | 'timeoutMs' | 'resolved'>, seconds: number): number {
  if (t.timeoutMs && !t.resolved) return t.timeoutMs
  const base = Math.max(2, seconds) * 1000
  return t.level === 'error' || (!!t.actions?.length && !t.resolved) ? Math.max(base, LONG_POPUP_MS) : base
}

/** Announced at once (alert) or politely (status). */
export const popupRole = (t: Pick<ToastMessage, 'kind' | 'level'>): 'alert' | 'status' => (kindOf(t) === 'needsYou' || t.level === 'error' ? 'alert' : 'status')

/**
 * The pop-ups a window keeps, newest first: every one that stays until handled, however many, and the newest `max` of
 * the rest. A new one never pushes out one that waits for you.
 */
export function keepPopups<T>(newestFirst: readonly T[], stays: (t: T) => boolean, max = MAX_POPUPS): T[] {
  let others = 0
  return newestFirst.filter((t) => stays(t) || others++ < max)
}

/** The bell keeps this many entries per window, newest first. */
export const BELL_MAX = 100
