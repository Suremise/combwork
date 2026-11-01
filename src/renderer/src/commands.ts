import { PROJECT_KEYBINDING_CATEGORIES, SESSION_LAYOUTS, projectSessionView, resolveKeybinding } from '@shared/defaults'
import { PROVIDERS, providerDescriptor } from '@shared/providers'
import { batchCounts, type BatchCounts } from '@shared/startAll'
import { appTakesTerminalKey } from '@shared/terminalInput'
import type { ProjectInfo, ProviderId, SessionLayout, ToastTarget } from '@shared/types'
import { tilePageCount } from '@shared/tiles'
import { APP_NAME } from '@shared/appName'
import { msg, tr, type Msg, type Values } from '@shared/i18n'
import { call } from './api'
import { EXPORT_BOARD, exportBoard, unarchiveBatch } from './boardBatches'
import { restoreBoard09 } from './components/BoardUpgrade'
import { checkForUpdates, openReleaseNotes } from './components/Updates'
import { openModeMenu } from './components/PermissionMode'
import * as actions from './actions'
import { noteCommandUsed } from './tips'
import { showNoticeTarget } from './noticeTarget'
import { requestStripMenu, type StripMenu } from './stripMenus'
import { showAntivirus } from './components/Antivirus'
import { focusTileAfter } from './components/AgentTiles'
import type { VcSection } from '@shared/gitRepo'
import { agentPage, assistantOnLeft, closeTile, showTilePage, tileFocusOf, tilePage, tilesPageSize, focusedAgentId, get, isAssistantPath, setAssistantSide, notify, openInSessionsTab, openProjectSettings, openVersionControl, revealAgent, set, setActivity, setAssistantOpen, setProgressOpen, progressIsOpen, showAssistantView, showView, showUnusedWorktrees, setProjectTab, showAgent, showPage, panePageCount, shownLayout, toggleCompactSidebar, type ProjectTab } from './store'
import { STRIP_TABS } from '@shared/projectTabs'
import { workspacePaused } from './teamPause'
import { pauseTheTeam, resumeTheTeam } from './components/TeamPause'

/** A command's category: an id (CATEGORY_TEXT names it), as Settings → Keyboard Shortcuts groups and filters them. */
export type CommandCategory = 'view' | 'file' | 'project' | 'session' | 'help' | 'preferences' | 'assistant' | 'developer' | 'tasks' | 'notes' | 'mcp'

/** Each category's name, in the palette ("Session: Compact Conversation…") and Settings → Keyboard Shortcuts. */
export const CATEGORY_TEXT: Record<CommandCategory, Msg> = {
  view: msg({ id: 'shell.category.view', defaultMessage: 'View', description: "A command's category (the View menu's)." }),
  file: msg({ id: 'shell.category.file', defaultMessage: 'File', description: "A command's category (the File menu's)." }),
  project: msg({ id: 'shell.category.project', defaultMessage: 'Project', description: "A command's category: commands about the project shown." }),
  session: msg({ id: 'shell.category.session', defaultMessage: 'Session', description: "A command's category: commands about an agent's session." }),
  help: msg({ id: 'shell.category.help', defaultMessage: 'Help', description: "A command's category (the Help menu's)." }),
  preferences: msg({ id: 'shell.category.preferences', defaultMessage: 'Preferences', description: "A command's category: Settings and what is in it." }),
  assistant: msg({ id: 'shell.category.assistant', defaultMessage: 'Assistant', description: "A command's category: the Hive Assistant's." }),
  developer: msg({ id: 'shell.category.developer', defaultMessage: 'Developer', description: "A command's category: tools for developing Hive and debugging it." }),
  tasks: msg({ id: 'shell.category.tasks', defaultMessage: 'Tasks', description: "A command's category: the task board's cards." }),
  notes: msg({ id: 'shell.category.notes', defaultMessage: 'Notes', description: "A command's category: shared notes." }),
  mcp: msg({ id: 'shell.category.mcp', defaultMessage: 'MCP', description: "A command's category: MCP servers. MCP is a name: keep it." })
}

/** A command as written below: its name a message (#767). */
export interface CommandDef {
  id: string
  /** Its name, a message; with values for one that names something (a layout, an agent's number). */
  name: Msg
  nameValues?: Values
  category: CommandCategory
  /** The default shortcut. Users change it in Settings → Keyboard Shortcuts (projects for Project and Session commands). */
  keybinding?: string
  run: (...args: any[]) => unknown
  /** Whether it can run now; given the arguments it runs with (a notice's button names its project, #1437). */
  when?: (...args: unknown[]) => boolean
  /** Needs arguments (e.g. a path), so it can't have a shortcut or appear in the palette. */
  internal?: boolean
  /** A toggle: shown with a checkmark in the menus and the palette while it is on. */
  checked?: () => boolean
  /** Its label as things are now, in the menus and the palette (`label` is its name everywhere else), in the language shown. */
  liveLabel?: () => string
  /** What it does, on hover in the menus, in the language shown. */
  tip?: () => string
  /** Left out of the menus, the palette and Tips, and not run, while this says so (developer features, #637). */
  hidden?: () => boolean
}

export interface Command extends CommandDef {
  /** Its name in the language shown, as it is when read: read it when rendering, never keep it. */
  readonly label: string
}

/** A command's label in the menus and the palette. */
export const commandLabel = (c: Command): string => c.liveLabel?.() ?? c.label

/** A command's category's name, in the language shown. */
export const commandCategory = (c: Pick<Command, 'category'>): string => tr(CATEGORY_TEXT[c.category])

/** CONTRIBUTING's section on fixing a translation (Help → Improve This Translation). */
const TRANSLATING_URL = 'https://github.com/Suremise/hive-desktop/blob/main/CONTRIBUTING.md#fix-a-translation'

/** More than one window is open: File → Exit closes them all. */
const severalWindows = (): boolean => get().windowCount > 1

const hasWorkspace = (): boolean => !!get().workspace
const hasProject = (): boolean => !!get().selectedProject && hasWorkspace()
const selected = () => get().workspace?.projects.find((p) => p.path === get().selectedProject)
/** One of the agent strip's template menus, on the Session tab of the project shown. */
const stripMenu = (menu: StripMenu): void => {
  const p = get().selectedProject
  if (!p) return
  setProjectTab(p, 'session')
  requestStripMenu(p, menu)
}
/** The focused agent of the selected project has a running session. */
const hasLive = (): boolean => {
  const p = selected()
  return !!p?.agents.find((a) => a.id === focusedAgentId(p))?.live
}

/** A batch action's label with how many agents it acts on, as the project header shows it (#275); no count with one agent. */
function batchLabel(m: Msg, which: keyof BatchCounts): string {
  const agents = selected()?.agents ?? []
  return tr(m, { several: agents.length > 1 ? 'yes' : 'no', n: agents.length > 1 ? batchCounts(agents)[which] : 0 })
}

function cycleAgent(delta: number): void {
  const p = selected()
  if (!p || p.agents.length < 2) return
  const i = p.agents.findIndex((a) => a.id === focusedAgentId(p))
  showAgent(p, p.agents[(i + delta + p.agents.length) % p.agents.length].id)
  setProjectTab(p.path, 'session')
}

const tab = (t: ProjectTab) => () => {
  const p = get().selectedProject
  if (!p) return
  showView('projects')
  setProjectTab(p, t)
}

// The strip's tabs (#974: Settings isn't one); from Project Settings, the next is the first and the previous the last.
const TAB_ORDER: ProjectTab[] = STRIP_TABS.map((t) => t.id)

function cycleTab(delta: number): void {
  const p = get().selectedProject
  if (!p) return
  const at = TAB_ORDER.indexOf(get().projectTabs[p] ?? 'session')
  const i = at >= 0 ? at : delta > 0 ? -1 : TAB_ORDER.length
  showView('projects')
  setProjectTab(p, TAB_ORDER[(i + delta + TAB_ORDER.length) % TAB_ORDER.length])
}

/** Focus agent N (1-based) of the selected project and show it. */
/** Whether the selected project's Session tab shows Tiles (#976), whose pages are pages of tiles. */
const tilesShown = (p: ProjectInfo): boolean => projectSessionView(p.config, get().settings) === 'tiles'

/** How many agent pages the selected project has (its panes' cells ÷ its layout's panes, #134, #762; in Tiles, of tiles, #976). */
const pageCount = (): number => {
  const p = selected()
  if (!p) return 1
  return tilesShown(p) ? tilePageCount(p.agents.length, tilesPageSize(p)) : panePageCount(p)
}

/** Whether the selected project's agents move: two or more (in order), or one in panes side by side (to another cell, #762). */
const canMove = (): boolean => {
  const p = selected()
  return !!p && (p.agents.length > 1 || (p.agents.length === 1 && actions.panesPlaced(p)))
}

/** Whether the selected project's panes form a grid, whose panes also move up and down (#762). */
const gridShown = (): boolean => {
  const p = selected()
  if (!p || tilesShown(p) || !p.agents.length) return false
  const l = shownLayout(p)
  return l === 'grid' || l === 'grid6'
}

/** Goes to the next or previous agent page (when the project has more than one). */
function cyclePage(delta: number): void {
  const p = selected()
  if (!p) return
  const pages = pageCount()
  if (pages < 2) return
  if (tilesShown(p)) {
    // The grid's next page; from the focus view, back to the grid on it.
    const next = (tilePage(p) + delta + pages) % pages
    closeTile(p)
    showTilePage(p, next)
  } else showPage(p, (agentPage(p, focusedAgentId(p)) + delta + pages) % pages)
  setProjectTab(p.path, 'session')
}

function focusAgentN(n: number): void {
  const p = selected()
  const a = p?.agents[n - 1]
  if (!p || !a) return
  showAgent(p, a.id)
  setProjectTab(p.path, 'session')
}

/** Always on Top for this window: the title bar's pin, View → Always on Top, the palette and Ctrl+Alt+O. */
export function toggleAlwaysOnTop(): void {
  void call('window:setAlwaysOnTop', !get().alwaysOnTop).then((on) => set({ alwaysOnTop: on }))
}

function focusTerminal(): void {
  const p = selected()
  if (!p) return
  showView('projects')
  setProjectTab(p.path, 'session')
  setTimeout(() => {
    const host = document.querySelector<HTMLElement>(`.terminal-host.focused-agent textarea`) ?? document.querySelector<HTMLElement>('.terminal-host:not(.hidden) textarea')
    host?.focus()
  }, 50)
}

const layoutCommand = (value: SessionLayout, n: number): CommandDef => ({
  id: `layout.${value}`,
  name: msg({ id: 'shell.command.layout', defaultMessage: 'Layout: {layout}', description: "A command per agent layout (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. {layout} is the layout's name." }),
  nameValues: { layout: SESSION_LAYOUTS.find((l) => l.value === value)?.label ?? value },
  category: 'session',
  keybinding: `Mod+Alt+${n}`, // i18n-ignore: a shortcut's keys
  when: hasProject,
  run: () => {
    // One layout for the project (#134).
    const p = selected()
    if (p) void actions.setLayout(p.path, value)
  }
})

const COMMAND_DEFS: CommandDef[] = [
  { id: 'palette.show', name: msg({ id: 'shell.command.palette.show', defaultMessage: 'Show All Commands', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', keybinding: 'Mod+Shift+P', run: () => set({ paletteOpen: true, paletteMode: 'commands' }) }, // i18n-ignore: a shortcut's keys
  { id: 'project.goto', name: msg({ id: 'shell.command.project.goto', defaultMessage: 'Go to Project…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category. The … says it opens a dialog first: keep it.' }), category: 'view', keybinding: 'Mod+P', when: hasWorkspace, run: () => set({ paletteOpen: true, paletteMode: 'projects' }) }, // i18n-ignore: a shortcut's keys
  { id: 'settings.open', name: msg({ id: 'shell.command.settings.open', defaultMessage: 'Open Settings', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Preferences category.' }), category: 'preferences', keybinding: 'Mod+,', run: () => setActivity('settings') }, // i18n-ignore: a shortcut's keys
  { id: 'settings.providers', name: msg({ id: 'shell.command.settings.providers', defaultMessage: 'Choose Coding Agents (Providers)', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Preferences category.' }), category: 'preferences', run: () => { set({ settingsSection: 'providers', settingsQuery: '' }); setActivity('settings') } },
  { id: 'settings.accounts', name: msg({ id: 'shell.command.settings.accounts', defaultMessage: 'Accounts & Connections', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Preferences category (HI-2107): opens Settings → Accounts & Connections.' }), category: 'preferences', run: () => { set({ settingsSection: 'accounts', settingsQuery: '' }); setActivity('settings') } },
  { id: 'settings.keybindings', name: msg({ id: 'shell.command.settings.keybindings', defaultMessage: 'Customise Keyboard Shortcuts', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Preferences category.' }), category: 'preferences', run: () => { set({ settingsSection: 'keybindings', settingsQuery: '' }); setActivity('settings') } },
  { id: 'settings.advanced', name: msg({ id: 'shell.command.settings.advanced', defaultMessage: 'Advanced Settings', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Preferences category.' }), category: 'preferences', run: () => { set({ settingsSection: 'advanced', settingsQuery: '' }); setActivity('settings') } },
  { id: 'settings.notifications', name: msg({ id: 'shell.command.settings.notifications', defaultMessage: 'Notification Settings', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Preferences category.' }), category: 'preferences', run: () => { set({ settingsSection: 'notifications', settingsQuery: '' }); setActivity('settings') } },
  { id: 'antivirus.show', name: msg({ id: 'shell.command.antivirus.show', defaultMessage: 'Antivirus Scanning of the Workspace', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Preferences category.' }), category: 'preferences', run: () => showAntivirus() },
  { id: 'antivirus.dismiss', name: msg({ id: 'shell.command.antivirus.dismiss', defaultMessage: 'Don’t Suggest Antivirus Exclusions Again', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Preferences category. It isn't in the menus or the palette: notifications and buttons run it by its name." }), category: 'preferences', internal: true, run: () => void call('antivirus:dismiss') },
  { id: 'window.new', name: msg({ id: 'shell.command.window.new', defaultMessage: 'New Window', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the File category.' }), category: 'file', keybinding: 'Mod+K Mod+N', run: () => call('window:new') }, // i18n-ignore: a shortcut's keys
  { id: 'workspace.open', name: msg({ id: 'shell.command.workspace.open', defaultMessage: 'Open Workspace…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the File category. The … says it opens a dialog first: keep it.' }), category: 'file', keybinding: 'Mod+K Mod+O', run: (path?: string) => actions.openWorkspace(path) }, // i18n-ignore: a shortcut's keys
  { id: 'workspace.create', name: msg({ id: 'shell.command.workspace.create', defaultMessage: 'New Workspace…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the File category. The … says it opens a dialog first: keep it.' }), category: 'file', run: () => actions.createWorkspace() },
  { id: 'workspace.clearRecent', name: msg({ id: 'shell.command.workspace.clearRecent', defaultMessage: 'Clear Recently Opened…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the File category. The … says it opens a dialog first: keep it.' }), category: 'file', tip: () => tr(msg({ id: 'shell.tip.workspace.clearRecent', defaultMessage: 'Forget the recent workspaces (the folders are left alone); ones open in a window stay', description: 'What a command does, on hover in the menus.' })), run: () => actions.clearRecent() },
  { id: 'workspace.close', name: msg({ id: 'shell.command.workspace.close', defaultMessage: 'Close Workspace', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the File category.' }), category: 'file', when: hasWorkspace, tip: () => tr(msg({ id: 'shell.tip.workspace.close', defaultMessage: "Stop this workspace's agents and close it; the window stays open", description: 'What a command does, on hover in the menus.' })), run: () => actions.closeWorkspace() },
  {
    id: 'workspace.repairMove',
    name: msg({ id: 'shell.command.workspace.repairMove', defaultMessage: 'Repair Moved Workspace…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the File category. The … says it opens a dialog first: keep it.' }),
    category: 'file',
    when: () => !!get().workspace?.moved,
    tip: () => tr(msg({ id: 'shell.tip.workspace.repairMove', defaultMessage: 'The workspace or a project moved to another folder: repair what still points to the old one', description: 'What a command does, on hover in the menus.' })),
    run: () => set({ moveRepairOpen: true })
  },
  { id: 'workspace.refresh', name: msg({ id: 'shell.command.workspace.refresh', defaultMessage: 'Refresh Workspace', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the File category.' }), category: 'file', keybinding: 'F5', when: hasWorkspace, run: () => actions.refreshWorkspace() },
  { id: 'project.new', name: msg({ id: 'shell.command.project.new', defaultMessage: 'New Project…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category. The … says it opens a dialog first: keep it.' }), category: 'project', keybinding: 'Mod+Alt+N', when: hasWorkspace, run: () => actions.createProject() }, // i18n-ignore: a shortcut's keys
  { id: 'project.toggleActive', name: msg({ id: 'shell.command.project.toggleActive', defaultMessage: 'Toggle Project Active', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', keybinding: 'Mod+Alt+A', when: hasProject, run: () => actions.toggleActiveSelected() }, // i18n-ignore: a shortcut's keys
  { id: 'project.next', name: msg({ id: 'shell.command.project.next', defaultMessage: 'Next Project', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', keybinding: 'Mod+PageDown', when: hasWorkspace, run: () => actions.cycleProject(1) }, // i18n-ignore: a shortcut's keys
  { id: 'project.previous', name: msg({ id: 'shell.command.project.previous', defaultMessage: 'Previous Project', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', keybinding: 'Mod+PageUp', when: hasWorkspace, run: () => actions.cycleProject(-1) }, // i18n-ignore: a shortcut's keys
  { id: 'project.focus', name: msg({ id: 'shell.command.project.focus', defaultMessage: 'Focus Project', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category. It isn't in the menus or the palette: notifications and buttons run it by its name." }), category: 'project', internal: true, run: (path: string) => path && actions.selectProject(path) },
  { id: 'project.remove', name: msg({ id: 'shell.command.project.remove', defaultMessage: 'Remove Project…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category. The … says it opens a dialog first: keep it.' }), category: 'project', when: hasProject, run: (path?: unknown) => set({ removeProjectFor: typeof path === 'string' ? path : get().selectedProject }) },
  { id: 'project.openExplorer', name: msg({ id: 'shell.command.project.openExplorer', defaultMessage: 'Reveal Project in File Explorer', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', when: hasProject, run: () => call('project:openInExplorer', get().selectedProject!) },
  { id: 'project.openTerminal', name: msg({ id: 'shell.command.project.openTerminal', defaultMessage: 'Open External Terminal Here', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', keybinding: 'Mod+Shift+`', when: hasProject, run: () => call('project:openTerminal', get().selectedProject!) }, // i18n-ignore: a shortcut's keys
  { id: 'project.tab.session', name: msg({ id: 'shell.command.project.tab.session', defaultMessage: 'Go to Session', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', keybinding: 'Alt+1', when: hasProject, run: tab('session') },
  { id: 'project.tab.overview', name: msg({ id: 'shell.command.project.tab.overview', defaultMessage: 'Go to Overview', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', keybinding: 'Alt+2', when: hasProject, run: tab('overview') },
  { id: 'project.tab.performance', name: msg({ id: 'shell.command.project.tab.performance', defaultMessage: 'Go to Performance', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', keybinding: 'Alt+3', when: hasProject, run: tab('performance') },
  { id: 'project.tab.tasks', name: msg({ id: 'shell.command.project.tab.tasks', defaultMessage: 'Go to Tasks', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', keybinding: 'Alt+4', when: hasProject, run: tab('tasks') },
  { id: 'project.tab.sessions', name: msg({ id: 'shell.command.project.tab.sessions', defaultMessage: 'Go to Sessions', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', keybinding: 'Alt+5', when: hasProject, run: tab('sessions') },
  { id: 'project.tab.files', name: msg({ id: 'shell.command.project.tab.files', defaultMessage: 'Go to Files', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', keybinding: 'Alt+6', when: hasProject, run: tab('files') },
  { id: 'project.tab.images', name: msg({ id: 'shell.command.project.tab.images', defaultMessage: 'Go to Attachments', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', keybinding: 'Alt+7', when: hasProject, run: tab('images') },
  { id: 'project.tab.changes', name: msg({ id: 'shell.command.project.tab.changes', defaultMessage: 'Go to Version Control', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category: shows the Version Control tab (glossary 2.1).' }), category: 'project', keybinding: 'Alt+8', when: hasProject, run: tab('changes') },
  { id: 'project.tab.activity', name: msg({ id: 'shell.command.project.tab.activity', defaultMessage: 'Go to Activity', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category: shows the Activity tab, the project's live work as a tree." }), category: 'project', keybinding: 'Alt+9', when: hasProject, run: tab('activity') },
  { id: 'project.openVersionControl', name: msg({ id: 'shell.command.project.openVersionControl', defaultMessage: 'Open Version Control', description: "A command, in the Project category: shows a project's Version Control tab (glossary 2.1). It isn't in the menus or the palette: notifications run it by its name (Hive found another version control in a project's folder)." }), category: 'project', internal: true, run: (path?: string, section?: VcSection) => typeof path === 'string' && openVersionControl(path, section ?? get().vcSection[path] ?? 'workflow') },
  { id: 'project.tab.memory', name: msg({ id: 'shell.command.project.tab.memory', defaultMessage: 'Go to Memory', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', when: hasProject, run: tab('memory') },
  { id: 'project.tab.skills', name: msg({ id: 'shell.command.project.tab.skills', defaultMessage: 'Go to Skills', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', when: hasProject, run: tab('skills') },
  { id: 'project.tab.templates', name: msg({ id: 'shell.command.project.tab.templates', defaultMessage: 'Go to Templates', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', when: hasProject, run: tab('templates') },
  { id: 'project.tab.mcp', name: msg({ id: 'shell.command.project.tab.mcp', defaultMessage: 'Go to MCP', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', when: hasProject, run: tab('mcp') },
  { id: 'project.tab.settings', name: msg({ id: 'shell.command.project.tab.settings', defaultMessage: 'Go to Project Settings', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', keybinding: 'Alt+0', when: hasProject, run: tab('settings') },
  { id: 'project.storage', name: msg({ id: 'shell.command.project.storage', defaultMessage: 'Project Storage and Clean Up…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category. The … says it opens a dialog first: keep it.' }), category: 'project', when: hasProject, run: () => openProjectSettings(get().selectedProject!, 'storage') },
  { id: 'project.tab.next', name: msg({ id: 'shell.command.project.tab.next', defaultMessage: 'Next Project Tab', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', keybinding: 'Mod+Tab', when: hasProject, run: () => cycleTab(1) }, // i18n-ignore: a shortcut's keys
  { id: 'project.tab.previous', name: msg({ id: 'shell.command.project.tab.previous', defaultMessage: 'Previous Project Tab', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category.' }), category: 'project', keybinding: 'Mod+Shift+Tab', when: hasProject, run: () => cycleTab(-1) }, // i18n-ignore: a shortcut's keys
  { id: 'session.new', name: msg({ id: 'shell.command.session.new', defaultMessage: 'New Session', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category.' }), category: 'session', keybinding: 'Mod+Shift+N', when: hasProject, run: () => actions.newSession() }, // i18n-ignore: a shortcut's keys
  { id: 'session.resume', name: msg({ id: 'shell.command.session.resume', defaultMessage: 'Resume Last Session', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category.' }), category: 'session', keybinding: 'Mod+Shift+R', when: hasProject, run: () => actions.resumeLast() }, // i18n-ignore: a shortcut's keys
  { id: 'session.stop', name: msg({ id: 'shell.command.session.stop', defaultMessage: 'Stop Session', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category.' }), category: 'session', keybinding: 'Mod+Shift+X', when: hasLive, run: () => actions.stopSession() }, // i18n-ignore: a shortcut's keys
  {
    id: 'session.compact',
    name: msg({ id: 'shell.command.session.compact', defaultMessage: 'Compact Conversation…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. The … says it opens a dialog first: keep it.' }),
    category: 'session',
    keybinding: 'Mod+Alt+C', // i18n-ignore: a shortcut's keys
    when: hasLive,
    run: (path?: string, agentId?: string) => {
      const p = path ?? get().selectedProject
      const id = agentId ?? focusedAgentId(get().workspace?.projects.find((x) => x.path === p))
      if (p && id) set({ compactFor: { project: p, agentId: id } })
    }
  },
  {
    id: 'session.permissionMode',
    name: msg({ id: 'shell.command.session.permissionMode', defaultMessage: 'Switch Permission Mode…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. The … says it opens a dialog first: keep it.' }),
    category: 'session',
    keybinding: 'Mod+Alt+M', // i18n-ignore: a shortcut's keys
    when: hasProject,
    run: () => {
      const p = selected()
      const id = focusedAgentId(p)
      if (p && id) openModeMenu(p.path, id, document.querySelector('.project-header .mode-badge'))
    }
  },
  {
    id: 'session.handOverTo',
    name: msg({ id: 'shell.command.session.handOverTo', defaultMessage: "Hand Over an Agent's Work", description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. It isn't in the menus or the palette: notifications and buttons run it by its name." }),
    category: 'session',
    // From the long-conversation notification, which passes the agent.
    internal: true,
    run: (projectPath?: unknown, agentId?: unknown) => {
      if (typeof projectPath === 'string' && typeof agentId === 'string') set({ handOverFor: { project: projectPath, agentId } })
    }
  },
  {
    id: 'session.showTranscript',
    name: msg({ id: 'shell.command.session.showTranscript', defaultMessage: "Read a Session's Transcript", description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. It isn't in the menus or the palette: notifications and buttons run it by its name. It opens the Sessions tab on one session (#1434)." }),
    category: 'session',
    // A refused Resume's notice (#1434), which passes the project and the session.
    internal: true,
    run: (projectPath?: unknown, sessionId?: unknown) => {
      if (typeof projectPath === 'string' && typeof sessionId === 'string') openInSessionsTab(projectPath, sessionId)
    }
  },
  {
    id: 'session.handOverLongConversation',
    name: msg({ id: 'shell.command.session.handOverLongConversation', defaultMessage: 'Hand Over a Long Conversation', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. It isn't in the menus or the palette: notifications and buttons run it by its name. It opens Hand Over to… if the agent is idle and on no card loop's card." }),
    category: 'session',
    // The long-conversation notice's Hand Over to…, which passes the agent: checked again when it is clicked.
    internal: true,
    run: (projectPath?: unknown, agentId?: unknown) => {
      if (typeof projectPath === 'string' && typeof agentId === 'string') void actions.handOverLongConversation(projectPath, agentId)
    }
  },
  {
    id: 'session.allowLockedEdit',
    name: msg({ id: 'shell.command.session.allowLockedEdit', defaultMessage: 'Allow a Locked Edit', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. It isn't in the menus or the palette: notifications and buttons run it by its name." }),
    category: 'session',
    // Only from the notification, which passes the agent and file.
    internal: true,
    run: (projectPath?: unknown, agentId?: unknown, path?: unknown) => {
      if (typeof projectPath === 'string' && typeof agentId === 'string' && typeof path === 'string')
        void actions.attempt(tr(msg({ id: 'shell.error.allowEdit', defaultMessage: 'Could not allow the edit', description: "An error's title: allowing an agent's edit of a locked file failed." })), () => call('session:allowLockedEdit', projectPath, agentId, path))
    }
  },
  {
    id: 'session.settleLeftovers',
    name: msg({ id: 'shell.command.session.settleLeftovers', defaultMessage: 'End or Keep the Processes an Agent Left Running', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. It isn't in the menus or the palette: notifications and buttons run it by its name." }),
    category: 'session',
    // Only from the notification and the pane header, which pass the agent and what to do.
    internal: true,
    run: (projectPath?: unknown, agentId?: unknown, how?: unknown) => {
      if (typeof projectPath === 'string' && typeof agentId === 'string' && (how === 'end' || how === 'keep'))
        void actions.attempt(how === 'end' ? tr(msg({ id: 'shell.error.endProcesses', defaultMessage: 'Could not end the processes', description: "An error's title: ending the processes an agent left running failed." })) : tr(msg({ id: 'shell.error.keepProcesses', defaultMessage: 'Could not keep the processes', description: "An error's title: keeping the processes an agent left running failed." })), () => call('session:settleLeftovers', projectPath, agentId, how))
    }
  },
  {
    id: 'session.stopBackgroundAndResume',
    name: msg({ id: 'shell.command.session.stopBackgroundAndResume', defaultMessage: 'Stop a Background Session and Resume It', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. It isn't in the menus or the palette: notifications and buttons run it by its name." }),
    category: 'session',
    // Only from the notification, which names the job and the conversation.
    internal: true,
    run: (projectPath?: unknown, agentId?: unknown, jobId?: unknown, sessionId?: unknown) => {
      if (typeof projectPath === 'string' && typeof agentId === 'string' && typeof jobId === 'string' && typeof sessionId === 'string')
        void actions.attempt(tr(msg({ id: 'shell.error.stopBackground', defaultMessage: 'Could not stop the background session', description: "An error's title: stopping an agent's background session failed." })), () => call('session:stopBackgroundAndResume', projectPath, agentId, jobId, sessionId))
    }
  },
  {
    id: 'session.resumeAfterClose',
    name: msg({ id: 'shell.command.session.resumeAfterClose', defaultMessage: 'Resume the Agents Running When Hive Closed', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. It isn't in the menus or the palette: notifications and buttons run it by its name." }),
    category: 'session',
    // Only from the notice that Hive closed unexpectedly (#984), which lists them.
    internal: true,
    run: () => void actions.attempt(tr(msg({ id: 'shell.error.resumeAfterClose', defaultMessage: 'Could not resume the agents', description: "An error's title: resuming the agents that were running when Hive closed unexpectedly failed." })), () => call('app:resumeAfterClose'))
  },
  {
    id: 'session.stopLeftAfterClose',
    name: msg({ id: 'shell.command.session.stopLeftAfterClose', defaultMessage: 'Stop What the Agents Started Before Hive Closed', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category: ends the processes the agents had started that still run after Hive closed unexpectedly. It isn't in the menus or the palette: notifications and buttons run it by its name." }),
    category: 'session',
    // Only from the notice that Hive closed unexpectedly (#987), which lists them.
    internal: true,
    run: () => void actions.attempt(tr(msg({ id: 'shell.error.stopLeftAfterClose', defaultMessage: 'Could not stop the processes', description: "An error's title: ending the processes the agents had started before Hive closed unexpectedly failed." })), () => call('app:stopLeftAfterClose'))
  },
  {
    id: 'session.resumeRestart',
    name: msg({ id: 'shell.command.session.resumeRestart', defaultMessage: 'Resume the Agents Working When Hive Closed', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category: resumes the agents that were working when Hive was last quit or restarted. It isn't in the menus or the palette: notifications and buttons run it by its name." }),
    category: 'session',
    // Only from the notice offering it (HI-1707), which lists them.
    internal: true,
    run: () => void actions.attempt(tr(msg({ id: 'shell.error.resumeRestart', defaultMessage: 'Could not resume the agents', description: "An error's title: resuming the agents that were working when Hive was last quit or restarted failed." })), () => call('app:resumeRestart'))
  },
  {
    id: 'session.dismissRestart',
    name: msg({ id: 'shell.command.session.dismissRestart', defaultMessage: "Don't Resume the Agents Working When Hive Closed", description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category: declines the offer to resume the agents that were working when Hive was last quit or restarted. It isn't in the menus or the palette: notifications and buttons run it by its name." }),
    category: 'session',
    // Only from the notice offering it (HI-1707).
    internal: true,
    run: () => void call('app:dismissRestart')
  },
  {
    id: 'session.applyPermissionModes',
    name: msg({ id: 'shell.command.session.applyPermissionModes', defaultMessage: 'Switch Running Agents to Their Permission Mode Settings', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category.' }),
    category: 'session',
    run: async () => {
      const r = await actions.attempt(tr(msg({ id: 'shell.error.switchModes', defaultMessage: 'Could not switch permission modes', description: "An error's title: switching running agents to their permission mode settings failed." })), () => call('session:applyModes'))
      if (!r) return
      if (r.switched.length) notify('success', tr(msg({ id: 'shell.modes.switched', defaultMessage: 'Permission mode switched', description: 'A notice after running agents were switched to their permission mode settings; the agents are listed under it.' })), r.switched.join('\n'))
      if (r.skipped.length) notify('warning', r.switched.length ? tr(msg({ id: 'shell.modes.someSkipped', defaultMessage: 'Some agents were not switched', description: 'A notice after switching permission modes: the agents listed under it were not switched.' })) : tr(msg({ id: 'shell.modes.noneSwitched', defaultMessage: 'Permission mode not switched', description: 'A notice after switching permission modes: none could be switched; why is listed under it.' })), r.skipped.join('\n'))
      if (!r.switched.length && !r.skipped.length) notify('info', tr(msg({ id: 'shell.modes.nothing', defaultMessage: 'Nothing to switch', description: 'A notice: every running agent already has its permission mode.' })), tr(msg({ id: 'shell.modes.nothingDetail', defaultMessage: 'Every running agent is already in the mode its settings ask for.', description: 'More in the notice that there was nothing to switch.' })))
    }
  },
  { id: 'session.focusTerminal', name: msg({ id: 'shell.command.session.focusTerminal', defaultMessage: 'Focus Session Terminal', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category.' }), category: 'session', keybinding: 'Mod+`', when: hasProject, run: () => focusTerminal() }, // i18n-ignore: a shortcut's keys
  { id: 'agent.add', name: msg({ id: 'shell.command.agent.add', defaultMessage: 'Add Agent', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category.' }), category: 'session', keybinding: 'Mod+Alt+Shift+N', when: hasProject, run: (path?: string) => void actions.quickAddAgent(path ?? get().selectedProject) }, // i18n-ignore: a shortcut's keys
  { id: 'agent.addWith', name: msg({ id: 'shell.command.agent.addWith', defaultMessage: 'Add Agent…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. The … says it opens a dialog first: keep it.' }), category: 'session', when: hasProject, run: (path?: string) => set({ addAgentFor: path ?? get().selectedProject }) },
  {
    id: 'agent.settings',
    name: msg({ id: 'shell.command.agent.settings', defaultMessage: 'Agent Settings…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. The … says it opens a dialog first: keep it.' }),
    category: 'session',
    when: () => !!selected()?.agents.length,
    // From a notice (#702: an agent to rename), that agent; from the palette, the focused one.
    run: (path?: string, agentId?: string) => {
      const p = path ? get().workspace?.projects.find((x) => x.path === path) : selected()
      const id = agentId ?? (p ? focusedAgentId(p) : null)
      if (p && id && p.agents.some((a) => a.id === id)) set({ agentSettingsFor: { project: p.path, agentId: id } })
    }
  },
  {
    id: 'agent.hooks',
    name: msg({ id: 'shell.command.agent.hooks', defaultMessage: 'Agent Hooks…', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category: opens the focused agent's Hooks dialog (the hooks its session has, and what Hive received). The … says it opens a dialog first: keep it." }),
    category: 'session',
    when: () => !!selected()?.agents.length,
    run: (path?: string, agentId?: string) => {
      const p = path ? get().workspace?.projects.find((x) => x.path === path) : selected()
      const id = agentId ?? (p ? focusedAgentId(p) : null)
      if (p && id && p.agents.some((a) => a.id === id)) set({ hooksFor: { project: p.path, agentId: id } })
    }
  },
  {
    id: 'agent.menu',
    name: msg({ id: 'shell.command.agent.menu', defaultMessage: 'Agent Menu…', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category: opens the focused agent's ⋯ menu on its pane (everything its pane header doesn't show). The … says it opens a menu first: keep it." }),
    category: 'session',
    when: () => !!selected()?.agents.length,
    run: () => {
      const p = selected()
      const id = p ? focusedAgentId(p) : null
      if (!p || !id) return
      revealAgent(p, id)
      requestStripMenu(p.path, 'agentMenu', id)
    }
  },
  {
    id: 'agent.next',
    name: msg({ id: 'shell.command.agent.next', defaultMessage: 'Focus Next Agent', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category.' }),
    category: 'session',
    keybinding: 'Mod+Alt+]', // i18n-ignore: a shortcut's keys
    when: hasProject,
    run: () => cycleAgent(1)
  },
  { id: 'agent.previous', name: msg({ id: 'shell.command.agent.previous', defaultMessage: 'Focus Previous Agent', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category.' }), category: 'session', keybinding: 'Mod+Alt+[', when: hasProject, run: () => cycleAgent(-1) }, // i18n-ignore: a shortcut's keys
  { id: 'agent.moveLeft', name: msg({ id: 'shell.command.agent.moveLeft', defaultMessage: 'Move Agent Left', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category.' }), category: 'session', keybinding: 'Mod+Alt+Shift+ArrowLeft', when: canMove, run: () => actions.nudgeAgent(-1) }, // i18n-ignore: a shortcut's keys
  { id: 'agent.moveRight', name: msg({ id: 'shell.command.agent.moveRight', defaultMessage: 'Move Agent Right', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category.' }), category: 'session', keybinding: 'Mod+Alt+Shift+ArrowRight', when: canMove, run: () => actions.nudgeAgent(1) }, // i18n-ignore: a shortcut's keys
  { id: 'agent.moveUp', name: msg({ id: 'shell.command.agent.moveUp', defaultMessage: 'Move Agent Up', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category: moves the agent's pane one cell up in a grid layout." }), category: 'session', keybinding: 'Mod+Alt+Shift+ArrowUp', when: gridShown, run: () => actions.moveAgentPane('up') }, // i18n-ignore: a shortcut's keys
  { id: 'agent.moveDown', name: msg({ id: 'shell.command.agent.moveDown', defaultMessage: 'Move Agent Down', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category: moves the agent's pane one cell down in a grid layout." }), category: 'session', keybinding: 'Mod+Alt+Shift+ArrowDown', when: gridShown, run: () => actions.moveAgentPane('down') }, // i18n-ignore: a shortcut's keys
  { id: 'agent.nextPage', name: msg({ id: 'shell.command.agent.nextPage', defaultMessage: 'Next Agent Page', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category.' }), category: 'session', keybinding: 'Mod+Alt+PageDown', when: () => pageCount() > 1, run: () => cyclePage(1) }, // i18n-ignore: a shortcut's keys
  { id: 'agent.previousPage', name: msg({ id: 'shell.command.agent.previousPage', defaultMessage: 'Previous Agent Page', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category.' }), category: 'session', keybinding: 'Mod+Alt+PageUp', when: () => pageCount() > 1, run: () => cyclePage(-1) }, // i18n-ignore: a shortcut's keys
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): CommandDef => ({ id: `agent.focus${n}`, name: msg({ id: 'shell.command.agent.focusN', defaultMessage: 'Focus Agent {n}', description: "A command per agent number (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. {n} is the agent's place in the strip, 1 to 9." }), nameValues: { n }, category: 'session', keybinding: `Mod+${n}`, // i18n-ignore: a shortcut's keys
    when: () => (selected()?.agents.length ?? 0) >= n, run: () => focusAgentN(n) })),
  layoutCommand('single', 1),
  layoutCommand('columns2', 2),
  layoutCommand('columns3', 3),
  layoutCommand('grid', 4),
  layoutCommand('grid6', 5),
  // The Session tab's Panes | Tiles toggle (#975), remembered per project; no default shortcut (Ctrl+Alt+letters are AltGr's).
  {
    id: 'session.toggleView',
    name: msg({ id: 'shell.command.session.toggleView', defaultMessage: 'Switch Between Panes and Tiles', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category: switches the Session tab between Panes (the agents' terminals) and Tiles (a small tile per agent). Panes and Tiles: as the toggle says them." }),
    category: 'session',
    when: hasProject,
    run: () => {
      const p = selected()
      if (!p) return
      showView('projects')
      setProjectTab(p.path, 'session')
      void actions.setSessionView(p.path, projectSessionView(p.config, get().settings) === 'panes' ? 'tiles' : 'panes')
    }
  },
  // From an agent's focus view back to the grid of tiles (#976). Esc does it too, outside the terminal (in it, Esc is the CLI's).
  {
    id: 'session.backToTiles',
    name: msg({ id: 'shell.command.session.backToTiles', defaultMessage: 'Back to Tiles', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category: from one agent's focus view (its pane large) back to the Tiles view's grid of tiles." }),
    category: 'session',
    keybinding: 'Mod+Alt+Escape', // i18n-ignore: a shortcut's keys
    when: () => !!tileFocusOf(selected()),
    run: () => {
      const p = selected()
      if (p) focusTileAfter(closeTile(p))
    }
  },
  { id: 'session.archive', name: msg({ id: 'shell.command.session.archive', defaultMessage: 'Archive Session and Start New…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. The … says it opens a dialog first: keep it.' }), category: 'session', when: hasProject, run: () => actions.archiveCurrent() },
  // Every agent of the project at once, after one confirmation (#216); the menus and the palette say how many (#275).
  {
    id: 'session.startFreshIdle',
    name: msg({ id: 'shell.command.session.startFreshIdle', defaultMessage: 'Start Fresh (Idle Agents)…', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category (#1437): gives each idle running agent of the project a new conversation, after one question. The … says it opens a dialog first: keep it." }),
    category: 'session',
    // The nudge's button passes its project (in this window: main sends it to the window that has it), whatever is
    // selected; otherwise the selected one, with an agent running.
    when: (projectPath?: unknown) => (typeof projectPath === 'string' ? !!get().workspace?.projects.some((p) => p.path.toLowerCase() === projectPath.toLowerCase()) : hasProject() && !!selected()?.agents.some((a) => a.live)),
    run: (projectPath?: unknown) => {
      const path = typeof projectPath === 'string' ? projectPath : selected()?.path
      if (path) void actions.startFreshIdle(path)
    }
  },
  { id: 'session.startNewAll', name: msg({ id: 'shell.command.session.startNewAll', defaultMessage: 'Start New (All)…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. The … says it opens a dialog first: keep it.' }), category: 'session', when: () => hasProject() && !!selected()?.agents.length, liveLabel: () => batchLabel(msg({ id: 'shell.command.session.startNewAllLive', defaultMessage: '{several, select, yes {Start New ({n})…} other {Start New…}}', description: 'The command that gives every agent of the project a new session, as the menus and the palette show it: with several agents, how many it acts on ({n}). The … says it asks first: keep it.' }), 'startNew'), run: () => void actions.startNewAll(get().selectedProject!) },
  // The project's agents and layout as a template (#126); loading one and adding one of its agents open the agent strip's menus (#286).
  { id: 'template.save', name: msg({ id: 'shell.command.template.save', defaultMessage: 'Save Agents as Template…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. The … says it opens a dialog first: keep it.' }), category: 'session', when: () => hasProject() && !!selected()?.agents.length, run: () => void actions.saveTemplate(get().selectedProject!) },
  { id: 'template.load', name: msg({ id: 'shell.command.template.load', defaultMessage: 'Load Template…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. The … says it opens a dialog first: keep it.' }), category: 'session', when: () => !!selected(), run: () => stripMenu('loadTemplate') },
  { id: 'template.addAgent', name: msg({ id: 'shell.command.template.addAgent', defaultMessage: 'Add Agent from Template…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. The … says it opens a dialog first: keep it.' }), category: 'session', when: () => !!selected(), run: () => stripMenu('addFromTemplate') },
  { id: 'session.archiveAll', name: msg({ id: 'shell.command.session.archiveAll', defaultMessage: 'Archive and Start New (All)…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. The … says it opens a dialog first: keep it.' }), category: 'session', when: () => hasProject() && !!batchCounts(selected()?.agents ?? []).archive, liveLabel: () => batchLabel(msg({ id: 'shell.command.session.archiveAllLive', defaultMessage: '{several, select, yes {Archive and Start New ({n})…} other {Archive and Start New…}}', description: "The command that archives the agents' sessions and starts new ones, as the menus and the palette show it: with several agents, how many it acts on ({n}). The … says it asks first: keep it." }), 'archive'), run: () => void actions.startNewAll(get().selectedProject!, true) },
  // Remove All (#291): every agent of the project after one question; user-only (not in the Agent API).
  {
    id: 'session.removeAll',
    name: msg({ id: 'shell.command.session.removeAll', defaultMessage: 'Remove All Agents…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. The … says it opens a dialog first: keep it.' }),
    category: 'session',
    when: () => hasProject() && !!selected()?.agents.length,
    liveLabel: () => tr(msg({ id: 'shell.command.session.removeAllLive', defaultMessage: '{n, plural, one {Remove Agent…} other {Remove All Agents (#)…}}', description: "The command that removes the project's agents, as the menus and the palette show it: how many it removes. The … says it asks first: keep it." }), { n: selected()?.agents.length ?? 0 }),
    run: () => void actions.removeAllAgents(get().selectedProject!)
  },
  { id: 'view.projects', name: msg({ id: 'shell.command.view.projects', defaultMessage: 'Show Projects', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', keybinding: 'Mod+Shift+E', run: () => setActivity('projects') }, // i18n-ignore: a shortcut's keys
  { id: 'view.overview', name: msg({ id: 'shell.command.view.overview', defaultMessage: 'Show Workspace Overview', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', keybinding: 'Mod+Shift+O', run: () => setActivity('overview') }, // i18n-ignore: a shortcut's keys
  { id: 'view.activity', name: msg({ id: 'shell.command.view.activity', defaultMessage: 'Show Activity', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category: Activity's workspace level, what every project's agents run now." }), category: 'view', run: () => setActivity('activity') },
  { id: 'view.performance', name: msg({ id: 'shell.command.view.performance', defaultMessage: 'Show Performance', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', run: () => setActivity('performance') },
  { id: 'view.board', name: msg({ id: 'shell.command.view.board', defaultMessage: 'Show Task Board', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', keybinding: 'Mod+Shift+J', run: () => setActivity('board') }, // i18n-ignore: a shortcut's keys
  {
    id: 'task.new',
    name: msg({ id: 'shell.command.task.new', defaultMessage: 'New Card…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Tasks category. The … says it opens a dialog first: keep it.' }),
    category: 'tasks',
    keybinding: 'Mod+Alt+T', // i18n-ignore: a shortcut's keys
    when: hasWorkspace,
    // For the selected project when its Tasks tab or the Session tab is shown, else the board's filter.
    run: () => {
      const s = get()
      const p = s.activity === 'projects' ? selected()?.name : s.boardProject
      set({ taskOpen: { project: p ?? '' } })
    }
  },
  {
    id: 'task.exportBoard',
    name: EXPORT_BOARD,
    category: 'tasks',
    when: hasWorkspace,
    run: () => void exportBoard()
  },
  {
    id: 'task.reviewSetAside',
    name: msg({ id: 'shell.command.task.reviewSetAside', defaultMessage: 'Review Cards Made by an Older Hive…', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Tasks category: opens the dialog listing cards an older version of Hive saved, set aside, to add each to the board or discard it. The … says it opens a dialog first: keep it." }),
    category: 'tasks',
    when: hasWorkspace,
    run: () => set({ setAsideOpen: true })
  },
  {
    id: 'task.undoArchive',
    name: msg({ id: 'shell.command.task.undoArchive', defaultMessage: 'Undo Archive', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Tasks category. It isn't in the menus or the palette: notifications and buttons run it by its name." }),
    category: 'tasks',
    // The Undo of an Archived n cards toast (#351): its batch back where it was.
    internal: true,
    run: (id: string) => void unarchiveBatch(id)
  },
  {
    id: 'agent.show',
    name: msg({ id: 'shell.command.agent.show', defaultMessage: 'Show Agent', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. It isn't in the menus or the palette: notifications and buttons run it by its name." }),
    category: 'session',
    // From a notification or the tray, which name the agent; the Assistant's opens its panel.
    internal: true,
    run: (path?: unknown, agentId?: unknown) => {
      if (typeof path === 'string' && isAssistantPath(path)) return setAssistantOpen(true)
      const p = get().workspace?.projects.find((x) => x.path === path)
      if (!p || typeof agentId !== 'string') return
      actions.selectProject(p.path)
      showAgent(p, agentId)
      setProjectTab(p.path, 'session')
    }
  },
  {
    id: 'slot.releaseHeld',
    name: msg({ id: 'shell.command.slot.releaseHeld', defaultMessage: 'Release a Held Slot', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. It isn't in the menus or the palette: a notice's button runs it by its name (HI-2309), asking first whether to release a slot that Windows' idle Sandbox broker holds." }),
    category: 'session',
    // The notice that a slot is held only by an idle broker (HI-2309): Release Slot…'s question for it.
    internal: true,
    run: (path?: unknown, slot?: unknown) => {
      if (typeof path === 'string' && typeof slot === 'string') void actions.releaseHeldSlot(path, slot)
    }
  },
  {
    id: 'notice.openTarget',
    name: msg({ id: 'shell.command.notice.openTarget', defaultMessage: 'Open What a Notification Is About', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Session category. It isn't in the menus or the palette: a click on a notification runs it by its name, to show the agent's pane or the card it names." }),
    category: 'session',
    // A notice's target (HI-1961), in the window that has its project: notice:action brings it here.
    internal: true,
    run: (target?: unknown) => {
      if (target && typeof target === 'object') showNoticeTarget(target as ToastTarget)
    }
  },
  {
    id: 'project.unusedWorktrees',
    name: msg({ id: 'shell.command.project.unusedWorktrees', defaultMessage: 'Show Unused Worktrees', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Project category. It isn't in the menus or the palette: notifications and buttons run it by its name." }),
    category: 'project',
    // From a notification or Storage, which name the project (#353).
    internal: true,
    run: (path?: unknown) => {
      const p = get().workspace?.projects.find((x) => x.path === path)
      if (!p) return
      actions.selectProject(p.path)
      showView('projects')
      showUnusedWorktrees(p.path)
    }
  },
  { id: 'view.notes', name: msg({ id: 'shell.command.view.notes', defaultMessage: 'Show Shared Notes', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', keybinding: 'Mod+Shift+H', run: () => setActivity('notes') }, // i18n-ignore: a shortcut's keys
  { id: 'view.skills', name: msg({ id: 'shell.command.view.skills', defaultMessage: 'Show Skills', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', keybinding: 'Mod+Shift+K', run: () => setActivity('skills') }, // i18n-ignore: a shortcut's keys
  { id: 'view.templates', name: msg({ id: 'shell.command.view.templates', defaultMessage: 'Show Templates', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', run: () => setActivity('templates') },
  { id: 'view.mcp', name: msg({ id: 'shell.command.view.mcp', defaultMessage: 'Show MCP Servers', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', keybinding: 'Mod+Shift+M', run: () => setActivity('mcp') }, // i18n-ignore: a shortcut's keys
  { id: 'view.assistant', name: msg({ id: 'shell.command.view.assistant', defaultMessage: 'Show Hive Assistant View', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', run: () => setActivity('assistant') },
  { id: 'view.assistantConversations', name: msg({ id: 'shell.command.view.assistantConversations', defaultMessage: 'Show Assistant Conversations', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', run: () => showAssistantView('conversations') },
  { id: 'view.modes', name: msg({ id: 'shell.command.view.modes', defaultMessage: 'Show Assistant Modes', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', run: () => showAssistantView('modes') },
  { id: 'view.assistantImages', name: msg({ id: 'shell.command.view.assistantImages', defaultMessage: 'Show Assistant Attachments', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', run: () => showAssistantView('images') },
  { id: 'view.assistantJournal', name: msg({ id: 'shell.command.view.assistantJournal', defaultMessage: 'Show Assistant Journal', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', run: () => showAssistantView('journal') },
  { id: 'assistant.toggle', name: msg({ id: 'shell.command.assistant.toggle', defaultMessage: 'Toggle Hive Assistant', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Assistant category.' }), category: 'assistant', keybinding: 'Mod+Alt+I', when: hasWorkspace, run: () => setAssistantOpen(!get().assistantOpen) }, // i18n-ignore: a shortcut's keys
  { id: 'assistant.settings', name: msg({ id: 'shell.command.assistant.settings', defaultMessage: 'Assistant Settings…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Assistant category. The … says it opens a dialog first: keep it.' }), category: 'assistant', when: hasWorkspace, run: () => set({ assistantSettingsOpen: true }) },
  {
    id: 'assistant.moveSide',
    name: msg({ id: 'shell.command.assistant.moveSide', defaultMessage: 'Move Assistant Panel Left or Right', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Assistant category.' }),
    liveLabel: () => (assistantOnLeft(get()) ? tr(msg({ id: 'shell.command.assistant.moveRight', defaultMessage: 'Move Assistant Panel to the Right', description: "The command that moves the Assistant's panel, while it is on the left." })) : tr(msg({ id: 'shell.command.assistant.moveLeft', defaultMessage: 'Move Assistant Panel to the Left', description: "The command that moves the Assistant's panel, while it is on the right." }))),
    category: 'assistant',
    run: () => void setAssistantSide(assistantOnLeft(get()) ? 'right' : 'left')
  },
  {
    id: 'progress.toggle',
    name: msg({ id: 'shell.command.progress.toggle', defaultMessage: 'Toggle Progress Panel', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }),
    category: 'view',
    keybinding: 'Mod+Alt+P', // i18n-ignore: a shortcut's keys
    when: () => hasWorkspace() && get().settings?.general.progressPanel !== false,
    run: () => setProgressOpen(!progressIsOpen())
  },
  // The answer to a question the Assistant waits on (its card in the panel, or a notification).
  { id: 'assistant.answer', name: msg({ id: 'shell.command.assistant.answer', defaultMessage: 'Answer the Hive Assistant', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Assistant category. It isn't in the menus or the palette: notifications and buttons run it by its name." }), category: 'assistant', internal: true, run: (id: string, yes: boolean) => void call('assistant:answer', id, yes) },
  {
    id: 'assistant.start',
    name: msg({ id: 'shell.command.assistant.start', defaultMessage: 'Start the Hive Assistant', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Assistant category.' }),
    category: 'assistant',
    when: () => !!get().workspace?.assistant && !get().workspace?.assistant?.agents[0]?.live,
    run: () => {
      setAssistantOpen(true)
      const a = get().workspace?.assistant
      if (a) void actions.newSession(a.path, a.agents[0]?.id)
    }
  },
  { id: 'view.toggleSidebar', name: msg({ id: 'shell.command.view.toggleSidebar', defaultMessage: 'Toggle Sidebar', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', keybinding: 'Mod+B', run: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })) }, // i18n-ignore: a shortcut's keys
  { id: 'view.compactSidebar', name: msg({ id: 'shell.command.view.compactSidebar', defaultMessage: 'Toggle Compact Sidebar', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', keybinding: 'Mod+Alt+B', run: () => toggleCompactSidebar() }, // i18n-ignore: a shortcut's keys
  { id: 'view.notifications', name: msg({ id: 'shell.command.view.notifications', defaultMessage: 'Show Notifications', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', keybinding: 'Mod+Alt+U', run: () => set({ showNotifications: true, unread: 0 }) }, // i18n-ignore: a shortcut's keys
  { id: 'view.zoomIn', name: msg({ id: 'shell.command.view.zoomIn', defaultMessage: 'Zoom In', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', keybinding: 'Mod+=', run: () => call('window:zoom', 'in') }, // i18n-ignore: a shortcut's keys
  { id: 'view.zoomOut', name: msg({ id: 'shell.command.view.zoomOut', defaultMessage: 'Zoom Out', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', keybinding: 'Mod+-', run: () => call('window:zoom', 'out') }, // i18n-ignore: a shortcut's keys
  { id: 'view.zoomReset', name: msg({ id: 'shell.command.view.zoomReset', defaultMessage: 'Reset Zoom', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', keybinding: 'Mod+0', run: () => call('window:zoom', 'reset') }, // i18n-ignore: a shortcut's keys
  { id: 'view.fullScreen', name: msg({ id: 'shell.command.view.fullScreen', defaultMessage: 'Toggle Full Screen', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', keybinding: 'F11', run: () => call('window:toggleFullScreen') },
  { id: 'view.alwaysOnTop', name: msg({ id: 'shell.command.view.alwaysOnTop', defaultMessage: 'Always on Top', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the View category.' }), category: 'view', keybinding: 'Mod+Alt+O', checked: () => get().alwaysOnTop, run: () => toggleAlwaysOnTop() }, // i18n-ignore: a shortcut's keys
  { id: 'view.devTools', name: msg({ id: 'shell.command.view.devTools', defaultMessage: 'Toggle Developer Tools', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Developer category.' }), category: 'developer', keybinding: 'Mod+Shift+I', run: () => call('window:toggleDevTools') }, // i18n-ignore: a shortcut's keys
  { id: 'help.devConsole', name: msg({ id: 'shell.command.help.devConsole', defaultMessage: 'Developer Console', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Developer category.' }), category: 'developer', keybinding: 'Mod+Alt+J', when: hasWorkspace, hidden: () => !get().settings?.advanced.showDeveloperFeatures, tip: () => tr(msg({ id: 'shell.tip.help.devConsole', defaultMessage: 'What each CLI sends Hive, next to what Hive made of it, in a window of its own', description: 'What a command does, on hover in the menus.' })), run: () => call('console:open') }, // i18n-ignore: a shortcut's keys
  { id: 'console.showCapture', name: msg({ id: 'shell.command.console.showCapture', defaultMessage: 'Show Capture in Folder', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Developer category: shows a capture of the developer console's flight recorder in File Explorer. It isn't in the menus or the palette: notifications and buttons run it by its name." }), category: 'developer', internal: true, run: (name: string) => typeof name === 'string' && void call('console:showRecording', name) },
  { id: 'view.reload', name: msg({ id: 'shell.command.view.reload', defaultMessage: 'Reload Window', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Developer category.' }), category: 'developer', run: () => void actions.saveUnsavedFirst('reload the window' /* i18n-ignore: actions.ts slots the phrase into its sentence (E5b) */).then((ok) => ok && location.reload()) },
  { id: 'notes.open', name: msg({ id: 'shell.command.notes.open', defaultMessage: 'Open Shared Note', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Notes category. It isn't in the menus or the palette: notifications and buttons run it by its name." }), category: 'notes', internal: true, run: (path: string) => { showView('notes'); set({ selectedNote: path }) } },
  { id: 'mcp.import', name: msg({ id: 'shell.command.mcp.import', defaultMessage: 'Copy Project MCP Servers to Workspace', description: "A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the MCP category. It isn't in the menus or the palette: notifications and buttons run it by its name." }), category: 'mcp', internal: true, run: (path: string, names: string[]) => actions.importProjectMcp(path, names) },
  { id: 'help.agentSetup', name: msg({ id: 'shell.command.help.agentSetup', defaultMessage: 'Provider Setup…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Help category. The … says it opens a dialog first: keep it.' }), category: 'help', run: (provider?: unknown) => set({ setupOpen: typeof provider === 'string' ? provider : true }) },
  { id: 'help.checkProviders', name: msg({ id: 'shell.command.help.checkProviders', defaultMessage: 'Check Coding Agents for Updates', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Help category.' }), category: 'help', run: () => actions.refreshProviders() },
  { id: 'help.docs', name: msg({ id: 'shell.command.help.docs', defaultMessage: 'Documentation', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Help category.' }), category: 'help', keybinding: 'F1', run: () => { set({ docsPage: 'guide' }); setActivity('docs') } },
  { id: 'help.api', name: msg({ id: 'shell.command.help.api', defaultMessage: 'Agent API Reference', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Help category.' }), category: 'help', run: () => { set({ docsPage: 'api' }); setActivity('docs') } },
  { id: 'help.shortcuts', name: msg({ id: 'shell.command.help.shortcuts', defaultMessage: 'Keyboard Shortcuts', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Help category.' }), category: 'help', keybinding: 'Mod+K Mod+S', run: () => set({ shortcutsOpen: true }) }, // i18n-ignore: a shortcut's keys
  { id: 'help.tips', name: msg({ id: 'shell.command.help.tips', defaultMessage: 'Tips…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Help category. The … says it opens a dialog first: keep it.' }), category: 'help', run: () => set({ tipsOpen: true }) },
  { id: 'help.releaseNotes', name: msg({ id: 'shell.command.help.releaseNotes', defaultMessage: 'Release Notes', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Help category.' }), category: 'help', run: () => { set({ docsPage: 'changelog' }); setActivity('docs') } },
  // Help → Improve This Translation (#795): how to fix a translation or add a language, in CONTRIBUTING on GitHub.
  {
    id: 'help.improveTranslation',
    name: msg({ id: 'shell.command.help.improveTranslation', defaultMessage: 'Improve This Translation', description: 'A command (the Help menu, the command palette), in the Help category: opens the guide for translators, on GitHub, to fix a translation or add a language.' }),
    category: 'help',
    tip: () => tr(msg({ id: 'shell.tip.help.improveTranslation', defaultMessage: 'How to fix a translation, or add a language, on GitHub', description: 'What a command does, on hover in the menus.' })),
    run: () => call('app:openExternal', TRANSLATING_URL)
  },
  { id: 'help.logs', name: msg({ id: 'shell.command.help.logs', defaultMessage: 'Open Logs Folder', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Help category.' }), category: 'help', run: () => call('app:openLogs') },
  {
    id: 'help.restoreBoard09',
    name: msg({ id: 'shell.command.help.restoreBoard09', defaultMessage: 'Restore the 0.9 Board Backup…', description: "A command (the Help menu, the command palette), in the Help category: puts back the copy of the workspace's board Hive kept when it upgraded the board to 1.0, for going back to Hive 0.9. The … says it asks first: keep it." }),
    category: 'help',
    when: () => hasWorkspace() && !!get().boardState?.backup09,
    tip: () => tr(msg({ id: 'shell.tip.help.restoreBoard09', defaultMessage: 'Puts back the board as it was before its upgrade to 1.0, to go back to Hive 0.9', description: 'What a command does, on hover in the menus.' })),
    run: () => void restoreBoard09()
  },
  { id: 'help.diagnostics', name: msg({ id: 'shell.command.help.diagnostics', defaultMessage: 'Copy Diagnostics…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Help category. The … says it opens a dialog first: keep it.' }), category: 'help', run: () => set({ diagnosticsOpen: true }) },
  { id: 'help.about', name: msg({ id: 'shell.command.help.about', defaultMessage: 'About {app}', description: "A command (the Help menu, the command palette), in the Help category. {app} is Hive's name." }), nameValues: { app: APP_NAME }, category: 'help', run: () => set({ aboutOpen: true }) },
  { id: 'help.checkUpdates', name: msg({ id: 'shell.command.help.checkUpdates', defaultMessage: 'Check for Updates…', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Help category. The … says it opens a dialog first: keep it.' }), category: 'help', run: () => checkForUpdates() },
  { id: 'update.show', name: msg({ id: 'shell.command.update.show', defaultMessage: 'Show Hive Update', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Help category.' }), category: 'help', when: () => ['available', 'downloading', 'ready'].includes(get().update?.status ?? ''), run: () => set({ updateOpen: true }) },
  { id: 'update.install', name: msg({ id: 'shell.command.update.install', defaultMessage: 'Restart and Update Hive', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Help category.' }), category: 'help', when: () => get().update?.status === 'ready', run: () => call('update:install') },
  // Pausing the team before an update (HI-2081): every open workspace's lanes, wakes and hand-outs held until it resumes.
  { id: 'team.pause', name: msg({ id: 'shell.command.team.pause', defaultMessage: 'Pause the Team', description: "A command (the command palette, Settings → Keyboard Shortcuts), in the Help category (HI-2081): before an update, Hive starts no lane card, wakes no agent with card events and gives no reviews out in every open workspace, and tells each running agent to park (finish its turn, end its runs, commit). The Progress panel's Lanes shows what still runs." }), category: 'help', when: () => hasWorkspace() && !workspacePaused(get().workspace?.path), run: () => void pauseTheTeam() },
  { id: 'team.resume', name: msg({ id: 'shell.command.team.resume', defaultMessage: 'Resume the Team', description: 'A command (the command palette, Settings → Keyboard Shortcuts), in the Help category (HI-2081): lifts the pause of every open workspace, so lanes start their cards and agents are woken again.' }), category: 'help', when: () => hasWorkspace() && workspacePaused(get().workspace?.path), run: () => void resumeTheTeam() },
  { id: 'update.releaseNotes', name: msg({ id: 'shell.command.update.releaseNotes', defaultMessage: "What's New in Hive", description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the Help category.' }), category: 'help', run: (version?: unknown) => openReleaseNotes(typeof version === 'string' ? version : get().appInfo?.version) },
  // As the window's X: with several open, it closes this one (stopping its workspace's agents); the last one goes to the tray or quits.
  { id: 'window.close', name: msg({ id: 'shell.command.window.close', defaultMessage: 'Close Window', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the File category.' }), category: 'file', keybinding: 'Mod+Shift+W', tip: () => (severalWindows() ? tr(msg({ id: 'shell.tip.window.closeSeveral', defaultMessage: "Close this window and stop its workspace's agents", description: 'What a command does, on hover in the menus. With several windows open.' })) : get().settings?.general.closeToTray ? tr(msg({ id: 'shell.tip.window.closeToTray', defaultMessage: 'Close the window; Hive keeps running in the tray', description: 'What a command does, on hover in the menus. With one window, and Close to tray on.' })) : tr(msg({ id: 'shell.tip.window.closeQuit', defaultMessage: 'Close the window and quit Hive', description: 'What a command does, on hover in the menus. With one window, and Close to tray off.' }))), run: () => call('window:close') }, // i18n-ignore: a shortcut's keys
  {
    id: 'app.quit',
    name: msg({ id: 'shell.command.app.quit', defaultMessage: 'Exit', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the File category.' }),
    category: 'file',
    keybinding: 'Mod+Q', // i18n-ignore: a shortcut's keys
    liveLabel: () => (severalWindows() ? tr(msg({ id: 'shell.command.app.quitAll', defaultMessage: 'Exit Hive (all windows)', description: "The File menu's Exit, with several windows open: it closes them all." })) : tr(msg({ id: 'shell.command.app.quit', defaultMessage: 'Exit', description: 'A command (the menus, the command palette, Settings → Keyboard Shortcuts), in the File category.' }))),
    tip: () => (severalWindows() ? tr(msg({ id: 'shell.tip.app.quitAll', defaultMessage: 'Close all {n} windows and stop the agents in every workspace', description: 'What a command does, on hover in the menus. {n} is how many windows are open (2 or more).' }), { n: get().windowCount }) : tr(msg({ id: 'shell.tip.app.quit', defaultMessage: 'Quit Hive', description: 'What a command does, on hover in the menus.' }))),
    run: () => call('app:quit')
  }
]

/** Every command: its `label` reads its name in the language shown, each time. */
export const commands: Command[] = COMMAND_DEFS.map((d) => Object.defineProperty(d as Command, 'label', { get: () => tr(d.name, d.nameValues), enumerable: true }))

export function runCommand(id: string, ...args: unknown[]): void {
  const c = commands.find((x) => x.id === id)
  if (!c || c.hidden?.()) return
  if (c.when && !c.when(...args)) return
  // Tips skip what the user already does.
  noteCommandUsed(id)
  void Promise.resolve(c.run(...args)).catch((e) => console.error(e))
}

/** Whether a project may override this command's shortcut. */
export function isProjectScoped(c: Pick<Command, 'category'>): boolean {
  return PROJECT_KEYBINDING_CATEGORIES.some((x) => x.toLowerCase() === c.category)
}

/** The shortcut a command has now: the selected project's override, the user's, or the default. */
export function commandKeybinding(id: string): string | undefined {
  const c = commands.find((x) => x.id === id)
  if (!c || c.internal) return undefined
  const s = get()
  const project = isProjectScoped(c) ? s.workspace?.projects.find((p) => p.path === s.selectedProject)?.config.keybindings : undefined
  return resolveKeybinding(id, c.keybinding, s.settings?.keybindings, project)
}

// Physical keys, so Shift and AltGr don't change what a combination is called (Ctrl+Shift+1 stays "1", not "!").
const CODE_KEYS: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space' // i18n-ignore: a shortcut's keys
}

/** A key event as a combination string ("Mod+Shift+P"), or '' for a lone modifier. */
export function eventToKey(e: KeyboardEvent): string {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return ''
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Mod') // i18n-ignore: a shortcut's keys
  if (e.altKey) parts.push('Alt') // i18n-ignore: a shortcut's keys
  if (e.shiftKey) parts.push('Shift') // i18n-ignore: a shortcut's keys
  const code = e.code ?? ''
  let key: string
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^Numpad\d$/.test(code)) key = code.slice(6)
  else if (CODE_KEYS[code]) key = CODE_KEYS[code]
  else {
    key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key // i18n-ignore: a shortcut's keys
    if (key === '+') key = '='
    if (key === '_') key = '-'
  }
  parts.push(key)
  return parts.join('+')
}

/** Every command that currently has a shortcut, with it. */
function bound(): { c: Command; key: string }[] {
  const out: { c: Command; key: string }[] = []
  for (const c of commands) {
    const key = commandKeybinding(c.id)
    if (key) out.push({ c, key: key.toUpperCase() })
  }
  return out
}

let chordPrefix: string | null = null
let chordTimer: number | undefined

/** Resolves a keyboard event to a command (supports two-step chords like "Mod+K Mod+S"). */
export function matchKeybinding(e: KeyboardEvent): Command | null {
  const key = eventToKey(e)
  if (!key) return null
  const norm = (k: string): string => k.toUpperCase()
  const all = bound()
  if (chordPrefix) {
    const full = `${chordPrefix} ${key}`
    chordPrefix = null
    window.clearTimeout(chordTimer)
    return all.find((b) => b.key === norm(full))?.c ?? null
  }
  const exact = all.find((b) => b.key === norm(key))
  if (exact) return exact.c
  if (all.some((b) => b.key.startsWith(norm(key) + ' '))) {
    chordPrefix = key
    chordTimer = window.setTimeout(() => (chordPrefix = null), 1500)
    e.preventDefault()
  }
  return null
}

/**
 * Whether the window's shortcuts take this key (without resolving it, so a chord isn't started or used up): a chord's next
 * key while one is pending, a whole binding, or a chord's first key. A view's own key handling (the tile grid's arrows)
 * steps aside for it.
 */
export function keyIsBound(e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return false
  const key = eventToKey(e)
  if (!key) return false
  if (chordPrefix) return true
  const norm = key.toUpperCase()
  return bound().some((b) => b.key === norm || b.key.startsWith(norm + ' '))
}

/**
 * Shortcuts an agent's terminal UI uses itself (Claude Code: Ctrl+B background task, Ctrl+K kill line…)
 * stay with the terminal. Each provider lists its own; outside a terminal, all of them count.
 */
export function terminalReserved(provider?: ProviderId): Set<string> {
  return new Set(provider ? providerDescriptor(provider).reservedKeys : PROVIDERS.flatMap((p) => p.reservedKeys))
}

/** Keys the terminal must pass through to Hive instead of the agent. Chords are not started from the terminal. */
export function isAppShortcut(e: KeyboardEvent, provider?: ProviderId, allKeysToCli = false): boolean {
  if (e.type !== 'keydown') return false
  const key = eventToKey(e)
  if (!key) return false
  // Every key to the CLI (#1292, Settings → Advanced) but the command palette's, so every command stays in reach. A
  // two-step palette shortcut: its first key starts the window's chord (matchKeybinding), its second completes it; any
  // other key goes to the CLI, and the chord its first key began is over.
  const takes = appTakesTerminalKey(key, { allKeysToCli, palette: commandKeybinding('palette.show'), reserved: terminalReserved(provider), bound: bound().map((b) => b.key), pending: chordPrefix })
  if (allKeysToCli && !takes && chordPrefix) {
    chordPrefix = null
    window.clearTimeout(chordTimer)
  }
  return takes
}
