import { msg, tr } from '../shared/i18n'
import { APP_NAME } from '../shared/appName'
import { basename, join } from 'path'
import { app, BrowserWindow, nativeTheme, screen, shell, type WebContents } from 'electron'
import type { CombworkEvent, WindowState } from '../shared/types'
import { config } from './config'
import { onCombworkEvent } from './events'
import { keepOffScreen, offScreenOrigin, testQuiet } from './testQuiet'
import { resourcesDir } from './tray'
import type { CombworkWindow } from './windows'
import { placeOnDisplay } from './windowBounds'

/**
 * The developer console's window (#366, #637): its own window like Chrome DevTools, so it can go on a second screen, one
 * per Hive window and on the workspace that window showed when it opened. It calls only the console's channels (ipc.ts),
 * closes with the window that opened it or when that window leaves its workspace (another opens in it, or it closes), and
 * remembers its size and position.
 */

const consoles = new Map<CombworkWindow, BrowserWindow>()
/** A console window's page → the Hive window it belongs to. */
const owners = new Map<number, CombworkWindow>()
/** Each console's workspace (lower case): the one its owner showed when it opened. */
const workspaces = new Map<BrowserWindow, string>()

const workspaceKey = (path: string | null | undefined): string => (path ?? '').toLowerCase()

let following = false
/** Closes a console whose owner no longer shows its workspace: its capture and its list end with it. */
function followWorkspaces(): void {
  if (following) return
  following = true
  onCombworkEvent((e) => {
    if (e.type !== 'workspace-changed') return
    for (const [owner, win] of consoles) {
      if (!win.isDestroyed() && workspaceKey(owner.ws.path) !== workspaces.get(win)) win.destroy()
    }
  })
}

const DEFAULT_BOUNDS: WindowState = { width: 1100, height: 720, maximized: false }

/**
 * The IPC channels a console window may call: its sources, options, subscription and recording, the settings for its
 * theme, the app's info for its language (#1104: without it, the console showed English in every language), and the
 * flight recorder's captures (#698).
 */
export const CONSOLE_WINDOW_CHANNELS: ReadonlySet<string> = new Set(['console:sources', 'console:options', 'console:subscribe', 'console:snapshot', 'console:record', 'console:stopRecording', 'console:recordings', 'console:showRecording', 'console:captures', 'settings:get', 'app:info'])

/** The Hive window a console window's page belongs to. */
export function consoleOwner(sender: WebContents): CombworkWindow | null {
  return owners.get(sender.id) ?? null
}

/** The console window open for a Hive window. */
export function consoleWindowOf(owner: CombworkWindow): BrowserWindow | null {
  const w = consoles.get(owner)
  return w && !w.isDestroyed() ? w : null
}

function dark(): boolean {
  const t = config.settings.appearance.theme
  return t === 'dark' || (t === 'system' && nativeTheme.shouldUseDarkColors)
}

/** The smallest a console window can be. */
const CONSOLE_MIN = { width: 560, height: 320 }

/** Opens the Hive window's console on its workspace, or brings it forward when it is open. */
export function openConsoleWindow(owner: CombworkWindow): BrowserWindow {
  if (!owner.ws.path) throw new Error(tr(msg({ id: 'main.console.noWorkspace', defaultMessage: "Open a workspace first: the developer console shows a workspace's agents and Combwork's work there.", description: 'An error when the developer console is opened with no workspace open.' })))
  followWorkspaces()
  const open = consoleWindowOf(owner)
  if (open) {
    if (open.isMinimized()) open.restore()
    // A quiet test copy never takes the focus (testQuiet).
    if (testQuiet()) open.showInactive()
    else open.focus()
    return open
  }
  // Fitted to the display it opens on, as Hive's windows are (#862): saved on a larger one, it would run off this one's edge.
  const b = placeOnDisplay({ ...DEFAULT_BOUNDS, ...config.get().consoleWindow }, CONSOLE_MIN, screen)
  const offScreen = testQuiet() ? offScreenOrigin(b.width) : null
  const win = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: offScreen ? offScreen.x : b.x,
    y: offScreen ? offScreen.y : b.y,
    minWidth: CONSOLE_MIN.width,
    minHeight: CONSOLE_MIN.height,
    show: false,
    focusable: !offScreen,
    title: tr(msg({ id: 'main.console.title', defaultMessage: 'Developer Console — {workspace}', description: "The developer console's window title. {workspace} is the workspace's folder name." }), { workspace: basename(owner.ws.path ?? '') || APP_NAME }),
    icon: join(resourcesDir(), 'icon.png'),
    backgroundColor: dark() ? '#1e1e1e' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  win.removeMenu()
  // Its title names its workspace, which the page doesn't know.
  win.on('page-title-updated', (e) => e.preventDefault())
  if (b.maximized && !offScreen) win.maximize()
  if (offScreen) keepOffScreen(win)
  const id = win.webContents.id
  consoles.set(owner, win)
  owners.set(id, owner)
  workspaces.set(win, workspaceKey(owner.ws.path))
  win.on('closed', () => {
    owners.delete(id)
    workspaces.delete(win)
    if (consoles.get(owner) === win) consoles.delete(owner)
  })
  // It goes with the window that opened it.
  const closeWithOwner = (): void => {
    if (!win.isDestroyed()) win.destroy()
  }
  owner.win.once('closed', closeWithOwner)
  win.once('closed', () => {
    if (!owner.win.isDestroyed()) owner.win.removeListener('closed', closeWithOwner)
  })

  const saveBounds = (): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    const maximized = win.isMaximized()
    const { x, y, width, height } = win.getBounds()
    config.update((c) => {
      const was = c.consoleWindow ?? DEFAULT_BOUNDS
      // A quiet test copy's window is off screen: its size is kept, never that place.
      c.consoleWindow = maximized ? { ...was, maximized } : offScreen ? { ...was, width, height, maximized } : { x, y, width, height, maximized }
    })
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.once('ready-to-show', () => (testQuiet() ? win.showInactive() : win.show()))

  // Nothing opens or navigates inside it: links go to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#console`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'console' })
  return win
}

/** Closes every console window (developer features turned off). */
export function closeConsoleWindows(): void {
  for (const w of consoles.values()) if (!w.isDestroyed()) w.close()
}

/** Sends an event to every console window (the settings, for its theme; the console's options). */
export function sendToConsoles(event: CombworkEvent): void {
  for (const w of consoles.values()) if (!w.isDestroyed()) w.webContents.send('hive:event', event)
}
