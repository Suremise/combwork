import type { AgentLeftovers } from './agentProcesses'
import type { AntivirusStatus, AvAction, AvChangeResult, AvMovePlan, AvSuggestionReply } from './antivirus'
import type { JournalEdit, JournalEntryView, JournalFilter, JournalForgetPreview, JournalForgetResult, JournalPage, JournalSettings } from './journal'
import type {
  ArchiveBatch,
  BoardState,
  SetAsideCard,
  ArchiveRequest,
  ArchiveResult,
  UnarchiveResult,
  BoardFold,
  UpdateState,
  WorktreeGone,
  WorktreeMatch,
  WorktreeCheck,
  UnusedWorktrees,
  UnusedWorktreeRemoval,
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
  OldWorktreeOutcome,
  AgentPatch,
  CleanupItem,
  CleanupOptions,
  CleanupResult,
  PurgePreview,
  PurgeResult,
  PurgeTarget,
  ModeInfo,
  RecentWorkspace,
  AgentInstallInfo,
  AppConfig,
  AppInfo,
  AppSettings,
  EffortOption,
  FallbackModel,
  FileContent,
  FileEntry,
  GitDiff,
  HiddenProject,
  GitStatus,
  HiveEvent,
  LiveSessionState,
  McpFileServer,
  McpShown,
  McpProjectServer,
  McpServerDef,
  McpServerInfo,
  MergeResult,
  MergeSlotInfo,
  LaneInfo,
  LaneStartRequest,
  LaneStartResult,
  ModelPrice,
  MemorySource,
  NoteFile,
  PlanUsage,
  ProjectConfig,
  ProjectProviderConfig,
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
  TaskColumn,
  TaskMoveResult,
  TaskPatch,
  TaskStartTarget,
  Transcript,
  TranscriptSearchResult,
  TranscriptTool,
  WorkflowChange,
  WorkflowCheck,
  WorkflowForm,
  WorkspaceInfo
} from './types'
import type { MetricsQuery, MetricsReport } from './metrics'
import type { Fact } from './workflow/facts'
import type { Artifact, CompareScope, ImportResult, KeptEntry } from './benchmark'
import type { AgentTemplate, TemplateDeleted, TemplateDest, TemplateEntry, TemplateRef, TemplateScope } from './templates'
import type { ProjectPref, ProjectPrefValue } from './uiPrefs'
import type { TipsChange, TipsState } from './tips'
import type { AdvancedState } from './advanced'
import type { GitTool } from './gitTool'
import type { GitInitCheck, GitInitOptions } from './gitInit'
import type { GitHistory, GitRepoInfo, GitRepoSummary, PushScope } from './gitRepo'
import type { BoardFoldChange } from './tasks'
import type { CardCost, CardRoundCosts, LaneCost } from './cardCosts'
import type { ConsoleEvent, ConsoleRecordingInfo, ConsoleSource } from './devConsole'
import type { Osc52Refusal } from './osc52'
import type { ForYouAnswer, ForYouSummary, WorkBadge, WorkView } from './workflow/workView'
import type { QueueResumed, QueueView } from './workflow/queue'

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
export type SettingsPatch = DeepPartial<AppSettings>

/**
 * Every request the renderer can make of the main process.
 * The preload bridge exposes these as `window.hive.invoke(channel, ...args)`.
 */
export interface HiveRequests {
  'app:info': () => AppInfo
  /** The plan usage each provider last reported (e.g. 5-hour and weekly limits), by provider. */
  'app:planUsage': () => Record<ProviderId, PlanUsage>
  'app:quit': () => void
  /** Restarts Hive: quits as app:quit does (asking about running agents), then starts it again (#676). */
  'app:restart': () => void
  'app:quitDecision': (choice: QuitChoice, dontAskAgain: boolean) => void
  'app:cancelPendingQuit': () => void
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
  /** The notice that Hive closed unexpectedly (#984): resumes the agents that were running, once; main tells the result. */
  'app:resumeAfterClose': () => { resumed: number; failed: number }
  /** The unexpected-close notice's Stop Them (#987): how many processes the agents had started were stopped. */
  'app:stopLeftAfterClose': () => number
  'update:state': () => UpdateState
  /** A check started by the user; resolves with the result. */
  'update:check': () => UpdateState
  'update:download': () => void
  /** Restart and Update: quits (asking if agents are working), installs and restarts. */
  'update:install': () => void
  'update:skip': (version: string) => void
  /** Opens the Chromium/Electron licences that ship next to the app's executable. */
  'app:openChromiumLicenses': () => boolean

  'window:minimize': () => void
  'window:toggleMaximize': () => void
  'window:close': () => void
  /** How many Hive windows are open. */
  'window:count': () => number
  /** Opens another Hive window (the welcome page), like VS Code's New Window. */
  'window:new': () => void
  'window:toggleDevTools': () => void
  'window:zoom': (direction: 'in' | 'out' | 'reset') => void
  'window:toggleFullScreen': () => void
  'window:edit': (role: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => void
  'window:setTitleBarColors': (color: string, symbolColor: string) => void
  /** How many backdrops (dialogs, nested or not, the command palette) are up in this window: dims the window buttons to match. */
  'window:setBackdrops': (count: number) => void
  /** The taskbar button's badge: a PNG (base64) drawn at `scale`, or none at 0. */
  'window:setBadge': (count: number, png: string | null, scale: number) => void
  /** Always on Top for this window, remembered for its workspace (pin.ts). Returns the window's state now. */
  'window:setAlwaysOnTop': (on: boolean) => boolean
  'window:getAlwaysOnTop': () => boolean
  /** The project this window's page shows (null: none), for banners shown for "This project". */
  'window:showing': (projectPath: string | null) => void
  /** A banner was clicked: brings up the window showing its project, and the project (as a Windows notification's click). */
  'notice:open': (projectPath: string | null) => void

  'settings:get': () => AppSettings
  'settings:update': (patch: SettingsPatch) => AppSettings
  'settings:reset': (section?: keyof AppSettings) => AppSettings
  /** Replaces a provider's price overrides (USD per million tokens, by model id). */
  /** Replaces a provider's price overrides, and (when given) which shipped prices are removed from its table. */
  'settings:setProviderPrices': (provider: ProviderId, prices: Record<string, ModelPrice>, removed?: string[]) => AppSettings
  /** Replaces a provider's fallback list of models or effort levels (#125); null goes back to Hive's defaults. */
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
  /** Saves a report as a JSON file (a save dialog): the path, or null if cancelled. `sanitize` replaces project names. */
  'metrics:export': (q: MetricsQuery, sanitize: boolean) => string | null
  /** Ends an agent's card watch (#128: Cancel Card Watch in its pane's ⋯). Whether it had one. */
  'watch:cancel': (projectPath: string, agentId: string) => boolean
  /** Cancels the messages waiting to be offered to an agent (#530, #647): how many there were. */
  'session:cancelMessages': (projectPath: string, agentId: string) => number
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
  /** Settings → Workspace → Card loop rounds and wait (#412): the values given change, the rest stay. */
  'workspace:setLoops': (patch: { rounds?: number; waitHours?: number }) => WorkspaceInfo | null
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
  /** The projects the one-time presets notice offers presets to (§16.17), or null when it isn't due. */
  'workflow:presetsNotice': () => { path: string; name: string }[] | null
  /** The presets notice was answered (Choose… or Not now): it isn't shown again in this workspace. */
  'workflow:presetsNoticeSaid': () => void
  /**
   * The project's merge queues (#1353, SPEC §16.9.3): one target's, or every target's it has queued for or paused. Each
   * change comes as a `queue-changed` event.
   */
  'queue:list': (projectPath: string, target?: string) => QueueView[]
  /** Pause queue (the user's): the target's queue stops before its next entry; saved. A queue paused already keeps its pause. */
  'queue:pause': (projectPath: string, target: string) => QueueView
  /** Resume: clears the pause once its cause, where Hive can see it, is gone (`resumed`); else the queue is paused again, saying why. */
  'queue:resume': (projectPath: string, target: string) => QueueResumed
  /** Remove from queue (the user's override): the card back to Approved, never merged; refused once its merge has begun. */
  'queue:remove': (n: number, reason?: string) => TaskCard
  /** Retry merge (the user's override): requeues a returned card's unchanged revision, once. */
  'queue:retry': (n: number, reason?: string) => TaskCard
  /** Adds the project's .hive to its git repository's info/exclude (#345); refuses where no git repository holds it. */
  'project:excludeHive': (projectPath: string) => WorkspaceInfo
  /** The files under the project's .hive git tracks (#364), for the confirmation before untracking them. */
  'project:hiveTracked': (projectPath: string) => string[]
  /** `git rm --cached` of exactly the files confirmed (#364), refused if git tracks others now: their removal staged, the files left on disk. */
  'project:untrackHive': (projectPath: string, files: string[]) => WorkspaceInfo
  /** Changes one provider's overrides for a project, merged under the file lock. */
  'project:updateProvider': (projectPath: string, provider: ProviderId, patch: Partial<ProjectProviderConfig>) => ProjectConfig
  'project:openInExplorer': (projectPath: string) => void
  'project:openTerminal': (projectPath: string) => void
  /** What hiding, removing or deleting the project would touch (Project → Remove Project…). */
  'project:removalInfo': (projectPath: string) => ProjectRemovalInfo
  /** Hides it, removes it from Hive (packing its workspace files into its folder) or deletes it (to the Recycle Bin). */
  'project:remove': (projectPath: string, how: ProjectRemoval) => { warnings: string[] }
  /** Projects hidden or removed from Hive, and whether each folder is still in the workspace. */
  'project:hidden': () => (HiddenProject & { present: boolean })[]
  'project:restore': (name: string) => { handovers: number; cards: number }
  /** Stops listing a hidden or removed project whose folder is gone. */
  'project:forget': (name: string) => void
  /** A folder holding what Remove from Hive packed: keep (unpack into this workspace) or discard it. */
  'project:takeRemovedData': (projectPath: string, keep: boolean) => { handovers: number; cards: number }

  /** The board's state (#1207): read-only and why, and the copy kept from before its upgrade to 1.0. */
  'board:state': () => BoardState
  /** Upgrades the board to 1.0, the user having said yes (refused while another Hive has the workspace open). */
  'board:upgrade': () => { backup: string | null }
  /** Help → Restore the 0.9 Board Backup…: the 1.0 board copied aside, the 0.9 copy put back. */
  'board:restore09': () => { saved: string; restored: string }
  /** Every card on the workspace's board, archived ones too. */
  /** The board as the window shows it: archived cards in short (TaskCard.summary) unless `fullArchive` (#1017). */
  'tasks:list': (fullArchive?: boolean) => TaskCard[]
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
  /** Cards an older Hive saved, set aside for review (#1044): listed, added to the board, discarded (by file name). */
  'tasks:setAside': () => SetAsideCard[]
  'tasks:addSetAside': (file: string) => TaskCard
  'tasks:discardSetAside': (file: string) => void
  'tasks:create': (input: { title: string; description?: string; project?: string; agent?: string | null; column?: TaskColumn; labels?: string[]; context?: string[]; kind?: 'code' | 'no-code' }) => TaskCard
  /** Changes a card's kind after it was made (#1277): an override, asked first (`ask`) unless `confirm`, with its reason. */
  'tasks:setKind': (n: number, kind: 'code' | 'no-code', opts?: { confirm?: boolean; reason?: string }) => { ask: true } | TaskCard
  /** Answers an agent's proposed kind (#1277): `accept` makes it the card's kind, else the card stays code. */
  'tasks:confirmKind': (n: number, accept: boolean) => TaskCard
  /** A card's context reference (#818): its section's text and heading line, or why it doesn't resolve. projectPath: the card's project's (null: a card about the workspace). */
  'docs:section': (projectPath: string | null, ref: string) => { ref: string; content: string; line: number } | { ref: string; problem: string; closest?: string[] }
  'tasks:update': (n: number, patch: TaskPatch) => TaskCard
  /**
   * The user's move of a card to a column through its workflow rules (#1265, SPEC §16.8.4): a move that skips a rule
   * asks first (`ask`, nothing written) unless `confirm`, then records an Override (with `reason`, optional).
   */
  'tasks:move': (n: number, column: TaskColumn, opts?: { before?: number | null; confirm?: boolean; reason?: string; agent?: string | null }) => TaskMoveResult
  /** The columns a card can be moved to under its rules (#1275): where a drag may drop it; null: every column (no rule applies). */
  'tasks:columns': (n: number) => TaskColumn[] | null
  /** A card's facts (#1216), oldest first: what each move recorded (none on a board waiting for its upgrade). */
  'tasks:facts': (n: number) => Fact[]
  /** What waits for the user (For you, #1269, SPEC §16.8.5): every live card's open requests, of one project (its folder name) or the workspace, oldest first, and their count. */
  'tasks:forYou': (project?: string | null) => ForYouSummary
  /** The user answers a card's request (For you): only the user. Refused when it was answered or retired meanwhile. */
  'tasks:answer': (n: number, request: string, answer: ForYouAnswer) => TaskCard
  'tasks:comment': (n: number, text: string) => TaskCard
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

  'session:list': (projectPath: string) => SessionListItem[]
  /** agentId: without one, the project's only agent. skipSetup starts the agent even though the worktree's setup command hasn't succeeded. */
  'session:start': (projectPath: string, opts: { resumeId?: string; name?: string; agentId?: string; skipSetup?: boolean }) => LiveSessionState
  /** Stops the CLI's background job holding a conversation, then resumes it in the agent. */
  'session:stopBackgroundAndResume': (projectPath: string, agentId: string, jobId: string, sessionId: string) => void
  'session:stop': (projectPath: string, agentId?: string) => void
  /** What this window's agents left running when they stopped (#507); `settled`: once every launch that has exited has been looked at (#613). */
  'session:leftovers': (settled?: boolean) => AgentLeftovers[]
  /** Ends what the agent's stopped launches left running (only processes they started), or keeps it running and stops listing it. Returns how many. */
  'session:settleLeftovers': (projectPath: string, agentId: string, how: 'end' | 'keep') => number
  /** Types a short "carry on" into a running agent whose turn a refused sign-in stopped (Resume (n), #309). */
  'session:carryOn': (projectPath: string, agentId: string) => void
  /** The user says an agent whose state is unknown (silent, no sign of its turn's end) is idle (#648). */
  'session:markIdle': (projectPath: string, agentId: string) => void
  'session:archive': (projectPath: string, sessionId: string, archived: boolean) => void
  'session:rename': (projectPath: string, sessionId: string, name: string) => void
  /** Deletes a session that isn't running from Hive (its record and backups; the CLI's transcript stays). */
  'session:delete': (projectPath: string, sessionId: string) => void
  /** Archives, unarchives or deletes several sessions (a branch of the Sessions tab), each all or nothing; skips those in use. */
  'session:bulk': (projectPath: string, action: SessionBulkAction, sessionIds: string[]) => SessionBulkResult
  /** Deleted sessions' usage (list items with deleted: true), which totals still count. */
  'session:keptUsage': (projectPath: string) => SessionListItem[]
  /** What Hive keeps for a project or the Assistant (Project Settings → Storage); the last result unless refresh. `request` lets storage:abandon end the call. */
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
  /** What Purge… (#1138) would remove of Hive's for a session, a project or the window's workspace: every file and record, with its size. */
  'storage:purgePreview': (target: PurgeTarget) => PurgePreview
  /** Removes what a preview (its id) listed, those of its keys given, to the Recycle Bin or permanently, skipping what changed since. */
  'storage:purge': (previewId: string, listed: string[], permanent: boolean) => PurgeResult
  /** Forgets every transcript's usage, in memory and in usage-cache.json (Settings → Sessions → Usage cache). */
  'session:clearUsageCache': () => void
  'session:adopt': (projectPath: string, sessionId: string) => void
  'session:usage': (projectPath: string, sessionId: string) => SessionUsage | null
  /** The window showed these agents' panes (all of the project's agents when none are named). */
  'session:markSeen': (projectPath: string, agentIds?: string[]) => void
  'session:live': () => LiveSessionState[]
  /** Runs the CLI's /compact in the agent's session (only while the agent is idle). */
  'session:compact': (projectPath: string, focus?: string, agentId?: string) => void
  /** Switches a running agent's permission mode the way the CLI allows (Claude Code: Shift+Tab). ok false: not possible live (restart instead) or it didn't take. */
  'session:setMode': (projectPath: string, agentId: string, mode: PermissionMode) => { ok: boolean; restart?: boolean; message?: string }
  /** Lets an agent edit a file another agent holds ("Ask me" lock, for CLIs that can't ask themselves). */
  'session:allowLockedEdit': (projectPath: string, agentId: string, path: string) => void
  /** Continues one agent's work in another, of any provider: a handover from the source (optional), then the target picks it up. */
  'session:handOver': (projectPath: string, fromAgentId: string, toAgentId: string, opts: { handover: boolean }) => void
  /** Whether the agent may hand over to a new conversation of its own now (#1057): what a long conversation's Hand Over to… asks when clicked. */
  'session:mayHandOverNow': (projectPath: string, agentId: string) => boolean
  /** Turns Plan mode on or off in a running agent, for providers where it is a toggle (Codex). */
  'session:setPlanMode': (projectPath: string, agentId: string, on: boolean) => void
  /** Stops the agent and resumes the same conversation in the given mode. */
  'session:restartInMode': (projectPath: string, agentId: string, mode: PermissionMode) => void
  /** Switches running agents whose settings now say a different mode (after "Switch now"). */
  'session:applyModes': () => { switched: string[]; skipped: string[] }
  /** Saves the clipboard image into .hive/attachments/<sessionId> and gives its path; null if the clipboard has no image. */
  'session:pasteImage': (projectPath: string, agentId?: string) => string | null
  /** How each file would be attached to the agent's session (#387): copied or by path, its size and kind. Nothing changes. */
  'session:planAttach': (projectPath: string, sources: string[], agentId?: string) => AttachmentPlan[]
  /** Attaches files to the agent's running session: copies those planAttach says into .hive/attachments/<sessionId>; the paths to paste. */
  'session:attach': (projectPath: string, sources: string[], agentId?: string) => Attached[]

  /** Adds an agent to the project (up to Agents per project, #562), creating its worktree if asked, or reusing one (#456: `reuse` says how). */
  'agents:add': (projectPath: string, opts: AddAgentOptions) => AddedAgent
  /** What more agents would cost (#562): the memory the running agents take now (null: can't be told) and the computer's. */
  'agents:memory': () => { running: { agents: number; bytes: number } | null; total: number; free: number }
  /** Changing provider clears the agent's model, effort and mode, and its session to resume (conversations can't move between providers). */
  /** Changes an agent's name and settings; for the Hive Assistant's home, its settings for this workspace (mode too). */
  'agents:update': (projectPath: string, agentId: string, patch: AgentPatch) => AgentDef
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
  /** Agent templates (#126): the workspace's and the project's. */
  'templates:list': (projectPath: string) => TemplateEntry[]
  /** Saves the project's agents and layout; a name already there is replaced only with `overwrite` (else `exists`). */
  'templates:save': (projectPath: string, scope: TemplateScope, name: string, overwrite: boolean) => { saved: TemplateEntry } | { exists: string }
  /** What loading a template would do, and what stops it now. `from`: the project a project's template is kept in, if not this one. */
  'templates:plan': (projectPath: string, scope: TemplateScope, file: string, from?: string, names?: string[]) => TemplateLoadPlan
  /** Replaces the project's agents and layout with a template's; `expected` is the agents' ids as the user saw them. */
  'templates:load': (projectPath: string, scope: TemplateScope, file: string, expected: string[], from?: string, removeOld?: { paths: string[]; mergedInto: string | null }, names?: string[]) =>{ created: string[]; removed: string[]; oldWorktrees: OldWorktreeOutcome[] }
  /** Adds one agent of a template (the `index`-th), the others left alone. */
  'templates:addAgent': (projectPath: string, scope: TemplateScope, file: string, index: number, from?: string) => AgentDef & { reused?: true }
  /** Every template of the workspace (#127, the Templates view): the workspace's, then each project's. */
  'templates:all': () => TemplateEntry[]
  /** Renames a template where it is kept (another of that name there refuses it). */
  'templates:rename': (ref: TemplateRef, name: string) => TemplateEntry
  /** An edited template (#271), saved where it is kept; `savedAt`: as it was when the editor opened it. */
  'templates:update': (ref: TemplateRef, edited: Pick<AgentTemplate, 'name' | 'description' | 'layout' | 'agents'>, savedAt: string | null) => TemplateEntry
  /** Copies a template into the workspace or a project; a name taken there gets a number ("Pair (2)"). */
  'templates:duplicate': (ref: TemplateRef, to: TemplateDest) => TemplateEntry
  /** Deletes a template (to the Recycle Bin). */
  /** Deletes it; says the unused worktrees its worktree agents left, per project (#353). */
  'templates:delete': (ref: TemplateRef) => TemplateDeleted
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
  'worktrees:mergeUnused': (projectPath: string, path: string, opts: { squash: boolean; message: string; cleanup: boolean }) => MergeResult
  /** What removing one anyway loses, checked now, under a token the removal presents; throws when git can't say. */
  'worktrees:removalPreview': (projectPath: string, path: string) => UnusedWorktreePreview
  /** Removes one (the user's choice): a merged, clean one; or with `force`, a preview's token, only while nothing in it changed since. */
  'worktrees:removeUnused': (projectPath: string, path: string, opts: { expectInto?: string | null; force?: string }) => UnusedWorktreeRemoval
  'agents:merge': (projectPath: string, agentId: string, opts: { squash: boolean; message: string; cleanup: boolean; moveBranch?: boolean }) => MergeResult

  /** The conversation for the transcript viewer; null when the file has not changed since knownVersion (a Transcript's `version`). Long tool input/output is shortened. */
  /** The conversation from item `from` on (default: the last TRANSCRIPT_WINDOW items); null when the file hasn't changed since knownVersion and `from` is unchanged. */
  'transcript:read': (projectPath: string, sessionId: string, opts?: { knownVersion?: string; from?: number }) => Transcript | null
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
  /** Its process's size now (null without one): a terminal shown before the window has fitted it draws at that size. */
  'pty:size': (key: string) => { cols: number; rows: number } | null
  'pty:kill': (key: string) => void
  /** A terminal refused its program's OSC 52 clipboard request (#736): logged. */
  'pty:clipboardRefused': (key: string, reason: Osc52Refusal) => void

  'skills:list': (projectPath?: string) => SkillInfo[]
  /** The workspace's Hive skills, with the bundled skills it doesn't have (bundled: 'missing'). */
  'skills:workspace': () => SkillInfo[]
  'skills:create': (name: string, description: string, targets: SkillTarget[]) => SkillInfo
  /** Chooses a .md or .zip to add as a skill; returns it with a suggested name, or null if cancelled. */
  'skills:pickFile': () => { path: string; name: string } | null
  'skills:addFromFile': (file: string, name: string, targets: SkillTarget[]) => SkillInfo
  /** Moves a Hive or local skill to the Recycle Bin. */
  'skills:delete': (skillPath: string) => void
  /** Puts back a bundled skill as this version of Hive ships it. */
  'skills:restoreBundled': (name: string) => SkillInfo
  'skills:copyToWorkspace': (skillPath: string) => SkillInfo
  'skills:openFolder': () => void

  'mcp:list': () => McpServerInfo[]
  /**
   * On or off in the workspace (#1093, its master switch; off keeps the projects' choices). Turning it on with
   * `expected` (the server the user was shown): refused if it has been replaced or edited since; `projects` (path → on)
   * sets those projects' own choices in the same change.
   */
  'mcp:setGlobal': (name: string, enabled: boolean, expected?: McpShown, projects?: Record<string, boolean>) => void
  /** On or off in one project, its own choice (#1093: it runs there while it is on in the workspace too); `expected` as for mcp:setGlobal. */
  'mcp:setProject': (projectPath: string, name: string, enabled: boolean, expected?: McpShown) => void
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

  'notes:tree': () => NoteFile[]
  'notes:create': (relPath: string, isDir: boolean) => string
  'notes:delete': (path: string) => void
  'notes:rename': (path: string, newName: string) => string

  /** The Hive Assistant's modes: the workspace's, then Hive's that it doesn't have (bundled: 'missing'). */
  /** The Hive Assistant's actions in this window's workspace, oldest first, and the questions it waits on. */
  'assistant:actions': () => AssistantAction[]
  'assistant:questions': () => AssistantQuestion[]
  'assistant:answer': (id: string, yes: boolean) => void
  /** Revert on a setting the Assistant changed (its activity list): sets it back, and lists that too (#186). */
  'assistant:revertSetting': (actionId: string) => void
  /** The Assistant's changes kept for undo (#1282), by the user's message they came from, newest first (7 days). */
  'assistant:changes': () => AssistantChangeGroup[]
  /** The user undoes one of the Assistant's changes, or a message's: what each put back, and what it left and why. */
  'assistant:undo': (sel: { change?: string; group?: string }) => AssistantUndoResult[]
  /** Switches this workspace's Assistant to a mode (a file in .hive/modes): told at once if it runs, else when it starts (#259). */
  'assistant:switchMode': (modeId: string, save?: boolean) => 'told' | 'later' | 'saved'
  /** This window's workspace's merge slots: those held or waited for (#350). */
  'mergeSlots:list': () => MergeSlotInfo[]
  /** The user releases the hold they confirmed (its id) of a project's merge slot; refused if the slot changed hands since. Returns who held it. */
  'mergeSlots:release': (projectPath: string, branch: string, holdId: string) => string
  /** This window's workspace's lanes (#483): running ones and those ended lately, oldest first. */
  'lanes:list': () => LaneInfo[]
  /** The user ends a lane (abandoned: unmerged); returns it as it is now. */
  'lanes:end': (laneId: string, abandoned?: boolean) => LaneInfo
  /**
   * Start lane… (#1280): records a lane of a project's cards in order and starts its builder and reviewer, each in a
   * fresh conversation with the generated brief. Refused (nothing recorded) while either agent is busy.
   */
  'lanes:start': (projectPath: string, req: LaneStartRequest) => LaneStartResult
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
  /** The user looked at the Progress panel: the taskbar stops showing a failure in red. */
  'progress:seen': () => void
  /** Opens the log a run reported (a text log or report, in its default app); an error says why it can't. */
  'progress:openLog': (id: string) => void
  /** Shows the log a run reported in its folder. */
  'progress:showLog': (id: string) => void
  /** Opens this window's developer console (#637), or brings it forward; refused unless Show developer features is on. */
  'console:open': () => void
  /** The developer console's sources in this window's workspace (#636): its agents, its Assistant and Hive itself. */
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
   * Records a source this window may read to a file in Hive's console-recordings folder (#638), from now until stopped,
   * the window closes or leaves its workspace: redacted, or with prompt and reply text when `includeText` (secrets stay
   * masked). Replaces this window's recording; progress comes as `console-recording`.
   */
  'console:record': (source: string, opts?: { includeText?: boolean }) => ConsoleRecordingInfo
  /** Stops this window's recording; null if it wasn't recording. */
  'console:stopRecording': () => ConsoleRecordingInfo | null
  /** This window's recording going on, and the newest one in Hive's folder (Copy Diagnostics offers it). */
  'console:recordings': () => { active: ConsoleRecordingInfo | null; latest: ConsoleRecordingInfo | null }
  /** Shows one of Hive's recordings (by its file name) in its folder. */
  'console:showRecording': (name: string) => void
  /** The flight recorder's captures (#698), newest first: each one's trigger, agent and when. */
  'console:captures': () => ConsoleRecordingInfo[]
  'modes:list': () => ModeInfo[]
  'modes:create': (name: string) => ModeInfo
  /** Moves the mode's file to the Recycle Bin. */
  'modes:delete': (id: string) => void
  /** Puts back one of Hive's modes as this version ships it (the workspace's copy goes to the Recycle Bin). */
  'modes:restore': (id: string) => ModeInfo

  'file:read': (path: string) => string
  /** With `expected` (the text as read), refuses with CONFLICT if the file has changed on disk since (a missing file reads as ''). */
  'file:write': (path: string, content: string, expected?: string) => void

  'memory:list': (projectPath: string) => MemorySource[]
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
  /** Opens a file of a Changes root (as git:status takes it, an unused worktree's too, #495) with its default app. */
  'changes:openFile': (root: string, file: string) => void
  /** Whether git itself runs (#346): as last checked, or checked again with `recheck`. */
  'git:tool': (recheck?: boolean) => GitTool
  /** The Git view (#607), the project folder's only (agents' worktrees change through the merge flow). The user's: no agent tool reaches these. */
  'git:summary': (projectPath: string) => GitRepoSummary
  'git:info': (projectPath: string) => GitRepoInfo
  'git:history': (projectPath: string) => GitHistory
  /** Each action replies with what it did, in a sentence. Switching (and creating a branch to switch to) or pulling is refused while an agent works in the folder or its merge slot is held (`folderBusy`). */
  'git:switch': (projectPath: string, branch: string) => string
  'git:createBranch': (projectPath: string, name: string, stay?: boolean) => string
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
  /** Initialise repository (#701): whether it can be done, and what the dialog asks; then git init on main, .hive excluded first, a starter .gitignore, the first commit. */
  'git:initCheck': (projectPath: string) => GitInitCheck
  'git:init': (projectPath: string, opts: GitInitOptions) => string

  /** Each provider's installed CLI, by provider. */
  'provider:info': () => Record<ProviderId, AgentInstallInfo>
  /** Looks again (one provider, or all), including the latest version. */
  'provider:refresh': (provider?: ProviderId) => Record<ProviderId, AgentInstallInfo>
  /** Runs install, update, sign-in or setup in a terminal; returns the terminal's key. */
  'provider:task': (provider: ProviderId, task: ProviderTask) => string
  /** Runs the retry offered for the last failed update, only at the user's request. */
  'provider:retryUpdate': (provider: ProviderId) => string
  /** Stops every running agent of a provider (turning it off). */
  'provider:stopAgents': (provider: ProviderId) => void

  'api:info': () => AgentApiInfo
  'api:regenerateToken': () => AgentApiInfo
  /** A new read-only viewer token with this name (#620). */
  'api:createViewer': (name: string) => AgentApiInfo
  /** Revokes a viewer token (its id): its requests are refused from now on. */
  'api:revokeViewer': (id: string) => AgentApiInfo
}

export type HiveChannel = keyof HiveRequests

export interface HiveBridge {
  invoke<C extends HiveChannel>(channel: C, ...args: Parameters<HiveRequests[C]>): Promise<ReturnType<HiveRequests[C]>>
  onEvent(listener: (event: HiveEvent) => void): () => void
  onPtyData(listener: (key: string, data: string) => void): () => void
  onPtyExit(listener: (key: string, code: number) => void): () => void
  /** Full path of a file dropped from Explorer. */
  pathForFile(file: File): string
  platform: string
}
