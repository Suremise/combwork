import { PresetsNotice } from './components/WorkflowOptions'
import { NewProjectsNotice } from './components/PresetStep'
import { fmt, msg, tr } from '@shared/i18n'
import { useAntivirusOffer } from './components/Antivirus'
import { useEffect, useRef, useState } from 'react'
import type { CombworkEvent } from '@shared/types'
import { call } from './api'
import { playChime } from './chime'
import { matchKeybinding, runCommand, runCommandAsync } from './commands'
import { HooksDialog } from './components/HooksDialog'
import { AdminSnippetDialog } from './components/AdminSnippetDialog'
import { AboutDialog, AgentSetupDialog, DiagnosticsDialog, CommandPalette, CompactDialog, Dialogs, NotificationCenter, ProvidersBanner, QuitDialog, QuitPendingBanner, ShortcutsDialog } from './components/Overlays'
import { ConnectionsIntroBanner, useProviderWarnings } from './components/ConnectionChoice'
import { AddAgentDialog, AgentSettingsDialog, askWorkflowToolsRestart, HandOverDialog, MergeDialog, TemplateAgentDialog } from './components/AgentDialogs'
import { BranchMergeDialog } from './components/BranchMerge'
import { BoardUpgradeAsk, BoardUpgradeBanner } from './components/BoardUpgrade'
import { WorkspaceOpening } from './components/WorkspaceOpening'
import { CloseCommandPanel } from './components/CloseCommandPanel'
import { ArchiveAllDialog, BoardView, MoveToDoingDialog, TaskDialog, TaskStartDialog } from './components/Board'
import { LaneStartDialog } from './components/LaneStartDialog'
import { WorkspaceOverviewView } from './views/WorkspaceOverview'
import { PerformanceView } from './views/Performance'
import { WorkspaceActivityView } from './views/WorkspaceActivity'
import { RemoveProjectDialog } from './components/ProjectRemoval'
import { UpdateDialog } from './components/Updates'
import { ModeMenuHost } from './components/PermissionMode'
import { ActivityBar, StatusBar } from './components/Shell'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { enabledProviders } from '@shared/providers'
import { tipsState } from '@shared/tips'
import { CornerPlacement, TipsDialog } from './components/Tips'
import { Popups } from './components/Popups'
import { startEntryReconciler } from './entryConditions'
import { applyTipsState, showTodaysTip, startTipWatch } from './tips'
import { startupReplay } from './startupReplay'
import { movesShown } from './pendingMoves'
import { AssistantPanel, AssistantSettingsDialog } from './components/Assistant'
import { ProgressPanel, progressRunsChanged } from './components/Progress'
import { queueBoardChanged, queueChangedEvent } from './queueSource'
import { AssistantMain } from './components/AssistantView'
import { reloadAssistantChanges } from './assistantUndo'
import { agentOnScreen, applyLeftovers, applyLiveState, bumpUsage, noteAssistantAction, flushLiveStates, setLoaded, setWithLive, showWorkspace, liveStateOf, assistantOnLeft, assistantWasOpen, clearStartFailure, filesListeners, agentStartChanged, findProject, get, loadTasks, noteAgentAdded, noteEnd, projectKey, pushToast, resolveToasts, set, updateToasts, useLanguage, useStore } from './store'
import { DocsView, McpView, NotesView, SkillView, WelcomeView } from './views/OtherViews'
import { DialectView } from './components/Dialects'
import { TemplatesView } from './components/Templates'
import { ProjectView } from './views/ProjectView'
import { SettingsView } from './views/SettingsView'
import { ErrorBoundary } from './components/ErrorBoundary'
import { markOnScreenSeen, onScreen } from './inbox'
import { InboxPopover } from './components/Inbox'
import { MoveRepairDialog, MovedBanner } from './components/MoveRepair'
import { SetAsideDialog } from './components/SetAside'
import { chimeAllowed } from '@shared/bursts'
import { sessionEpochBook } from '@shared/sessionEpoch'
import { loadAdvanced } from './advanced'
import { applyProjectPref } from './projectPrefs'
import { useLayoutRoom } from './layoutRoom'
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
      target: { kind: 'project', projectPath: p.path, project: p.name },
      title: tr(msg({ id: 'shell.mcp.notInWorkspace', defaultMessage: '{project}: MCP servers not in the workspace', description: "A notice: a project defines MCP servers of its own (in its .mcp.json) that the workspace doesn't have. {project} is its name." }), { project: p.name }),
      message: tr(msg({ id: 'shell.mcp.notInWorkspaceDetail', defaultMessage: "{n, plural, one {{servers} is defined in the project's .mcp.json and will stay disabled until copied to the workspace.} other {{servers} are defined in the project's .mcp.json and will stay disabled until copied to the workspace.}}", description: "More in the notice about a project's own MCP servers. {servers} lists their names; {n} is how many. .mcp.json is a file name: keep it." }), { n: p.unmanagedMcp.length, servers: fmt.list(p.unmanagedMcp) }),
      actions: [{ label: tr(msg({ id: 'shell.mcp.copyToWorkspace', defaultMessage: 'Copy to workspace', description: "The notice's button: copies the project's MCP servers to the workspace." })), command: 'mcp.import', args: [p.path, p.unmanagedMcp] }],
      // Live while some of them still aren't in the workspace (HI-2320: entryConditions.ts).
      condition: { kind: 'mcpMissing', projectPath: p.path, names: p.unmanagedMcp },
      timestamp: new Date().toISOString()
    })
  }
}

/** When the last chime played, and how many have (for tests). */
let lastChimeAt: number | null = null
/** The run each agent terminal's epoch was made for (HI-2213). */
const epochBook = sessionEpochBook()
let chimesPlayed = 0
;(window as unknown as { __cwChimes?: () => number }).__cwChimes = () => chimesPlayed
// The bell's list as the tests read it (HI-2320): each entry, whether it was quiet (no pop-up), its buttons and what it says once resolved.
;(window as unknown as { __cwBell?: () => unknown[] }).__cwBell = () => get().notifications.map((t) => ({ id: t.id, title: t.title, kind: t.kind ?? null, level: t.level, quiet: !!t.quiet, resolved: t.resolved ?? null, actions: t.actions?.map((x) => x.label) ?? [], target: t.target?.kind ?? null }))

function handleEvent(e: CombworkEvent): void {
  switch (e.type) {
    case 'workspace-progress':
      setLoaded({ openProgress: e.progress })
      break
    case 'recent-changed':
      // Opened, removed or cleared (in any window): this window's view of the list, asked for again (#144).
      void call('workspace:recent').then((recent) => setLoaded({ recent })).catch(() => undefined)
      break
    case 'workspace-changed': {
      const sel = get().selectedProject
      // A move shown and still being saved stays as shown (#1229): this report may have read the order from before it.
      const ws = movesShown.keep(e.workspace)
      // Another workspace in this window: its Assistant panel shows as that workspace left it, and its board.
      const other = ws?.path !== get().workspace?.path
      if (other) set({ assistantOpen: assistantWasOpen(ws?.path), tasks: [], boardProject: null, taskOpen: null, taskStartFor: null, laneStartFor: null, taskDoing: null })
      if (other) void loadLeftovers()
      if (other) void loadAdvanced()
      showWorkspace(ws, other)
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
      // As last told, a state not shown yet too (applyLiveState shows them a few times a second, HI-1806).
      const prev = liveStateOf(path, e.state.agentId)
      // Its new terminal shown with its start, in the same update (HI-1862: a dozen agents started at once); once per
      // run, however often its start is told (HI-2213).
      if (e.state.status === 'starting' && !prev?.settingUp) {
        const { runId } = e.state
        const shown = prev?.runId
        setWithLive((s) => {
          const epoch = epochBook.starting(key, runId, s.sessionEpoch[key], shown)
          return epoch === undefined ? {} : { sessionEpoch: { ...s.sessionEpoch, [key]: epoch } }
        }, true)
      }
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
      bumpUsage(e.projectPath)
      // Why and when it ended, for its stopped pane (HI-1881); a failed launch has none (its failed bar says so).
      if (e.ended) noteEnd(findProject(get(), e.projectPath)?.path ?? e.projectPath, e.agentId, e.ended)
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
          ...(name ? { target: { kind: 'agent' as const, projectPath: path, agentId: e.agentId, name, project: p?.name ?? path } } : {}),
          actions: shown ? [{ label: tr(msg({ id: 'shell.startFailed.show', defaultMessage: 'Show', description: "The notice's button: shows the agent's pane." })), command: 'agent.show', args: [path, e.agentId] }] : undefined,
          timestamp: failure.at
        })
      break
    }
    case 'agent-leftovers': {
      const path = findProject(get(), e.leftovers.projectPath)?.path ?? e.leftovers.projectPath
      // Its notice's End Them / Keep Running is main's offer (HI-2320): main resolves it as they end or change.
      applyLeftovers({ ...e.leftovers, projectPath: path })
      break
    }
    case 'usage-changed': {
      bumpUsage(findProject(get(), e.projectPath)?.path ?? e.projectPath)
      break
    }
    case 'toast':
      pushToast(e.toast)
      break
    case 'toast-resolved':
      resolveToasts(e.ids, e.outcome)
      break
    case 'toast-update':
      updateToasts(e.ids, e.drop, e.note)
      break
    case 'notify-pending':
      set({ finishesPending: e.finishes })
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
    case 'ui-panes-changed': {
      const panes = { ...get().panes }
      for (const [k, v] of Object.entries(e.panes)) {
        if (v === null) delete panes[k]
        else panes[k] = v
      }
      set({ panes })
      break
    }
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
      // An entry's button run here for another window (HI-2320): that window's spinner waits until it has finished.
      if (e.reply) {
        const reply = e.reply
        void runCommandAsync(e.command, ...(e.args ?? [])).finally(() => void call('notice:actionDone', reply, null).catch(() => undefined))
      } else runCommand(e.command, ...(e.args ?? []))
      break
    case 'quit-request':
      set({ quitRequest: e.sessions, quitUnsaved: e.unsaved, quitScope: e.scope ?? 'app' })
      break
    case 'quit-pending':
      set({ quitPending: e.pending ? { working: e.working } : null })
      break
    case 'close-command':
      set({ closeCommand: e.run })
      break
    case 'keep-awake':
      set({ keepAwake: e.working })
      break
    case 'files-changed':
      filesListeners.forEach((l) => l(e.projectPath, e.dirs))
      break
    case 'connections-changed':
      set((st) => ({ connectionsChanged: st.connectionsChanged + 1 }))
      break
    case 'plan-usage-cleared':
      set((st) => {
        const { [e.connection]: _gone, ...rest } = st.connectionPlanUsage
        return { connectionPlanUsage: rest }
      })
      break
    case 'plan-usage':
      if (e.connection) set((st) => ({ connectionPlanUsage: { ...st.connectionPlanUsage, [e.connection!]: e.usage } }))
      else set((st) => ({ planUsage: { ...st.planUsage, [e.provider]: e.usage } }))
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
      setLoaded((s) => ({ skillsVersion: s.skillsVersion + 1 }))
      break
    case 'modes-changed':
      setLoaded((s) => ({ modesVersion: s.modesVersion + 1 }))
      break
    case 'dialects-changed':
      setLoaded((s) => ({ dialectsVersion: s.dialectsVersion + 1 }))
      break
    case 'journal-changed':
      if (e.workspacePath.toLowerCase() === get().workspace?.path.toLowerCase()) set((s) => ({ journalVersion: s.journalVersion + 1 }))
      break
    case 'assistant-activity': {
      // One action each: a message changing many cards sends many at once, shown together (HI-1863).
      noteAssistantAction(e.action)
      // What it changed is kept for undo as it is made (#1283): the panel's list follows, read again once per burst.
      reloadAssistantChanges()
      break
    }
    case 'language-changed':
      // i18n.ts has switched the text; the language setting's notes read the rest.
      set((s) => ({ appInfo: s.appInfo && { ...s.appInfo, language: e.language } }))
      break
    case 'usage-history':
      // The usage history's import (#1106): the Workspace Overview's note follows it.
      set((s) => (s.workspaceUsage && s.workspaceUsage.workspacePath.toLowerCase() === e.workspacePath.toLowerCase() ? { workspaceUsage: { ...s.workspaceUsage, history: e.progress } } : {}))
      break
    case 'session-bulk': {
      // Bulk actions on a host's sessions (#1659): its Sessions tab shows how far each has got.
      const k = e.projectPath.toLowerCase()
      set((s) => {
        const { [k]: _ended, ...rest } = s.sessionBulk
        return { sessionBulk: e.runs.length ? { ...rest, [k]: e.runs } : rest }
      })
      break
    }
    case 'progress-runs':
      if (e.workspacePath.toLowerCase() === get().workspace?.path.toLowerCase()) progressRunsChanged(e)
      break
    case 'merge-slots-changed':
      if (e.workspacePath.toLowerCase() === get().workspace?.path.toLowerCase()) setLoaded({ mergeSlots: e.slots })
      break
    case 'queue-changed':
      if (e.workspacePath.toLowerCase() === get().workspace?.path.toLowerCase()) queueChangedEvent(e.projectPath)
      break
    case 'tools-restart-asked':
      // Busy agents whose tools a workflow change changed (HI-2694): asked whether to restart them.
      if (e.workspacePath.toLowerCase() === get().workspace?.path.toLowerCase()) void askWorkflowToolsRestart(e.projectPath, e.agents)
      break
    case 'workflow-changed':
      if (e.workspacePath.toLowerCase() !== get().workspace?.path.toLowerCase()) break
      set((s) => ({ workflowVersion: s.workflowVersion + 1 }))
      // A board change: its columns come with its next read (HI-1682).
      void loadTasks()
      break
    case 'lanes-changed':
      if (e.workspacePath.toLowerCase() === get().workspace?.path.toLowerCase()) setLoaded({ lanes: e.lanes })
      break
    case 'assistant-questions': {
      // A load's questions still waiting (setLoaded) count as shown: they are never notified again.
      flushLiveStates()
      const before = get().assistantQuestions
      set({ assistantQuestions: e.questions })
      // With the panel hidden, the question comes as a notification the user can answer: main tells it once, as the
      // routing table says (HI-2320: a pop-up, or a Windows notification with Combwork in the background), and its entry
      // says Answered once the question no longer waits.
      if (!get().assistantOpen) {
        for (const q of e.questions.filter((x) => !before.some((b) => b.id === x.id))) void call('assistant:tellQuestion', q.id).catch(() => undefined)
      }
      break
    }
    case 'agent-added':
      noteAgentAdded(e.projectPath, e.agentId)
      break
    case 'agent-start':
      agentStartChanged(e.projectPath, e.agentId, e.start, e.seq)
      break
    case 'branch-status':
      set((st) => ({ branchStatus: { ...st.branchStatus, [projectKey(e.projectPath, e.agentId)]: e.status } }))
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
/** Reads the board again shortly (one change can come as several events: Combwork's own and the folder watcher's). */
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
  // Whether one is open, not the workspace itself: its every change would render the whole window again (HI-1806).
  const workspace = useStore((s) => !!s.workspace)
  const workspacePath = useStore((s) => s.workspace?.path ?? null)
  useAntivirusOffer()
  const assistantLeft = useStore(assistantOnLeft)
  const activity = useStore((s) => s.activity)
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const sidebarVisible = useStore((s) => s.sidebarVisible)
  const sidebarCompact = useStore((s) => s.sidebarCompact)
  const lastSide = useStore((s) => s.lastSideActivity)
  const setupShown = useRef(false)
  // Room for the work beside the side panels (HI-1737): the Projects list may fold to its rail for it.
  const [bench, setBench] = useState<HTMLDivElement | null>(null)
  const sideView = activity === 'docs' || activity === 'settings' ? lastSide : activity
  useLayoutRoom(bench, sidebarVisible && !sidebarCompact && sideView === 'projects')

  // Window-made notifications lose their buttons once their condition no longer holds (HI-2320); tips wait for a quiet moment.
  useEffect(() => {
    const offEntries = startEntryReconciler()
    const offTips = startTipWatch()
    return () => {
      offEntries()
      offTips()
    }
  }, [])

  useEffect(() => {
    // What another window changes while this one loads must outlive the older snapshot it loads (#295).
    const early = startupReplay(handleEvent)
    // The workspace reports heard (HI-2638): one heard after the snapshot's answer is newer than it. A workspace reopened at
    // start reports itself once, as its open ends; asked before then, the snapshot has none, and its other answers can
    // come after that report: applied then, it put back no workspace, and the window stayed empty.
    let wsTold = 0
    const off = window.combwork.onEvent((e) => {
      if (e.type === 'workspace-changed') wsTold++
      handleEvent(e)
      early.note(e)
    })
    void (async () => {
      const [s, ui, snap, recent, ag, api, info, live] = await Promise.all([
        call('settings:get'),
        call('ui:get'),
        call('workspace:get').then((w) => ({ w, told: wsTold })),
        call('workspace:recent'),
        call('provider:info'),
        call('api:info'),
        call('app:info'),
        call('session:live')
      ])
      // A startup cleaned up meanwhile (StrictMode's first, in development) leaves the window to the newer one (#337).
      if (!early.active()) return
      const ws = wsTold > snap.told ? get().workspace : snap.w
      set({ settings: s, sidebarWidth: ui.sidebarWidth, sidebarVisible: ui.sidebarVisible, sidebarCompact: !!ui.sidebarCompact, panes: ui.panes ?? {}, skillsProvider: ui.skillsProvider ?? {}, skillsFold: ui.skillsFold ?? {}, sessionsTree: ui.sessionsTree ?? {}, combworkVcsNotice: ui.combworkVcsNotice ?? {}, assistantFold: ui.assistantFold ?? {}, boardFold: ui.boardFold ?? {}, progressFilter: ui.progressFilter ?? {}, tabs: ui.tabs ?? {}, laneOrder: ui.laneOrder ?? {}, tips: tipsState(ui.tips), workspace: ws, recent, providers: ag, api, appInfo: info })
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
      const more = { planUsage: await call('app:planUsage'), connectionPlanUsage: await call('app:connectionPlanUsage'), update: await call('update:state'), keepAwake: await call('app:keepAwake'), windowCount: await call('window:count') }
      if (!early.active()) return
      set(more)
      const q = await call('app:quitState')
      if (!early.active()) return
      set({ quitRequest: q.request, quitUnsaved: q.unsaved, quitScope: q.scope, quitPending: q.pending ? { working: q.working } : null })
      // And its close command's panel (HI-1368), when it reloaded while one ran.
      const closing = await call('closeCommand:state')
      if (!early.active()) return
      set({ closeCommand: closing })
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
      // The close command's panel is up (HI-1368): nothing behind it runs, its own keys included.
      const closing = get().closeCommand
      if (get().dialog || get().paletteOpen || get().recordingKeys || closing?.state === 'running' || closing?.state === 'failed') return
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
      case 'dialects':
        return <DialectView />
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
      case 'activity':
        return workspacePath ? <WorkspaceActivityView key={workspacePath} workspacePath={workspacePath} /> : null
      default:
        return workspace ? null : <WelcomeView />
    }
  })()

  return (
    <div className="app">
      <TitleBar />
      <div className="workbench" ref={setBench}>
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
          <ConnectionsIntroBanner />
          <MovedBanner />
          <BoardUpgradeBanner />
          <PresetsNotice />
          <NewProjectsNotice />
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
      <Popups />
      <NotificationCenter />
      <InboxPopover />
      <CommandPalette />
      <QuitDialog />
      <CompactDialog />
      <HooksDialog />
      <AdminSnippetDialog />
      <MoveRepairDialog />
      <SetAsideDialog />
      <BoardUpgradeAsk />
      <WorkspaceOpening />
      <CloseCommandPanel />
      <AddAgentDialog />
      <AgentSettingsDialog />
      <TemplateAgentDialog />
      <AssistantSettingsDialog />
      <MergeDialog />
      <BranchMergeDialog />
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
