import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import { basename, join } from 'path'
import { mostUrgent } from '../shared/defaults'
import { branchSummary, firstAcross, inbox, inboxStateText, type Inbox, type InboxItem } from '../shared/inbox'
import type { LiveSessionState, ProjectInfo, SessionStatus } from '../shared/types'
import { appName } from '../shared/appName'
import { msg, onLanguageChange, tr, type Msg } from '../shared/i18n'
import { knownStatus } from './branchWatch'
import { emitTo, onHiveEvent } from './events'
import { resourcesDir } from './paths'
import { presentWindow } from './testQuiet'
import { sessions } from './sessions'
import { restartAndInstall, updateState } from './updater'
import { openWorkspaces, type WorkspaceService } from './workspace'

let tray: Tray | null = null
let attention = false
let pendingQuit = false
let rebuildTray: () => void = () => undefined

export interface TrayActions {
  quit: () => void
  quitNow: () => void
  cancelPendingQuit: () => void
}

/** Shows or clears the "will quit when agents finish" state in the tray. */
export function setTrayPendingQuit(pending: boolean): void {
  pendingQuit = pending
  rebuildTray()
}

export { resourcesDir }

/** Loaded once: the tray is rebuilt on every status change. */
const icons = new Map<string, Electron.NativeImage>()

function icon(name: 'tray' | 'tray-attention'): Electron.NativeImage {
  const cached = icons.get(name)
  if (cached) return cached
  const img = nativeImage.createFromPath(join(resourcesDir(), `${name}.png`))
  const hi = nativeImage.createFromPath(join(resourcesDir(), `${name}@2x.png`))
  if (!hi.isEmpty()) img.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() })
  icons.set(name, img)
  return img
}

const STATUS_LABEL: Record<SessionStatus, Msg> = {
  stopped: msg({ id: 'main.tray.status.stopped', defaultMessage: 'Stopped', description: "An agent's status in the tray menu, after its project's name." }),
  starting: msg({ id: 'main.tray.status.starting', defaultMessage: 'Starting…', description: "An agent's status in the tray menu, after its project's name." }),
  ready: msg({ id: 'main.tray.status.ready', defaultMessage: 'Ready', description: "An agent's status in the tray menu, after its project's name." }),
  working: msg({ id: 'main.tray.status.working', defaultMessage: 'Working…', description: "An agent's status in the tray menu, after its project's name." }),
  waiting: msg({ id: 'main.tray.status.waiting', defaultMessage: 'Needs input', description: "An agent's status in the tray menu, after its project's name." }),
  background: msg({ id: 'main.tray.status.background', defaultMessage: 'Background tasks', description: "An agent's status in the tray menu, after its project's name. Its turn ended while background tasks it started run." }),
  watching: msg({ id: 'main.tray.status.watching', defaultMessage: 'Waiting on cards', description: "An agent's status in the tray menu, after its project's name. It waits for cards to change." }),
  finished: msg({ id: 'main.tray.status.finished', defaultMessage: 'Finished', description: "An agent's status in the tray menu, after its project's name." }),
  error: msg({ id: 'main.tray.status.error', defaultMessage: 'Error', description: "An agent's status in the tray menu, after its project's name." }),
  signin: msg({ id: 'main.tray.status.signin', defaultMessage: 'Needs sign-in', description: "An agent's status in the tray menu, after its project's name. Its CLI's sign-in was refused or has expired." })
}

/** Items the tray lists per section; the rest are counted. */
const TRAY_ITEMS = 10

/** A window's inbox, with each agent's state as it is now (the workspace's cached info has it as of its last refresh). */
function windowInbox(w: WorkspaceService, live: LiveSessionState[]): Inbox {
  const info = w.info()
  if (!info) return { needYou: [], finished: [], toReview: [] }
  const now = new Map(live.map((s) => [`${s.projectPath.toLowerCase()}#${s.agentId}`, s]))
  const fresh = (p: ProjectInfo): ProjectInfo => ({ ...p, agents: p.agents.map((a) => ({ ...a, live: now.get(`${p.path.toLowerCase()}#${a.id}`) ?? null })) })
  return inbox(info.projects.map(fresh), info.assistant ? fresh(info.assistant) : null, knownStatus)
}

export function showWindow(win: BrowserWindow): void {
  presentWindow(win)
}

export function createTray(getWindow: () => BrowserWindow | null, actions: TrayActions): Tray {
  tray = new Tray(icon('tray'))
  tray.setToolTip(appName(app.isPackaged))
  const rebuild = (): void => {
    if (!tray) return
    const live = sessions.liveStates()
    const open = openWorkspaces()
    const boxes = open.map((w) => ({ w, box: windowInbox(w, live) }))
    const needYou = boxes.reduce((n, b) => n + b.box.needYou.length, 0)
    attention = needYou > 0
    tray.setImage(icon(attention ? 'tray-attention' : 'tray'))
    const working = live.filter((s) => s.status === 'working' || s.status === 'background').length
    // Hive's name and its workspaces, then (each a line) what its agents do and whether it waits to quit.
    tray.setToolTip(
      [
        `${appName(app.isPackaged)}${open.length ? ` — ${open.map((w) => basename(w.path!)).join(', ')}` : ''}`,
        live.length ? tr(msg({ id: 'main.tray.counts', defaultMessage: '{working} working, {needYou, plural, one {# needs you} other {# need you}}', description: "A line of the tray icon's tooltip: how many agents are working and how many need you." }), { working, needYou }) : '',
        pendingQuit ? tr(msg({ id: 'main.tray.willQuit', defaultMessage: 'Will quit when agents finish', description: "A line of the tray icon's tooltip while Hive waits for agents to finish before quitting." })) : ''
      ]
        .filter(Boolean)
        .join('\n')
    )
    // The inbox, oldest first across every window: each item shows its agent in the window showing its workspace.
    const inboxSection = (title: string, pick: (b: Inbox) => InboxItem[]): Electron.MenuItemConstructorOptions[] => {
      const { shown, total } = firstAcross(boxes.map(({ w, box }) => ({ owner: w, items: pick(box) })), TRAY_ITEMS)
      if (!total) return []
      const items: Electron.MenuItemConstructorOptions[] = shown.map(({ owner: w, item }) => ({
        label: `${item.assistant ? item.projectName : `${item.projectName} · ${item.agentName}`}  —  ${item.kind === 'review' && item.branch ? branchSummary(item.branch) : inboxStateText(item)}`.slice(0, 120),
        click: () => {
          const win = w.window ?? getWindow()
          if (!win) return
          showWindow(win)
          emitTo(win, { type: 'menu-command', command: 'agent.show', args: [item.projectPath, item.agentId] })
        }
      }))
      if (total > shown.length) items.push({ label: tr(msg({ id: 'main.tray.more', defaultMessage: '{n, plural, one {and # more} other {and # more}}', description: "The tray menu, under a section's first ten items: how many more there are (the section's items: agents waiting, messages and the like)." }), { n: total - shown.length }), enabled: false })
      return [{ label: tr(msg({ id: 'main.tray.section', defaultMessage: '{title} ({n})', description: "A section's heading in the tray menu: its name and how many items it has." }), { title, n: total }), enabled: false }, ...items, { type: 'separator' }]
    }
    // Each window's active projects; a project opens in the window showing its workspace.
    const projectItems: Electron.MenuItemConstructorOptions[] = []
    for (const w of open) {
      const active = w.activeNames()
      if (open.length > 1 && active.length) projectItems.push({ label: basename(w.path!), enabled: false })
      for (const name of active) {
        const p = join(w.path!, name)
        const states = sessions.projectStates(p)
        const st = mostUrgent(states)
        projectItems.push({
          label: `${open.length > 1 ? '   ' : ''}${name}  —  ${states.length > 1 ? tr(msg({ id: 'main.tray.statusOfMany', defaultMessage: '{n, plural, one {{status} (# agent)} other {{status} (# agents)}}', description: "A project's line in the tray menu with several agents: the most urgent one's status, and how many agents it has (2 or more)." }), { status: tr(STATUS_LABEL[st?.status ?? 'stopped']), n: states.length }) : tr(STATUS_LABEL[st?.status ?? 'stopped'])}`,
          click: () => {
            const win = w.window ?? getWindow()
            if (!win) return
            showWindow(win)
            emitTo(win, { type: 'menu-command', command: 'project.focus', args: [p] })
          }
        })
      }
    }
    if (!projectItems.length) projectItems.push({ label: tr(msg({ id: 'main.tray.noProjects', defaultMessage: 'No active projects', description: 'The tray menu when no project is active.' })), enabled: false })
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: tr(msg({ id: 'main.tray.show', defaultMessage: 'Show Hive', description: "The tray menu: brings Hive's window up." })), click: () => { const w = getWindow(); if (w) showWindow(w) } },
        { type: 'separator' },
        ...inboxSection(tr(msg({ id: 'main.tray.needYou', defaultMessage: 'Need you', description: 'A section of the tray menu: agents waiting for you.' })), (b) => b.needYou),
        // Finished since you last looked (#1632): apart from what needs you, and not counted with it.
        ...inboxSection(tr(msg({ id: 'main.tray.finished', defaultMessage: 'Finished', description: 'A section of the tray menu: agents that finished their turn since you last looked (nothing waits for you there).' })), (b) => b.finished),
        ...inboxSection(tr(msg({ id: 'main.tray.toReview', defaultMessage: 'To review', description: "A section of the tray menu: agents' work to look at." })), (b) => b.toReview),
        { label: tr(msg({ id: 'main.tray.active', defaultMessage: 'Active projects', description: 'A section of the tray menu: the active projects.' })), enabled: false },
        ...projectItems,
        { type: 'separator' },
        { label: tr(msg({ id: 'main.tray.settings', defaultMessage: 'Settings', description: 'The tray menu: opens Settings.' })), click: () => { const w = getWindow(); if (w) { showWindow(w); emitTo(w, { type: 'menu-command', command: 'settings.open' }) } } },
        ...(updateState().status === 'ready' ? [{ label: tr(msg({ id: 'main.tray.restartToUpdate', defaultMessage: 'Restart to Update ({version})', description: 'The tray menu when an update is downloaded. {version} is its version.' }), { version: updateState().version ?? '' }), click: () => restartAndInstall() }] : []),
        ...(pendingQuit
          ? [
              { label: tr(msg({ id: 'main.tray.quitting', defaultMessage: '{n, plural, one {Quitting when the agent finishes} other {Quitting when # agents finish}}', description: 'The tray menu while Hive waits for working agents to finish before quitting.' }), { n: working }), enabled: false },
              { label: tr(msg({ id: 'main.tray.quitNow', defaultMessage: 'Quit Now', description: 'The tray menu: quits without waiting for the agents.' })), click: actions.quitNow },
              { label: tr(msg({ id: 'main.tray.cancelQuit', defaultMessage: 'Cancel Pending Quit', description: 'The tray menu: Hive no longer quits when the agents finish.' })), click: actions.cancelPendingQuit }
            ]
          : [{ label: tr(msg({ id: 'main.tray.quit', defaultMessage: 'Quit Hive', description: 'The tray menu: quits Hive.' })), click: actions.quit }])
      ])
    )
  }
  rebuildTray = rebuild
  tray.on('click', () => {
    const w = getWindow()
    if (!w) return
    if (w.isVisible() && w.isFocused()) w.hide()
    else showWindow(w)
  })
  // A working agent's status changes many times a minute (its cost with every status line): rebuild at most every 500 ms.
  let pending: NodeJS.Timeout | null = null
  onHiveEvent((e) => {
    if (e.type !== 'session-status' && e.type !== 'session-exit' && e.type !== 'workspace-changed' && e.type !== 'update-state' && e.type !== 'branch-status') return
    pending ??= setTimeout(() => {
      pending = null
      rebuild()
    }, 500)
  })
  // Its menu and tooltip in the language shown (#796).
  onLanguageChange(() => rebuild())
  rebuild()
  return tray
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
