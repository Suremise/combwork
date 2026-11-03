import { Children, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { McpServerInfo, NoteFile, ProjectInfo, SkillInfo } from '@shared/types'
import { AgentsTable, agentsText } from './AgentsTable'
import { useLanes, type Lane } from '../laneSource'
import { agentLaunchSettings, agentProvider, modeOption } from '@shared/providers'
import { modeInEffect } from '@shared/cliOwnMode'
import { agentsToResume } from '@shared/resumeAll'
import { hooksMissingText, shownMergeSlot, shownStatusMessage } from '@shared/runtime'
import * as actions from '../actions'
import { call } from '../api'
import { commandKeybinding, runCommand } from '../commands'
import { get, notify, projectKeyOf, projectStarting, projectState, startingLabel, prompt, set, setProjectTab, toggleCompactSidebar, useStore } from '../store'
import { cx, formatKeybinding } from '../util'
import { Icon, IconButton, InfoTip, LoadFailed, OneLineTitle, SearchInput, StaleNote, StatusDot, STATUS_TEXT, Switch, Tooltip, useContextMenu, type MenuEntry } from './ui'
import { addSkill, deleteSkill, DeliveredSwitch, HiveSkillsWarning, restoreBundled, SKILL_LEVEL_TIP, skillDescription, SkillRow } from './Skills'
import { DialectsPanel } from './Dialects'
import { TemplatesPanel } from './Templates'
import { hasEditorDraftsUnder } from '../editorDrafts'
import { useInbox } from '../inbox'
import { useScopedLoad } from '../scopedLoad'
import { AssistantSidePanel } from './AssistantView'
import { McpSearch } from './McpServerPicker'
import { McpCatalogPanel } from './McpCatalog'
import { mcpServerShown, type McpFilter } from '@shared/agentMcp'
import { BoardPanel } from './Board'
import { WorkspaceOverviewPanel } from '../views/WorkspaceOverview'
import { PerformancePanel } from '../views/Performance'
import { WorkspaceActivityPanel } from '../views/WorkspaceActivity'
import { fmt, tr, tRich } from '@shared/i18n'
import { msg } from '@shared/i18n/msg'
import { WORKSPACE_NOTES_PATH, workspaceNotesPath } from '@shared/workspaceNotes'

/** Width of the compact Projects rail, and how narrow a drag has to go before the sidebar snaps to it. */
const RAIL_WIDTH = 48
const SNAP_WIDTH = 120

const M = {
  noWorkspace: msg({ id: 'assistant.sidebar.noWorkspace', defaultMessage: '{what, select, projects {Open a workspace to see its projects.} notes {Open a workspace to see its shared notes.} other {Open a workspace to see its MCP servers.}}', description: 'The sidebar with no workspace open (Projects, Shared Notes or MCP Servers).' }),
  openWorkspace: msg({ id: 'assistant.sidebar.openWorkspace', defaultMessage: 'Open Workspace', description: 'A button and the compact sidebar\'s tooltip: opens a workspace.' }),
  newWorkspace: msg({ id: 'assistant.sidebar.newWorkspace', defaultMessage: 'New Workspace', description: "A button with no workspace open: creates a workspace." }),
  newSession: msg({ id: 'assistant.sidebar.newSession', defaultMessage: 'New Session', description: "An item of a project's right-click menu in the Projects sidebar: starts a session." }),
  resumeLast: msg({ id: 'assistant.sidebar.resumeLast', defaultMessage: 'Resume Last Session', description: "An item of a project's right-click menu in the Projects sidebar." }),
  resumeAll: msg({ id: 'assistant.sidebar.resumeAll', defaultMessage: 'Resume All Agents', description: "An item of a project's right-click menu in the Projects sidebar: resumes every agent's session." }),
  stopAll: msg({ id: 'assistant.sidebar.stopAll', defaultMessage: 'Stop All Agents', description: "A project's right-click menu, with more than one agent running." }),
  stopSession: msg({ id: 'assistant.sidebar.stopSession', defaultMessage: 'Stop Session', description: "An item of a project's right-click menu in the Projects sidebar: stops its running session." }),
  addAgent: msg({ id: 'assistant.sidebar.addAgent', defaultMessage: 'Add Agent', description: "A project's right-click menu: adds an agent at once, with the defaults." }),
  addAgentDialog: msg({ id: 'assistant.sidebar.addAgentDialog', defaultMessage: 'Add Agent…', description: "A project's right-click menu: opens the Add Agent dialog." }),
  markNotWorking: msg({ id: 'assistant.sidebar.markNotWorking', defaultMessage: 'Mark as Not Working On', description: "A project's right-click menu: makes it inactive." }),
  markWorking: msg({ id: 'assistant.sidebar.markWorking', defaultMessage: 'Mark as Working On', description: "A project's right-click menu: makes it active." }),
  reveal: msg({ id: 'assistant.sidebar.reveal', defaultMessage: 'Reveal in File Explorer', description: "A project's or a note's right-click menu." }),
  terminal: msg({ id: 'assistant.sidebar.terminal', defaultMessage: 'Open External Terminal', description: "An item of a project's right-click menu: opens a terminal window in its folder." }),
  tasks: msg({ id: 'assistant.sidebar.tasks', defaultMessage: 'Tasks', description: "A project's right-click menu: its Tasks tab." }),
  projectSettings: msg({ id: 'assistant.sidebar.projectSettings', defaultMessage: 'Project Settings', description: "A project's right-click menu: its Settings tab." }),
  removeProject: msg({ id: 'assistant.sidebar.removeProject', defaultMessage: 'Remove Project…', description: "An item of a project's right-click menu in the Projects sidebar: removes it from the workspace." }),
  needYou: msg({ id: 'assistant.sidebar.needYou', defaultMessage: '{count, plural, one {# agent needs you} other {# agents need you}}', description: "Tooltip on a project's bell: how many of its agents wait for you." }),
  expand: msg({ id: 'assistant.sidebar.expand', defaultMessage: 'Expand Sidebar', description: 'The compact sidebar: the button that widens it again.' }),
  expandTip: msg({ id: 'assistant.sidebar.expandTip', defaultMessage: '{hasKey, select, yes {Expand Sidebar ({key})} other {Expand Sidebar}}', description: 'Tooltip on the compact sidebar\'s widen button, with its shortcut ({key}: "Ctrl+Alt+B").' }),
  compactTip: msg({ id: 'assistant.sidebar.compactTip', defaultMessage: '{hasKey, select, yes {Compact Sidebar ({key})} other {Compact Sidebar}}', description: 'The Projects sidebar: the button that narrows it to a rail, with its shortcut ({key}: "Ctrl+Alt+B").' }),
  noSession: msg({ id: 'assistant.sidebar.noSession', defaultMessage: 'No session', description: "An active project's status when no session runs." }),
  inactive: msg({ id: 'assistant.sidebar.inactive', defaultMessage: 'Inactive', description: "A project's status when it isn't being worked on." }),
  railLabel: msg({ id: 'assistant.sidebar.railLabel', defaultMessage: '{project}: {status}', description: 'The compact sidebar: a project\'s accessible name, with its status ("Working").' }),
  workspace: msg({ id: 'assistant.sidebar.workspace', defaultMessage: 'Workspace: {name}', description: "The compact sidebar: tooltip on the workspace's icon." }),
  projects: msg({ id: 'assistant.sidebar.projects', defaultMessage: 'Projects', description: "The Projects sidebar's heading with no workspace open." }),
  bypassTip: msg({ id: 'assistant.sidebar.bypassTip', defaultMessage: 'Bypass permissions: sessions run every action without asking.', description: "Tooltip on a project's warning: an agent runs in a provider's no-guardrails mode." }),
  restartTip: msg({ id: 'assistant.sidebar.restartTip', defaultMessage: 'Settings changed since this session started. Restart the session to apply them.', description: "Tooltip on a project's restart mark." }),
  unmanagedTip: msg({ id: 'assistant.sidebar.unmanagedTip', defaultMessage: 'Project MCP servers not in the workspace (disabled): {servers}', description: "Tooltip on a project's plug: MCP servers in its own config that Hive turned off." }),
  statusLabel: msg({ id: 'assistant.sidebar.statusLabel', defaultMessage: '{project} agents: {status}', description: "A project's status, for screen readers (its agents' table follows on focus)." }),
  activeTip: msg({ id: 'assistant.sidebar.activeTip', defaultMessage: 'Working on this project. Click to mark it as not being worked on.', description: "Tooltip on an active project's switch." }),
  inactiveTip: msg({ id: 'assistant.sidebar.inactiveTip', defaultMessage: 'Mark as a project you are working on. Only active projects run sessions and show status.', description: "Tooltip on an inactive project's switch." }),
  activeLabel: msg({ id: 'assistant.sidebar.activeLabel', defaultMessage: 'Active: {project}', description: "A project's switch, for screen readers." }),
  newProject: msg({ id: 'assistant.sidebar.newProject', defaultMessage: 'New Project…', description: 'The Projects sidebar: a button.' }),
  refresh: msg({ id: 'assistant.sidebar.refresh', defaultMessage: 'Refresh', description: 'A sidebar button: reads its list again.' }),
  openWorkspaceFolder: msg({ id: 'assistant.sidebar.openWorkspaceFolder', defaultMessage: 'Open Workspace Folder', description: 'The Projects sidebar: a button that opens the workspace in Explorer.' }),
  filterProjects: msg({ id: 'assistant.sidebar.filterProjects', defaultMessage: 'Filter projects', description: "The Projects sidebar's filter box, empty." }),
  noProjects: msg({ id: 'assistant.sidebar.noProjects', defaultMessage: 'This workspace has no projects yet. Each folder in the workspace is a project.', description: 'The Projects sidebar with no projects.' }),
  newProjectButton: msg({ id: 'assistant.sidebar.newProjectButton', defaultMessage: 'New Project', description: 'The Projects sidebar with no projects: a button.' }),
  workingOn: msg({ id: 'assistant.sidebar.workingOn', defaultMessage: 'Working on', description: 'The Projects sidebar: the section of active projects.' }),
  workingOnTip: msg({ id: 'assistant.sidebar.workingOnTip', defaultMessage: 'Active projects get a terminal session, status indicators and notifications.', description: "Tooltip on the Working on section of the Projects sidebar." }),
  toggleOn: msg({ id: 'assistant.sidebar.toggleOn', defaultMessage: 'Toggle a project on to start working on it.', description: 'Under Working on, with no active projects.' }),
  otherProjects: msg({ id: 'assistant.sidebar.otherProjects', defaultMessage: 'Other projects', description: 'The Projects sidebar: the section of inactive projects.' }),
  sharedNotes: msg({ id: 'assistant.sidebar.sharedNotes', defaultMessage: 'Shared Notes', description: "The Shared Notes sidebar's heading." }),
  newFolder: msg({ id: 'assistant.sidebar.newFolder', defaultMessage: 'New Folder', description: "Shared Notes: the dialog's title." }),
  newNote: msg({ id: 'assistant.sidebar.newNote', defaultMessage: 'New Note', description: "Shared Notes: the dialog's title." }),
  notePlaceholder: msg({ id: 'assistant.sidebar.notePlaceholder', defaultMessage: 'note-name.md', description: "Placeholder of the New Note dialog's name box: an example file name (lower case, a dash, .md). Keep .md." }),
  folderPlaceholder: msg({ id: 'assistant.sidebar.folderPlaceholder', defaultMessage: 'folder-name', description: "Placeholder of the New Folder dialog's name box (Shared Notes): an example folder name (lower case, a dash)." }),
  folderMessage: msg({ id: 'assistant.sidebar.folderMessage', defaultMessage: 'Folder inside .hive/shared', description: 'Shared Notes, New Folder. Keep .hive/shared as it is.' }),
  noteMessage: msg({ id: 'assistant.sidebar.noteMessage', defaultMessage: 'Markdown note inside .hive/shared. Agents can read it through the Hive MCP tools.', description: 'Shared Notes, New Note. Keep .hive/shared as it is.' }),
  create: msg({ id: 'assistant.sidebar.create', defaultMessage: 'Create', description: "New Note's, New Folder's and New MCP Server's button." }),
  createFailed: msg({ id: 'assistant.sidebar.createFailed', defaultMessage: 'Could not create', description: 'An error notice: a shared note or folder.' }),
  newNoteHere: msg({ id: 'assistant.sidebar.newNoteHere', defaultMessage: 'New Note Here', description: "A shared notes folder's right-click menu." }),
  newFolderHere: msg({ id: 'assistant.sidebar.newFolderHere', defaultMessage: 'New Folder Here', description: "A shared notes folder's right-click menu." }),
  renameMenu: msg({ id: 'assistant.sidebar.renameMenu', defaultMessage: 'Rename…', description: "A shared note's right-click menu." }),
  saveFirst: msg({ id: 'assistant.sidebar.saveFirst', defaultMessage: 'Save or discard your changes to {name} first', description: 'A notice: a note with unsaved edits can\'t be renamed.' }),
  saveFirstDetail: msg({ id: 'assistant.sidebar.saveFirstDetail', defaultMessage: 'It has unsaved edits, which would otherwise be saved under its old name.', description: 'Under Save or discard your changes first.' }),
  rename: msg({ id: 'assistant.sidebar.rename', defaultMessage: 'Rename', description: "Renaming a shared note: the dialog's title and button." }),
  renameFailed: msg({ id: 'assistant.sidebar.renameFailed', defaultMessage: 'Could not rename', description: 'An error notice: a shared note.' }),
  delete: msg({ id: 'assistant.sidebar.delete', defaultMessage: 'Delete', description: "A shared note's right-click menu." }),
  deleteFolder: msg({ id: 'assistant.sidebar.deleteFolder', defaultMessage: 'Delete folder', description: 'A button on a shared notes folder.' }),
  deleteNote: msg({ id: 'assistant.sidebar.deleteNote', defaultMessage: 'Delete note', description: "A trash button beside a shared note: deletes it." }),
  notesTip: msg({ id: 'assistant.sidebar.notesTip', defaultMessage: "Notes, instructions and handovers stored in the workspace's .hive/shared folder. Shared across every project and session.", description: 'Tooltip on Shared Notes. Keep .hive/shared as it is.' }),
  newNoteButton: msg({ id: 'assistant.sidebar.newNoteButton', defaultMessage: 'New Note…', description: "A button over the shared notes: creates a note." }),
  newFolderButton: msg({ id: 'assistant.sidebar.newFolderButton', defaultMessage: 'New Folder…', description: "A button over the shared notes: creates a folder." }),
  openFolder: msg({ id: 'assistant.sidebar.openFolder', defaultMessage: 'Open Folder', description: "Shared Notes: a button that opens .hive/shared in Explorer." }),
  workspaceNotes: msg({ id: 'assistant.sidebar.workspaceNotes', defaultMessage: 'Workspace notes', description: "The pinned first row of Shared Notes: the note Hive gives every agent when it starts (notes about this machine). Keep Workspace notes in English: it is the note's name (its file is Workspace notes.md) and what agents are told." }),
  workspaceNotesTip: msg({ id: 'assistant.sidebar.workspaceNotesTip', defaultMessage: "Notes about this machine (a full path, a local tool's version) that every agent gets when it starts, on every coding agent and in any folder. Kept in .hive/shared, out of git.", description: 'Tooltip on the pinned Workspace notes row of Shared Notes. Keep .hive/shared as it is.' }),
  noNotes: msg({ id: 'assistant.sidebar.noNotes', defaultMessage: 'No notes yet. Create one, or ask an agent to write a handover with the Hive MCP tools.', description: "The Shared Notes sidebar when the workspace has no notes." }),
  openFirst: msg({ id: 'assistant.sidebar.openFirst', defaultMessage: 'Open a workspace first', description: 'A notice: adding a skill with no workspace open.' }),
  skills: msg({ id: 'assistant.sidebar.skills', defaultMessage: 'Skills', description: "The heading of the Skills sidebar: the workspace's Hive skills." }),
  newSkill: msg({ id: 'assistant.sidebar.newSkill', defaultMessage: 'New Skill…', description: "A button over the Hive skills: creates a skill." }),
  skillFromFile: msg({ id: 'assistant.sidebar.skillFromFile', defaultMessage: 'Add Skill from File (.md or .zip)…', description: 'The Skills sidebar: a button. Keep .md and .zip as they are.' }),
  openSkillsFolder: msg({ id: 'assistant.sidebar.openSkillsFolder', defaultMessage: 'Open Hive Skills Folder', description: 'The Skills sidebar: a button that opens .hive/skills in Explorer.' }),
  filterSkills: msg({ id: 'assistant.sidebar.filterSkills', defaultMessage: 'Filter skills', description: "The Skills sidebar's filter box, empty." }),
  hiveGroup: msg({ id: 'assistant.sidebar.hiveGroup', defaultMessage: 'Hive', description: "The Skills sidebar: the section of the workspace's Hive skills. Usually kept as Hive." }),
  noWorkspaceSkills: msg({ id: 'assistant.sidebar.noWorkspaceSkills', defaultMessage: 'Open a workspace to manage Hive skills.', description: 'The Skills sidebar with no workspace open.' }),
  skillsLoadTarget: msg({ id: 'assistant.sidebar.skillsLoadTarget', defaultMessage: 'the skills', description: 'What could not be loaded when the Hive skills were first read: shown in "Could not load {what}: {error}", with Retry.' }),
  skillsRefreshTarget: msg({ id: 'assistant.sidebar.skillsRefreshTarget', defaultMessage: 'the skills', description: 'What could not be refreshed while the skills shown stay on screen: shown in "Could not refresh {what}; last updated …", with Retry.' }),
  loading: msg({ id: 'assistant.sidebar.loading', defaultMessage: 'Loading…', description: "The Skills sidebar while the Hive skills are read." }),
  noSkills: msg({ id: 'assistant.sidebar.noSkills', defaultMessage: 'No Hive skills yet. Create one with +, or add one from a .md or .zip.', description: 'The Skills sidebar with no Hive skills. + is the add button.' }),
  restoreSkill: msg({ id: 'assistant.sidebar.restoreSkill', defaultMessage: 'Restore this skill that ships with Hive', description: "A button beside a deleted skill of Hive's own." }),
  deleteSkill: msg({ id: 'assistant.sidebar.deleteSkill', defaultMessage: 'Delete skill', description: "A trash button beside a Hive skill: deletes it." }),
  skillsHint: msg({ id: 'assistant.sidebar.skillsHint', defaultMessage: "Each goes to the project agents in every project, unless it's marked <b>Assistant</b> (only the Hive Assistant gets it) or <b>Agents + Assistant</b>. A project's own skills, and your user and plugin skills, are in its <b>Skills</b> tab.", description: "Under the Skills sidebar's list. <b> is bold: the badges' words (Assistant, Agents + Assistant) and the tab's name, as they show." }),
  mcpServers: msg({ id: 'assistant.sidebar.mcpServers', defaultMessage: 'MCP Servers', description: "The heading of the MCP sidebar: the workspace's MCP servers." }),
  newServerTitle: msg({ id: 'assistant.sidebar.newServerTitle', defaultMessage: 'New MCP Server', description: "The title of the dialog that creates an MCP server." }),
  newServerMessage: msg({ id: 'assistant.sidebar.newServerMessage', defaultMessage: 'Creates {file} in the workspace from a template you can edit.', description: 'New MCP Server. {file} is .hive/mcp/<name>.json, <name> standing for the name you type.' }),
  serverNameRule: msg({ id: 'assistant.sidebar.serverNameRule', defaultMessage: 'Use letters, numbers, "-" and "_". "hive" is reserved.', description: "New MCP Server: a name that can't be used. Keep hive as it is (the built-in server's name)." }),
  createServerFailed: msg({ id: 'assistant.sidebar.createServerFailed', defaultMessage: 'Could not create server', description: "An error notice: New MCP Server couldn't create the server's file; the reason follows." }),
  mcpTip: msg({ id: 'assistant.sidebar.mcpTipAdded', defaultMessage: "MCP servers deployed to the workspace (.hive/mcp) are available to every project and the Hive Assistant, and run only where they are added: a project's MCP tab, the Assistant's view, or Add to… here. Changes apply to new sessions.", description: 'Tooltip on MCP Servers (HI-2059). Keep .hive/mcp as it is; "MCP tab" and "Add to…" as Hive shows them.' }),
  newServer: msg({ id: 'assistant.sidebar.newServer', defaultMessage: 'New MCP Server…', description: "A button over the MCP servers: creates a server from a template." }),
  serverFromFile: msg({ id: 'assistant.sidebar.serverFromFile', defaultMessage: 'Add MCP Server from File (.json or .zip)…', description: 'The MCP sidebar: a button. Keep .json and .zip as they are.' }),
  openMcpFolder: msg({ id: 'assistant.sidebar.openMcpFolder', defaultMessage: 'Open MCP Folder', description: 'The MCP sidebar: a button that opens .hive/mcp in Explorer.' }),
  workspaceGroup: msg({ id: 'assistant.sidebar.workspaceGroup', defaultMessage: 'Workspace', description: "The MCP sidebar: the section of the workspace's servers." }),
  installedTab: msg({ id: 'assistant.sidebar.mcpInstalled', defaultMessage: 'Installed', description: "The MCP view's first tab (HI-545): the workspace's servers." }),
  catalogueTab: msg({ id: 'assistant.sidebar.mcpCatalogue', defaultMessage: 'Catalogue', description: "The MCP view's second tab (HI-545): servers from the MCP catalogues, to install." }),
  noMatch: msg({ id: 'assistant.sidebar.mcpNoMatch', defaultMessage: 'No server matches.', description: "The MCP view (HI-2059) when no server matches its search and filter." }),
  noServers: msg({ id: 'assistant.sidebar.noServers', defaultMessage: 'No MCP servers yet. Create one with +, or add one from a .json definition or a .zip of a server folder.', description: 'The MCP sidebar with no servers. + is the add button.' }),
  deleteServer: msg({ id: 'assistant.sidebar.deleteServer', defaultMessage: 'Delete server', description: "A trash button beside an MCP server of the workspace: deletes it." }),
  builtIn: msg({ id: 'assistant.sidebar.builtIn', defaultMessage: 'Built-in', description: "The MCP sidebar: the section of Hive's own server." }),
  hiveServerDesc: msg({ id: 'assistant.sidebar.hiveServerDesc', defaultMessage: 'Hive tools for agents: projects, shared notes, handovers, notifications', description: "Under the built-in hive server: what it gives agents." }),
  hiveServerTip: msg({ id: 'assistant.sidebar.hiveServerTip', defaultMessage: 'Controlled in Settings → Agent API', description: "Tooltip on the built-in server's On or Off." }),
  on: msg({ id: 'assistant.sidebar.on', defaultMessage: 'On', description: 'A badge: the built-in hive server is on.' }),
  off: msg({ id: 'assistant.sidebar.off', defaultMessage: 'Off', description: 'A badge: the built-in hive server is off.' })
}

const bold = (c: React.ReactNode[]): React.ReactNode => <strong>{c}</strong>

export function Sidebar() {
  const activity = useStore((s) => s.activity)
  const visible = useStore((s) => s.sidebarVisible)
  const width = useStore((s) => s.sidebarWidth)
  const compactSetting = useStore((s) => s.sidebarCompact)
  // Folded to its rail for the room (HI-1737, layoutRoom.ts), unless the user expanded it meanwhile.
  const folded = useStore((s) => s.sidebarFolded && !s.sidebarUnfolded)
  const last = useStore((s) => s.lastSideActivity)
  const [dragging, setDragging] = useState(false)
  if (!visible) return null
  const view = activity === 'docs' || activity === 'settings' ? last : activity
  // Only the Projects list has a compact form; the other panels always show at full width.
  const compact = (compactSetting || folded) && view === 'projects'

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    setDragging(true)
    const startX = e.clientX
    const startW = compact ? RAIL_WIDTH : width
    const move = (ev: MouseEvent): void => {
      const w = startW + ev.clientX - startX
      // In the Projects view, dragging narrow snaps to the rail and dragging out again restores the list.
      // Snapping keeps the width from before the drag, so expanding again restores it.
      if (view === 'projects' && w < SNAP_WIDTH) set({ sidebarCompact: true, sidebarWidth: width })
      else set({ sidebarCompact: false, sidebarWidth: Math.max(200, Math.min(600, w)) })
    }
    const up = (): void => {
      setDragging(false)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      void call('ui:set', { sidebarWidth: get().sidebarWidth })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className={cx('sidebar', compact && 'compact')} style={{ width: compact ? RAIL_WIDTH : width }}>
      {view === 'projects' && (compact ? <ProjectsRail /> : <ProjectsPanel />)}
      {view === 'overview' && <WorkspaceOverviewPanel />}
      {view === 'activity' && <WorkspaceActivityPanel />}
      {view === 'performance' && <PerformancePanel />}
      {view === 'board' && <BoardPanel />}
      {view === 'notes' && <NotesPanel />}
      {view === 'skills' && <SkillsPanel />}
      {view === 'dialects' && <DialectsPanel />}
      {view === 'templates' && <TemplatesPanel />}
      {view === 'mcp' && <McpPanel />}
      {view === 'assistant' && <AssistantSidePanel />}
      <div className={cx('sidebar-resizer', dragging && 'dragging')} onMouseDown={startDrag} onDoubleClick={() => {
          set({ sidebarWidth: 280, sidebarCompact: false })
          void call('ui:set', { sidebarWidth: 280 })
        }} />
    </div>
  )
}

function NoWorkspace({ what }: { what: 'projects' | 'notes' | 'mcp' }) {
  return (
    <div className="pane-empty">
      {tr(M.noWorkspace, { what })}
      <button className="btn primary" onClick={() => runCommand('workspace.open')}>
        <Icon name="folder-opened" /> {tr(M.openWorkspace)}
      </button>
      <button className="btn subtle" onClick={() => runCommand('workspace.create')}>
        <Icon name="new-folder" /> {tr(M.newWorkspace)}
      </button>
    </div>
  )
}

export function Section({ title, count, children, defaultOpen = true, tip, buttons }: { title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean; tip?: string; buttons?: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <>
      <div className="section-header" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        {title}
        {tip && (
          <span onClick={(e) => e.stopPropagation()}>
            <InfoTip text={tip} />
          </span>
        )}
        {count !== undefined && <span className="count">{count}</span>}
        {buttons && (
          <span className="section-actions" onClick={(e) => e.stopPropagation()}>
            {buttons}
          </span>
        )}
      </div>
      {open && children}
    </>
  )
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** The compact sidebar's shortcut, for a message's select. */
function compactKey(): { hasKey: 'yes' | 'no'; key: string } {
  const kb = commandKeybinding('view.compactSidebar')
  return { hasKey: kb ? 'yes' : 'no', key: kb ? formatKeybinding(kb) : '' }
}

/** A project's lanes (its builders and reviewers, to pair them up in its agents table, #529). */
/** An agent of the project whose hooks aren't arriving (#1336) speaks for its row: its status word would be a guess. */
const deafStatus = (p: ProjectInfo): string | null => hooksMissingText(p.agents.find((a) => a.live?.hooksMissing)?.live, tr)

function projectLanes(lanes: readonly Lane[], p: ProjectInfo): Lane[] {
  return lanes.filter((l) => l.project.toLowerCase() === p.path.toLowerCase())
}

/** Right-click menu for a project, shared by the full list and the compact rail. */
function projectMenu(p: ProjectInfo): MenuEntry[] {
  const running = p.agents.filter((a) => a.live).length
  // One of its agents starting or resuming already (#1177).
  const starting = projectStarting(p.path)
  const noStart = starting ? { disabled: true, detail: startingLabel(starting) } : {}
  return [
    { label: tr(M.newSession), icon: 'add', action: 'start', ...noStart, onClick: () => void actions.newSession(p.path) },
    { label: tr(M.resumeLast), icon: 'debug-continue', action: 'resume', ...noStart, onClick: () => void actions.resumeLast(p.path) },
    ...(p.agents.length > 1 ? [{ label: tr(M.resumeAll), icon: 'blank', action: 'resume' as const, disabled: !agentsToResume(p.agents).length, onClick: () => void actions.resumeAllAgents(p.path) }] : []),
    running > 1
      ? { label: tr(M.stopAll), icon: 'debug-stop', action: 'stop', onClick: () => void actions.stopAllAgents(p.path) }
      : { label: tr(M.stopSession), icon: 'debug-stop', action: 'stop', disabled: !running, onClick: () => void actions.stopSession(p.path, p.agents.find((a) => a.live)?.id) },
    { label: tr(M.addAgent), icon: 'person-add', onClick: () => void actions.quickAddAgent(p.path) },
    { label: tr(M.addAgentDialog), icon: 'blank', onClick: () => set({ addAgentFor: p.path }) },
    { separator: true },
    { label: tr(p.active ? M.markNotWorking : M.markWorking), icon: p.active ? 'circle-slash' : 'pass', onClick: () => void actions.setProjectActive(p.path, !p.active) },
    { separator: true },
    { label: tr(M.reveal), icon: 'folder-opened', onClick: () => void call('project:openInExplorer', p.path) },
    { label: tr(M.terminal), icon: 'terminal', onClick: () => void call('project:openTerminal', p.path) },
    { separator: true },
    {
      label: tr(M.tasks),
      icon: 'project',
      onClick: () => {
        actions.selectProject(p.path)
        setProjectTab(p.path, 'tasks')
      }
    },
    {
      label: tr(M.projectSettings),
      icon: 'settings',
      onClick: () => {
        actions.selectProject(p.path)
        setProjectTab(p.path, 'settings')
      }
    },
    { separator: true },
    { label: tr(M.removeProject), icon: 'trash', onClick: () => set({ removeProjectFor: p.path }) }
  ]
}

/** A project's tile text in the rail: its key (#1221), else its initials; 3 and 4 letters shrink to fit the tile. */
function RailLabel({ text }: { text: string }) {
  return <span className={cx('rail-initials', text.length > 2 && `rail-initials-${Math.min(text.length, 4)}`)}>{text}</span>
}

/** Short label for the rail: the initials of a multi-word name ("web-dashboard" → "WD"), else its first two letters ("hive" → "Hi"). */
export function projectInitials(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s._-]+/)
    .filter((w) => /[a-z0-9]/i.test(w))
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  const w = words[0] ?? name
  return w.charAt(0).toUpperCase() + w.charAt(1).toLowerCase()
}

/** The Projects sidebar collapsed to one status dot per project. */
/** How many of each project's agents need you (the inbox's count), by path. */
function useNeedCounts(): Map<string, number> {
  const { needYou } = useInbox()
  return useMemo(() => {
    const m = new Map<string, number>()
    for (const i of needYou) m.set(i.projectPath, (m.get(i.projectPath) ?? 0) + 1)
    return m
  }, [needYou])
}

function NeedCount({ n }: { n: number | undefined }) {
  if (!n) return null
  return (
    <Tooltip content={tr(M.needYou, { count: n })}>
      <span className="project-needs">
        <Icon name="bell-dot" />
        {n}
      </span>
    </Tooltip>
  )
}

function ProjectsRail() {
  const workspace = useStore((s) => s.workspace)
  const needs = useNeedCounts()
  const tasks = useStore((s) => s.tasks)
  const lanes = useLanes()
  const selected = useStore((s) => s.selectedProject)
  const keys = useStore((s) => s.projectKeys)
  const menu = useContextMenu()

  const expand = (
    <Tooltip content={tr(M.expandTip, compactKey())} side="right">
      <button className="rail-btn" onClick={() => toggleCompactSidebar(false)} aria-label={tr(M.expand)}>
        <Icon name="chevron-right" />
      </button>
    </Tooltip>
  )
  if (!workspace) {
    return (
      <div className="rail">
        {expand}
        <Tooltip content={tr(M.openWorkspace)} side="right">
          <button className="rail-btn" onClick={() => runCommand('workspace.open')} aria-label={tr(M.openWorkspace)}>
            <Icon name="folder-opened" />
          </button>
        </Tooltip>
      </div>
    )
  }

  const item = (p: ProjectInfo) => {
    const state = projectState(p)
    const status = deafStatus(p) ?? (state ? STATUS_TEXT[state.status] : tr(p.active ? M.noSession : M.inactive))
    // Its agents as a table (#529), whenever it has any.
    const table = p.agents.length > 0
    const lanesOf = projectLanes(lanes, p)
    const tip = (
      <div className="rail-tip">
        <strong>{p.name}</strong>
        <div>
          {status}
          {state && (state.statusMessage ?? state.mergeSlot) ? ` — ${shownStatusMessage(state) ?? shownMergeSlot(state)}` : ''}
        </div>
        {p.branch && (
          <div className="desc">
            <Icon name="git-branch" /> {p.branch}
          </div>
        )}
        {table && <AgentsTable project={p} tasks={tasks} lanes={lanesOf} />}
      </div>
    )
    return (
      <Tooltip key={p.path} content={tip} side="right" block focus className={table ? 'agents-tip' : undefined}>
        <div
          className={cx('rail-project', selected === p.path && 'selected', !p.active && 'inactive')}
          role="button"
          tabIndex={0}
          onClick={() => actions.selectProject(p.path)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            actions.selectProject(p.path)
          }}
          onDoubleClick={() => p.active && !state && void actions.newSession(p.path)}
          onContextMenu={(e) => menu.open(e, projectMenu(p))}
          aria-label={tr(M.railLabel, { project: p.name, status })}
          aria-description={table ? agentsText(p, tasks, lanesOf) : undefined}
        >
          <RailLabel text={projectKeyOf({ projectKeys: keys }, p.path) ?? projectInitials(p.name)} />
          <span className={cx('dot', state?.status ?? (p.active ? 'idle' : 'stopped'), state?.unseen && 'unseen')} />
          {!!needs.get(p.path) && <span className="project-need-count">{needs.get(p.path)}</span>}
        </div>
      </Tooltip>
    )
  }

  const active = workspace.projects.filter((p) => p.active)
  const inactive = workspace.projects.filter((p) => !p.active)
  return (
    <div className="rail">
      {expand}
      <Tooltip content={tr(M.workspace, { name: workspace.name })} side="right">
        <span className="rail-workspace">
          <Icon name="root-folder" />
        </span>
      </Tooltip>
      <div className="rail-list">
        {active.map(item)}
        {active.length > 0 && inactive.length > 0 && <div className="rail-sep" />}
        {inactive.map(item)}
      </div>
      {menu.element}
    </div>
  )
}

function ProjectsPanel() {
  const workspace = useStore((s) => s.workspace)
  const needs = useNeedCounts()
  const tasks = useStore((s) => s.tasks)
  const lanes = useLanes()
  const selected = useStore((s) => s.selectedProject)
  const settings = useStore((s) => s.settings)
  const menu = useContextMenu()
  const [filter, setFilter] = useState('')

  if (!workspace) {
    return (
      <>
        <div className="pane-header">{tr(M.projects)}</div>
        <NoWorkspace what="projects" />
      </>
    )
  }
  const list = workspace.projects.filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()))
  const active = list.filter((p) => p.active)
  const inactive = list.filter((p) => !p.active)

  const row = (p: ProjectInfo) => {
    // Marked when any agent starts (or runs) in its provider's no-guardrails mode.
    const bypass = !!settings && p.agents.some((a) => {
      const l = agentLaunchSettings(agentProvider(a, settings), a, settings)
      // The mode in effect: on the CLI's own setting, the one its CLI showed (#1284).
      return !!modeOption(l.provider, (a.live ? modeInEffect(a.live) : undefined) ?? l.permissionMode)?.danger
    })
    // One dot per project: the most urgent of its agents.
    const state = projectState(p)
    const running = p.agents.filter((a) => a.live).length
    const status = deafStatus(p) ?? (state ? STATUS_TEXT[state.status] : tr(p.active ? M.noSession : M.inactive))
    const lanesOf = projectLanes(lanes, p)
    return (
      <div
        key={p.path}
        className={cx(/* i18n-ignore: class names */ 'row project-row', selected === p.path && 'selected', !p.active && 'inactive')}
        onClick={() => actions.selectProject(p.path)}
        onDoubleClick={() => p.active && !state && void actions.newSession(p.path)}
        onContextMenu={(e) => menu.open(e, projectMenu(p))}
      >
        <StatusDot live={state} active={p.active} />
        <div className="project-text">
          <div className="project-name">
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
            {bypass && (
              <Tooltip content={tr(M.bypassTip)}>
                <Icon name="warning" className="" />
              </Tooltip>
            )}
            {running > 1 && (
              <Tooltip content={<AgentsTable project={p} tasks={tasks} lanes={lanesOf} />} className="agents-tip">
                <span className="agent-count" aria-description={agentsText(p, tasks, lanesOf)}>
                  {running}
                </span>
              </Tooltip>
            )}
            {p.agents.some((a) => a.restartNeeded) && (
              <Tooltip content={tr(M.restartTip)}>
                <Icon name="refresh" />
              </Tooltip>
            )}
            {p.unmanagedMcp.length > 0 && (
              <Tooltip content={tr(M.unmanagedTip, { servers: fmt.list(p.unmanagedMcp, 'unit') })}>
                <Icon name="plug" />
              </Tooltip>
            )}
            <NeedCount n={needs.get(p.path)} />
          </div>
          <div className="project-sub">
            {p.branch && (
              <>
                <Icon name="git-branch" /> {p.branch} ·
              </>
            )}{' '}
            {/* Its agents as a table (#529), whenever it has any: on hover, or on keyboard focus (the row's one tab stop for it). */}
            {p.agents.length ? (
              <Tooltip content={<AgentsTable project={p} tasks={tasks} lanes={lanesOf} />} className="agents-tip" focus>
                <span className="project-status" tabIndex={0} aria-label={tr(M.statusLabel, { project: p.name, status })} aria-description={agentsText(p, tasks, lanesOf)}>
                  {status}
                </span>
              </Tooltip>
            ) : (
              status
            )}
          </div>
        </div>
        <Tooltip content={tr(p.active ? M.activeTip : M.inactiveTip)}>
          <Switch small checked={p.active} onChange={(v) => void actions.setProjectActive(p.path, v)} label={tr(M.activeLabel, { project: p.name })} />
        </Tooltip>
      </div>
    )
  }

  return (
    <>
      <div className="pane-header">
        {workspace.name}
        <div className="actions">
          <IconButton icon="new-folder" title={tr(M.newProject)} onClick={() => runCommand('project.new')} />
          <IconButton icon="refresh" title={tr(M.refresh)} onClick={() => void actions.refreshWorkspace()} />
          <IconButton icon="chevron-left" title={tr(M.compactTip, compactKey())} onClick={() => toggleCompactSidebar(true)} />
          <IconButton icon="folder-opened" title={tr(M.openWorkspaceFolder)} onClick={() => void call('app:openPath', workspace.path)} />
        </div>
      </div>
      {workspace.projects.length > 6 && (
        <div style={{ padding: '0 8px 6px 12px' }}>
          <SearchInput style={{ height: 24 }} placeholder={tr(M.filterProjects)} value={filter} onChange={setFilter} />
        </div>
      )}
      <div className="pane-body">
        {workspace.projects.length === 0 ? (
          <div className="pane-empty">
            {tr(M.noProjects)}
            <button className="btn primary" onClick={() => runCommand('project.new')}>
              <Icon name="new-folder" /> {tr(M.newProjectButton)}
            </button>
          </div>
        ) : (
          <>
            <Section title={tr(M.workingOn)} count={active.length} tip={tr(M.workingOnTip)}>
              {active.length === 0 && <div className="pane-empty" style={{ paddingTop: 8 }}>{tr(M.toggleOn)}</div>}
              {active.map(row)}
            </Section>
            <Section title={tr(M.otherProjects)} count={inactive.length}>
              {inactive.map(row)}
            </Section>
          </>
        )}
      </div>
      {menu.element}
    </>
  )
}

// ---------------------------------------------------------------------------
// Shared notes
// ---------------------------------------------------------------------------

function NotesPanel() {
  // Its path only (HI-1806): the workspace's every change would render the panel again.
  const wsPath = useStore((s) => s.workspace?.path)
  const version = useStore((s) => s.notesVersion)
  const selected = useStore((s) => s.selectedNote)
  const [tree, setTree] = useState<NoteFile[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ handovers: true })
  const menu = useContextMenu()

  const load = useCallback(() => {
    if (wsPath) void call('notes:tree').then(setTree)
  }, [wsPath])
  useEffect(load, [load, version])

  if (!wsPath) {
    return (
      <>
        <div className="pane-header">{tr(M.sharedNotes)}</div>
        <NoWorkspace what="notes" />
      </>
    )
  }

  const notesFile = workspaceNotesPath(wsPath)
  // The pinned row is the note: the tree lists the others.
  const others = tree.filter((n) => n.isDir || n.relPath.toLowerCase() !== WORKSPACE_NOTES_PATH.toLowerCase())

  const create = async (isDir: boolean, parent = ''): Promise<void> => {
    const name = await prompt({
      title: tr(isDir ? M.newFolder : M.newNote),
      message: tr(isDir ? M.folderMessage : M.noteMessage),
      placeholder: isDir ? tr(M.folderPlaceholder) : tr(M.notePlaceholder),
      initial: parent ? `${parent}/` : '',
      confirmLabel: tr(M.create)
    })
    if (!name) return
    const path = await actions.attempt(tr(M.createFailed), () => call('notes:create', name, isDir))
    if (path && !isDir) set({ selectedNote: path })
    load()
  }

  const renderNodes = (nodes: NoteFile[], depth: number): React.ReactNode =>
    nodes.map((n) => (
      <div key={n.path}>
        <div
          className={cx('row', selected === n.path && 'selected')}
          // Its path in .hive/shared (#1571): what a test finds a note or folder by, whatever the window's language.
          data-note={n.relPath}
          style={{ paddingLeft: 12 + depth * 14 }}
          onClick={() => (n.isDir ? setExpanded((e) => ({ ...e, [n.relPath]: !e[n.relPath] })) : set({ selectedNote: n.path }))}
          onContextMenu={(e) =>
            menu.open(e, [
              ...(n.isDir
                ? [
                    { label: tr(M.newNoteHere), icon: 'new-file', onClick: () => void create(false, n.relPath) },
                    { label: tr(M.newFolderHere), icon: 'new-folder', onClick: () => void create(true, n.relPath) },
                    { separator: true }
                  ]
                : []),
              {
                label: tr(M.renameMenu),
                icon: 'tag',
                onClick: async () => {
                  // Its unsaved edits are tied to its path: renaming would leave them saving to the old name.
                  if (hasEditorDraftsUnder(n.path)) return notify('warning', tr(M.saveFirst, { name: n.name }), tr(M.saveFirstDetail))
                  const nn = await prompt({ title: tr(M.rename), initial: n.name, confirmLabel: tr(M.rename) })
                  if (nn && nn !== n.name) {
                    // Edited while the dialog was open.
                    if (hasEditorDraftsUnder(n.path)) return notify('warning', tr(M.saveFirst, { name: n.name }), tr(M.saveFirstDetail))
                    const np = await actions.attempt(tr(M.renameFailed), () => call('notes:rename', n.path, nn))
                    if (np && selected === n.path) set({ selectedNote: np })
                    load()
                  }
                }
              },
              { label: tr(M.reveal), icon: 'folder-opened', onClick: () => void call('app:showInFolder', n.path) },
              { separator: true },
              { label: tr(M.delete), icon: 'trash', danger: true, onClick: () => void actions.deleteNote(n.path, n.relPath, n.isDir).then(load) }
            ])
          }
        >
          {n.isDir ? <Icon name={expanded[n.relPath] ? 'chevron-down' : 'chevron-right'} /> : <Icon name={n.name.endsWith('.md') ? 'markdown' : 'file'} />}
          {n.isDir && <Icon name={expanded[n.relPath] ? 'folder-opened' : 'folder'} />}
          <span className="label">{n.name}</span>
          <div className="row-actions" style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <IconButton icon="trash" title={tr(n.isDir ? M.deleteFolder : M.deleteNote)} onClick={() => void actions.deleteNote(n.path, n.relPath, n.isDir).then(load)} />
          </div>
        </div>
        {n.isDir && expanded[n.relPath] && n.children && renderNodes(n.children, depth + 1)}
      </div>
    ))

  return (
    <>
      <div className="pane-header">
        <OneLineTitle text={tr(M.sharedNotes)} />
        <InfoTip text={tr(M.notesTip)} />
        <div className="actions">
          <IconButton icon="new-file" title={tr(M.newNoteButton)} onClick={() => void create(false)} />
          <IconButton icon="new-folder" title={tr(M.newFolderButton)} onClick={() => void create(true)} />
          <IconButton icon="refresh" title={tr(M.refresh)} onClick={load} />
          <IconButton icon="folder-opened" title={tr(M.openFolder)} onClick={() => void call('app:openPath', `${wsPath}\\.hive\\shared`)} />
        </div>
      </div>
      <div className="pane-body">
        {/* Workspace notes (#1433), pinned first whether it exists yet or not: opening it makes it. */}
        <div className={cx('row', 'pinned-note', selected?.toLowerCase() === notesFile.toLowerCase() && 'selected')} style={{ paddingLeft: 12 }} title={tr(M.workspaceNotesTip)} onClick={() => set({ selectedNote: notesFile })}>
          <Icon name="pinned" />
          <span className="label">{tr(M.workspaceNotes)}</span>
        </div>
        {others.length === 0 ? <div className="pane-empty">{tr(M.noNotes)}</div> : renderNodes(others, 0)}
      </div>
      {menu.element}
    </>
  )
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

const NO_SKILLS: SkillInfo[] = []

function SkillsPanel() {
  // Whether one is open, and its path (HI-1806): the workspace's every change would render the panel again.
  const workspace = useStore((s) => !!s.workspace)
  const version = useStore((s) => s.skillsVersion)
  const selectedSkill = useStore((s) => s.selectedSkill)
  // This workspace's skills: another workspace's (opened in this window before) never show here.
  const wsPath = useStore((s) => s.workspace?.path ?? '')
  const loaded = useScopedLoad<SkillInfo[]>(wsPath)
  const skills = loaded.data ?? NO_SKILLS
  const error = loaded.error
  const [filter, setFilter] = useState('')

  const { load: loadScoped } = loaded
  const load = useCallback(() => loadScoped(wsPath, () => call('skills:workspace')), [wsPath, loadScoped])
  useEffect(load, [load, version])
  // Refresh and Retry read the skills again everywhere they show, the Skills view's main area too (#841).
  const reload = (): void => set((s) => ({ skillsVersion: s.skillsVersion + 1 }))

  const add = async (mode: 'new' | 'file'): Promise<void> => {
    if (!workspace) return notify('warning', tr(M.openFirst))
    const s = await addSkill(mode, { kind: 'hive' })
    if (s) set({ selectedSkill: s.path })
  }

  const f = (s: SkillInfo): boolean => !filter || `${s.name} ${skillDescription(s)}`.toLowerCase().includes(filter.toLowerCase())
  const shown = skills.filter(f)
  const missing = skills.filter((s) => s.bundled === 'missing').length

  return (
    <>
      <div className="pane-header">
        {tr(M.skills)}
        <div className="actions">
          <IconButton icon="add" title={tr(M.newSkill)} onClick={() => void add('new')} disabled={!workspace} />
          <IconButton icon="file-add" title={tr(M.skillFromFile)} onClick={() => void add('file')} disabled={!workspace} />
          <IconButton icon="refresh" title={tr(M.refresh)} onClick={reload} />
          <IconButton icon="folder-opened" title={tr(M.openSkillsFolder)} onClick={() => void call('skills:openFolder')} disabled={!workspace} />
        </div>
      </div>
      {workspace && <HiveSkillsWarning />}
      <div style={{ padding: '0 8px 6px 12px' }}>
        <SearchInput style={{ height: 24 }} placeholder={tr(M.filterSkills)} value={filter} onChange={setFilter} />
      </div>
      <div className="pane-body">
        <Section title={tr(M.hiveGroup)} count={skills.length - missing} tip={SKILL_LEVEL_TIP.hive}>
          {!workspace && <div className="pane-empty">{tr(M.noWorkspaceSkills)}</div>}
          {workspace && error && loaded.data && <StaleNote what={tr(M.skillsRefreshTarget)} error={error} at={loaded.at} onRetry={reload} />}
          {workspace && error && !loaded.data && <LoadFailed inline what={tr(M.skillsLoadTarget)} error={error} onRetry={reload} />}
          {workspace && !error && !loaded.data && (
            <div className="pane-empty">
              <Icon name="loading" spin /> {tr(M.loading)}
            </div>
          )}
          {workspace && !error && loaded.data && skills.length === 0 && <div className="pane-empty">{tr(M.noSkills)}</div>}
          {shown.map((s) => (
            <SkillRow
              key={s.path}
              skill={s}
              selected={selectedSkill === s.path}
              onSelect={() => set({ selectedSkill: s.path })}
              delivered={s.audience !== 'assistant' && !s.problem && s.bundled !== 'missing' ? <DeliveredSwitch skill={s} /> : undefined}
              actionsFor={
                s.bundled === 'missing' ? (
                  <IconButton icon="history" title={tr(M.restoreSkill)} onClick={() => void restoreBundled(s).then((r) => r && set({ selectedSkill: r.path }))} />
                ) : (
                  <IconButton icon="trash" title={tr(M.deleteSkill)} onClick={() => void deleteSkill(s)} />
                )
              }
            />
          ))}
        </Section>
        {workspace && (
          <p className="hint" style={{ padding: '4px 14px' }}>
            {Children.toArray(tRich<React.ReactNode>(M.skillsHint, { b: bold }))}
          </p>
        )}
      </div>
    </>
  )
}


// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

function McpPanel() {
  const workspace = useStore((s) => s.workspace)
  const version = useStore((s) => s.skillsVersion)
  const selected = useStore((s) => s.selectedMcp)
  const api = useStore((s) => s.api)
  const settings = useStore((s) => s.settings)
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const loaded = useRef(false)
  // Search and filter for a long list (HI-2059): by name, description and tags, and by where a server is added.
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<McpFilter>('all')
  // Installed, or the catalogues' servers to install (HI-545).
  const tab = useStore((s) => s.mcpTab)

  const wsPath = workspace?.path
  const load = useCallback(() => {
    if (!wsPath) return
    void call('mcp:list').then((l) => {
      setServers(l)
      loaded.current = true
    })
  }, [wsPath])
  useEffect(load, [load, version])

  if (!workspace) {
    return (
      <>
        <div className="pane-header">{tr(M.mcpServers)}</div>
        <NoWorkspace what="mcp" />
      </>
    )
  }

  const create = async (): Promise<void> => {
    const name = await prompt({
      title: tr(M.newServerTitle),
      message: tr(M.newServerMessage, { file: '.hive/mcp/<name>.json' }),
      placeholder: tr(msg({ id: 'actions.mcp.namePlaceholder', defaultMessage: 'server-name', description: "Placeholder of the server's name box: an example name (lower case, a dash)." })),
      confirmLabel: tr(M.create),
      validate: (v) => (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v.trim()) && v.trim() !== 'hive' ? null : tr(M.serverNameRule))
    })
    if (!name) return
    const m = await actions.attempt(tr(M.createServerFailed), () => call('mcp:create', name.trim()))
    if (m) set({ selectedMcp: m.name })
    load()
  }

  const hiveOn = !!(settings?.agentApi.enabled && settings.agentApi.provideHiveMcp && api?.running)
  const shown = servers.filter((m) => mcpServerShown(m, query, filter))

  return (
    <>
      <div className="pane-header">
        {tr(M.mcpServers)}
        <InfoTip text={tr(M.mcpTip)} />
        <div className="actions">
          <IconButton icon="add" title={tr(M.newServer)} onClick={() => void create()} />
          <IconButton icon="file-add" title={tr(M.serverFromFile)} onClick={() => void actions.addMcpServerFromFile().then((m) => m && load())} />
          <IconButton icon="refresh" title={tr(M.refresh)} onClick={() => (tab === 'catalogue' ? set((s) => ({ mcpCatalogVersion: s.mcpCatalogVersion + 1 })) : load())} />
          <IconButton icon="folder-opened" title={tr(M.openMcpFolder)} onClick={() => void call('mcp:openFolder')} />
        </div>
      </div>
      <div className="mcp-tabs">
        <div className="segmented" role="tablist" aria-label={tr(M.mcpServers)}>
          <button role="tab" aria-selected={tab === 'installed'} className={cx(tab === 'installed' && 'active')} data-mcp-tab="installed" onClick={() => set({ mcpTab: 'installed' })}>
            {tr(M.installedTab)}
          </button>
          <button role="tab" aria-selected={tab === 'catalogue'} className={cx(tab === 'catalogue' && 'active')} data-mcp-tab="catalogue" onClick={() => set({ mcpTab: 'catalogue' })}>
            {tr(M.catalogueTab)}
          </button>
        </div>
      </div>
      {tab === 'catalogue' ? (
        <div className="pane-body">
          <McpCatalogPanel />
        </div>
      ) : (
      <div className="pane-body">
        {servers.length > 0 && <McpSearch query={query} filter={filter} onQuery={setQuery} onFilter={setFilter} errors stacked />}
        <Section title={tr(M.workspaceGroup)} count={servers.length}>
          {loaded.current && servers.length === 0 && <div className="pane-empty">{tr(M.noServers)}</div>}
          {servers.length > 0 && !shown.length && <div className="pane-empty">{tr(M.noMatch)}</div>}
          {shown.map((m) => (
            <div key={m.name} className={cx(/* i18n-ignore: class names */ 'row tall', selected === m.name && 'selected')} onClick={() => set({ selectedMcp: m.name })}>
              <Icon name={m.error ? 'error' : m.def?.url ? 'globe' : 'plug'} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="label">
                  {m.name}{' '}
                  {m.secretWarnings.length > 0 && (
                    <Tooltip content={m.secretWarnings.join('\n')}>
                      <Icon name="warning" />
                    </Tooltip>
                  )}
                </div>
                <div className="desc" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {actions.mcpErrorText(m) ?? m.def?.description ?? m.def?.command ?? m.def?.url}
                </div>
                {!m.error && (
                  <div className="desc mcp-where" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {actions.mcpWhereText(m, workspace.projects)}
                  </div>
                )}
              </div>
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                <IconButton icon="trash" title={tr(M.deleteServer)} onClick={() => void actions.deleteMcpServer(m)} />
              </div>
            </div>
          ))}
        </Section>
        <Section title={tr(M.builtIn)} count={1}>
          <div className={cx(/* i18n-ignore: class names */ 'row tall', selected === '__hive' && 'selected')} onClick={() => set({ selectedMcp: '__hive' })}>
            <Icon name="hubot" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="label">{'hive' /* i18n-ignore: the server's name */}</div>
              <div className="desc">{tr(M.hiveServerDesc)}</div>
            </div>
            <Tooltip content={tr(M.hiveServerTip)}>
              <span className={cx('badge', hiveOn ? 'success' : '')}>{tr(hiveOn ? M.on : M.off)}</span>
            </Tooltip>
          </div>
        </Section>
      </div>
      )}
    </>
  )
}
