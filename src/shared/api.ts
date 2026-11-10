import type { CardAttachment, CardAttachmentGroup, CardDrafts } from './cardAttachments'
import type { CardCleanupItem } from './cardCleanup'
import type { BranchStart, ResolvedStart, StartPoints } from './nextVersion'
import type { IgnoreTarget } from './gitIgnoreRules'
import type { DialectCatalogue, DialectFile, DialectFileView, DialectRefusal, DialectRow, DialectUsage } from './dialects'
import type { ActivityCardAgent, ActivityDetail, ActivityNow, ActivityTurns, EndProcessResult } from './activity'
import type { SessionHooks } from './hooks'
import type { ClaudeSnippetFacts } from './claudeHookHandlers'
import type { AgentLeftovers } from './agentProcesses'
import type { FreshRow, FreshWhy } from './freshStarts'
import type { AntivirusStatus, AvAction, AvChangeResult, AvMovePlan, AvSuggestionReply } from './antivirus'
import type { ConnectionPatch, ConnectionsView } from './accounts'
import type { LaunchImpact } from './launchPolicy'
import type { ServerModelsRead } from './serverConnection'
import type { ContextCheck, LastCheck, ToolTest } from './serverDiagnostics'
import type { MovedNotice } from './connectionDefaults'
import type { JournalEdit, JournalEntryView, JournalFilter, JournalForgetPreview, JournalForgetResult, JournalPage, JournalSettings } from './journal'
import type {
  ArchiveBatch,
  Connection,
  ConnectionLaunch,
  CopyView,
  SlotTestOp,
  SlotOptions,
  SlotView,
  HeldWriter,
  BoardState,
  SetAsideCard,
  ArchiveRequest,
  ArchiveResult,
  CloseCommandRun,
  CommandRef,
  CommandsCombwork,
  CommandsWorkspace,
  UnarchiveResult,
  BoardFold,
  UpdateState,
  WorktreeGone,
  WorktreeMatch,
  WorktreeCheck,
  UnusedWorktrees,
  UnusedWorktreeRemoval,
  MergeBranchList,
  UnusedWorktreePreview,
  RemovedAgent,
  MoveOptions,
  MovePlan,
  MoveReport,
  ProgressRun,
  ProgressSnapshot,
  PermissionMode,
  AddAgentOptions,
  AddedAgent,
  AssistantAction,
  AssistantChangeGroup,
  AssistantUndoResult,
  AssistantQuestion,
  AgentApiInfo,
  AgentBranchStatus,
  AgentDef,
  TemplateLoadPlan,
  AgentPatch,
  CleanupItem,
  CleanupOptions,
  CleanupResult,
  PurgePreview,
  PurgeResult,
  PurgeTarget,
  ModeInfo,
  RecentWorkspace,
  Account,
  ServerModel,
  AgentInstallInfo,
  AppConfig,
  AppInfo,
  AppSettings,
  EffortOption,
  FallbackModel,
  FileContent,
  FileEntry,
  FileGitDone,
  FileGitInfo,
  FileGitRuleText,
  GitDiff,
  HiddenProject,
  GitStatus,
  CombworkEvent,
  LiveSessionState,
  StartedSession,
  McpFileServer,
  McpShown,
  McpPlacesResult,
  McpCatalogFilter,
  McpCatalogPrepared,
  McpCatalogSettings,
  McpCatalogSourcePage,
  McpProjectServer,
  McpServerDef,
  McpServerInfo,
  MergeResult,
  MergeSlotInfo,
  LaneInfo,
  LaneStartRequest,
  LaneStartInfo,
  LaneStartResult,
  ModelPrice,
  MemorySource,
  AssistantMemory,
  NoteFile,
  PlanUsage,
  ProjectConfig,
  ProviderId,
  ProviderTask,
  ProjectGitInfo,
  ProjectRemoval,
  ProjectRemovalInfo,
  ProjectStorage,
  QuitChoice,
  QuitScope,
  QuitSession,
  SessionBulkAction,
  SessionBulkResult,
  SessionAttachmentGroup,
  AttachmentPlan,
  Attached,
  AttachmentContent,
  SessionLayout,
  SessionListItem,
  WorkspaceUsage,
  WorkspaceStorage,
  SessionUsage,
  SkillInfo,
  SkillTarget,
  TaskCard,
  TaskChanges,
  TaskCursor,
  TaskColumn,
  TaskMoveResult,
  TaskPatch,
  TaskStartTarget,
  Transcript,
  TranscriptSearchResult,
  TranscriptTool,
  WorkflowChange,
  RetargetPreview,
  RetargetResult,
  NextVersionPlan,
  NextVersionResult,
  WorkflowCheck,
  WorkflowForm,
  PlatformSwitchCheck,
  WorkflowLevel,
  WorkflowLevelCheck,
  ProjectStages,
  ToastTarget,
  UsageMoveRule,
  WorkspaceInfo
} from './types'
import type { PlatformId } from './platform/descriptors'
import type { SlotLevelForm, SlotOptionOrigin } from './slotDefaults'
import type { GithubHostChange, GithubHostsForm } from './githubHost'
import type { MetricsQuery, MetricsReport } from './metrics'
import type { Fact } from './workflow/facts'
import type { CommitMessage, WorkflowOptions } from './workflow/options'
import type { Artifact, CompareScope, ImportResult, KeptEntry } from './benchmark'
import type { AgentTemplate, TemplateDest, TemplateEntry, TemplateRef, TemplateScope } from './templates'
import type { ConnectionAnswers, ConnectionsApplied, ConnectionsPlan } from './templateConnections'
import type { TemplateWorkflow } from './workflow/templateOptions'
import type { ProjectPref, ProjectPrefValue } from './uiPrefs'
import type { TipsChange, TipsState } from './tips'
import type { AdvancedState } from './advanced'
import type { GitTool } from './gitTool'
import type { GitInitCheck, GitInitOptions } from './gitInit'
import type { BranchAt, BranchDrops, BranchUpdateHow, BranchUpdatePlan, CompareLines, GitComparison, LeftoverInfo, GitHistory, GitRepoInfo, GitRepoSummary, PushScope } from './gitRepo'
import type { JjBookmarksView, JjCompareView, JjConflictsView, JjHistoryView, JjOperationPreview, JjOperationsView, JjRepoView, JjResolved, JjView } from './jjViews'
import type { BoardFoldChange } from './tasks'
import type { CardCost, CardRoundCosts, LaneCost } from './cardCosts'
import type { ConsoleEvent, ConsoleRecordingInfo, ConsoleSource } from './devConsole'
import type { Osc52Refusal } from './osc52'
import type { ForYouAnswer, ForYouSummary, WorkBadge, WorkView } from './workflow/workView'
import type { BranchQueueCard, QueueRecent, QueueResumed, QueueView } from './workflow/queue'
import type { LongTask, WindowWhere } from './windowHealth'
import type { MainStalls } from './mainStalls'

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
export type SettingsPatch = DeepPartial<AppSettings>

/**
 * Every request the renderer can make of the main process.
 * The preload bridge exposes these as `window.combwork.invoke(channel, ...args)`.
 */
export interface CombworkRequests {
  'app:info': () => AppInfo
  /** The plan usage each provider last reported (e.g. 5-hour and weekly limits), by provider. */
  'app:planUsage': () => Record<ProviderId, PlanUsage>
  'app:connectionPlanUsage': () => Record<string, PlanUsage>
  'app:quit': () => void
  /** Restarts Combwork: quits as app:quit does (asking about running agents), then starts it again (#676). */
  'app:restart': () => void
  'app:quitDecision': (choice: QuitChoice, dontAskAgain: boolean) => void
  'app:cancelPendingQuit': () => void
  /** This window's close command (HI-1368), for a window that reloads while its panel is up; null: none. */
  'closeCommand:state': () => CloseCommandRun | null
  /** The panel's Don't wait: Combwork stops waiting for this window's close command and goes on; the command carries on. */
  'closeCommand:dontWait': (id: string) => void
  /** The panel's Close, on a failed close command: Combwork goes on. */
  'closeCommand:dismiss': (id: string) => void
  /** The panel's choice on a failed command (HI-1954), for that step's attempt only: a stale or repeated one does nothing. */
  'closeCommand:control': (id: string, action: 'rerun' | 'skip' | 'stop', step: number, attempt: number) => void
  /** Settings → Commands at the workspace's level (HI-1954): its commands and its open and close points, saved in workspace.json; returns them as saved. Only the user's window sets them. */
  'commands:setWorkspace': (workspacePath: string, commands: CommandsWorkspace) => CommandsWorkspace
  /** Settings → Commands at Combwork's level (HI-1954): Combwork's commands and When Combwork quits, run; returns them as saved. */
  'commands:setCombwork': (commands: CommandsCombwork) => CommandsCombwork
  /** Runs one command by hand in this window (HI-1954): its panel, as a point's, with one step. */
  'commands:run': (ref: CommandRef) => void
  /** Current quit state, for a window that reloads while a quit dialog or pending quit is open. */
  'app:quitState': () => { request: QuitSession[] | null; unsaved: string[]; scope: QuitScope; pending: boolean; working: number }
  'app:openExternal': (url: string) => void
  'app:openPath': (path: string) => void
  'app:showInFolder': (path: string) => void
  'app:openLogs': () => void
  /** Help → Copy Diagnostics: versions, coding agents, counts, key settings and the end of the log, redacted, as Markdown. */
  /** Copy Diagnostics' text; `recording` attaches the newest redacted developer console recording (#638). */
  'app:diagnostics': (opts?: { recording?: boolean }) => string
  /** How many working agents keep the PC awake now (0: none, or the setting doesn't). */
  'app:keepAwake': () => number
  /** The notice that Combwork closed unexpectedly (#984): resumes the agents that were running, once; main tells the result. */
  'app:resumeAfterClose': () => { resumed: number; failed: number }
  /** The unexpected-close notice's Stop Them (#987): how many processes the agents had started were stopped. */
  'app:stopLeftAfterClose': () => number
  /** The notice offering to resume the agents that were working when Combwork closed (HI-1707): queues them; how many. */
  'app:resumeRestart': () => number
  /** That notice's Dismiss: none resumed, and the offer isn't made again; how many it offered. */
  'app:dismissRestart': () => number
  'update:state': () => UpdateState
  /** A check started by the user; resolves with the result. */
  'update:check': () => UpdateState
  'update:download': () => void
  /** Restart and Update: quits (asking if agents are working), installs and restarts. */
  /** `version`: from the update's notice (HI-2320), installed only while it is the one ready. */
  'update:install': (version?: string) => void
  'update:skip': (version: string) => void
  /** Pausing the team before an update (HI-2081): every open workspace's pause and what still runs, scanned now. */
  'team:state': () => import('./teamPause').TeamPauseState
  /** Pause the Team: every open workspace (one id; a workspace opened meanwhile is held too); those it couldn't pause, named. */
  'team:pause': () => { done: string[]; failed: { workspacePath: string; error: string }[] }
  /** Resume the Team: every open workspace's pause lifted. */
  'team:resume': () => { done: string[]; failed: { workspacePath: string; error: string }[] }
  /** End It on a process the check names, after the window's question: it and what it started, by its recorded identity. */
  'team:endProcess': (projectPath: string, agentId: string, pid: number, created: string) => 'ended' | 'notFound' | 'failed'
  /** Show Its Window (HI-2095): brings forward the window showing another open workspace; never switches this one. False when none shows it. */
  'team:showWorkspace': (workspacePath: string) => boolean
  /** Install Now: scanned again here first; installed only when every open workspace is paused and parked. */
  'team:install': () => { installed: boolean; state: import('./teamPause').TeamPauseState }
  /** Opens the Chromium/Electron licences that ship next to the app's executable. */
  'app:openChromiumLicenses': () => boolean

  'window:minimize': () => void
  'window:toggleMaximize': () => void
  'window:close': () => void
  /** How many Combwork windows are open. */
  'window:count': () => number
  /** Opens another Combwork window (the welcome page), like VS Code's New Window. */
  'window:new': () => void
  'window:toggleDevTools': () => void
  'window:zoom': (direction: 'in' | 'out' | 'reset') => void
  'window:toggleFullScreen': () => void
  'window:edit': (role: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => void
  'window:setTitleBarColors': (color: string, symbolColor: string) => void
  /** How many backdrops (dialogs, nested or not, the command palette) are up in this window: dims the window buttons to match. */
  'window:setBackdrops': (count: number) => void
  /** Where this window is (its view, project, tab, dialog, panels), as it changes: what its long-task and hang lines in combwork.log name (HI-1775). */
  'window:where': (where: WindowWhere) => void
  /** The page's long tasks just ended, and where it was: logged in combwork.log, rate-limited (HI-1775). */
  'window:longTasks': (tasks: LongTask[], where: WindowWhere) => void
  /** The taskbar button's badge: a PNG (base64) drawn at `scale`, or none at 0. */
  'window:setBadge': (count: number, png: string | null, scale: number) => void
  /** Always on Top for this window, remembered for its workspace (pin.ts). Returns the window's state now. */
  'window:setAlwaysOnTop': (on: boolean) => boolean
  'window:getAlwaysOnTop': () => boolean
  /** The project this window's page shows (null: none), for banners shown for "This project". */
  'window:showing': (projectPath: string | null) => void
  /** A banner was clicked: brings up the window showing its project, and the project (as a Windows notification's click). */
  'notice:open': (projectPath: string | null) => void
  /** A banner's button (#1437): brings up the window that has its project, shows the project and runs the command there. */
  /** An entry's button, run in the window that has its project (HI-2320: resolves once the command there has finished). */
  'notice:action': (projectPath: string, command: string, args: unknown[]) => void
  /** The window that ran a notice:action's command says it has finished (`error`: its failure, shown where its button was). */
  'notice:actionDone': (reply: string, error: string | null) => void
  /** A notice's target (HI-1961): brings up the window that has its project or workspace (else this one) and opens it there. */
  'notice:target': (target: ToastTarget) => void

  'settings:get': () => AppSettings
  'settings:update': (patch: SettingsPatch) => AppSettings
  'settings:reset': (section?: keyof AppSettings) => AppSettings
  /** Replaces a provider's price overrides (USD per million tokens, by model id). */
  /** Replaces a provider's price overrides, and (when given) which shipped prices are removed from its table. */
  'settings:setProviderPrices': (provider: ProviderId, prices: Record<string, ModelPrice>, removed?: string[]) => AppSettings
  /** Replaces a provider's fallback list of models or effort levels (#125); null goes back to Combwork's defaults. */
  'settings:setProviderFallback': (provider: ProviderId, kind: 'models' | 'efforts', list: (FallbackModel | EffortOption)[] | null) => AppSettings
  /** Sets (string), removes (null) or resets to the default (undefined) one command's shortcut. */
  'settings:setKeybinding': (commandId: string, key: string | null | undefined) => AppSettings
  /** Advanced settings (#367): advanced.json's overrides, this window's workspace's own values and the installed CLIs. */
  'advanced:state': () => AdvancedState
  /** Sets an advanced value (null: back to the default), in advanced.json or (scope workspace) this workspace's own. */
  'advanced:set': (id: string, value: unknown, scope?: 'app' | 'workspace') => AdvancedState
  /** Keeps a CLI-facing override for the CLI version installed now. */
  'advanced:keep': (id: string) => AdvancedState
  /** Opens advanced.json in the user's editor. */
  'advanced:open': () => void
  'ui:get': () => AppConfig['ui']
  'ui:set': (ui: Partial<AppConfig['ui']>) => void
  /** Saves one pane's size (null: back to its default), leaving the other panes as they are: several windows save them. */
  'ui:setPane': (key: string, size: number | null) => void
  /** Saves (null: forgets) one project's view preference (Skills tab provider or groups, Sessions tree), merged into what is saved: several windows save them (#245). */
  'ui:setProjectPref': <P extends ProjectPref>(pref: P, project: string, value: ProjectPrefValue<P> | null) => void
  /** Changes this window's workspace's board fold (#170), on what is saved now, leaving other workspaces' as they are; replies with them all. */
  /** Applies one change to what the tips know, on what is saved (#266): several windows change it. Replies with the state saved. */
  'ui:changeTips': (change: TipsChange) => TipsState
  'ui:changeBoardFold': (change: BoardFoldChange) => Record<string, BoardFold>
  /** Saves this window's workspace's running lanes in the user's order (#568; null: back to the usual order), leaving other workspaces' as they are; replies with them all. */
  'ui:setLaneOrder': (ids: string[] | null) => Record<string, string[]>

  'workspace:get': () => WorkspaceInfo | null
  'workspace:open': (path?: string) => WorkspaceInfo | null
  'workspace:create': () => WorkspaceInfo | null
  /** False when the user cancelled (running agents would have been stopped). */
  'workspace:close': () => boolean
  /** The recent workspaces as this window sees them: whether each folder is there, and whether another window has it open (#144). */
  'workspace:recent': () => RecentWorkspace[]
  /** Every project's (and the Assistant's) sessions with their usage, for the Workspace Overview. */
  'workspace:usage': () => WorkspaceUsage
  /** The workspace's performance metrics for a scope and range (metrics.ts; the Performance view and tab). */
  'metrics:query': (q: MetricsQuery) => MetricsReport
  /** Clears the workspace's performance metrics. */
  'metrics:reset': () => void
  /** The main process's recent stalls since Combwork started, newest first (HI-1135, mainStalls.ts): Combwork's, not a workspace's. */
  'performance:stalls': () => MainStalls
  /** Saves a report as a JSON file (a save dialog): the path, or null if cancelled. `sanitize` replaces project names. */
  'metrics:export': (q: MetricsQuery, sanitize: boolean) => string | null
  /** Ends an agent's card watch (#128: Cancel Card Watch in its pane's ⋯). Whether it had one. */
  'watch:cancel': (projectPath: string, agentId: string) => boolean
  /** Cancels the messages waiting to be offered to an agent (#530, #647): how many there were. */
  'session:cancelMessages': (projectPath: string, agentId: string) => number
  /** Deliver Now (#1432): the line telling an agent of what waits in its inbox, typed once. Whether it was typed. */
  'session:deliverNow': (projectPath: string, agentId: string) => boolean
  /** Start Fresh (Idle Agents) (#1437): each agent of the project, and why it doesn't start fresh now (null: it does). */
  'session:freshPlan': (projectPath: string) => FreshRow[]
  /** Starts one agent fresh if it is still idle: null when it was, else why not. */
  'session:startFresh': (projectPath: string, agentId: string) => FreshWhy | null
  /** Kept comparisons (Performance → Compare), for a scope only: a project's page sees its own project's. */
  'benchmarks:list': (scope: CompareScope) => { entries: KeptEntry[]; base: string | null; run: string | null; notice?: string }
  /** Imports a benchmark or export (an open dialog; or, with `token`, a file an earlier answer asked about). Null if cancelled. */
  'benchmarks:import': (scope: CompareScope, answer?: { token: string; useProjectPart: boolean }) => ImportResult | null
  /** Keeps the page's current report (its query: scope, range, filters) as a comparison. */
  'benchmarks:keep': (q: MetricsQuery, label?: string) => KeptEntry
  'benchmarks:read': (scope: CompareScope, id: string) => Artifact
  'benchmarks:remove': (scope: CompareScope, id: string) => void
  'benchmarks:pin': (scope: CompareScope, id: string, pinned: boolean) => void
  /** Remembers a scope's chosen baseline and run. */
  'benchmarks:select': (scope: CompareScope, base: string | null, run: string | null) => void
  /** Forgets a recent workspace (the folder is left alone), whatever the case of the path given (#144). */
  'workspace:removeRecent': (path: string) => RecentWorkspace[]
  /** Clears the recent workspaces, keeping those open in a window now (#144). */
  'workspace:clearRecent': () => RecentWorkspace[]
  'workspace:refresh': () => WorkspaceInfo | null
  /** What Repair… would do for a moved workspace or project (#146), with the user's choices; null when nothing moved. */
  'workspace:movePlan': (opts?: MoveOptions) => MovePlan | null
  /** Repairs it (refused while agents run): worktrees, session folders, the CLIs' per-path data (copied), Open Recent. */
  'workspace:moveRepair': (opts?: MoveOptions) => MoveReport
  /** Defender and the moved workspace's old and new folders (#1302), for Repair's dialog; null when the workspace didn't move. */
  'workspace:moveDefender': () => AvMovePlan | null
  /** Locate…: a folder picker for an agent's worktree that wasn't found; the folder, or null when cancelled. */
  'workspace:moveLocate': (projectPath: string, agentId: string) => string | null

  'project:create': (name: string, key?: string | null) => WorkspaceInfo | null
  'project:setActive': (projectPath: string, active: boolean) => WorkspaceInfo | null
  /** Each project's key and old keys (#1219, #704), by its folder (projects with no id yet have none). */
  'project:keys': () => { projectPath: string; key: string; aliases: string[] }[]
  /** Makes a key the project's (Project Settings), its old one kept as an alias; refused, saying why. Returns the key as kept. */
  'project:setKey': (projectPath: string, key: string) => string
  /** The names moved cards keep in the projects they left (`HI-1` → its card's number), #1221. */
  'project:movedCardNames': () => Record<string, number>
  /** Any of a project's settings but its workflow options, which change only through `workflow:setOptions` (refused here). */
  'project:updateConfig': (projectPath: string, patch: Partial<ProjectConfig>) => ProjectConfig
  /** The project's workflow options as Project Settings → Workflow shows them (#1278): its own, what they inherit, the presets. */
  'workflow:form': (projectPath: string) => WorkflowForm
  /** What saving a change to the project's workflow options would do (§16.6.5's warning): its problems, what changes, what keeps the old rules. */
  'workflow:check': (projectPath: string, change: WorkflowChange) => WorkflowCheck
  /** Saves the project's workflow options, checked again (refused, with every reason); `applyTo`: cards in flight to work under them from now (OP-38). */
  'workflow:setOptions': (projectPath: string, change: WorkflowChange, opts?: { applyTo?: number[] }) => WorkflowForm
  /** HI-2680: moves what a confirmed Retarget preview listed, as the user: each item rechecked; what happened to each. */
  'workflow:retarget': (projectPath: string, preview: RetargetPreview) => RetargetResult
  /** HI-2807: what Start the next version's dialog shows: the release, its head, the proposed name, what can follow. */
  'workflow:nextVersionPlan': (projectPath: string) => NextVersionPlan
  /** HI-2807: what can follow `to` from the release with both going on (the dialog's name edited). */
  'workflow:nextVersionPreview': (projectPath: string, from: string, to: string) => RetargetPreview | null
  /** HI-2807: Start the next version: the branch made at the release's head as shown, the release added to Other branches, Work merges into moved to it. */
  'workflow:startNextVersion': (projectPath: string, args: { name: string; from: BranchStart; base: NextVersionPlan['base'] }) => NextVersionResult
  /** The user's answer to the merge queue's question before an upgraded project's first merge (HI-1697, For you): its merge style and commit message saved, the request answered. */
  'workflow:chooseMerge': (projectPath: string, choice: { card: number; request: string; style: WorkflowOptions['style']; commitMessage: CommitMessage }) => void
  /**
   * The project's stages as its current options produce them, in board order, and its own names for them (N5, #1417);
   * null for a project whose version control isn't recorded yet. A `workflow-changed` event says when to read it again.
   */
  'workflow:stages': (projectPath: string) => ProjectStages | null
  /**
   * Every project's stages (`workflow:stages`) by its path in lower case: read with the board's cards, so its columns
   * are right in its first paint, never added after it (HI-1682).
   */
  'board:stages': () => Record<string, ProjectStages | null>
  /** What switching the project's version control would do (#1419, §16.6.5's warning): why it can't now, what keeps old rules. */
  'workflow:checkPlatform': (projectPath: string, to: PlatformId) => PlatformSwitchCheck
  /**
   * Switches the project's version control from its next card (#1419), checked again under its lock: refused when
   * `expected` (the platform the window showed) isn't the one in force, or what is detected doesn't allow it.
   */
  /** `token` (HI-2799): a switch between Git and jj, the group its warning showed (`PlatformSwitchCheck.store.token`). */
  'workflow:setPlatform': (projectPath: string, to: PlatformId, opts: { expected: PlatformId; token?: string }) => { from: PlatformId; to: PlatformId }
  /**
   * "How do you work?" answered Not now (#1423) for the platform the step showed: no preset, the options inherited, not
   * asked again for it. Ignored if the project uses another platform now, or was answered meanwhile.
   */
  'workflow:presetNotNow': (projectPath: string, platform: PlatformId) => void
  /** The projects the one-time presets notice offers presets to (§16.17), or null when it isn't due. */
  'workflow:presetsNotice': () => { path: string; name: string }[] | null
  /** The presets notice was answered (Choose… or Not now): it isn't shown again in this workspace. */
  'workflow:presetsNoticeSaid': () => void
  /** A level's workflow defaults for a platform as the editor shows them (#1422: Combwork's, or the open workspace's). */
  'workflow:levelForm': (level: WorkflowLevel, platform: PlatformId) => WorkflowForm
  /** What saving a level's defaults would do: its problems, what changes, and the projects inheriting it (#1422). */
  'workflow:levelCheck': (level: WorkflowLevel, platform: PlatformId, change: WorkflowChange) => WorkflowLevelCheck
  /** Saves a level's defaults, checked again (refused with its reasons, or as changed meanwhile); the form as it is now. */
  'workflow:setLevel': (level: WorkflowLevel, platform: PlatformId, change: WorkflowChange) => WorkflowForm
  /**
   * The project's merge queues (#1353, SPEC §16.9.3): one target's, or every target's it has queued for or paused, or has
   * cards in flight under Combwork merges into, or its current options have Combwork merge into (#1356: the panel decides which
   * show). Each change comes as a `queue-changed` event.
   */
  'queue:list': (projectPath: string, target?: string) => QueueView[]
  /** The project's slots (#1429, SPEC §16.10.1), each with its open lease. */
  'slots:list': (projectPath: string) => SlotView[]
  /** One setting of the Version Control tab's Slots and copies (#1445): set, or with null removed, under the project's lock. */
  'slots:setSetting': (projectPath: string, key: 'setup' | 'archive' | 'copy' | 'copiesSize', value: string | number | null) => { slots: SlotOptions; copies: { size?: number } }
  /** A project's copied files as they inherit (HI-1765: its own, its workspace's, Combwork's, the default), and where they come from. */
  'slots:copyOf': (projectPath: string) => { value: string; origin: SlotOptionOrigin }
  /** A workspace's (null) or a project's GitHub host settings as they resolve (HI-2779), and a change to them. */
  'github:form': (projectPath: string | null) => GithubHostsForm
  'github:set': (projectPath: string | null, change: GithubHostChange) => GithubHostsForm
  /** Combwork's or the workspace's slot defaults (HI-1765: Settings → Workflow defaults, Git), with what each inherits. */
  'slots:levelForm': (level: WorkflowLevel) => SlotLevelForm
  /** Sets one of a level's slot defaults (an empty string: none), or with null removes it, so it inherits. */
  'slots:setLevelDefault': (level: WorkflowLevel, key: 'copy', value: string | null) => SlotLevelForm
  /** Ends an agent's carried lease (#1441, Release Slot… in its menu): its adopted worktree stops being its own. Whether it did. */
  'slots:releaseCarried': (projectPath: string, agentId: string) => boolean
  /** A slot's writer as Release Slot… shows it (#1506): its holder, whether its run is live, what is listed of its processes. Null: none. */
  'slots:heldWriter': (projectPath: string, slot: string) => HeldWriter | null
  /** Release Slot… on a held writer (#1506): `end` ends its listed processes first; refused while its Combwork or run lives, or it changed. */
  'slots:releaseWriter': (projectPath: string, slot: string, run: string, end: boolean) => void
  /** The project's review and check copies (#1435, SPEC §16.10.5), each with its lease not freed. */
  'copies:list': (projectPath: string) => CopyView[]
  /** Test copies only (unpackaged): lend, release, tidy or remove in the project's slot pool, as #1438 and #1447 will. */
  'slots:test': (projectPath: string, op: SlotTestOp) => unknown
  /** A target's queue history (#1357, the Git tab's Merge queue section): its latest 50 outcomes, newest first. */
  'queue:history': (projectPath: string, target: string) => QueueRecent[]
  /** The card an agent's worktree branch is for, when Combwork merges it (#1357, the Merge dialog), and where it stands in the queue. */
  /** The user saw these returned entries of a target's queue (#1356, the Progress panel): they leave its card. */
  'queue:seen': (projectPath: string, target: string, entries: string[]) => void
  /** Pause queue (the user's): the target's queue stops before its next entry; saved. A queue paused already keeps its pause. */
  'queue:pause': (projectPath: string, target: string) => QueueView
  /** HI-2679: brings `to` up to date with `from` (a forward merge through `to`'s queue), as the user. */
  'queue:forward': (projectPath: string, from: string, to: string) => { upToDate: boolean; card: number | null; queued: boolean }
  /** Resume: clears the pause once its cause, where Combwork can see it, is gone (`resumed`); else the queue is paused again, saying why. */
  'queue:resume': (projectPath: string, target: string) => QueueResumed
  /** Remove from queue (the user's override): the card back to Approved, never merged; refused once its merge has begun. */
  'queue:remove': (n: number, reason?: string) => TaskCard
  /** Retry merge (the user's override): requeues a returned card's unchanged revision, once. */
  'queue:retry': (n: number, reason?: string) => TaskCard
  /** Adds the project's .combwork to its git repository's info/exclude (#345); refuses where no git repository holds it. */
  'project:excludeCombwork': (projectPath: string) => WorkspaceInfo
  /** The files under the project's .combwork git tracks (#364), for the confirmation before untracking them. */
  'project:combworkTracked': (projectPath: string) => string[]
  /** `git rm --cached` of exactly the files confirmed (#364), refused if git tracks others now: their removal staged, the files left on disk. */
  'project:untrackCombwork': (projectPath: string, files: string[]) => WorkspaceInfo
  'project:openInExplorer': (projectPath: string) => void
  'project:openTerminal': (projectPath: string) => void
  /** What hiding, removing or deleting the project would touch (Project → Remove Project…). */
  'project:removalInfo': (projectPath: string) => ProjectRemovalInfo
  /** Hides it, removes it from Combwork (packing its workspace files into its folder) or deletes it (to the Recycle Bin). */
  'project:remove': (projectPath: string, how: ProjectRemoval) => { warnings: string[] }
  /** Projects hidden or removed from Combwork, and whether each folder is still in the workspace. */
  'project:hidden': () => (HiddenProject & { present: boolean })[]
  'project:restore': (name: string) => { handovers: number; cards: number }
  /** Stops listing a hidden or removed project whose folder is gone. */
  'project:forget': (name: string) => void
  /** A folder holding what Remove from Combwork packed: keep (unpack into this workspace) or discard it. */
  'project:takeRemovedData': (projectPath: string, keep: boolean) => { handovers: number; cards: number }

  /** The board's state (#1207): read-only and why, and the copy kept from before its upgrade to 1.0. */
  'board:state': () => BoardState
  /** Upgrades the board to 1.0, the user having said yes (refused while another Combwork has the workspace open). */
  'board:upgrade': () => { backup: string | null }
  /** Help → Restore the 0.9 Board Backup…: the 1.0 board copied aside, the 0.9 copy put back. */
  'board:restore09': () => { saved: string; restored: string }
  /** Every card on the workspace's board, archived ones too. */
  /** The board as the window shows it: archived cards in short (TaskCard.summary) unless `fullArchive` (#1017). */
  'tasks:list': (fullArchive?: boolean) => TaskCard[]
  /** The board's cards changed since the window's cursor, or all of them (HI-1715, windowChanges). */
  'tasks:changes': (since: TaskCursor | null) => TaskChanges
  /** Exports the board to a folder of JSON files the user picks (#1017); null when the user cancelled. */
  'tasks:export': () => { dir: string; cards: number } | null
  /** The workspace's Assistant journal (#1031): its settings and size, a change of them, deleting it. */
  'journal:status': () => { settings: JournalSettings; bytes: number; entries: number }
  'journal:set': (patch: Partial<JournalSettings>) => JournalSettings
  'journal:delete': () => void
  /** The journal browser (#1033): a page of the timeline, the projects named, an entry, an edit, a delete, and Forget (previewed: a count and a token for that set; then deleted only while the set is unchanged). */
  'journal:browse': (filter: JournalFilter, offset?: number, limit?: number) => JournalPage
  'journal:projects': () => string[]
  'journal:entry': (id: number) => JournalEntryView | null
  'journal:edit': (id: number, edit: JournalEdit) => boolean
  'journal:deleteEntry': (id: number) => boolean
  'journal:forgetPreview': (filter: JournalFilter) => JournalForgetPreview
  'journal:forget': (filter: JournalFilter, token: string) => JournalForgetResult
  /** Cards an older version saved, set aside for review (#1044): listed, added to the board, discarded (by file name). */
  'tasks:setAside': () => SetAsideCard[]
  'tasks:addSetAside': (file: string) => TaskCard
  'tasks:discardSetAside': (file: string) => void
  'tasks:create': (input: { title: string; description?: string; project?: string; agent?: string | null; column?: TaskColumn; labels?: string[]; context?: string[]; kind?: 'code' | 'no-code'; skipReview?: string; target?: string | null }, drafts?: CardDrafts) => TaskCard
  /** Changes a card's kind after it was made (#1277): an override, asked first (`ask`) unless `confirm`, with its reason. */
  'tasks:setKind': (n: number, kind: 'code' | 'no-code', opts?: { confirm?: boolean; reason?: string }) => { ask: true } | TaskCard
  /** Answers an agent's proposed kind (#1277): `accept` makes it the card's kind, else the card stays code. */
  'tasks:confirmKind': (n: number, accept: boolean) => TaskCard
  /** Makes a card skip review, or review it after all (#1625), answering an agent's proposal too: `reason`, the user's optional note. */
  'tasks:setReviewSkip': (n: number, skip: boolean, opts?: { reason?: string }) => TaskCard
  /** Sets the branch a card merges into (HI-2556, its Merges into): one the project lists, or null for its own. */
  'tasks:setTarget': (n: number, target: string | null) => TaskCard
  /** A card's context reference (#818): its section's text and heading line, or why it doesn't resolve. projectPath: the card's project's (null: a card about the workspace). */
  'docs:section': (projectPath: string | null, ref: string) => { ref: string; content: string; line: number } | { ref: string; problem: string; closest?: string[] }
  /** A change; with `more`, its comment and the dialog's drafts (HI-1700) in the same change. */
  'tasks:update': (n: number, patch: TaskPatch, more?: { comment?: string; drafts?: CardDrafts }) => TaskCard
  /**
   * The user's move of a card to a column through its workflow rules (#1265, SPEC §16.8.4): a move that skips a rule
   * asks first (`ask`, nothing written) unless `confirm`, then records an Override (with `reason`, optional).
   */
  'tasks:move': (n: number, column: TaskColumn, opts?: { before?: number | null; confirm?: boolean; reason?: string; agent?: string | null; paths?: string[] | null }) => TaskMoveResult
  /** The columns a card can be moved to under its rules (#1275): where a drag may drop it; null: every column (no rule applies). */
  'tasks:columns': (n: number) => TaskColumn[] | null
  /** A card's facts (#1216), oldest first: what each move recorded (none on a board waiting for its upgrade). */
  'tasks:facts': (n: number) => Fact[]
  /** What waits for the user (For you, #1269, SPEC §16.8.5): every live card's open requests, of one project (its folder name) or the workspace, oldest first, and their count. */
  'tasks:forYou': (project?: string | null) => ForYouSummary
  /** The user answers a card's request (For you): only the user. Refused when it was answered or retired meanwhile. */
  'tasks:answer': (n: number, request: string, answer: ForYouAnswer) => TaskCard
  'tasks:comment': (n: number, text: string, drafts?: CardDrafts) => TaskCard
  /** A card's attachments (HI-1700), newest first. */
  'cards:attachments': (n: number) => CardAttachment[]
  /** A project's cards' attachments, by card (its Attachments tab). */
  'cards:projectAttachments': (projectPath: string) => CardAttachmentGroup[]
  'cards:removeAttachment': (n: number, id: string) => void
  /** A card attachment's text, for the attachment viewer's preview (HI-1958): by card and id, as `attachments:read` gives a session's. */
  'cards:readAttachment': (n: number, id: string) => AttachmentContent
  /** A session attachment of `host` (a pane's) copied to a card. */
  'cards:attachFromPane': (n: number, host: string, path: string) => CardAttachment
  /** Changes the words of one of a card's decisions, or removes it (text null): the user's (#357). */
  'tasks:editDecision': (n: number, id: string, text: string | null) => TaskCard
  'tasks:archive': (n: number, archived: boolean) => TaskCard
  /** Archives the cards listed as one batch (#351), the user's: Undo or "Unarchive this batch" brings it back. */
  'tasks:archiveBatch': (numbers: number[], req: ArchiveRequest) => ArchiveResult
  /** Brings a batch back, each card where it was in its column; a batch with cards that couldn't come back is kept. */
  'tasks:unarchiveBatch': (id: string) => UnarchiveResult
  /** The bulk archives kept (the latest 50), oldest first. */
  'tasks:archiveBatches': () => ArchiveBatch[]
  /** To the Recycle Bin. */
  'tasks:delete': (n: number) => void
  /** Gives the card to an agent (an existing one, or a new one) with the card as its prompt, and moves it to Doing. */
  'tasks:start': (n: number, target: TaskStartTarget, opts?: { confirm?: boolean; reason?: string }) => { agentId: string; agentName: string; added: boolean } | { ask: string[] }
  /** A card's work (#1223): its facts folded into its line, revisions, verdicts, checks, marks and integration; null with no such card, or on a board not upgraded to 1.0. */
  'tasks:work': (n: number) => WorkView | null
  /** Every live card's badges from its work (#1223), in number order; archived cards aren't read. */
  'tasks:workBadges': () => WorkBadge[]

  /** own: Combwork's own sessions alone, for a view that shows them before the others (HI-1681). */
  'session:list': (projectPath: string, opts?: { own?: boolean }) => SessionListItem[]
  /** agentId: without one, the project's only agent. skipSetup starts the agent even though the worktree's setup command hasn't succeeded. */
  'session:start': (projectPath: string, opts: { resumeId?: string; name?: string; agentId?: string; skipSetup?: boolean; auto?: boolean; freshAsked?: boolean }) => StartedSession
  /** Stops the CLI's background job holding a conversation, then resumes it in the agent. */
  'session:stopBackgroundAndResume': (projectPath: string, agentId: string, jobId: string, sessionId: string, offer?: string) => void
  'session:stop': (projectPath: string, agentId?: string) => void
  /** What this window's agents left running when they stopped (#507); `settled`: once every launch that has exited has been looked at (#613). */
  'session:leftovers': (settled?: boolean) => AgentLeftovers[]
  /** Ends what the agent's stopped launches left running (only processes they started), or keeps it running and stops listing it. Returns how many. */
  'session:settleLeftovers': (projectPath: string, agentId: string, how: 'end' | 'keep') => number
  /** A notice's End Them / Keep Running (HI-2320): only the processes it listed, by id and start time; its entry says what happened. */
  'session:settleOffer': (projectPath: string, offer: string, how: 'end' | 'keep') => void
  /** Types a short "carry on" into a running agent whose turn a refused sign-in stopped (Resume (n), #309). */
  'session:carryOn': (projectPath: string, agentId: string) => void
  /** After a refused resume (Resume All): 'running' when the agent runs that conversation, or a start of it under way finished (its failure thrown); 'other' otherwise (HI-1746). */
  'session:joinResume': (projectPath: string, agentId: string, sessionId: string) => 'running' | 'other'
  /** The user says an agent whose state is unknown (silent, no sign of its turn's end) is idle (#648). */
  'session:markIdle': (projectPath: string, agentId: string) => void
  /** Try again on a blocked input (HI-2191): one clear of it, for the block `since` names; what came of it. */
  'session:retryInput': (projectPath: string, agentId: string, since: string) => 'clear' | 'blocked' | 'gone' | 'busy'
  'session:archive': (projectPath: string, sessionId: string, archived: boolean) => void
  'session:rename': (projectPath: string, sessionId: string, name: string) => void
  /** Deletes a session that isn't running from Combwork (its record and backups; the CLI's transcript stays). */
  'session:delete': (projectPath: string, sessionId: string) => void
  /** Archives, unarchives or deletes several sessions (a branch of the Sessions tab), each all or nothing; skips those in use. */
  'session:bulk': (projectPath: string, action: SessionBulkAction, sessionIds: string[]) => SessionBulkResult
  /** Deleted sessions' usage (list items with deleted: true), which totals still count. */
  'session:keptUsage': (projectPath: string) => SessionListItem[]
  /** What Combwork keeps for a project or the Assistant (Project Settings → Storage); the last result unless refresh. `request` lets storage:abandon end the call. */
  'storage:project': (projectPath: string, refresh?: boolean, request?: string) => ProjectStorage
  /** Every project's storage and the Assistant's, biggest first (Settings → Workspace); `request` as for storage:project. */
  'storage:workspace': (refresh?: boolean, request?: string) => WorkspaceStorage
  /** The window stopped waiting for a storage request (its page closed): the call fails, and a measurement nothing else waits for stops. */
  'storage:abandon': (request: string) => void
  /** Antivirus scanning of the window's workspace (#316, main/antivirus.ts): cached unless refresh. */
  'antivirus:status': (refresh?: boolean) => AntivirusStatus
  /** Works out a change (add or remove the workspace's exclusions, or read Defender's list) for the user to confirm: its exact folders. */
  'antivirus:prepare': (action: AvAction) => { id: string; action: AvAction; paths: string[]; workspacePath: string }
  /** Runs a prepared change exactly as confirmed, with administrator rights (one UAC prompt); refused if anything changed. Status null: the workspace changed meanwhile. */
  'antivirus:apply': (id: string) => { result: AvChangeResult; status: AntivirusStatus | null }
  /** Whether to suggest exclusions now (marks the offer made): the suggestion (status, which time) or null, and when a reminder may come. */
  'antivirus:suggestion': () => AvSuggestionReply
  /** "Don't ask again" for the window's workspace. */
  'antivirus:dismiss': () => void
  /** What Clean Up… would move to the Recycle Bin with these options. */
  'storage:cleanupPreview': (projectPath: string, opts: CleanupOptions) => CleanupItem[]
  /** Moves what the preview listed (its paths) to the Recycle Bin, skipping what no longer qualifies. */
  'storage:cleanup': (projectPath: string, opts: CleanupOptions, listed: string[]) => CleanupResult
  /** What the project's clean-up of archived cards' attachments would remove now (HI-1842): its due cards and their files, kept as a plan. */
  'storage:cardCleanupPreview': (projectPath: string) => { plan: string | null; items: CardCleanupItem[]; more: boolean }
  /** Applies a kept plan (Clean Up Now's Move): only its files still as they were, each card checked again; an expired or used plan is refused. */
  'storage:cardCleanup': (projectPath: string, plan: string) => { cards: number; files: number; bytes: number; left: number; stopped?: boolean }
  /** What Purge… (#1138) would remove of Combwork's for a session, a project or the window's workspace: every file and record, with its size. */
  'storage:purgePreview': (target: PurgeTarget) => PurgePreview
  /** Removes what a preview (its id) listed, those of its keys given, to the Recycle Bin or permanently, skipping what changed since. */
  'storage:purge': (previewId: string, listed: string[], permanent: boolean) => PurgeResult
  /** Forgets every transcript's usage, in memory and in usage-cache.json (Settings → Sessions → Usage cache). */
  'session:clearUsageCache': () => void
  'session:adopt': (projectPath: string, sessionId: string) => void
  'session:usage': (projectPath: string, sessionId: string) => SessionUsage | null
  /** An agent's hooks for its Hooks dialog (HI-982): what its launch has and what Combwork received; null when it isn't running. */
  'session:hooks': (projectPath: string, agentId: string) => SessionHooks | null
  /** The window showed these agents' panes (all of the project's agents when none are named). */
  'session:markSeen': (projectPath: string, agentIds?: string[]) => void
  'session:live': () => LiveSessionState[]
  /** Runs the CLI's /compact in the agent's session (only while the agent is idle). */
  'session:compact': (projectPath: string, focus?: string, agentId?: string) => void
  /** Switches a running agent's permission mode the way the CLI allows (Claude Code: Shift+Tab). ok false: not possible live (restart instead) or it didn't take. */
  'session:setMode': (projectPath: string, agentId: string, mode: PermissionMode) => { ok: boolean; restart?: boolean; message?: string }
  /** Lets an agent edit a file another agent holds ("Ask me" lock, for CLIs that can't ask themselves). */
  /** `offer`: from its notice (HI-2320), answering only the ask it offered. */
  'session:allowLockedEdit': (projectPath: string, agentId: string, path: string, offer?: string) => void
  /** Continues one agent's work in another, of any provider: a handover from the source (optional), then the target picks it up. */
  'session:handOver': (projectPath: string, fromAgentId: string, toAgentId: string, opts: { handover: boolean }) => void
  /** Whether the agent may hand over to a new conversation of its own now (#1057): what a long conversation's Hand Over to… asks when clicked. */
  'session:mayHandOverNow': (projectPath: string, agentId: string) => boolean
  /** The long-conversation notice's Hand Over to… (HI-2320): for its conversation only (stale: another now, the notice says so), else whether it may hand over now. */
  'session:handOverOffer': (projectPath: string, agentId: string, sessionId: string) => 'ok' | 'busy' | 'stale'
  /** Turns Plan mode on or off in a running agent, for providers where it is a toggle (Codex). */
  'session:setPlanMode': (projectPath: string, agentId: string, on: boolean) => void
  /** Stops the agent and resumes the same conversation in the given mode. */
  'session:restartInMode': (projectPath: string, agentId: string, mode: PermissionMode) => void
  /** Switches running agents whose settings now say a different mode (after "Switch now"). */
  /** `offer`: from Switch Now's notice (HI-2320), which then says what happened. */
  'session:applyModes': (offer?: string) => { switched: string[]; skipped: string[] }
  /** Saves the clipboard image into .combwork/attachments/<sessionId> and gives its path; null if the clipboard has no image. */
  'session:pasteImage': (projectPath: string, agentId?: string) => string | null
  /** How each file would be attached to the agent's session (#387): copied or by path, its size and kind. Nothing changes. */
  'session:planAttach': (projectPath: string, sources: string[], agentId?: string) => AttachmentPlan[]
  /** Attaches files to the agent's running session: copies those planAttach says into .combwork/attachments/<sessionId>; the paths to paste. */
  'session:attach': (projectPath: string, sources: string[], agentId?: string) => Attached[]

  /** Adds an agent to the project (the user's: up to 24, past Maximum agents, #562, HI-2001), creating its worktree if asked, or reusing one (#456: `reuse` says how). */
  'agents:add': (projectPath: string, opts: AddAgentOptions) => AddedAgent
  /** Test copies only (#1451): an agent with a 0.9 worktree of its own, as an upgraded project has (1.0 adds none). */
  'agents:testLegacy': (projectPath: string, opts: AddAgentOptions) => AgentDef
  /** What more agents would cost (#562): the memory the running agents take now (null: can't be told) and the computer's. */
  'agents:memory': () => { running: { agents: number; bytes: number } | null; total: number; free: number }
  /** Changing provider clears the agent's model, effort and mode, and its session to resume (conversations can't move between providers). */
  /** Changes an agent's name and settings; for the Combwork Assistant's home, its settings for this workspace (mode too). */
  /** `confirmed` (HI-2670): agents:impact's fingerprint, when the change takes the agent off its lanes or cards. */
  'agents:update': (projectPath: string, agentId: string, patch: AgentPatch, confirmed?: string | null) => AgentDef
  /** What a change of an agent (its connection or role) would take out of the workflow (HI-2670); null: nothing. */
  'agents:impact': (projectPath: string, agentId: string, patch: AgentPatch) => LaunchImpact | null
  /**
   * Removes an agent (its session must be stopped). deleteWorktree also removes its worktree and branch; 'merged-clean'
   * only when they are fully merged into the main branch (`mergedInto`, the one the user was shown) and clean then,
   * guarded against changes while deleting, and never one another agent of the project still works in (#291).
   */
  'agents:remove': (projectPath: string, agentId: string, opts: { deleteWorktree: boolean | 'merged-clean'; mergedInto?: string | null; releaseCards?: boolean }) => RemovedAgent
  /** Whether each worktree agent's worktree could be deleted without losing work (merged and clean), for Remove All's question (#291). */
  'agents:worktreeChecks': (projectPath: string) => ({ agentId: string } & WorktreeCheck)[]
  /** The agent's worktree when its folder is missing, with whether its branch survives (#146); null when it isn't missing. */
  'agents:missingWorktree': (projectPath: string, agentId: string) => WorktreeGone | null
  /** Makes a missing worktree again: on its branch when it survives, else new from its base (#146). */
  'agents:recreateWorktree': (projectPath: string, agentId: string) => AgentDef
  /** Removes the link of an agent whose worktree folder is missing: it works in the project folder from now on. */
  'agents:unlinkWorktree': (projectPath: string, agentId: string) => AgentDef
  /** Moves an agent to `index` in the project's order (its position afterwards); returns the agents' ids in order. */
  'agents:move': (projectPath: string, agentId: string, index: number) => string[]
  /** Swaps two agents' places in the project's order (one dropped on another's pane); returns the agents' ids in order. */
  'agents:swap': (projectPath: string, agentId: string, otherId: string) => string[]
  /** Saves where the panes are in one layout (#762): its cells page after page, an agent's id or null; returns them as saved. */
  'agents:place': (projectPath: string, layout: SessionLayout, cells: (string | null)[]) => (string | null)[]
  /** Agent templates (#126): Combwork's own (#1436), the workspace's and the project's. */
  'templates:list': (projectPath: string) => TemplateEntry[]
  /** Saves the project's agents and layout; a name already there is replaced only with `overwrite` (else `exists`). */
  /** `usePatterns` (#1440): the project's key in its agents' names kept as a pattern (`HI-B1` as `{key}-B{n}`). */
  /** `includeWorkflow` (HI-1910): the project's workflow as the template's section for its version control (unset: true). */
  'templates:save': (projectPath: string, scope: TemplateScope, name: string, overwrite: boolean, usePatterns?: boolean, includeWorkflow?: boolean) => { saved: TemplateEntry; workflow: { saved: PlatformId | null; kept: PlatformId[] } } | { exists: string }
  /** What loading a template would do, and what stops it now. `from`: the project a project's template is kept in, if not this one. */
  'templates:plan': (projectPath: string, scope: TemplateScope, file: string, from?: string, names?: string[]) => TemplateLoadPlan
  /**
   * Replaces the project's agents and layout with a template's; `expected` is the agents' ids as the user saw them.
   * `connections` (HI-2109): the picker's answers (`*`, a role, an agent's name → a connection's id).
   */
  'templates:load': (projectPath: string, scope: TemplateScope, file: string, expected: string[], from?: string, names?: string[], connections?: ConnectionAnswers, applyWorkflow?: boolean) => { created: string[]; removed: string[]; workflow: TemplateWorkflow | null; maxAgents?: number }
  /** Adds one agent of a template (the `index`-th), the others left alone; on `connection` (HI-2109), else its role's preselected one. */
  'templates:addAgent': (projectPath: string, scope: TemplateScope, file: string, index: number, from?: string, name?: string, connection?: string) => AgentDef
  /** Choose Connections… (HI-2109): the project's agents by their roles, with their connections, and the connections usable here. */
  'templates:connectionsPlan': (projectPath: string) => ConnectionsPlan
  /** Choose Connections…: the project's agents given the connections answered, nothing else changed; `expected`: their ids as shown (else refused). */
  'templates:applyConnections': (projectPath: string, connections: ConnectionAnswers, expected: string[]) => ConnectionsApplied
  /** Every template of the workspace (#127, the Templates view): Combwork's own (#1436), the workspace's, then each project's. */
  'templates:all': () => TemplateEntry[]
  /** Renames a template where it is kept (another of that name there refuses it). */
  'templates:rename': (ref: TemplateRef, name: string) => TemplateEntry
  /** An edited template (#271), saved where it is kept; `savedAt`: as it was when the editor opened it. */
  'templates:update': (ref: TemplateRef, edited: Pick<AgentTemplate, 'name' | 'description' | 'layout' | 'agents' | 'pairs' | 'workflow'>, savedAt: string | null) => TemplateEntry
  /** Copies a template into the workspace or a project; a name taken there gets a number ("Pair (2)"). */
  'templates:duplicate': (ref: TemplateRef, to: TemplateDest) => TemplateEntry
  /** Deletes a template (to the Recycle Bin); Combwork's own can't be (#1436). */
  'templates:delete': (ref: TemplateRef) => void
  /** Exports a template to a file the user chooses (a save dialog); its path, or null if cancelled. */
  'templates:export': (ref: TemplateRef) => string | null
  /** Picks a file to import (an open dialog) and checks it: what it holds, refused saying why; null if cancelled. */
  'templates:pickImport': () => { path: string; name: string; agents: number; unknown: string[] } | null
  /** Imports a checked file into a place; a name already there is a clash unless `onClash` says replace or keep both. */
  'templates:import': (path: string, to: TemplateDest, onClash?: 'replace' | 'keep') => { imported: TemplateEntry } | { clash: string }
  /** Branches and worktrees, for the Add Agent dialog. */
  'agents:gitInfo': (projectPath: string) => ProjectGitInfo
  /** The unused worktree a new one on `branch` from `base` would reuse (#456), checked: null when there is none. */
  'agents:worktreeMatch': (projectPath: string, branch: string, base: string, name?: string) => WorktreeMatch | null
  'agents:branchStatus': (projectPath: string, agentId: string) => AgentBranchStatus
  /** Every worktree agent's unmerged work known so far (then `branch-status` events as it changes). */
  'agents:branchStatuses': () => { projectPath: string; agentId: string; status: AgentBranchStatus | null }[]
  /** Commits the worktree's changes and merges its branch into the project folder's current branch. */
  /** The project's worktrees no agent works in, each checked: merged into the main branch and clean, or why not (#353). */
  'worktrees:unused': (projectPath: string) => UnusedWorktrees
  /** An unused worktree's branch as the Merge dialog shows it, and its merge (#400): as an agent's, by its folder. */
  'worktrees:unusedBranchStatus': (projectPath: string, path: string) => AgentBranchStatus
  'worktrees:mergeUnused': (projectPath: string, path: string, opts: { squash: boolean; message: string; cleanup: boolean; card?: number; outsideQueue?: { card: number; reason: string } }) => MergeResult
  /** What removing one anyway loses, checked now, under a token the removal presents; throws when git can't say. */
  'worktrees:removalPreview': (projectPath: string, path: string) => UnusedWorktreePreview
  /** Removes one (the user's choice): a merged, clean one; or with `force`, a preview's token, only while nothing in it changed since. */
  'worktrees:removeUnused': (projectPath: string, path: string, opts: { expectInto?: string | null; force?: string }) => UnusedWorktreeRemoval
  /** The Merge dialog's merges outside cards (#1450): the branches it offers and the targets. */
  'worktrees:mergeBranches': (projectPath: string) => MergeBranchList
  /** What a branch holds that the target doesn't. */
  'worktrees:branchMergeStatus': (projectPath: string, branch: string, target: string) => AgentBranchStatus
  /** The card a branch is: the one Combwork's merge queue merges (Merge anyway), and the card whose line it is while not Done. */
  'worktrees:branchCards': (projectPath: string, branch: string) => { queue: BranchQueueCard | null; line: { number: number; key: string; title: string } | null }
  /** Merges a branch into a target; `card`: confirmed for that unfinished card's line; `outsideQueue` as agents:merge's. */
  'worktrees:mergeBranch': (projectPath: string, branch: string, opts: { target: string; squash: boolean; message: string; card?: number; outsideQueue?: { card: number; reason: string } }) => MergeResult
  /**
   * `outsideQueue`: merged anyway, though Combwork merges the card on this branch (#1357): an override on it, with the reason.
   * `card`: confirmed for that unfinished card's line (#1450); every merge route refuses one without it.
   */
  'agents:merge': (projectPath: string, agentId: string, opts: { squash: boolean; message: string; cleanup: boolean; moveBranch?: boolean; card?: number; outsideQueue?: { card: number; reason: string } }) => MergeResult

  /** The conversation for the transcript viewer; null when the file has not changed since knownVersion (a Transcript's `version`). Long tool input/output is shortened. */
  /** The conversation from item `from` on (default: the last TRANSCRIPT_WINDOW items); null when the file hasn't changed since knownVersion and `from` is unchanged. */
  'transcript:read': (projectPath: string, sessionId: string, opts?: { knownVersion?: string; from?: number }) => Transcript | null
  /** The Activity tab (#1254): what runs in a project's agents' launches now (their processes, by Stop's tracking, and background tasks). */
  'activity:now': (projectPath: string) => ActivityNow
  /** Activity's workspace level (HI-1664): what runs now in each of these session hosts of the window's workspace, in one call. */
  'activity:nowAll': (paths: string[]) => { path: string; now: ActivityNow }[]
  /** The agents of the window's workspace whose running session worked on this card (HI-1664, by the cards' index). */
  'activity:cardAgents': (card: number) => ActivityCardAgent[]
  /** The project's sessions running or active within `hours`, from their records alone (no transcript looked for). */
  'activity:sessions': (projectPath: string, hours: number) => SessionListItem[]
  /** An item's whole input (a prompt, a tool call's input and result) as written, masked like the log; null for another kind. */
  'activity:detail': (projectPath: string, sessionId: string, itemId: number) => ActivityDetail | null
  /** A session's latest turns and their tool calls, from its transcript; null when unchanged since knownVersion. */
  'activity:turns': (projectPath: string, sessionId: string, knownVersion?: string) => ActivityTurns | null
  /** Ends one of an agent's own processes (pid and start time, as listed), never its CLI. */
  'activity:endProcess': (projectPath: string, agentId: string, pid: number, created: string) => EndProcessResult
  /** One tool call with its full input and output. */
  'transcript:tool': (projectPath: string, sessionId: string, itemId: number) => TranscriptTool
  /** An image stored in the transcript, as a data URL. */
  'transcript:image': (projectPath: string, sessionId: string, imageId: number) => string
  /** Searches one session, or all of the project's sessions when sessionId is null. */
  'transcript:search': (projectPath: string, query: string, sessionId: string | null) => TranscriptSearchResult[]
  /** The transcript's compactions, oldest first: each one's item id (to open the transcript at its divider). */
  /** A Sessions view (`view`: its id) shows this transcript now, or none (null): archiving or deleting it from another window skips it. */
  'transcript:viewing': (view: string, projectPath: string, sessionId: string | null) => void
  'transcript:compactions': (projectPath: string, sessionId: string) => number[]
  /** Asks where to save, writes the conversation as Markdown and returns the path (null if cancelled). */
  'transcript:export': (projectPath: string, sessionId: string, title: string) => string | null

  'pty:write': (key: string, data: string) => void
  'pty:resize': (key: string, cols: number, rows: number) => void
  'pty:buffer': (key: string) => string
  /** Its process's size now, or the size the next one starts at without one (HI-2250): a terminal shown before the window has fitted it draws at that size. */
  'pty:size': (key: string) => { cols: number; rows: number }
  'pty:kill': (key: string) => void
  /** A terminal refused its program's OSC 52 clipboard request (#736): logged. */
  'pty:clipboardRefused': (key: string, reason: Osc52Refusal) => void

  'skills:list': (projectPath?: string) => SkillInfo[]
  /** The workspace's Combwork skills, with the bundled skills it doesn't have (bundled: 'missing'). */
  'skills:workspace': () => SkillInfo[]
  'skills:create': (name: string, description: string, targets: SkillTarget[]) => SkillInfo
  /** Chooses a .md or .zip to add as a skill; returns it with a suggested name, or null if cancelled. */
  'skills:pickFile': () => { path: string; name: string } | null
  'skills:addFromFile': (file: string, name: string, targets: SkillTarget[]) => SkillInfo
  /** Moves a Combwork or local skill to the Recycle Bin. */
  'skills:delete': (skillPath: string) => void
  /** Puts back a bundled skill as this version of Combwork ships it. */
  'skills:restoreBundled': (name: string) => SkillInfo
  'skills:copyToWorkspace': (skillPath: string) => SkillInfo
  /** A Combwork skill delivered to agents or not (#1431, Skills → Delivered to agents): in the workspace (no project), or one project's. */
  'skills:setDelivered': (projectPath: string | null, name: string, on: boolean) => void
  'skills:openFolder': () => void
  /** A listed skill's files (HI-2011), relative with "/", SKILL.md among them; `projectPath`: its project's tab. */
  'skills:files': (skillPath: string, projectPath?: string) => { files: string[]; truncated: boolean }

  // The Dialects view (HI-2444), in the window's workspace; paths are a dialect file's in .combwork/dialects ("claude-code/Opus 5.5.json").
  /** Every agent text a dialect can override (the Default beneath every file), by area: read once. */
  'dialects:catalogue': () => DialectCatalogue
  /** The workspace's dialect files: the Workspace file, each CLI's folder, the API's. */
  'dialects:list': () => DialectRow[]
  /** A file with the layers beneath it; null when it isn't there. */
  'dialects:file': (path: string) => DialectFileView | null
  /** Which running sessions speak which files, and whose chain moved ("restart to apply"): the view's only. */
  'dialects:usage': () => DialectUsage[]
  /** Saves a file (the form's draft, or the JSON tab's text), checked; `base`: the text on disk the draft started from. */
  'dialects:save': (path: string, draft: { file: DialectFile } | { raw: string }, base: string) => DialectRefusal | null
  'dialects:setOn': (path: string, on: boolean) => void
  /**
   * A new file in a CLI's folder under a label (HI-2523): empty (New Model File), or `from`'s texts (Duplicate). With a
   * model ('' for none: a test copy) it claims it, and `from` in the reply is the file that had it (now a test copy).
   */
  'dialects:create': (folder: string, label: string, model: string, from: string | null) => { path: string; from: string | null } | DialectRefusal
  /** Set Model (HI-2523): moves the model's claim onto one of the user's model files or test copies; the file that had it becomes a test copy. */
  'dialects:promote': (path: string, model: string) => { from: string | null } | DialectRefusal
  /** The model IDs agents of this CLI have run in the workspace, newest first (HI-2523: the model field's suggestions). */
  'dialects:models': (cli: string) => string[]
  /** Puts back a shipped file as this Combwork ships it. */
  'dialects:revert': (path: string) => void
  /** Moves a file the user made to the Recycle Bin (the Workspace, CLI and shipped files are refused). */
  'dialects:delete': (path: string) => DialectRefusal | null
  /** Chooses a file to import: an opaque token for this window and workspace, and its suggested label; null if cancelled. */
  'dialects:pickImport': () => { token: string; label: string } | null
  /** Imports the picked file into a folder under a label: as a test copy when its model is taken (or can't be there). */
  'dialects:import': (token: string, folder: string, label: string) => { path: string; testCopy: boolean } | DialectRefusal
  /** Writes a file as it is where the user chooses; the path written, or null if cancelled. */
  'dialects:export': (path: string) => string | null
  /** The files an agent of this CLI can pick (Agent Settings → Dialect): its folder's model files and test copies. */
  'dialects:choices': (cli: string) => { path: string; name: string; model?: string }[]

  /** The workspace's servers, each with where it is added (HI-2059: the projects and the Combwork Assistant). */
  'mcp:list': () => McpServerInfo[]
  /**
   * Adds a server to a project (its path) or the Combwork Assistant (`assistant`), HI-2059. `expected` is the server the user
   * was shown: refused if it has been replaced or edited since.
   */
  'mcp:add': (target: string, name: string, expected: McpShown) => void
  /** Removes a server from a project (its path) or the Combwork Assistant (`assistant`), HI-2059. */
  'mcp:remove': (target: string, name: string) => void
  /**
   * Add to… (the MCP view, HI-2059): added to the projects ticked (path → true) and removed from the others listed, and
   * for the Combwork Assistant as `assistant` says; `expected` as for mcp:add. Says what changed where, and what failed.
   */
  'mcp:places': (name: string, expected: McpShown | undefined, projects: Record<string, boolean>, assistant?: boolean) => McpPlacesResult
  'mcp:create': (name: string) => McpServerInfo
  'mcp:read': (name: string) => string
  /** With `expected` (the text as read), refuses with CONFLICT if the file has changed on disk since. */
  'mcp:save': (name: string, text: string, expected?: string) => McpServerInfo
  'mcp:delete': (name: string) => void
  /** The servers the project defines in its own config that the workspace hasn't got, with what each runs. */
  'mcp:projectServers': (projectPath: string) => McpProjectServer[]
  /** Copies them to the workspace, each on in the project when it is still the definition shown (by name), else off. */
  'mcp:importFromProject': (projectPath: string, names: string[], shown?: Record<string, McpServerDef>) => { copied: string[]; on: string[] }
  'mcp:openFolder': () => void
  /** Add MCP Server from File (#550): the file the user picks (.json or .zip), or null. */
  'mcp:pickFile': () => string | null
  /** What adding the file would add: its name, what it runs, whether the name is taken. Adds nothing. */
  'mcp:previewFile': (file: string) => McpFileServer
  /**
   * Adds it as `name`, off in the workspace and in every project (#1093); a name in use is refused unless `replace` (the
   * old one goes to the Recycle Bin).
   */
  'mcp:addFromFile': (file: string, name: string, replace: boolean) => McpServerInfo
  /**
   * The MCP catalogues' pages (HI-545): each listed source's rows for a search and a filter. `refresh` reads the
   * catalogues and this PC again (the view opening, ↻); `source` and `offset`: that source's next page.
   */
  'mcp:catalog': (opts: { query?: string; filter?: McpCatalogFilter; source?: string; offset?: number; refresh?: boolean }) => McpCatalogSourcePage[]
  /** The one-time note for a source Combwork doesn't check was shown (HI-545). */
  'mcp:catalogNoted': (url: string) => void
  /** Downloads and checks a catalogue server for Install or Update (HI-545): what it would run, held for the answer. */
  'mcp:catalogPrepare': (source: string, name: string) => McpCatalogPrepared
  /** Drops a prepared download the user cancelled. */
  'mcp:catalogDrop': (id: string) => void
  /** Installs a prepared catalogue server as `name` (added nowhere); `replace` over a server of the name. */
  'mcp:catalogInstall': (id: string, name: string, replace: boolean) => void
  /** Updates an installed catalogue server, refused if its definition or the places shown changed meanwhile (HI-545/s17). */
  'mcp:catalogUpdate': (id: string, shown: McpShown, places: { projects: string[]; assistant: boolean }) => { stale?: string }
  /** The catalogue sources (Settings → MCP Catalogues), and saving them. */
  'mcp:catalogSources': () => McpCatalogSettings
  'mcp:catalogSetSources': (next: McpCatalogSettings) => McpCatalogSettings

  'notes:tree': () => NoteFile[]
  'notes:create': (relPath: string, isDir: boolean) => string
  'notes:delete': (path: string) => void
  'notes:rename': (path: string, newName: string) => string

  /** The Combwork Assistant's modes: the workspace's, then Combwork's that it doesn't have (bundled: 'missing'). */
  /** The Combwork Assistant's actions in this window's workspace, oldest first, and the questions it waits on. */
  'assistant:actions': () => AssistantAction[]
  'assistant:questions': () => AssistantQuestion[]
  'assistant:answer': (id: string, yes: boolean) => void
  /** A question of the Assistant's, its panel hidden in this window (HI-2320): told once as a notification that needs you; whether it was told now. */
  'assistant:tellQuestion': (id: string) => boolean
  /** The Assistant's changes kept for undo (#1282), by the user's message they came from, newest first (7 days). */
  'assistant:changes': () => AssistantChangeGroup[]
  /** The user undoes one of the Assistant's changes, or a message's: what each put back, and what it left and why. */
  'assistant:undo': (sel: { change?: string; group?: string }) => AssistantUndoResult[]
  /** Switches this workspace's Assistant to a mode (a file in .combwork/modes): told at once if it runs, else when it starts (#259). */
  'assistant:switchMode': (modeId: string, save?: boolean) => 'told' | 'later' | 'saved'
  /** This window's workspace's merge slots: those held or waited for (#350). */
  'mergeSlots:list': () => MergeSlotInfo[]
  /** The user releases the hold they confirmed (its id) of a project's merge slot; refused if the slot changed hands since. Returns who held it. */
  'mergeSlots:release': (projectPath: string, branch: string, holdId: string) => string
  /** This window's workspace's lanes (#483): running ones and those ended lately, oldest first. */
  'lanes:list': () => LaneInfo[]
  /** The user ends a lane (abandoned: unmerged); returns it as it is now. */
  'lanes:end': (laneId: string, abandoned?: boolean) => LaneInfo
  /** The user retries a lane's new conversations no more tried (HI-2034: an agent busy as the lane started): how many. */
  'lanes:retryFresh': (laneId: string) => number
  /** Test copies only (HI-2034): a lane agent owed its new conversation, as a busy start leaves it, `minutesAgo` since. */
  'lanes:test': (op: { op: 'oweFresh'; lane: string; role: 'builder' | 'reviewer'; minutesAgo?: number }) => boolean
  /** Test copies only (HI-2321): how many of an agent's card-loop grace checks have finished (`loopChecksOf`), so a test waits for its own. */
  'loops:checks': (projectPath: string, agentId: string) => number
  /**
   * Start lane… (#1280): records a lane of a project's cards in order and starts its builder and reviewer, each in a
   * fresh conversation with the generated brief. Refused (nothing recorded) while either agent is busy.
   */
  'lanes:start': (projectPath: string, req: LaneStartRequest) => LaneStartResult
  /** What Start Lane… offers for a project (#1443): the reviewer pool's agents when its rules have G17 a shared pool, else null. */
  'lanes:startInfo': (projectPath: string) => LaneStartInfo
  /**
   * Cost per card (#602): the cards named, or every card (a project's, by its folder name) held at some time in [from, to)
   * (ms since the epoch).
   */
  'costs:cards': (q: { numbers?: number[]; project?: string | null; from?: number; to?: number }) => CardCost[]
  /** A card's cost per round and role (#1226): null when there is no such card. */
  'costs:rounds': (card: number) => CardRoundCosts | null
  /** Cost per lane (#602): the lanes named, or every lane listed. */
  'costs:lanes': (laneIds?: string[]) => LaneCost[]
  /** This window's workspace's progress runs, newest first. */
  'progress:list': () => ProgressRun[]
  /** The same, with the number of the last telling of them sent (#1108: `progress-runs`' seq), so later ones can follow it. */
  'progress:snapshot': () => ProgressSnapshot
  /** Moves a finished or stale run to Recent. */
  'progress:dismiss': (id: string) => void
  /** Stop for an isolated check (#1435): its check copy's job ended, so its command and all it started end. Whether it was one. */
  'progress:stop': (id: string) => boolean
  /** The user looked at the Progress panel: the taskbar stops showing a failure in red. */
  'progress:seen': () => void
  /** Opens the log a run reported (a text log or report, in its default app); an error says why it can't. */
  'progress:openLog': (id: string) => void
  /** Shows the log a run reported in its folder. */
  'progress:showLog': (id: string) => void
  /** Opens this window's developer console (#637), or brings it forward; refused unless Show developer features is on. */
  'console:open': () => void
  /** The developer console's sources in this window's workspace (#636): its agents, its Assistant and Combwork itself. */
  'console:sources': () => ConsoleSource[]
  /** The developer console's options (#699): `showText`, Settings → Advanced → Developer console: show text. Changes come as `console-options`. */
  'console:options': () => { showText: boolean }
  /**
   * What this window watches in the developer console: replaces its list ([] ends it) and returns each source's events
   * so far. Capture runs only while a window watches a source; live events come as `console-events`. Redacted, or with
   * prompt, reply and command text while `console:options`' showText is on (secrets stay masked).
   */
  'console:subscribe': (sources: string[]) => Record<string, ConsoleEvent[]>
  /** A watched source's events after `since` (a seq), oldest first (with text as `console:subscribe` says). */
  'console:snapshot': (source: string, since?: number) => ConsoleEvent[]
  /**
   * Records a source this window may read to a file in Combwork's console-recordings folder (#638), from now until stopped,
   * the window closes or leaves its workspace: redacted, or with prompt and reply text when `includeText` (secrets stay
   * masked). Replaces this window's recording; progress comes as `console-recording`.
   */
  'console:record': (source: string, opts?: { includeText?: boolean }) => ConsoleRecordingInfo
  /** Stops this window's recording; null if it wasn't recording. */
  'console:stopRecording': () => ConsoleRecordingInfo | null
  /** This window's recording going on, and the newest one in Combwork's folder (Copy Diagnostics offers it). */
  'console:recordings': () => { active: ConsoleRecordingInfo | null; latest: ConsoleRecordingInfo | null }
  /** Shows one of Combwork's recordings (by its file name) in its folder. */
  'console:showRecording': (name: string) => void
  /** The flight recorder's captures (#698), newest first: each one's trigger, agent and when. */
  'console:captures': () => ConsoleRecordingInfo[]
  'modes:list': () => ModeInfo[]
  'modes:create': (name: string) => ModeInfo
  /** Moves the mode's file to the Recycle Bin. */
  'modes:delete': (id: string) => void
  /** Puts back one of Combwork's modes as this version ships it (the workspace's copy goes to the Recycle Bin). */
  'modes:restore': (id: string) => ModeInfo

  'file:read': (path: string) => string
  /** With `expected` (the text as read), refuses with CONFLICT if the file has changed on disk since (a missing file reads as ''). */
  'file:write': (path: string, content: string, expected?: string) => void

  'memory:list': (projectPath: string) => MemorySource[]
  /** The Assistant's own memory (HI-2666): what `provider` (the one it runs on) saved for the window's workspace's folder. */
  'assistant:memory': (provider: ProviderId) => AssistantMemory
  /** Opens that memory's folder in File Explorer (HI-2736): the one assistant:memory names, found again in main. */
  'assistant:openMemoryFolder': (provider: ProviderId) => void
  /** Whether the given providers all read the project's AGENTS.md (directly or through an import). */
  'memory:instructionsShared': (projectPath: string, providers: ProviderId[]) => boolean
  /** Makes the given providers share AGENTS.md; returns the files written. */
  'memory:shareInstructions': (projectPath: string, providers: ProviderId[]) => string[]

  'files:list': (projectPath: string, rel: string) => FileEntry[]
  'files:create': (projectPath: string, parentRel: string, name: string, isDir: boolean) => string
  'files:rename': (projectPath: string, rel: string, newName: string) => string
  'files:move': (projectPath: string, rels: string[], destRel: string) => string[]
  'files:copy': (projectPath: string, rels: string[], destRel: string) => string[]
  /** Copies files from outside the project (e.g. dropped from Explorer) into destRel. */
  'files:import': (projectPath: string, sources: string[], destRel: string) => string[]
  /** Moves entries to the Recycle Bin. */
  'files:trash': (projectPath: string, rels: string[]) => void
  'files:find': (projectPath: string, query: string) => FileEntry[]
  'files:read': (projectPath: string, rel: string) => FileContent
  /** Saves text. With expectedModified, refuses (error "CONFLICT") if the file changed on disk since. */
  'files:write': (projectPath: string, rel: string, text: string, expectedModified: string | null, bom: boolean) => { modified: string; size: number }
  'files:open': (projectPath: string, rel: string) => void
  'files:reveal': (projectPath: string, rel: string) => void
  /** Which entries are files that exist (folders and missing paths are false); for the terminal's file links. */
  'files:linkFiles': (projectPath: string, rels: string[]) => (string | null)[]
  /** Starts/stops live 'files-changed' events for a project (reference counted). */
  'files:watch': (projectPath: string) => void
  /** The files with unsaved edits in the renderer (absolute paths), so quitting can ask about them. */
  'files:setUnsaved': (paths: string[]) => void
  'files:unwatch': (projectPath: string) => void
  /** The Files tab's Git menu (HI-2743): whether the project is a repository, its branch, and each item's tracked and ignored state. */
  'files:gitInfo': (projectPath: string, items: { rel: string; isDir: boolean }[]) => FileGitInfo
  /** Exclude from git: a line per item (or one `*.ext` line) in the top .gitignore (`shared`) or .git/info/exclude (`local`). */
  'files:gitExclude': (projectPath: string, items: { rel: string; isDir: boolean }[], target: IgnoreTarget, ext: boolean) => FileGitDone
  /** Stop tracking, keep the file: `git rm --cached`. */
  'files:gitUntrack': (projectPath: string, items: { rel: string; isDir: boolean }[]) => FileGitDone
  /** Include again: removes the plain line that ignores the item. */
  'files:gitInclude': (projectPath: string, items: { rel: string; isDir: boolean }[]) => FileGitDone
  /** Why is this ignored?: the file of the rule that ignores the item, its text and line, for Combwork's viewer (a rule outside the Files tab's tree). */
  'files:gitRuleText': (projectPath: string, items: { rel: string; isDir: boolean }[]) => FileGitRuleText

  'attachments:list': (projectPath: string) => SessionAttachmentGroup[]
  /** A kept attachment's text, for the viewer's previews. */
  'attachments:read': (projectPath: string, path: string) => AttachmentContent
  'attachments:trash': (projectPath: string, path: string) => void
  /** Moves all of a session's attachments to the Recycle Bin, all or none (not while it runs): how many went. */
  'attachments:trashGroup': (projectPath: string, sessionId: string) => number
  /** Copies an image attachment to the clipboard. */
  'attachments:copyImage': (path: string) => void

  /** root is a project or one of its agents' worktrees. With base, lists everything changed since the branch left base. */
  'git:status': (root: string, base?: string) => GitStatus
  'git:diff': (root: string, file: string, base?: string) => GitDiff
  /** The Changes tab's branch comparison (HI-1824, read-only): what can be compared, two branches, one file of them. */
  'git:compareLines': (projectPath: string) => CompareLines
  /** The Changes tab's leftover branches (HI-1823): every local branch, uncut, with its worktree and commits not in the target. */
  'git:leftovers': (projectPath: string) => LeftoverInfo
  /** pinBase and pinHead: the commits an earlier page of this comparison returned, so its pages are of one state ('' for the tips now). */
  'git:compare': (projectPath: string, base: string, head: string, page?: number, pinBase?: string, pinHead?: string) => GitComparison
  'git:compareDiff': (projectPath: string, base: string, head: string, file: string, pinned?: { base: string; head: string } | null) => GitDiff
  /** Opens a file of a Changes root (as git:status takes it, an unused worktree's too, #495) with its default app. */
  'changes:openFile': (root: string, file: string) => void
  /** Whether git itself runs (#346): as last checked, or checked again with `recheck`. */
  'git:tool': (recheck?: boolean) => GitTool
  /** The Git view (#607), the project folder's only (agents' worktrees change through the merge flow). The user's: no agent tool reaches these. */
  'git:summary': (projectPath: string) => GitRepoSummary
  /** A jj project's views (HI-2799): read-only, pinned at the single operation head; the user's window only. */
  'jj:repo': (projectPath: string) => JjView<JjRepoView>
  'jj:history': (projectPath: string) => JjView<JjHistoryView>
  'jj:bookmarks': (projectPath: string) => JjView<JjBookmarksView>
  'jj:conflicts': (projectPath: string) => JjView<JjConflictsView>
  'jj:compare': (projectPath: string, from: string, to: string) => JjView<JjCompareView | { from: JjResolved; to: JjResolved; op: string }>
  /** jj's operations, newest first, a page from the head or from `from` (HI-2800). */
  'jj:operations': (projectPath: string, from?: string | null) => JjView<JjOperationsView>
  /** What reverting one operation would change, read only; `at`: the head the window showed it at (Copy's revalidation). */
  'jj:operationPreview': (projectPath: string, op: string, at?: string | null) => JjView<JjOperationPreview>
  'git:info': (projectPath: string) => GitRepoInfo
  'git:deleteBranches': (projectPath: string, branches: BranchAt[], unmerged?: boolean) => string
  'git:deleteRemoteBranches': (projectPath: string, remote: string, branches: BranchAt[]) => string
  'git:branchDrops': (projectPath: string, branch: string) => BranchDrops
  'git:history': (projectPath: string, ref?: string | null, page?: number) => GitHistory
  /** Each action replies with what it did, in a sentence. Switching (and creating a branch to switch to) or pulling is refused while an agent works in the folder or its merge slot is held (`folderBusy`). */
  'git:switch': (projectPath: string, branch: string) => string
  /** Update from <target> (HI-1180): what it would do to a branch (its dialog), and the update, merge or rebase, saying what it did. */
  'git:updatePlan': (projectPath: string, branch: string) => BranchUpdatePlan
  'git:updateBranch': (projectPath: string, branch: string, how: BranchUpdateHow) => string
  /** Creates a branch, switching to it unless `stay`: at the folder's commit, or (HI-2807) at `from` as the user was shown it. */
  'git:createBranch': (projectPath: string, name: string, stay?: boolean, from?: BranchStart | null) => string
  /** HI-2807: why `name` can't be a new branch (a name git refuses, a branch or tag of that name), or null. */
  'git:checkBranchName': (projectPath: string, name: string) => string | null
  /** HI-2807: a start point (branch, tag, remote branch or commit) resolved, or null when there's no such thing. */
  'git:resolveStart': (projectPath: string, ref: string) => ResolvedStart | null
  /** HI-2807: the names New branch…'s Starts at offers. */
  'git:startPoints': (projectPath: string) => StartPoints
  /** HI-2807: which of these names aren't local branches now. */
  'git:missingBranches': (projectPath: string, names: string[]) => string[]
  'git:addRemote': (projectPath: string, name: string, url: string) => string
  'git:setRemoteUrl': (projectPath: string, name: string, url: string) => string
  'git:fetch': (projectPath: string) => string
  'git:pull': (projectPath: string) => string
  /** To the upstream, or to `remote` (setting it as the upstream) when the branch has none. Never forced. */
  'git:push': (projectPath: string, remote?: string) => string
  /** Push to… (#1385): the branch checked out, or every branch and tag, to any remote; never changes what a branch tracks. */
  'git:pushTo': (projectPath: string, remote: string, scope: PushScope, branch?: string) => string
  /** The local branches tracking a remote, all of them: what Remove's confirmation lists (#1385). */
  'git:remoteTracking': (projectPath: string, remote: string) => string[]
  /** `expected`: the branches the confirmation listed; refused when those tracking it now differ. */
  'git:removeRemote': (projectPath: string, name: string, expected?: string[]) => string
  'git:renameRemote': (projectPath: string, from: string, to: string) => string
  /** What a local branch tracks (#1385): `remote`'s `remoteBranch`, or nothing (`remote` null); `pushFirst` makes it there first. */
  'git:setUpstream': (projectPath: string, branch: string, remote: string | null, remoteBranch?: string, pushFirst?: boolean) => string
  'git:createTag': (projectPath: string, name: string, message: string, pushTo?: string) => string
  /** This repository's own user.name and user.email; empty removes it (the global one applies). */
  'git:setIdentity': (projectPath: string, name: string, email: string) => string
  /** Initialise repository (#701): whether it can be done, and what the dialog asks; then git init on main, .combwork excluded first, a starter .gitignore, the first commit. */
  'git:initCheck': (projectPath: string) => GitInitCheck
  'git:init': (projectPath: string, opts: GitInitOptions) => string

  /** Each provider's installed CLI, by provider. */
  'provider:info': () => Record<ProviderId, AgentInstallInfo>
  /** Looks again (one provider, or all), including the latest version. */
  'provider:refresh': (provider?: ProviderId) => Record<ProviderId, AgentInstallInfo>
  /** Runs install, update, sign-in or setup in a terminal; returns the terminal's key. */
  'provider:task': (provider: ProviderId, task: ProviderTask, host?: string) => string
  /** Runs the retry offered for the last failed update, only at the user's request. */
  'provider:retryUpdate': (provider: ProviderId) => string
  /** Stops every running agent of a provider (turning it off). */
  'provider:stopAgents': (provider: ProviderId) => void

  /** Combwork's accounts (HI-980) and this window's workspace's choice of them; `check`: each checked again (Settings shown). */
  'connections:list': (check?: boolean) => ConnectionsView
  /** Adds an account (its folder and junctions made); returns it, for its Sign in. */
  'connections:add': (provider: ProviderId, name: string) => Account
  'connections:rename': (id: string, name: string) => void
  /** Removes an account and its folder for good (refused while it is in use; `closeTerminal`, HI-1870: its open sign-in or Set Up terminal ended first). */
  'connections:remove': (id: string, opts?: { closeTerminal?: boolean }) => void
  /** Opens the account's sign-in (the CLI's own) in a terminal; returns the terminal's key. */
  'connections:signIn': (id: string) => string
  /**
   * Adds a server connection (HI-1772): its server, its models, and its key once (when the server needs one), which is
   * stored encrypted and never sent back. Returns it.
   */
  'connections:addServer': (input: { cli: ProviderId; name: string; baseUrl: string; preset?: string; models: ServerModel[]; modelsFrom: 'typed' | 'listed'; key?: string }) => Account & { keyFailed?: boolean }
  /** Changes a server connection's server; `keyCleared`: its base URL moved to another server, so its key was removed. */
  'connections:editServer': (id: string, patch: { baseUrl?: string; preset?: string | null; models?: ServerModel[]; modelsFrom?: 'typed' | 'listed' }) => { keyCleared: boolean }
  /** Saves or replaces a server connection's key; the reply has its last 4 characters only. */
  'connections:setKey': (id: string, key: string) => { last4: string }
  'connections:removeKey': (id: string) => void
  /** Reads a server connection's models from its server (`request`: this reading's id, for cancelling it and telling a stale reply). */
  'connections:readModels': (id: string, request: string) => ServerModelsRead
  'connections:cancelModels': (id: string, request: string) => void
  /** A server connection's diagnostics (HI-2683): one model's context as its server reports it (`request`: this check's id). */
  'connections:readContext': (id: string, model: string, request: string) => ContextCheck
  /** The tool-call test, one model's (`request`: this check's id). */
  'connections:testTools': (id: string, model: string, request: string) => ToolTest
  /** Ends a check, that one only (a newer one for the same model stays). */
  'connections:cancelCheck': (id: string, model: string, request: string) => void
  /** The last results of a model's checks, kept while Combwork runs. */
  'connections:lastCheck': (id: string, model: string) => LastCheck
  /** The context the user says a model has (null: clears it). */
  'connections:setModelContext': (id: string, model: string, tokens: number | null) => void
  /** HI-2682: a server connection's model's output budget (null: the default). */
  'connections:setModelOutput': (id: string, model: string, tokens: number | null) => void
  /** Opens the CLI on a connection (a server one, or a sign-in one: HI-1826), for its first-run screens; returns the terminal's key. */
  /** Its terminal's key, and where it opened (HI-1871: a workspace folder or a project's; absent, its own folder). */
  'connections:setUp': (id: string) => { key: string; in?: { folder: string; project?: string; workspace?: true } }
  /** Reset Masking Data (the user confirmed it): fingerprints made again from the keys saved now; masking strict for good after. */
  'connections:resetMasking': () => void
  /** Takes on the login an account is now signed in as (its change answered). */
  'connections:keepLogin': (id: string) => void
  /** Turns an account on or off in this window's workspace. */
  'connections:setOn': (id: string, on: boolean) => void
  /** An account's usage move (HI-2195): its agents move to another account at a share of a limit; null turns it off. */
  'connections:setUsageMove': (id: string, rule: UsageMoveRule | null) => void
  /** Moves an account to `index` in the one order of accounts (HI-2107, decision A; 0: the top); never on or off. */
  'connections:move': (id: string, index: number) => void
  /** Adds a connection on an account (HI-2107), after its others; refused for an effort its model doesn't take (decision E). */
  'connection:add': (account: string, input: ConnectionPatch & { name: string }) => Connection
  /** Changes a connection's name or values (each null leaves it to the CLI); running agents on it are offered Restart or Switch Now. */
  'connection:update': (id: string, patch: ConnectionPatch) => Connection
  /**
   * What saving these launch settings (HI-2670) would take out of the workflow: agents on running lanes or holding cards
   * in Doing or Review, made Independent by its Combwork tools going off. Null: nothing to confirm.
   */
  'connection:launchImpact': (id: string, launch: ConnectionLaunch | null) => LaunchImpact | null
  /** Saves a connection's launch settings (HI-2670); `confirmed`, launchImpact's fingerprint, when it has one. */
  'connection:setLaunch': (id: string, launch: ConnectionLaunch | null, confirmed?: string | null) => Connection
  /** A copy of a connection, after it. */
  'connection:duplicate': (id: string) => Connection
  /** Removes a connection; refused while an agent or the Assistant in an open workspace uses it, naming them. */
  'connection:remove': (id: string) => void
  /** Moves a connection to `index` among its account's (0: its base). */
  'connection:move': (id: string, index: number) => void
  /** Values moved from this window's workspace's projects onto their agents that their connection can't use (HI-1770), not dismissed. */
  'connections:notice': () => MovedNotice[]
  /** Dismisses those of the notice's entries (by key) that it lists now. */
  'connections:dismissNotice': (keys: string[]) => void
  /** Dismisses the one-time notice that agents run on connections (HI-1774), for good, in every window. */
  'connections:dismissIntro': () => void
  /** Switches this window's workspace's running agents whose connection isn't the one chosen now, each at its next safe point. */
  'connections:switchAffected': () => { projectPath: string; agentId: string; result: 'queued' | 'waiting' | 'notRunning' }[]
  /** Switches one agent to the connection chosen for it now, at its next safe point (HI-1755). */
  'session:switchConnection': (projectPath: string, agentId: string) => 'queued' | 'waiting' | 'notRunning'
  /** An agent whose role changed (HI-2664): restarted to load its side's tools; `ifIdle` says `busy` rather than wait. */
  'session:restartForTools': (projectPath: string, agentId: string, when: 'ifIdle' | 'atSafePoint') => 'restarting' | 'busy' | 'same' | 'notRunning'

  'api:info': () => AgentApiInfo
  /** What the Claude Code admin snippet is made from (HI-2777): ports and the hooks' timeouts. */
  'api:claudeSnippet': () => ClaudeSnippetFacts
  'api:regenerateToken': () => AgentApiInfo
  /** A new read-only viewer token with this name (#620). */
  'api:createViewer': (name: string) => AgentApiInfo
  /** Revokes a viewer token (its id): its requests are refused from now on. */
  'api:revokeViewer': (id: string) => AgentApiInfo
}

export type CombworkChannel = keyof CombworkRequests

export interface CombworkBridge {
  invoke<C extends CombworkChannel>(channel: C, ...args: Parameters<CombworkRequests[C]>): Promise<ReturnType<CombworkRequests[C]>>
  onEvent(listener: (event: CombworkEvent) => void): () => void
  onPtyData(listener: (key: string, data: string) => void): () => void
  onPtyExit(listener: (key: string, code: number) => void): () => void
  /** Full path of a file dropped from Explorer. */
  pathForFile(file: File): string
  platform: string
  /** A test copy's window: React's commits are watched (HI-1387, renderer commitWatch.ts). */
  commitWatch: boolean
  /**
   * What arrived from main between two times (epoch ms): each call's reply, each event and terminal output, in words
   * ("reply tasks:changes", "event tasks-changed ×3"): what a long task's line names as under way (HI-1775).
   */
  arrivals(from: number, to: number): string[]
}
