import { PresetsNotice } from './components/WorkflowOptions'
import { fmt, msg, tr } from '@shared/i18n'
import { useAntivirusOffer } from './components/Antivirus'
import { useEffect, useRef } from 'react'
import type { HiveEvent } from '@shared/types'
import { call } from './api'
import { playChime } from './chime'
import { matchKeybinding, runCommand } from './commands'
import { AboutDialog, AgentSetupDialog, DiagnosticsDialog, CommandPalette, CompactDialog, Dialogs, NotificationCenter, ProvidersBanner, QuitDialog, QuitPendingBanner, ShortcutsDialog, Toasts } from './components/Overlays'
import { AddAgentDialog, AgentSettingsDialog, HandOverDialog, MergeDialog, TemplateAgentDialog } from './components/AgentDialogs'
import { BoardUpgradeAsk, BoardUpgradeBanner } from './components/BoardUpgrade'
import { ArchiveAllDialog, BoardView, MoveToDoingDialog, TaskDialog, TaskStartDialog } from './components/Board'
import { LaneStartDialog } from './components/LaneStartDialog'
import { WorkspaceOverviewView } from './views/WorkspaceOverview'
import { PerformanceView } from './views/Performance'
import { RemoveProjectDialog } from './components/ProjectRemoval'
import { UpdateDialog } from './components/Updates'
import { ModeMenuHost } from './components/PermissionMode'
import { ActivityBar, StatusBar } from './components/Shell'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { enabledProviders } from '@shared/providers'
import { tipsState } from '@shared/tips'
import { CornerPlacement, TipCard, TipsDialog } from './components/Tips'
import { applyTipsState, showTodaysTip } from './tips'
import { startupReplay } from './startupReplay'
import { AssistantPanel, AssistantSettingsDialog } from './components/Assistant'
import { ProgressPanel, progressRunsChanged } from './components/Progress'
import { queueBoardChanged, queueChangedEvent } from './queueSource'
import { AssistantMain } from './components/AssistantView'
import { loadAssistantChanges } from './assistantUndo'
import { agentOnScreen, applyLeftovers, applyLiveState, assistantOnLeft, assistantWasOpen, clearStartFailure, filesListeners, findProject, get, loadTasks, noteAgentAdded, notify, projectKey, pushToast, set, useLanguage, useProviderWarnings, useStore } from './store'
import { DocsView, McpView, NotesView, SkillView, WelcomeView } from './views/OtherViews'
import { TemplatesView } from './components/Templates'
import { ProjectView } from './views/ProjectView'
import { SettingsView } from './views/SettingsView'
import { ErrorBoundary } from './components/ErrorBoundary'
import { markOnScreenSeen, onScreen } from './inbox'
import { InboxPopover } from './components/Inbox'
import { MoveRepairDialog, MovedBanner } from './components/MoveRepair'
import { SetAsideDialog } from './components/SetAside'
import { NoticeBanners, addNotice, resolveNotices } from './components/NoticeBanners'
import { chimeAllowed } from '@shared/bursts'
import { loadAdvanced } from './advanced'
import { applyProjectPref } from './projectPrefs'
// The agent-state mark's test hook (the statemarks suite), until the session page shows the marks itself (#974).
import './components/StateMark'

function applyTheme(): void {
  const s = get().settings
  if (!s) return
  const t = s.appearance.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : s.appearance.theme
  document.documentElement.dataset.theme = t
  document.documentElement.style.setProperty('--ui-font-size', `${s.appearance.uiFontSize}px`)
  void call('window:setTitleBarColors', t === 'dark' ? '#1f1f1f' : '#f3f3f3', t === 'dark' ? '#cccccc' : '#333333')
}

const noticedMcp = new Set<string>()

function noticeUnmanagedMcp(): void {
  for (const p of get().workspace?.projects ?? []) {
    if (!p.unmanagedMcp.length || noticedMcp.has(p.path)) continue
    noticedMcp.add(p.path)
    pushToast({
      id: `mcp-${p.path}`,
      level: 'warning',
      title: tr(msg({ id: 'shell.mcp.notInWorkspace', defaultMessage: '{project}: MCP servers not in the workspace', description: "A notice: a project defines MCP servers of its own (in its .mcp.json) that the workspace doesn't have. {project} is its name." }), { project: p.name }),
      message: tr(msg({ id: 'shell.mcp.notInWorkspaceDetail', defaultMessage: "{n, plural, one {{servers} is defined in the project's .mcp.json and will stay disabled until copied to the workspace.} other {{servers} are defined in the project's .mcp.json and will stay disabled until copied to the workspace.}}", description: "More in the notice about a project's own MCP servers. {servers} lists their names; {n} is how many. .mcp.json is a file name: keep it." }), { n: p.unmanagedMcp.length, servers: fmt.list(p.unmanagedMcp) }),
      actions: [{ label: tr(msg({ id: 'shell.mcp.copyToWorkspace', defaultMessage: 'Copy to workspace', description: "The notice's button: copies the project's MCP servers to the workspace." })), command: 'mcp.import', args: [p.path, p.unmanagedMcp] }],
      timestamp: new Date().toISOString()
    })
  }
}

/** When the last chime played, and how many have (for tests). */
let lastChimeAt: number | null = null
let chimesPlayed = 0
;(window as unknown as { __hiveChimes?: () => number }).__hiveChimes = () => chimesPlayed

function handleEvent(e: HiveEvent): void {
  switch (e.type) {
    case 'recent-changed':
      // Opened, removed or cleared (in any window): this window's view of the list, asked for again (#144).
      void call('workspace:recent').then((recent) => set({ recent })).catch(() => undefined)
      break
    case 'workspace-changed': {
      const sel = get().selectedProject
      const ws = e.workspace
      // Another workspace in this window: its Assistant panel shows as that workspace left it, and its board.
      const other = ws?.path !== get().workspace?.path
      if (other) set({ assistantOpen: assistantWasOpen(ws?.path), tasks: [], boardProject: null, taskOpen: null, taskStartFor: null, laneStartFor: null, taskDoing: null })
      if (other) void loadLeftovers()
      if (other) void loadAdvanced()
      // Drop warnings about projects that belong to a workspace that is no longer open.
      set((s) => ({ workspace: ws, toasts: s.toasts.filter((t) => !t.id.startsWith('mcp-') || !!ws?.projects.some((p) => t.id === `mcp-${p.path}`)) }))
      if (ws && (!sel || !ws.projects.some((p) => p.path === sel))) set({ selectedProject: (ws.projects.find((p) => p.active) ?? ws.projects[0])?.path ?? null })
      if (!ws) set({ selectedProject: null })
      if (other) void loadTasks()
      noticeUnmanagedMcp()
      break
    }
    case 'session-status': {
      const path = findProject(get(), e.state.projectPath)?.path ?? e.state.projectPath
      // A new session (or its worktree setup) gets a fresh terminal. The setup command and Claude Code share one.
      const key = projectKey(path, e.state.agentId)
      const prev = findProject(get(), path)?.agents.find((a) => a.id === e.state.agentId)?.live
      if (e.state.status === 'starting' && !prev?.settingUp) set((s) => ({ sessionEpoch: { ...s.sessionEpoch, [key]: (s.sessionEpoch[key] ?? 0) + 1 } }))
      // A new launch: the last one's failure no longer applies.
      if (e.state.status === 'starting') clearStartFailure(path, e.state.agentId)
      // An agent on screen is seen as it finishes: it never shows as unseen.
      if (e.state.unseen && onScreen(path, e.state.agentId)) {
        applyLiveState({ ...e.state, unseen: false })
        void call('session:markSeen', path, [e.state.agentId]).catch(() => undefined)
      } else applyLiveState(e.state)
      break
    }
    case 'session-exit': {
      set((s) => ({ usageVersion: { ...s.usageVersion, [e.projectPath]: (s.usageVersion[e.projectPath] ?? 0) + 1 } }))
      if (!e.failure) break
      const p = findProject(get(), e.projectPath)
      const path = p?.path ?? e.projectPath
      const failure = e.failure
      set((s) => ({ startFailures: { ...s.startFailures, [projectKey(path, e.agentId)]: failure } }))
      // Its pane says why; a toast only when the pane isn't on screen.
      const name = p?.agents.find((a) => a.id === e.agentId)?.name
      const shown = get().workspace?.projects.some((x) => x.path === path)
      if (!agentOnScreen(path, e.agentId))
        pushToast({
          id: `start-failed-${projectKey(path, e.agentId)}`,
          level: 'error',
          title: name ? (p ? tr(msg({ id: 'shell.startFailed.named', defaultMessage: "{project} · {agent} couldn't start", description: "A notice when an agent's session failed to start, while its pane isn't on screen. {project} and {agent} are names." }), { project: p.name, agent: name }) : tr(msg({ id: 'shell.startFailed.agent', defaultMessage: "{agent} couldn't start", description: "A notice when an agent's session failed to start. {agent} is its name." }), { agent: name })) : tr(msg({ id: 'shell.startFailed.unnamed', defaultMessage: "An agent couldn't start", description: "A notice when a session failed to start and its agent isn't known." })),
          message: failure.hint ?? failure.reason,
          actions: shown ? [{ label: tr(msg({ id: 'shell.startFailed.show', defaultMessage: 'Show', description: "The notice's button: shows the agent's pane." })), command: 'agent.show', args: [path, e.agentId] }] : undefined,
          timestamp: failure.at
        })
      break
    }
    case 'agent-leftovers': {
      const path = findProject(get(), e.leftovers.projectPath)?.path ?? e.leftovers.projectPath
      applyLeftovers({ ...e.leftovers, projectPath: path })
      // Nothing left (ended, kept, or ended by themselves): the offers to end them go too.
      if (!e.leftovers.processes.length && !e.leftovers.more) {
        const offer = (a: { command: string; args?: unknown[] }): boolean => a.command === 'session.settleLeftovers' && String(a.args?.[0]).toLowerCase() === e.leftovers.projectPath.toLowerCase() && a.args?.[1] === e.leftovers.agentId
        set((s) => ({ toasts: s.toasts.filter((t) => !t.actions?.some(offer)) }))
      }
      break
    }
    case 'usage-changed': {
      const path = findProject(get(), e.projectPath)?.path ?? e.projectPath
      set((s) => ({ usageVersion: { ...s.usageVersion, [path]: (s.usageVersion[path] ?? 0) + 1 } }))
      break
    }
    case 'toast':
      pushToast(e.toast)
      break
    case 'chime': {
      // Agents finishing together chime once: at most one every 2 seconds.
      const n = get().settings?.notifications
      if (!n || !chimeAllowed(lastChimeAt, Date.now())) break
      lastChimeAt = Date.now()
      chimesPlayed++
      // Silent in a quiet test copy: counted, not heard.
      if (!e.silent) playChime(n.chimeSound, n.chimeVolume)
      break
    }
    case 'ui-pref-changed':
      applyProjectPref(e.pref, e.project, e.value)
      break
    case 'tips-changed':
      applyTipsState(tipsState(e.tips))
      break
    case 'advanced-changed':
      void loadAdvanced()
      break
    case 'settings-changed':
      set({ settings: e.settings })
      applyTheme()
      setTimeout(() => void call('api:info').then((api) => set({ api })), 400)
      break
    case 'provider-install':
      set((st) => ({ providers: { ...st.providers, [e.provider]: e.info } }))
      break
    case 'git-tool':
      set({ gitTool: e.git })
      break
    case 'menu-command':
      runCommand(e.command, ...(e.args ?? []))
      break
    case 'quit-request':
      set({ quitRequest: e.sessions, quitUnsaved: e.unsaved, quitScope: e.scope ?? 'app' })
      break
    case 'quit-pending':
      set({ quitPending: e.pending ? { working: e.working } : null })
      break
    case 'keep-awake':
      set({ keepAwake: e.working })
      break
    case 'files-changed':
      filesListeners.forEach((l) => l(e.projectPath, e.dirs))
      break
    case 'plan-usage':
      set((st) => ({ planUsage: { ...st.planUsage, [e.provider]: e.usage } }))
      break
    case 'update-state':
      set({ update: e.state })
      break
    case 'notes-changed':
      set((s) => ({ notesVersion: s.notesVersion + 1 }))
      break
    case 'tasks-changed':
      if (e.workspacePath.toLowerCase() === get().workspace?.path.toLowerCase()) {
        scheduleTasksLoad()
        queueBoardChanged()
      }
      break
    case 'skills-changed':
      set((s) => ({ skillsVersion: s.skillsVersion + 1 }))
      break
    case 'modes-changed':
      set((s) => ({ modesVersion: s.modesVersion + 1 }))
      break
    case 'journal-changed':
      if (e.workspacePath.toLowerCase() === get().workspace?.path.toLowerCase()) set((s) => ({ journalVersion: s.journalVersion + 1 }))
      break
    case 'assistant-activity':
      set((s) => ({ assistantActions: [...s.assistantActions, e.action].slice(-200) }))
      // What it changed is kept for undo as it is made (#1283): the panel's list follows.
      void loadAssistantChanges()
      break
    case 'language-changed':
      // i18n.ts has switched the text; the language setting's notes read the rest.
      set((s) => ({ appInfo: s.appInfo && { ...s.appInfo, language: e.language } }))
      break
    case 'usage-history':
      // The usage history's import (#1106): the Workspace Overview's note follows it.
      set((s) => (s.workspaceUsage && s.workspaceUsage.workspacePath.toLowerCase() === e.workspacePath.toLowerCase() ? { workspaceUsage: { ...s.workspaceUsage, history: e.progress } } : {}))
      break
    case 'progress-runs':
      if (e.workspacePath.toLowerCase() === get().workspace?.path.toLowerCase()) progressRunsChanged(e)
      break
    case 'merge-slots-changed':
      if (e.workspacePath.toLowerCase() === get().workspace?.path.toLowerCase()) set({ mergeSlots: e.slots })
      break
    case 'queue-changed':
      if (e.workspacePath.toLowerCase() === get().workspace?.path.toLowerCase()) queueChangedEvent(e.projectPath)
      break
    case 'lanes-changed':
      if (e.workspacePath.toLowerCase() === get().workspace?.path.toLowerCase()) set({ lanes: e.lanes })
      break
    case 'assistant-questions': {
      const before = get().assistantQuestions
      set({ assistantQuestions: e.questions })
      // With the panel hidden, the question comes as a notification the user can answer.
      if (!get().assistantOpen) {
        for (const q of e.questions.filter((x) => !before.some((b) => b.id === x.id))) {
          notify('warning', q.title, q.message, [
            { label: q.yes, command: 'assistant.answer', args: [q.id, true] },
            { label: q.no, command: 'assistant.answer', args: [q.id, false] }
          ])
        }
      }
      break
    }
    case 'agent-added':
      noteAgentAdded(e.projectPath, e.agentId)
      break
    case 'branch-status':
      set((st) => ({ branchStatus: { ...st.branchStatus, [projectKey(e.projectPath, e.agentId)]: e.status } }))
      break
    case 'notice':
      addNotice(e.notice)
      break
    case 'notice-resolved':
      resolveNotices(e.projectPath, e.agentId)
      break
    case 'window-state':
      // Focusing the window marks the agents on screen seen (markOnScreenSeen).
      set({ maximized: e.maximized, windowFocused: e.focused, alwaysOnTop: e.alwaysOnTop })
      break
    case 'windows-changed':
      set({ windowCount: e.count })
      break
  }
}

let tasksTimer: number | undefined
/** Reads the board again shortly (one change can come as several events: Hive's own and the folder watcher's). */
/** What this window's agents left running (#507), replacing what the store had (another workspace's). */
async function loadLeftovers(): Promise<void> {
  const all = await call('session:leftovers').catch(() => [])
  set({ leftovers: {} })
  for (const l of all) applyLeftovers({ ...l, projectPath: findProject(get(), l.projectPath)?.path ?? l.projectPath })
}

function scheduleTasksLoad(): void {
  window.clearTimeout(tasksTimer)
  tasksTimer = window.setTimeout(() => void loadTasks(), 120)
}

export function App() {
  // In a new language, every component renders again (#767): App's render renders them all.
  useLanguage()
  const workspace = useStore((s) => s.workspace)
  useAntivirusOffer()
  const assistantLeft = useStore(assistantOnLeft)
  const activity = useStore((s) => s.activity)
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const sidebarVisible = useStore((s) => s.sidebarVisible)
  const sidebarCompact = useStore((s) => s.sidebarCompact)
  const setupShown = useRef(false)

  useEffect(() => {
    // What another window changes while this one loads must outlive the older snapshot it loads (#295).
    const early = startupReplay(handleEvent)
    const off = window.hive.onEvent((e) => {
      handleEvent(e)
      early.note(e)
    })
    void (async () => {
      const [s, ui, ws, recent, ag, api, info, live] = await Promise.all([
        call('settings:get'),
        call('ui:get'),
        call('workspace:get'),
        call('workspace:recent'),
        call('provider:info'),
        call('api:info'),
        call('app:info'),
        call('session:live')
      ])
      // A startup cleaned up meanwhile (StrictMode's first, in development) leaves the window to the newer one (#337).
      if (!early.active()) return
      set({ settings: s, sidebarWidth: ui.sidebarWidth, sidebarVisible: ui.sidebarVisible, sidebarCompact: !!ui.sidebarCompact, panes: ui.panes ?? {}, skillsProvider: ui.skillsProvider ?? {}, skillsFold: ui.skillsFold ?? {}, sessionsTree: ui.sessionsTree ?? {}, hiveVcsNotice: ui.hiveVcsNotice ?? {}, assistantFold: ui.assistantFold ?? {}, boardFold: ui.boardFold ?? {}, progressFilter: ui.progressFilter ?? {}, laneOrder: ui.laneOrder ?? {}, tips: tipsState(ui.tips), workspace: ws, recent, providers: ag, api, appInfo: info })
      early.settle()
      set({ assistantOpen: assistantWasOpen(ws?.path) })
      // A window restored on top (its workspace was left pinned) shows its pin lit from the start.
      void call('window:getAlwaysOnTop').then((on) => {
        if (early.active()) set({ alwaysOnTop: on })
      }).catch(() => undefined)
      if (ws) set({ selectedProject: (ws.projects.find((p) => p.active) ?? ws.projects[0])?.path ?? null })
      for (const l of live) applyLiveState(l)
      void loadLeftovers()
      void loadTasks()
      void loadAdvanced()
      void call('git:tool').then((g) => {
        if (early.active()) set((st) => ({ gitTool: st.gitTool ?? g }))
      })
      void call('agents:branchStatuses').then((list) => {
        if (early.active()) set((st) => ({ branchStatus: { ...Object.fromEntries(list.map((b) => [projectKey(b.projectPath, b.agentId), b.status])), ...st.branchStatus } }))
      })
      // A reloaded window picks up a quit dialog or pending quit that was already in progress.
      const more = { planUsage: await call('app:planUsage'), update: await call('update:state'), keepAwake: await call('app:keepAwake'), windowCount: await call('window:count') }
      if (!early.active()) return
      set(more)
      const q = await call('app:quitState')
      if (!early.active()) return
      set({ quitRequest: q.request, quitUnsaved: q.unsaved, quitScope: q.scope, quitPending: q.pending ? { working: q.working } : null })
      applyTheme()
      noticeUnmanagedMcp()
      // The day's tip, once the window has settled.
      setTimeout(showTodaysTip, 4000)
    })()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', applyTheme)
    return () => {
      off()
      early.stop()
      mq.removeEventListener('change', applyTheme)
    }
  }, [])

  // A provider in use that isn't installed, or none installed at all (#474): offer its setup once detection has finished.
  const warn = useProviderWarnings()
  useEffect(() => {
    if (setupShown.current || !settings) return
    const missing = warn.noneInstalled ? enabledProviders(settings)[0]?.id : warn.providers.find((p) => providers[p.id] && !providers[p.id].checking && !providers[p.id].found)?.id
    if (missing) {
      setupShown.current = true
      set({ setupOpen: missing })
    }
  }, [providers, settings, warn])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (get().dialog || get().paletteOpen || get().recordingKeys) return
      const cmd = matchKeybinding(e)
      if (!cmd) return
      e.preventDefault()
      e.stopPropagation()
      runCommand(cmd.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Agents whose panes come on screen (a project, page, tab or the window shown) are seen.
  useEffect(() => useStore.subscribe(markOnScreenSeen), [])

  // Main hears which project this window shows, for banners shown for "This project" (#157).
  const showing = useStore((s) => (s.workspace ? s.selectedProject : null))
  useEffect(() => {
    void call('window:showing', showing).catch(() => undefined)
  }, [showing])

  useEffect(() => {
    void call('ui:set', { sidebarVisible })
  }, [sidebarVisible])

  useEffect(() => {
    void call('ui:set', { sidebarCompact })
  }, [sidebarCompact])

  if (!settings) return <div className="app" />

  const main = (() => {
    switch (activity) {
      case 'settings':
        return <SettingsView />
      case 'docs':
        return <DocsView />
      case 'notes':
        return <NotesView />
      case 'skills':
        return <SkillView />
      case 'templates':
        return <TemplatesView />
      case 'mcp':
        return <McpView />
      case 'assistant':
        return <AssistantMain />
      case 'board':
        return <BoardView />
      case 'overview':
        return <WorkspaceOverviewView />
      case 'performance':
        return <PerformanceView />
      default:
        return workspace ? null : <WelcomeView />
    }
  })()

  return (
    <div className="app">
      <TitleBar />
      <div className="workbench">
        <ActivityBar />
        <Sidebar />
        {workspace && assistantLeft && (
          <ErrorBoundary view="assistant">
            <AssistantPanel />
          </ErrorBoundary>
        )}
        <div className="main-area">
          <QuitPendingBanner />
          <ProvidersBanner />
          <MovedBanner />
          <BoardUpgradeBanner />
          <PresetsNotice />
          {workspace && <ProjectView visible={activity === 'projects'} />}
          {main && (
            <div className="tab-body">
              <ErrorBoundary resetKey={activity}>
                {main}
              </ErrorBoundary>
            </div>
          )}
        </div>
        {workspace && (
          <ErrorBoundary view="progress">
            <ProgressPanel />
          </ErrorBoundary>
        )}
        {workspace && !assistantLeft && (
          <ErrorBoundary view="assistant">
            <AssistantPanel />
          </ErrorBoundary>
        )}
      </div>
      <StatusBar />
      <CornerPlacement />
      <TipCard />
      <Toasts />
      <NoticeBanners />
      <NotificationCenter />
      <InboxPopover />
      <CommandPalette />
      <QuitDialog />
      <CompactDialog />
      <MoveRepairDialog />
      <SetAsideDialog />
      <BoardUpgradeAsk />
      <AddAgentDialog />
      <AgentSettingsDialog />
      <TemplateAgentDialog />
      <AssistantSettingsDialog />
      <MergeDialog />
      <HandOverDialog />
      <TaskDialog />
      <ArchiveAllDialog />
      <TaskStartDialog />
      <LaneStartDialog />
      <MoveToDoingDialog />
      <RemoveProjectDialog />
      <AboutDialog />
      <DiagnosticsDialog />
      <UpdateDialog />
      <ModeMenuHost />
      <ShortcutsDialog />
      <TipsDialog />
      <AgentSetupDialog />
      {/* Last: its questions (confirm, choose, prompt) are often asked from another dialog, so they go on top. */}
      <Dialogs />
    </div>
  )
}
