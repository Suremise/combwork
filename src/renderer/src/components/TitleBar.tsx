import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import iconUrl from '../assets/icon.svg'
import { commandKeybinding, commandLabel, commands, runCommand, toggleAlwaysOnTop } from '../commands'
import { useStore } from '../store'
import { basename, cx, formatKeybinding, recentNote, recentTip } from '../util'
import { Icon, Tooltip, useContextMenu } from './ui'
import * as actions from '../actions'
import { useNeedsYou } from '../inbox'
import { badgeText, windowTitle } from '@shared/taskbar'
import { PROJECT_MENU } from '@shared/projectTabs'
import { appName as nameOf } from '@shared/appName'
import { call } from '../api'
import { msg, tr, type Msg } from '@shared/i18n'

/** The taskbar badge: a red disc with the count, drawn at the screen's scale (Windows shows it at 16 px). */
function drawBadge(count: number, scale: number): string {
  const size = Math.round(16 * scale)
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const r = size / 2
  g.beginPath()
  g.arc(r, r, r - 0.5 * scale, 0, Math.PI * 2)
  g.fillStyle = '#d13438'
  g.fill()
  // A light rim keeps it apart from the icon under it on dark and light taskbars.
  g.lineWidth = scale
  g.strokeStyle = 'rgba(255,255,255,0.9)'
  g.stroke()
  const text = badgeText(count)
  g.fillStyle = '#ffffff'
  g.font = `600 ${Math.round((text.length > 1 ? 8.5 : 11) * scale)}px "Segoe UI", sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, r, r + 0.5 * scale)
  return c.toDataURL('image/png').split(',')[1]
}

/** The window title (Alt+Tab, the taskbar) and the taskbar badge, with what needs you in this window (For you, #1632). */
function useTaskbarCount(title: string): void {
  const needYou = useNeedsYou().count
  const on = useStore((s) => s.settings?.notifications.taskbarCount ?? true)
  const count = on ? needYou : 0
  useEffect(() => {
    document.title = windowTitle(title, count)
  }, [title, count])
  useEffect(() => {
    const scale = window.devicePixelRatio || 1
    void call('window:setBadge', count, count ? drawBadge(count, scale) : null, scale).catch(() => undefined)
  }, [count])
}

/** Space kept between the title and the menu bar or the pin on either side of it. */
const TITLE_GAP = 12
/** Narrower than this between the menu bar and the pin, the title hides rather than show a few letters. */
const TITLE_MIN = 48

/**
 * Places the window title (#1038): centred in the window while it fits between the menu bar and the pin, else moved
 * aside and cut short with an ellipsis, and hidden when there's no room, so a long menu bar (German at 900 px) never
 * runs into it.
 */
function useTitleFit(bar: RefObject<HTMLDivElement | null>, menus: RefObject<HTMLDivElement | null>, end: RefObject<HTMLDivElement | null>, titleEl: RefObject<HTMLDivElement | null>, title: string): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    const b = bar.current
    const m = menus.current
    const a = end.current
    const t = titleEl.current
    if (!b || !m || !a || !t) return
    const fit = (): void => {
      const left = m.offsetLeft + m.offsetWidth + TITLE_GAP
      const right = a.offsetLeft - TITLE_GAP
      const room = right - left
      if (room < TITLE_MIN) return setStyle({ visibility: 'hidden' })
      // The whole title's width, however narrow it is shown, rounded up: scrollWidth rounds a fractional width
      // (197.09 px) down, and the ellipsis then took its last letters with room to spare (HI-2319).
      const range = document.createRange()
      range.selectNodeContents(t)
      const width = Math.min(Math.ceil(range.getBoundingClientRect().width), room)
      const centred = (b.clientWidth - width) / 2
      setStyle({ left: Math.min(Math.max(centred, left), right - width), maxWidth: width })
    }
    fit()
    const ro = new ResizeObserver(fit)
    for (const el of [b, m, a]) ro.observe(el)
    // Measured again once the fonts have loaded, as a fallback font's width isn't the title's.
    let gone = false
    void document.fonts?.ready.then(() => !gone && fit())
    return () => {
      gone = true
      ro.disconnect()
    }
  }, [bar, menus, end, titleEl, title])
  return style
}

/** A menu of the title bar: its id (a hook for tests, data-menu), its name, and its items (commands by id). */
type MenuDef = { id: string; label: Msg; items: (string | '-' | { submenu: 'recent' })[] }

const MENUS: MenuDef[] = [
  {
    id: 'file',
    label: msg({ id: 'shell.menu.file', defaultMessage: 'File', description: "A menu of the title bar's menu bar." }),
    items: ['project.new', 'window.new', '-', 'workspace.open', 'workspace.create', { submenu: 'recent' }, 'workspace.refresh', 'workspace.close', '-', 'settings.open', '-', 'window.close', 'app.quit']
  },
  { id: 'edit', label: msg({ id: 'shell.menu.edit', defaultMessage: 'Edit', description: "A menu of the title bar's menu bar." }), items: ['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.paste', '-', 'edit.selectAll'] },
  {
    id: 'view',
    label: msg({ id: 'shell.menu.view', defaultMessage: 'View', description: "A menu of the title bar's menu bar." }),
    items: ['palette.show', '-', 'view.projects', 'view.overview', 'view.board', 'view.notes', 'view.skills', 'view.mcp', 'view.modes', '-', 'assistant.toggle', 'assistant.settings', 'assistant.moveSide', 'view.toggleSidebar', 'view.notifications', '-', 'view.zoomIn', 'view.zoomOut', 'view.zoomReset', 'view.fullScreen', 'view.alwaysOnTop']
  },
  {
    id: 'project',
    label: msg({ id: 'shell.menu.project', defaultMessage: 'Project', description: "A menu of the title bar's menu bar." }),
    // Its tabs are the tab strip's, in its order (#216).
    items: PROJECT_MENU
  },
  { id: 'session', label: msg({ id: 'shell.menu.session', defaultMessage: 'Session', description: "A menu of the title bar's menu bar." }), items: ['session.new', 'session.resume', 'session.stop', '-', 'session.compact', 'session.archive', 'agent.menu', '-', 'session.startNewAll', 'session.archiveAll', 'session.removeAll', '-', 'project.tab.sessions'] },
  {
    id: 'help',
    label: msg({ id: 'shell.menu.help', defaultMessage: 'Help', description: "A menu of the title bar's menu bar." }),
    items: ['help.docs', 'help.api', 'help.shortcuts', 'help.tips', 'help.releaseNotes', 'help.improveTranslation', '-', 'help.agentSetup', 'help.checkProviders', '-', 'view.devTools', 'help.devConsole', 'view.reload', 'help.logs', 'help.diagnostics', 'help.restoreBoard09', '-', 'help.checkUpdates', 'help.about']
  }
]

const EDIT: Record<string, { label: Msg; key: string; role: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' }> = {
  'edit.undo': { label: msg({ id: 'shell.edit.undo', defaultMessage: 'Undo', description: 'An item of the Edit menu.' }), key: 'Mod+Z', role: 'undo' }, // i18n-ignore: a shortcut's keys
  'edit.redo': { label: msg({ id: 'shell.edit.redo', defaultMessage: 'Redo', description: 'An item of the Edit menu.' }), key: 'Mod+Y', role: 'redo' }, // i18n-ignore: a shortcut's keys
  'edit.cut': { label: msg({ id: 'shell.edit.cut', defaultMessage: 'Cut', description: 'An item of the Edit menu.' }), key: 'Mod+X', role: 'cut' }, // i18n-ignore: a shortcut's keys
  'edit.copy': { label: msg({ id: 'shell.edit.copy', defaultMessage: 'Copy', description: 'An item of the Edit menu.' }), key: 'Mod+C', role: 'copy' }, // i18n-ignore: a shortcut's keys
  'edit.paste': { label: msg({ id: 'shell.edit.paste', defaultMessage: 'Paste', description: 'An item of the Edit menu.' }), key: 'Mod+V', role: 'paste' }, // i18n-ignore: a shortcut's keys
  'edit.selectAll': { label: msg({ id: 'shell.edit.selectAll', defaultMessage: 'Select All', description: 'An item of the Edit menu.' }), key: 'Mod+A', role: 'selectAll' } // i18n-ignore: a shortcut's keys
}

export function TitleBar() {
  const [open, setOpen] = useState<number | null>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [recentOpen, setRecentOpen] = useState(false)
  // Right-click on a recent workspace: Remove from Recent (#144). Outside the menu, so it stays when the menu closes.
  const recentMenu = useContextMenu()
  // Its name only (HI-1806): the workspace's every change would render the title bar again.
  const workspaceName = useStore((s) => s.workspace?.name)
  const selected = useStore((s) => s.selectedProject)
  const recent = useStore((s) => s.recent)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open === null) return
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.menubar')) setOpen(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    const onBlur = (): void => setOpen(null)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const openMenu = (i: number, el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    setAnchor({ x: r.left, y: r.bottom + 2 })
    setRecentOpen(false)
    setOpen(i)
  }

  const appName = useStore((s) => nameOf(!s.appInfo || s.appInfo.isPackaged))
  const pinned = useStore((s) => s.alwaysOnTop)
  const pinKey = commandKeybinding('view.alwaysOnTop')
  const title = [selected ? basename(selected) : null, workspaceName, appName].filter(Boolean).join(' — ')
  useTaskbarCount(title)
  const barRef = useRef<HTMLDivElement>(null)
  const menubarRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  const titleStyle = useTitleFit(barRef, menubarRef, actionsRef, titleRef, title)

  return (
    <div className="titlebar" ref={barRef} onDoubleClick={(e) => e.target === e.currentTarget && void window.combwork.invoke('window:toggleMaximize')}>
      <div className="titlebar-logo">
        <img src={iconUrl} alt="" />
      </div>
      <div className="menubar" ref={menubarRef}>
        {MENUS.map((m, i) => (
          <div
            key={m.id}
            className={cx('menubar-item', open === i && 'open')}
            data-menu={m.id}
            onMouseDown={(e) => (open === i ? setOpen(null) : openMenu(i, e.currentTarget))}
            onMouseEnter={(e) => open !== null && open !== i && openMenu(i, e.currentTarget)}
          >
            {tr(m.label)}
          </div>
        ))}
      </div>
      <div className="titlebar-title" ref={titleRef} style={titleStyle}>
        {title}
      </div>
      {/* Always on Top, just left of the window controls: lit while the window stays above other apps. */}
      <div className="titlebar-actions" ref={actionsRef}>
        <Tooltip content={`${tr(msg({ id: 'shell.titlebar.pinTip', defaultMessage: '{on, select, yes {Always on Top (on)} other {Always on Top (off)}}', description: 'Tooltip of the pin in the title bar (its shortcut follows): whether the window stays above other apps.' }), { on: pinned ? 'yes' : 'no' })}${pinKey ? `  ${formatKeybinding(pinKey)}` : ''}`}>
          <button className={cx('titlebar-pin', pinned && 'on')} aria-label={tr(msg({ id: 'shell.titlebar.pin', defaultMessage: 'Always on Top', description: 'The name, for screen readers, of the pin in the title bar.' }))} aria-pressed={pinned} onClick={toggleAlwaysOnTop}>
            <Icon name={pinned ? 'pinned' : 'pin'} />
          </button>
        </Tooltip>
      </div>
      {open !== null &&
        createPortal(
          <div className="menu" ref={menuRef} style={{ left: anchor.x, top: anchor.y }}>
            {MENUS[open].items.map((item, idx) => {
              if (item === '-') return <div key={idx} className="menu-sep" />
              if (typeof item === 'object') {
                return (
                  <div
                    key={idx}
                    style={{ position: 'relative' }}
                    onMouseEnter={() => {
                      setRecentOpen(true)
                      // Whether each folder is there now, and open elsewhere (#144).
                      void actions.loadRecent()
                    }}
                    onMouseLeave={() => setRecentOpen(false)}
                  >
                    <div className="menu-item">
                      <Icon name="history" />
                      <span>{tr(msg({ id: 'shell.menu.openRecent', defaultMessage: 'Open Recent', description: "The File menu's submenu of recent workspaces." }))}</span>
                      <span className="menu-key">
                        <Icon name="chevron-right" />
                      </span>
                    </div>
                    {recentOpen && (
                      <div className="menu" style={{ position: 'absolute', left: '100%', top: -4 }}>
                        {recent.length === 0 && <div className="menu-item disabled">{tr(msg({ id: 'shell.menu.noRecent', defaultMessage: 'No recent workspaces', description: 'Open Recent when there are none.' }))}</div>}
                        {recent.map((r) => (
                          <div
                            key={r.path}
                            className={cx('menu-item', 'recent-item', !r.exists && 'missing')}
                            title={recentTip(r)}
                            onClick={() => {
                              setOpen(null)
                              void actions.openRecent(r.path)
                            }}
                            onContextMenu={(e) => {
                              setOpen(null)
                              recentMenu.open(e, [{ label: tr(msg({ id: 'shell.menu.removeRecentItem', defaultMessage: 'Remove from Recent', description: 'Right-click menu of a recent workspace: forgets it (the folder stays).' })), icon: 'close', onClick: () => void actions.removeRecent(r.path) }])
                            }}
                          >
                            <Icon name={r.exists ? 'folder' : 'warning'} />
                            <span>{basename(r.path)}</span>
                            <span className="menu-key">{recentNote(r)}</span>
                            <button
                              className="recent-remove"
                              aria-label={tr(msg({ id: 'shell.menu.removeRecentLabel', defaultMessage: 'Remove {workspace} from recent', description: "The name, for screen readers, of the × beside a recent workspace. {workspace} is its folder's name." }), { workspace: basename(r.path) })}
                              title={tr(msg({ id: 'shell.menu.removeRecent', defaultMessage: 'Remove from recent', description: 'Tooltip of the × beside a recent workspace.' }))}
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation()
                                void actions.removeRecent(r.path)
                              }}
                            >
                              <Icon name="close" />
                            </button>
                          </div>
                        ))}
                        {recent.length > 0 && (
                          <>
                            <div className="menu-sep" />
                            <div
                              className="menu-item"
                              onClick={() => {
                                setOpen(null)
                                void actions.clearRecent()
                              }}
                            >
                              <Icon name="clear-all" />
                              <span>{tr(msg({ id: 'shell.menu.clearRecent', defaultMessage: 'Clear Recently Opened…', description: 'The last item of Open Recent: forgets them all, after asking.' }))}</span>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              }
              if (EDIT[item]) {
                const e = EDIT[item]
                return (
                  <div
                    key={idx}
                    className="menu-item"
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => {
                      setOpen(null)
                      void window.combwork.invoke('window:edit', e.role)
                    }}
                  >
                    <Icon name="blank" />
                    <span>{tr(e.label)}</span>
                    <span className="menu-key">{formatKeybinding(e.key)}</span>
                  </div>
                )
              }
              const c = commands.find((x) => x.id === item)
              if (!c || c.hidden?.()) return null
              const enabled = !c.when || c.when()
              const kb = commandKeybinding(item)
              return (
                <div
                  key={idx}
                  className={cx('menu-item', !enabled && 'disabled')}
                  data-command={c.id}
                  title={c.tip?.()}
                  onClick={() => {
                    if (!enabled) return
                    setOpen(null)
                    runCommand(item)
                  }}
                >
                  <Icon name={c.checked?.() ? 'check' : 'blank'} />
                  <span>{commandLabel(c)}</span>
                  {kb && <span className="menu-key">{formatKeybinding(kb)}</span>}
                </div>
              )
            })}
          </div>,
          document.body
        )}
      {recentMenu.element}
    </div>
  )
}
