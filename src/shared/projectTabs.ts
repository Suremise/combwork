import { agentMsg, say } from './agentText'
import { msg } from './i18n/msg'
import type { MemorySource } from './types'

/**
 * A project's tabs, in the order the tab strip shows them (#216), and the title bar's Project menu built from the same
 * list, so the menu can't fall behind the strip again. Each tab has a command, `project.tab.<id>` (commands.ts). Their
 * labels are messages, shown with tr() where the strip draws them. `more` (#1043): in the strip's More ▾ menu, not a tab
 * of its own, and with no Alt shortcut.
 */
export const PROJECT_TABS = [
  { id: 'session', label: msg({ id: 'project.tab.session', defaultMessage: 'Session', description: "A project's tab: its agents' terminals." }), icon: 'terminal' },
  { id: 'overview', label: msg({ id: 'project.tab.overview', defaultMessage: 'Overview', description: "A project's tab: its usage, cost and sessions in figures." }), icon: 'dashboard' },
  { id: 'performance', label: msg({ id: 'project.tab.performance', defaultMessage: 'Performance', description: "A project's tab: how its agents' turns perform." }), icon: 'pulse' },
  { id: 'tasks', label: msg({ id: 'project.tab.tasks', defaultMessage: 'Tasks', description: "A project's tab: its cards on the task board." }), icon: 'project' },
  { id: 'sessions', label: msg({ id: 'project.tab.sessions', defaultMessage: 'Sessions', description: "A project's tab: its sessions' transcripts." }), icon: 'history' },
  { id: 'files', label: msg({ id: 'project.tab.files', defaultMessage: 'Files', description: "A project's tab: its files." }), icon: 'files' },
  // Attachments (#387): its id is from when it showed only images, kept so tab settings and shortcuts carry over.
  { id: 'images', label: msg({ id: 'project.tab.attachments', defaultMessage: 'Attachments', description: "A project's tab: what was pasted or dropped into its sessions." }), icon: 'attach' },
  // Version Control (#1416; the Git view of #607): Workflow, then Changes, History, Branches & remotes and Merge queue. Its
  // id stays `changes` (saved tabs, `project.tab.changes`).
  { id: 'changes', label: msg({ id: 'project.tab.versionControl', defaultMessage: 'Version Control', description: "A project's tab (renamed from Git): its version control, workflow options, changes, history and branches. Glossary 2.1: Version Control (the tab)." }), icon: 'source-control' },
  // Activity (#1254): last of the main tabs, so the others keep their Alt keys.
  { id: 'activity', label: msg({ id: 'project.tab.activity', defaultMessage: 'Activity', description: "A project's tab: its live work as a tree, card → agent → session → turn → tool call, with subagents and processes." }), icon: 'type-hierarchy' },
  { id: 'memory', label: msg({ id: 'project.tab.memory', defaultMessage: 'Memory', description: "A project's tab: the instructions and memory files its agents read." }), icon: 'book', more: true },
  { id: 'skills', label: msg({ id: 'project.tab.skills', defaultMessage: 'Skills', description: "A project's tab: the skills its agents get." }), icon: 'sparkle', more: true },
  { id: 'templates', label: msg({ id: 'project.tab.templates', defaultMessage: 'Templates', description: "A project's tab: templates of agents and cards." }), icon: 'library', more: true },
  { id: 'mcp', label: msg({ id: 'project.tab.mcp', defaultMessage: 'MCP', description: "A project's tab: the MCP servers its agents get. Keep MCP." }), icon: 'plug', more: true },
  // The Preview (HI-3615): only while Settings → Advanced's switch is on; in the strip, after its main tabs, once the
  // project has a preview command (previewStrip), else here in More ▾ to set one up.
  { id: 'preview', label: msg({ id: 'project.tab.preview', defaultMessage: 'Preview', description: "A project's tab: its dev server's page, shown in a guarded view." }), icon: 'globe', more: true },
  { id: 'settings', label: msg({ id: 'project.tab.settings', defaultMessage: 'Settings', description: "A project's tab: its own settings." }), icon: 'settings' }
] as const

export type ProjectTab = (typeof PROJECT_TABS)[number]['id']

/**
 * The tabs the strip shows (#974): all but Settings, which opens from the project header's ⋯, the title bar's Project
 * menu and its command (Alt+0), and shows with no tab of the strip chosen.
 */
export const STRIP_TABS = PROJECT_TABS.filter((t) => t.id !== 'settings')

/** The strip's own tabs, Alt+1…9 in this order (#1043), and the ones in its More ▾ menu after them. */
export const MAIN_TABS = STRIP_TABS.filter((t) => !('more' in t))
export const MORE_TABS = STRIP_TABS.filter((t) => 'more' in t)

/**
 * What a new instructions file (CLAUDE.md, AGENTS.md…) starts with when Memory creates it: its agents read it, so it is
 * English whatever the window's language, under a heading and a line that name whom it applies to (HI-2667, its
 * `scope`): a project's file the project, a connection's that connection's agents in every project, the user's every
 * project.
 */
export const instructionsStarter = (project: string, provider: string, scope?: MemorySource['scope']): string => {
  if (scope === 'user') return `# ${say(USER_HEADING)}\n\n${say(USER_STARTER, { provider })}\n`
  if (scope) return `# ${scope.connection}\n\n${say(CONNECTION_STARTER, { provider })}\n`
  return `# ${project}\n\n${say(STARTER, { provider })}\n`
}

const STARTER = agentMsg({ id: 'contract.instructions.starterFor', text: 'Instructions for {provider} in this project.', note: "A new instructions file's first line under the project's name (Memory creates it). provider: the CLI's name (Claude Code)." })
const CONNECTION_STARTER = agentMsg({ id: 'contract.instructions.starterConnection', text: 'Instructions for {provider} agents on this connection, in every project.', note: "A connection's new instructions file's first line, under the connection's name (Memory creates it): its agents read it in every project. provider: the CLI's name (Claude Code)." })
const USER_HEADING = agentMsg({ id: 'contract.instructions.userHeading', text: 'All projects', note: "The heading of the user's own new instructions file (~/.claude/CLAUDE.md and the like), which applies in every project (Memory creates it)." })
const USER_STARTER = agentMsg({ id: 'contract.instructions.starterUser', text: 'Instructions for {provider} in every project.', note: "The user's own new instructions file's first line, under its heading (Memory creates it). provider: the CLI's name (Claude Code)." })

/** HI-3615: where the Preview tab is: in the strip (a preview command set), in More ▾ (none yet), or hidden (the switch off). */
export type PreviewTabPlace = 'strip' | 'more' | 'hidden'

/** The strip's tabs and More ▾'s, with the Preview tab where it is now (the static lists have it in More ▾). */
export function stripTabs(preview: PreviewTabPlace): { main: readonly (typeof STRIP_TABS)[number][]; more: readonly (typeof STRIP_TABS)[number][] } {
  const tab = STRIP_TABS.find((t) => t.id === 'preview')!
  const more = MORE_TABS.filter((t) => t.id !== 'preview' || preview === 'more')
  return { main: preview === 'strip' ? [...MAIN_TABS, tab] : MAIN_TABS, more }
}

/** The command that shows a tab. */
export const tabCommand = (id: ProjectTab): string => `project.tab.${id}`

/**
 * The title bar's Project menu: command ids, '-' for a separator. Its tabs are the strip's, in its order: the main tabs,
 * then More ▾'s, then Project Settings (#1043).
 */
export const PROJECT_MENU: string[] = [
  'project.toggleActive',
  'project.next',
  'project.previous',
  '-',
  'task.new',
  '-',
  'project.openExplorer',
  'project.openTerminal',
  '-',
  ...MAIN_TABS.map((t) => tabCommand(t.id)),
  '-',
  ...MORE_TABS.map((t) => tabCommand(t.id)),
  '-',
  tabCommand('settings'),
  '-',
  'project.remove'
]
