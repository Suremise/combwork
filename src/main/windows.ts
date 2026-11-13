import type { BrowserWindow, WebContents } from 'electron'
import type { CombworkEvent, QuitChoice, QuitScope, QuitSession } from '../shared/types'
import type { InstallOffer } from './updateConsent'
import { setEventRouter } from './events'
import { samePlace } from './fsutil'
import { forgetWindowViews } from './transcriptReads'
import { forgetOwner } from './notify'
import { contextWorkspace, setWorkspaceFallback, workspaceFor, type WorkspaceService } from './workspace'

/**
 * Combwork's windows, like VS Code's: each shows one workspace (or the welcome page), all in one app process,
 * so settings, the Agent API, the tray, updates and file locks stay single. This module keeps track of
 * them and decides which window each event and terminal's output goes to.
 */

/** The window buttons' height: the title bar's (34 px) less its bottom border, which would otherwise stop short of them. */
export const TITLE_BAR_OVERLAY = 33

export interface CombworkWindow {
  win: BrowserWindow
  ws: WorkspaceService
  /** Files with unsaved edits in this window (reported by its page). */
  unsaved: string[]
  focusedAt: number
  /** A quit or close question shown in this window, waiting for the answer. */
  /** `update`: the update it offers to install now (HI-3167); `answer`'s `install`, the version Install now was chosen for. */
  question: { request: QuitSession[]; unsaved: string[]; scope: QuitScope; update: InstallOffer | null; answer: (c: QuitChoice, install: string | null) => void } | null
  /** Closing was decided: let the window close. */
  closing: boolean
  /** The project its page shows (reported by the page): for banners shown for "This project" (#157). */
  showing: string | null
}

const entries = new Map<number, CombworkWindow>()

export function registerWindow(win: BrowserWindow, ws: WorkspaceService): CombworkWindow {
  const e: CombworkWindow = { win, ws, unsaved: [], focusedAt: Date.now(), question: null, closing: false, showing: null }
  entries.set(win.webContents.id, e)
  ws.window = win
  win.on('focus', () => (e.focusedAt = Date.now()))
  return e
}

export function unregisterWindow(e: CombworkWindow): void {
  for (const [k, v] of entries) {
    if (v !== e) continue
    entries.delete(k)
    forgetWindowViews(k)
    // The offers of entries only it held went with it (HI-2320).
    forgetOwner(k)
  }
  e.ws.window = null
}

/** Every window, in the order they were opened. */
export function combworkWindows(): CombworkWindow[] {
  return [...entries.values()].filter((e) => !e.win.isDestroyed())
}

export function windowOf(sender: WebContents): CombworkWindow | null {
  return entries.get(sender.id) ?? null
}

/** The window used when nothing says which: the one focused last. */
export function lastFocused(): CombworkWindow | null {
  return combworkWindows().sort((a, b) => b.focusedAt - a.focusedAt)[0] ?? null
}

/** The window showing a workspace folder, if one is. */
export function windowShowing(path: string): CombworkWindow | null {
  // By real paths: the folder by another name (an 8.3 short name, a junction) is the same workspace (#455).
  return combworkWindows().find((e) => !!e.ws.path && samePlace(e.ws.path, path)) ?? null
}

/** The window showing the workspace a project (or worktree) path belongs to. */
export function windowForPath(p: string): CombworkWindow | null {
  const ws = workspaceFor(p)
  return ws ? (combworkWindows().find((e) => e.ws === ws) ?? null) : null
}

const wins = (list: (CombworkWindow | null)[]): BrowserWindow[] => list.filter((e): e is CombworkWindow => !!e && !e.win.isDestroyed()).map((e) => e.win)

function inContext(): CombworkWindow | null {
  const ws = contextWorkspace()
  return ws ? (combworkWindows().find((e) => e.ws === ws) ?? null) : null
}

function forEvent(e: CombworkEvent): BrowserWindow[] {
  const all = combworkWindows()
  switch (e.type) {
    case 'session-status':
      return wins([windowForPath(e.state.projectPath)])
    case 'session-exit':
    case 'chime':
    case 'usage-changed':
    case 'files-changed':
    case 'assistant-activity':
    case 'assistant-questions':
    case 'agent-added':
    case 'agent-start':
    case 'branch-status':
    case 'session-bulk':
      return wins([windowForPath(e.projectPath)])
    case 'agent-leftovers':
      return wins([windowForPath(e.leftovers.projectPath)])
    case 'tasks-changed':
    case 'journal-changed':
      return wins([windowForPath(e.workspacePath)])
    case 'progress-runs':
      return wins([windowShowing(e.workspacePath)])
    case 'workspace-changed':
    case 'skills-changed':
    case 'notes-changed': {
      // From a window's request: that window. From elsewhere (the Agent API, a timer): every window refreshes.
      const w = inContext()
      return w ? wins([w]) : wins(all)
    }
    case 'toast':
    case 'menu-command': {
      const source = e.type === 'toast' ? e.toast.source : undefined
      const bySource = source && /[\\/]/.test(source) ? windowForPath(source) : null
      return wins([inContext() ?? bySource ?? lastFocused()])
    }
    case 'window-state':
    case 'quit-request':
    case 'notice':
      // Sent to one window by emitTo.
      return []
    default:
      // Settings, providers, plan usage, updates, a pending quit: every window.
      return wins(all)
  }
}

function forPty(key: string): BrowserWindow[] {
  // session:<project path>#<agent id>: the window showing that project. Other terminals (Provider Setup's
  // tasks) go to every window; only the one that started the task shows it.
  const m = /^session:(.+)#[^#]+$/.exec(key)
  return m ? wins([windowForPath(m[1])]) : wins(combworkWindows())
}

setEventRouter({ forEvent, forPty })
setWorkspaceFallback(() => lastFocused()?.ws ?? null)
