import { randomUUID } from 'crypto'
import { Notification, type BrowserWindow } from 'electron'
import { kindOfLevel, notifyRoute, toldWhenAway, type FocusedCombwork, type NotifyRoute } from '../shared/notify'
import type { Notice, NotifyKind, ToastAction, ToastLevel, ToastMessage, ToastTarget } from '../shared/types'
import type { TextPart } from '../shared/advanced'
import { config } from './config'
import { emit, emitTo, setToastTeller, tellListeners } from './events'
import { createLogger, userText } from './logger'
import { notificationIcon } from './paths'
import { presentWindow, showOsNotification, testNotifyLog } from './testQuiet'

const log = createLogger('notify')

/**
 * Combwork's one way to tell the user something from main (HI-2320): `tell()` routes an entry once (shared/notify.ts
 * notifyRoute), picks the one window that owns it, and sends it there alone, as a pop-up (kept in that window's bell),
 * a quiet bell row beside a Windows notification, or a bell row only. Entries with buttons are registered under their
 * offer, so taking or losing that offer resolves exactly them (`resolveOffer`), never a newer offer's.
 */

/** What tell() needs of the windows, given by index.ts (windows.ts and workspace.ts would make a cycle here). */
export interface NotifyHost {
  /** The Combwork window the user is using (visible, not minimised, focused), or null with Combwork in the background. */
  focused: () => (FocusedCombwork & { win: BrowserWindow }) | null
  /** The window to own an entry when none is focused: the one showing its project's workspace, else the last focused. */
  fallback: (projectPath: string | null, source?: string) => BrowserWindow | null
  /** The workspace a project belongs to, for the pop-up scope. */
  workspaceOf: (projectPath: string) => string | null
  /** A project's folder as its workspace has it, when `path` is one (a toast's source: its link), else null. */
  projectAt?: (path: string) => string | null
  /** The Combwork window whose IPC request is being served now, or null (HI-2355: ipc.ts requestingWindow). */
  requester?: () => BrowserWindow | null
}

let host: NotifyHost = { focused: () => null, fallback: () => null, workspaceOf: () => null }

export function setNotifyHost(h: NotifyHost): void {
  host = h
}

export function focusedCombwork(): (FocusedCombwork & { win: BrowserWindow }) | null {
  return host.focused()
}

export interface TellSpec {
  kind: NotifyKind
  /** Its look (icon, colour); by default from its kind. */
  level?: ToastLevel
  /** In the language Combwork shows. */
  title: string
  message?: string
  /** The title in English, for the Agent API's stream (#796), when `title` is translated. */
  apiTitle?: string
  /** The title's text as data: the stream says it again in each client's dialect (HI-2465). Its English is `apiTitle` (or `title`). */
  apiTitleText?: TextPart
  /** The project it is about (null: Combwork-wide): its scope, its owner window when none is focused, and its link. */
  projectPath?: string | null
  /** The agent it is about, for the Agent API's stream and its link. */
  agentId?: string
  /** What a click opens; by default the project, when it has one. */
  target?: ToastTarget
  actions?: ToastAction[]
  /** The offer its buttons act on (e.g. `leftovers:<runIds>`): resolveOffer() resolves exactly this entry. */
  offer?: string
  /** A stable id, for an entry a newer one replaces (a project's platform notice). */
  id?: string
  timeoutMs?: number
  source?: string
  /** A Windows notification's own click (the default shows its owner window and opens its target). */
  onWindowsClick?: () => void
}

/** Where an entry went, and its id. */
export interface Told {
  id: string
  route: NotifyRoute
  /** The entry as the window got it (none when routed nowhere). */
  entry?: ToastMessage
}

const DEFAULT_LEVEL: Record<NotifyKind, ToastLevel> = { needsYou: 'info', finished: 'success', work: 'info', usage: 'warning', warning: 'warning', result: 'info', transcript: 'warning', update: 'info', quit: 'info', tip: 'info' } // i18n-ignore: levels, not text

/** The kinds that answer the request they were made in (HI-2355): Combwork's own messages, told in the window that asked. */
const ANSWERS_REQUESTS: ReadonlySet<NotifyKind> = new Set(['result', 'warning'])

/** The Agent API's kind for an entry it hears of (#620: finished, waiting, or another notice). */
const apiKind = (k: NotifyKind): Notice['kind'] => (k === 'needsYou' ? 'waiting' : k === 'finished' ? 'finished' : 'notice')

/** Kept, so a garbage-collected Notification still delivers its click. */
const shownNotifications = new Set<Electron.Notification>()

/** Each offer's entries, oldest first; at most MAX_OFFERS are kept (the oldest let go: its entries' buttons stay as they were). */
const offers = new Map<string, { ids: Set<string>; owner: number | null }>()
const MAX_OFFERS = 300

/**
 * Tells the user (HI-2320): routed once, owned by one window, sent there alone. Owner: the window the user is using,
 * whatever workspace it shows (a click opens the target where it is); with none focused, the one showing the entry's
 * workspace, else the last focused. The Agent API's stream hears of the kinds it always did.
 */
export function tell(spec: TellSpec): Told {
  const at = host.focused()
  const projectPath = spec.projectPath ?? null
  const workspacePath = projectPath ? host.workspaceOf(projectPath) : null
  const { route, why } = notifyRoute(config.settings.notifications, spec.kind, at, { workspacePath, projectPath })
  const id = spec.id ?? randomUUID()
  // i18n-ignore: the log (English)
  if (spec.kind !== 'result' && spec.kind !== 'warning') log.info(`Notice ${spec.kind} told: ${route} (${why}) (${userText(spec.title)})`)
  if (route === 'none') return { id, route }
  // Its link (HI-2320: every entry about something opens it): as given, else its project, else the project its source
  // names (main's toast() passes the project's folder as its source).
  const sourceProject = !projectPath && spec.source && /[\\/]/.test(spec.source) ? (host.projectAt?.(spec.source) ?? null) : null
  const linked = projectPath ?? sourceProject
  const target = spec.target ?? (linked ? { kind: 'project' as const, projectPath: linked, project: projectName(linked) } : undefined)
  // Its owner (s19's rules): Combwork's own result or warning answering a window's request goes to that window, even if
  // another has the focus by then (HI-2355); otherwise the window in use; with none, its workspace's (or source's).
  // Agents' kinds never follow a request: a request's context can carry into later callbacks (a session it started).
  const requester = ANSWERS_REQUESTS.has(spec.kind) ? (host.requester?.() ?? null) : null
  const owner = requester ?? at?.win ?? host.fallback(projectPath, spec.source)
  const entry: ToastMessage = {
    id,
    kind: spec.kind,
    level: spec.level ?? DEFAULT_LEVEL[spec.kind],
    title: spec.title,
    ...(spec.message ? { message: spec.message } : {}),
    ...(spec.actions?.length ? { actions: spec.actions } : {}),
    ...(target ? { target } : {}),
    ...(spec.offer ? { offer: spec.offer } : {}),
    ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.source ? { source: spec.source } : {}),
    ...(route === 'popup' ? {} : { quiet: true }),
    timestamp: new Date().toISOString()
  }
  testNotifyLog({ kind: 'entry', id, notifyKind: spec.kind, route, title: spec.title, owner: owner && !owner.isDestroyed() ? owner.webContents.id : null })
  if (spec.offer) register(spec.offer, id, owner)
  if (toldWhenAway(spec.kind)) {
    const notice: Notice = { id, kind: apiKind(spec.kind), title: spec.title, ...(spec.apiTitle && spec.apiTitle !== spec.title ? { apiTitle: spec.apiTitle } : {}), ...(spec.apiTitleText !== undefined ? { apiTitleText: spec.apiTitleText } : {}), body: spec.message ?? '', projectPath, ...(spec.agentId ? { agentId: spec.agentId } : {}) }
    tellListeners({ type: 'notice', notice, ...(route === 'windows' ? { windows: true as const } : {}) })
  }
  // Combwork has closed: its windows are closing, so a Windows notification alone. No window to own it (none open yet): the
  // event router's choice, as before.
  if (spec.kind !== 'quit') {
    if (owner && !owner.isDestroyed()) emitTo(owner, { type: 'toast', toast: entry })
    else emit({ type: 'toast', toast: entry })
  }
  if (route === 'windows') showWindows(entry, projectPath, spec)
  return { id, route, entry }
}

function projectName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/** The Windows notification (HI-2320: only with no Combwork window focused): its click shows its owner window and opens its target. */
function showWindows(entry: ToastMessage, projectPath: string | null, spec: TellSpec): void {
  if (!Notification.isSupported()) return
  // Agents' notices chime in the window (or not, per the chime settings): their Windows notification is silent.
  const note = new Notification({ title: entry.title, body: entry.message ?? '', silent: entry.kind !== 'usage', icon: notificationIcon() })
  shownNotifications.add(note)
  if (shownNotifications.size > 50) shownNotifications.delete(shownNotifications.values().next().value!)
  note.on('click', () => {
    shownNotifications.delete(note)
    if (spec.onWindowsClick) return spec.onWindowsClick()
    const w = host.fallback(projectPath, spec.source)
    if (!w || w.isDestroyed()) return
    presentWindow(w)
    if (entry.target) emitTo(w, { type: 'menu-command', command: 'notice.openTarget', args: [entry.target] })
  })
  if (!showOsNotification(note, entry.title, entry.message ?? '')) shownNotifications.delete(note)
}

function register(offer: string, id: string, owner: BrowserWindow | null): void {
  const o = offers.get(offer) ?? { ids: new Set<string>(), owner: owner && !owner.isDestroyed() ? owner.webContents.id : null }
  o.ids.add(id)
  offers.delete(offer)
  offers.set(offer, o)
  while (offers.size > MAX_OFFERS) offers.delete(offers.keys().next().value!)
}

/** Whether an offer still has an entry that isn't resolved (its buttons shown). */
export function offerOpen(offer: string): boolean {
  return offers.has(offer)
}

/**
 * The offer was taken, or no longer applies: its entries (in whichever window) lose their buttons and say `outcome`.
 * Only that offer's: a newer offer for the same agent has another key. Returns whether it had any.
 */
export function resolveOffer(offer: string, outcome: string): boolean {
  const o = offers.get(offer)
  if (!o) return false
  offers.delete(offer)
  emit({ type: 'toast-resolved', ids: [...o.ids], outcome })
  return true
}

/**
 * One of an offer's buttons is done, or no longer applies, while its others still do (HI-2320: an entry with independent
 * buttons): those commands' buttons go from its entries, and `note` says what happened. The offer stays open.
 */
export function dropOfferActions(offer: string, commands: string[], note: string): boolean {
  const o = offers.get(offer)
  if (!o) return false
  emit({ type: 'toast-update', ids: [...o.ids], drop: commands, note })
  return true
}

/** Resolves every open offer whose key `match` picks (e.g. all of an agent's asks once it no longer asks). */
export function resolveOffers(match: (offer: string) => boolean, outcome: string): number {
  let n = 0
  for (const k of [...offers.keys()]) if (match(k) && resolveOffer(k, outcome)) n++
  return n
}

/** A window closed: the offers only it held are let go (their entries went with it), and buttons it ran for others end. */
export function forgetOwner(webContentsId: number): void {
  for (const [k, o] of offers) if (o.owner === webContentsId) offers.delete(k)
  for (const p of [...runningActions.values()]) if (p.win === webContentsId) p.done(NOTICE_ACTION_UNFINISHED)
}

/** Entries' buttons run in another window (notice:action), until that window says they have finished. */
const runningActions = new Map<string, { win: number; done: (error: string | null) => void }>()

/** The longest an entry's button waits for the window that runs it (HI-2320, the Assistant's scope for round 3). */
export const NOTICE_ACTION_MS = 30_000

/** Why an entry's button run elsewhere didn't finish: its window didn't say so in time, reloaded, or went. */
export const NOTICE_ACTION_UNFINISHED = 'unfinished'

/**
 * Runs an entry's button in `win` (the window that has its project) and resolves once its command there has finished
 * (HI-2320: the button's spinner lasts that long, wherever it runs). Bounded (NOTICE_ACTION_MS), and cancelled if that
 * window reloads or navigates, its renderer goes, or it closes: then it rejects with NOTICE_ACTION_UNFINISHED, never
 * passing for done. Only that window's own reply finishes it (noticeActionDone checks the sender).
 */
export function noticeActionIn(win: BrowserWindow, command: string, args: unknown[], waitMs = NOTICE_ACTION_MS): Promise<void> {
  const reply = randomUUID()
  const wc = win.webContents
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(NOTICE_ACTION_UNFINISHED), waitMs)
    timer.unref?.()
    const cancel = (): void => finish(NOTICE_ACTION_UNFINISHED)
    const events = ['did-start-navigation', 'render-process-gone', 'destroyed'] as const
    for (const e of events) wc.once(e as never, cancel)
    const finish = (error: string | null): void => {
      if (!runningActions.has(reply)) return
      runningActions.delete(reply)
      clearTimeout(timer)
      for (const e of events) wc.removeListener(e as never, cancel)
      if (error) reject(new Error(error))
      else resolve()
    }
    runningActions.set(reply, { win: wc.id, done: finish })
    emitTo(win, { type: 'menu-command', command, args, reply })
  })
}

/** The window that ran an entry's button says it has finished: only the one it was sent to (`from`, its webContents id). */
export function noticeActionDone(reply: string, error: string | null, from: number): void {
  const p = runningActions.get(reply)
  if (!p || p.win !== from) return
  p.done(error)
}

/** For tests: how many entries' buttons wait for another window. */
export const noticeActionsWaiting = (): number => runningActions.size

const askSeq = new Map<string, number>()
const askKey = (projectPath: string, agentId: string): string => `ask:${projectPath.toLowerCase()}#${agentId}#`

/**
 * A waiting agent's new ask (HI-2320): its own offer, `ask:<project>#<agent>#<n>`, so an older ask's resolution never
 * touches it. The agent no longer asking resolves every ask it made (resolveAsks).
 */
export function askOffer(projectPath: string, agentId: string): string {
  const k = askKey(projectPath, agentId)
  const n = (askSeq.get(k) ?? 0) + 1
  askSeq.set(k, n)
  return `${k}${n}`
}

/** The agent no longer asks (answered, moved on, stopped): the entries of its asks so far say `outcome`. */
export function resolveAsks(projectPath: string, agentId: string, outcome: string): number {
  const k = askKey(projectPath, agentId)
  return resolveOffers((o) => o.startsWith(k), outcome)
}

/** How many finishes wait to be told together (HI-2320: the window holds a tip back while some do). */
export function notifyPending(finishes: number): void {
  emit({ type: 'notify-pending', finishes })
}

/** For tests. */
export function resetOffers(): void {
  offers.clear()
  askSeq.clear()
}

// main's toast() (events.ts) is told here: Combwork's own messages by their level; `source` (a path) names the window
// that owns one when none is focused. (A unit test's mock of events.ts may leave it out: toast() then sends as before.)
const installTeller = (): void => setToastTeller((t) =>
  tell({
    kind: kindOfLevel(t.level),
    level: t.level,
    title: t.title,
    message: t.message,
    actions: t.actions,
    target: t.target,
    source: t.source,
    offer: t.offer,
    timeoutMs: t.timeoutMs,
    id: t.id
  })
)
try {
  installTeller()
} catch {
  // events.ts mocked without it (unit tests).
}
